"""Independent RK memory service for host-verified task evidence."""
import os
from pathlib import Path
import sys
import threading
import time
import re
import json
import hashlib
import sqlite3
from datetime import datetime
from contextlib import closing

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
                # Explicit preferences are exercised across independent, potentially
                # long RK tasks. Keep QA isolation while allowing that sequence;
                # inferred task evidence retains its short five-minute lifetime.
                args['ttl'] = 86400 if args.get('kind') == 'preference' else 300
        result = self.memory.call(args)
        if self.namespace != 'production' and op == 'memory.get':
            # A limited catalog is not a scope index. Check the live records'
            # tags before exposing any body, including records older than its page.
            if not isinstance(result, dict):
                raise ValueError('INVALID_MEMORY_RESULT')
            records, missing = result.get('memories'), result.get('missing', [])
            if (not isinstance(records, list) or not isinstance(missing, list)
                    or any(not isinstance(record, dict) for record in records)):
                raise ValueError('INVALID_MEMORY_RESULT')
            identifiers = [record.get('id') for record in records] + missing
            if (any(not isinstance(identifier, str) or identifier not in args['ids']
                    for identifier in identifiers)
                    or len(set(identifiers)) != len(identifiers)
                    or (result.get('deferred') and identifiers)
                    or (not result.get('deferred') and set(identifiers) != set(args['ids']))):
                raise ValueError('INVALID_MEMORY_RESULT')
            if any(not isinstance(record.get('tags'), list)
                   or self.namespace not in record['tags'] for record in records):
                raise ValueError('MEMORY_SCOPE_MISMATCH')
        return result

    def provenance(self, kind, identity, value, complete=False):
        """Only a digest and acknowledgement, never a second copy of user text.

        A durable same-ID conflict check precedes every write. Retrying an
        acknowledged item does not resurrect memory the user later deleted.
        """
        directory = self.root / '.runtime'
        directory.mkdir(parents=True, exist_ok=True)
        digest = hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                           separators=(',', ':')).encode()).hexdigest()
        with closing(sqlite3.connect(directory / 'coloop-memory-provenance.sqlite3')) as db, db:
            db.execute('CREATE TABLE IF NOT EXISTS receipts(namespace TEXT, kind TEXT, identity TEXT, digest TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(namespace,kind,identity))')
            row = db.execute('SELECT digest,completed FROM receipts WHERE namespace=? AND kind=? AND identity=?',
                             (self.namespace, kind, identity)).fetchone()
            if row and row[0] != digest:
                raise ValueError('MEMORY_SOURCE_ID_CONFLICT')
            if not row:
                db.execute('INSERT INTO receipts(namespace,kind,identity,digest) VALUES(?,?,?,?)',
                           (self.namespace, kind, identity, digest))
            if complete:
                db.execute('UPDATE receipts SET completed=1 WHERE namespace=? AND kind=? AND identity=?',
                           (self.namespace, kind, identity))
            return bool(row and row[1])

    def save_source_fragment(self, value):
        # Keep the durable source receipt pending until storage acknowledges
        # every fragment. Retries reuse the source-derived key and exact text.
        try:
            acknowledgement = self.call_memory('memory.set', value)
        except Exception:
            # Storage errors may contain source text or local paths.
            raise ValueError('MEMORY_WRITE_FAILED') from None
        if isinstance(acknowledgement, dict) and acknowledgement.get('deferred'):
            raise ValueError('MEMORY_WRITE_DEFERRED')
        if (not isinstance(acknowledgement, dict)
                or not isinstance(acknowledgement.get('id'), str) or not acknowledgement['id'].strip()
                or acknowledgement.get('error') or acknowledgement.get('saved') is False
                or acknowledgement.get('ok') is False
                or acknowledgement.get('key', value['key']) != value['key']):
            raise ValueError('MEMORY_WRITE_UNACKNOWLEDGED')

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
            if op == 'memory.remember':
                key, text, task_id = value.get('key'), value.get('value'), value.get('source_task_id')
                if (set(value) != {'key', 'value', 'source_task_id'}
                        or not isinstance(key, str) or not key.startswith('preference:coloop:')
                        or not 19 <= len(key) <= 128 or any(ord(c) < 32 for c in key)
                        or not isinstance(text, str) or not 1 <= len(text.strip()) <= 1000
                        or '\x00' in text or not isinstance(task_id, str) or not 1 <= len(task_id) <= 128):
                    raise ValueError('INVALID_PREFERENCE_REQUEST')
                if self.namespace != 'production':
                    prefix = 'preference:coloop:qa_' + hashlib.sha256(self.namespace.encode()).hexdigest()[:16] + ':'
                    if not key.startswith(prefix):
                        key = prefix + key[len('preference:coloop:'):]
                result = self.call_memory('memory.set', {
                    'key': key, 'value': text, 'kind': 'preference',
                    'tags': ['user_preference'], 'summary': text[:160],
                    'source_task_id': task_id, 'source': 'user_message', 'verified': False,
                })
                if isinstance(result, dict) and result.get('deferred'):
                    raise ValueError('PREFERENCE_WRITE_DEFERRED')
                if isinstance(result, dict) and (result.get('error') or result.get('ok') is False
                                               or result.get('saved') is False):
                    raise ValueError('PREFERENCE_WRITE_UNACKNOWLEDGED')
                identifier = result.get('id') if isinstance(result, dict) else None
                if not isinstance(identifier, str) or not identifier:
                    raise ValueError('PREFERENCE_READBACK_REQUIRED')
                readback = self.call_memory('memory.get', {'ids': [identifier]})
                if isinstance(readback, dict) and readback.get('deferred'):
                    raise ValueError('PREFERENCE_READBACK_DEFERRED')
                records = readback.get('memories', []) if isinstance(readback, dict) else []
                if (not isinstance(records, list) or len(records) != 1
                        or not isinstance(records[0], dict) or records[0].get('id') != identifier
                        or records[0].get('key') != key or records[0].get('value') != text
                        or records[0].get('kind') != 'preference'):
                    raise ValueError('PREFERENCE_READBACK_MISMATCH')
                # Keep the existing receipt fields; do not duplicate its storage
                # metadata inside the model's readback evidence.
                confirmed = {field: records[0][field] for field in ('id', 'key', 'value', 'kind')}
                return {'ok': True, 'result': {**result, 'memories': [confirmed], 'readback_verified': True}}
            if op == 'memory.feedback':
                expected = {'feedback_id', 'source_task_id', 'decision_id', 'scope',
                            'workspace_scope', 'rating', 'source_quote', 'supersedes', 'created_at'}
                identifier = re.compile(r'^[a-f0-9-]{36}$')
                feedback_id, task_id = value.get('feedback_id'), value.get('source_task_id')
                decision_id, quote = value.get('decision_id'), value.get('source_quote')
                workspace_scope, rating = value.get('workspace_scope'), value.get('rating')
                supersedes, created_at = value.get('supersedes'), value.get('created_at')
                if (set(value) != expected or value.get('scope') != 'future'
                        or not isinstance(feedback_id, str) or not identifier.fullmatch(feedback_id)
                        or not isinstance(task_id, str) or not identifier.fullmatch(task_id)
                        or not isinstance(decision_id, str) or (decision_id and not identifier.fullmatch(decision_id))
                        or not isinstance(workspace_scope, str) or not re.fullmatch(r'[a-f0-9]{48}', workspace_scope)
                        or rating not in ('positive', 'negative') or not isinstance(quote, str)
                        or len(quote) > 4000 or '\x00' in quote
                        or not isinstance(supersedes, str) or (supersedes and not identifier.fullmatch(supersedes))
                        or supersedes == feedback_id or not isinstance(created_at, str)):
                    raise ValueError('INVALID_FEEDBACK_REQUEST')
                stamp = datetime.fromisoformat(created_at.replace('Z', '+00:00'))
                if stamp.tzinfo is None:
                    raise ValueError('INVALID_FEEDBACK_TIME')
                if self.provenance('feedback', feedback_id, value):
                    return {'ok': True, 'result': {'already_stored': True}}
                # Exact human feedback, never a model-inferred preference. Raw
                # fragments retain negations; retrieval requires the complete set.
                text = quote or ('用户对本次自动推进给出' + ('正面' if rating == 'positive' else '负面')
                                 + '反馈，未提供具体原因。不得据此推断某项长期偏好。')
                fragments = [text[index:index + 1000] for index in range(0, len(text), 1000)]
                key_prefix = 'feedback:coloop:'
                if self.namespace != 'production':
                    key_prefix += 'qa_' + hashlib.sha256(self.namespace.encode()).hexdigest()[:16] + ':'
                for index, fragment in enumerate(fragments, 1):
                    tags = ['auto_work_feedback', 'origin:direct-user', 'scope:' + workspace_scope,
                            'feedback:' + feedback_id,
                            'fbmeta:' + rating + ':' + str(index) + ':' + str(len(fragments)) + ':' + str(int(stamp.timestamp() * 1000))]
                    if decision_id:
                        tags.append('decision:' + decision_id)
                    if supersedes:
                        tags.append('supersedes:' + supersedes)
                    self.save_source_fragment({
                        'key': key_prefix + feedback_id + ':' + str(index),
                        'value': fragment, 'kind': 'task', 'tags': tags,
                        'summary': '用户对自动推进的反馈；需读取完整反馈后判断，不作为新授权。',
                        'source_task_id': task_id, 'source': 'user_feedback', 'verified': False,
                    })
                self.provenance('feedback', feedback_id, value, complete=True)
                return {'ok': True, 'result': {'records': len(fragments)}}
            if op == 'memory.choice':
                expected = {'source_task_id', 'event_id', 'workspace_scope', 'source_quote', 'created_at', 'origin'}
                task_id, event_id, quote = value.get('source_task_id'), value.get('event_id'), value.get('source_quote')
                workspace_scope, created_at = value.get('workspace_scope'), value.get('created_at')
                if (set(value) != expected or value.get('origin') != 'user'
                        or not isinstance(task_id, str) or not re.fullmatch(r'[a-f0-9-]{36}', task_id)
                        or not isinstance(event_id, str) or not 1 <= len(event_id) <= 200 or any(ord(c) < 32 for c in event_id)
                        or not isinstance(quote, str) or not 1 <= len(quote.strip()) <= 4000 or '\x00' in quote
                        or re.search(r'\[Coloop Auto (?:Agent )?Work:', quote, re.I)
                        or re.search(r'PRIVATE KEY|\bBearer\s+|(?:password|api[_ -]?key|secret|token)\s*[:=]|(?:密码|密钥|口令)\s*[:：=]|\bsk-[\w-]{8,}', quote, re.I)
                        or not isinstance(workspace_scope, str) or not re.fullmatch(r'[a-f0-9]{48}', workspace_scope)
                        or not isinstance(created_at, str)):
                    raise ValueError('INVALID_CHOICE_REQUEST')
                if datetime.fromisoformat(created_at.replace('Z', '+00:00')).tzinfo is None:
                    raise ValueError('INVALID_CHOICE_TIME')
                identity = hashlib.sha256((task_id + '\0' + event_id).encode()).hexdigest()[:48]
                if self.provenance('choice', identity, value):
                    return {'ok': True, 'result': {'already_stored': True}}
                fragments = [quote[index:index + 1000] for index in range(0, len(quote), 1000)]
                metadata = json.dumps({'event_id': event_id, 'source_task_id': task_id,
                                       'created_at': created_at, 'parts': len(fragments)}, ensure_ascii=False)
                prefix = 'case:coloop:'
                if self.namespace != 'production':
                    prefix += 'qa_' + hashlib.sha256(self.namespace.encode()).hexdigest()[:16] + ':'
                for index, fragment in enumerate([metadata] + fragments):
                    self.save_source_fragment({
                        'key': prefix + identity + ':' + str(index), 'value': fragment, 'kind': 'task',
                        'tags': ['auto_work_choice', 'origin:direct-user', 'scope:' + workspace_scope,
                                 'choice:' + identity, 'part:' + str(index) + '/' + str(len(fragments))],
                        'summary': '真实用户选择案例，需读取完整原句；不是推断偏好或新授权。',
                        'source_task_id': task_id, 'source': 'user_choice', 'verified': False,
                    })
                self.provenance('choice', identity, value, complete=True)
                return {'ok': True, 'result': {'records': len(fragments) + 1}}
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
