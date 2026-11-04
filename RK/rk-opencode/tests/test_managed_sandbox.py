"""No-NPU input/fail-closed checks for the optional CPU sandbox prototype."""

import ctypes
import errno
import importlib.util
import json
import os
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1] / "agent/managed_sandbox.py"
spec = importlib.util.spec_from_file_location("managed_sandbox", MODULE)
sandbox = importlib.util.module_from_spec(spec)

sys.modules[spec.name] = sandbox
spec.loader.exec_module(sandbox)


class SandboxTests(unittest.TestCase):
    def test_exact_bytes_are_validated_without_opening_a_project(self):
        value = {"test_a.py": "# 中文\n", "sample.json": b'{"value":1}'}
        result = sandbox.checked_files(value)
        self.assertEqual(result["test_a.py"], "# 中文\n".encode())
        self.assertEqual(result["sample.json"], value["sample.json"])

    def test_paths_cannot_select_host_files_or_escape_snapshot(self):
        for name in (
            "../test_a.py",
            "/test_a.py",
            "D:/test_a.py",
            "x\\test_a.py",
            "x//test_a.py",
            "x/./test_a.py",
            ".ssh/test_a.py",
            "test_\x00.py",
        ):
            with self.subTest(name=name), self.assertRaises(ValueError):
                sandbox.checked_files({name: "pass"})

    def test_content_and_total_count_budgets_are_mandatory(self):
        for files in (
            {},
            {"other.py": "pass"},
            {"test_a.py": b"a\x00b"},
            {"test_a.py": b"\xff"},
            {"test_a.py": "x" * 262145},
            {f"test_{n}.py": "pass" for n in range(65)},
            {f"test_{n}.py": "x" * 262144 for n in range(5)},
        ):
            with self.subTest(count=len(files)), self.assertRaises((ValueError, UnicodeError)):
                sandbox.checked_files(files)

    def test_limits_cannot_be_disabled_or_coerced_from_boolean(self):
        for values in (
            {"wall_seconds": True},
            {"wall_seconds": 31},
            {"cpu_seconds": 0},
            {"memory_mb": 513},
            {"output_bytes": 65537},
        ):
            with self.subTest(values=values), self.assertRaises(ValueError):
                sandbox.Limits(**values).validate()

    def test_nonlinux_never_starts_the_supplied_test_code(self):
        with (
            patch.object(sandbox.sys, "platform", "win32"),
            patch.object(sandbox.subprocess, "Popen") as spawn,
            self.assertRaises(sandbox.SandboxUnavailable),
        ):
            sandbox.run_unittest({"test_a.py": "raise RuntimeError('must never run')"})
        spawn.assert_not_called()

    def test_recursive_readonly_failure_has_no_writable_fallback(self):
        class Lib:
            def mount(self, *args):
                return 0

            def syscall(self, *args):
                ctypes.set_errno(errno.ENOSYS)
                return -1

        with self.assertRaises(OSError) as raised:
            sandbox._bind_readonly(Lib(), "/source", "/target")
        self.assertEqual(raised.exception.errno, errno.ENOSYS)

    def test_unknown_arch_cannot_install_an_incomplete_filter(self):
        with patch.object(sandbox.platform, "machine", return_value="riscv64"):
            with self.assertRaises(sandbox.SandboxUnavailable):
                sandbox._install_seccomp(object())

    def test_internal_cli_outside_pid_namespace_never_reaches_mount_or_exec(self):
        read_fd, write_fd = os.pipe()
        try:
            with tempfile.TemporaryDirectory(prefix="coloop-cpu-sandbox-") as base:
                with (
                    patch.object(sandbox.os, "getpid", return_value=123),
                    patch.object(sandbox.os, "execve") as execute,
                    self.assertRaises(SystemExit) as raised,
                ):
                    sandbox._inner(base, str(write_fd), "{}", "unused")
                self.assertEqual(raised.exception.code, 125)
                execute.assert_not_called()
            os.close(write_fd)
            write_fd = -1
            report = json.loads(os.read(read_fd, 4096))
            self.assertFalse(report["ready"])
            self.assertEqual(report["stage"], "private_namespace")
        finally:
            os.close(read_fd)
            if write_fd != -1:
                os.close(write_fd)


if __name__ == "__main__":
    unittest.main()
