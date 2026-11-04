"""No-NPU lease tests. Linux ledger cases use real flock in WSL/board Python."""

import contextlib
import importlib.util
import io
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

AGENT = Path(__file__).resolve().parents[1] / "agent"
sys.path.insert(0, str(AGENT))
SPEC = importlib.util.spec_from_file_location(
    "managed_activity", AGENT / "coloop_managed_activity.py"
)
activity = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(activity)


class Client:
    def __init__(self):
        self.calls = []
        self.failure = False

    def request(self, path, body=None, timeout=0):
        self.calls.append((path, body, timeout))
        if self.failure:
            raise ConnectionError("synthetic service unavailable")
        return {"ready": True}


class Ledger:
    def __init__(self):
        self.values = set()
        self.events = []

    def update(self, session, active):
        self.events.append((session, active))
        if active:
            self.values.add(session)
        else:
            self.values.discard(session)


class ManagedActivityTests(unittest.TestCase):
    def test_active_is_recorded_before_rpc_and_release_removed_only_after_success(self):
        client, ledger = Client(), Ledger()
        client.failure = True
        with self.assertRaises(ConnectionError):
            activity.activity(client, ledger, "own-session", True)
        self.assertEqual(ledger.values, {"own-session"})
        with self.assertRaises(ConnectionError):
            activity.activity(client, ledger, "own-session", False)
        self.assertEqual(ledger.values, {"own-session"})
        client.failure = False
        activity.activity(client, ledger, "own-session", False)
        self.assertEqual(ledger.values, set())
        self.assertTrue(all(row[0] == "/activity" for row in client.calls))

    def test_rpc_does_not_include_fact_text_or_model_operations(self):
        client, ledger = Client(), Ledger()
        activity.activity(client, ledger, "own-session", True)
        self.assertEqual(
            client.calls, [("/activity", {"session_id": "own-session", "active": True}, 5)]
        )

    @unittest.skipUnless(os.name == "posix", "real private flock ledger is Linux-only")
    def test_private_ledger_rejects_other_owner_ids_and_symlink(self):
        with tempfile.TemporaryDirectory(prefix="coloop-managed-activity-") as folder:
            root = Path(folder)
            ledger = activity.LeaseLedger(root, 123, "test-enrollment")
            session = "coloop-managed-123-own"
            ledger.update(session, True)
            self.assertEqual(ledger.sessions(), {session})
            self.assertEqual(ledger.path.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(ValueError):
                ledger.update("coloop-managed-456-other", True)
            ledger.update(session, False)
            self.assertEqual(ledger.sessions(), set())
            ledger.path.unlink()
            ledger.path.symlink_to(root / "outside")
            (root / "outside").write_text("[]")
            with self.assertRaises(ValueError):
                ledger.sessions()

    @unittest.skipUnless(os.name == "posix", "real private flock ledger is Linux-only")
    def test_release_owner_only_releases_recorded_dead_owner_sessions(self):
        with tempfile.TemporaryDirectory(prefix="coloop-managed-activity-") as folder:
            root = Path(folder)
            (root / ".runtime").mkdir()
            (root / ".runtime/memory-config.json").write_text('{"enabled":true}')
            ledger = activity.LeaseLedger(root, 123, "test-enrollment")
            sessions = {"coloop-managed-123-a", "coloop-managed-123-b"}
            for session in sessions:
                ledger.update(session, True)
            client = Client()
            args = [
                "helper",
                "--root",
                str(root),
                "--owner-pid",
                "123",
                "--enrollment-id",
                "test-enrollment",
                "--release-owner",
            ]
            with (
                patch.object(sys, "argv", args),
                patch.object(activity, "MemoryClient", return_value=client),
                patch.object(activity, "owner_alive", return_value=True),
                contextlib.redirect_stdout(io.StringIO()),
            ):
                with self.assertRaisesRegex(ValueError, "STILL_ALIVE"):
                    activity.main()
            self.assertEqual(client.calls, [])
            with (
                patch.object(sys, "argv", args),
                patch.object(activity, "MemoryClient", return_value=client),
                patch.object(activity, "owner_alive", return_value=False),
                contextlib.redirect_stdout(io.StringIO()),
            ):
                self.assertEqual(activity.main(), 0)
            self.assertEqual({call[1]["session_id"] for call in client.calls}, sessions)
            self.assertTrue(
                all(call[0] == "/activity" and call[1]["active"] is False for call in client.calls)
            )
            self.assertEqual(ledger.sessions(), set())

    @unittest.skipUnless(os.name == "posix", "real private flock ledger is Linux-only")
    def test_ready_only_drains_without_activity_or_memory_write(self):
        with tempfile.TemporaryDirectory(prefix="coloop-managed-activity-") as folder:
            root = Path(folder)
            (root / ".runtime").mkdir()
            (root / ".runtime/memory-config.json").write_text('{"enabled":true}')
            client = Client()
            args = [
                "helper",
                "--root",
                str(root),
                "--owner-pid",
                str(os.getppid()),
                "--enrollment-id",
                "test-enrollment",
                "--ready-only",
            ]
            with (
                patch.object(sys, "argv", args),
                patch.object(activity, "MemoryClient", return_value=client),
                contextlib.redirect_stdout(io.StringIO()),
            ):
                self.assertEqual(activity.main(), 0)
            self.assertEqual(client.calls, [("/ready-for-foreground", {}, 185)])


if __name__ == "__main__":
    unittest.main()
