"""Offline Docling adapter. One bounded JSON request/response per process.

Only the host supplies paths. The content cache is local and is never a completion
proof: rendered PDF verification remains a separate Coloop capability.
"""
from __future__ import annotations

import contextlib
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import socket
import sys
import tempfile

VERSION = "2.147.0"
SCHEMA = "coloop-docling-1"
MAX_SOURCE = 30 * 1024 * 1024
MAX_CACHE = 32 * 1024 * 1024
MAX_RESPONSE = 1024 * 1024
MAX_BLOCKS = 20000
TEXT_CHUNK = 2000


class AdapterError(Exception):
    pass


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for data in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(data)
    return h.hexdigest()


def offline():
    # Do not rely solely on library-specific download flags. A document parser
    # receives untrusted bytes, so block Python socket connections in this process.
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1",
                      HF_HUB_DISABLE_TELEMETRY="1", DO_NOT_TRACK="1")

    def blocked(*args, **kwargs):
        raise AdapterError("DOCLING_NETWORK_DISABLED")

    socket.create_connection = blocked
    socket.socket.connect = blocked
    socket.socket.connect_ex = blocked


def parser_version():
    actual = importlib.metadata.version("docling")
    if actual != VERSION:
        raise AdapterError("DOCLING_VERSION_MISMATCH")
    components = {name: importlib.metadata.version(name) for name in
                  ("docling", "docling-core", "docling-parse", "docling-ibm-models", "rapidocr", "onnxruntime")}
    return ";".join(f"{key}={value}" for key, value in sorted(components.items()))


def provenance(item):
    result = []
    for entry in getattr(item, "prov", []):
        box = getattr(entry, "bbox", None)
        row = {"page": int(entry.page_no)}
        if box is not None:
            row["bbox"] = {key: float(getattr(box, key)) for key in ("l", "t", "r", "b")}
            row["coordinate_origin"] = str(getattr(box.coord_origin, "value", box.coord_origin))
        result.append(row)
    return result


def document_blocks(document):
    from docling_core.types.doc import TableItem, TextItem
    blocks = []

    def append(item, kind, text, table=None):
        text = str(text)
        prov = provenance(item)
        source_id = str(item.self_ref)
        for offset in range(0, max(1, len(text)), TEXT_CHUNK):
            row = {"id": f"block:{len(blocks)}", "source_id": source_id,
                   "kind": kind, "text": text[offset:offset + TEXT_CHUNK],
                   "text_offset": offset, "pages": sorted({p["page"] for p in prov}),
                   "provenance": prov}
            if table is not None:
                row["table"] = table
            blocks.append(row)
            if len(blocks) > MAX_BLOCKS:
                raise AdapterError("DOCLING_DOCUMENT_TOO_LARGE")

    for item, _level in document.iterate_items():
        if isinstance(item, TableItem):
            data = item.data
            for cell in data.table_cells:
                append(item, "table_cell", cell.text, {
                    "id": str(item.self_ref), "rows": int(data.num_rows),
                    "columns": int(data.num_cols),
                    "row": int(cell.start_row_offset_idx),
                    "column": int(cell.start_col_offset_idx),
                    "row_span": int(cell.row_span), "column_span": int(cell.col_span),
                    "column_header": bool(cell.column_header),
                    "row_header": bool(cell.row_header),
                })
        elif isinstance(item, TextItem):
            append(item, str(getattr(item.label, "value", item.label)), item.text)
    return blocks


def valid_blocks(blocks):
    return (isinstance(blocks, list) and len(blocks) <= MAX_BLOCKS and
            all(isinstance(block, dict) and block.get("id") == f"block:{index}" and
                isinstance(block.get("text"), str) and len(block["text"]) <= TEXT_CHUNK
                for index, block in enumerate(blocks)))


def convert(path, model_directory):
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions, RapidOcrOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption
    options = PdfPipelineOptions(artifacts_path=model_directory,
                                 enable_remote_services=False,
                                 allow_external_plugins=False,
                                 do_ocr=True, do_table_structure=True)
    options.ocr_options = RapidOcrOptions(backend="onnxruntime")
    converter = DocumentConverter(allowed_formats=[InputFormat.PDF, InputFormat.DOCX],
                                  format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)})
    result = converter.convert(path, raises_on_error=True, max_num_pages=200,
                               max_file_size=MAX_SOURCE)
    if str(getattr(result.status, "value", result.status)) != "success":
        raise AdapterError("DOCLING_CONVERSION_INCOMPLETE")
    return document_blocks(result.document)


def handle(request):
    if not isinstance(request, dict) or set(request) - {
        "path", "cache_directory", "model_directory", "start_block", "max_blocks", "max_characters"
    }:
        raise AdapterError("DOCLING_INVALID_REQUEST")
    path = Path(request.get("path", ""))
    if not path.is_absolute() or path.suffix.lower() not in (".pdf", ".docx"):
        raise AdapterError("DOCLING_LOCAL_PDF_DOCX_REQUIRED")
    path = path.resolve(strict=True)
    if not path.is_file() or path.stat().st_size > MAX_SOURCE:
        raise AdapterError("DOCLING_SOURCE_TOO_LARGE")
    cache = Path(request.get("cache_directory", ""))
    models = Path(request.get("model_directory", ""))
    if not cache.is_absolute() or not models.is_absolute():
        raise AdapterError("DOCLING_INVALID_CONFIGURATION")
    start, limit, budget = (request.get("start_block", 0), request.get("max_blocks", 20),
                            request.get("max_characters", 8000))
    if any(type(value) is not int for value in (start, limit, budget)) or not (
        0 <= start <= MAX_BLOCKS and 1 <= limit <= 40 and 2000 <= budget <= 16000
    ):
        raise AdapterError("DOCLING_INVALID_RANGE")
    version = parser_version()
    source_hash = digest(path)
    manifest = models / "manifest.json"
    model_revision = digest(manifest) if manifest.is_file() else "unmanifested"
    key = hashlib.sha256(f"{SCHEMA}:{version}:{model_revision}:{path.suffix.lower()}:{source_hash}".encode()).hexdigest()
    cache.mkdir(parents=True, exist_ok=True)
    cache_file = cache / (key + ".json")
    content = None
    if cache_file.exists() and cache_file.stat().st_size <= MAX_CACHE:
        try:
            candidate = json.loads(cache_file.read_text(encoding="utf-8"))
            if (isinstance(candidate, dict) and candidate.get("schema") == SCHEMA and candidate.get("source_sha256") == source_hash
                    and candidate.get("parser_version") == version and valid_blocks(candidate.get("blocks"))):
                content = candidate
        except (ValueError, OSError):
            pass
    hit = content is not None
    if content is None:
        # Convert a frozen local copy, never a URL or the mutable original.
        with tempfile.TemporaryDirectory(prefix="coloop-docling-") as temp:
            snapshot = Path(temp) / ("source" + path.suffix.lower())
            with path.open("rb") as source, snapshot.open("xb") as target:
                total = 0
                for part in iter(lambda: source.read(1024 * 1024), b""):
                    total += len(part)
                    if total > MAX_SOURCE:
                        raise AdapterError("DOCLING_SOURCE_TOO_LARGE")
                    target.write(part)
            if digest(snapshot) != source_hash:
                raise AdapterError("DOCLING_SOURCE_CHANGED")
            content = {"schema": SCHEMA, "source_sha256": source_hash, "parser_version": version,
                       "blocks": convert(snapshot, models)}
        if digest(path) != source_hash:
            raise AdapterError("DOCLING_SOURCE_CHANGED")
        encoded = json.dumps(content, ensure_ascii=False).encode("utf-8")
        if len(encoded) > MAX_CACHE:
            raise AdapterError("DOCLING_DOCUMENT_TOO_LARGE")
        descriptor, temporary = tempfile.mkstemp(prefix=key + ".", suffix=".tmp", dir=cache)
        try:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(encoded)
            os.replace(temporary, cache_file)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    if digest(path) != source_hash:
        raise AdapterError("DOCLING_SOURCE_CHANGED")
    all_blocks = content["blocks"]
    if start > len(all_blocks):
        raise AdapterError("DOCLING_OFFSET_OUT_OF_RANGE")
    selected, count = [], 0
    for block in all_blocks[start:start + limit]:
        if count + len(block["text"]) > budget:
            break
        selected.append(block)
        count += len(block["text"])
    next_block = start + len(selected)
    return {"ok": True, "source_sha256": source_hash, "parser_version": version,
            "document_id": key, "block_count": len(all_blocks), "blocks": selected,
            "truncated": next_block < len(all_blocks),
            "next_block": next_block if next_block < len(all_blocks) else None,
            "cache_hit": hit, "channel": "host_docling"}


def main():
    offline()
    try:
        raw = sys.stdin.buffer.readline(16385)
        if len(raw) > 16384:
            raise AdapterError("DOCLING_REQUEST_TOO_LARGE")
        # Library logs/progress must not share the data protocol.
        with contextlib.redirect_stdout(sys.stderr):
            result = handle(json.loads(raw))
        payload = json.dumps(result, ensure_ascii=False)
        if len(payload.encode("utf-8")) > MAX_RESPONSE:
            raise AdapterError("DOCLING_RESPONSE_TOO_LARGE")
    except AdapterError as error:
        payload = json.dumps({"ok": False, "error": str(error)})
    except importlib.metadata.PackageNotFoundError:
        payload = json.dumps({"ok": False, "error": "DOCLING_NOT_INSTALLED"})
    except Exception as error:
        # Do not expose file contents, arbitrary exception strings or credentials.
        print(type(error).__name__, file=sys.stderr)
        payload = json.dumps({"ok": False, "error": "DOCLING_CONVERSION_FAILED"})
    sys.stdout.write(payload + "\n")


if __name__ == "__main__":
    main()
