"""RK Agent/runtime integration with synthetic observations and a fake HID controller."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).resolve().parents[1] / 'resources' / file)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


agent = module('state_agent', 'rk-cloud-agent.py')
runtime = module('state_runtime', 'browser-runtime.py')


class Memory:
    def __init__(self):
        self.calls = []

    def request(self, path, body, timeout):
        self.calls.append((path, body))
        if path != '/call':
            return {'ready': True}
        if body['op'] == 'get':
            return {'memory': None}
        return {'id': 'fixture-memory', 'source': 'agent', 'verified': 0, **body}


class AgentRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.events, self.memory = [], Memory()
        self.controller = Mock()
        self.r = runtime.BrowserRuntime(self.events.append, self.controller, root=self.root)
        self.r.stop.wait = Mock()
        self.r.check = lambda: None
        self.a = agent.RKCloudAgent(self.root, '打开 Bilibili', 'home', 'f' * 32,
                                    self.transport, self.events.append, self.r.timed, self.r.check,
                                    memory=self.memory)
        self.r.agent = self.a
        self.addCleanup(self.a.close)
        self.a.call('plan', {})

    def transport(self, system, content):
        data = json.loads(content)
        if data.get('stage') == 'plan':
            return json.dumps(data['requestedPlan'])
        return json.dumps({'summary': '合成观察与模拟输入闭环已核对，未操作真实网页。',
                           'lessons': ['实际输入必须另行做硬件验证。']}, ensure_ascii=False)

    def view(self, observation_id='fresh'):
        return {'observation_id': observation_id, 'phase': 'home_tab', 'foreground': True,
                'browser_handle': 100, 'browser_pid': 200,
                'targets': [{'id': 0, 'name': 'Home', 'role': 'home_tab'}]}

    def permit(self):
        return {'token': 'permit', 'action': {'action': 'click', 'target_id': 0}}

    def test_checkpoint_is_dispatching_before_controller_and_receipt_after_both_guards(self):
        def execute(action, permit, guard):
            state = json.loads((self.a.directory / 'state.json').read_text(encoding='utf-8'))
            self.assertEqual(state['pending_input']['status'], 'dispatching')
            guard(b'move')
            guard(b'press')
        self.controller.execute.side_effect = execute
        self.r._rpc = Mock(side_effect=[self.permit(), {'valid': True}, {'valid': True}])
        view = self.view()
        receipts = []
        self.r.click_interaction(view, self.a.call('act', view), receipts)
        self.assertEqual(receipts, self.a.receipts)
        self.assertEqual(receipts[0]['observation_id'], 'fresh')
        self.assertIsNone(self.a.pending_input)
        self.assertEqual(self.r.metrics['uiaChecks'], 2)
        self.assertEqual(self.r.metrics['actions'], 1)

    def test_permit_rejection_records_not_sent_then_only_executes_new_observation(self):
        fresh = self.view('new')
        self.r.observe_interaction = Mock(return_value=fresh)
        self.r._rpc = Mock(side_effect=[ValueError('RELAY_TARGET_CHANGED'), fresh, self.permit()])
        old = self.view('old')
        self.r.click_interaction(old, self.a.call('act', old), [])
        self.assertEqual(self.controller.execute.call_count, 1)
        self.assertEqual([row['outcome'] for row in self.a.history], ['not_sent', 'input_sent'])
        self.assertEqual(self.a.receipts[0]['observation_id'], 'new')

    def test_partial_input_is_unknown_and_cannot_be_retried_or_written_to_memory(self):
        def fail(action, permit, guard):
            guard(b'move')
            raise OSError('USB fixture disconnect')
        self.controller.execute.side_effect = fail
        self.r._rpc = Mock(side_effect=[self.permit(), {'valid': True}])
        view = self.view()
        with self.assertRaises(OSError):
            self.r.click_interaction(view, self.a.call('act', view), [])
        with self.assertRaisesRegex(ValueError, 'ACTION_NOT_READY'):
            self.a.call('act', self.view('another'))
        self.r.phase('failed', 'DESKTOP_INPUT_OUTCOME_UNKNOWN')
        state = json.loads((self.a.directory / 'state.json').read_text(encoding='utf-8'))
        self.assertTrue(state['unknown_input'])
        self.assertFalse(state['memory_saved'])
        self.assertEqual(self.controller.execute.call_count, 1)

    def test_journal_failure_stops_before_hid_and_still_emits_terminal_and_releases_lease(self):
        view = self.view()
        command = self.a.call('act', view)
        self.r._rpc = Mock(return_value=self.permit())
        with patch.object(self.a, 'checkpoint', side_effect=OSError('disk fixture full')):
            with self.assertRaises(OSError):
                self.r.click_interaction(view, command, [])
            self.r.phase('failed', 'AGENT_JOURNAL_FAILURE')
        self.controller.execute.assert_not_called()
        self.assertEqual(self.events[-1]['phase'], 'failed')
        self.assertFalse(self.a.leased)

    def test_full_home_loop_uses_inprocess_agent_with_no_host_relay_and_saves_provenance(self):
        self.a.close()
        events, memory = [], Memory()
        obj = runtime.BrowserRuntime(events.append, Mock(), root=self.root)
        obj.stop.wait = Mock()
        obj.check = lambda: None
        operations = []
        def rpc(op, body=None):
            operations.append(op)
            if op == 'cloud_transport':
                return self.transport(body['system'], body['content'])
            if op == 'observe':
                return {}
            if op == 'mouse_observe':
                phase = body['phase']
                return {'observation_id': phase, 'phase': phase, 'foreground': phase != 'open_chrome',
                        'browser_handle': 100, 'browser_pid': 200,
                        'targets': [{'id': 0, 'name': phase,
                                     'role': 'chrome_icon' if phase == 'open_chrome' else phase}]}
            if op == 'mouse_permit':
                return self.permit()
            if op == 'verify':
                return {'verified': True, 'input_mode': 'mouse_same_window', 'browser_handle': 100,
                        'browser_pid': 200, 'address': 'https://www.bilibili.com',
                        'evidence_scope': 'synthetic_observation_fake_hid'}
            raise AssertionError(op)
        obj._rpc = rpc
        def factory(*args, **kwargs):
            return agent.RKCloudAgent(*args, **kwargs, memory=memory)
        with patch.dict(sys.modules, {'rk_cloud_agent': types.SimpleNamespace(RKCloudAgent=factory)}):
            obj.run({'authorizeInput': True, 'planner': 'cloud-hid', 'windowTitle': 'Chrome → Bilibili',
                     'agentLocation': 'rk', 'goal': '打开 Bilibili', 'browserTask': 'home', 'maxSteps': 4})
        self.assertEqual(events[-1]['phase'], 'completed')
        self.assertEqual(obj.controller.execute.call_count, 2)
        self.assertEqual(operations.count('cloud_transport'), 2)
        self.assertFalse(any(op.startswith('relay_') for op in operations))
        state = json.loads((obj.agent.directory / 'state.json').read_text(encoding='utf-8'))
        self.assertTrue(state['business_verified'] and state['memory_saved'])
        self.assertEqual(state['status'], 'completed')


if __name__ == '__main__':
    unittest.main()
