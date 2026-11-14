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
            result = self.adapter.dispatch('execute', command(action=action))
            self.assertFalse(result['ok'])
            self.assertEqual(result['receipt']['outcome'], 'not_sent')
            self.assertTrue(result['receipt']['rejected_before_input'])
        self.assertEqual(self.hid.calls, [])
        self.assertTrue(self.adapter.dispatch('execute', command('corrected'))['ok'])

    def test_host_target_rejection_is_not_sent(self):
        self.adapter.rpc_hook = lambda *_: {'allowed': False}
        result = self.adapter.dispatch('execute', command())
        self.assertEqual(result['receipt']['outcome'], 'not_sent')
        self.assertTrue(result['receipt']['release_confirmed'])
        self.assertEqual(self.hid.calls, [])
        self.assertTrue(self.adapter.dispatch('stop', IDENTITY)['neutral'])

    def test_host_rpc_binding_diagnostics_persist_without_private_content_or_changed_input_outcome(self):
        self.adapter.rpc_hook = None
        for index, (failed_op, stage) in enumerate((
                ('input.validate', 'input.validate'), ('input.guard', 'input.guard'),
                ('clipboard.prepare', 'input.guard'), ('clipboard.verify', 'clipboard.verify'))):
            with self.subTest(op=failed_op):
                diagnostics = {'category': 'editor_binding', 'stage': stage,
                    'checks': {'window': True, 'focused': False, 'editorRect': True,
                               'targetRuntime': 1, 'textReadable': 'private draft',
                               'privateText': True}, 'text': 'private draft',
                    'raw': {'tree': 'private controls'}}

                def reply(packet):
                    self.events.append(packet)
                    if packet.get('type') != 'request':
                        return
                    response = {'type': 'reply', 'id': packet['id']}
                    if packet['op'] == failed_op:
                        response.update(error='EDITOR_BINDING_CHANGED', diagnostics=diagnostics)
                    else:
                        response['value'] = self.rpc(packet['op'], packet['value'])
                    self.adapter.accept(support.parse(support.encode(response)))

                self.adapter.emit = reply
                before = len(self.hid.calls)
                action = {'action': 'paste', 'target_id': 1, 'text': 'hello'} if failed_op.startswith('clipboard.') else None
                request = command('diagnostics-' + str(index), action)
                result = self.adapter.dispatch('execute', request)
                expected = {'category': 'editor_binding', 'stage': stage,
                            'checks': {'window': True, 'focused': False, 'editorRect': True}}
                self.assertEqual(result['error'], 'EDITOR_BINDING_CHANGED')
                self.assertEqual(result['receipt']['diagnostics'], expected)
                self.assertEqual(result['receipt']['outcome'], 'unknown' if failed_op == 'clipboard.verify' else 'not_sent')
                self.assertTrue(result['receipt']['release_confirmed'])
                self.assertEqual(len(self.hid.calls) - before, 1 if failed_op == 'clipboard.verify' else 0)
                saved = self.adapter.dispatch('status', {**IDENTITY, 'command_id': request['command_id']})['receipt']
                self.assertEqual(saved['diagnostics'], expected)
                self.assertNotIn('private', support.encode(saved))
                self.assertEqual(self.adapter.pending, {})

    def test_host_rpc_drops_diagnostics_with_wrong_error_category_stage_or_check_types(self):
        self.adapter.rpc_hook = None
        valid = {'category': 'editor_binding', 'stage': 'input.validate', 'checks': {'window': True}}
        for index, (code, diagnostics) in enumerate((
                ('INPUT_TARGET_CHANGED', valid),
                ('EDITOR_BINDING_CHANGED', {**valid, 'category': 'private'}),
                ('EDITOR_BINDING_CHANGED', {**valid, 'stage': 'clipboard.prepare'}),
                ('EDITOR_BINDING_CHANGED', {**valid, 'checks': {'window': 1, 'focused': 'private'}}))):
            def reply(packet):
                self.adapter.accept({'type': 'reply', 'id': packet['id'], 'error': code,
                                     'diagnostics': diagnostics})

            self.adapter.emit = reply
            request = command('invalid-diagnostics-' + str(index))
            result = self.adapter.dispatch('execute', request)
            self.assertEqual(result['error'], code)
            self.assertEqual(result['receipt']['outcome'], 'not_sent')
            self.assertTrue(result['receipt']['release_confirmed'])
            self.assertNotIn('diagnostics', result['receipt'])
            saved = self.adapter.dispatch('status', {**IDENTITY, 'command_id': request['command_id']})['receipt']
            self.assertNotIn('diagnostics', saved)
        self.assertEqual(self.hid.calls, [])

    def test_host_rpc_input_target_checks_survive_focus_failure_and_status_without_private_fields(self):
        self.adapter.rpc_hook = None
        for index, stage in enumerate(('input.validate', 'input.guard')):
            with self.subTest(stage=stage):
                safe = {'category': 'input_target', 'stage': stage, 'checks': {
                    'same': True, 'inside': True, 'observedPointMatches': False, 'identityMatches': True}}

                def reply(packet):
                    response = {'type': 'reply', 'id': packet['id']}
                    if packet['op'] == stage:
                        response.update(error='INPUT_TARGET_CHANGED', diagnostics={
                            **safe, 'text': 'private draft', 'checks': {**safe['checks'],
                            'elementValid': 'private element', 'targetRuntime': False, 'title': 'private title'}})
                    else:
                        response['value'] = self.rpc(packet['op'], packet['value'])
                    self.adapter.accept(support.parse(support.encode(response)))

                self.adapter.emit = reply
                request = command('focus-diagnostics-' + str(index))
                result = self.adapter.dispatch('execute', request)
                self.assertEqual(result['error'], 'INPUT_TARGET_CHANGED')
                self.assertEqual(result['receipt']['diagnostics'], safe)
                self.assertEqual(result['receipt']['outcome'], 'not_sent')
                self.assertTrue(result['receipt']['release_confirmed'])
                saved = self.adapter.dispatch('status', {**IDENTITY, 'command_id': request['command_id']})['receipt']
                self.assertEqual(saved['diagnostics'], safe)
                self.assertNotIn('private', support.encode(saved))
        self.assertEqual(self.hid.calls, [])

    def test_invalid_reuse_cannot_replace_a_known_command_with_not_sent(self):
        original = self.adapter.dispatch('execute', command())['receipt']
        malformed = command(action={'action': 'click', 'target_id': 999})
        result = self.adapter.dispatch('execute', malformed)
        self.assertFalse(result['ok'])
        self.assertEqual(result['error'], 'COMMAND_CONFLICT')
        self.assertNotIn('receipt', result)
        status = self.adapter.dispatch('status', {**IDENTITY, 'command_id': 'command1'})
        self.assertEqual(status['receipt'], original)
        self.assertEqual(len(self.hid.calls), 1)

    def test_malformed_action_and_target_containers_are_rejected_before_input(self):
        for replacement in (
                {'action': None},
                {'action': {'action': [], 'target_id': 1}},
                {'observation': {'observation_id': 'bad', 'window_id': '42', 'targets': None}},
                {'observation': {'observation_id': 'bad', 'window_id': '42', 'ocr_items': {}}},
                {'observation': {'observation_id': 'bad', 'window_id': '42', 'targets': [{'id': []}]}}):
            with self.subTest(replacement=replacement):
                result = self.adapter.dispatch('execute', {**command(), **replacement})
                self.assertFalse(result['ok'])
                self.assertEqual(result['receipt']['outcome'], 'not_sent')
                self.assertTrue(result['receipt']['release_confirmed'])
        self.assertEqual(self.hid.calls, [])

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
        following = command('next')
        following['observation']['observation_id'] = 'obs-after-unknown'
        self.assertTrue(self.adapter.dispatch('execute', following)['ok'])
        self.assertTrue(self.adapter.dispatch('stop', IDENTITY)['neutral'])
        self.adapter.close()
        resumed = self.create()
        new_task = {'task_id': 'another-task', 'generation': 2}
        self.assertTrue(resumed.dispatch('begin', new_task)['ok'])
        self.assertEqual(resumed.dispatch('execute', request)['receipt']['outcome'], 'unknown')
        next_request = {**command('another-command'), **new_task}
        self.assertTrue(resumed.dispatch('execute', next_request)['ok'])
        self.assertEqual(len(self.hid.calls), 3)

    def test_failed_paste_verification_persists_only_bounded_diagnostic_fields(self):
        previous = self.adapter.rpc_hook
        diagnostics = {'verified': False, 'source': 'uia', 'checks': {'focused': True, 'text': False},
                       'attempts': 3, 'elapsed_ms': 412.5, 'failure': 'text_not_settled'}
        self.adapter.rpc_hook = lambda op, value: {**diagnostics, 'text': 'private draft',
            'raw': {'tree': 'private controls'}} if op == 'clipboard.verify' else previous(op, value)
        result = self.adapter.dispatch('execute', command(action={'action': 'paste', 'target_id': 1, 'text': 'hello'}))
        self.assertEqual(result['error'], 'INPUT_EFFECT_UNKNOWN')
        self.assertEqual(result['receipt']['verification'], diagnostics)
        saved = self.adapter.dispatch('status', {**IDENTITY, 'command_id': 'command1'})['receipt']
        self.assertEqual(saved['verification'], diagnostics)
        self.assertNotIn('private', support.encode(saved))
        self.assertTrue(saved['release_confirmed'])

    def test_paste_scope_diagnostics_allow_missing_attempts_and_exclude_non_boolean_checks(self):
        previous = self.adapter.rpc_hook
        self.adapter.rpc_hook = lambda op, value: {'verified': False, 'source': 'uia',
            'checks': {'window': False, 'rawText': 'private'}, 'failure': 'paste_scope_changed',
            'attempts': True, 'elapsed_ms': float('inf')} if op == 'clipboard.verify' else previous(op, value)
        result = self.adapter.dispatch('execute', command(action={'action': 'paste', 'target_id': 1, 'text': 'hello'}))
        self.assertEqual(result['receipt']['verification'], {'verified': False, 'source': 'uia',
            'checks': {'window': False}, 'failure': 'paste_scope_changed'})

    def test_released_unknown_does_not_bypass_an_active_task_or_change_its_receipt(self):
        previous = self.adapter.rpc_hook
        self.adapter.rpc_hook = lambda op, value: {'verified': False} if op == 'clipboard.verify' else previous(op, value)
        request = command(action={'action': 'paste', 'target_id': 1, 'text': 'hello'})
        receipt = self.adapter.dispatch('execute', request)['receipt']
        other = {'task_id': 'another-task', 'generation': 2}
        self.assertEqual(self.adapter.dispatch('begin', other)['error'], 'EXECUTOR_BUSY')
        self.assertTrue(self.adapter.dispatch('stop', IDENTITY)['neutral'])
        self.assertTrue(self.adapter.dispatch('begin', other)['ok'])
        self.assertEqual(self.adapter.dispatch('status', {**IDENTITY, 'command_id': 'command1'})['receipt'], receipt)
        self.assertEqual(len(self.hid.calls), 1)

    def stopped_draft(self):
        previous = self.adapter.rpc_hook
        self.adapter.rpc_hook = lambda op, value: {'verified': False} if op == 'clipboard.verify' else previous(op, value)
        pasted = command('draft:paste', {'action': 'paste', 'target_id': 1, 'text': 'already pasted'})
        receipt = self.adapter.dispatch('execute', pasted)['receipt']
        self.assertEqual(receipt['outcome'], 'unknown')
        self.assertTrue(receipt['release_confirmed'])
        self.assertTrue(self.adapter.dispatch('stop', IDENTITY)['neutral'])
        return {**IDENTITY, 'command_id': 'draft:send', 'paste_command_id': 'draft:paste'}

    def test_resume_draft_only_allows_one_enter_and_never_replays_paste(self):
        request = self.stopped_draft()
        before_rpcs = len(self.rpcs)
        result = self.adapter.dispatch('resume_draft', request)
        self.assertTrue(result['ok'])
        self.assertEqual(result['restricted_command_id'], 'draft:send')
        self.assertEqual(result['restricted_action'], {'action': 'hotkey', 'keys': 'ENTER'})
        self.assertEqual(len(self.rpcs), before_rpcs)
        self.assertEqual(len(self.hid.calls), 1)
        with self.adapter.connect() as db:
            saved = support.parse(db.execute('SELECT value FROM session WHERE id=1').fetchone()['value'])
        self.assertEqual(saved['restricted_command_id'], 'draft:send')
        self.assertEqual(self.adapter.dispatch('begin', IDENTITY)['error'], 'RESUME_COMMAND_RESTRICTED')
        for blocked in (
                command('other', {'action': 'hotkey', 'target_id': 1, 'keys': 'ENTER'}),
                command('draft:send', {'action': 'hotkey', 'target_id': 1, 'keys': 'CTRL+ENTER'}),
                command('draft:send'),
                command('draft:paste', {'action': 'paste', 'target_id': 1, 'text': 'already pasted'})):
            self.assertEqual(self.adapter.dispatch('execute', blocked)['error'], 'RESUME_COMMAND_RESTRICTED')
        sent = command('draft:send', {'action': 'hotkey', 'target_id': 1, 'keys': 'ENTER'})
        original_execute = self.hid.execute

        def assert_durable_before_input(action, validated, guard):
            status = self.adapter.dispatch('status', {**IDENTITY, 'command_id': 'draft:send'})
            self.assertEqual(status['receipt']['outcome'], 'dispatching')
            original_execute(action, validated, guard)

        self.hid.execute = assert_durable_before_input
        self.assertTrue(self.adapter.dispatch('execute', sent)['ok'])
        self.assertTrue(self.adapter.dispatch('execute', sent)['deduplicated'])
        self.assertEqual(self.hid.calls, [{'action': 'hotkey', 'keys': 'CTRL+V'},
                                         {'action': 'hotkey', 'keys': 'ENTER'}])
        self.adapter.dispatch('stop', IDENTITY)
        self.assertEqual(self.adapter.dispatch('resume_draft', request)['error'], 'SEND_ALREADY_RECORDED')
        self.assertEqual(self.adapter.dispatch('begin', IDENTITY)['error'], 'SESSION_STOPPED')

    def test_resume_draft_requires_same_stopped_identity_and_paired_command_ids(self):
        request = self.stopped_draft()
        for changes, error in (
                ({'task_id': 'other'}, 'SESSION_MISMATCH'),
                ({'generation': '1'}, 'SESSION_MISMATCH'),
                ({'command_id': 'other:send'}, 'INVALID_DRAFT_RESUME'),
                ({'paste_command_id': 'other:paste'}, 'INVALID_DRAFT_RESUME'),
                ({'command_id': ':send', 'paste_command_id': ':paste'}, 'INVALID_DRAFT_RESUME'),
                ({'action': {'action': 'click'}}, 'INVALID_DRAFT_RESUME'),
                ({'command_id': 'absent:send', 'paste_command_id': 'absent:paste'}, 'PASTE_RECEIPT_REQUIRED')):
            self.assertEqual(self.adapter.dispatch('resume_draft', {**request, **changes})['error'], error)
        self.assertTrue(self.adapter.dispatch('resume_draft', request)['ok'])
        self.assertEqual(self.adapter.dispatch('resume_draft', request)['error'], 'SESSION_NOT_STOPPED')
        self.assertEqual(len(self.hid.calls), 1)

    def test_resume_draft_rejects_inflight_unreleased_or_invalid_paste_receipts(self):
        request = self.stopped_draft()
        self.adapter.in_flight = 'still-cleaning-up'
        self.assertEqual(self.adapter.dispatch('resume_draft', request)['error'], 'EXECUTOR_BUSY')
        self.adapter.in_flight = None
        self.adapter.execution_lock.acquire()
        try:
            self.assertEqual(self.adapter.dispatch('resume_draft', request)['error'], 'EXECUTOR_BUSY')
        finally:
            self.adapter.execution_lock.release()
        original = self.adapter.dispatch('status', {**IDENTITY, 'command_id': 'draft:paste'})['receipt']
        for changes, error in (({'release_confirmed': False}, 'INPUT_UNKNOWN'),
                               ({'action': 'click'}, 'PASTE_RECEIPT_INVALID'),
                               ({'outcome': 'not_sent'}, 'PASTE_RECEIPT_INVALID')):
            self.adapter.record({**original, **changes})
            self.assertEqual(self.adapter.dispatch('resume_draft', request)['error'], error)
        self.adapter.record(original)
        for outcome in ('unknown', 'input_sent', 'effect_verified'):
            self.adapter.record({**original, 'outcome': outcome})
            self.assertTrue(self.adapter.dispatch('resume_draft', request)['ok'])
            self.adapter.dispatch('stop', IDENTITY)
        self.assertEqual(len(self.hid.calls), 1)

    def test_resume_draft_rejects_foreign_paste_and_any_prior_send_receipt(self):
        request = self.stopped_draft()
        with self.adapter.connect() as db:
            db.execute("UPDATE commands SET generation=? WHERE command_id='draft:paste'", (support.encode(2),))
            db.commit()
        self.assertEqual(self.adapter.dispatch('resume_draft', request)['error'], 'SESSION_MISMATCH')
        with self.adapter.connect() as db:
            db.execute("UPDATE commands SET generation=? WHERE command_id='draft:paste'", (support.encode(1),))
            db.commit()
        self.adapter.record({**IDENTITY, 'command_id': 'draft:send', 'action': 'hotkey',
                             'outcome': 'not_sent', 'release_confirmed': True}, 'already-recorded')
        self.assertEqual(self.adapter.dispatch('resume_draft', request)['error'], 'SEND_ALREADY_RECORDED')
        self.assertEqual(len(self.hid.calls), 1)

    def test_draft_resume_survives_restart_only_as_stopped_without_input_replay(self):
        request = self.stopped_draft()
        self.assertTrue(self.adapter.dispatch('resume_draft', request)['ok'])
        self.adapter.close()
        self.adapter = self.create()
        self.assertEqual(self.adapter.dispatch('status', IDENTITY)['phase'], 'stopped')
        self.assertEqual(self.adapter.dispatch('begin', IDENTITY)['error'], 'SESSION_STOPPED')
        self.assertEqual(len(self.hid.calls), 1)
        self.assertTrue(self.adapter.dispatch('resume_draft', request)['ok'])
        sent = command('draft:send', {'action': 'hotkey', 'target_id': 1, 'keys': 'ENTER'})
        self.assertTrue(self.adapter.dispatch('execute', sent)['ok'])
        self.adapter.close()
        self.adapter = self.create()
        self.assertEqual(self.adapter.dispatch('resume_draft', request)['error'], 'SEND_ALREADY_RECORDED')
        self.assertTrue(self.adapter.dispatch('execute', sent)['deduplicated'])
        self.assertEqual(len(self.hid.calls), 2)

    def test_failed_draft_resume_persistence_keeps_session_stopped(self):
        request = self.stopped_draft()
        with patch.object(self.adapter, 'save_session', side_effect=sqlite3.OperationalError('disk failure')):
            self.assertFalse(self.adapter.dispatch('resume_draft', request)['ok'])
        self.assertEqual(self.adapter.current['phase'], 'stopped')
        self.assertTrue(self.adapter.cancel.is_set())
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
        self.record = None

    def call(self, args):
        self.calls.append(args)
        if args['op'] == 'catalog':
            return {'memories': [{'id': 'qa-memory', 'tags': ['qa:unit']}]}
        if args['op'] == 'set':
            self.record = {**args, 'id': 'qa-memory'}
            return {'id': 'qa-memory', 'key': args['key']}
        return {'memories': [self.record if self.record and identifier == self.record['id']
                             else {'id': identifier, 'tags': ['qa:unit'] if identifier == 'qa-memory' else []}
                             for identifier in args['ids']]}


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

    def test_explicit_preferences_reuse_scoped_key_and_fixed_source(self):
        request = {'key': 'preference:coloop:A02:signature', 'value': '署名小林', 'source_task_id': 'task1'}
        saved = self.worker.dispatch('memory.remember', request)
        self.assertTrue(saved['ok'])
        self.assertTrue(saved['result']['readback_verified'])
        self.assertEqual(saved['result']['memories'][0]['value'], '署名小林')
        self.assertTrue(self.worker.dispatch('memory.remember', {**request, 'value': '署名林悦'})['ok'])
        calls = [row for row in self.memory.calls if row['op'] == 'set']
        self.assertEqual(calls[0]['key'], calls[1]['key'])
        self.assertTrue(calls[0]['key'].startswith('preference:coloop:qa_'))
        self.assertEqual(calls[1]['value'], '署名林悦')
        self.assertEqual(calls[1]['kind'], 'preference')
        self.assertEqual(calls[1]['source'], 'user_message')
        self.assertFalse(calls[1]['verified'])
        self.assertEqual(calls[1]['tags'], ['qa:unit', 'user_preference'])
        self.assertEqual(calls[1]['ttl'], 86400)
        for change in ({'kind': 'procedure'}, {'key': 'private:credential:bad'}, {'value': ''}, {'verified': True}):
            self.assertFalse(self.worker.dispatch('memory.remember', {**request, **change})['ok'])
        self.assertEqual(len([row for row in self.memory.calls if row['op'] == 'set']), 2)

    def test_remember_does_not_report_success_for_unconfirmed_or_stale_write(self):
        request = {'key': 'preference:coloop:test:signature', 'value': '署名小林', 'source_task_id': 'task1'}
        original = self.memory.call
        for changes in ({'value': '旧偏好'}, {'key': 'preference:coloop:another'},
                        {'kind': 'procedure'}, {'id': 'another'}):
            def corrupted(args):
                result = original(args)
                if args['op'] == 'get_many':
                    return {'memories': [{**result['memories'][0], **changes}]}
                return result
            with patch.object(self.memory, 'call', side_effect=corrupted):
                result = self.worker.dispatch('memory.remember', request)
            self.assertFalse(result['ok'])
            expected = 'INVALID_MEMORY_RESULT' if 'id' in changes else 'PREFERENCE_READBACK_MISMATCH'
            self.assertEqual(result['error'], expected)
        with patch.object(self.memory, 'call', return_value={}):
            result = self.worker.dispatch('memory.remember', request)
        self.assertEqual(result['error'], 'PREFERENCE_READBACK_REQUIRED')

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
        self.assertFalse(self.worker.dispatch('memory.catalog', {'namespace': 'production'})['ok'])

    def test_reads_older_scoped_record_without_a_first_page_catalog_gate(self):
        record = {'id': 'older-sixth-record', 'tags': ['qa:unit', 'user_preference'],
                  'key': 'preference:coloop:qa:signature', 'kind': 'preference', 'value': '署名小林'}
        with patch.object(self.memory, 'call', return_value={'memories': [record], 'missing': []}) as call:
            result = self.worker.dispatch('memory.get', {'ids': [record['id']]})
        self.assertEqual(result, {'ok': True, 'result': {'memories': [record], 'missing': []}})
        call.assert_called_once_with({'op': 'get_many', 'ids': [record['id']]})

    def test_scoped_read_preserves_missing_and_maintenance_results(self):
        for response in ({'memories': [], 'missing': ['deleted']},
                         {'memories': [], 'deferred': True, 'reason': 'maintenance'}):
            with self.subTest(response=response), patch.object(self.memory, 'call', return_value=response):
                self.assertEqual(self.worker.dispatch('memory.get', {'ids': ['deleted']}),
                                 {'ok': True, 'result': response})

    def test_production_read_accepts_existing_records_without_qa_tags(self):
        response = {'memories': [{'id': 'existing', 'value': '中文回复'}], 'missing': []}
        with patch.object(self.worker, 'namespace', 'production'), \
                patch.object(self.memory, 'call', return_value=response) as call:
            self.assertEqual(self.worker.dispatch('memory.get', {'ids': ['existing']}),
                             {'ok': True, 'result': response})
        call.assert_called_once_with({'op': 'get_many', 'ids': ['existing']})

    def test_production_remember_rejects_malformed_readback_with_a_stable_error(self):
        request = {'key': 'preference:coloop:test:signature', 'value': '署名小林', 'source_task_id': 'task1'}
        for records in (None, {}, [None], ['invalid']):
            with self.subTest(records=records), patch.object(self.worker, 'namespace', 'production'), \
                    patch.object(self.memory, 'call', side_effect=[{'id': 'saved'}, {'memories': records}]):
                self.assertEqual(self.worker.dispatch('memory.remember', request),
                                 {'ok': False, 'error': 'PREFERENCE_READBACK_MISMATCH'})

    def test_scoped_read_rejects_foreign_or_malformed_bodies_without_returning_content(self):
        for response, code in (
            ({'memories': [{'id': 'a', 'tags': ['qa:other'], 'value': 'private body'}]}, 'MEMORY_SCOPE_MISMATCH'),
            ({'memories': [{'id': 'a', 'value': 'private body'}]}, 'MEMORY_SCOPE_MISMATCH'),
            ({'memories': [{'id': 'a', 'tags': 'qa:unit', 'value': 'private body'}]}, 'MEMORY_SCOPE_MISMATCH'),
            ({'memories': [{'id': 'a', 'tags': ['qa:unit']}, {'id': 'b', 'tags': ['qa:other']}]}, 'MEMORY_SCOPE_MISMATCH'),
            ({'memories': [{'id': 'other', 'tags': ['qa:unit']}]}, 'INVALID_MEMORY_RESULT'),
            ({'memories': [{'id': 'a', 'tags': ['qa:unit']}, {'id': 'a', 'tags': ['qa:unit']}]}, 'INVALID_MEMORY_RESULT'),
            ({'memories': [], 'missing': ['unknown']}, 'INVALID_MEMORY_RESULT'),
            ({'memories': []}, 'INVALID_MEMORY_RESULT'),
            ({'memories': None}, 'INVALID_MEMORY_RESULT'),
            ({'memories': [None]}, 'INVALID_MEMORY_RESULT'),
            ({'memories': [{'id': 'a', 'tags': ['qa:unit']}], 'deferred': True}, 'INVALID_MEMORY_RESULT'),
        ):
            ids = ['a', 'b'] if any(isinstance(item, dict) and item.get('id') == 'b'
                                   for item in response.get('memories') or []) else ['a']
            with self.subTest(response=response), patch.object(self.memory, 'call', return_value=response):
                self.assertEqual(self.worker.dispatch('memory.get', {'ids': ids}),
                                 {'ok': False, 'error': code})

    def test_remember_rejects_negative_write_acknowledgement_before_readback(self):
        request = {'key': 'preference:coloop:test:signature', 'value': '署名小林', 'source_task_id': 'task1'}
        for ack, code in (
            ({'id': 'qa-memory', 'deferred': True}, 'PREFERENCE_WRITE_DEFERRED'),
            ({'id': 'qa-memory', 'saved': False}, 'PREFERENCE_WRITE_UNACKNOWLEDGED'),
            ({'id': 'qa-memory', 'ok': False}, 'PREFERENCE_WRITE_UNACKNOWLEDGED'),
            ({'id': 'qa-memory', 'error': 'busy'}, 'PREFERENCE_WRITE_UNACKNOWLEDGED'),
        ):
            with self.subTest(ack=ack), patch.object(self.memory, 'call', return_value=ack) as call:
                self.assertEqual(self.worker.dispatch('memory.remember', request), {'ok': False, 'error': code})
                self.assertEqual(call.call_count, 1)

    def test_remember_reports_deferred_readback_and_can_be_retried(self):
        request = {'key': 'preference:coloop:test:signature', 'value': '署名小林', 'source_task_id': 'task1'}
        original = self.memory.call
        def deferred_read(args):
            if args['op'] == 'get_many':
                return {'memories': [], 'deferred': True, 'reason': 'maintenance'}
            return original(args)
        with patch.object(self.memory, 'call', side_effect=deferred_read):
            result = self.worker.dispatch('memory.remember', request)
        self.assertEqual(result, {'ok': False, 'error': 'PREFERENCE_READBACK_DEFERRED'})
        self.assertTrue(self.worker.dispatch('memory.remember', request)['result']['readback_verified'])

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
