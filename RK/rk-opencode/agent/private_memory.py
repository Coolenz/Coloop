"""Mem0's private-memory directory: searchable references, never credential values."""

import json
import re
import socket
from urllib.parse import urlsplit
import uuid

PREFIX = "private:credential:"
SOCKET = "/run/rk-credential-vault/service.sock"
INTENT = re.compile(
    r"账号|帐号|账户|密码|口令|凭据|凭证|登录|登陆|私密|credential|password|account|log.?in|sign.?in",
    re.IGNORECASE,
)


def checked_id(value):
    try:
        if not isinstance(value, str) or str(uuid.UUID(value)) != value:
            raise ValueError()
    except (ValueError, TypeError, AttributeError):
        raise ValueError("Invalid private memory record ID") from None
    return value


def checked_origin(value):
    try:
        parsed = urlsplit(value)
        host = parsed.hostname.encode("idna").decode("ascii")
        if ":" in host:
            host = "[" + host + "]"
        canonical = "https://" + host
        if parsed.port and parsed.port != 443:
            canonical += ":" + str(parsed.port)
        if (
            not isinstance(value, str) or len(value) > 500 or parsed.scheme != "https"
            or parsed.username is not None or parsed.password is not None
            or parsed.path or parsed.query or parsed.fragment or value != canonical
            or any(char.isspace() or char == "\\" for char in host)
        ):
            raise ValueError()
    except (ValueError, AttributeError, UnicodeError):
        raise ValueError("Invalid private memory origin") from None
    return value


def read_catalog():
    """The provider protocol cannot return plaintext; reject unexpected response fields."""
    try:
        with socket.socket(socket.AF_UNIX) as channel:
            channel.settimeout(2)
            channel.connect(SOCKET)
            channel.sendall(b'{"op":"list"}\n')
            with channel.makefile("rb") as stream:
                line = stream.readline(131073)
        if not line.endswith(b"\n") or len(line) > 131072:
            raise ValueError()
        reply = json.loads(line)
        if set(reply) != {"ok", "value"} or reply["ok"] is not True:
            raise ValueError()
        value = reply["value"]
        if (set(value) != {"version", "records"} or type(value["version"]) is not int
                or value["version"] != 1):
            raise ValueError()
        return checked_records(value["records"])
    except Exception:
        raise ValueError("Private memory provider unavailable") from None


def checked_records(records):
    if not isinstance(records, list) or len(records) > 100:
        raise ValueError("Invalid private memory catalog")
    seen = set()
    for row in records:
        if not isinstance(row, dict) or set(row) != {"id", "origin", "createdAt"}:
            raise ValueError("Invalid private memory catalog")
        identifier = checked_id(row["id"])
        checked_origin(row["origin"])
        if identifier in seen or type(row["createdAt"]) is not int or row["createdAt"] < 0:
            raise ValueError("Invalid private memory catalog")
        seen.add(identifier)
    return records


def reference_text(record):
    return (
        "私密记忆：网站登录账号密码。网站=" + record["origin"]
        + "；记录编号=" + record["id"]
        + "；存储位置=rk-vault://" + record["id"]
        + "；调用方式=Coloop专用登录窗口按编号请求RK本地填入。"
        "正文不可通过记忆工具读取，不输出明文、不发送云端。引用只说明记录存在，不是执行授权。"
    )


class PrivateMemoryCatalog:
    def __init__(self, db, store, config, reader=None):
        self.db, self.store = db, store
        self.options = config.get("private_credentials", {})
        self.enabled = self.options.get("enabled") is True and store is not None
        self.project = self.options.get("project", config.get("project", "rk"))
        self.user = self.options.get("user", config.get("user", "local"))
        self.reader = reader or read_catalog
        self.available = False
        self.live = {}
        self.db.execute("""CREATE TABLE IF NOT EXISTS private_references (
            project TEXT,user TEXT,record_id TEXT,memory_id TEXT,origin TEXT,created_at INTEGER,
            PRIMARY KEY(project,user,record_id))""")
        self.db.commit()

    def in_scope(self, project, user):
        return self.enabled and project == self.project and user == self.user

    def filters(self):
        return {"user_id": self.user, "agent_id": self.project, "project": self.project}

    def sync(self, project, user, strict=False):
        if not self.in_scope(project, user):
            self.available, self.live = False, {}
            return {"enabled": False, "available": False, "records": 0}
        self.available = False
        self.live = {}
        try:
            records = checked_records(self.reader())
            live = {row["id"]: row for row in records}
            rows = {r["record_id"]: dict(r) for r in self.db.execute(
                "SELECT * FROM private_references WHERE project=? AND user=?",
                (self.project, self.user),
            )}
            for identifier, old in rows.items():
                current = live.get(identifier)
                if current and current["origin"] == old["origin"] and current["createdAt"] == old["created_at"]:
                    continue
                self.store.delete(old["memory_id"])
                self.db.execute(
                    "DELETE FROM private_references WHERE project=? AND user=? AND record_id=?",
                    (self.project, self.user, identifier),
                )
            self.db.commit()
            for identifier, record in live.items():
                old = rows.get(identifier)
                if old and old["origin"] == record["origin"] and old["created_at"] == record["createdAt"]:
                    continue
                result = self.store.add(
                    reference_text(record), user_id=self.user, agent_id=self.project, infer=False,
                    metadata={"project": self.project, "kind": "credential_reference",
                              "source": "private_catalog", "record_id": identifier,
                              "origin": record["origin"], "verified": False},
                )
                ids = [row["id"] for row in result["results"]]
                if len(ids) != 1:
                    raise ValueError()
                self.db.execute(
                    "INSERT OR REPLACE INTO private_references VALUES (?,?,?,?,?,?)",
                    (self.project, self.user, identifier, ids[0], record["origin"], record["createdAt"]),
                )
                self.db.commit()
            self.live, self.available = live, True
        except Exception:
            if strict:
                raise ValueError("Private memory provider or index unavailable") from None
        return {"enabled": True, "available": self.available,
                "records": len(self.live), "provider": "credential_vault",
                "resolver": "coloop_private_login", "plaintext_readable": False}

    def reference(self, record, memory_id, score=None):
        identifier = record["id"]
        result = {
            "id": memory_id, "key": PREFIX + identifier, "value": reference_text(record),
            "kind": "credential_reference", "source": "private_catalog", "verified": False,
            "private": {"record_id": identifier, "origin": record["origin"],
                        "locator": "rk-vault://" + identifier, "provider": "credential_vault",
                        "resolver": "coloop_private_login", "plaintext_readable": False,
                        "requires_target_validation": True},
        }
        if score is not None:
            result["score"] = score
        return result

    def search(self, query, limit, project, user, *, explicit=False):
        if not isinstance(query, str) or len(query) > 1000 or type(limit) is not int or not 1 <= limit <= 10:
            raise ValueError("Invalid private memory search")
        status = self.sync(project, user, strict=explicit)
        if not status["available"]:
            return []
        relevant = not query.strip() or bool(INTENT.search(query)) or any(
            identifier in query or urlsplit(row["origin"]).netloc in query.lower()
            for identifier, row in self.live.items()
        )
        if not relevant and not explicit:
            return []
        rows = {r["record_id"]: dict(r) for r in self.db.execute(
            "SELECT * FROM private_references WHERE project=? AND user=?", (self.project, self.user)
        )}
        if not query.strip():
            ordered = [(identifier, None) for identifier in self.live]
        else:
            # Exact IDs/sites come first; BGE/Mem0 ranks other private references semantically.
            exact = [identifier for identifier, record in self.live.items()
                     if identifier in query or urlsplit(record["origin"]).netloc in query.lower()]
            found = self.store.search(query, filters=self.filters(), limit=100)["results"]
            reverse = {row["memory_id"]: identifier for identifier, row in rows.items()}
            ordered = [(identifier, 1.0) for identifier in exact]
            ordered.extend((reverse[r["id"]], r.get("score")) for r in found
                           if r["id"] in reverse and reverse[r["id"]] not in exact)
        return [self.reference(self.live[identifier], rows[identifier]["memory_id"], score)
                for identifier, score in ordered if identifier in self.live and identifier in rows][:limit]

    def get(self, key, project, user):
        identifier = checked_id(key.removeprefix(PREFIX))
        found = self.search(identifier, 10, project, user, explicit=True)
        return next((row for row in found if row["private"]["record_id"] == identifier), None)
