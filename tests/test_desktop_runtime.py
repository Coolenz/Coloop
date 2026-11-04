"""CPU tests for the board loop. No model, Windows input or real board involved."""
import importlib.util
from pathlib import Path
import threading
import time
import unittest

spec = importlib.util.spec_from_file_location(
    'desktop_runtime', Path(__file__).resolve().parents[1] / 'resources/desktop-runtime.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RuntimeTests(unittest.TestCase):
    def test_fill_keeps_observed_pointer_id_and_keyboard_requests_have_only_native_fields(self):
        calls, events = [], []
        class InstalledHID:
            def execute(self, action, validated):
                if action['action'] == 'click':
                    self_fields = {'action', 'target_id'}
                elif action['action'] == 'hotkey':
                    self_fields = {'action', 'keys'}
                else:
                    self_fields = {'action', 'text'}
                if set(action) != self_fields:
                    raise ValueError('Invalid native action')
                calls.append(action)
        module.execute_hid_action(InstalledHID(), {'action': 'fill', 'target_id': 7, 'text': '0012'},
                                  {}, lambda: events.append('check'), lambda: events.append('focus'),
                                  lambda _: None)
        self.assertEqual(calls, [{'action': 'click', 'target_id': 7},
                                {'action': 'hotkey', 'keys': 'CTRL+A'},
                                {'action': 'type', 'text': '0012'}])
        self.assertIn('focus', events)
        calls.clear()
        module.execute_hid_action(InstalledHID(), {'action': 'hotkey', 'target_id': 7, 'keys': 'ENTER'},
                                  {}, lambda: None, lambda: None, lambda _: None)
        self.assertEqual(calls, [{'action': 'hotkey', 'keys': 'ENTER'}])

    def test_installed_sender_report_guard_and_release_contract_is_preserved(self):
        sent, guards, releases = [], [], []
        class InstalledHID:
            @staticmethod
            def send(path, reports, neutral, check=None):
                try:
                    for report in reports:
                        if check:
                            check(report)
                        sent.append((path, report))
                finally:
                    releases.append(neutral)
            def execute(self, action, validated, check=None):
                self.send('native-device', [b'input'], b'neutral', check)
        controller = module.interruptible_hid(InstalledHID, lambda: guards.append('cancel'))
        controller.execute({}, {}, lambda report: guards.append(report))
        self.assertEqual(sent, [('native-device', b'input')])
        self.assertEqual(guards, ['cancel', b'input'])
        self.assertEqual(releases, [b'neutral'])

    def test_report_cancellation_does_not_replace_native_cleanup(self):
        sent, released = [], []
        class InstalledHID:
            @staticmethod
            def send(path, reports, neutral, check=None):
                try:
                    check(reports[0])
                    sent.append(reports[0])
                finally:
                    released.append(neutral)
        def stop():
            raise module.Stopped()
        controller = module.interruptible_hid(InstalledHID, stop)
        with self.assertRaises(module.Stopped):
            controller.send('native-device', [b'input'], b'neutral')
        self.assertEqual(sent, [])
        self.assertEqual(released, [b'neutral'])

    def setUp(self):
        self.events, self.inputs = [], []
        self.runtime = module.Runtime(self.events.append, lambda *args: self.inputs.append(args))
        self.config = {'goal': 'type the code then Apply', 'expectedText': 'Applied: 0032',
                       'authorizeInput': True, 'planner': 'rk', 'maxSteps': 2,
                       'observerSession': 'current-session'}
        self.observed = {'observation_id': 'abcdef012345', 'window_open': True,
                         'targets': [{'id': 1, 'name': 'Input', 'type': 'Edit', 'source': 'uia'},
                                     {'id': 2, 'name': 'Apply', 'type': 'Button', 'source': 'uia'}]}
        self.plan = {'observation_id': 'abcdef012345', 'actions': [
            {'action': 'fill', 'target_id': 1, 'text': '0032'},
            {'action': 'click', 'target_id': 2}]}

    def test_model_finish_is_not_completion(self):
        def rpc(op, _value=None):
            return self.observed if op == 'observe' else {
                'actions': [{'action': 'finish'}], 'observation_id': self.observed['observation_id']}
        self.runtime.rpc = rpc
        self.runtime.run(self.config)
        self.assertEqual(self.events[-1]['error'], 'DESKTOP_RESULT_NOT_VERIFIED')
        self.assertFalse(self.inputs)

    def test_auto_planner_uses_the_same_observation_and_result_boundary(self):
        self.config['planner'] = 'auto'
        self.runtime.rpc = lambda *_: {**self.observed, 'targets': [{'name': 'Applied: 0032'}]}
        self.runtime.run(self.config)
        self.assertEqual(self.events[-1]['error'], 'DESKTOP_RESULT_ALREADY_VISIBLE')
        self.assertFalse(self.inputs)

    def test_stale_plan_never_reaches_input(self):
        self.runtime.rpc = lambda op, _value=None: self.observed if op == 'observe' else {
            **self.plan, 'observation_id': '111111111111'}
        self.runtime.run(self.config)
        self.assertEqual(self.events[-1]['error'], 'STALE_DESKTOP_OBSERVATION')
        self.assertFalse(self.inputs)

    def test_changed_session_blocks_input(self):
        def rpc(op, _value=None):
            return {'observe': self.observed,
                    'plan': self.plan,
                    'validate_batch': {'session_id': 'another-session'}}[op]
        self.runtime.rpc = rpc
        self.runtime.run(self.config)
        self.assertEqual(self.events[-1]['error'], 'DESKTOP_SESSION_CHANGED')
        self.assertFalse(self.inputs)

    def test_same_page_batch_plans_once_executes_twice_and_only_then_reobserves(self):
        calls = []
        observations = iter([self.observed, {**self.observed,
            'targets': [{'id': 2, 'name': 'Applied: 0032', 'type': 'Text'}]}])
        def rpc(op, _value=None):
            calls.append(op)
            if op == 'observe':
                return next(observations)
            if op == 'plan':
                return self.plan
            return {'session_id': 'current-session', 'batch_id': 'batch'}
        self.runtime.rpc = rpc
        self.runtime.run(self.config)
        self.assertEqual(len(self.inputs), 2)
        self.assertEqual(self.events[-1]['phase'], 'completed')
        self.assertEqual(calls, ['observe', 'plan', 'validate_batch', 'validate_next', 'validate_next', 'observe'])
        self.assertEqual(self.runtime.steps, 1)
        self.assertEqual(sum(event['phase'] == 'executing' for event in self.events), 1)

    def test_invalid_last_action_blocks_entire_batch_before_input(self):
        plan = {**self.plan, 'actions': [self.plan['actions'][0], {'action': 'click', 'target_id': 999}]}
        self.runtime.rpc = lambda op, _value=None: self.observed if op == 'observe' else plan
        self.runtime.run(self.config)
        self.assertEqual(self.events[-1]['error'], 'UNKNOWN_DESKTOP_TARGET')
        self.assertFalse(self.inputs)

    def test_stop_between_actions_prevents_remaining_batch(self):
        def rpc(op, _value=None):
            if op == 'observe':
                return self.observed
            if op == 'plan':
                return self.plan
            return {'session_id': 'current-session', 'batch_id': 'batch'}
        self.runtime.rpc = rpc
        def execute(*args):
            self.inputs.append(args)
            self.runtime.stop.set()
        self.runtime.execute = execute
        self.runtime.run(self.config)
        self.assertEqual(len(self.inputs), 1)
        self.assertEqual(self.events[-1]['phase'], 'cancelled')

    def test_existing_result_does_not_falsely_complete_new_task(self):
        self.runtime.rpc = lambda *_: {**self.observed, 'targets': [{'name': 'Applied: 0032'}]}
        self.runtime.run(self.config)
        self.assertEqual(self.events[-1]['error'], 'DESKTOP_RESULT_ALREADY_VISIBLE')
        self.assertFalse(self.inputs)

    def test_stop_interrupts_pending_planning_and_discards_late_reply(self):
        result = []
        thread = threading.Thread(target=lambda: self._wait_for_plan(result))
        thread.start()
        while not self.events:
            time.sleep(0.005)
        self.runtime.accept({'type': 'stop'})
        thread.join(1)
        self.assertFalse(thread.is_alive())
        self.assertEqual(result, ['stopped'])
        self.runtime.accept({'type': 'reply', 'id': self.events[0]['id'], 'value': {'action': 'type'}})
        self.assertFalse(self.inputs)

    def _wait_for_plan(self, result):
        try:
            self.runtime.rpc('plan', {'observation': {}})
        except module.Stopped:
            result.append('stopped')

    def test_heartbeat_expiry_revokes_execution(self):
        self.runtime.last_heartbeat = self.runtime.clock() - 13
        self.runtime.run(self.config)
        self.assertEqual(self.events[-1]['phase'], 'cancelled')
        self.assertFalse(self.inputs)

    def test_non_ascii_or_extra_fields_cannot_execute(self):
        for action in [
            {'action': 'fill', 'target_id': 1, 'text': '\u4e2d\u6587'},
            {'action': 'click', 'target_id': 1, 'shell': 'ignored'},
        ]:
            with self.assertRaises(ValueError):
                module.Runtime.validate({'observation_id': 'abcdef012345', 'actions': [action]}, self.observed)


if __name__ == '__main__':
    unittest.main()
