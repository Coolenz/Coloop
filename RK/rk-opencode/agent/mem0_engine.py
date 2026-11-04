"""Real Mem0 storage/retrieval with source-preserving hierarchical compression."""

import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import time
import unicodedata

from private_memory import PREFIX as PRIVATE_PREFIX, PrivateMemoryCatalog

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
        layers = ["facts", "capsules"]
        if config.get("private_credentials", {}).get("enabled") is True:
            layers.append("private_refs")
        for layer in layers:
            # 2.2.1 registers custom factories but its config validators retain a static
            # provider whitelist. Construct only these two typed wrappers explicitly;
            # factory config, vector-store and MemoryConfig validation still run.
            self.stores[layer] = Memory(
                MemoryConfig(
                    llm=LlmConfig.model_construct(
                        provider="rk_memory", config={"model": "active-local-rkllm"}
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
        self.init_catalog()
        self.private_catalog = PrivateMemoryCatalog(
            self.db, self.stores.get("private_refs"), config
        )

    def init_catalog(self):
        """Additive sidecar schema; old Mem0 vectors and entry versions stay intact."""
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS memory_descriptors(
              memory_id TEXT PRIMARY KEY, summary TEXT NOT NULL, source_task_id TEXT);
            CREATE TABLE IF NOT EXISTS memory_tags(
              memory_id TEXT NOT NULL,tag TEXT NOT NULL,PRIMARY KEY(memory_id,tag));
            CREATE INDEX IF NOT EXISTS memory_tags_lookup ON memory_tags(tag,memory_id);
        """)
        self.db.commit()

    @staticmethod
    def checked_tags(tags):
        if not isinstance(tags, list) or len(tags) > 8:
            raise ValueError("tags must contain at most 8 strings")
        result = []
        for tag in tags:
            if not isinstance(tag, str):
                raise ValueError("Invalid memory tag")
            tag = unicodedata.normalize("NFC", tag.strip())
            prefix, separator, value = tag.partition(":")
            tag = prefix.lower() + separator + value
            if not 1 <= len(tag) <= 64 or any(ord(c) < 32 for c in tag):
                raise ValueError("Invalid memory tag")
            if tag not in result:
                result.append(tag)
        return sorted(result)

    def descriptor(self, identifier):
        row = self.db.execute(
            "SELECT summary,source_task_id FROM memory_descriptors WHERE memory_id=?",
            (identifier,),
        ).fetchone()
        tags = [r[0] for r in self.db.execute(
            "SELECT tag FROM memory_tags WHERE memory_id=? ORDER BY tag", (identifier,)
        )]
        return {"tags": tags, "summary": row[0] if row else "",
                "sourceTaskId": row[1] if row else None}

    def catalog(self, tags=None, query="", limit=5):
        tags = self.checked_tags([] if tags is None else tags)
        if not isinstance(query, str) or len(query) > 1000 or type(limit) is not int or not 1 <= limit <= 5:
            raise ValueError("Invalid catalog query or limit")
        # Current IDs are authoritative, including deletion, TTL and supersession.
        live = {r["id"]: r for r in self.rows()}
        if tags:
            placeholders = ",".join("?" for _ in tags)
            found = self.db.execute(
                f"SELECT memory_id FROM memory_tags WHERE tag IN ({placeholders}) "
                "GROUP BY memory_id HAVING COUNT(DISTINCT tag)=?", (*tags, len(tags)),
            )
            candidates = {r[0] for r in found}
            live = {id_: row for id_, row in live.items() if id_ in candidates}
        if query.strip() and live:
            found = self.stores["facts"].search(query, filters=self.filters(), limit=30)["results"]
            rows = [live[r["id"]] for r in found if r["id"] in live]
        else:
            rows = list(live.values())
        return {"memories": [{"id": r["id"], "key": r["key"], "kind": r["kind"],
                  "source": r["source"], "verified": bool(r["verified"]), "expiresAt": r["expires"],
                  **self.descriptor(r["id"])} for r in rows[:limit]]}

    def get_many(self, identifiers):
        if (not isinstance(identifiers, list) or not 1 <= len(identifiers) <= 5
                or any(not isinstance(id_, str) or not 1 <= len(id_) <= 128 for id_ in identifiers)
                or len(set(identifiers)) != len(identifiers)):
            raise ValueError("ids must contain 1..5 unique memory IDs")
        live = {r["id"]: r for r in self.rows()}
        return {"memories": [{**live[id_], **self.descriptor(id_)} for id_ in identifiers if id_ in live],
                "missing": [id_ for id_ in identifiers if id_ not in live]}

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

    def set(self, key, value, kind="fact", *, source="agent", verified=False, ttl=None,
            tags=None, summary=None, source_task_id=None):
        from memory import MemoryStore, KINDS

        key = MemoryStore.checked_key(key)
        if key.startswith(PRIVATE_PREFIX):
            raise ValueError("Private memory references are maintained by their provider")
        if not isinstance(value, str) or not 1 <= len(value) <= 1000 or kind not in KINDS:
            raise ValueError("Invalid memory value or kind")
        if source == "agent" and verified:
            raise ValueError("Agent claims cannot mark themselves verified")
        if ttl is not None and (type(ttl) not in (int, float) or not 1 <= ttl <= 31536000):
            raise ValueError("Invalid ttl")
        existing = self.get(key)
        previous = self.descriptor(existing["id"]) if existing else {}
        tags = self.checked_tags(previous.get("tags", []) if tags is None else tags)
        summary = previous.get("summary", "") if summary is None else summary
        source_task_id = previous.get("sourceTaskId") if source_task_id is None else source_task_id
        if not isinstance(summary, str) or len(summary) > 160 or "\x00" in summary:
            raise ValueError("summary must contain at most 160 characters")
        if source_task_id is not None and (not isinstance(source_task_id, str)
                or not 1 <= len(source_task_id) <= 128 or "\x00" in source_task_id):
            raise ValueError("Invalid source task ID")
        if (
            existing
            and existing["value"] == value
            and existing["source"] == source
            and existing["kind"] == kind
            and bool(existing["verified"]) == bool(verified)
            and ttl is None
            and existing["expires"] is None
        ):
            self.write_descriptor(existing["id"], tags, summary, source_task_id)
            return {**existing, **self.descriptor(existing["id"]), "deduplicated": True}
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
                "tags": tags,
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
        self.write_descriptor(ids[0], tags, summary, source_task_id)
        if existing:
            self.stores["facts"].update(existing["id"], metadata={"active": False})
        self.invalidate_capsules()
        return self.get(key)

    def write_descriptor(self, identifier, tags, summary, source_task_id):
        with self.db:
            self.db.execute("INSERT OR REPLACE INTO memory_descriptors VALUES(?,?,?)",
                            (identifier, summary, source_task_id))
            self.db.execute("DELETE FROM memory_tags WHERE memory_id=?", (identifier,))
            self.db.executemany("INSERT INTO memory_tags VALUES(?,?)",
                                [(identifier, tag) for tag in tags])

    def get(self, key):
        from memory import MemoryStore

        key = MemoryStore.checked_key(key)
        if key.startswith(PRIVATE_PREFIX):
            return self.private_catalog.get(key, self.project, self.user)
        row = next((r for r in self.rows() if r["key"] == key), None)
        return {**row, **self.descriptor(row["id"])} if row else None

    def search(self, query, limit=5, history=False):
        if (
            not isinstance(query, str)
            or len(query) > 1000
            or type(limit) is not int
            or not 1 <= limit <= 10
        ):
            raise ValueError("Invalid search query or limit")
        live = {r["id"]: r for r in self.rows(history=history)}
        private = [] if history else self.private_catalog.search(
            query, limit, self.project, self.user
        )
        if not query.strip():
            return (private + list(live.values()))[:limit]
        results = self.stores["facts"].search(query, filters=self.filters(history), limit=30)[
            "results"
        ]
        ordinary = [{**live[r["id"]], "score": r.get("score")}
                    for r in results if r["id"] in live]
        return (private + ordinary)[:limit]

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
        if key.startswith(PRIVATE_PREFIX):
            raise ValueError("Delete private memory through Coloop's protected credential manager")
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
            "private_memory": self.private_catalog.sync(self.project, self.user),
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

    def browse(self, query="", category="all", offset=0, limit=25):
        if (not isinstance(query, str) or len(query) > 1000
                or category not in ("all", "ordinary", "private")
                or type(offset) is not int or not 0 <= offset <= 100000
                or type(limit) is not int or not 1 <= limit <= 50):
            raise ValueError("Invalid memory browsing parameters")
        private_status = self.private_catalog.sync(self.project, self.user)
        ordinary = self.rows() if category != "private" else []
        private = []
        if category != "ordinary" and private_status["available"]:
            private = [{"private": {"record_id": row["id"], "origin": row["origin"],
                        "locator": "rk-vault://" + row["id"],
                        "resolver": "coloop_private_login"}, "createdAt": row["createdAt"]}
                       for row in self.private_catalog.live.values()]
        mode = "all"
        if query.strip():
            needle = query.strip().casefold()
            exact_facts = [row for row in ordinary if needle in (
                (row["key"] or "") + "\n" + row["value"] + "\n" + row["id"] + "\n"
                + " ".join(self.descriptor(row["id"])["tags"])
            ).casefold()]
            exact_private = [row for row in private if needle in (
                row["private"]["origin"] + "\n" + row["private"]["locator"]
                + "\n" + PRIVATE_PREFIX + row["private"]["record_id"]
            ).casefold()]
            if exact_facts or exact_private:
                ordinary, private, mode = exact_facts, exact_private, "literal"
            else:
                mode = "semantic"
                if ordinary:
                    live = {row["id"]: row for row in ordinary}
                    found = self.stores["facts"].search(query, filters=self.filters(), limit=30)["results"]
                    ordinary = [{**live[row["id"]], "score": row.get("score", 0)}
                                for row in found if row["id"] in live][:10]
                if private:
                    private = self.private_catalog.search(
                        query, 10, self.project, self.user, explicit=True
                    )
        items = [{"id": row["id"], "category": "ordinary", "key": row["key"],
                  "text": row["value"], "kind": row["kind"], "source": row["source"],
                  "verified": bool(row["verified"]), "expiresAt": row["expires"],
                  "score": row.get("score", 0), **self.descriptor(row["id"])} for row in ordinary]
        items += [{"id": PRIVATE_PREFIX + row["private"]["record_id"], "category": "private",
                   "recordId": row["private"]["record_id"], "origin": row["private"]["origin"],
                   "locator": row["private"]["locator"], "resolver": "coloop_private_login",
                   "protected": True, "score": row.get("score", 0)} for row in private]
        if query.strip():
            items.sort(key=lambda row: row["score"] or 0, reverse=True)
        for row in items:
            row.pop("score")
        return {"items": items[offset:offset + limit], "total": len(items),
                "offset": offset, "limit": limit, "mode": mode, "private_memory": private_status}

    def revise(self, identifier, value, tags=None, summary=None):
        old = next((row for row in self.rows() if row["id"] == identifier), None)
        if old is None:
            raise ValueError("Ordinary memory no longer exists")
        key = old["key"] or "memory_" + old["id"]
        if old["key"] is None:
            if self.get(key) is not None:
                raise ValueError("Generated memory key already exists")
            self.db.execute("UPDATE entries SET key=? WHERE id=?", (key, identifier))
            self.db.commit()
        try:
            current = self.set(key, value, old["kind"], tags=tags, summary=summary)
        except Exception:
            persisted = self.get(key)
            if old["key"] is None and (persisted is None or persisted["id"] == identifier):
                self.db.execute("UPDATE entries SET key=NULL WHERE id=?", (identifier,))
                self.db.commit()
            raise
        if old["expires"] is not None:
            self.db.execute("UPDATE entries SET expires=? WHERE id=?", (old["expires"], current["id"]))
            self.db.commit()
        return self.get(key)

    def call(self, args):
        op = args.get("op")
        if op == "browse":
            return self.browse(args.get("query", ""), args.get("category", "all"),
                               args.get("offset", 0), args.get("limit", 25))
        if op == "revise":
            return self.revise(args.get("id"), args.get("value"), args.get("tags"), args.get("summary"))
        if op == "catalog":
            return self.catalog(args.get("tags"), args.get("query", ""), args.get("limit", 5))
        if op == "get_many":
            return self.get_many(args.get("ids"))
        if op == "remove_record":
            current = next((row for row in self.rows() if row["id"] == args.get("id")), None)
            return self.delete(current["key"] or current["id"]) if current else {"deleted": False, "count": 0}
        if op == "lookup_private":
            return {"memories": self.private_catalog.search(
                args.get("query", ""), args.get("limit", 5), self.project, self.user,
                explicit=True,
            ), "private_memory": {
                "enabled": self.private_catalog.in_scope(self.project, self.user),
                "available": self.private_catalog.available,
                "provider": "credential_vault", "plaintext_readable": False,
            }}
        if op == "sync_private":
            return {"private_memory": self.private_catalog.sync(
                self.project, self.user, strict=True
            )}
        if op == "set":
            return self.set(
                args.get("key"), args.get("value"), args.get("kind", "fact"), ttl=args.get("ttl"),
                tags=args.get("tags"), summary=args.get("summary"), source_task_id=args.get("source_task_id")
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
