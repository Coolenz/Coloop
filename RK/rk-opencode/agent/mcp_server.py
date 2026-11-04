"""Dependency-free local MCP stdio tools for OpenCode (newline JSON-RPC)."""

import argparse
import json
import os
from pathlib import Path
import sys

from memory_client import memory_backend


MEMORY_TOOL = {
    "name": "memory",
    "description": "Unified memory. For private credentials use arguments op=lookup_private and query=website; lookup_private is an operation, not a tool name. Returns protected record IDs, locators and Coloop resolver, never plaintext or execution permission. search/get also discover references. set stores ordinary unverified claims.",
    "inputSchema": {
        "type": "object",
        "properties": {
            "op": {
                "type": "string",
                "enum": ["set", "get", "search", "delete", "ingest", "compact", "status",
                         "lookup_private", "sync_private"],
            },
            "key": {"type": "string"},
            "value": {"type": "string"},
            "kind": {"type": "string", "enum": ["fact", "preference", "procedure", "task"]},
            "query": {"type": "string"},
            "limit": {"type": "integer"},
            "ttl": {"type": "integer"},
        },
        "required": ["op"],
        "additionalProperties": False,
    },
}


def compact_private_reference(row):
    """Keep SDK indexing IDs out of the planner's executable record namespace."""
    private = row.get("private") if isinstance(row, dict) else None
    if (
        not isinstance(private, dict)
        or private.get("provider") != "credential_vault"
        or private.get("resolver") != "coloop_private_login"
        or private.get("plaintext_readable") is not False
        or private.get("requires_target_validation") is not True
        or not isinstance(private.get("record_id"), str)
        or private.get("locator") != "rk-vault://" + private["record_id"]
    ):
        raise ValueError("Invalid protected memory reference")
    return {"kind": "credential_reference", "record_id": private["record_id"],
            "origin": private["origin"], "locator": private["locator"],
            "resolver": private["resolver"], "plaintext_readable": False,
            "requires_target_validation": True}


def memory_tool_result(value, operation):
    if operation in ("lookup_private", "search"):
        return {**value, "memories": [
            compact_private_reference(row)
            if operation == "lookup_private" or row.get("kind") == "credential_reference"
            else row for row in value["memories"]
        ]}
    row = value.get("memory")
    if operation == "get" and isinstance(row, dict) and row.get("kind") == "credential_reference":
        return {"memory": compact_private_reference(value["memory"])}
    return value


class MCPServer:
    def __init__(self, root, mode):
        self.memory = memory_backend(root) if mode == "memory" else None
        self.mode = mode
        self.tools = [MEMORY_TOOL] if mode == "memory" else []
        if mode == "desktop":
            from desktop import DesktopTools, DESKTOP_TOOL

            self.desktop = DesktopTools(root)
            self.tools = [DESKTOP_TOOL]
        if mode == "desktop-fast":
            from fast_desktop import FastDesktop, FAST_TOOL

            self.desktop = FastDesktop(root)
            self.tools = [FAST_TOOL]
        if mode == "windows":
            from windows_desktop import WindowsDesktopTools, WINDOWS_TOOL

            self.desktop = WindowsDesktopTools(root, model_view=True)
            self.tools = [WINDOWS_TOOL]

    def dispatch(self, request):
        method, params = request.get("method"), request.get("params", {})
        if method == "initialize":
            return {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "rk-local-" + self.mode, "version": "0.2.0"},
            }
        if method == "ping":
            return {}
        if method == "tools/list":
            return {"tools": self.tools}
        if method == "tools/call":
            name = params.get("name")
            available = {item["name"]: item for item in self.tools}
            if name not in available:
                raise ValueError("Unknown tool")
            arguments = params.get("arguments", {})
            if not isinstance(arguments, dict):
                raise ValueError("arguments must be an object")
            # Validate even if the caller bypasses the model bridge.
            sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "bridge"))
            from protocol import validate

            validate(arguments, available[name]["inputSchema"])
            try:
                value = (
                    self.memory.call(arguments)
                    if name == "memory"
                    else self.desktop.call(arguments)
                )
                if name == "memory":
                    value = memory_tool_result(value, arguments.get("op"))
                return {
                    "content": [{"type": "text", "text": json.dumps(value, ensure_ascii=False)}]
                }
            except (ValueError, OSError, RuntimeError) as error:
                return {"isError": True, "content": [{"type": "text", "text": str(error)}]}
        raise ValueError("Unsupported method")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--mode", choices=["memory", "desktop", "desktop-fast", "windows"], default="memory"
    )
    args = parser.parse_args()
    os.umask(0o077)
    root = Path(os.environ.get("RK_AGENT_ROOT", Path(__file__).resolve().parents[1]))
    server = MCPServer(root, args.mode)
    for line in sys.stdin:
        request = None
        try:
            if len(line.encode("utf-8")) > 262144:
                raise ValueError("Request too large")
            request = json.loads(line)
            if not isinstance(request, dict) or request.get("jsonrpc") != "2.0":
                raise ValueError("Expected JSON-RPC object")
            if "id" not in request:
                continue
            response = {"jsonrpc": "2.0", "id": request["id"], "result": server.dispatch(request)}
        except (ValueError, KeyError, TypeError) as error:
            response = {
                "jsonrpc": "2.0",
                "id": request.get("id") if isinstance(request, dict) else None,
                "error": {"code": -32602, "message": str(error)},
            }
        print(json.dumps(response, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
