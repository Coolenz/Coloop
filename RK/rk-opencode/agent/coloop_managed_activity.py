"""Managed source foreground leases; never reads/writes facts or starts a model."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import secrets
import stat
import urllib.request

from memory_client import MemoryClient

ID = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")


def owner_alive(pid: int) -> bool:
    try:
        value = (Path("/proc") / str(pid) / "stat").read_text()
    except FileNotFoundError:
        return False
    return value.rsplit(")", 1)[1].split()[0] != "Z"


class LeaseLedger:
    def __init__(self, root: Path, pid: int, enrollment: str):
        self.directory = root / ".runtime/coloop-managed/activity"
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.directory.is_symlink() or stat.S_IMODE(self.directory.stat().st_mode) & 0o077:
            raise ValueError("PRIVATE_ACTIVITY_DIRECTORY_REQUIRED")
        self.path = self.directory / f"{pid}-{enrollment}.json"
        self.lock = self.path.with_suffix(".lock")
        self.prefix = f"coloop-managed-{pid}-"

    @contextmanager
    def locked(self):
        import fcntl

        descriptor = os.open(self.lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) & 0o077:
                raise ValueError("PRIVATE_ACTIVITY_LOCK_REQUIRED")
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            yield
        finally:
            os.close(descriptor)

    def read(self):
        if not self.path.exists():
            return set()
        info = self.path.lstat()
        if (
            not stat.S_ISREG(info.st_mode)
            or stat.S_IMODE(info.st_mode) & 0o077
            or info.st_size > 8192
        ):
            raise ValueError("PRIVATE_ACTIVITY_LEDGER_REQUIRED")
        values = json.loads(self.path.read_text())
        if (
            not isinstance(values, list)
            or len(values) > 64
            or any(
                not isinstance(value, str)
                or not ID.fullmatch(value)
                or not value.startswith(self.prefix)
                for value in values
            )
        ):
            raise ValueError("INVALID_ACTIVITY_LEDGER")
        return set(values)

    def update(self, session: str, active: bool):
        if not ID.fullmatch(session) or not session.startswith(self.prefix):
            raise ValueError("MANAGED_ACTIVITY_SESSION_REQUIRED")
        with self.locked():
            values = self.read()
            if active:
                values.add(session)
            else:
                values.discard(session)
            if len(values) > 64:
                raise ValueError("MANAGED_ACTIVITY_CAPACITY")
            pending = self.path.with_suffix("." + secrets.token_hex(12) + ".pending")
            try:
                descriptor = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(descriptor, "w") as output:
                    json.dump(sorted(values), output)
                os.replace(pending, self.path)
            finally:
                pending.unlink(missing_ok=True)

    def sessions(self):
        with self.locked():
            return self.read()


def activity(client, ledger, session, active):
    # Write first for active: a crash after successful HTTP still has an owner
    # record. Remove only after successful release, so failures remain retryable.
    if active:
        ledger.update(session, True)
    client.request("/activity", {"session_id": session, "active": active}, timeout=5)
    if not active:
        ledger.update(session, False)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--owner-pid", type=int, required=True)
    parser.add_argument("--enrollment-id", required=True)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--active", choices=("true", "false"))
    group.add_argument("--ready-only", action="store_true")
    group.add_argument("--release-owner", action="store_true")
    parser.add_argument("--session-id")
    args = parser.parse_args()
    if args.owner_pid < 1 or not ID.fullmatch(args.enrollment_id):
        parser.error("Invalid managed owner")
    if not args.release_owner and args.owner_pid != os.getppid():
        raise ValueError("MANAGED_ACTIVITY_OWNER_REQUIRED")
    root = args.root.resolve()

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *_args, **_kwargs):
            return None

    # Applies only to this short-lived helper, never to system proxy settings.
    urllib.request.install_opener(
        urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    )
    config = root / ".runtime/memory-config.json"
    if not config.exists() or not json.loads(config.read_text()).get("enabled"):
        print('{"enabled":false}')
        return 0
    client = MemoryClient(root)
    ledger = LeaseLedger(root, args.owner_pid, args.enrollment_id)
    if args.release_owner:
        if owner_alive(args.owner_pid):
            raise ValueError("MANAGED_ACTIVITY_OWNER_STILL_ALIVE")
        sessions = ledger.sessions()
        for session in sessions:
            activity(client, ledger, session, False)
        print(json.dumps({"enabled": True, "released": len(sessions)}))
    elif args.ready_only:
        client.request("/ready-for-foreground", {}, timeout=185)
        print('{"enabled":true,"ready":true}')
    else:
        if (
            not args.session_id
            or not ID.fullmatch(args.session_id)
            or not args.session_id.startswith(ledger.prefix)
        ):
            raise ValueError("MANAGED_ACTIVITY_SESSION_REQUIRED")
        activity(client, ledger, args.session_id, args.active == "true")
        print(json.dumps({"enabled": True, "active": args.active == "true"}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        # No response bodies, credentials or tracebacks escape the private helper.
        raise SystemExit("MANAGED_MEMORY_ACTIVITY_UNAVAILABLE") from None
