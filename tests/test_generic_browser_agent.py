import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('generic', Path(__file__).resolve().parents[1] / 'resources/rk-browser-agent.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class GenericBrowserTests(unittest.TestCase):
    def test_usb_keyboard_browser_shortcuts_are_allowed_but_run_dialog_is_not(self):
        for keys in ['CTRL+L', 'CTRL+A', 'ENTER', 'CTRL+T']:
            obj = self.fixture({'action': 'hotkey', 'observation_id': 'fresh', 'target_id': 7, 'keys': keys})
            self.assertEqual(obj.decision(obj.observe())['keys'], keys)
        obj = self.fixture({'action': 'hotkey', 'observation_id': 'fresh', 'target_id': 7, 'keys': 'WIN+R'})
        with self.assertRaisesRegex(ValueError, 'INVALID_HOTKEY'):
            obj.decision(obj.observe())

    def test_ocr_augments_control_without_granting_input_permission(self):
        targets = module.fuse_targets(
            [{'rect': [0, 0, 100, 50], 'role': 'Edit', 'occluded': False}],
            [{'rect': [10, 10, 90, 30], 'text': '地址栏'},
             {'rect': [200, 200, 260, 230], 'text': '未知按钮'}])
        self.assertEqual(targets[0]['ocr_text'], ['地址栏'])
        self.assertFalse(targets[0]['actionable'])
        self.assertFalse(targets[1]['actionable'])

    def fixture(self, response, **view):
        observation = {'observation_id': 'fresh', 'targets': [
            {'id': 7, 'source': 'uia', 'role': 'Edit', 'actionable': True, 'occluded': False}], **view}
        return module.BrowserAgent('用 Edge 打开爱奇艺主页', lambda s, c: json.dumps(response),
                                   lambda: observation, lambda a: {'state': 'input_sent'}, lambda r: None)

    def test_goal_does_not_require_a_site_template(self):
        command = {'action': 'fill', 'observation_id': 'fresh', 'target_id': 7, 'text': 'https://www.iqiyi.com/'}
        self.assertEqual(self.fixture(command).decision(self.fixture(command).observe()), command)

    def test_unknown_target_and_unverified_finish_reject(self):
        for command in [{'action': 'click', 'target_id': 8}, {'action': 'finish'}]:
            obj = self.fixture({**command, 'observation_id': 'fresh'})
            with self.assertRaises(ValueError):
                obj.decision(obj.observe())

    def test_unknown_input_latches_failure(self):
        obj = self.fixture({'action': 'click', 'target_id': 7, 'observation_id': 'fresh'})
        obj.execute = lambda action: {'state': 'unknown'}
        with self.assertRaises(ValueError):
            obj.run()
        with self.assertRaisesRegex(ValueError, 'INPUT_OUTCOME_UNKNOWN'):
            obj.decision({'observation_id': 'new', 'targets': []})

    def test_ocr_text_alone_cannot_authorize_fill(self):
        obj = self.fixture({'action': 'fill', 'observation_id': 'fresh', 'target_id': 7, 'text': 'abc'},
                           targets=[{'id': 7, 'source': 'ocr', 'role': 'Edit', 'actionable': True, 'occluded': False}])
        with self.assertRaisesRegex(ValueError, 'INVALID_FILL'):
            obj.decision(obj.observe())
