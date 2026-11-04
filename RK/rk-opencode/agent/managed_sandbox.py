"""Optional Linux CPU-only prototype for tests in a private, read-only snapshot.

This module is not wired into Agent approvals. It deliberately supports only the
system Python unittest runner and standard library. No real project path is bound
read/write; callers pass the exact synthetic/approved file bytes. A successful
bootstrap is mandatory: missing namespaces, recursive read-only mounts, capability
dropping, no_new_privs, or seccomp means no test code executes.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import selectors
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from typing import Mapping


class SandboxUnavailable(RuntimeError):
    pass


@dataclass(frozen=True)
class Limits:
    wall_seconds: int = 10
    cpu_seconds: int = 2
    memory_mb: int = 256
    output_bytes: int = 65536

    def validate(self):
        bounds = (
            (self.wall_seconds, 1, 30),
            (self.cpu_seconds, 1, 5),
            (self.memory_mb, 64, 512),
            (self.output_bytes, 1024, 65536),
        )
        if any(type(value) is not int or not low <= value <= high for value, low, high in bounds):
            raise ValueError("INVALID_SANDBOX_LIMITS")


def checked_files(files: Mapping[str, str | bytes]) -> dict[str, bytes]:
    if not isinstance(files, dict) or not 1 <= len(files) <= 64:
        raise ValueError("INVALID_SANDBOX_FILES")
    result: dict[str, bytes] = {}
    total = 0
    for name, content in files.items():
        if (
            not isinstance(name, str)
            or not name
            or len(name) > 256
            or "\\" in name
            or any(ord(character) < 32 for character in name)
        ):
            raise ValueError("INVALID_SANDBOX_PATH")
        path = PurePosixPath(name)
        if (
            path.is_absolute()
            or str(path) != name
            or any(
                part in (".", "..") or part.startswith(".") or ":" in part for part in path.parts
            )
            or path.suffix not in (".py", ".json", ".txt")
        ):
            raise ValueError("INVALID_SANDBOX_PATH")
        if not isinstance(content, (str, bytes)):
            raise ValueError("INVALID_SANDBOX_CONTENT")
        data = content.encode("utf-8") if isinstance(content, str) else content
        total += len(data)
        if b"\x00" in data or len(data) > 262144 or total > 1048576:
            raise ValueError("SANDBOX_INPUT_LIMIT")
        data.decode("utf-8", errors="strict")
        result[name] = data
    if not any(
        PurePosixPath(name).name.startswith("test_") and name.endswith(".py") for name in result
    ):
        raise ValueError("SANDBOX_TEST_REQUIRED")
    return result


def _trusted_binary(path: str) -> str:
    resolved = str(Path(path).resolve(strict=True))
    info = os.stat(resolved)
    if info.st_uid != 0 or info.st_mode & 0o022 or not os.path.isfile(resolved):
        raise SandboxUnavailable("UNTRUSTED_SANDBOX_BINARY")
    return resolved


def _kill_owned(process):
    try:
        if os.getpgid(process.pid) != process.pid:
            raise SandboxUnavailable("SANDBOX_PROCESS_GROUP_CHANGED")
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def run_unittest(files: Mapping[str, str | bytes], limits: Limits | None = None) -> dict:
    """Run exact supplied bytes with fixed argv; return bounded evidence, never execute shell."""
    limits = limits or Limits()
    limits.validate()
    content = checked_files(files)
    if sys.platform != "linux" or os.geteuid() == 0:
        raise SandboxUnavailable("UNPRIVILEGED_LINUX_REQUIRED")
    unshare = shutil.which("unshare")
    if not unshare:
        raise SandboxUnavailable("UNSHARE_REQUIRED")
    unshare = _trusted_binary(unshare)
    interpreter = _trusted_binary("/usr/bin/python3")
    interpreter_hash = hashlib.sha256(Path(interpreter).read_bytes()).hexdigest()
    module = str(Path(__file__).resolve(strict=True))
    manifest = [
        {"path": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        for name, data in sorted(content.items())
    ]
    snapshot_hash = hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest()
    started = time.monotonic()
    streams = {"stdout": bytearray(), "stderr": bytearray(), "status": bytearray()}
    reason = "PROCESS_EXIT"
    with tempfile.TemporaryDirectory(prefix="coloop-cpu-sandbox-") as temporary:
        base = Path(temporary)
        os.chmod(base, 0o700)
        source, root = base / "source", base / "root"
        source.mkdir(mode=0o700)
        root.mkdir(mode=0o700)
        for name, data in content.items():
            target = source / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            target.chmod(0o444)
        status_read, status_write = os.pipe()
        command = [
            unshare,
            "--user",
            "--map-root-user",
            "--mount",
            "--net",
            "--pid",
            "--fork",
            "--kill-child=KILL",
            "--propagation",
            "private",
            "--",
            interpreter,
            "-I",
            "-S",
            module,
            "--internal-child",
            str(base),
            str(status_write),
            json.dumps(asdict(limits)),
            os.readlink("/proc/self/ns/net"),
            interpreter_hash,
        ]
        process = None
        selector = selectors.DefaultSelector()
        try:
            process = subprocess.Popen(
                command,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd="/",
                env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"},
                start_new_session=True,
                close_fds=True,
                pass_fds=(status_write,),
            )
            os.close(status_write)
            status_write = -1
            for handle, name in (
                (process.stdout, "stdout"),
                (process.stderr, "stderr"),
                (status_read, "status"),
            ):
                fd = handle if isinstance(handle, int) else handle.fileno()
                os.set_blocking(fd, False)
                selector.register(handle, selectors.EVENT_READ, name)
            while selector.get_map():
                if time.monotonic() - started > limits.wall_seconds:
                    reason = "WALL_LIMIT"
                    _kill_owned(process)
                for key, _ in selector.select(0.05):
                    fd = key.fileobj if isinstance(key.fileobj, int) else key.fileobj.fileno()
                    try:
                        data = os.read(fd, 16384)
                    except BlockingIOError:
                        continue
                    if not data:
                        selector.unregister(key.fileobj)
                        continue
                    label = key.data
                    if label == "status":
                        if len(streams[label]) + len(data) > 4096:
                            reason = "BOOTSTRAP_STATUS_LIMIT"
                            _kill_owned(process)
                        else:
                            streams[label].extend(data)
                    else:
                        remaining = (
                            limits.output_bytes - len(streams["stdout"]) - len(streams["stderr"])
                        )
                        streams[label].extend(data[: max(0, remaining)])
                        if len(data) > remaining:
                            reason = "OUTPUT_LIMIT"
                            _kill_owned(process)
                if reason != "PROCESS_EXIT" and process.poll() is None:
                    _kill_owned(process)
            returncode = process.wait(timeout=2)
        finally:
            if status_write != -1:
                os.close(status_write)
            if process is not None:
                if process.poll() is None:
                    _kill_owned(process)
                    process.wait(timeout=2)
                if process.stdout:
                    process.stdout.close()
                if process.stderr:
                    process.stderr.close()
            os.close(status_read)
            selector.close()
    try:
        bootstrap = json.loads(streams["status"])
    except (ValueError, UnicodeError):
        bootstrap = {"ready": False, "error": "BOOTSTRAP_NOT_CONFIRMED"}
    return {
        "prototype_only": True,
        "npu_used": False,
        "runner": "system-python-unittest-no-shell",
        "snapshot_sha256": snapshot_hash,
        "system_python_sha256": interpreter_hash,
        "input_manifest": manifest,
        "limits": asdict(limits),
        "bootstrap": bootstrap,
        "passed": bootstrap.get("ready") is True and returncode == 0 and reason == "PROCESS_EXIT",
        "returncode": returncode,
        "termination_reason": reason,
        "elapsed_seconds": round(time.monotonic() - started, 4),
        "stdout": streams["stdout"].decode("utf-8", errors="replace"),
        "stderr": streams["stderr"].decode("utf-8", errors="replace"),
        "captured_bytes": len(streams["stdout"]) + len(streams["stderr"]),
        "process_exited": True,
        "temporary_directory_removed": not base.exists(),
        "network_allowed": False,
        "host_home_bound": False,
        "host_project_bound_rw": False,
        "outputs_exported": False,
    }


class _MountAttr(ctypes.Structure):
    _fields_ = [
        (name, ctypes.c_uint64) for name in ("attr_set", "attr_clr", "propagation", "userns_fd")
    ]


class _CapHeader(ctypes.Structure):
    _fields_ = [("version", ctypes.c_uint32), ("pid", ctypes.c_int)]


class _CapData(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint32) for name in ("effective", "permitted", "inheritable")]


class _SockFilter(ctypes.Structure):
    _fields_ = [
        ("code", ctypes.c_ushort),
        ("jt", ctypes.c_ubyte),
        ("jf", ctypes.c_ubyte),
        ("k", ctypes.c_uint32),
    ]


class _SockFprog(ctypes.Structure):
    _fields_ = [("len", ctypes.c_ushort), ("filter", ctypes.POINTER(_SockFilter))]


def _call(lib, name, *args):
    if getattr(lib, name)(*args) == -1:
        raise OSError(ctypes.get_errno(), name)


def _mount(lib, source, target, kind=None, flags=0, data=None):
    def encoded(value):
        return None if value is None else str(value).encode()

    _call(
        lib,
        "mount",
        encoded(source),
        encoded(target),
        encoded(kind),
        ctypes.c_ulong(flags),
        encoded(data),
    )


def _bind_readonly(lib, source, target, noexec=False):
    _mount(lib, source, target, flags=4096 | 16384)  # MS_BIND | MS_REC
    attr = _MountAttr(1 | 2 | 4 | (8 if noexec else 0), 0, 0, 0)
    # Linux >=5.12: recursive mount attributes, no writable submount escape.
    _call(
        lib,
        "syscall",
        442,
        -100,
        str(target).encode(),
        0x8000,
        ctypes.byref(attr),
        ctypes.sizeof(attr),
    )


def _drop_capabilities(lib):
    last = int(Path("/proc/sys/kernel/cap_last_cap").read_text())
    if not 0 <= last <= 63:
        raise SandboxUnavailable("CAPABILITY_RANGE_UNSUPPORTED")
    _call(lib, "prctl", 47, 4, 0, 0, 0)  # clear all ambient capabilities
    for cap in range(last + 1):
        _call(lib, "prctl", 24, cap, 0, 0, 0)  # bounding set
    header, data = _CapHeader(0x20080522, 0), (_CapData * 2)()
    _call(lib, "capset", ctypes.byref(header), ctypes.byref(data))
    _call(lib, "capget", ctypes.byref(header), ctypes.byref(data))
    if any(value.effective or value.permitted or value.inheritable for value in data):
        raise SandboxUnavailable("CAPABILITIES_REMAIN")
    if any(lib.prctl(23, cap, 0, 0, 0) != 0 for cap in range(last + 1)):
        raise SandboxUnavailable("CAPABILITY_BOUNDING_SET_REMAINS")
    _call(lib, "prctl", 38, 1, 0, 0, 0)  # no_new_privs
    if lib.prctl(39, 0, 0, 0, 0) != 1:
        raise SandboxUnavailable("NO_NEW_PRIVS_REQUIRED")
    _call(lib, "prctl", 4, 0, 0, 0, 0)  # nondumpable


def _install_seccomp(lib):
    machine = platform.machine().lower()
    if machine in ("aarch64", "arm64"):
        audit = 0xC00000B7
        # Numbers checked against this board's /usr/include/asm-generic/unistd.h.
        denied = [
            33,
            39,
            40,
            41,
            51,
            97,
            104,
            105,
            106,
            116,
            117,
            142,
            154,
            157,
            198,
            199,
            200,
            201,
            202,
            203,
            217,
            218,
            219,
            220,
            224,
            225,
            241,
            242,
            264,
            265,
            268,
            270,
            271,
            273,
            280,
            282,
            294,
            424,
            425,
            426,
            427,
            428,
            429,
            430,
            431,
            432,
            433,
            434,
            435,
            438,
            440,
            442,
        ]
    else:
        raise SandboxUnavailable("SECCOMP_ARCH_UNSUPPORTED")
    instructions = [
        _SockFilter(0x20, 0, 0, 4),
        _SockFilter(0x15, 1, 0, audit),
        _SockFilter(0x06, 0, 0, 0x80000000),
        _SockFilter(0x20, 0, 0, 0),
    ]
    for number in sorted(set(denied)):
        instructions.extend(
            [_SockFilter(0x15, 0, 1, number), _SockFilter(0x06, 0, 0, 0x00050000 | errno.EPERM)]
        )
    instructions.append(_SockFilter(0x06, 0, 0, 0x7FFF0000))
    buffer = (_SockFilter * len(instructions))(*instructions)
    program = _SockFprog(len(instructions), buffer)
    _call(lib, "prctl", 22, 2, ctypes.byref(program), 0, 0)
    if lib.prctl(21, 0, 0, 0, 0) != 2:
        raise SandboxUnavailable("SECCOMP_FILTER_REQUIRED")


def _inner(base_text, status_text, limits_text, original_net, interpreter_hash=None):
    fd = int(status_text)
    ready = False
    stage = "private_namespace"
    try:
        base = Path(base_text).resolve(strict=True)
        if (
            not base.name.startswith("coloop-cpu-sandbox-")
            or base.is_symlink()
            or os.getpid() != 1
            or os.geteuid() != 0
        ):
            raise SandboxUnavailable("INVALID_PRIVATE_NAMESPACE")
        limits = Limits(**json.loads(limits_text))
        limits.validate()
        import resource

        lib = ctypes.CDLL(None, use_errno=True)
        root, source = base / "root", base / "source"
        stage = "private_root"
        _mount(lib, None, "/", flags=16384 | (1 << 18))  # private propagation
        _mount(lib, "tmpfs", root, "tmpfs", 2 | 4, "size=16m,nr_inodes=512,mode=0755")
        for name in (
            "usr",
            "lib64",
            "workspace",
            "tmp",
            "output",
            "proc",
            "dev",
            "home",
            "root",
            "nonexistent",
            "etc",
        ):
            (root / name).mkdir()
        stage = "readonly_os"
        if platform.machine().lower() not in ("aarch64", "arm64"):
            raise SandboxUnavailable("SANDBOX_ARCH_UNSUPPORTED")
        (root / "usr/bin").mkdir()
        (root / "usr/lib").mkdir()
        (root / "lib").symlink_to("usr/lib")
        # Parent verified root ownership before user-namespace UID remapping.
        python_source = Path("/usr/bin/python3").resolve(strict=True)
        if python_source.stat().st_size > 12 * 1048576:
            raise SandboxUnavailable("SYSTEM_PYTHON_SIZE_LIMIT")
        python_target = root / "usr/bin/python3"
        binary = python_source.read_bytes()
        if hashlib.sha256(binary).hexdigest() != interpreter_hash:
            raise SandboxUnavailable("SYSTEM_PYTHON_CHANGED")
        python_target.write_bytes(binary)
        python_target.chmod(0o555)
        stdlib = Path(f"/usr/lib/python{sys.version_info.major}.{sys.version_info.minor}")
        libraries = Path("/lib/aarch64-linux-gnu").resolve(strict=True)
        for source_path, target in (
            (stdlib, root / "usr/lib" / stdlib.name),
            (libraries, root / "usr/lib/aarch64-linux-gnu"),
        ):
            if source_path.is_symlink() or not source_path.is_dir():
                raise SandboxUnavailable("SYSTEM_LIBRARY_LAYOUT_UNSUPPORTED")
            target.mkdir()
            _bind_readonly(lib, source_path, target)
        (root / "usr/lib/ld-linux-aarch64.so.1").symlink_to(
            "aarch64-linux-gnu/ld-linux-aarch64.so.1"
        )
        (root / "bin").symlink_to("usr/bin")
        (root / "etc/passwd").write_text("root:x:0:0:sandbox:/nonexistent:/usr/sbin/nologin\n")
        (root / "etc/group").write_text("root:x:0:\n")
        stage = "readonly_snapshot"
        _bind_readonly(lib, source, root / "workspace", noexec=True)
        stage = "private_outputs"
        _mount(lib, "tmpfs", root / "tmp", "tmpfs", 2 | 4 | 8, "size=8m,nr_inodes=128,mode=1777")
        _mount(lib, "tmpfs", root / "output", "tmpfs", 2 | 4 | 8, "size=8m,nr_inodes=128,mode=0700")
        _mount(lib, "proc", root / "proc", "proc", 1 | 2 | 4 | 8)
        _mount(lib, None, root, flags=32 | 1 | 2 | 4)  # remount private root read-only
        stage = "chroot"
        os.chroot(root)
        os.chdir("/workspace")
        for candidate in os.listdir("/proc/self/fd"):
            number = int(candidate)
            if number > 2 and number != fd:
                try:
                    os.close(number)
                except OSError:
                    pass
        changed_net = os.readlink("/proc/self/ns/net") != original_net
        if not changed_net or Path("/home/cat").exists():
            raise SandboxUnavailable("HOST_NAMESPACE_VISIBLE")
        stage = "capabilities"
        _drop_capabilities(lib)
        stage = "limits"
        resource.setrlimit(resource.RLIMIT_CPU, (limits.cpu_seconds, limits.cpu_seconds + 1))
        resource.setrlimit(resource.RLIMIT_AS, (limits.memory_mb * 1048576,) * 2)
        resource.setrlimit(resource.RLIMIT_FSIZE, (1048576, 1048576))
        resource.setrlimit(resource.RLIMIT_NPROC, (0, 0))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))
        stage = "seccomp"
        _install_seccomp(lib)
        status = {
            "ready": True,
            "pid_namespace_pid": os.getpid(),
            "network_namespace_changed": changed_net,
            "recursive_readonly": True,
            "capabilities_zero": True,
            "no_new_privs": True,
            "seccomp": True,
            "host_home_bound": False,
            "host_project_bound_rw": False,
            "temporary_outputs_only": True,
        }
        os.write(fd, json.dumps(status).encode())
        os.close(fd)
        ready = True
        stage = "exec"
        os.execve(
            "/usr/bin/python3",
            [
                "python3",
                "-I",
                "-S",
                "-X",
                "utf8",
                "-m",
                "unittest",
                "discover",
                "-s",
                "/workspace",
                "-p",
                "test_*.py",
                "-v",
            ],
            {
                "PATH": "/usr/bin:/bin",
                "HOME": "/nonexistent",
                "TMPDIR": "/tmp",
                "LANG": "C.UTF-8",
                "LC_ALL": "C.UTF-8",
            },
        )
    except BaseException as error:
        if not ready:
            try:
                os.write(
                    fd,
                    json.dumps(
                        {
                            "ready": False,
                            "error": type(error).__name__,
                            "reason": str(error) if isinstance(error, SandboxUnavailable) else None,
                            "stage": stage,
                            "errno": getattr(error, "errno", None),
                        }
                    ).encode(),
                )
            except OSError:
                pass
        raise SystemExit(125) from None


if __name__ == "__main__":
    if len(sys.argv) == 7 and sys.argv[1] == "--internal-child":
        _inner(*sys.argv[2:])
    else:
        raise SystemExit("This prototype exposes run_unittest(files); no arbitrary command CLI.")
