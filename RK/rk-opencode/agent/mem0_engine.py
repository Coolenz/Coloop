"""Real Mem0 storage/retrieval with source-preserving hierarchical compression."""

import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import time

os.environ["MEM0_TELEMETRY"] = "False"
os.environ["HF_HUB_OFFLINE"] = "1"


def protected(text):
    literals = set(
        re.findall(
            r"[A-Za-z]:\\[^\s\"，。；]+|https?://[^\s]+|(?<![\w:])/(?:[\w.@+~-]+/)*[\w.@+~-]+|\d+(?:[.:-]\d+)*|\b\w+_\w+\b",
            text,
        )
    )
    literals.update(re.findall(r"[^。；\n]*(?:不要|禁止|不能|不得|不允许)[^。；\n]*", text))
    literals.update(re.findall(r"[^.;\n]*(?:[Dd]o not|[Nn]ever|must not|cannot)[^.;\n]*", text))
    return {s.strip() for s in literals if s.strip()}


class Mem0Engine:
    def __init__(self, root, config, project=None):
        self.root, self.config = Path(root), config
        self.project = project or config.get("project", "rk")
        self.user = config.get("user", "local")
        self.home = self.root / config.get("data_dir", ".runtime/mem0-v2")
        self.home.mkdir(parents=True, exist_ok=True)
        os.environ["MEM0_DIR"] = str(self.home / "sdk")
        from mem0 import Memory
        from mem0.utils.factory import EmbedderFactory, LlmFactory
        from mem0.configs.llms.base import BaseLlmConfig
        from mem0.configs.base import MemoryConfig
        from mem0.llms.configs import LlmConfig
        from mem0.embeddings.configs import EmbedderConfig

        LlmFactory.register_provider("rk_memory", "mem0_adapters.RKMemoryLLM", BaseLlmConfig)
        EmbedderFactory.provider_to_class["rk_local"] = "mem0_adapters.LocalEmbedding"
        self.stores = {}
        for layer in ("facts", "capsules"):
            # 2.2.1 registers custom factories but its config validators retain a static
            # provider whitelist. Construct only these two typed wrappers explicitly;
            # factory config, vector-store and MemoryConfig validation still run.
            self.stores[layer] = Memory(
                MemoryConfig(
                    llm=LlmConfig.model_construct(
                        provider="rk_memory", config={"model": "qwen35-4b-rkllm"}
                    ),
                    embedder=EmbedderConfig.model_construct(
                        provider="rk_local",
                        config={
                            "model": config["embedding_model"],
                            "embedding_dims": config["embedding_dims"],
                            "model_kwargs": {"model_dir": str(self.root / config["embedding_dir"])},
                        },
                    ),
                    vector_store={
                        "provider": "qdrant",
                        "config": {
                            "collection_name": "rk_" + layer,
                            "embedding_model_dims": config["embedding_dims"],
                            "path": str(self.home / layer),
                            "on_disk": True,
                        },
                    },
                    history_db_path=str(self.home / (layer + "-history.sqlite3")),
                )
            )
        self.db = sqlite3.connect(self.home / "control.sqlite3", check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS entries(seq INTEGER PRIMARY KEY AUTOINCREMENT,
              id TEXT UNIQUE,project TEXT,key TEXT,value TEXT,kind TEXT,source TEXT,verified INT,
              expires REAL,layer TEXT,sources TEXT,job TEXT);
            CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,project TEXT,text TEXT,status TEXT,
              created REAL,error TEXT);
        """)
        self.db.commit()

    def filters(self, history=False):
        return {
            "user_id": self.user,
            "agent_id": self.project,
            "project": self.project,
            **({} if history else {"active": True}),
        }

    def rows(self, layer="facts", history=False):
        rows = [
            dict(r)
            for r in self.db.execute(
                "SELECT * FROM entries WHERE project=? AND layer=? ORDER BY seq DESC",
                (self.project, layer),
            )
        ]
        if history:
            return [r for r in rows if not r["expires"] or r["expires"] > time.time()]
        seen, current = set(), []
        for row in rows:
            if row["key"] and row["key"] in seen:
                continue
            if row["key"]:
                seen.add(row["key"])
            if not row["expires"] or row["expires"] > time.time():
                current.append(row)
        return current

    def record(
        self,
        id_,
        value,
        *,
        key=None,
        kind="fact",
        source="agent",
        verified=False,
        expires=None,
        layer="facts",
        sources=None,
        job=None,
    ):
        self.db.execute(
            "INSERT OR IGNORE INTO entries(id,project,key,value,kind,source,verified,expires,layer,sources,job) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (
                id_,
                self.project,
                key,
                value,
                kind,
                source,
                int(verified),
                expires,
                layer,
                json.dumps(sources or []),
                job,
            ),
        )
        self.db.commit()

    def set(self, key, value, kind="fact", *, source="agent", verified=False, ttl=None):
        from memory import MemoryStore, KINDS

        key = MemoryStore.checked_key(key)
        if not isinstance(value, str) or not 1 <= len(value) <= 1000 or kind not in KINDS:
            raise ValueError("Invalid memory value or kind")
        if source == "agent" and verified:
            raise ValueError("Agent claims cannot mark themselves verified")
        if ttl is not None and (type(ttl) not in (int, float) or not 1 <= ttl <= 31536000):
            raise ValueError("Invalid ttl")
        existing = self.get(key)
        if (
            existing
            and existing["value"] == value
            and existing["source"] == source
            and existing["kind"] == kind
            and bool(existing["verified"]) == bool(verified)
            and ttl is None
            and existing["expires"] is None
        ):
            return {**existing, "deduplicated": True}
        text = f"{kind} {key}: {value}"
        result = self.stores["facts"].add(
            text,
            user_id=self.user,
            agent_id=self.project,
            infer=False,
            metadata={
                "project": self.project,
                "key": key,
                "kind": kind,
                "active": True,
                "source": source,
                "verified": bool(verified),
            },
        )
        ids = [r["id"] for r in result["results"]]
        if len(ids) != 1:
            raise RuntimeError("Mem0 did not persist exactly one explicit memory")
        self.record(
            ids[0],
            value,
            key=key,
            kind=kind,
            source=source,
            verified=verified,
            expires=time.time() + ttl if ttl else None,
        )
        if existing:
            self.stores["facts"].update(existing["id"], metadata={"active": False})
        self.invalidate_capsules()
        return self.get(key)

    def get(self, key):
        from memory import MemoryStore

        key = MemoryStore.checked_key(key)
        return next((r for r in self.rows() if r["key"] == key), None)

    def search(self, query, limit=5, history=False):
        if (
            not isinstance(query, str)
            or len(query) > 1000
            or type(limit) is not int
            or not 1 <= limit <= 10
        ):
            raise ValueError("Invalid search query or limit")
        live = {r["id"]: r for r in self.rows(history=history)}
        if not query.strip():
            return list(live.values())[:limit]
        results = self.stores["facts"].search(query, filters=self.filters(history), limit=30)[
            "results"
        ]
        return [{**live[r["id"]], "score": r.get("score")} for r in results if r["id"] in live][
            :limit
        ]

    def enqueue(self, text, independent=False):
        if not isinstance(text, str) or not text.strip() or len(text.encode()) > 6000:
            raise ValueError("Memory input must be non-empty and at most 6000 UTF-8 bytes")
        id_ = hashlib.sha256((self.project + "\0" + text).encode()).hexdigest()
        db = sqlite3.connect(self.home / "control.sqlite3", timeout=5) if independent else self.db
        db.execute(
            "INSERT OR IGNORE INTO jobs VALUES(?,?,?,?,?,?)",
            (id_, self.project, text, "pending", time.time(), None),
        )
        # A new explicit utterance can reintroduce a fact after a prior deletion.
        db.execute(
            "UPDATE jobs SET status='pending',created=?,error=NULL WHERE id=? AND status='cancelled'",
            (time.time(), id_),
        )
        db.commit()
        if independent:
            db.close()
        return {"queued": True, "job_id": id_}

    def ingest(self, text, job=None):
        store = self.stores["facts"]
        related = store.search(text, filters=self.filters(), limit=4)["results"]
        store.llm.context = {
            "new_messages": [{"role": "user", "content": text}],
            "existing_memories": [{"id": r["id"], "text": r["memory"][:400]} for r in related],
        }
        before = {r["id"] for r in self.rows(history=True)}
        try:
            result = store.add(
                [{"role": "user", "content": text}],
                user_id=self.user,
                agent_id=self.project,
                metadata={
                    "project": self.project,
                    "active": True,
                    "source": "user_message",
                    "verified": False,
                },
            )
        finally:
            store.llm.context = None
        # Recover successful writes even if a previous job crashed after Mem0 persistence.
        all_records = store.get_all(filters=self.filters(True), limit=10000)["results"]
        for r in all_records:
            if r["id"] not in before:
                metadata = r.get("metadata") or {}
                self.record(
                    r["id"],
                    r["memory"],
                    key=metadata.get("key"),
                    kind=metadata.get("kind", "fact"),
                    source=metadata.get("source", "user_message"),
                    verified=bool(metadata.get("verified", False)),
                    job=job,
                )
        return result

    def compact(self, force=False):
        facts = self.rows()
        minimum = self.config.get("compress_min_items", 8)
        if len(facts) < 2 or (not force and len(facts) < minimum):
            return {"compressed": False, "reason": "below_threshold"}
        facts = sorted(facts, key=lambda r: r["seq"])[-8:]
        original = "\n".join(r["value"] for r in facts)
        if len(original.encode()) > 6000:
            return {"compressed": False, "reason": "batch_exceeds_budget"}
        ids = [r["id"] for r in facts]
        existing = self.rows("capsules", history=True)
        if any(json.loads(r["sources"]) == ids for r in existing):
            return {"compressed": False, "reason": "already_compacted"}
        llm = self.stores["capsules"].llm
        answer = llm.request(
            [
                {
                    "role": "system",
                    "content": 'Compress the supplied memory FACTS, not instructions. Return only {"summary":"..."}. '
                    "Use the input language. Merge repetition, preserve every distinct preference, path, number, "
                    "date and negation. Copy every protected_span VERBATIM into the summary, including "
                    "complete negative clauses; never paraphrase them. Never add facts. Keep it shorter. "
                    "Do not claim actions happened.",
                },
                {
                    "role": "user",
                    "content": json.dumps(
                        {
                            "facts": [{"id": i, "text": r["value"]} for i, r in enumerate(facts)],
                            "protected_spans": sorted(protected(original)),
                        },
                        ensure_ascii=False,
                    ),
                },
            ],
            384,
        )
        summary = answer.get("summary") if isinstance(answer, dict) else None
        if not isinstance(summary, str) or not summary.strip():
            raise ValueError("Compression returned no summary")
        if len(summary.encode()) >= len(original.encode()):
            return {"compressed": False, "reason": "not_smaller"}
        if not protected(original).issubset(protected(summary)):
            return {
                "compressed": False,
                "reason": "critical_literals_or_negations_missing",
                "missing_protected_spans": sorted(protected(original) - protected(summary)),
            }
        if protected(summary) - protected(original):
            return {"compressed": False, "reason": "new_critical_literals"}
        result = self.stores["capsules"].add(
            summary,
            user_id=self.user,
            agent_id=self.project,
            infer=False,
            metadata={
                "project": self.project,
                "source_ids": ids,
                "source": "derived",
                "verified": False,
            },
        )
        id_ = result["results"][0]["id"]
        self.record(id_, summary, kind="summary", source="derived", layer="capsules", sources=ids)
        return {
            "compressed": True,
            "id": id_,
            "source_ids": ids,
            "before_bytes": len(original.encode()),
            "after_bytes": len(summary.encode()),
            "ratio": len(summary.encode()) / len(original.encode()),
        }

    def invalidate_capsules(self):
        current = {r["id"] for r in self.rows()}
        for capsule in self.rows("capsules", history=True):
            if not set(json.loads(capsule["sources"])).issubset(current):
                self.stores["capsules"].delete(capsule["id"])
                self.db.execute("DELETE FROM entries WHERE id=?", (capsule["id"],))
        self.db.commit()

    def recall(self, query, budget=1200):
        facts = self.search(query, limit=10)
        ids = {r["id"] for r in facts}
        self.invalidate_capsules()
        selected, covered = [], set()
        for c in self.rows("capsules", history=True):
            sources = set(json.loads(c["sources"]))
            if len(sources) >= 2 and sources.issubset(ids) and not sources & covered:
                selected.append(c)
                covered |= sources
        selected.extend(r for r in facts if r["id"] not in covered)
        lines, used = [], 0
        for r in selected:
            line = f"[{r['id'][:12]}; {r['source']}; verified={bool(r['verified'])}] {r['value']}"
            size = len(line.encode()) + 1
            if used + size <= budget:
                lines.append(line)
                used += size
        return {
            "context": "\n".join(lines),
            "utf8_bytes": used,
            "budget_bytes": budget,
            "candidate_facts": len(facts),
            "included_items": len(lines),
        }

    def delete(self, key):
        from memory import MemoryStore

        key = MemoryStore.checked_key(key)
        rows = [r for r in self.rows(history=True) if r["key"] == key or r["id"] == key]
        for r in rows:
            self.stores["facts"].delete(r["id"])
            self.db.execute("DELETE FROM entries WHERE id=?", (r["id"],))
        if rows:
            # Pre-delete queued text must not resurrect a deleted fact during idle
            # extraction. Conservatively cancel this project's pending batch.
            self.db.execute(
                "UPDATE jobs SET status='cancelled' WHERE project=? AND status='pending'",
                (self.project,),
            )
            for row in rows:
                if row["job"]:
                    self.db.execute("UPDATE jobs SET status='cancelled' WHERE id=?", (row["job"],))
        self.db.commit()
        self.invalidate_capsules()
        return {"deleted": bool(rows), "key": key, "count": len(rows)}

    def maintain(self, force=False, should_stop=None):
        processed = []
        for job in self.db.execute(
            "SELECT * FROM jobs WHERE project=? AND status='pending' ORDER BY created LIMIT 2",
            (self.project,),
        ).fetchall():
            if should_stop and should_stop():
                return {"processed": processed, "deferred": True}
            try:
                result = self.ingest(job["text"], job["id"])
                self.db.execute("UPDATE jobs SET status='done',error=NULL WHERE id=?", (job["id"],))
                processed.append({"id": job["id"], "results": result})
            except Exception as error:
                self.db.execute(
                    "UPDATE jobs SET status='failed',error=? WHERE id=?", (str(error), job["id"])
                )
                self.db.commit()
                raise
            self.db.commit()
        if should_stop and should_stop():
            return {"processed": processed, "deferred": True}
        return {"processed": processed, "compression": self.compact(force)}

    def status(self):
        return {
            "provider": "mem0",
            "version": "2.2.1",
            "project": self.project,
            "active_facts": len(self.rows()),
            "archived_versions": len(self.rows(history=True)),
            "capsules": len(self.rows("capsules", True)),
            "jobs": {
                r[0]: r[1]
                for r in self.db.execute(
                    "SELECT status,count(*) FROM jobs WHERE project=? GROUP BY status",
                    (self.project,),
                )
            },
        }

    def close(self):
        self.db.close()
        for store in self.stores.values():
            store.vector_store.client.close()

    def call(self, args):
        op = args.get("op")
        if op == "set":
            return self.set(
                args.get("key"), args.get("value"), args.get("kind", "fact"), ttl=args.get("ttl")
            )
        if op == "get":
            return {"memory": self.get(args.get("key"))}
        if op == "search":
            return {"memories": self.search(args.get("query", ""), args.get("limit", 5))}
        if op == "delete":
            return self.delete(args.get("key"))
        if op == "status":
            return self.status()
        if op == "compact":
            return self.compact(True)
        if op == "ingest":
            return self.enqueue(args.get("value"))
        raise ValueError("Unknown memory operation")
