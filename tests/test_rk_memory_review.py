"""Isolated durable memory outbox checks. No board, model or Mem0 connection."""
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
import subprocess
import sys
import contextlib
import io
import sqlite3
from types import SimpleNamespace
from unittest.mock import Mock, patch


spec = importlib.util.spec_from_file_location('rk_memory_review',
    Path(__file__).resolve().parents[1] / 'resources/rk-proactive-agent.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def job(task_id='task1'):
    return {'task_id': task_id, 'goal': 'Append outline', 'verified': True,
            'result': 'Outline observed', 'receipts': [{'action': 'paste', 'outcome': 'input_sent'}]}


def proposal():
    return {'type': 'memory.set', 'key': 'procedure:existing-user-record',
            'kind': 'procedure', 'value': 'Preserve the title before appending an outline.',
            'tags': ['app:editor'], 'summary': 'Append an outline'}


class MemoryReviewTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.queues = []
        self.events = []

    def tearDown(self):
        for queue in self.queues:
            queue.close(2)
        self.directory.cleanup()

    def queue(self, namespace='production', infer=None, memory=None, events=None):
        event_target = self.events if events is None else events
        queue = module.MemoryReviewQueue(self.directory.name, namespace,
            infer or (lambda *_: proposal()), memory or (lambda *_: {'id': 'memory1'}),
            lambda kind, **value: event_target.append({'type': kind, **value}))
        self.queues.append(queue)
        return queue

    def wait_status(self, queue, task_id, status):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            row = queue.status(task_id)
            if row and row['status'] == status:
                return row
            time.sleep(.01)
        self.fail(f'{task_id} did not reach {status}: {queue.status(task_id)}')

    def test_shutdown_retains_validated_proposal_for_restart_without_model_replay(self):
        entered, release = threading.Event(), threading.Event()
        calls, writes = [], []

        def infer(*_):
            calls.append('model')
            entered.set()
            release.wait(2)
            return proposal()

        first = self.queue(infer=infer)
        first.enqueue(job())
        self.assertTrue(entered.wait(1))
        first.close(.01)
        release.set()
        first.worker.join(2)
        self.wait_status(first, 'task1', 'pending')

        def no_model(*_):
            raise AssertionError('Cached proposal must not invoke the model again')

        second = self.queue(infer=no_model, memory=lambda _, body: writes.append(body) or {'id': 'saved1'})
        self.wait_status(second, 'task1', 'saved')
        self.assertEqual(calls, ['model'])
        self.assertEqual(len(writes), 1)
        self.assertEqual(writes[0]['source_task_id'], 'task1')

    def test_process_crash_releases_writer_lock_and_recovers_running_job(self):
        source = '''import importlib.util, pathlib, sys, time
spec = importlib.util.spec_from_file_location('runtime', sys.argv[1])
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)
def infer(*args):
    pathlib.Path(sys.argv[2], 'model-started').write_text('ready')
    time.sleep(60)
queue = runtime.MemoryReviewQueue(sys.argv[2], 'production', infer, lambda *args: None, lambda *args, **kwargs: None)
queue.enqueue({'task_id':'task1', 'verified':True, 'goal':'Append', 'result':'Verified', 'receipts':[]})
time.sleep(60)
'''
        process = subprocess.Popen([sys.executable, '-c', source, str(Path(module.__file__)),
                                    self.directory.name], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        try:
            deadline = time.monotonic() + 5
            while not (Path(self.directory.name) / 'model-started').exists():
                if process.poll() is not None or time.monotonic() >= deadline:
                    self.fail('Child did not start its persisted memory job')
                time.sleep(.01)
        finally:
            process.terminate()
            process.wait(5)
            process.stderr.close()
        restored = self.queue()
        self.wait_status(restored, 'task1', 'saved')

    def test_uncertain_write_retries_identical_key_and_proposal(self):
        writes = []
        first = self.queue(memory=lambda _, body: writes.append(body) or {'id': 'saved1'})
        first.enqueue(job())
        self.wait_status(first, 'task1', 'saved')
        first.close()
        # Model process died after storage committed, before queue acknowledgement.
        with first.connect() as db:
            db.execute("UPDATE jobs SET status='running',memory_id=NULL WHERE task_id='task1'")
            db.commit()
        second = self.queue(infer=lambda *_: self.fail('Unexpected reinference'),
                            memory=lambda _, body: writes.append(body) or {'id': 'saved1'})
        self.wait_status(second, 'task1', 'saved')
        self.assertEqual(writes[0], writes[1])
        self.assertNotEqual(writes[0]['key'], proposal()['key'])
        self.assertFalse(writes[0]['verified'])
        self.assertEqual(writes[0]['source'], 'agent')

    def test_two_runtimes_share_one_writer_and_duplicate_enqueue_is_idempotent(self):
        entered, release = threading.Event(), threading.Event()
        active, maximum, calls = 0, 0, []
        guard = threading.Lock()

        def infer(_stage, _policy, value, _tokens):
            nonlocal active, maximum
            with guard:
                active += 1
                maximum = max(maximum, active)
                calls.append(value['task_id'])
            entered.set()
            release.wait(2)
            with guard:
                active -= 1
            return proposal()

        first, second = self.queue(infer=infer), self.queue(infer=infer)
        first.enqueue(job('task1'))
        self.assertTrue(entered.wait(1))
        second.enqueue(job('task1'))
        second.enqueue(job('task2'))
        release.set()
        self.wait_status(first, 'task1', 'saved')
        self.wait_status(first, 'task2', 'saved')
        self.assertEqual(maximum, 1)
        self.assertCountEqual(calls, ['task1', 'task2'])

    def test_saved_task_rejects_changed_evidence_and_accepts_reordered_retry(self):
        calls, writes = [], []
        queue = self.queue(infer=lambda *args: calls.append(args) or proposal(),
                           memory=lambda _, value: writes.append(value) or {'id': 'memory1'})
        original = job()
        queue.enqueue(original)
        self.wait_status(queue, 'task1', 'saved')
        reordered = dict(reversed(list(original.items())))
        reordered['receipts'] = [dict(reversed(list(original['receipts'][0].items())))]
        queue.enqueue(reordered)
        for changes in ({'goal': 'Replace the title'}, {'result': 'Different result'},
                        {'receipts': [{'action': 'paste', 'outcome': 'effect_verified'}]}):
            with self.subTest(changes=changes), self.assertRaisesRegex(ValueError, 'memory_task_conflict'):
                queue.enqueue({**original, **changes})
        with queue.connect() as db:
            stored = db.execute("SELECT job FROM jobs WHERE task_id='task1'").fetchone()
        self.assertEqual(module.parse(stored['job']), original)
        self.assertEqual(queue.status('task1')['status'], 'saved')
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(writes), 1)

    def test_pending_task_rejects_changed_evidence_without_replacing_queued_job(self):
        entered, release = threading.Event(), threading.Event()
        calls = []

        def infer(_stage, _policy, value, _tokens):
            calls.append(value)
            entered.set()
            release.wait(2)
            return proposal()

        queue = self.queue(infer=infer)
        queue.enqueue(job('task1'))
        try:
            self.assertTrue(entered.wait(1))
            original = job('task2')
            queue.enqueue(original)
            self.assertEqual(queue.status('task2')['status'], 'pending')
            queue.enqueue(dict(reversed(list(original.items()))))
            with self.assertRaisesRegex(ValueError, 'memory_task_conflict'):
                queue.enqueue({**original, 'verified_texts': ['Different text']})
        finally:
            release.set()
        self.wait_status(queue, 'task2', 'saved')
        self.assertEqual([value['task_id'] for value in calls], ['task1', 'task2'])
        self.assertEqual(calls[1], original)

    def test_namespaces_cannot_recover_each_others_pending_jobs(self):
        production = self.queue()
        production.close()
        with production.connect() as db:
            db.execute("INSERT INTO jobs(task_id,job,status,created) VALUES(?,?,'pending',?)",
                       ('task1', module.encode(job()), time.time()))
            db.commit()
        qa = self.queue(namespace='qa:run1', infer=lambda *_: self.fail('QA read production work'))
        self.assertIsNone(qa.status('task1'))
        self.assertNotEqual(production.database, qa.database)
        restored = self.queue()
        self.wait_status(restored, 'task1', 'saved')

    def test_legacy_unscoped_jobs_require_review_instead_of_writing_production(self):
        path = Path(self.directory.name) / 'logs/coloop-proactive/old/memory-review.json'
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps({'status': 'pending', 'job': job()}), encoding='utf-8')
        queue = self.queue(infer=lambda *_: self.fail('Legacy QA scope is unknown'))
        status = self.wait_status(queue, 'task1', 'needs_review')
        self.assertEqual(status['last_error'], 'legacy_scope_unknown')
        self.assertEqual(json.loads(path.read_text())['status'], 'pending')

    def test_truthy_failed_storage_replies_are_not_success(self):
        for index, ack in enumerate(({'id': 'm1', 'error': 'busy'}, {'id': 'm1', 'saved': False},
                                     {'id': 'm1', 'key': 'unexpected'}, True)):
            with self.subTest(ack=ack):
                queue = self.queue(namespace=f'ack:{index}', memory=lambda *_, reply=ack: reply)
                queue.MAX_FAILURES = 1
                queue.enqueue(job())
                status = self.wait_status(queue, 'task1', 'failed')
                self.assertEqual(status['last_error'], 'memory_save_unacknowledged')

    def test_model_cannot_supply_authority_fields_or_change_memory_kind(self):
        queue = self.queue()
        for extension in ({'verified': True}, {'source': 'user'}, {'ttl': 1},
                          {'source_task_id': 'another'}, {'kind': 'preference'}):
            with self.subTest(extension=extension), self.assertRaisesRegex(ValueError, 'invalid_memory_proposal'):
                queue.validate_proposal({**proposal(), **extension}, 'task1')
        self.assertNotEqual(queue.validate_proposal(proposal(), 'task1')['key'],
                            queue.validate_proposal(proposal(), 'task2')['key'])

    def test_no_reusable_memory_is_skipped_and_does_not_touch_storage(self):
        queue = self.queue(infer=lambda *_: {'type': 'finish', 'summary': 'Nothing reusable'},
                           memory=lambda *_: self.fail('Skipped review cannot write memory'))
        queue.enqueue(job())
        self.wait_status(queue, 'task1', 'skipped')
        queue.close()
        self.assertTrue(any(e['type'] == 'memory.saved' and e['status'] == 'skipped'
                            and e['saved'] is False for e in self.events))

    def test_unverified_jobs_are_rejected_before_persistence(self):
        queue = self.queue()
        with self.assertRaisesRegex(ValueError, 'memory_requires_verified_task'):
            queue.enqueue({**job(), 'verified': False})
        self.assertIsNone(queue.status('task1'))

    def test_queue_capacity_bounds_waiting_jobs_without_more_workers(self):
        entered, release = threading.Event(), threading.Event()

        def infer(*_):
            entered.set()
            release.wait(2)
            return proposal()

        queue = self.queue(infer=infer)
        queue.MAX_PENDING = 2
        queue.enqueue(job('task1'))
        self.assertTrue(entered.wait(1))
        queue.enqueue(job('task2'))
        with self.assertRaisesRegex(ValueError, 'memory_queue_full'):
            queue.enqueue(job('task3'))
        self.assertIsNone(queue.status('task3'))
        release.set()
        self.wait_status(queue, 'task2', 'saved')

    def test_queue_initialization_failure_does_not_block_foreground_task_admission(self):
        events = []
        with patch.object(module, 'MemoryReviewQueue', side_effect=OSError('disk unavailable')):
            agent = module.Agent(self.directory.name, events.append, model=lambda *_: proposal())
            agent.start({'task_id': 'task1', 'goal': 'Execute the foreground task'})
            self.assertEqual(agent.task['phase'], 'queued')
            self.assertIsNone(agent.memory_reviews)
            agent.task['verified'] = True
            with self.assertRaises(OSError):
                agent.queue_memory_review(agent.task, {'summary': 'completed'})
        agent.mem = lambda *_: {'id': 'memory1'}
        agent.queue_memory_review(agent.task, {'summary': 'completed'})
        self.queues.append(agent.memory_reviews)
        self.wait_status(agent.memory_reviews, 'task1', 'saved')
        self.assertTrue(any(e['type'] == 'memory.queue_error' for e in events))

    def test_worker_retries_failed_startup_database_read_and_delivers_retained_notice(self):
        queue = self.queue()
        queue.close()
        with queue.connect() as db:
            db.execute("INSERT INTO jobs(task_id,job,status,created) VALUES(?,?,'needs_review',?)",
                       ('legacy', module.encode(job('legacy')), time.time()))
            db.commit()
        original = queue.connect
        reads = []

        def interrupted_connect():
            reads.append(1)
            if len(reads) == 1:
                raise sqlite3.OperationalError('temporary IO failure')
            return original()

        queue.connect = interrupted_connect
        queue.stopped.clear()
        queue.worker = threading.Thread(target=queue.run)
        queue.worker.start()
        deadline = time.monotonic() + 2
        while not any(e['type'] == 'memory.saved' and e['task_id'] == 'legacy' for e in self.events):
            if time.monotonic() >= deadline:
                self.fail('Retained notice was lost after the startup read failed')
            time.sleep(.01)
        self.assertTrue(queue.worker.is_alive())
        self.assertGreaterEqual(len(reads), 2)

    def test_transient_service_outage_remains_retryable_past_three_failures(self):
        attempts = []

        def memory(*_):
            attempts.append(1)
            if len(attempts) <= 4:
                raise ConnectionRefusedError('Service is starting')
            return {'id': 'memory1'}

        queue = self.queue(memory=memory)
        queue.enqueue(job())
        for count in range(1, 5):
            deadline = time.monotonic() + 3
            while len(attempts) < count or queue.status('task1')['status'] != 'retry':
                if time.monotonic() >= deadline:
                    self.fail('Transient failure did not remain retryable')
                time.sleep(.01)
            with queue.connect() as db:
                row = db.execute("SELECT failures,next_attempt FROM jobs WHERE task_id='task1'").fetchone()
                self.assertEqual(row['failures'], 0)
                self.assertLessEqual(row['next_attempt'] - time.time(), 60)
                db.execute("UPDATE jobs SET next_attempt=0 WHERE task_id='task1'")
                db.commit()
            queue.wake.set()
        self.wait_status(queue, 'task1', 'saved')
        self.assertEqual(len(attempts), 5)

    def test_deferred_storage_ack_is_pending_retry_and_never_saved(self):
        queue = self.queue(memory=lambda *_: {'deferred': True})
        queue.MAX_FAILURES = 1
        queue.enqueue(job())
        self.wait_status(queue, 'task1', 'retry')
        self.assertFalse(any(e['type'] == 'memory.saved' for e in self.events))

    def test_originating_runtime_receives_terminal_ack_when_other_runtime_writes(self):
        owner_events, other_events, writers = [], [], []
        owner = self.queue(events=owner_events,
                           memory=lambda *_: self.fail('Owner is prevented from acquiring writer lock'))
        owner.close()

        @contextlib.contextmanager
        def unavailable_lock():
            yield False

        owner.writer_lock = unavailable_lock
        owner.stopped.clear()
        owner.worker = threading.Thread(target=owner.run)
        owner.worker.start()
        self.queue(events=other_events, memory=lambda *_: writers.append('other') or {'id': 'memory1'})
        owner.enqueue(job())
        deadline = time.monotonic() + 3
        while not any(e['type'] == 'memory.saved' and e['saved'] for e in owner_events):
            if time.monotonic() >= deadline:
                self.fail('Owner did not receive the other writer completion')
            time.sleep(.01)
        owner.poll_statuses()
        owner.enqueue(job())
        owner.poll_statuses()
        self.assertEqual(writers, ['other'])
        self.assertEqual(len([e for e in owner_events if e['type'] == 'memory.saved']), 1)


class QwenTimingTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        (self.root / '.runtime').mkdir()
        (self.root / '.runtime/api-key').write_text('isolated-test-key', encoding='utf-8')
        self.activity = Mock()
        self.client = Mock(return_value=self.activity)
        self.memory_module = patch.dict(sys.modules, {'memory_client': SimpleNamespace(MemoryClient=self.client)})
        self.memory_module.start()
        self.model = module.Qwen(self.root)

    def tearDown(self):
        self.memory_module.stop()
        self.directory.cleanup()

    def enable_activity(self):
        (self.root / '.runtime/memory-config.json').write_text('{"enabled":true}', encoding='utf-8')

    def test_readiness_and_inference_have_separate_metadata_only_timings(self):
        self.enable_activity()
        with patch.object(self.model, 'generate', return_value=proposal()) as generate, \
                patch.object(module.time, 'monotonic', side_effect=[1, 3, 4, 9]):
            self.assertEqual(self.model(module.REVIEW, job(), 384), proposal())
        generate.assert_called_once_with(module.REVIEW, job(), 384)
        self.assertEqual(self.model.last_timing, {'readiness_ms': 2000, 'inference_ms': 5000,
                                                'model_requests': 0, 'json_repairs': 0})
        self.assertEqual([call.args[0] for call in self.activity.request.call_args_list],
                         ['/activity', '/ready-for-foreground', '/activity'])
        self.assertFalse(self.activity.request.call_args_list[-1].args[1]['active'])

    def test_readiness_failure_records_wait_and_releases_activity_without_inference(self):
        self.enable_activity()

        def activity(path, *_args, **_kwargs):
            if path == '/ready-for-foreground':
                raise TimeoutError('not ready')

        self.activity.request.side_effect = activity
        with patch.object(self.model, 'generate') as generate, \
                patch.object(module.time, 'monotonic', side_effect=[1, 4]), \
                self.assertRaises(TimeoutError):
            self.model(module.REVIEW, job(), 384)
        generate.assert_not_called()
        self.assertEqual(self.model.last_timing['readiness_ms'], 3000)
        self.assertEqual(self.model.last_timing['inference_ms'], 0)
        self.assertEqual(self.model.last_timing['model_requests'], 0)
        self.assertFalse(self.activity.request.call_args_list[-1].args[1]['active'])

    def response(self, value):
        response = io.StringIO(json.dumps(value))
        response.headers = {'X-RK-Privacy': 'metadata-only'}
        return response

    def test_json_repair_counts_both_requests_and_resets_for_the_next_call(self):
        def health():
            return self.response({'model': 'isolated-test-model'})

        def completion(content):
            return self.response({'choices': [{'finish_reason': 'stop', 'message': {'content': content}}]})

        self.model.opener = Mock()
        self.model.opener.open.side_effect = [health(), completion('invalid JSON'),
                                              health(), completion(module.encode(proposal())),
                                              health(), completion(module.encode(proposal()))]
        self.assertEqual(self.model(module.REVIEW, job(), 384), proposal())
        self.assertEqual(self.model.last_timing['model_requests'], 2)
        self.assertEqual(self.model.last_timing['json_repairs'], 1)
        self.assertEqual(self.model.last_timing['readiness_ms'], 0)
        self.assertEqual(self.model(module.REVIEW, job('task2'), 384), proposal())
        self.assertEqual(self.model.last_timing['model_requests'], 1)
        self.assertEqual(self.model.last_timing['json_repairs'], 0)
        self.client.assert_not_called()


if __name__ == '__main__':
    unittest.main()
