"""Real Mem0/CPU/HTTP/MCP checks; optional real local Agent, synthetic credentials only."""

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import time
import urllib.error
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agent"))
from mem0_engine import Mem0Engine  # noqa: E402
from memory_client import MemoryClient  # noqa: E402
from mcp_server import MCPServer  # noqa: E402
from private_memory import PREFIX  # noqa: E402


def running_agent_environment(folder):
    # Reuse the already-ready model. A memory test must not run a launcher that can rebuild
    # or restart a shared worker after an unrelated source/profile update.
    sys.path.insert(0, str(ROOT))
    from model_profiles import load_profile, opencode_config, running_model

    live = running_model(ROOT)
    profile = load_profile()
    if live["model"] != profile["model_id"] or live["context"] != profile["context"]:
        raise RuntimeError("Selected and running model differ; shared model was not changed")
    for name in ("agent-data", "agent-config", "agent-workspace"):
        (folder / name).mkdir()
    # Stock 1.19.5 checks plugin dependencies in its configuration directory, even
    # for built-in-only plugins. Reuse the pinned offline SDK, as managed.sh does.
    sdk = ROOT / ".runtime/config/opencode"
    lock = (ROOT / "plugins/package-lock.json").read_bytes()
    if (sdk / "package-lock.json").read_bytes() != lock:
        raise RuntimeError("Pinned offline plugin SDK lock mismatch")
    for name in ("plugin", "sdk"):
        package = json.loads((sdk / "node_modules/@opencode-ai" / name / "package.json").read_text())
        if package["version"] != "1.19.5":
            raise RuntimeError("Pinned offline plugin SDK is unavailable")
    entries = list((sdk / "node_modules").rglob("*"))
    if not entries or any(p.is_symlink() or p.suffix.lower() in (".node", ".exe", ".dll", ".so", ".dylib")
                          for p in entries):
        raise RuntimeError("Only the existing pure-JavaScript plugin cache may be copied")
    destination = folder / "agent-config/opencode"
    destination.mkdir()
    for name in ("package.json", "package-lock.json"):
        shutil.copy2(sdk / name, destination / name)
    shutil.copytree(sdk / "node_modules", destination / "node_modules")
    config = destination / "opencode.json"
    config.write_text(json.dumps(opencode_config(profile), ensure_ascii=False), encoding="utf-8")
    env = {**os.environ, "RK_AGENT_API_KEY": (ROOT / ".runtime/api-key").read_text().strip(),
           "RK_AGENT_ROOT": str(ROOT), "OPENCODE_CONFIG": str(config),
           "XDG_CONFIG_HOME": str(folder / "agent-config"),
           "XDG_DATA_HOME": str(folder / "agent-data"),
           "XDG_CACHE_HOME": str(ROOT / ".runtime/cache"), "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"}
    for option in ("AUTOUPDATE", "MODELS_FETCH", "LSP_DOWNLOAD", "DEFAULT_PLUGINS",
                   "PROJECT_CONFIG", "AUTOCOMPACT", "PRUNE", "CLAUDE_CODE"):
        env["OPENCODE_DISABLE_" + option] = "true"
    return env


def vault(body):
    result = subprocess.run(
        ["/usr/bin/python3", "-I", "/usr/local/lib/rk-credential-vault/credential_client.py"],
        input=json.dumps(body).encode() + b"\n", capture_output=True, timeout=5,
    )
    data = json.loads(result.stdout)
    if result.returncode or data.get("ok") is not True:
        raise RuntimeError("Synthetic vault operation failed")
    return data["value"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--agent", action="store_true", help="One real OpenCode/NPU lookup")
    args = parser.parse_args()
    stamp = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime(
        "%Y%m%d-%H%M%S"
    )
    folder = ROOT / "logs" / ("private-memory-validation-" + stamp)
    folder.mkdir()
    os.environ["RK_AGENT_ROOT"] = str(ROOT)
    client = MemoryClient(ROOT)
    lease = "private-memory-validation-" + uuid.uuid4().hex
    report = {"passed": False, "real_mem0": True, "real_cpu_embeddings": True,
              "real_agent_requested": args.agent, "real_cloud_used": False, "checks": {}}
    records, engine = [], None
    user_value, password = "USER_" + secrets.token_hex(12), "PWD_" + secrets.token_hex(16)
    site = "https://memory-" + secrets.token_hex(6) + ".invalid"
    before = client.call({"op": "status"})

    def check(name, value):
        report["checks"][name] = bool(value)
        if not value:
            raise AssertionError(name)

    try:
        activity = client.request("/activity", {"session_id": lease, "active": True})
        report["foreground_activity_count"] = activity["active_sessions"]
        check("foreground_lease_registered", activity["active_sessions"] >= 1)
        # Activity leases are maintenance barriers, not proof of a running NPU call. The
        # ready-service-only Agent uses the existing server's busy rejection; it never
        # starts/stops a shared worker to obtain exclusive model ownership.
        client.request("/ready-for-foreground", {}, timeout=185)
        record = vault({"op": "create", "origin": site,
                        "username": user_value, "password": password})
        records.append(record)
        # Independently create via the existing vault API; no special registration call is needed.
        query = site + " 的网站登录账号密码存在哪里，设备如何获取使用？"
        started = time.perf_counter()
        found = client.lookup_private(query)
        report["first_lookup_seconds"] = time.perf_counter() - started
        ref = found["memories"][0]
        identifier = record["id"]
        check("authoritative_record_discovered", ref["private"]["record_id"] == identifier)
        semantic = client.lookup_private("我保存的网站登录账户要去哪里找，怎样让设备使用？")
        semantic_match = next((row for row in semantic["memories"]
                               if row["private"]["record_id"] == identifier), None)
        check("semantic_lookup_without_site_or_record_id", semantic_match is not None)
        report["semantic_reference_score"] = semantic_match.get("score")
        check("location_and_resolver", ref["private"]["locator"] == "rk-vault://" + identifier
              and ref["private"]["resolver"] == "coloop_private_login")
        check("no_plaintext_in_lookup", all(value not in json.dumps(found) for value in (user_value, password)))
        ordinary = client.call({"op": "search", "query": query})
        check("ordinary_search_discovers_private_memory",
              ordinary["memories"][0]["private"]["record_id"] == identifier)
        recalled = client.request("/recall", {"query": query})
        check("automatic_recall_contains_reference", identifier in recalled["context"]
              and "rk-vault://" in recalled["context"] and "Coloop" in recalled["context"])
        check("recall_budget", len(recalled["context"].encode()) <= recalled["budget_bytes"])
        check("no_plaintext_in_recall", all(value not in recalled["context"] for value in (user_value, password)))
        mcp = MCPServer(ROOT, "memory")
        reply = mcp.dispatch({"method": "tools/call", "params": {
            "name": "memory", "arguments": {"op": "lookup_private", "query": site},
        }})
        mcp_value = json.loads(reply["content"][0]["text"])
        check("real_mcp_routes_into_mem0", mcp_value["memories"][0]["record_id"] == identifier)
        for op in ("set", "delete"):
            try:
                client.call({"op": op, "key": PREFIX + identifier, "value": "forbidden overwrite"})
            except urllib.error.HTTPError as error:
                check("ordinary_" + op + "_cannot_change_private_memory", error.code == 409)
            else:
                check("ordinary_" + op + "_cannot_change_private_memory", False)

        # A separate real SDK store proves persistence/embedding; the LLM provider must not run.
        config = json.loads((ROOT / ".runtime/memory-config.json").read_text())
        isolated_config = {**config, "data_dir": str(folder / "isolated-store")}
        engine = Mem0Engine(ROOT, isolated_config)
        def no_llm(*_args, **_kwargs):
            raise AssertionError("Private reference indexing invoked a model")
        engine.stores["private_refs"].llm.request = no_llm
        sdk_ref = engine.call({"op": "lookup_private", "query": site})["memories"][0]
        sdk_row = engine.stores["private_refs"].get(sdk_ref["id"])
        check("real_mem0_sdk_persisted_reference", identifier in sdk_row["memory"])
        check("private_excluded_from_fact_compression", not engine.rows()
              and engine.compact(True)["reason"] == "below_threshold")
        engine.close()
        engine = Mem0Engine(ROOT, isolated_config)
        reopened = engine.get(PREFIX + identifier)
        check("independent_sdk_reopen_recovers_reference", reopened["id"] == sdk_ref["id"])
        engine.stores["facts"].llm.request = no_llm
        original = engine.set("management_probe", "management_probe 原始普通记忆", ttl=1200)
        directory = engine.call({"op": "browse"})
        check("unified_real_sdk_browse_both_categories", directory["total"] == 2
              and {row["category"] for row in directory["items"]} == {"ordinary", "private"})
        check("unified_real_sdk_private_has_no_body", all(
            "text" not in row and "password" not in row and "username" not in row
            for row in directory["items"] if row["category"] == "private"
        ))
        page = engine.call({"op": "browse", "offset": 1, "limit": 1})
        check("unified_real_sdk_pagination", page["total"] == 2 and len(page["items"]) == 1)
        exact = engine.call({"op": "browse", "query": "management_probe"})
        check("unified_real_sdk_literal_search", exact["mode"] == "literal"
              and exact["total"] == 1 and exact["items"][0]["category"] == "ordinary")
        updated = engine.call({"op": "revise", "id": original["id"], "value": "更新普通记忆"})
        check("unified_real_sdk_revision_keeps_history", updated["id"] != original["id"]
              and len(engine.rows(history=True)) == 2 and len(engine.rows()) == 1)
        check("unified_real_sdk_revision_preserves_expiry", updated["expires"] == original["expires"]
              and not updated["verified"])
        removed = engine.call({"op": "remove_record", "id": updated["id"]})
        check("unified_real_sdk_delete_cannot_restore_old_version", removed["count"] == 2
              and engine.get("management_probe") is None and not engine.rows(history=True))
        engine.project = "another-project"
        check("project_isolation", not engine.call({"op": "lookup_private", "query": site})["memories"])
        engine.project = config.get("project", "rk")

        if args.agent:
            prompt = (
                "请调用rk_memory_memory工具，参数op为lookup_private，query为网站 " + site
                + "。查询它的私密登录记忆，最终answer只写工具返回的完整locator、空格竖线空格、resolver。"
                "定位符已经包含编号，不重复单写编号。不要输出账号密码，不执行登录，不编造编号。"
            )
            started = time.perf_counter()
            agent_env = running_agent_environment(folder)
            try:
                result = subprocess.run(
                    [str(ROOT / "bin/opencode"), "run", "--format", "json",
                     "--agent", "rk-memory", prompt], cwd=folder / "agent-workspace",
                    env=agent_env, stdin=subprocess.DEVNULL,
                    capture_output=True, text=True, timeout=120,
                )
            except subprocess.TimeoutExpired as error:
                (folder / "opencode.jsonl").write_bytes(error.stdout or b"")
                (folder / "opencode.stderr").write_bytes(error.stderr or b"")
                report["agent"] = {"timed_out": True, "seconds": time.perf_counter() - started}
                raise
            (folder / "opencode.jsonl").write_text(result.stdout, encoding="utf-8")
            (folder / "opencode.stderr").write_text(result.stderr, encoding="utf-8")
            events = []
            for line in result.stdout.splitlines():
                try:
                    events.append(json.loads(line))
                except ValueError:
                    pass
            answers = "\n".join(e.get("part", {}).get("text", "") for e in events if e.get("type") == "text")
            calls = [e for e in events if e.get("type") == "tool_use"
                     and e.get("part", {}).get("state", {}).get("status") == "completed"
                     and "memory" in e.get("part", {}).get("tool", "")]
            report["agent"] = {"exit_code": result.returncode, "seconds": time.perf_counter() - started,
                               "completed_memory_tools": len(calls), "answer": answers}
            check("real_agent_completed_memory_lookup", bool(calls))
            check("real_agent_correct_lookup_arguments", any(
                e["part"]["state"].get("input", {}).get("op") == "lookup_private"
                and site in e["part"]["state"].get("input", {}).get("query", "")
                for e in calls
            ))
            check("real_agent_process_success", result.returncode == 0)
            check("real_agent_exact_unknown_record", answers.strip()
                  == "rk-vault://" + identifier + " | coloop_private_login")
            check("no_secret_in_agent_session", all(value not in result.stdout + result.stderr
                                                    for value in (user_value, password)))

        vault({"op": "delete", "id": identifier})
        records.clear()
        check("delete_removes_live_reference", not any(
            row["private"]["record_id"] == identifier
            for row in client.lookup_private(site)["memories"]
        ))
        check("delete_removes_sdk_index", engine.get(PREFIX + identifier) is None)
        after = client.call({"op": "status"})
        check("ordinary_memory_unchanged", all(before[k] == after[k] for k in
              ("active_facts", "archived_versions", "capsules", "jobs")))
        home = ROOT / config.get("data_dir", ".runtime/mem0-v2")
        scanned = 0
        for base in (home, folder / "isolated-store"):
            for path in base.rglob("*"):
                if path.is_file():
                    data = path.read_bytes()
                    check("no_plaintext_in_mem0_storage", all(value.encode() not in data
                                                           for value in (user_value, password)))
                    scanned += 1
        report["scanned_memory_files"] = scanned
        report["passed"] = True
    finally:
        if engine:
            engine.close()
        for record in records:
            vault({"op": "delete", "id": record["id"]})
        client.call({"op": "sync_private"})
        client.request("/activity", {"session_id": lease, "active": False})
        report["source_sha256"] = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
            for name in ("agent/private_memory.py", "agent/mem0_engine.py", "agent/mcp_server.py")}
        (folder / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({"passed": report["passed"], "folder": str(folder), "checks": report["checks"]}))
    raise SystemExit(0 if report["passed"] else 1)


if __name__ == "__main__":
    main()
