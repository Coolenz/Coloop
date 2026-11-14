"""Single-step RK USB executor. Planning and task completion belong to the host."""
import contextlib
import hashlib
import json
import math
import os
from pathlib import Path
import queue
import re
import sqlite3
import sys
import threading
import time

from coloop_rk_support import canonical_action, encode, parse


def input_failure_diagnostics(message, value):
    categories = {'EDITOR_BINDING_CHANGED': ('editor_binding', (
        'assistantAllowed', 'window', 'process', 'windowRect', 'focused',
        'targetFound', 'targetType', 'targetRuntimePresent', 'targetRuntime',
        'snapshotRuntime', 'editorRectPresent', 'editorRect', 'textReadable', 'textWithinLimit')),
        'INPUT_TARGET_CHANGED': ('input_target', (
        'same', 'inside', 'elementValid', 'focusValid', 'observedPointMatches',
        'observedFocusMatches', 'identityMatches', 'assistantAllowed'))}
    expected = categories.get(message)
    if (not expected or not isinstance(value, dict) or value.get('category') != expected[0]
            or value.get('stage') not in ('input.validate', 'input.guard', 'clipboard.verify')
            or not isinstance(value.get('checks'), dict)):
        return None
    checks = {key: value['checks'][key] for key in expected[1]
              if key in value['checks'] and type(value['checks'][key]) is bool}
    if not checks:
        return None
    return {'category': expected[0], 'stage': value['stage'], 'checks': checks}


class ExecutionError(Exception):
    def __init__(self, message, *, diagnostics=None):
        super().__init__(message)
        self.diagnostics = input_failure_diagnostics(message, diagnostics)


@contextlib.contextmanager
def exclusive_file(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a+b') as handle:
        if handle.tell() == 0:
            handle.write(b'0')
            handle.flush()
        handle.seek(0)
        if os.name == 'nt':
            import msvcrt
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == 'nt':
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle, fcntl.LOCK_UN)


class ExecutionAdapter:
    def __init__(self, root, emit, *, hid=None, rpc=None, clock=time.monotonic, namespace=None):
        self.root, self.emit, self.clock = Path(root), emit, clock
        self.namespace = namespace or os.environ.get('COLOOP_EXECUTION_NAMESPACE',
            os.environ.get('COLOOP_MEMORY_NAMESPACE', 'production'))
        if (not isinstance(self.namespace, str) or not 1 <= len(self.namespace) <= 128
                or (self.namespace != 'production' and not self.namespace.startswith('qa:'))):
            raise ValueError('INVALID_EXECUTION_NAMESPACE')
        self.hid, self.rpc_hook = hid, rpc
        self.guard, self.execution_lock = threading.RLock(), threading.Lock()
        self.cancel, self.closed = threading.Event(), threading.Event()
        self.pending, self.requests = {}, queue.Queue(maxsize=16)
        self.stop_waiters = []
        self.heartbeat = self.clock()
        self.current, self.in_flight = None, None
        # First release of this adapter: no legacy production journal is replayed.
        scope = hashlib.sha256(self.namespace.encode()).hexdigest()
        self.database = self.root / '.runtime/rk-execution' / (scope + '.sqlite3')
        self.database.parent.mkdir(parents=True, exist_ok=True)
        self.instance_lease = exclusive_file(self.root / '.runtime/rk-execution.lock')
        try:
            self.instance_lease.__enter__()
        except OSError as error:
            raise ExecutionError('EXECUTOR_BUSY') from error
        self.lease_open = True
        try:
            with self.connect() as db:
                db.execute('PRAGMA journal_mode=WAL')
                db.execute('''CREATE TABLE IF NOT EXISTS commands (
                    command_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, generation TEXT NOT NULL,
                    digest TEXT NOT NULL, receipt TEXT NOT NULL, outcome TEXT NOT NULL)''')
                db.execute('CREATE TABLE IF NOT EXISTS session (id INTEGER PRIMARY KEY, value TEXT)')
                rows = db.execute("SELECT command_id,receipt,outcome FROM commands WHERE outcome IN ('accepted','dispatching')").fetchall()
                for row in rows:
                    receipt = parse(row['receipt'])
                    receipt.update(outcome='unknown' if row['outcome'] == 'dispatching' else 'not_sent',
                                   error='EXECUTOR_RESTARTED')
                    db.execute('UPDATE commands SET receipt=?,outcome=? WHERE command_id=?',
                               (encode(receipt), receipt['outcome'], row['command_id']))
                saved = db.execute('SELECT value FROM session WHERE id=1').fetchone()
                self.current = parse(saved['value']) if saved else None
                if self.current and self.current.get('phase') in ('active', 'stopping'):
                    # Owning the global lock proves the previous executor is gone.
                    # End its session. Business effects remain in the journal;
                    # only unconfirmed hardware release prevents new input.
                    self.current['phase'] = 'stopped'
                    db.execute('UPDATE session SET value=? WHERE id=1', (encode(self.current),))
                db.commit()
        except Exception:
            self.release_instance()
            raise

    def connect(self):
        connection = sqlite3.connect(self.database, timeout=5)
        connection.row_factory = sqlite3.Row
        return contextlib.closing(connection)

    def release_instance(self):
        with self.guard:
            if self.lease_open:
                self.instance_lease.__exit__(None, None, None)
                self.lease_open = False

    @staticmethod
    def identity(value):
        task_id, generation = value.get('task_id'), value.get('generation')
        if (not isinstance(task_id, str) or not 1 <= len(task_id) <= 128 or '\x00' in task_id
                or not ((type(generation) is int and generation >= 0)
                        or (isinstance(generation, str) and 1 <= len(generation) <= 128))):
            raise ExecutionError('INVALID_SESSION')
        return {'task_id': task_id, 'generation': generation}

    def matches(self, identity):
        return self.current and all(self.current.get(key) == val for key, val in identity.items())

    def save_session(self):
        with self.connect() as db:
            db.execute('INSERT OR REPLACE INTO session VALUES(1,?)', (encode(self.current),))
            db.commit()

    def input_unreleased(self):
        with self.connect() as db:
            pending = db.execute("SELECT outcome,receipt FROM commands WHERE outcome IN ('unknown','dispatching')").fetchall()
        return any(row['outcome'] == 'dispatching' or
                   parse(row['receipt']).get('release_confirmed') is not True for row in pending)

    def begin(self, value):
        identity = self.identity(value)
        with self.guard:
            if self.closed.is_set():
                raise ExecutionError('EXECUTOR_CLOSED')
            if self.input_unreleased():
                raise ExecutionError('INPUT_UNKNOWN')
            if self.in_flight or (self.current and self.current['phase'] == 'active' and not self.matches(identity)):
                raise ExecutionError('EXECUTOR_BUSY')
            if self.matches(identity) and self.current['phase'] == 'stopped':
                raise ExecutionError('SESSION_STOPPED')
            if self.matches(identity) and self.current.get('restricted_command_id'):
                raise ExecutionError('RESUME_COMMAND_RESTRICTED')
            self.current = {**identity, 'phase': 'active'}
            self.cancel.clear()
            self.save_session()
            return {'ok': True, **self.current}

    def resume_draft(self, value):
        identity = self.identity(value)
        command_id, paste_id = value.get('command_id'), value.get('paste_command_id')
        if (set(value) != {'task_id', 'generation', 'command_id', 'paste_command_id'}
                or not isinstance(command_id, str) or not 6 <= len(command_id) <= 128
                or '\x00' in command_id or not command_id.endswith(':send')
                or paste_id != command_id[:-5] + ':paste' or len(paste_id) > 128):
            raise ExecutionError('INVALID_DRAFT_RESUME')
        with self.guard:
            if self.closed.is_set():
                raise ExecutionError('EXECUTOR_CLOSED')
            if not self.matches(identity):
                raise ExecutionError('SESSION_MISMATCH')
            if self.in_flight or self.execution_lock.locked():
                raise ExecutionError('EXECUTOR_BUSY')
            if self.current['phase'] != 'stopped':
                raise ExecutionError('SESSION_NOT_STOPPED')
            if self.input_unreleased():
                raise ExecutionError('INPUT_UNKNOWN')
            with self.connect() as db:
                sent = db.execute('SELECT command_id FROM commands WHERE command_id=?',
                                  (command_id,)).fetchone()
                pasted = db.execute('SELECT * FROM commands WHERE command_id=?',
                                    (paste_id,)).fetchone()
            if sent:
                raise ExecutionError('SEND_ALREADY_RECORDED')
            if not pasted:
                raise ExecutionError('PASTE_RECEIPT_REQUIRED')
            if (pasted['task_id'] != identity['task_id']
                    or pasted['generation'] != encode(identity['generation'])):
                raise ExecutionError('SESSION_MISMATCH')
            receipt = parse(pasted['receipt'])
            if (receipt.get('action') != 'paste' or receipt.get('release_confirmed') is not True
                    or receipt.get('outcome') not in ('unknown', 'input_sent', 'effect_verified')
                    or receipt.get('outcome') != pasted['outcome']):
                raise ExecutionError('PASTE_RECEIPT_INVALID')
            previous = self.current
            self.current = {**identity, 'phase': 'active', 'restricted_command_id': command_id,
                            'restricted_action': {'action': 'hotkey', 'keys': 'ENTER'}}
            try:
                self.save_session()
            except Exception:
                self.current = previous
                raise
            self.cancel.clear()
            return {'ok': True, **self.current}

    def check_restricted_command(self, identity, command_id, action):
        if self.current and self.current.get('restricted_command_id'):
            if (not self.matches(identity) or command_id != self.current['restricted_command_id']
                    or action.get('action') != 'hotkey' or action.get('keys') != 'ENTER'):
                raise ExecutionError('RESUME_COMMAND_RESTRICTED')

    @staticmethod
    def verification_summary(value):
        if not isinstance(value, dict):
            return {'verified': False}
        summary = {'verified': value.get('verified') is True}
        for key in ('source', 'failure'):
            if isinstance(value.get(key), str):
                summary[key] = value[key][:128]
        if isinstance(value.get('checks'), dict):
            summary['checks'] = {key: passed for key, passed in list(value['checks'].items())[:64]
                                 if isinstance(key, str) and len(key) <= 64 and type(passed) is bool}
        for key in ('attempts', 'elapsed_ms'):
            number = value.get(key)
            if type(number) in (int, float) and math.isfinite(number) and number >= 0:
                summary[key] = number
        return summary

    def stop(self, value):
        identity = self.identity(value)
        with self.guard:
            if not self.matches(identity):
                raise ExecutionError('SESSION_MISMATCH')
            self.cancel.set()
            self.current['phase'] = 'stopping' if self.in_flight else 'stopped'
            self.save_session()
            return self.stop_result()

    def stop_result(self):
        neutral = not self.in_flight and not self.input_unreleased()
        return {'ok': True, **self.current, 'in_flight': self.in_flight,
                'stopped': self.in_flight is None, 'neutral': neutral}

    def reply_to_stops(self):
        with self.guard:
            waiting, self.stop_waiters = self.stop_waiters, []
            result = self.stop_result() if waiting else None
        for request_id in waiting:
            self.emit({'type': 'reply', 'id': request_id, 'value': result})

    def check(self, identity):
        while True:
            if self.closed.is_set() or self.cancel.is_set():
                raise ExecutionError('TASK_STOPPED')
            if not self.matches(identity) or self.current['phase'] != 'active':
                raise ExecutionError('SESSION_MISMATCH')
            if self.clock() - self.heartbeat <= 3:
                return
            self.cancel.wait(.05)

    def host_rpc(self, op, value, identity, *, cleanup=False):
        if not cleanup:
            self.check(identity)
        if self.rpc_hook:
            result = self.rpc_hook(op, value)
            if not cleanup:
                self.check(identity)
            return result
        request_id = hashlib.sha256(os.urandom(32)).hexdigest()
        waiter = queue.Queue()
        with self.guard:
            self.pending[request_id] = waiter
        try:
            self.emit({'type': 'request', 'id': request_id, 'op': op, 'value': value})
            deadline = self.clock() + (5 if cleanup else 30)
            while self.clock() < deadline:
                if not cleanup:
                    self.check(identity)
                try:
                    response = waiter.get(timeout=.05)
                except queue.Empty:
                    continue
                if response.get('error'):
                    raise ExecutionError(str(response['error']), diagnostics=response.get('diagnostics'))
                return response.get('value')
            raise ExecutionError('HOST_RPC_TIMEOUT')
        finally:
            with self.guard:
                self.pending.pop(request_id, None)

    @staticmethod
    def validate(value):
        command_id = value.get('command_id')
        observed = value.get('observation')
        if not isinstance(command_id, str) or not 1 <= len(command_id) <= 128 or '\x00' in command_id:
            raise ExecutionError('INVALID_COMMAND_ID')
        if (not isinstance(observed, dict) or not isinstance(observed.get('observation_id'), str)
                or not observed.get('observation_id') or 'window_id' not in observed):
            raise ExecutionError('INVALID_OBSERVATION')
        try:
            action = canonical_action(value.get('action'))
        except ValueError as error:
            raise ExecutionError('INVALID_ACTION') from error
        fields = {'click': set(), 'double_click': set(), 'move': set(), 'scroll': {'steps'},
                  'hotkey': {'keys'}, 'paste': {'text'}}
        kind = action.get('action')
        targets, ocr_items = observed.get('targets', []), observed.get('ocr_items', [])
        if not isinstance(targets, list) or not isinstance(ocr_items, list):
            raise ExecutionError('INVALID_OBSERVATION')
        targets = targets + ocr_items
        target_ids = {item.get('id') for item in targets
                      if isinstance(item, dict) and type(item.get('id')) is int}
        if (not isinstance(kind, str) or kind not in fields or set(action) != {'action', 'target_id'} | fields[kind]
                or type(action.get('target_id')) is not int
                or action['target_id'] not in target_ids):
            raise ExecutionError('INVALID_ACTION')
        if kind == 'scroll' and (type(action['steps']) is not int or not 1 <= abs(action['steps']) <= 32):
            raise ExecutionError('INVALID_SCROLL')
        if kind == 'paste' and (not isinstance(action['text'], str) or not 1 <= len(action['text'].encode()) <= 32000):
            raise ExecutionError('INVALID_PASTE')
        if kind == 'hotkey' and (not isinstance(action['keys'], str) or not re.fullmatch(
                r'(?:(?:CTRL|ALT|SHIFT)\+)*(?:[A-Z0-9]|F(?:[1-9]|1[0-2])|ENTER|ESC|BACKSPACE|TAB|SPACE|RIGHT|LEFT|DOWN|UP|HOME|END)', action['keys'])):
            raise ExecutionError('INVALID_HOTKEY')
        return action, observed

    def status(self, value):
        identity = self.identity(value)
        command_id = value.get('command_id')
        if command_id is None:
            if not self.matches(identity):
                raise ExecutionError('SESSION_MISMATCH')
            return {'ok': True, **self.current, 'in_flight': self.in_flight}
        with self.connect() as db:
            row = db.execute('SELECT * FROM commands WHERE command_id=?', (command_id,)).fetchone()
        if not row:
            raise ExecutionError('COMMAND_NOT_FOUND')
        if row['task_id'] != identity['task_id'] or row['generation'] != encode(identity['generation']):
            raise ExecutionError('SESSION_MISMATCH')
        return {'ok': True, 'receipt': parse(row['receipt'])}

    def record(self, receipt, digest=None):
        with self.connect() as db:
            if digest is not None:
                db.execute('INSERT INTO commands VALUES(?,?,?,?,?,?)',
                    (receipt['command_id'], receipt['task_id'], encode(receipt['generation']),
                     digest, encode(receipt), receipt['outcome']))
            else:
                db.execute('UPDATE commands SET receipt=?,outcome=? WHERE command_id=?',
                           (encode(receipt), receipt['outcome'], receipt['command_id']))
            db.commit()

    @contextlib.contextmanager
    def input_lease(self):
        if self.hid is not None:
            yield self.hid
            return
        from hid import HIDController
        with exclusive_file(self.root / '.runtime/hid.lock'):
            yield HIDController()

    def execute(self, value):
        identity = self.identity(value)
        # A malformed retry must not claim that an earlier command was not sent.
        prior = None
        if isinstance(value.get('command_id'), str):
            with self.connect() as db:
                prior = db.execute('SELECT digest,receipt FROM commands WHERE command_id=?',
                                   (value['command_id'],)).fetchone()
        try:
            action, observed = self.validate(value)
        except ExecutionError as error:
            if prior:
                raise ExecutionError('COMMAND_CONFLICT') from error
            # Validation has no hardware effects. Return that fact to the model
            # so it can correct the request using a new observation.
            return {'ok': False, 'error': str(error), 'receipt': {
                **identity, 'command_id': value.get('command_id'),
                'outcome': 'not_sent', 'release_confirmed': True,
                'error': str(error), 'rejected_before_input': True}}
        canonical = json.dumps({**identity, 'action': action, 'observation': observed},
                               sort_keys=True, ensure_ascii=False, allow_nan=False, separators=(',', ':'))
        digest = hashlib.sha256(canonical.encode()).hexdigest()
        with self.guard:
            self.check_restricted_command(identity, value['command_id'], action)
        if prior:
            if prior['digest'] != digest:
                raise ExecutionError('COMMAND_CONFLICT')
            return {'ok': True, 'deduplicated': True, 'receipt': parse(prior['receipt'])}
        if not self.execution_lock.acquire(blocking=False):
            raise ExecutionError('EXECUTOR_BUSY')
        receipt = {**identity, 'command_id': value['command_id'],
                   'observation_id': observed['observation_id'], 'action': action['action'],
                   'outcome': 'accepted', 'release_confirmed': False}
        reports_started, input_complete, lease_id = False, False, None
        args = {**identity, 'command_id': value['command_id'], 'action_group_id': value['command_id'],
                'observation_id': observed['observation_id'], 'window_id': observed['window_id'], 'action': action}
        try:
            self.check(identity)
            with self.guard:
                if self.cancel.is_set() or not self.matches(identity):
                    raise ExecutionError('TASK_STOPPED')
                if self.input_unreleased():
                    raise ExecutionError('INPUT_UNKNOWN')
                self.check_restricted_command(identity, value['command_id'], action)
                self.in_flight = value['command_id']
                self.record(receipt, digest)
            validated = self.host_rpc('input.validate', args, identity)
            if not isinstance(validated, dict) or validated.get('allowed') is not True:
                raise ExecutionError('INPUT_TARGET_CHANGED')
            if action['action'] == 'paste':
                prepared = self.host_rpc('clipboard.prepare', {**args, 'text': action['text'], 'target_id': action['target_id']}, identity)
                lease_id = prepared['lease_id']
                args['lease_id'] = lease_id
                if self.host_rpc('clipboard.guard', args, identity).get('allowed') is not True:
                    raise ExecutionError('CLIPBOARD_LEASE_CHANGED')
            receipt['outcome'] = 'dispatching'
            self.record(receipt)

            def guard(_report):
                nonlocal reports_started
                if self.host_rpc('input.guard', args, identity).get('allowed') is not True:
                    raise ExecutionError('INPUT_GUARD_CHANGED')
                reports_started = True

            command = {'action': 'hotkey', 'keys': 'CTRL+V'} if lease_id else action
            if command['action'] == 'hotkey':
                command = {'action': 'hotkey', 'keys': command['keys']}
            with self.input_lease() as hid:
                hid.execute(command, validated, guard)
            input_complete = True
            receipt.update(outcome='input_sent', release_confirmed=True)
            if lease_id:
                verification = self.host_rpc('clipboard.verify', args, identity)
                receipt['verification'] = self.verification_summary(verification)
                if not isinstance(verification, dict) or verification.get('verified') is not True:
                    raise ExecutionError('INPUT_EFFECT_UNKNOWN')
                receipt['outcome'] = 'effect_verified'
            self.record(receipt)
            return {'ok': True, 'receipt': receipt}
        except Exception as error:
            code = str(error) if isinstance(error, ExecutionError) else type(error).__name__
            receipt.update(outcome='unknown' if reports_started else 'not_sent',
                           release_confirmed=input_complete or not reports_started, error=code)
            if isinstance(error, ExecutionError) and error.diagnostics is not None:
                receipt['diagnostics'] = error.diagnostics
            try:
                self.record(receipt)
            except (OSError, sqlite3.Error):
                # The committed dispatch marker still blocks all future input.
                receipt['journal_error'] = 'JOURNAL_UNAVAILABLE'
            return {'ok': False, 'error': code, 'receipt': receipt}
        finally:
            try:
                if lease_id:
                    try:
                        result = self.host_rpc('clipboard.finish', {**identity, 'lease_id': lease_id,
                            'input_outcome': receipt['outcome']}, identity, cleanup=True)
                        receipt['clipboard_cleanup'] = result
                    except Exception:
                        receipt['clipboard_cleanup'] = {'restored': False, 'error': 'CLEANUP_FAILED'}
                    try:
                        self.record(receipt)
                    except (OSError, sqlite3.Error):
                        receipt['journal_error'] = 'JOURNAL_UNAVAILABLE'
            finally:
                try:
                    with self.guard:
                        self.in_flight = None
                        if self.cancel.is_set() and self.current:
                            self.current['phase'] = 'stopped'
                            try:
                                self.save_session()
                            except (OSError, sqlite3.Error):
                                receipt['journal_error'] = 'JOURNAL_UNAVAILABLE'
                finally:
                    self.execution_lock.release()
                    try:
                        self.reply_to_stops()
                    finally:
                        if self.closed.is_set():
                            self.release_instance()

    def dispatch(self, op, value):
        try:
            if not isinstance(value, dict):
                raise ExecutionError('INVALID_REQUEST')
            handler = {'begin': self.begin, 'resume_draft': self.resume_draft,
                       'execute': self.execute, 'status': self.status, 'stop': self.stop}.get(op)
            if handler is None:
                raise ExecutionError('UNSUPPORTED_OPERATION')
            return handler(value)
        except Exception as error:
            return {'ok': False, 'error': str(error) if isinstance(error, ExecutionError) else type(error).__name__}

    def accept(self, packet):
        if packet.get('type') == 'heartbeat':
            self.heartbeat = self.clock()
        elif packet.get('type') == 'reply':
            with self.guard:
                waiter = self.pending.get(packet.get('id'))
            if waiter:
                waiter.put(packet)
        elif packet.get('type') == 'request':
            if packet.get('op') == 'stop':
                result = self.dispatch('stop', packet.get('value'))
                with self.guard:
                    if result.get('ok') and self.in_flight:
                        self.stop_waiters.append(packet.get('id'))
                        return
                    if result.get('ok'):
                        result = self.stop_result()
                self.emit({'type': 'reply', 'id': packet.get('id'), 'value': result})
            elif packet.get('op') == 'status':
                self.emit({'type': 'reply', 'id': packet.get('id'),
                           'value': self.dispatch('status', packet.get('value'))})
            else:
                try:
                    self.requests.put_nowait(packet)
                except queue.Full:
                    self.emit({'type': 'reply', 'id': packet.get('id'), 'value': {'ok': False, 'error': 'EXECUTOR_BUSY'}})

    def serve(self):
        self.emit({'type': 'ready', 'value': {'protocol': 'coloop-rk-executor-v1'}})
        while not self.closed.is_set():
            try:
                request = self.requests.get(timeout=.1)
            except queue.Empty:
                continue
            self.emit({'type': 'reply', 'id': request.get('id'),
                       'value': self.dispatch(request.get('op'), request.get('value'))})

    def close(self):
        self.closed.set()
        self.cancel.set()
        if self.execution_lock.acquire(blocking=False):
            self.execution_lock.release()
            self.release_instance()


def main():
    os.umask(0o077)
    root = Path(sys.argv[1]).expanduser().resolve()
    sys.path.insert(0, str(root / 'agent'))
    output_lock = threading.Lock()
    def emit(value):
        with output_lock:
            print(encode(value), flush=True)
    adapter = ExecutionAdapter(root, emit)
    worker = threading.Thread(target=adapter.serve, daemon=True)
    worker.start()
    try:
        for line in sys.stdin:
            if len(line.encode()) > 131072:
                raise ValueError('message_too_large')
            adapter.accept(parse(line))
    finally:
        adapter.close()
        worker.join(6)


if __name__ == '__main__':
    main()
