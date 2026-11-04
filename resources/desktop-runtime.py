"""Task-scoped RK runtime over an existing pinned SSH channel. No TCP listener."""
import json
from pathlib import Path
import queue
import re
import sys
import threading
import time
import uuid

MAX_LINE = 131072


class Stopped(Exception):
    pass


def interruptible_hid(controller_type, check):
    """Compose cancellation with the installed HID sender's optional report guard.

    Keep report timing, partial-write detection and neutral release in the native
    sender rather than duplicating its evolving device protocol here.
    """
    class InterruptibleHID(controller_type):
        def send(self, path, reports, neutral, report_check=None):
            def guarded(report):
                check()
                if report_check:
                    report_check(report)
            return super().send(path, reports, neutral, guarded)

    return InterruptibleHID()


def execute_hid_action(controller, action, validated, check, focus_check, wait):
    """Translate the desktop plan into complete native primitive requests."""
    check()
    if action['action'] == 'fill':
        controller.execute({'action': 'click', 'target_id': action['target_id']}, validated)
        wait(0.08)
        focus_check()
        check()
        controller.execute({'action': 'hotkey', 'keys': 'CTRL+A'}, validated)
        controller.execute({'action': 'type', 'text': action['text']}, validated)
    elif action['action'] == 'hotkey':
        # target_id belongs to the desktop focus permit, not the native chord.
        controller.execute({'action': 'hotkey', 'keys': action['keys']}, validated)
    else:
        controller.execute(action, validated)


class Runtime:
    def __init__(self, emit, execute, clock=time.monotonic):
        self.emit, self.execute, self.clock = emit, execute, clock
        self.stop = threading.Event()
        self.done = threading.Event()
        self.pending = {}
        self.guard = threading.Lock()
        self.last_heartbeat = clock()
        self.steps = 0
        self.sent = False
        self.started = clock()
        self.metrics = {'fullObservations': 0, 'planningCalls': 0, 'uiaChecks': 0,
                        'actions': 0, 'observationBytes': 0, 'elapsedMs': 0}

    def accept(self, message):
        if message.get('type') == 'heartbeat':
            self.last_heartbeat = self.clock()
        elif message.get('type') == 'stop':
            self.stop.set()
        elif message.get('type') == 'reply':
            with self.guard:
                pending = self.pending.get(message.get('id'))
            if pending:
                try:
                    pending.put_nowait(message)
                except queue.Full:
                    pass

    def check(self):
        if self.stop.is_set():
            raise Stopped()
        if self.clock() - self.last_heartbeat > 12:
            self.stop.set()
            raise Stopped()

    def rpc(self, operation, value=None):
        self.check()
        if operation == 'observe':
            self.metrics['fullObservations'] += 1
        elif operation == 'plan':
            self.metrics['planningCalls'] += 1
            self.metrics['observationBytes'] += len(json.dumps((value or {}).get('observation', {}), ensure_ascii=False).encode('utf-8'))
        elif operation in ('validate_batch', 'validate_next', 'validate_focus'):
            self.metrics['uiaChecks'] += 1
        request_id, result = uuid.uuid4().hex, queue.Queue(maxsize=1)
        with self.guard:
            self.pending[request_id] = result
        self.emit({'type': 'request', 'id': request_id, 'op': operation, 'value': value})
        deadline = self.clock() + (200 if operation == 'plan' else 25)
        try:
            while self.clock() < deadline:
                self.check()
                try:
                    response = result.get(timeout=0.1)
                    self.check()
                    if response.get('error'):
                        raise ValueError(response['error'])
                    return response.get('value')
                except queue.Empty:
                    pass
            raise TimeoutError('DESKTOP_REQUEST_TIMEOUT')
        finally:
            with self.guard:
                self.pending.pop(request_id, None)

    def phase(self, value, **extra):
        if value in ('completed', 'cancelled', 'failed'):
            self.metrics['elapsedMs'] = round((self.clock() - self.started) * 1000)
            extra['metrics'] = self.metrics
        self.emit({'type': 'state', 'phase': value, 'steps': self.steps, **extra})

    @staticmethod
    def compact(observed):
        targets = [target for target in observed.get('targets', []) if target.get('source') == 'uia'][:32]
        names = {''.join(str(target.get('name', '')).split()) for target in targets}
        texts = [str(target.get('name', '')) for target in observed.get('targets', [])
                 if target.get('source') == 'ocr' and ''.join(str(target.get('name', '')).split()) not in names]
        return {
            'observation_id': observed['observation_id'],
            'focused_control': observed.get('focused_control'),
            'targets': [{k: target[k] for k in ('id', 'name', 'type', 'value', 'focused') if k in target}
                        for target in targets],
            'screen_text': texts[:12],
        }

    @staticmethod
    def validate(plan, observed):
        if (not isinstance(plan, dict) or set(plan) != {'observation_id', 'actions'} or
                not isinstance(plan['actions'], list) or not 1 <= len(plan['actions']) <= 8):
            raise ValueError('INVALID_DESKTOP_ACTION')
        if plan['observation_id'] != observed['observation_id']:
            raise ValueError('STALE_DESKTOP_OBSERVATION')
        fields = {'click': {'target_id'}, 'fill': {'target_id', 'text'},
                  'hotkey': {'target_id', 'keys'}, 'wait': set(), 'finish': set()}
        for action in plan['actions']:
            kind = action.get('action')
            if kind not in fields or set(action) != {'action'} | fields[kind]:
                raise ValueError('INVALID_DESKTOP_ACTION')
            if 'target_id' in action:
                targets = [t for t in observed['targets'] if t['id'] == action['target_id']
                           and t.get('source') == 'uia']
                if type(action['target_id']) is not int or len(targets) != 1:
                    raise ValueError('UNKNOWN_DESKTOP_TARGET')
                if kind == 'fill' and targets[0]['type'] != 'Edit':
                    raise ValueError('UNKNOWN_DESKTOP_TARGET')
            if kind == 'fill' and (not isinstance(action['text'], str) or not 1 <= len(action['text']) <= 64
                                  or any(not 32 <= ord(c) <= 126 for c in action['text'])):
                raise ValueError('ASCII_INPUT_REQUIRED')
            if kind == 'hotkey' and (not isinstance(action['keys'], str) or not re.fullmatch(
                    r'(?:(?:CTRL|ALT|SHIFT)\+)*(?:[A-Z0-9]|F(?:[1-9]|1[0-2])|ENTER|ESC|BACKSPACE|TAB|SPACE|RIGHT|LEFT|DOWN|UP|HOME|END)', action['keys'])):
                raise ValueError('INVALID_DESKTOP_ACTION')
        return plan['actions']

    def run(self, config):
        self.started = self.clock()
        try:
            if (config.get('authorizeInput') is not True or
                    config.get('planner') not in ('rk', 'hybrid', 'auto') or
                    type(config.get('maxSteps')) is not int or not 1 <= config['maxSteps'] <= 20 or
                    not isinstance(config.get('expectedText'), str) or not config['expectedText'].strip()):
                raise ValueError('INVALID_DESKTOP_TASK')
            expected = ''.join(config['expectedText'].split())
            deadline = self.clock() + 600
            history = []
            while self.clock() < deadline:
                self.phase('observing' if not self.steps else 'verifying')
                observed = self.rpc('observe')
                if observed.get('window_open') is False:
                    raise ValueError('TARGET_WINDOW_CLOSED')
                if any(expected in ''.join(str(target.get('name', '')).split())
                       for target in observed.get('targets', [])):
                    if not self.steps:
                        raise ValueError('DESKTOP_RESULT_ALREADY_VISIBLE')
                    self.check()
                    self.phase('completed')
                    return
                if self.steps >= config['maxSteps']:
                    raise ValueError('DESKTOP_STEP_LIMIT')
                self.phase('planning')
                plan = self.rpc('plan', {'goal': config['goal'], 'expectedText': config['expectedText'],
                                          'planner': config['planner'], 'observation': self.compact(observed),
                                          'previous': history[-2:]})
                self.check()
                actions = self.validate(plan, observed)
                if any(action['action'] == 'finish' for action in actions):
                    raise ValueError('DESKTOP_RESULT_NOT_VERIFIED')
                self.steps += 1
                self.phase('validating')
                permit = self.rpc('validate_batch', plan)
                if permit.get('session_id') != config['observerSession']:
                    raise ValueError('DESKTOP_SESSION_CHANGED')
                self.phase('executing')
                for index, action in enumerate(actions):
                    self.check()
                    validated = self.rpc('validate_next', {'batch_id': permit['batch_id'], 'index': index})
                    if validated.get('session_id') != config['observerSession']:
                        raise ValueError('DESKTOP_SESSION_CHANGED')
                    if action['action'] == 'wait':
                        self.stop.wait(0.5)
                        continue
                    self.sent = True
                    try:
                        self.execute(action, validated, self.check)
                        self.metrics['actions'] += 1
                    except Stopped:
                        raise
                    except Exception:
                        raise ValueError('DESKTOP_INPUT_OUTCOME_UNKNOWN') from None
                    self.stop.wait(0.08)
                self.stop.wait(0.15)
                history.append({'actions': [{'action': a['action'], 'target_id': a.get('target_id')}
                                             for a in actions]})
            raise TimeoutError('DESKTOP_TASK_TIMEOUT')
        except Stopped:
            self.phase('cancelled', error='DESKTOP_STOPPED_AFTER_INPUT' if self.sent else None)
        except Exception as error:
            code = str(error)
            allowed = {'INVALID_DESKTOP_ACTION', 'STALE_DESKTOP_OBSERVATION', 'UNKNOWN_DESKTOP_TARGET',
                       'ASCII_INPUT_REQUIRED', 'DESKTOP_STEP_LIMIT', 'DESKTOP_RESULT_NOT_VERIFIED',
                       'DESKTOP_SESSION_CHANGED', 'TARGET_WINDOW_CLOSED', 'DESKTOP_TASK_TIMEOUT',
                       'DESKTOP_REQUEST_TIMEOUT', 'INVALID_DESKTOP_TASK', 'DESKTOP_INPUT_OUTCOME_UNKNOWN',
                       'DESKTOP_RESULT_ALREADY_VISIBLE', 'DESKTOP_WINDOW_NOT_FOUND',
                       'DESKTOP_WINDOW_AMBIGUOUS', 'DESKTOP_TARGET_CHANGED', 'DESKTOP_TARGET_UNAVAILABLE',
                       'DESKTOP_FOCUS_CHANGED', 'DESKTOP_WINDOW_NOT_FOREGROUND'}
            self.phase('failed', error=code if code in allowed else 'DESKTOP_EXECUTION_FAILED')
        finally:
            self.done.set()


def main():
    import fcntl
    root = Path(sys.argv[1]).expanduser().resolve()
    sys.path.insert(0, str(root / 'agent'))
    from hid import HIDController
    output_lock = threading.Lock()

    def emit(value):
        with output_lock:
            print(json.dumps(value, ensure_ascii=False), flush=True)

    def execute(action, validated, check):
        controller = interruptible_hid(HIDController, check)
        execute_hid_action(controller, action, validated, check,
                           lambda: runtime.rpc('validate_focus', {
                               'batch_id': validated['batch_id'], 'index': validated['index']}),
                           runtime.stop.wait)

    HIDController.node('hid.rk_keyboard')
    HIDController.node('hid.rk_mouse')
    # Hold the same device lock used by legacy desktop and credential inputs for
    # the whole task, including planning, rather than interleaving other writers.
    input_lock = (root / '.runtime/hid.lock').open('a')
    fcntl.flock(input_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    runtime = Runtime(emit, execute)
    worker = None
    emit({'type': 'ready', 'value': {'protocol': 1, 'hid': True}})
    try:
        for line in sys.stdin:
            if len(line.encode('utf-8')) > MAX_LINE:
                raise ValueError('INPUT_TOO_LARGE')
            message = json.loads(line)
            if message.get('type') == 'start' and worker is None:
                worker = threading.Thread(target=runtime.run, args=(message['value'],), daemon=True)
                worker.start()
            else:
                runtime.accept(message)
                if message.get('type') == 'stop' and worker is None:
                    runtime.phase('cancelled')
    finally:
        runtime.stop.set()
        if worker:
            worker.join(3)
        input_lock.close()


if __name__ == '__main__':
    main()
