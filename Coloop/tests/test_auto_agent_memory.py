"""Feedback provenance checks with no board, model or external memory service."""
import importlib.util
import pathlib
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from unittest.mock import Mock

root = pathlib.Path(__file__).resolve().parents[1]
support_spec = importlib.util.spec_from_file_location('coloop_rk_support', root / 'resources/rk-proactive-agent.py')
support = importlib.util.module_from_spec(support_spec)
sys.modules['coloop_rk_support'] = support
support_spec.loader.exec_module(support)
spec = importlib.util.spec_from_file_location('auto_memory_worker', root / 'resources/rk-memory-worker.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FeedbackTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.calls = []
        self.model = Mock(side_effect=AssertionError('Feedback must not invoke inference'))
        self.memory = Mock()
        self.memory.call.side_effect = lambda body: self.calls.append(body) or {'id': str(len(self.calls))}
        self.worker = module.MemoryWorker(self.directory.name, lambda _: None,
                                         memory=self.memory, model=self.model, namespace='qa:feedback')

    def tearDown(self):
        self.worker.close()
        self.directory.cleanup()

    def value(self, **changes):
        body = {
            'feedback_id': '11111111-1111-4111-8111-111111111111',
            'source_task_id': '22222222-2222-4222-8222-222222222222',
            'decision_id': '', 'scope': 'future', 'workspace_scope': 'a' * 48,
            'rating': 'negative', 'source_quote': '以后先核验再报告完成。',
            'supersedes': '', 'created_at': '2026-11-06T12:00:00Z',
        }
        body.update(changes)
        return body

    def choice_value(self, **changes):
        body = {'source_task_id': '22222222-2222-4222-8222-222222222222', 'event_id': 'native-user-event',
                'workspace_scope': 'a' * 48, 'source_quote': '本次选择离线核验，然后继续。',
                'created_at': '2026-11-06T12:00:00Z', 'origin': 'user'}
        body.update(changes)
        return body

    def completed_receipts(self):
        with closing(sqlite3.connect(pathlib.Path(self.directory.name) / '.runtime/coloop-memory-provenance.sqlite3')) as db:
            return db.execute('SELECT COUNT(*) FROM receipts WHERE completed=1').fetchone()[0]

    def test_future_feedback_preserves_exact_human_source_without_preference_inference(self):
        quote = '甲' * 999 + '不' + '要' * 999 + '删' + '乙' * 1000 + '丙' * 1000
        result = self.worker.dispatch('memory.feedback', self.value(source_quote=quote))
        self.assertTrue(result['ok'])
        self.assertEqual(''.join(row['value'] for row in self.calls), quote)
        self.assertEqual(len(self.calls), 4)
        for index, row in enumerate(self.calls, 1):
            self.assertEqual(row['kind'], 'task')
            self.assertEqual(row['source'], 'user_feedback')
            self.assertFalse(row['verified'])
            self.assertIn('origin:direct-user', row['tags'])
            self.assertTrue(any(tag.startswith(f'fbmeta:negative:{index}:4:') for tag in row['tags']))
            self.assertTrue(row['key'].startswith('feedback:coloop:qa_'))
        self.model.assert_not_called()

    def test_same_feedback_id_is_idempotent_and_conflicting_original_is_rejected(self):
        body = self.value(supersedes='33333333-3333-4333-8333-333333333333',
                          decision_id='44444444-4444-4444-8444-444444444444')
        self.assertTrue(self.worker.dispatch('memory.feedback', body)['ok'])
        self.assertIn('supersedes:' + body['supersedes'], self.calls[0]['tags'])
        self.assertLessEqual(len(self.calls[0]['tags']), 8)
        self.assertTrue(self.worker.dispatch('memory.feedback', body)['result']['already_stored'])
        self.assertEqual(len(self.calls), 1)
        changed = dict(body, source_quote='不同原句不能覆盖同一反馈编号')
        self.assertEqual(self.worker.dispatch('memory.feedback', changed)['error'], 'MEMORY_SOURCE_ID_CONFLICT')
        self.assertEqual(len(self.calls), 1)

    def test_real_user_choice_is_a_traceable_case_and_never_a_preference(self):
        body = self.choice_value()
        self.assertTrue(self.worker.dispatch('memory.choice', body)['ok'])
        self.assertEqual(len(self.calls), 2)
        self.assertIn('native-user-event', self.calls[0]['value'])
        self.assertEqual(self.calls[1]['value'], body['source_quote'])
        self.assertTrue(all(row['kind'] == 'task' for row in self.calls))
        self.assertTrue(self.worker.dispatch('memory.choice', body)['result']['already_stored'])
        self.assertEqual(len(self.calls), 2)
        for patch in ({'origin': 'coloop'}, {'source_quote': '[Coloop Auto Agent Work:x] 继续'},
                      {'source_quote': 'api_key=secret-value'}):
            self.assertFalse(self.worker.dispatch('memory.choice', dict(body, **patch))['ok'])
        self.model.assert_not_called()

    def test_unsuccessful_fragment_acknowledgements_remain_retryable(self):
        acknowledgements = (
            None, {}, {'id': ''}, {'id': '   '}, {'id': 1},
            {'id': 'record', 'deferred': True}, {'id': 'record', 'saved': False},
            {'id': 'record', 'ok': False}, {'id': 'record', 'key': 'wrong-key'},
            {'id': 'record', 'error': 'private source text must never be returned'},
        )
        for operation, body in (('memory.feedback', self.value()), ('memory.choice', self.choice_value())):
            for acknowledgement in acknowledgements:
                with self.subTest(operation=operation, acknowledgement=acknowledgement):
                    self.memory.call.side_effect = lambda _: acknowledgement
                    result = self.worker.dispatch(operation, body)
                    self.assertFalse(result['ok'])
                    self.assertIn(result['error'], ('MEMORY_WRITE_DEFERRED', 'MEMORY_WRITE_UNACKNOWLEDGED'))
                    self.assertEqual(self.completed_receipts(), 0)
        self.model.assert_not_called()

    def test_storage_exception_does_not_expose_source_or_complete_receipt(self):
        for operation, body in (('memory.feedback', self.value()), ('memory.choice', self.choice_value())):
            for exception in (ValueError('private source text'), OSError('private storage location')):
                with self.subTest(operation=operation, exception=type(exception).__name__):
                    self.memory.call.side_effect = exception
                    self.assertEqual(self.worker.dispatch(operation, body),
                                     {'ok': False, 'error': 'MEMORY_WRITE_FAILED'})
                    self.assertEqual(self.completed_receipts(), 0)

    def test_partial_write_retries_same_fragments_after_restart_and_acknowledged_retry_stays_noop(self):
        for operation, body in (
                ('memory.feedback', self.value(source_quote='甲' * 999 + '不' + '要' * 1000)),
                ('memory.choice', self.choice_value(source_quote='乙' * 999 + '不' + '要' * 1000))):
            with self.subTest(operation=operation):
                records, attempts = {}, []
                fail_last_fragment = True

                def write(fragment):
                    attempts.append(dict(fragment))
                    if fail_last_fragment and fragment['key'].endswith(':2'):
                        return {'deferred': True}
                    identifier = 'record-' + str(len(records) + 1)
                    records[fragment['key']] = dict(fragment)
                    return {'id': identifier, 'key': fragment['key'], 'saved': True}

                self.memory.call.side_effect = write
                self.assertEqual(self.worker.dispatch(operation, body),
                                 {'ok': False, 'error': 'MEMORY_WRITE_DEFERRED'})
                original_attempts = list(attempts)
                self.assertEqual(len(records), len(attempts) - 1)
                self.worker.close()
                self.worker = module.MemoryWorker(self.directory.name, lambda _: None,
                                                 memory=self.memory, model=self.model, namespace='qa:feedback')
                fail_last_fragment = False
                result = self.worker.dispatch(operation, body)
                self.assertTrue(result['ok'])
                self.assertEqual(result['result']['records'], len(records))
                self.assertEqual(attempts[len(original_attempts):], original_attempts)
                count = len(attempts)
                records.clear()
                self.assertTrue(self.worker.dispatch(operation, body)['result']['already_stored'])
                self.assertEqual(len(attempts), count)
                self.assertEqual(records, {})
        self.model.assert_not_called()

    def test_task_scope_and_forged_model_fields_are_not_accepted_by_the_memory_operation(self):
        self.assertFalse(self.worker.dispatch('memory.feedback', self.value(scope='task'))['ok'])
        self.assertFalse(self.worker.dispatch('memory.feedback', self.value(model_preference='invented'))['ok'])
        self.assertEqual(self.calls, [])

    def test_rating_without_reason_does_not_invent_a_specific_preference(self):
        self.assertTrue(self.worker.dispatch('memory.feedback', self.value(source_quote=''))['ok'])
        self.assertIn('未提供具体原因', self.calls[0]['value'])
        self.assertEqual(self.calls[0]['kind'], 'task')
        self.model.assert_not_called()


if __name__ == '__main__':
    unittest.main()
