"""Exercise real Mem0/Chinese embeddings; optionally RKLLM extraction/compression."""

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import sys
import time
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agent"))
from mem0_engine import Mem0Engine, protected  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--local", action="store_true", help="PC embeddings and simulated LLM guards"
    )
    parser.add_argument("--activate", action="store_true")
    args = parser.parse_args()
    if args.local and args.activate:
        parser.error("Local simulated LLM checks cannot activate production")
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    folder = ROOT / "logs" / ("mem0-validation-" + stamp)
    folder.mkdir(parents=True)
    config_path = ROOT / ".runtime/memory-config.json"
    config = (
        {
            "embedding_model": "BAAI/bge-small-zh-v1.5",
            "embedding_dims": 512,
            "embedding_dir": ".cache/memory-model",
        }
        if args.local
        else json.loads(config_path.read_text())
    )
    config = {**config, "data_dir": str(folder / "store"), "project": "validation-" + stamp}
    os.environ["RK_AGENT_ROOT"] = str(ROOT)
    report = {"passed": False, "real_llm": not args.local, "checks": {}, "config": config}
    started = time.perf_counter()
    engine = None

    def check(name, condition):
        report["checks"][name] = bool(condition)
        if not condition:
            raise AssertionError(name)

    try:
        engine = Mem0Engine(ROOT, config)
        a = engine.set("save_dir", r"生成的文件默认保存在 D:\RK\agent-output", "preference")
        engine.set("theme", "用户喜欢深色界面", "preference")
        engine.set("language", "用户希望使用中文交流", "preference")
        before = time.perf_counter()
        found = engine.search("输出结果应该存到哪个文件夹", 3)
        report["semantic_search_ms"] = (time.perf_counter() - before) * 1000
        report["semantic_results"] = found
        check("chinese_paraphrase_top1", found[0]["id"] == a["id"])
        check(
            "same_key_exact_dedup",
            engine.set("save_dir", a["value"], "preference")["id"] == a["id"],
        )
        project = engine.project
        engine.project = "other-" + project
        check("project_isolation", not engine.search("保存目录"))
        engine.project = project
        changed = engine.set("save_dir", r"生成的文件默认保存在 D:\RK\new-output", "preference")
        check("preference_update_current", engine.get("save_dir")["id"] == changed["id"])
        check(
            "preference_history_retained", a["id"] in {r["id"] for r in engine.rows(history=True)}
        )
        engine.set("temporary", "旧值")
        engine.set("temporary", "新值", ttl=1)
        with patch("mem0_engine.time.time", return_value=time.time() + 2):
            check("expiry_no_old_resurrection", engine.get("temporary") is None)
        try:
            engine.set("bad", "model claim", verified=True)
            check("cannot_self_verify", False)
        except ValueError:
            check("cannot_self_verify", True)
        check("recall_budget", len(engine.recall("保存目录", 180)["context"].encode()) <= 180)
        queued = engine.enqueue("用户希望使用中文交流")
        engine.delete("language")
        state = engine.db.execute(
            "SELECT status FROM jobs WHERE id=?", (queued["job_id"],)
        ).fetchone()[0]
        check("delete_cancels_stale_queue", state == "cancelled")
        engine.enqueue("用户希望使用中文交流")
        state = engine.db.execute(
            "SELECT status FROM jobs WHERE id=?", (queued["job_id"],)
        ).fetchone()[0]
        check("new_utterance_can_reintroduce", state == "pending")
        for row in list(engine.rows()):
            engine.delete(row["key"] or row["id"])

        text = "我的开发板是鲁班猫4，项目名称是星河助手。我希望回答一直使用中文。"
        if args.local:
            extractor = engine.stores["facts"].llm
            extractor.request = lambda *a, **k: {
                "memory": [
                    {
                        "text": "用户的开发板是鲁班猫4",
                        "attributed_to": "user",
                        "linked_memory_ids": [],
                    }
                ]
            }
        before = time.perf_counter()
        report["extraction"] = engine.ingest(text)
        report["extraction_seconds"] = time.perf_counter() - before
        extracted = engine.rows()
        check("sdk_infer_true_persisted", bool(extracted))
        check(
            "extracted_source_unverified",
            all(r["source"] == "user_message" and not r["verified"] for r in extracted),
        )
        report["extracted_facts"] = extracted
        count = len(extracted)
        engine.ingest(text)
        check("repeat_extraction_dedup", len(engine.rows()) == count)
        for row in list(engine.rows()):
            engine.delete(row["key"] or row["id"])

        phrase = r"项目生成的文件默认保存到 D:\RK\agent-output。不要自动覆盖已有文件。每次最多处理512条记录。"
        for i in range(8):
            engine.set("rule_" + str(i), "项目长期规则，后续任务均需遵守：" + phrase, "preference")
        llm = engine.stores["capsules"].llm
        if args.local:
            llm.request = lambda *a, **k: {"summary": phrase}
        before = time.perf_counter()
        report["compression"] = engine.compact(True)
        report["compression_seconds"] = time.perf_counter() - before
        check("compression_saved", report["compression"].get("compressed"))
        capsule = engine.rows("capsules", True)[0]
        check(
            "compression_literals_preserved",
            protected(phrase).issubset(protected(capsule["value"])),
        )
        check("compression_raw_facts_retained", len(engine.rows()) == 8)
        check("compression_has_lineage", len(json.loads(capsule["sources"])) == 8)
        recall = engine.recall("项目长期规则与保存文件目录", 1200)
        report["compressed_recall"] = recall
        check("compressed_recall_used", capsule["id"][:12] in recall["context"])
        engine.delete("rule_0")
        check("delete_invalidates_capsule", not engine.rows("capsules", True))
        llm.request = lambda *a, **k: {"summary": "默认保存文件。"}
        rejected = engine.compact(True)
        check(
            "lossy_summary_rejected",
            rejected.get("reason") == "critical_literals_or_negations_missing",
        )
        llm.request = lambda *a, **k: {"summary": phrase + "上限999条。"}
        check(
            "invented_literal_rejected",
            engine.compact(True).get("reason") == "new_critical_literals",
        )
        report["passed"] = True
    except Exception as error:
        report["error"] = repr(error)
        raise
    finally:
        if engine:
            engine.close()
        report["seconds"] = time.perf_counter() - started
        report["source_sha256"] = {
            p.name: hashlib.sha256(p.read_bytes()).hexdigest()
            for p in (ROOT / "agent").glob("mem0_*.py")
        }
        (folder / "report.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(
            json.dumps(
                {
                    "report": str(folder / "report.json"),
                    "passed": report["passed"],
                    "checks": report["checks"],
                },
                ensure_ascii=False,
            )
        )
    if args.activate:
        current = json.loads(config_path.read_text())
        current.update(
            enabled=True, auto_maintain=True, validation_report=str(folder / "report.json")
        )
        temporary = config_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(current, indent=2))
        temporary.replace(config_path)
        print("Mem0 enabled after real embedding/NPU validation")


if __name__ == "__main__":
    main()
