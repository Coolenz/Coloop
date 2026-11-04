"""Local Coloop advisory review client and OpenCode 1.19.5 pending-request adapter.

The adapter never executes a command or input action. It only sends an existing
OpenCode request to Coloop, verifies the reply, then answers that same request.
The generic review interface returns advice and never executes it. OpenCode read
approvals stay pending because the upstream Agent's data destination cannot be
verified from provider/model names. Explicit denials and safe choices may reply.
OpenCode endpoints/types were checked against the lockfile-pinned SDK in
rk-opencode/.cache/plugin-sdk/node_modules/@opencode-ai/sdk/dist/v2/gen/.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

MAX_JSON_BYTES = 2 * 1024 * 1024
EVENT_TTL_SECONDS = 180
TRANSIENT_REASONS = {"MODEL_BUSY", "REQUEST_IN_PROGRESS", "REVIEW_UNAVAILABLE", "REVIEW_TIMEOUT"}
EVENT_KEYS = {
    "version",
    "id",
    "sessionId",
    "kind",
    "workspace",
    "tool",
    "patterns",
    "command",
    "question",
    "choices",
    "createdAt",
    "expiresAt",
}
DECISION_KEYS = {
    "version",
    "id",
    "sessionId",
    "requestHash",
    "decision",
    "choiceId",
    "reasonCode",
    "source",
    "expiresAt",
}


class AdapterError(Exception):
    """A fixed, public error code; never carry upstream text or credentials."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def canonical_json(value: Any) -> str:
    try:
        return json.dumps(
            value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
        )
    except (TypeError, ValueError, UnicodeError, RecursionError) as error:
        raise AdapterError("INVALID_JSON") from error


def digest(value: Any) -> str:
    try:
        return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()
    except UnicodeError as error:
        raise AdapterError("INVALID_JSON") from error


def _object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise AdapterError("DUPLICATE_JSON_KEY")
        result[key] = value
    return result


def parse_json(data: bytes) -> Any:
    if len(data) > MAX_JSON_BYTES:
        raise AdapterError("JSON_TOO_LARGE")
    try:
        return json.loads(
            data.decode("utf-8-sig"),
            object_pairs_hook=_object,
            parse_constant=lambda _: _invalid_json(),
        )
    except (ValueError, UnicodeError, RecursionError) as error:
        raise AdapterError("INVALID_JSON") from error


def _invalid_json() -> None:
    raise AdapterError("INVALID_JSON")


def _text(value: Any, limit: int = 50000, *, empty: bool = False) -> bool:
    return (
        isinstance(value, str)
        and (empty or bool(value))
        and len(value) <= limit
        and "\x00" not in value
    )


def _identifier(value: Any, limit: int = 128, *, choice: bool = False) -> bool:
    pattern = r"[A-Za-z0-9_-]+" if choice else r"[A-Za-z0-9._:-]+"
    return _text(value, limit) and re.fullmatch(pattern, value) is not None


def absolute_directory(value: Any) -> str:
    if (
        not _text(value, 1024)
        or any(ord(char) < 32 for char in value)
        or not (PurePosixPath(value).is_absolute() or PureWindowsPath(value).is_absolute())
    ):
        raise AdapterError("INVALID_DIRECTORY")
    return value


def timestamp(value: Any) -> datetime:
    if (
        not _text(value, 80)
        or re.fullmatch(
            r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})", value
        )
        is None
    ):
        raise AdapterError("INVALID_TIMESTAMP")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError("timezone required")
        return parsed.astimezone(timezone.utc)
    except ValueError as error:
        raise AdapterError("INVALID_TIMESTAMP") from error


def iso_time(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def validate_event(event: Any, *, now: datetime | None = None) -> dict[str, Any]:
    if (
        not isinstance(event, dict)
        or set(event) - EVENT_KEYS
        or type(event.get("version")) is not int
        or event["version"] != 1
        or not _identifier(event.get("id"))
        or not _identifier(event.get("sessionId"))
        or event.get("kind") not in ("permission", "question")
    ):
        raise AdapterError("INVALID_EVENT")
    absolute_directory(event.get("workspace"))
    created, expires = timestamp(event.get("createdAt")), timestamp(event.get("expiresAt"))
    current = now or datetime.now(timezone.utc)
    if expires <= current:
        raise AdapterError("EVENT_EXPIRED")
    if (
        expires <= created
        or expires - created > timedelta(seconds=300)
        or created > current + timedelta(seconds=30)
    ):
        raise AdapterError("INVALID_TIMESTAMP")
    for field, limit in (("tool", 80), ("command", 8000), ("question", 4000)):
        if field in event and not _text(event[field], limit, empty=field == "command"):
            raise AdapterError("INVALID_EVENT")
    if "patterns" in event and (
        not isinstance(event["patterns"], list)
        or not 1 <= len(event["patterns"]) <= 20
        or not all(_text(p, 1024) for p in event["patterns"])
    ):
        raise AdapterError("INVALID_EVENT")
    if "choices" in event:
        choices = event["choices"]
        if not isinstance(choices, list) or not 1 <= len(choices) <= 20:
            raise AdapterError("INVALID_EVENT")
        ids = []
        for choice in choices:
            if (
                not isinstance(choice, dict)
                or set(choice) - {"id", "label", "description"}
                or not _identifier(choice.get("id"), 64, choice=True)
                or not _text(choice.get("label"), 200)
                or ("description" in choice and not _text(choice["description"], 800, empty=True))
            ):
                raise AdapterError("INVALID_EVENT")
            ids.append(choice["id"])
        if len(set(ids)) != len(ids):
            raise AdapterError("INVALID_EVENT")
    if len(canonical_json(event).encode("utf-8")) > 256000:
        raise AdapterError("EVENT_TOO_LARGE")
    return event


def validate_decision(value: Any, event: dict[str, Any]) -> dict[str, Any]:
    required = DECISION_KEYS - {"choiceId"}
    if (
        not isinstance(value, dict)
        or set(value) - DECISION_KEYS
        or required - set(value)
        or type(value.get("version")) is not int
        or value["version"] != 1
        or value.get("decision") not in ("allow", "deny", "select", "defer")
        or value.get("source") not in ("policy", "rk")
        or not isinstance(value.get("reasonCode"), str)
        or re.fullmatch(r"[A-Z][A-Z0-9_]{0,79}", value["reasonCode"]) is None
    ):
        raise AdapterError("INVALID_DECISION")
    if (
        value["id"] != event["id"]
        or value["sessionId"] != event["sessionId"]
        or value["requestHash"] != digest(event)
        or value["expiresAt"] != event["expiresAt"]
    ):
        raise AdapterError("DECISION_BINDING_MISMATCH")
    if timestamp(value["expiresAt"]) <= datetime.now(timezone.utc):
        raise AdapterError("DECISION_EXPIRED")
    if value["decision"] == "select":
        choices = event.get("choices", [])
        if (
            event["kind"] != "question"
            or not _identifier(value.get("choiceId"), 64, choice=True)
            or value["choiceId"] not in {c["id"] for c in choices}
        ):
            raise AdapterError("INVALID_SELECTION")
    elif "choiceId" in value:
        raise AdapterError("INVALID_SELECTION")
    if event["kind"] == "question" and value["decision"] == "allow":
        raise AdapterError("INVALID_SELECTION")
    return value


def loopback_url(value: Any) -> str:
    if not _text(value, 2048) or any(ord(c) <= 32 for c in value):
        raise AdapterError("INVALID_URL")
    try:
        parsed = urlsplit(value)
        host, port = parsed.hostname, parsed.port
        if (
            parsed.scheme not in ("http", "https")
            or not host
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
            or parsed.path not in ("", "/")
            or port == 0
        ):
            raise ValueError("invalid endpoint")
        if host.lower() == "localhost":
            host = "127.0.0.1"  # No DNS resolution or hosts-file rebinding.
        if not ipaddress.ip_address(host).is_loopback:
            raise ValueError("not loopback")
        address = f"[{host}]" if ":" in host else host
        return f"{parsed.scheme}://{address}" + (f":{port}" if port else "")
    except ValueError as error:
        raise AdapterError("INVALID_URL") from error


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class LocalJsonClient:
    def __init__(self, url: str, authorization: str = "", timeout: float = 195):
        self.url = loopback_url(url)
        self.authorization = authorization
        self.timeout = timeout
        self.opener = build_opener(ProxyHandler({}), NoRedirect())

    def request(self, method: str, path: str, body: Any = None) -> Any:
        if not path.startswith("/") or path.startswith("//"):
            raise AdapterError("INVALID_REQUEST_PATH")
        headers = {"Accept": "application/json"}
        if self.authorization:
            headers["Authorization"] = self.authorization
        payload = None if body is None else canonical_json(body).encode("utf-8")
        if payload is not None:
            headers["Content-Type"] = "application/json"
        request = Request(self.url + path, data=payload, headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                if response.status != 200:
                    raise AdapterError("HTTP_STATUS")
                if response.headers.get_content_type() != "application/json":
                    raise AdapterError("INVALID_CONTENT_TYPE")
                return parse_json(response.read(MAX_JSON_BYTES + 1))
        except HTTPError as error:
            code = "REDIRECT_BLOCKED" if 300 <= error.code < 400 else "HTTP_STATUS"
            raise AdapterError(code) from error
        except (URLError, OSError, TimeoutError) as error:
            raise AdapterError("LOCAL_HTTP_UNAVAILABLE") from error


def default_connection() -> Path:
    appdata = os.environ.get("APPDATA")
    if not appdata:
        raise AdapterError("APPDATA_UNAVAILABLE")
    return Path(appdata) / "coloop" / "agent-coordinator" / "connection.json"


def read_json_file(path: Path) -> Any:
    try:
        with path.open("rb") as stream:
            return parse_json(stream.read(MAX_JSON_BYTES + 1))
    except OSError as error:
        raise AdapterError("LOCAL_FILE_UNAVAILABLE") from error


def coordinator_client(path: Path | None = None) -> LocalJsonClient:
    connection = read_json_file(path or default_connection())
    if (
        not isinstance(connection, dict)
        or set(connection) != {"url", "token"}
        or not _text(connection["token"], 4096)
        or any(ord(c) < 33 or ord(c) > 126 for c in connection["token"])
    ):
        raise AdapterError("INVALID_CONNECTION")
    return LocalJsonClient(connection["url"], "Bearer " + connection["token"])


def review(client: LocalJsonClient, event: Any) -> dict[str, Any]:
    validate_event(event)
    return validate_decision(client.request("POST", "/v1/review", event), event)


def opencode_client(url: str) -> LocalJsonClient:
    username = os.environ.get("RK_OPENCODE_USERNAME", "")
    password = os.environ.get("RK_OPENCODE_PASSWORD", "")
    if bool(username) != bool(password) or ":" in username:
        raise AdapterError("INVALID_OPENCODE_CREDENTIALS")
    authorization = ""
    if password:
        encoded = base64.b64encode(f"{username}:{password}".encode("utf-8")).decode("ascii")
        authorization = "Basic " + encoded
    return LocalJsonClient(url, authorization, timeout=15)


def audit(request_id: str, result: str, reason: str) -> None:
    # Only locally generated/fixed codes or schema-validated reason codes enter this log.
    print(
        canonical_json({"requestHash": digest(request_id), "result": result, "reasonCode": reason}),
        file=sys.stderr,
    )


class OpenCodeAdapter:
    def __init__(
        self,
        opencode: LocalJsonClient,
        coordinator: LocalJsonClient,
        directory: str,
        workspace: str | None = None,
    ):
        self.opencode = opencode
        self.coordinator = coordinator
        self.directory = absolute_directory(directory)
        self.workspace = absolute_directory(workspace if workspace is not None else directory)
        self.query = "?" + urlencode({"directory": self.directory})
        self.observed: dict[tuple[str, str, str], tuple[str, dict[str, Any] | None]] = {}
        self.handled: set[tuple[str, str, str]] = set()
        self.retryable: set[tuple[str, str, str]] = set()
        self.last_error: str | None = None

    def pending(self, kind: str) -> list[dict[str, Any]]:
        values = self.opencode.request("GET", f"/{kind}{self.query}")
        if not isinstance(values, list) or len(values) > 10000:
            raise AdapterError("INVALID_PENDING_LIST")
        keys = set()
        for value in values:
            if (
                not isinstance(value, dict)
                or not _identifier(value.get("id"))
                or not _identifier(value.get("sessionID"))
            ):
                raise AdapterError("INVALID_PENDING_REQUEST")
            key = (value["sessionID"], value["id"])
            if key in keys:
                raise AdapterError("DUPLICATE_PENDING_REQUEST")
            keys.add(key)
        return values

    def make_event(self, kind: str, pending: dict[str, Any]) -> dict[str, Any] | None:
        now = datetime.now(timezone.utc)
        event: dict[str, Any] = {
            "version": 1,
            "id": pending["id"],
            "sessionId": pending["sessionID"],
            "kind": kind,
            "workspace": self.workspace,
            "createdAt": iso_time(now),
            "expiresAt": iso_time(now + timedelta(seconds=EVENT_TTL_SECONDS)),
        }
        if kind == "permission":
            if (
                not _text(pending.get("permission"), 80)
                or not isinstance(pending.get("patterns"), list)
                or not all(_text(p) for p in pending["patterns"])
                or not isinstance(pending.get("metadata"), dict)
            ):
                raise AdapterError("INVALID_PENDING_REQUEST")
            event.update(tool=pending["permission"], patterns=pending["patterns"])
            metadata = pending["metadata"]
            # Dropping unknown fields could hide the operation's true file or effect.
            # Only the explicit command field has an agreed semantic mapping.
            if set(metadata) - {"command"}:
                return None
            if "command" in metadata:
                if not _text(metadata["command"], 8000, empty=True):
                    raise AdapterError("INVALID_PENDING_REQUEST")
                event["command"] = metadata["command"]
        else:
            questions = pending.get("questions")
            if not isinstance(questions, list) or len(questions) != 1:
                return None
            question = questions[0]
            if not isinstance(question, dict) or question.get("multiple") is True:
                return None
            options = question.get("options")
            if (
                not _text(question.get("question"))
                or not isinstance(options, list)
                or not 1 <= len(options) <= 100
            ):
                return None
            choices = []
            for index, option in enumerate(options):
                if (
                    not isinstance(option, dict)
                    or not _text(option.get("label"))
                    or not _text(option.get("description"), empty=True)
                ):
                    return None
                choices.append(
                    {
                        "id": str(index),
                        "label": option["label"],
                        "description": option["description"],
                    }
                )
            if len({c["label"] for c in choices}) != len(choices):
                return None
            event.update(question=question["question"], choices=choices)
        return validate_event(event)

    def poll_once(self) -> bool:
        """Review at most one newly observed request; keep all event timestamps stable."""
        self.last_error = None
        available = [
            (kind, value) for kind in ("permission", "question") for value in self.pending(kind)
        ]
        live = {(kind, value["sessionID"], value["id"]) for kind, value in available}
        self.observed = {key: entry for key, entry in self.observed.items() if key in live}
        self.retryable.intersection_update(live)
        for kind, pending in available:
            key = (kind, pending["sessionID"], pending["id"])
            original_hash = digest(pending)
            if key in self.handled:
                continue
            if key in self.observed:
                if key not in self.retryable:
                    continue
                saved_hash, event = self.observed[key]
                self.retryable.discard(key)
                if original_hash != saved_hash:
                    audit(pending["id"], "pending", "PENDING_CHANGED_OR_CONSUMED")
                    return True
                if event is None or timestamp(event["expiresAt"]) <= datetime.now(timezone.utc):
                    audit(pending["id"], "pending", "EVENT_EXPIRED")
                    return True
            else:
                # Mark before network I/O: an ambiguous transport failure is not retried.
                self.observed[key] = (original_hash, None)
                event = self.make_event(kind, pending)
                self.observed[key] = (original_hash, event)
            if event is None:
                reason = (
                    "UNSUPPORTED_QUESTION" if kind == "question" else "UNKNOWN_PERMISSION_METADATA"
                )
                audit(pending["id"], "pending", reason)
                return True
            try:
                decision = review(self.coordinator, event)
                if decision["decision"] == "defer":
                    if decision["reasonCode"] in TRANSIENT_REASONS:
                        self.retryable.add(key)
                    audit(pending["id"], "pending", decision["reasonCode"])
                    return True
                if kind == "permission" and decision["decision"] == "allow":
                    # Local review does not prove that the primary Agent keeps file data local.
                    # Config/model names cannot establish the route through plugins or proxies.
                    audit(pending["id"], "pending", "UNVERIFIED_AGENT_DATA_ROUTE")
                    return True
                current = [
                    value
                    for value in self.pending(kind)
                    if value["id"] == pending["id"] and value["sessionID"] == pending["sessionID"]
                ]
                if len(current) != 1 or digest(current[0]) != original_hash:
                    raise AdapterError("PENDING_CHANGED_OR_CONSUMED")
                validate_decision(decision, event)  # Recheck expiry immediately before the POST.
                action = decision["decision"]
                if kind == "permission":
                    if action != "deny":
                        raise AdapterError("INVALID_SELECTION")
                    suffix, body = "reply", {"reply": "reject"}
                elif action == "deny":
                    suffix, body = "reject", None
                elif action == "select":
                    selected = next(c for c in event["choices"] if c["id"] == decision["choiceId"])
                    suffix, body = "reply", {"answers": [[selected["label"]]]}
                else:
                    raise AdapterError("INVALID_SELECTION")
                self.handled.add(key)
                path = f"/{kind}/{quote(pending['id'], safe='')}/{suffix}{self.query}"
                if self.opencode.request("POST", path, body) is not True:
                    raise AdapterError("REPLY_NOT_ACCEPTED")
                if any(
                    value["id"] == pending["id"] and value["sessionID"] == pending["sessionID"]
                    for value in self.pending(kind)
                ):
                    raise AdapterError("REPLY_NOT_CONSUMED")
                audit(pending["id"], "replied", decision["reasonCode"])
            except AdapterError as error:
                self.last_error = error.code
                audit(pending["id"], "pending", error.code)
            return True
        return False


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="mode", required=True)
    generic = commands.add_parser("review", help="Review one versioned JSON event")
    generic.add_argument("--event", required=True, type=Path)
    generic.add_argument("--connection", type=Path)
    adapter = commands.add_parser("opencode", help="Answer existing local OpenCode requests")
    adapter.add_argument("--url", required=True)
    adapter.add_argument("--directory", required=True)
    adapter.add_argument(
        "--workspace", help="Local Coloop policy workspace; defaults to the OpenCode directory"
    )
    adapter.add_argument("--connection", type=Path)
    adapter.add_argument("--once", action="store_true")
    args = parser.parse_args(argv)
    try:
        coordinator = coordinator_client(args.connection)
        if args.mode == "review":
            decision = review(coordinator, read_json_file(args.event))
            print(canonical_json(decision))
            return 0
        client = OpenCodeAdapter(
            opencode_client(args.url), coordinator, args.directory, args.workspace
        )
        while True:
            client.poll_once()
            if args.once:
                return 1 if client.last_error else 0
            time.sleep(2)
    except KeyboardInterrupt:
        return 130
    except AdapterError as error:
        audit("", "error", error.code)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
