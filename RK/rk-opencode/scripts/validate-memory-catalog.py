"""Validate real Mem0 CPU storage/catalog in an isolated data directory; no NPU or HID."""
import argparse
import datetime
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agent"))
from mem0_engine import Mem0Engine  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--local", action="store_true", help="Use the PC's cached embedding model")
    args = parser.parse_args()
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d-%H%M%S-%f")
    folder = ROOT / "logs" / ("memory-catalog-" + stamp)
    folder.mkdir(parents=True, exist_ok=False)
    base = {"embedding_model": "BAAI/bge-small-zh-v1.5", "embedding_dims": 512,
            "embedding_dir": ".cache/memory-model"} if args.local else json.loads(
                (ROOT / ".runtime/memory-config.json").read_text())
    config = {**base, "data_dir": str(folder / "store"), "project": "catalog-test-" + stamp,
              "private_credentials": {"enabled": False}}
    report = {"passed": False, "real_mem0": True, "npu": False, "checks": {}}
    engine = None

    def check(name, condition):
        report["checks"][name] = bool(condition)
        if not condition:
            raise AssertionError(name)

    try:
        engine = Mem0Engine(ROOT, config)
        first = engine.set("outline", "产品发布应包括渠道与预算。", "procedure",
                           tags=["app:notepad", "workflow:outline"], summary="发布计划提纲",
                           source_task_id="isolated-cpu-validation")
        directory = engine.catalog(["workflow:outline"], "发布计划")["memories"]
        check("semantic_catalog", len(directory) == 1 and directory[0]["id"] == first["id"])
        check("directory_excludes_body", "value" not in directory[0])
        engine.close()
        engine = Mem0Engine(ROOT, config)
        check("reopened_persistent_id", engine.get_many([first["id"]])["memories"][0]["value"] == first["value"])
        second = engine.set("outline", "更新后的发布提纲", "procedure")
        check("superseded_id_unreadable", engine.get_many([first["id"]])["missing"] == [first["id"]])
        check("tags_preserved", second["tags"] == ["app:notepad", "workflow:outline"])
        engine.delete("outline")
        check("deleted_catalog_empty", not engine.catalog(["workflow:outline"])["memories"])
        report["passed"] = True
    finally:
        if engine:
            engine.close()
        (folder / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({"passed": report["passed"], "report": str(folder / "report.json")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
