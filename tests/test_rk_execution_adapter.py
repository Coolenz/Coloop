"""RK execution boundary tests. No model, desktop, board or physical HID."""
import importlib.util
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).resolve().parents[1] / 'resources' / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


support = load('coloop_rk_support', 'rk-proactive-agent.py')
runtime = load('rk_execution_adapter', 'rk-execution-adapter.py')
memory_runtime = load('rk_memory_worker', 'rk-memory-worker.py')
IDENTITY = {'task_id': 'task1', 'generation': 1}


def command(command_id='command1', action=None):
    return {**IDENTITY, 'command_id': command_id,
            'observation': {'observation_id': 'obs1', 'window_id': '42',
                            'targets': [{'id': 1, 'rect': [0, 0, 50, 50]}]},
            'action': action or {'action': 'click', 'target_id': 1}}


class FakeHID:
    def __init__(self):
        self.calls = []

    def execute(self, action, validated, guard):
        guard(b'report')
        self.calls.append(action)


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.hid, self.events, self.rpcs = FakeHID(), [], []
        self.adapters = []
        self.adapter = self.create()
        self.assertTrue(self.adapter.dispatch('begin', IDENTITY)['ok'])

    def tearDown(self):
        for adapter in self.adapters:
            adapter.close()
        self.directory.cleanup()

    def rpc(self, op, value):
        self.rpcs.append((op, value))
        if op == 'clipboard.prepare':
            return {'lease_id': 'lease1'}
        if op == 'clipboard.verify':
            return {'verified': True}
        if op == 'clipboard.finish':
            return {'restored': True}
        return {'allowed': True, 'target': {'x': 10, 'y': 10}}

    def create(self, **options):
        adapter = runtime.ExecutionAdapter(self.directory.name, self.events.append,
            hid=options.pop('hid', self.hid), rpc=options.pop('rpc', self.rpc), **options)
        self.adapters.append(adapter)
        return adapter

    def test_same_command_deduplicates_across_reconnect_and_json_key_order(self):
        request = command()
        self.assertTrue(self.adapter.dispatch('execute', request)['ok'])
        reordered = {key: request[key] for key in reversed(request)}
        reordered['action'] = {'target_id': 1, 'action': 'click'}
        self.assertTrue(self.adapter.dispatch('execute', reordered)['deduplicated'])
        self.adapter.close()
        resumed = self.create()
        result = resumed.dispatch('execute', request)
        self.assertTrue(result['deduplicated'])
        self.assertEqual(result['receipt']['outcome'], 'input_sent')
        self.assertEqual(len(self.hid.calls), 1)

    def test_command_identity_is_immutable_even_after_stop(self):
        self.adapter.dispatch('execute', command())
        changed = command(action={'action': 'double_click', 'target_id': 1})
        self.assertEqual(self.adapter.dispatch('execute', changed)['error'], 'COMMAND_CONFLICT')
        self.adapter.dispatch('stop', IDENTITY)
        self.assertTrue(self.adapter.dispatch('execute', command())['deduplicated'])
        self.assertEqual(len(self.hid.calls), 1)

    def test_disconnected_session_does_not_block_new_task_without_unknown_input(self):
        for phase in ('active', 'stopping'):
            with self.subTest(phase=phase):
                self.adapter.current['phase'] = phase
                self.adapter.save_session()
                self.adapter.close()
                self.adapter = self.create()
                previous = self.adapter.current.copy()
                self.assertEqual(previous['phase'], 'stopped')
                with self.adapter.connect() as db:
                    saved = support.parse(db.execute('SELECT value FROM session WHERE id=1').fetchone()['value'])
                self.assertEqual(saved['phase'], 'stopped')
                following = {'task_id': 'after-' + phase, 'generation': previous['generation'] + 1}
                self.assertTrue(self.adapter.dispatch('begin', following)['ok'])
        self.assertEqual(self.hid.calls, [])

    def test_target_must_belong_to_supplied_observation_and_no_coordinates(self):
        for action in ({'action': 'click', 'target_id': 2},
                       {'action': 'click', 'target_id': 1, 'x': 10, 'y': 10},
                       {'action': 'scroll', 'target_id': 1, 'steps': 33},
                       {'action': 'type', 'target_id': 1, 'text': 'unsafe'}):
            self.assertFalse(self.adapter.dispatch('execute', command(action=action))['ok'])
        self.assertEqual(self.hid.calls, [])

    def test_host_target_rejection_is_not_sent(self):
        self.adapter.rpc_hook = lambda *_: {'allowed': False}
        result = self.adapter.dispatch('execute', command())
        self.assertEqual(result['receipt']['outcome'], 'not_sent')
        self.assertEqual(self.hid.calls, [])
        self.assertTrue(self.adapter.dispatch('stop', IDENTITY)['neutral'])

    def test_unicode_paste_uses_clipboard_with_verified_effect_and_cleanup(self):
        result = self.adapter.dispatch('execute', command(action={'action': 'paste', 'target_id': 1, 'text': '你好\nRésumé'}))
        self.assertTrue(result['ok'])
        self.assertEqual(result['receipt']['outcome'], 'effect_verified')
        self.assertEqual(self.hid.calls, [{'action': 'hotkey', 'keys': 'CTRL+V'}])
        self.assertEqual(next(value for op, value in self.rpcs if op == 'clipboard.prepare')['text'], '你好\nRésumé')
        self.assertTrue(result['receipt']['clipboard_cleanup']['restored'])

    def test_unverified_paste_is_unknown_and_never_replayed(self):
        previous = self.adapter.rpc_hook
        self.adapter.rpc_hook = lambda op, value: {'verified': False} if op == 'clipboard.verify' else previous(op, value)
        request = command(action={'action': 'paste', 'target_id': 1, 'text': 'hello'})
        result = self.adapter.dispatch('execute', request)
        self.assertEqual(result['receipt']['outcome'], 'unknown')
        self.assertTrue(result['receipt']['release_confirmed'])
        self.assertTrue(self.adapter.dispatch('execute', request)['deduplicated'])
        self.assertEqual(self.adapter.dispatch('execute', command('next'))['error'], 'INPUT_UNKNOWN')
        self.assertTrue(self.adapter.dispatch('stop', IDENTITY)['neutral'])
        self.adapter.close()
        resumed = self.create()
        self.assertEqual(resumed.dispatch('begin', {**IDENTITY, 'generation': 2})['error'], 'INPUT_UNKNOWN')
        self.assertEqual(len(self.hid.calls), 1)

    def test_stop_reader_cancels_inflight_and_delays_ack_until_cleanup(self):
        entered, release = threading.Event(), threading.Event()
        results = []

        def execute(action, validated, guard):
            guard(b'key-down')
            self.hid.calls.append(action)
            entered.set()
            release.wait(2)
            guard(b'next-key')

        self.hid.execute = execute
        runner = threading.Thread(target=lambda: results.append(self.adapter.dispatch('execute', command())))
        runner.start()
        self.assertTrue(entered.wait(1))
        self.adapter.accept({'type': 'request', 'id': 'status', 'op': 'status', 'value': {**IDENTITY, 'command_id': 'command1'}})
        self.assertEqual(self.events[-1]['value']['receipt']['outcome'], 'dispatching')
        self.adapter.accept({'type': 'request', 'id': 'stop', 'op': 'stop', 'value': IDENTITY})
        self.assertTrue(self.adapter.cancel.is_set())
        self.assertFalse(any(row.get('id') == 'stop' for row in self.events))
        release.set()
        runner.join(2)
        self.assertFalse(runner.is_alive())
        stopped = next(row['value'] for row in self.events if row.get('id') == 'stop')
        self.assertTrue(stopped['stopped'])
        self.assertFalse(stopped['neutral'])
        self.assertEqual(results[0]['receipt']['outcome'], 'unknown')
        self.assertEqual(len(self.hid.calls), 1)

    def test_heartbeat_pause_can_be_stopped_without_deadlock(self):
        self.adapter.heartbeat = -100
        results = []
        runner = threading.Thread(target=lambda: results.append(self.adapter.dispatch('execute', command())))
        runner.start()
        self.adapter.accept({'type': 'request', 'id': 'stop', 'op': 'stop', 'value': IDENTITY})
        runner.join(2)
        self.assertFalse(runner.is_alive())
        self.assertEqual(self.hid.calls, [])
        self.assertTrue(next(row['value'] for row in self.events if row.get('id') == 'stop')['stopped'])

    def test_crash_dispatch_marker_recovers_as_unknown_without_replay(self):
        self.adapter.dispatch('execute', command())
        with self.adapter.connect() as db:
            db.execute("UPDATE commands SET outcome='dispatching',receipt=? WHERE command_id='command1'",
                       (support.encode({**IDENTITY, 'command_id': 'command1', 'outcome': 'dispatching', 'release_confirmed': False}),))
            db.commit()
        self.adapter.close()
        resumed = self.create()
        status = resumed.dispatch('status', {**IDENTITY, 'command_id': 'command1'})
        self.assertEqual(status['receipt']['outcome'], 'unknown')
        self.assertEqual(resumed.current['phase'], 'stopped')
        self.assertEqual(resumed.dispatch('begin', {'task_id': 'after-restart', 'generation': 2})['error'], 'INPUT_UNKNOWN')
        self.assertEqual(resumed.dispatch('execute', command())['receipt']['outcome'], 'unknown')
        self.assertEqual(len(self.hid.calls), 1)

    def test_post_input_journal_failure_blocks_future_input_and_releases_lock(self):
        record = self.adapter.record

        def fail_terminal(receipt, digest=None):
            if receipt['outcome'] not in ('accepted', 'dispatching'):
                raise sqlite3.OperationalError('temporary disk failure')
            return record(receipt, digest)

        with patch.object(self.adapter, 'record', side_effect=fail_terminal):
            result = self.adapter.dispatch('execute', command())
        self.assertEqual(result['receipt']['outcome'], 'unknown')
        self.assertEqual(result['receipt']['journal_error'], 'JOURNAL_UNAVAILABLE')
        self.assertEqual(self.adapter.dispatch('execute', command('next'))['error'], 'INPUT_UNKNOWN')
        self.assertEqual(len(self.hid.calls), 1)
        self.assertTrue(self.adapter.execution_lock.acquire(False))
        self.adapter.execution_lock.release()

    def test_session_generation_and_cross_task_status_are_strict(self):
        self.adapter.dispatch('execute', command())
        for identity in ({'task_id': 'other', 'generation': 1}, {'task_id': 'task1', 'generation': '1'}):
            self.assertEqual(self.adapter.dispatch('stop', identity)['error'], 'SESSION_MISMATCH')
            self.assertEqual(self.adapter.dispatch('status', {**identity, 'command_id': 'command1'})['error'], 'SESSION_MISMATCH')
        self.adapter.dispatch('stop', IDENTITY)
        self.assertEqual(self.adapter.dispatch('begin', IDENTITY)['error'], 'SESSION_STOPPED')
        self.assertTrue(self.adapter.dispatch('begin', {**IDENTITY, 'generation': 2})['ok'])

    def test_one_executor_process_per_root(self):
        with self.assertRaisesRegex(runtime.ExecutionError, 'EXECUTOR_BUSY'):
            self.create()

    def test_qa_journal_is_isolated_while_executor_lock_is_global(self):
        self.adapter.close()
        qa = self.create(namespace='qa:run1')
        qa.dispatch('begin', IDENTITY)
        qa.dispatch('execute', command())
        with qa.connect() as db:
            db.execute("UPDATE commands SET outcome='unknown'")
            db.commit()
        with self.assertRaisesRegex(runtime.ExecutionError, 'EXECUTOR_BUSY'):
            self.create(namespace='production')
        qa.close()
        production = self.create(namespace='production')
        next_task = {**IDENTITY, 'generation': 2}
        self.assertTrue(production.dispatch('begin', next_task)['ok'])
        self.assertEqual(production.dispatch('status', {**next_task, 'command_id': 'command1'})['error'], 'COMMAND_NOT_FOUND')
        self.assertNotEqual(qa.database, production.database)

    def test_jsonline_rpc_wait_does_not_block_stop_or_clipboard_cleanup(self):
        self.adapter.rpc_hook = None
        results = []
        runner = threading.Thread(target=lambda: results.append(self.adapter.dispatch('execute',
            command(action={'action': 'paste', 'target_id': 1, 'text': 'hello'}))))
        runner.start()

        def request(op):
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                found = next((event for event in self.events if event.get('type') == 'request' and event.get('op') == op), None)
                if found:
                    return found
                time.sleep(.01)
            self.fail('No host RPC ' + op)

        for op in ('input.validate', 'clipboard.prepare'):
            packet = request(op)
            self.adapter.accept({'type': 'reply', 'id': packet['id'], 'value': self.rpc(op, packet['value'])})
        request('clipboard.guard')
        self.adapter.accept({'type': 'request', 'id': 'stop', 'op': 'stop', 'value': IDENTITY})
        cleanup = request('clipboard.finish')
        self.assertFalse(any(event.get('id') == 'stop' for event in self.events))
        self.adapter.accept({'type': 'reply', 'id': cleanup['id'], 'value': {'restored': True}})
        runner.join(2)
        self.assertFalse(runner.is_alive())
        self.assertEqual(self.hid.calls, [])
        stopped = next(event for event in self.events if event.get('id') == 'stop')
        self.assertTrue(stopped['value']['neutral'])
        self.assertTrue(stopped['value']['stopped'])
        self.assertNotIn('error', stopped)
        self.assertTrue(results[0]['receipt']['clipboard_cleanup']['restored'])


class FakeMemory:
    def __init__(self):
        self.calls = []

    def call(self, args):
        self.calls.append(args)
        if args['op'] == 'catalog':
            return {'memories': [{'id': 'qa-memory', 'tags': ['qa:unit']}]}
        if args['op'] == 'set':
            return {'id': 'qa-memory', 'key': args['key']}
        return {'memories': [{'id': identifier} for identifier in args['ids']]}


class MemoryWorkerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.events, self.model_calls = [], []
        self.memory = FakeMemory()
        self.worker = memory_runtime.MemoryWorker(self.directory.name, self.events.append,
            memory=self.memory, model=self.model, namespace='qa:unit')

    def tearDown(self):
        self.worker.close()
        self.directory.cleanup()

    def model(self, system, job, tokens):
        self.model_calls.append(job)
        return {'type': 'memory.set', 'kind': 'procedure', 'key': 'procedure:overwrite',
                'value': 'Use the verified editor target.', 'summary': 'Editor target', 'tags': ['app:editor']}

    def evidence(self):
        return {'task_id': 'task1', 'goal': 'Write outline', 'verified': True,
                'summary': 'Verified outline', 'verified_texts': ['你好'],
                'receipts': [{'action': 'paste', 'outcome': 'effect_verified'}]}

    def wait_saved(self):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            if any(event['type'] == 'memory.saved' and event['value']['saved'] for event in self.events):
                return
            time.sleep(.01)
        self.fail('Memory write not acknowledged')

    def test_verified_evidence_reuses_queue_and_fixed_memory_identity(self):
        self.assertIsInstance(self.worker.queue, support.MemoryReviewQueue)
        self.assertTrue(self.worker.dispatch('memory.enqueue', self.evidence())['ok'])
        self.wait_saved()
        self.assertTrue(self.worker.dispatch('memory.enqueue', self.evidence())['ok'])
        sets = [args for args in self.memory.calls if args['op'] == 'set']
        self.assertEqual(len(sets), 1)
        saved = sets[0]
        self.assertNotEqual(saved['key'], 'procedure:overwrite')
        self.assertEqual(saved['source_task_id'], 'task1')
        self.assertEqual(saved['source'], 'agent')
        self.assertFalse(saved['verified'])
        self.assertIn('qa:unit', saved['tags'])
        self.assertEqual(saved['ttl'], 300)
        self.assertEqual(self.model_calls[0]['verified_texts'], ['你好'])
        self.assertEqual(self.worker.dispatch('memory.status', {'task_id': 'task1'})['status'], 'saved')

    def test_unverified_or_unknown_evidence_cannot_be_enqueued(self):
        for altered in ({'verified': False}, {'receipts': [{'outcome': 'unknown'}]},
                        {'receipts': [{'outcome': 'dispatching'}]}, {'receipts': [{}]},
                        {'namespace': 'production'}):
            self.assertFalse(self.worker.dispatch('memory.enqueue', {**self.evidence(), **altered})['ok'])
        self.assertEqual(self.model_calls, [])
        self.assertIsNone(self.worker.queue.status('task1'))

    def test_catalog_get_scoped_to_configured_qa_namespace(self):
        self.assertTrue(self.worker.dispatch('memory.catalog', {'query': 'editor', 'tags': ['app:editor']})['ok'])
        self.assertEqual(self.memory.calls[-1]['tags'], ['qa:unit', 'app:editor'])
        self.assertTrue(self.worker.dispatch('memory.get', {'ids': ['qa-memory']})['ok'])
        self.assertEqual(self.worker.dispatch('memory.get', {'ids': ['production-memory']})['error'], 'MEMORY_SCOPE_MISMATCH')
        self.assertFalse(any(call['op'] == 'get_many' and 'production-memory' in call['ids'] for call in self.memory.calls))
        self.assertFalse(self.worker.dispatch('memory.catalog', {'namespace': 'production'})['ok'])

    def test_model_cannot_mark_memory_verified_or_override_source(self):
        self.worker.model = lambda *_: {'type': 'memory.set', 'kind': 'procedure',
            'value': 'Unsafe provenance', 'source': 'user', 'verified': True}
        self.worker.dispatch('memory.enqueue', self.evidence())
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline and self.worker.queue.status('task1')['status'] != 'retry':
            time.sleep(.01)
        self.assertEqual(self.worker.queue.status('task1')['status'], 'retry')
        self.assertFalse(any(call['op'] == 'set' for call in self.memory.calls))

    def test_no_legacy_agent_or_local_model_needed_for_executor_start(self):
        self.worker.close()
        with patch.object(support, 'Agent', side_effect=AssertionError('legacy agent forbidden')), \
             patch.object(support.Qwen, '__call__', side_effect=AssertionError('local model forbidden')):
            with tempfile.TemporaryDirectory() as directory:
                adapter = runtime.ExecutionAdapter(directory, lambda _: None, hid=FakeHID(), rpc=lambda *_: {'allowed': True})
                try:
                    self.assertTrue(adapter.dispatch('begin', IDENTITY)['ok'])
                    self.assertTrue(adapter.dispatch('execute', command())['ok'])
                finally:
                    adapter.close()


if __name__ == '__main__':
    unittest.main()
