"""Single-slot native conversation cache with explicit lineage and commit boundaries."""

from dataclasses import dataclass
import hashlib
import json
import re
import threading
import time

from protocol import InvalidRequest, content_text


def digest(value):
    data = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(data.encode("utf-8")).hexdigest()


def message_key(message):
    """Normalize harmless SDK differences, retaining role, text, arguments and call IDs."""
    result = {"role": message.get("role"), "content": content_text(message.get("content"))}
    if result["role"] == "assistant":
        calls = []
        for call in message.get("tool_calls", []):
            function = call["function"]
            calls.append(
                {
                    "id": call["id"],
                    "name": function["name"],
                    "arguments": json.loads(function["arguments"]),
                }
            )
        result["tool_calls"] = calls
    if result["role"] == "tool":
        result["tool_call_id"] = message.get("tool_call_id")
    return digest(result)


@dataclass(frozen=True)
class CacheContext:
    session: str
    signature: str
    keys: tuple
    roles: tuple


def request_context(body, session, control="auto"):
    if control not in ("auto", "off"):
        raise InvalidRequest("X-RK-Cache must be auto or off")
    if not session or control == "off":
        return None
    if not re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", session):
        raise InvalidRequest("Invalid cache session id")
    messages = body["messages"]
    signature = digest(
        {
            "model": body["model"],
            "instructions": [
                message_key(m) for m in messages if m.get("role") in ("system", "developer")
            ],
            "tools": body.get("tools", []),
            "tool_choice": body.get("tool_choice", "auto"),
        }
    )
    return CacheContext(
        session,
        signature,
        tuple(message_key(m) for m in messages),
        tuple(m.get("role") for m in messages),
    )


class ConversationCache:
    """A pending/failed/unrelated generation can never become accepted history."""

    def __init__(self, enabled=True, ttl=300):
        self.enabled = enabled
        self.ttl = ttl
        self.lock = threading.Lock()
        self.ticket = 0
        self.context = None
        self.expected = ()
        self.ready = False
        self.updated = 0
        self.native_tokens = 0

    def begin(self, context):
        with self.lock:
            reason = None
            if not self.enabled:
                reason = "disabled"
            elif context is None:
                reason = "no_session_or_request_disabled"
            elif not self.ready or self.context is None:
                reason = "cold_or_uncommitted"
            elif context.session != self.context.session:
                reason = "session_changed"
            elif context.signature != self.context.signature:
                reason = "instructions_or_tools_changed"
            elif time.monotonic() - self.updated > self.ttl:
                reason = "expired"
            elif (
                len(context.keys) <= len(self.expected)
                or context.keys[: len(self.expected)] != self.expected
            ):
                reason = "history_changed_or_retried"
            elif any(role not in ("user", "tool") for role in context.roles[len(self.expected) :]):
                reason = "unsupported_suffix"
            start = len(self.expected) if reason is None else 0
            native_tokens = self.native_tokens if reason is None else 0
            self.ticket += 1
            self.context, self.ready = context, False
            self.expected = context.keys if context else ()
            return {
                "ticket": self.ticket,
                "reset": reason is not None,
                "reason": reason or "append",
                "message_start": start,
                "native_tokens": native_tokens,
            }

    def commit(self, ticket, message, native_tokens):
        with self.lock:
            if ticket != self.ticket or self.context is None or not self.enabled:
                return
            self.expected = self.context.keys + (message_key(message),)
            self.ready = True
            self.updated = time.monotonic()
            self.native_tokens = native_tokens

    def invalidate(self, ticket):
        with self.lock:
            if ticket == self.ticket:
                self.ready = False
                self.native_tokens = 0
