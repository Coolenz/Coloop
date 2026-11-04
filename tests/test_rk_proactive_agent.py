"""CPU-only Agent behavior checks; never connects models, clipboard or HID devices."""
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest


spec = importlib.util.spec_from_file_location('rk_proactive',
    Path(__file__).resolve().parents[1] / 'resources/rk-proactive-agent.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def view(identity='obs1', text='Title'):
    return {'observation_id': identity, 'window_id': 'window1', 'ocr_text': text,
            'targets': [{'id': 2, 'name': text}], 'ocr_items': [{'id': 2, 'text': text}]}


class FakeHID:
    def __init__(self, fail=False):
        self.commands = []
        self.fail = fail

    def execute(self, command, validated, check):
        check(b'report')
        self.commands.append(command)
        if self.fail:
            raise OSError('partial USB write')


class AgentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.events = []
        self.agent = module.Agent(self.temp.name, self.events.append,
                                  model=lambda *_: (_ for _ in ()).throw(
                                      AssertionError('task execution must not call Qwen')), hid=FakeHID())
        self.agent.latest = view()

    def tearDown(self):
        self.agent.memory_reviews.close(timeout=2)
        self.temp.cleanup()

    def wait_memory(self, task_id='task1'):
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            status = self.agent.memory_reviews.status(task_id)
            if status and status['status'] in ('saved', 'skipped', 'failed'):
                return status
            time.sleep(.01)
        self.fail('Memory review did not finish')

    def start(self):
        self.agent.start({'task_id': 'task1', 'goal': 'append Chinese outline'})

    def tools(self, verified=True):
        calls = []
        def rpc(op, value, **kwargs):
            calls.append((op, value))
            if op == 'input.validate':
                return {'allowed': True, 'center': [20, 20], 'screen': [0, 0, 1920, 1080]}
            if op in ('input.guard', 'clipboard.guard'):
                return {'allowed': True}
            if op == 'clipboard.prepare':
                return {'lease_id': 'lease1'}
            if op == 'clipboard.verify':
                return {'verified': verified}
            if op == 'completion.verify':
                return {'verified': verified}
            if op == 'clipboard.finish':
                return {'restored': True}
            raise AssertionError(op)
        self.agent.rpc = rpc
        return calls

    def test_rpc_preserves_target_change_for_replanning(self):
        def emit(packet):
            self.agent.accept({'type': 'reply', 'id': packet['id'],
                               'error': 'INPUT_TARGET_CHANGED'})
        self.agent.emit = emit
        with self.assertRaisesRegex(ValueError, '^INPUT_TARGET_CHANGED$'):
            self.agent.rpc('input.validate', {})

    def test_rpc_preserves_cloud_truncation_for_shorter_replanning(self):
        for code in ('RELAY_OUTPUT_TRUNCATED', 'RELAY_RESPONSE_LIMIT'):
            def emit(packet):
                self.agent.accept({'type': 'reply', 'id': packet['id'], 'error': code})
            self.agent.emit = emit
            with self.assertRaisesRegex(ValueError, '^' + code + '$'):
                self.agent.rpc('cloud_transport', {})

    def test_transient_ocr_failure_reads_again_without_input(self):
        self.start()
        attempts = []
        def rpc(*_args, **_kwargs):
            attempts.append(1)
            if len(attempts) <= 2:
                raise ValueError('OBSERVATION_RETRY')
            return view('fresh')
        self.agent.rpc = rpc
        self.agent.cancel.wait = lambda _: False
        self.assertEqual(self.agent.observe()['observation_id'], 'fresh')
        self.assertEqual(len(attempts), 3)
        self.assertEqual(self.agent.hid.commands, [])

    def test_observation_retries_remain_cancellable(self):
        self.start()
        def rpc(*_args, **_kwargs):
            self.agent.cancel.set()
            raise ValueError('OBSERVATION_RETRY')
        self.agent.rpc = rpc
        with self.assertRaises(module.Cancelled):
            self.agent.observe()

    def test_observation_retry_does_not_swallow_privacy_or_host_errors(self):
        self.start()
        def rpc(*_args, **_kwargs):
            raise ValueError('host_tool_rejected:observe.request')
        self.agent.rpc = rpc
        self.agent.emit = lambda packet: self.agent.cancel.set() if packet['type'] == 'observation.retry' else None
        with self.assertRaises(module.Cancelled):
            self.agent.observe()
        self.assertEqual(self.agent.hid.commands, [])

    def test_pre_input_transient_errors_release_clipboard_without_dispatch(self):
        for reason in ('OBSERVATION_EXPIRED', 'INPUT_GUARD_CHANGED', 'CLIPBOARD_LEASE_CHANGED'):
            with self.subTest(reason=reason):
                if self.agent.task is None:
                    self.start()
                self.agent.task['receipts'].clear()
                calls = self.tools()
                original = self.agent.rpc
                def rpc(op, args, **kwargs):
                    if op == 'input.guard':
                        raise ValueError(reason)
                    return original(op, args, **kwargs)
                self.agent.rpc = rpc
                result = self.agent.execute_group(
                    [{'action': 'paste', 'target_id': 2, 'text': 'hello'}], view())
                self.assertEqual(result, 'reobserve')
                self.assertEqual(self.agent.hid.commands, [])
                self.assertEqual(calls[-1][0], 'clipboard.finish')
                self.assertEqual(self.agent.task['receipts'][-1]['outcome'], 'not_sent')

    def test_repeated_target_changes_recover_without_user_wait(self):
        self.start()
        self.agent.observe = lambda: view()
        self.agent.mem = lambda *_: {'memories': []}
        plans = []
        def cloud(*_args):
            plans.append(1)
            if len(plans) > 26:
                return {'type': 'blocked', 'reason': 'test completed'}
            return {'type': 'action_plan', 'observation_id': 'obs1',
                    'expected_text': 'new text', 'actions': [{'action': 'click', 'target_id': 2}]}
        self.agent.cloud = cloud
        def rpc(*_args, **_kwargs):
            raise ValueError('OBSERVATION_EXPIRED')
        self.agent.rpc = rpc
        def wait(reason):
            self.assertEqual(reason, 'test completed')
            raise module.Cancelled()
        self.agent.wait_for_help = wait
        with self.assertRaises(module.Cancelled):
            self.agent.run_task()
        self.assertEqual(len(plans), 28)
        self.assertEqual(self.agent.hid.commands, [])
        self.assertIsNotNone(self.agent.task)
        self.assertIsNone(self.agent.terminal)

    def test_consecutive_cloud_failures_recover_without_user_wait(self):
        self.start()
        self.agent.observe = lambda: view()
        self.agent.mem = lambda *_: {}
        calls = []
        def cloud(*_args):
            calls.append(1)
            if len(calls) == 8:
                raise module.Cancelled()
            raise TimeoutError('offline')
        self.agent.cloud = cloud
        self.agent.cancel.wait = lambda _: False
        self.agent.wait_for_help = lambda _: self.fail('temporary failures must recover automatically')
        with self.assertRaises(module.Cancelled):
            self.agent.run_task()
        self.assertEqual(len(calls), 8)
        budget_events = [e for e in self.events if e['type'] == 'task.budget']
        self.assertEqual(budget_events[-1]['value']['reason'], 'consecutive_failures')
        self.assertIsNotNone(self.agent.task)
        self.assertEqual(self.agent.hid.commands, [])

    def test_budget_ignores_poll_ids_but_recognizes_control_state_change(self):
        budget = module.DecisionBudget()
        for i in range(6):
            observed = view(str(i))
            observed['targets'][0]['id'] = i
            self.assertIsNone(budget.before_plan(observed))
        self.assertEqual(budget.before_plan(view('new-id')), 'no_progress')
        changed = view('next')
        changed['targets'][0]['state'] = True
        self.assertIsNone(budget.before_plan(changed))
        self.assertEqual(budget.unchanged, 0)

    def test_changing_screens_still_have_planning_limit_and_answer_resets_it(self):
        self.start()
        budget = self.agent.decision_budget
        for i in range(40):
            self.assertIsNone(budget.before_plan(view(str(i), str(i))))
        self.assertEqual(budget.before_plan(view('41', '41')), 'planning_limit')
        self.agent.emit = lambda packet: self.agent.answers.put({
            'question_id': packet['value']['question_id'], 'answer': 'continue'
        }) if packet['type'] == 'question' else None
        self.agent.wait_for_help('review progress')
        self.assertEqual(budget.rounds, 0)
        self.assertIsNone(budget.before_plan(view()))

    def test_control_state_completion_uses_live_baseline_and_post_input_read(self):
        self.start()
        observed = view()
        observed['targets'][0].update(runtime_id=[42, 8], center=[20, 20])
        self.agent.observe = lambda: observed
        self.agent.mem = lambda *_: {}
        replies = iter([
            {'type': 'action_plan', 'observation_id': 'obs1',
             'actions': [{'action': 'click', 'target_id': 2}],
             'expected_state': {'target_id': 2, 'property': 'checked', 'value': True}},
            {'type': 'finish', 'summary': 'checked'}, {'type': 'finish'}])
        self.agent.cloud = lambda *_: next(replies)
        reads = []
        def rpc(op, value, **_kwargs):
            self.assertEqual(op, 'completion.verify')
            reads.append(value)
            return {'observable': True, 'verified': len(reads) == 2}
        self.agent.rpc = rpc
        def execute(*_args):
            self.agent.task['receipts'].append({'outcome': 'input_sent', 'action': 'click'})
            return 'input_sent'
        self.agent.execute_group = execute
        self.agent.run_task()
        self.assertTrue(self.agent.terminal['verified'])
        self.assertEqual(len(reads), 2)
        self.assertEqual(reads[1]['expected_state']['runtime_id'], [42, 8])
        self.assertEqual(reads[1]['evidence_mode'], 'control_state')

    def test_unknown_or_already_satisfied_control_state_never_dispatches(self):
        for baseline in ({'observable': False, 'verified': False},
                         {'observable': True, 'verified': True}):
            with self.subTest(baseline=baseline):
                if self.agent.task is None:
                    self.start()
                self.agent.decision_budget.reset()
                observed = view()
                observed['targets'][0].update(runtime_id=[42, 8], center=[20, 20])
                self.agent.observe = lambda: observed
                self.agent.mem = lambda *_: {}
                self.agent.rpc = lambda *_args, **_kwargs: baseline
                plans = []
                def cloud(*_):
                    plans.append(1)
                    if len(plans) == 9:
                        raise module.Cancelled()
                    return {'type': 'action_plan', 'observation_id': 'obs1',
                        'actions': [{'action': 'click', 'target_id': 2}],
                        'expected_state': {'target_id': 2, 'property': 'selected', 'value': True}}
                self.agent.cloud = cloud
                self.agent.cancel.wait = lambda _: False
                self.agent.wait_for_help = lambda _: (_ for _ in ()).throw(module.Cancelled())
                self.agent.execute_group = lambda *_: self.fail('must not dispatch')
                with self.assertRaises(module.Cancelled):
                    self.agent.run_task()
                self.assertEqual(self.agent.task['receipts'], [])

    def test_waiting_for_help_keeps_task_and_resumes_on_answer(self):
        self.start()
        def emit(packet):
            if packet['type'] == 'question':
                self.assertIsNotNone(self.agent.task)
                self.assertIsNone(self.agent.terminal)
                self.agent.answers.put({'question_id': packet['value']['question_id'], 'answer': 'continue'})
        self.agent.emit = emit
        self.agent.wait_for_help('check the screen')
        self.assertEqual(self.agent.task['user_answers'][-1]['answer'], 'continue')
        self.assertNotIn('question_id', self.agent.task)

    def test_cloud_error_reobserves_instead_of_finishing_task(self):
        self.start()
        self.agent.observe = lambda: view('fresh')
        self.agent.mem = lambda *_: {'memories': []}
        calls = []
        def cloud(*_args):
            calls.append(1)
            if len(calls) == 1:
                raise TimeoutError('cloud timeout')
            return {'type': 'blocked', 'reason': 'need help'}
        self.agent.cloud = cloud
        self.agent.wait_for_help = lambda _: (_ for _ in ()).throw(module.Cancelled())
        self.agent.cancel.wait = lambda _: False
        with self.assertRaises(module.Cancelled):
            self.agent.run_task()
        self.assertEqual(len(calls), 3)
        self.assertIsNotNone(self.agent.task)
        self.assertIsNone(self.agent.terminal)

    def test_blocked_result_gets_an_automatic_feedback_turn_before_user_help(self):
        self.start()
        self.agent.observe = lambda: view('current')
        self.agent.mem = lambda *_: {'memories': []}
        payloads = []
        def cloud(_policy, payload):
            payloads.append(dict(payload))
            return {'type': 'blocked', 'reason': 'AI cannot control devices'}
        self.agent.cloud = cloud
        self.agent.wait_for_help = lambda _: (_ for _ in ()).throw(module.Cancelled())
        with self.assertRaises(module.Cancelled):
            self.agent.run_task()
        self.assertEqual(len(payloads), 2)
        self.assertEqual(payloads[1]['tool_results'][-1]['reason'], 'blocked_result_review')
        self.assertIsNotNone(self.agent.task)
        self.assertIsNone(self.agent.terminal)

    def test_task_can_observe_another_window(self):
        self.start()
        changed = {**view('obs2'), 'window_id': 'window2'}
        self.agent.rpc = lambda *_args, **_kwargs: changed
        self.assertEqual(self.agent.observe(), changed)
        self.assertEqual(self.agent.task['window_id'], 'window2')
        self.assertIs(self.agent.latest, changed)

    def test_window_change_before_input_returns_for_replanning(self):
        self.start()
        def rpc(*_args, **_kwargs):
            raise ValueError('INPUT_TARGET_CHANGED')
        self.agent.rpc = rpc
        self.agent.execute_group([{'action': 'click', 'target_id': 2}], view())
        self.assertEqual(self.agent.hid.commands, [])
        self.assertEqual(self.agent.task['receipts'], [])

    def test_suggestion_does_not_start_input(self):
        self.agent.model = lambda *_: {'decision': 'suggest', 'relevant_item_ids': [2]}
        forwarded = []
        self.agent.cloud = lambda policy, body: forwarded.append(body) or {
            'type': 'suggestion', 'title': 'Outline', 'text': '标题建议', 'goal': 'Append'}
        self.agent.classify(self.agent.latest)
        self.assertIsNone(self.agent.task)
        self.assertEqual(forwarded[0]['ocr_items'][0]['text'], 'Title')
        self.assertEqual(self.events[-1]['type'], 'suggestion')
        self.assertEqual(self.agent.hid.commands, [])

    def test_memory_review_does_not_block_task_and_keeps_original_identity(self):
        self.start()
        release = threading.Event()
        entered = threading.Event()
        def model(*_):
            entered.set()
            release.wait(2)
            return {'type': 'memory.set', 'key': 'procedure:test', 'value': 'verified'}
        self.agent.model = model
        writes = []
        self.agent.mem = lambda op, body: writes.append(body) or {'id': 'memory1'}
        original = self.agent.task
        original['verified'] = True
        self.agent.queue_memory_review(original, {'summary': 'done'})
        self.assertTrue(entered.wait(1))
        self.assertFalse(writes)
        self.agent.task = None
        self.agent.start({'task_id': 'task2', 'goal': 'next'})
        release.set()
        self.wait_memory()
        self.assertEqual(writes[0]['source_task_id'], 'task1')
        self.assertEqual(self.agent.task['task_id'], 'task2')

    def test_unavailable_script_executor_clears_unstarted_step(self):
        self.start()
        def emit(packet):
            if packet['type'] == 'request':
                self.agent.accept({'type': 'reply', 'id': packet['id'],
                                   'error': 'SCRIPT_EXECUTOR_UNAVAILABLE'})
        self.agent.emit = emit
        with self.assertRaisesRegex(ValueError, '^SCRIPT_EXECUTOR_UNAVAILABLE$'):
            self.agent.execute_script({'runtime': 'node', 'code': 'console.log(1)',
                                       'verify_code': 'console.log(1)'})
        self.assertNotIn('pending_script', self.agent.task)
        self.assertEqual(self.agent.task['receipts'], [])

    def test_ocr_goes_directly_to_cloud_without_local_inference(self):
        forwarded = []
        self.agent.cloud = lambda _, payload: forwarded.append(payload) or {
            'type': 'suggestion', 'title': 'Outline', 'text': 'Title', 'goal': 'Append'}
        self.agent.classify(self.agent.latest)
        self.assertEqual(forwarded[0]['observation'], self.agent.latest)
        self.assertEqual(self.agent.suggestion['text'], 'Title')
        self.assertFalse(any(e['type'] == 'model.timing' for e in self.events))

    def test_stale_cloud_recommendation_is_discarded(self):
        def cloud(*_):
            self.agent.latest = view('new')
            return {'type': 'suggestion', 'title': 'Old', 'text': 'Old', 'goal': 'Old'}
        self.agent.cloud = cloud
        self.agent.classify(self.agent.latest)
        self.assertIsNone(self.agent.suggestion)

    def test_cloud_defer_can_be_retried(self):
        self.agent.cloud = lambda *_: {'type': 'defer'}
        self.agent.classify(self.agent.latest)
        self.assertFalse(self.agent.seen)

    def test_text_reference_preserves_unicode_without_regeneration(self):
        self.start()
        self.agent.model = lambda *_: {'observation_id': 'obs1', 'actions': [
            {'action': 'paste', 'target_id': 2, 'text_ref': 'cloud_text'}]}
        literal = '\n中文原文 😀\n  保留空格 '
        self.assertEqual(self.agent.validate_cloud_group({'type': 'action_plan', 'observation_id': 'obs1',
            'actions': [{'action': 'paste', 'target_id': 2, 'text_ref': 'cloud_text'}]}, view(), literal)[0]['text'], literal)

    def test_cloud_format_retry_does_not_dispatch_input(self):
        replies = iter(['{}{}', '{"type":"finish","summary":"ok"}'])
        self.agent.rpc = lambda *_args, **_kwargs: next(replies)
        self.assertEqual(self.agent.cloud('JSON only', {'goal': 'test'})['type'], 'finish')
        self.assertEqual(self.agent.hid.commands, [])
        self.assertEqual(self.events[-1]['type'], 'cloud.format_retry')

    def test_ignored_content_not_suggested_again(self):
        count = []
        self.agent.cloud = lambda *_: count.append(1) or {'type': 'ignore'}
        self.agent.classify(self.agent.latest)
        self.agent.classify(self.agent.latest)
        self.assertEqual(len(count), 1)

    def test_stale_suggestion_cannot_execute(self):
        self.agent.suggestion = {'suggestion_id': 's1', 'observation_id': 'old',
                                 'goal': 'Append', 'text': 'Chinese'}
        with self.assertRaisesRegex(ValueError, 'stale_suggestion'):
            self.agent.accept({'type': 'suggestion.accept', 'value': {'suggestion_id': 's1'}})

    def test_accept_preserves_proposed_content(self):
        self.agent.suggestion = {'suggestion_id': 's1', 'observation_id': 'obs1',
                                 'goal': 'Append', 'text': '中文大纲'}
        self.agent.accept({'type': 'suggestion.accept',
                           'value': {'suggestion_id': 's1', 'task_id': 'task1'}})
        self.assertIn('中文大纲', self.agent.task['goal'])

    def test_task_ids_persistently_refuse_replay(self):
        self.start()
        self.agent.task = None
        with self.assertRaisesRegex(ValueError, 'duplicate_task'):
            self.start()
        another = module.Agent(self.temp.name, lambda _: None)
        self.addCleanup(another.memory_reviews.close)
        with self.assertRaises(FileExistsError):
            another.start({'task_id': 'task1', 'goal': 'Again'})
        another.memory_reviews.close()

    def test_failed_admission_journal_cannot_leave_executable_task(self):
        self.agent.state = lambda _: (_ for _ in ()).throw(OSError('disk full'))
        with self.assertRaises(OSError):
            self.start()
        self.assertIsNone(self.agent.task)
        self.assertEqual(self.agent.hid.commands, [])

    def test_answer_binds_to_question(self):
        self.start()
        self.agent.task['question_id'] = 'q1'
        with self.assertRaisesRegex(ValueError, 'stale_answer'):
            self.agent.accept({'type': 'task.answer', 'value': {
                'task_id': 'task1', 'question_id': 'old', 'answer': 'yes'}})

    def test_paste_uses_usb_chord_and_cleanup(self):
        self.start()
        calls = self.tools()
        self.agent.execute_group([{'action': 'paste', 'target_id': 2,
                                   'text': '中文\n大纲 😀'}], view())
        self.assertEqual(self.agent.hid.commands, [{'action': 'hotkey', 'keys': 'CTRL+V'}])
        self.assertEqual(calls[-1][0], 'clipboard.finish')
        prepare = next(value for op, value in calls if op == 'clipboard.prepare')
        self.assertEqual(prepare['text'], '中文\n大纲 😀')
        self.assertEqual(prepare['window_id'], 'window1')
        self.assertEqual(self.agent.task['receipts'][0]['outcome'], 'input_sent')

    def test_delayed_paste_is_verified_automatically_without_asking_or_replaying(self):
        self.start()
        self.agent.mem = lambda *_: {'memories': []}
        self.agent.observe = lambda: view('fresh', 'Title hello')
        self.agent.wait_for_help = lambda _: self.fail('must verify before asking the user')
        replies = iter([
            {'type': 'action_plan', 'observation_id': 'fresh', 'text': 'hello',
             'expected_text': 'hello', 'actions': [{'action': 'paste', 'target_id': 2, 'text_ref': 'cloud_text'}]},
            {'type': 'finish', 'summary': 'verified'},
            {'type': 'finish', 'summary': 'no memory'},
        ])
        self.agent.cloud = lambda *_: next(replies)
        calls = self.tools()
        original = self.agent.rpc
        verifications = []
        def rpc(op, args, **kwargs):
            if op == 'clipboard.verify':
                verifications.append(1)
                return {'allowed': True, 'verified': len(verifications) > 1, 'evidence': 'exact_insertion'}
            return original(op, args, **kwargs)
        self.agent.rpc = rpc
        self.agent.run_task()
        self.assertEqual(self.agent.terminal['phase'], 'completed')
        self.assertEqual(len(self.agent.hid.commands), 1)
        self.assertEqual(self.agent.task['receipts'][0]['recovery'], 'effect_verified')
        self.assertEqual(self.agent.task['verified_texts'], ['hello'])
        self.assertTrue(any(event['type'] == 'input.recovered' for event in self.events))

    def test_unresolved_input_recovery_only_reads_and_remains_unknown(self):
        self.start()
        self.tools(verified=False)
        self.agent.observe = lambda: view('new', 'unchanged')
        self.agent.cancel.wait = lambda _: False
        receipt = {'action': 'paste', 'outcome': 'unknown'}
        error = module.UnknownInput('test', {'receipt': receipt,
            'action': {'action': 'paste', 'text': 'hello'}, 'args': {},
            'observed': view(), 'input_complete': True})
        self.assertIsNone(self.agent.recover_input(error))
        self.assertEqual(receipt['outcome'], 'unknown')
        self.assertEqual(self.agent.hid.commands, [])
        self.assertEqual(sum(event['type'] == 'input.recovery_pending' for event in self.events), 3)

    def test_verification_alone_cannot_clear_uncertain_pressed_keys(self):
        self.start()
        self.agent.observe = lambda: view('fresh')
        self.agent.rpc = lambda *_: {'verified': True, 'allowed': True, 'evidence': 'exact_insertion'}
        self.agent.cancel.wait = lambda _: False
        receipt = {'action': 'paste', 'outcome': 'unknown'}
        error = module.UnknownInput('test', {'receipt': receipt,
            'action': {'action': 'paste', 'text': 'hello'}, 'args': {},
            'observed': view(), 'input_complete': False})
        self.assertIsNone(self.agent.recover_input(error))
        self.assertEqual(receipt['outcome'], 'unknown')

    def test_recovery_requires_released_keys_and_verified_effect_then_never_resends(self):
        self.start()
        neutral = []
        self.agent.hid.node = lambda _: 'test-keyboard'
        self.agent.hid.send = lambda node, reports, release: neutral.append(reports)
        self.agent.observe = lambda: view('fresh')
        self.agent.rpc = lambda *_: {'verified': True, 'allowed': True, 'evidence': 'exact_insertion'}
        receipt = {'action': 'paste', 'outcome': 'unknown'}
        error = module.UnknownInput('test', {'receipt': receipt,
            'action': {'action': 'paste', 'text': 'hello'}, 'args': {},
            'observed': view(), 'input_complete': False})
        self.assertEqual(self.agent.recover_input(error)['observation_id'], 'fresh')
        self.assertEqual(neutral, [[bytes(8)]])
        self.assertEqual(receipt['outcome'], 'input_sent')
        self.assertEqual(self.agent.hid.commands, [])

    def test_recovery_cancellation_remains_immediate(self):
        self.start()
        self.agent.cancel.set()
        with self.assertRaises(module.Cancelled):
            self.agent.recover_input(module.UnknownInput('test', {'action': {}, 'receipt': {}}))

    def test_script_plan_uses_real_host_tool_result_to_finish_same_task(self):
        self.start()
        self.agent.observe = lambda: view()
        self.agent.mem = lambda *_: {'memories': []}
        script = {'type': 'script', 'runtime': 'node', 'code': 'action', 'verify_code': 'readback'}
        responses = iter([script, {'type': 'finish', 'summary': 'actual file created'}, {'type': 'finish', 'summary': 'no memory'}])
        self.agent.cloud = lambda *_: next(responses)
        calls = []
        def rpc(op, args, **kwargs):
            calls.append((op,args))
            self.assertEqual(op, 'script.execute')
            return {'verified': True, 'evidence': 'file read back', 'exit_code': 0, 'stdout': '', 'stderr': '', 'verification': {}}
        self.agent.rpc = rpc
        self.agent.run_task()
        self.assertEqual(self.agent.terminal['phase'], 'completed')
        self.assertEqual(self.agent.task['receipts'][0]['action'], 'script')
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.agent.hid.commands, [])

    def test_script_timeout_queries_same_execution_id_without_replaying_a_new_job(self):
        self.start()
        ids = []
        def rpc(op, args, **kwargs):
            ids.append(args['script']['execution_id'])
            if len(ids) == 1:
                raise TimeoutError('rpc_timeout:script.execute')
            return {'verified': True, 'evidence': 'done'}
        self.agent.rpc = rpc
        with self.assertRaises(TimeoutError):
            self.agent.execute_script({'type': 'script', 'runtime': 'python', 'code': 'action', 'verify_code': 'readback'})
        self.assertIsNotNone(self.agent.task['pending_script'])
        self.assertTrue(self.agent.execute_script()['verified'])
        self.assertEqual(ids[0], ids[1])
        self.assertNotIn('pending_script', self.agent.task)

    def test_unverified_script_does_not_become_completion_evidence(self):
        self.start()
        self.agent.rpc = lambda *_args, **_kwargs: {'verified': False, 'exit_code': 0, 'stdout': 'done'}
        self.agent.execute_script({'type': 'script','runtime':'node','code':'action','verify_code':'readback'})
        self.assertIsNone(self.agent.task['script_evidence'])
        self.assertEqual(self.agent.task['receipts'][0]['outcome'], 'script_unverified')

    def test_large_chinese_script_outputs_fit_context_and_preserve_latest_verification(self):
        large = {'verified': True, 'evidence': '实际证据' * 6000, 'stdout': '输出' * 12000,
                 'stderr': '', 'verification': {'exit_code': 0, 'stdout': '重复证据' * 6000}}
        feedback = self.agent.script_feedback(large)
        payload = {'goal': '原始用户目标', 'observation': {**view(), 'ocr_text': '屏幕文字' * 6000},
                   'tool_results': [{'type':'script_result', **feedback} for _ in range(5)],
                   'memory_catalog': {'memories': '历史' * 6000}, 'receipts': [], 'user_answers': []}
        compact = self.agent.planning_context(payload)
        self.assertLessEqual(len(module.encode(compact).encode('utf8')), 22000)
        self.assertEqual(compact['goal'], payload['goal'])
        self.assertTrue(compact['tool_results'][-1]['verified'])
        self.assertTrue(compact['tool_results'][-1]['evidence'])
        self.assertEqual(len(payload['tool_results']), 5)  # full history is not mutated
        self.assertNotIn('stdout', feedback['verification'])

    def test_truncated_verification_requests_concise_readback_without_replaying_action(self):
        feedback = self.agent.script_feedback({'verified': False, 'exit_code': 0,
            'verification': {'exit_code': 0, 'truncated': True, 'stdout': 'provider metadata' * 5000}})
        self.assertTrue(feedback['verification']['truncated'])
        self.assertIn('Do not repeat the action', feedback['recovery'])
        self.assertIn('[string]', feedback['recovery'])
        self.assertLess(len(module.encode(feedback).encode()), 4000)

    def test_partial_input_is_unknown_and_never_retried(self):
        self.start()
        self.agent.hid.fail = True
        calls = self.tools()
        with self.assertRaises(module.UnknownInput):
            self.agent.execute_group([{'action': 'paste', 'target_id': 2, 'text': '中文'}], view())
        self.assertEqual(len(self.agent.hid.commands), 1)
        self.assertEqual(self.agent.task['receipts'][0]['outcome'], 'unknown')
        self.assertEqual(calls[-1][0], 'clipboard.finish')
        state = json.loads((self.agent.task['path'] / 'state.json').read_text(encoding='utf-8'))
        self.assertEqual(state['phase'], 'input_unknown')

    def test_unverified_paste_is_unknown_and_releases_clipboard(self):
        self.start()
        calls = self.tools(verified=False)
        with self.assertRaises(module.UnknownInput):
            self.agent.execute_group([{'action': 'paste', 'target_id': 2, 'text': '中文'}], view())
        self.assertEqual(calls[-1][0], 'clipboard.finish')

    def test_stop_prevents_any_input(self):
        self.start()
        self.tools()
        self.agent.accept({'type': 'task.stop', 'value': {'task_id': 'task1'}})
        with self.assertRaises(module.Cancelled):
            self.agent.execute_group([{'action': 'click', 'target_id': 2}], view())
        self.assertEqual(self.agent.hid.commands, [])

    def test_heartbeat_loss_stops_before_input(self):
        self.start()
        self.agent.heartbeat -= 4
        self.agent.cancel.wait = lambda _: True
        with self.assertRaises(module.Cancelled):
            self.agent.check()

    def test_scroll_ends_group_before_using_stale_targets(self):
        self.start()
        self.tools()
        self.agent.execute_group([{'action': 'scroll', 'target_id': 2, 'steps': 3},
                                  {'action': 'click', 'target_id': 2}], view())
        self.assertEqual(len(self.agent.hid.commands), 1)

    def test_cloud_actions_cannot_guess_coordinates_or_targets(self):
        self.start()
        self.agent.model = lambda *_: {'observation_id': 'obs1', 'actions': [
            {'action': 'click', 'target_id': 99}]}
        with self.assertRaisesRegex(ValueError, 'invalid_action'):
            self.agent.validate_cloud_group({'type': 'action_plan', 'observation_id': 'obs1',
                'actions': [{'action': 'click', 'target_id': 99}]}, view())

    def test_direct_cloud_plan_rejects_stale_observation(self):
        self.start()
        with self.assertRaisesRegex(ValueError, 'stale_observation'):
            self.agent.validate_cloud_group({'type': 'action_plan', 'observation_id': 'older',
                'actions': [{'action': 'click', 'target_id': 2}]}, view())
        self.assertEqual(self.agent.hid.commands, [])

    def test_natural_language_only_plan_does_not_fall_back_to_qwen(self):
        self.start()
        with self.assertRaisesRegex(ValueError, 'invalid_action_group'):
            self.agent.validate_cloud_group({'type': 'action_plan', 'observation_id': 'obs1',
                'instruction': 'Click the button'}, view())
        self.assertEqual(self.agent.hid.commands, [])

    def test_direct_cloud_coordinates_are_not_executable(self):
        self.start()
        with self.assertRaisesRegex(ValueError, 'invalid_action'):
            self.agent.validate_cloud_group({'type': 'action_plan', 'observation_id': 'obs1',
                'actions': [{'action': 'click', 'target_id': 2, 'x': 20, 'y': 20}]}, view())
        self.assertEqual(self.agent.hid.commands, [])

    def test_memory_tool_refresh_requires_a_new_cloud_plan_observation(self):
        self.start()
        observations = iter([view(), view('obs2'), view('obs3'), view('obs4')])
        self.agent.observe = lambda: next(observations)
        self.agent.mem = lambda *_: {'memories': []}
        responses = iter([{'type': 'memory.search', 'tags': ['app:notepad']},
            {'type': 'action_plan', 'observation_id': 'obs1', 'expected_text': 'Title',
             'actions': [{'action': 'click', 'target_id': 2}]},
            {'type': 'blocked', 'reason': 'test completed'},
            {'type': 'blocked', 'reason': 'test completed'}])
        sent = []
        self.agent.cloud = lambda _policy, payload: sent.append(payload) or next(responses)
        self.agent.wait_for_help = lambda _: (_ for _ in ()).throw(module.Cancelled())
        with self.assertRaises(module.Cancelled):
            self.agent.run_task()
        self.assertEqual(sent[2]['observation']['observation_id'], 'obs3')
        self.assertEqual(sent[1]['observation']['observation_id'], 'obs2')
        self.assertEqual(self.agent.hid.commands, [])

    def test_cloud_finish_without_evidence_is_rejected(self):
        self.start()
        self.agent.observe = lambda: view()
        self.agent.mem = lambda *_: {'memories': []}
        self.agent.cloud = lambda *_: {'type': 'finish', 'summary': 'Done'}
        original_emit = self.agent.emit
        def emit(packet):
            original_emit(packet)
            if packet['type'] == 'task.retry':
                self.agent.cancel.set()
        self.agent.emit = emit
        with self.assertRaises(module.Cancelled):
            self.agent.run_task()
        self.assertFalse(self.agent.task['verified'])

    def test_final_completion_cannot_reuse_stale_paste_evidence(self):
        self.start()
        self.agent.task['expected_text'] = 'Chinese outline'
        self.agent.task['verified_texts'] = ['Chinese outline']
        self.agent.task['receipts'] = [{'action': 'paste', 'outcome': 'input_sent'}]
        self.agent.observe = lambda: view(text='Chinese outline')
        self.agent.mem = lambda *_: {'memories': []}
        self.agent.cloud = lambda *_: {'type': 'finish', 'summary': 'Done'}
        self.agent.rpc = lambda *_args, **_kwargs: {'verified': False}
        original_emit = self.agent.emit
        def emit(packet):
            original_emit(packet)
            if packet['type'] == 'task.retry':
                self.agent.cancel.set()
        self.agent.emit = emit
        with self.assertRaises(module.Cancelled):
            self.agent.run_task()
        self.assertFalse(self.agent.task['verified'])

    def test_slot_released_before_terminal_callback_accepts_next_task(self):
        self.start()
        accepted = []
        def emit(packet):
            if packet['type'] == 'task.result':
                self.agent.start({'task_id': 'task2', 'goal': 'next explicit task'})
                accepted.append(self.agent.task['task_id'])
                self.agent.closed.set()
        self.agent.emit = emit
        self.agent.run_task = lambda: setattr(self.agent, 'terminal', {
            'task_id': 'task1', 'phase': 'completed', 'verified': True})
        worker = threading.Thread(target=self.agent.serve)
        worker.start()
        worker.join(2)
        self.agent.closed.set()
        self.assertEqual(accepted, ['task2'])

    def test_rpc_reply_correlation(self):
        def emit(packet):
            self.agent.accept({'type': 'reply', 'id': packet['id'], 'value': {'ok': True}})
        self.agent.emit = emit
        self.assertEqual(self.agent.rpc('test', {}), {'ok': True})

    def test_duplicate_json_rejected(self):
        with self.assertRaisesRegex(ValueError, 'duplicate_json_field'):
            module.parse('{"type":"finish","type":"action_plan"}')

    def test_known_hotkey_array_normalizes_without_inference_or_input(self):
        self.start()
        self.agent.model = lambda *_: {'observation_id': 'obs1', 'actions': [
            {'action': 'hotkey', 'target_id': 2, 'keys': ['ctrl', 'end']}]}
        self.assertEqual(self.agent.validate_cloud_group({'type': 'action_plan', 'observation_id': 'obs1',
            'actions': [{'action': 'hotkey', 'target_id': 2, 'keys': ['ctrl', 'end']}]}, view())[0]['keys'], 'CTRL+END')
        self.assertEqual(self.agent.hid.commands, [])

    def test_canonicalizer_rejects_conflicting_action_names(self):
        with self.assertRaisesRegex(ValueError, 'conflicting_action_fields'):
            module.canonical_action({'action': 'click', 'type': 'paste', 'target_id': 2})

    def test_cloud_literal_cannot_be_rewritten_by_action_payload(self):
        self.start()
        self.agent.model = lambda *_: {'observation_id': 'obs1', 'actions': [
            {'action': 'paste', 'target_id': 2, 'text': 'Paraphrased'}]}
        with self.assertRaisesRegex(ValueError, 'paste_literal_mismatch'):
            self.agent.validate_cloud_group({'type': 'action_plan', 'observation_id': 'obs1',
                'actions': [{'action': 'paste', 'target_id': 2, 'text': 'Paraphrased'}]}, view(), 'Exact original')

    def test_ocr_targets_are_available_alongside_uia(self):
        self.start()
        observed = view()
        observed['ocr_items'].append({'id': 7, 'text': 'Save'})
        self.agent.model = lambda *_: {'observation_id': 'obs1', 'actions': [
            {'action': 'click', 'target_id': 7}]}
        self.assertEqual(self.agent.validate_cloud_group({'type': 'action_plan', 'observation_id': 'obs1',
            'actions': [{'action': 'click', 'target_id': 7}]}, observed)[0]['target_id'], 7)

    def test_unknown_task_cannot_dispatch_another_group(self):
        self.start()
        self.agent.task['receipts'].append({'outcome': 'unknown'})
        with self.assertRaises(module.UnknownInput):
            self.agent.execute_group([{'action': 'click', 'target_id': 2}], view())

    def test_host_validation_must_explicitly_allow(self):
        self.start()
        self.agent.rpc = lambda *_: {'center': [20, 20], 'screen': [0, 0, 1920, 1080]}
        with self.assertRaisesRegex(ValueError, 'invalid_input_validation'):
            self.agent.execute_group([{'action': 'click', 'target_id': 2}], view())
        self.assertEqual(self.agent.hid.commands, [])

    def test_realistic_task_requires_observed_completion_before_memory(self):
        self.start()
        calls = self.tools()
        observations = iter([view(), view('obs3', 'Title\n中文大纲')])
        self.agent.observe = lambda: next(observations)
        self.agent.model = lambda *_: {'type': 'memory.set', 'key': 'procedure:outline',
            'kind': 'procedure', 'value': 'Append at end', 'tags': ['app:notepad'], 'summary': 'Outline'}
        responses = iter([
            {'type': 'action_plan', 'observation_id': 'obs1',
             'actions': [{'action': 'paste', 'target_id': 2, 'text_ref': 'cloud_text'}],
             'text': '\n中文大纲', 'expected_text': '中文大纲'},
            {'type': 'finish', 'summary': 'Observed outline'},
            {'type': 'memory.set', 'key': 'procedure:outline', 'kind': 'procedure',
             'value': 'Append at end', 'tags': ['app:notepad'], 'summary': 'Outline'}])
        cloud_calls = []
        self.agent.cloud = lambda *args: cloud_calls.append(args) or next(responses)
        writes = []
        self.agent.mem = lambda op, body: writes.append((op, body)) or (
            {'id': 'memory1'} if op == 'memory.set' else {'memories': []})
        self.agent.run_task()
        self.assertTrue(self.agent.task['verified'])
        self.wait_memory()
        self.assertEqual(len(cloud_calls), 2)
        feedback = cloud_calls[1][1]['tool_results'][-1]
        self.assertTrue(feedback['paste_verified'])
        self.assertIn('中文大纲', feedback['verified_text_excerpt'])
        self.assertEqual(writes[-1][0], 'memory.set')
        self.assertEqual(writes[-1][1]['source_task_id'], 'task1')
        self.assertEqual(self.agent.hid.commands, [{'action': 'hotkey', 'keys': 'CTRL+V'}])
        self.assertEqual(next(value for op, value in calls if op == 'input.validate')['observation_id'], 'obs1')
        self.assertEqual([e['value']['stage'] for e in self.events if e['type'] == 'model.timing'], ['memory_review'])
        self.assertTrue(any(event['type'] == 'cloud.action_group' for event in self.events))

    def test_nonwriting_task_requires_fresh_visible_result(self):
        self.start()
        calls = self.tools()
        observations = iter([view(text='Click pending'), view('after-click', 'CLICK VERIFIED')])
        self.agent.observe = lambda: next(observations)
        self.agent.mem = lambda *_: {'memories': []}
        replies = iter([
            {'type': 'action_plan', 'observation_id': 'obs1', 'text': '', 'expected_text': 'CLICK VERIFIED',
             'actions': [{'action': 'click', 'target_id': 2}]},
            {'type': 'finish', 'summary': 'Checked'}, {'type': 'finish', 'summary': 'No reusable memory'}])
        self.agent.cloud = lambda *_: next(replies)
        self.agent.run_task()
        self.assertTrue(self.agent.task['verified'])
        verify = next(value for op, value in calls if op == 'completion.verify')
        self.assertEqual(verify['evidence_mode'], 'visible_text')
        self.assertEqual(verify['observation_id'], 'after-click')

    def test_nonwriting_task_cannot_claim_preexisting_label_as_success(self):
        self.start()
        self.tools()
        self.agent.observe = lambda: view(text='Already visible')
        self.agent.mem = lambda *_: {'memories': []}
        replies = iter([
            {'type': 'action_plan', 'observation_id': 'obs1', 'expected_text': 'Already visible',
             'actions': [{'action': 'move', 'target_id': 2}]},
            {'type': 'finish', 'summary': 'Done'}])
        self.agent.cloud = lambda *_: next(replies)
        original_emit = self.agent.emit
        def emit(packet):
            original_emit(packet)
            if packet['type'] == 'task.retry':
                self.agent.cancel.set()
        self.agent.emit = emit
        with self.assertRaises(module.Cancelled):
            self.agent.run_task()
        self.assertFalse(self.agent.task['verified'])


if __name__ == '__main__':
    unittest.main()
