"""Independent RK memory service for host-verified task evidence."""
import os
from pathlib import Path
import sys
import threading
import time

from coloop_rk_support import MemoryReviewQueue, Qwen, encode, parse


class MemoryWorker:
    def __init__(self, root, emit, *, memory=None, model=None, namespace=None):
        self.root, self.emit = Path(root), emit
        self.namespace = namespace or os.environ.get('COLOOP_MEMORY_NAMESPACE', 'production')
        if (not isinstance(self.namespace, str) or not 1 <= len(self.namespace) <= 128
                or (self.namespace != 'production' and not self.namespace.startswith('qa:'))):
            raise ValueError('INVALID_MEMORY_NAMESPACE')
        self.memory, self.model = memory, model or Qwen(root)
        self.queue = MemoryReviewQueue(root, self.namespace, self.infer, self.call_memory, self.event)

    def event(self, kind, **value):
        self.emit({'type': kind, 'value': value})

    def infer(self, stage, system, job, tokens):
        started, success = time.monotonic(), False
        try:
            result = self.model(system, job, tokens)
            success = True
            return result
        finally:
            timing = self.model.last_timing if isinstance(self.model, Qwen) else {}
            self.event('model.timing', stage=stage, task_id=job['task_id'], success=success,
                       elapsed_ms=round((time.monotonic() - started) * 1000), max_tokens=tokens,
                       **timing)

    def call_memory(self, op, value):
        if self.memory is None:
            from memory_client import MemoryClient
            self.memory = MemoryClient(self.root)
        args = dict(value)
        args.pop('type', None)
        args['op'] = {'memory.set': 'set', 'memory.catalog': 'catalog', 'memory.get': 'get_many'}[op]
        if self.namespace != 'production':
            if op in ('memory.set', 'memory.catalog'):
                args['tags'] = [self.namespace] + [tag for tag in args.get('tags', []) if tag != self.namespace][:7]
            if op == 'memory.set':
                args['ttl'] = 300
            if op == 'memory.get':
                # A catalog lookup proves each requested ID is in this QA scope.
                catalog = self.memory.call({'op': 'catalog', 'tags': [self.namespace], 'limit': 5})
                allowed = {row.get('id') for row in catalog.get('memories', [])}
                if not set(args['ids']) <= allowed:
                    raise ValueError('MEMORY_SCOPE_MISMATCH')
        return self.memory.call(args)

    def dispatch(self, op, value):
        try:
            if not isinstance(value, dict) or 'namespace' in value:
                raise ValueError('INVALID_MEMORY_REQUEST')
            if op == 'memory.enqueue':
                if value.get('verified') is not True:
                    raise ValueError('MEMORY_REQUIRES_VERIFICATION')
                task_id, goal, receipts = value.get('task_id'), value.get('goal'), value.get('receipts')
                texts = value.get('verified_texts', [])
                if (not isinstance(task_id, str) or not 1 <= len(task_id) <= 128
                        or not isinstance(goal, str) or not goal.strip()
                        or not isinstance(receipts, list) or not receipts
                        or any(not isinstance(row, dict) or row.get('outcome') not in
                               ('input_sent', 'effect_verified', 'script_verified', 'observed_partial', 'not_sent') for row in receipts)
                        or not isinstance(texts, list) or len(texts) > 32
                        or any(not isinstance(text, str) or len(text) > 32000 for text in texts)):
                    raise ValueError('INVALID_MEMORY_EVIDENCE')
                job = {'task_id': task_id, 'goal': goal[:1000], 'verified': True,
                       'result': str(value.get('summary', ''))[:600],
                       'verified_texts': texts[-8:],
                       'receipts': [{key: row[key] for key in ('action', 'outcome') if key in row}
                                    for row in receipts[-16:]]}
                self.queue.enqueue(job)
                return {'ok': True, 'task_id': task_id, **self.queue.status(task_id)}
            if op == 'memory.status':
                task_id = value.get('task_id')
                if not isinstance(task_id, str):
                    raise ValueError('INVALID_MEMORY_REQUEST')
                status = self.queue.status(task_id)
                return {'ok': True, 'task_id': task_id, **status} if status else {'ok': False, 'error': 'MEMORY_JOB_NOT_FOUND'}
            if op == 'memory.catalog':
                query, tags, limit = value.get('query', ''), value.get('tags', []), value.get('limit', 5)
                if (set(value) - {'query', 'tags', 'limit'} or not isinstance(query, str) or len(query) > 4000
                        or not isinstance(tags, list) or len(tags) > 8
                        or any(not isinstance(tag, str) or not 1 <= len(tag) <= 64 for tag in tags)
                        or type(limit) is not int or not 1 <= limit <= 5):
                    raise ValueError('INVALID_MEMORY_REQUEST')
                return {'ok': True, 'result': self.call_memory(op, {'query': query, 'tags': tags, 'limit': limit})}
            if op == 'memory.get':
                ids = value.get('ids')
                if (set(value) != {'ids'} or not isinstance(ids, list) or not 1 <= len(ids) <= 5
                        or any(not isinstance(identifier, str) or not 1 <= len(identifier) <= 128 for identifier in ids)):
                    raise ValueError('INVALID_MEMORY_REQUEST')
                return {'ok': True, 'result': self.call_memory(op, {'ids': ids})}
            raise ValueError('UNSUPPORTED_OPERATION')
        except Exception as error:
            code = str(error) if isinstance(error, ValueError) else type(error).__name__
            return {'ok': False, 'error': code}

    def close(self):
        self.queue.close(timeout=1)


def main():
    os.umask(0o077)
    root = Path(sys.argv[1]).expanduser().resolve()
    sys.path.insert(0, str(root / 'agent'))
    output_lock = threading.Lock()
    def emit(value):
        with output_lock:
            print(encode(value), flush=True)
    worker = MemoryWorker(root, emit)
    emit({'type': 'ready', 'value': {'protocol': 'coloop-rk-memory-v1', 'namespace': worker.namespace}})
    try:
        for line in sys.stdin:
            if len(line.encode()) > 131072:
                raise ValueError('message_too_large')
            packet = parse(line)
            if packet.get('type') == 'request':
                emit({'type': 'reply', 'id': packet.get('id'),
                      'value': worker.dispatch(packet.get('op'), packet.get('value'))})
    finally:
        worker.close()


if __name__ == '__main__':
    main()
