"""Dependency-free local MCP stdio tools for OpenCode (newline JSON-RPC)."""

import argparse
import json
import os
from pathlib import Path
import sys

from memory_client import memory_backend


MEMORY_TOOL = {
    "name": "memory",
    "description": "Durable local memory. get/search before reuse; set stores an unverified agent claim.",
    "inputSchema": {
        "type": "object",
        "properties": {
            "op": {
                "type": "string",
                "enum": ["set", "get", "search", "delete", "ingest", "compact", "status"],
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


class MCPServer:
    def __init__(self, root, mode):
        self.memory = memory_backend(root)
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
                return {
                    "content": [{"type": "text", "text": json.dumps(value, ensure_ascii=False)}]
                }
            except (ValueError, OSError, RuntimeError) as error:
                return {"isError": True, "content": [{"type": "text", "text": str(error)}]}
        raise ValueError("Unsupported method")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=["memory", "desktop", "desktop-fast"], default="memory")
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
