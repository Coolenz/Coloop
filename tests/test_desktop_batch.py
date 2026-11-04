"""UIA-only batch guards using independent fake window facts; no native input."""
import copy
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import time
import unittest

spec = importlib.util.spec_from_file_location(
    'desktop_observer', Path(__file__).resolve().parents[1] / 'resources/desktop-observer.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class BatchTests(unittest.TestCase):
    def setUp(self):
        self.frame = {'_handle': 1, 'rect': [0, 0, 800, 600], 'screen': [0, 0, 1920, 1080],
                      '_focus': 'edit', '_focus_type': 'Edit',
                      'targets': [{'id': 1, '_runtime_id': 'edit', 'source': 'uia', 'name': 'Input',
                                   'type': 'Edit', 'rect': [10, 10, 100, 40], 'enabled': True},
                                  {'id': 2, '_runtime_id': 'button', 'source': 'uia', 'name': 'Confirm',
                                   'type': 'Button', 'rect': [110, 10, 200, 40], 'enabled': True}]}
        old = {**copy.deepcopy(self.frame), 'observation_id': 'abcdef012345',
               '_consumed': False, '_at': time.monotonic()}
        self.engine = object()
        self.fast_calls = 0
        self.observer = SimpleNamespace(ocr=self.engine, registry=SimpleNamespace(
            latest=old, ttl=90, session_id='session'))
        def snapshot():
            self.assertIsNone(self.observer.ocr, 'intermediate checks must never run OCR')
            self.fast_calls += 1
            return copy.deepcopy(self.frame)
        self.observer.snapshot = snapshot
        self.guard = module.BatchObserver(self.observer)
        self.plan = {'observation_id': 'abcdef012345', 'actions': [
            {'action': 'fill', 'target_id': 1, 'text': '0032'}, {'action': 'click', 'target_id': 2}]}

    def prepare(self):
        return self.guard.call('validate_batch', self.plan)['batch_id']

    def test_no_intermediate_ocr_and_value_changes_do_not_invalidate_button(self):
        batch = self.prepare()
        self.guard.call('validate_next', {'batch_id': batch, 'index': 0})
        self.guard.call('validate_focus', {'batch_id': batch, 'index': 0})
        self.frame['targets'][0]['value'] = '0032'
        self.guard.call('validate_next', {'batch_id': batch, 'index': 1})
        self.assertEqual(self.fast_calls, 4)
        self.assertIs(self.observer.ocr, self.engine)

    def test_replayed_action_invalidates_batch(self):
        batch = self.prepare()
        self.guard.call('validate_next', {'batch_id': batch, 'index': 0})
        with self.assertRaises(ValueError):
            self.guard.call('validate_next', {'batch_id': batch, 'index': 0})
        self.assertIsNone(self.guard.batch)

    def test_navigation_or_changed_control_stops_next_action(self):
        batch = self.prepare()
        self.guard.call('validate_next', {'batch_id': batch, 'index': 0})
        self.frame['targets'][1]['_runtime_id'] = 'new-page-button'
        with self.assertRaises(ValueError):
            self.guard.call('validate_next', {'batch_id': batch, 'index': 1})

    def test_wrong_focus_blocks_fill(self):
        batch = self.prepare()
        self.guard.call('validate_next', {'batch_id': batch, 'index': 0})
        self.frame['_focus'] = 'another-control'
        with self.assertRaises(ValueError):
            self.guard.call('validate_focus', {'batch_id': batch, 'index': 0})
        self.assertIsNone(self.guard.batch)

    def test_partial_invalid_batch_is_not_reserved(self):
        self.plan['actions'][1]['target_id'] = 99
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertFalse(self.observer.registry.latest['_consumed'])


if __name__ == '__main__':
    unittest.main()
