"""Service recovery gates: no SSH, real model, signal, or paid request."""
import contextlib
import importlib.util
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    'rk_model_service', Path(__file__).resolve().parents[1] / 'resources/rk-model-service.py')
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='coloop-model-recovery-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        for name in ['scripts/start.sh', 'scripts/stop-model.sh', 'build/rkllm-worker-qwen35-4b',
                     '.runtime/api-key', '.runtime/worker-protocol-qwen35-4b', 'model_profiles.py']:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('3' if 'protocol' in name else 'fixture')
        self.profile = dict(model_id='qwen35-4b-rkllm', prompt_format='embedded',
                            lock=str(self.root / 'model.lock'), fingerprint='a' * 64)
        self.health = dict(ready=False, model=self.profile['model_id'], worker_protocol=3,
                           profile='qwen35-4b', profile_fingerprint='a' * 64,
                           privacy_metadata_only=True)
        self.patches = contextlib.ExitStack()
        self.addCleanup(self.patches.close)
        original_path = sys.path[:]
        self.addCleanup(lambda: sys.path.__setitem__(slice(None), original_path))
        self.patches.enter_context(patch.dict(sys.modules, {
            'model_profiles': types.SimpleNamespace(WORKER_PROTOCOL=3,
                                                     load_profile=lambda _: self.profile)}))
        self.run = self.patches.enter_context(patch.object(runtime.subprocess, 'run'))
        self.identity = self.patches.enter_context(patch.object(
            runtime, 'bridge_identity', side_effect=[(42, 'start'), (42, 'start'), None]))
        self.get_health = self.patches.enter_context(patch.object(
            runtime, 'model_health', return_value=(503, self.health)))
        self.lock = self.patches.enter_context(patch.object(
            runtime, 'exclusive_lock', side_effect=lambda _: contextlib.nullcontext()))

    def start(self):
        runtime.start_model(str(self.root), 8088)

    def test_recovers_only_verified_dead_worker_with_normal_launcher(self):
        self.start()
        self.assertEqual([c.args[0] for c in self.run.call_args_list],
                         [['bash', 'scripts/stop-model.sh'], ['bash', 'scripts/start.sh']])
        self.assertTrue(all(c.kwargs['check'] for c in self.run.call_args_list))
        self.assertEqual(self.lock.call_count, 2)

    def test_legacy_marker_uses_actual_authenticated_protocol(self):
        (self.root / '.runtime/worker-protocol-qwen35-4b').write_text('2')
        self.start()
        self.assertEqual(self.run.call_count, 2)

    def test_healthy_wrong_profile_auth_failure_or_ambiguous_health_never_stops(self):
        cases = [(200, {**self.health, 'ready': True}), (401, {}), (500, {}),
                 (503, {**self.health, 'profile_fingerprint': 'b' * 64}),
                 (503, {**self.health, 'model': 'unrelated-model'}),
                 (503, {**self.health, 'privacy_metadata_only': False}), (503, {})]
        for health in cases:
            with self.subTest(health=health):
                self.identity.side_effect = None
                self.identity.return_value = (42, 'start')
                self.get_health.return_value = health
                with self.assertRaisesRegex(RuntimeError, 'not a verified dead worker'):
                    self.start()
                self.run.assert_not_called()

    def test_busy_model_or_parallel_recovery_never_stops(self):
        self.lock.side_effect = [contextlib.nullcontext(), RuntimeError('model busy')]
        with self.assertRaisesRegex(RuntimeError, 'busy'):
            self.start()
        self.run.assert_not_called()

    def test_recycled_pid_does_not_receive_stop(self):
        self.identity.side_effect = [(42, 'start'), (42, 'recycled')]
        with self.assertRaisesRegex(RuntimeError, 'ownership changed'):
            self.start()
        self.run.assert_not_called()

    def test_failed_stop_never_starts_replacement(self):
        self.run.side_effect = RuntimeError('stop failed')
        with self.assertRaisesRegex(RuntimeError, 'stop failed'):
            self.start()
        self.assertEqual(self.run.call_count, 1)

    def test_missing_assets_are_checked_before_stop(self):
        (self.root / 'build/rkllm-worker-qwen35-4b').unlink()
        with self.assertRaisesRegex(RuntimeError, 'installation incomplete'):
            self.start()
        self.run.assert_not_called()

    def test_occupied_unknown_listener_is_not_replaced(self):
        self.identity.side_effect = None
        self.identity.return_value = None
        with patch.object(runtime.socket, 'socket') as sock:
            sock.return_value.__enter__.return_value.connect_ex.return_value = 0
            with self.assertRaisesRegex(RuntimeError, 'port already in use'):
                self.start()
        self.run.assert_not_called()


class IdentityTests(unittest.TestCase):
    def test_requires_exact_server_argument_and_cwd_and_retains_start_time(self):
        with tempfile.TemporaryDirectory(prefix='coloop-model-identity-') as directory:
            root = Path(directory).resolve()
            (root / '.runtime').mkdir()
            (root / '.runtime/bridge.pid').write_text('42')
            proc = root / 'proc'
            process = proc / '42'
            process.mkdir(parents=True)
            (process / 'cmdline').write_bytes(b'python3\0bridge/server.py\0')
            (process / 'stat').write_text('42 (python worker) ' + ' '.join(['S'] * 19 + ['1234']))
            with patch.object(runtime.os, 'readlink', return_value=str(root)):
                self.assertEqual(runtime.bridge_identity(root, proc), (42, '1234'))
                (process / 'cmdline').write_bytes(b'python3\0other.py\0--note=bridge/server.py\0')
                with self.assertRaisesRegex(RuntimeError, 'another application'):
                    runtime.bridge_identity(root, proc)
            (process / 'cmdline').write_bytes(b'python3\0bridge/server.py\0')
            with patch.object(runtime.os, 'readlink', return_value=str(root / 'unrelated')):
                with self.assertRaisesRegex(RuntimeError, 'another application'):
                    runtime.bridge_identity(root, proc)


if __name__ == '__main__':
    unittest.main()
