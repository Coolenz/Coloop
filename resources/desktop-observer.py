"""Private stdio adapter for the existing window observer. Never injects input."""
import argparse
import contextlib
import ctypes
from ctypes import wintypes
import json
from pathlib import Path
import sys
import time
import uuid


class BatchObserver:
    """Consume one observation per batch; subsequent checks are UIA-only, no OCR."""
    def __init__(self, observer):
        self.observer = observer
        self.batch = None

    def fast_snapshot(self):
        engine = self.observer.ocr
        try:
            self.observer.ocr = None
            return self.observer.snapshot()
        finally:
            self.observer.ocr = engine

    @staticmethod
    def frame(old, live):
        if (old['_handle'] != live['_handle'] or old['rect'] != live['rect'] or
                old['screen'] != live['screen']):
            raise ValueError('Window or display changed during batch')

    @staticmethod
    def target(old, live, target_id):
        candidates = [t for t in old['targets'] if t['id'] == target_id and t.get('source') == 'uia']
        if len(candidates) != 1:
            raise ValueError('Batch input requires a unique UIA target')
        original = candidates[0]
        matches = [t for t in live['targets'] if t.get('_runtime_id') == original.get('_runtime_id')
                   and all(t.get(k) == original.get(k) for k in ('name', 'type', 'rect', 'source'))]
        if len(matches) != 1 or not matches[0]['enabled'] or matches[0].get('_occluded'):
            raise ValueError('Target changed or is covered')
        return matches[0]

    def call(self, op, body=None):
        try:
            return self._call(op, body)
        except Exception:
            self.batch = None
            raise

    def _call(self, op, body=None):
        if op == 'observe':
            self.batch = None
            return self.observer.measured_call('/observe', None)
        if op == 'validate_batch':
            self.batch = None
            old = self.observer.registry.latest
            if (not old or old['observation_id'] != body['observation_id'] or old['_consumed'] or
                    time.monotonic() - old['_at'] > self.observer.registry.ttl):
                raise ValueError('Old or consumed observation')
            live = self.fast_snapshot()
            self.frame(old, live)
            for action in body['actions']:
                if 'target_id' in action:
                    target = self.target(old, live, action['target_id'])
                    if action['action'] == 'fill' and target['type'] != 'Edit':
                        raise ValueError('Fill requires an Edit')
            old['_consumed'] = True
            self.batch = {'id': uuid.uuid4().hex, 'old': old, 'actions': body['actions'],
                          'next': 0, 'active': None, 'focus_checked': False,
                          'expires': time.monotonic() + 45}
            return {'batch_id': self.batch['id'], 'session_id': self.observer.registry.session_id}
        batch = self.batch
        if (not batch or body['batch_id'] != batch['id'] or time.monotonic() > batch['expires']):
            raise ValueError('Unknown or expired batch')
        index = body['index']
        if type(index) is not int or not 0 <= index < len(batch['actions']):
            raise ValueError('Invalid batch index')
        if op == 'validate_next' and index != batch['next']:
            raise ValueError('Consumed or out-of-order batch action')
        if op == 'validate_focus' and (batch['active'] != index or batch['focus_checked']):
            raise ValueError('Fill focus check already consumed')
        if op not in ('validate_next', 'validate_focus'):
            raise ValueError('Unsupported batch operation')
        live = self.fast_snapshot()
        self.frame(batch['old'], live)
        action = batch['actions'][index]
        result = {'batch_id': batch['id'], 'index': index, 'screen': live['screen'],
                  'session_id': self.observer.registry.session_id}
        if 'target_id' in action:
            target = self.target(batch['old'], live, action['target_id'])
            rect = target['rect']
            result['center'] = [(rect[0] + rect[2]) // 2, (rect[1] + rect[3]) // 2]
            if action['action'] == 'hotkey' or op == 'validate_focus':
                if live.get('_focus') != target.get('_runtime_id'):
                    raise ValueError('Input focus changed')
        if op == 'validate_next':
            batch['next'] += 1
            batch['active'] = index
            batch['focus_checked'] = False
        else:
            if action['action'] != 'fill' or live.get('_focus_type') != 'Edit':
                raise ValueError('Expected focused Edit')
            batch['focus_checked'] = True
        return result


def windows():
    user32 = ctypes.windll.user32
    user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    result = []
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def visit(handle, _):
        if user32.IsWindowVisible(handle):
            title = ctypes.create_unicode_buffer(512)
            user32.GetWindowTextW(handle, title, 512)
            if title.value and title.value != 'Coloop':
                result.append(title.value)
        return True

    user32.EnumWindows(callback_type(visit), 0)
    return result


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def main():
    sys.stdout.reconfigure(encoding='utf-8', errors='strict')
    sys.stdin.reconfigure(encoding='utf-8', errors='strict')
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--title')
    parser.add_argument('--folder', required=True)
    parser.add_argument('--list', action='store_true')
    args = parser.parse_args()
    if args.list:
        emit({'type': 'ready', 'value': sorted(set(windows()))})
        return
    sys.path.insert(0, str(Path(args.root) / 'pc'))
    with contextlib.redirect_stdout(sys.stderr):
        from observer import Observer
        from comtypes import CoInitialize
        CoInitialize()
        observer = Observer(args.title, True, Path(args.folder), persist_images=False)
        batches = BatchObserver(observer)
    emit({'type': 'ready', 'value': {'session_id': observer.registry.session_id}})
    for line in sys.stdin:
        message = json.loads(line)
        try:
            count = windows().count(args.title)
            if count == 0:
                raise ValueError('DESKTOP_WINDOW_NOT_FOUND')
            if count != 1:
                raise ValueError('DESKTOP_WINDOW_AMBIGUOUS')
            if message.get('op') not in ('observe', 'validate_batch', 'validate_next', 'validate_focus'):
                raise ValueError('Unsupported observation operation')
            with contextlib.redirect_stdout(sys.stderr):
                value = batches.call(message['op'], message.get('value'))
            emit({'type': 'reply', 'id': message['id'], 'value': value})
        except Exception as error:
            code = str(error)
            mapped = {
                'Target changed or is covered': 'DESKTOP_TARGET_CHANGED',
                'Batch input requires a unique UIA target': 'DESKTOP_TARGET_UNAVAILABLE',
                'Input focus changed': 'DESKTOP_FOCUS_CHANGED',
                'The allowed window must be foreground; switch to it and observe again': 'DESKTOP_WINDOW_NOT_FOREGROUND',
                'Foreground changed during capture': 'DESKTOP_WINDOW_NOT_FOREGROUND',
            }
            if code not in ('DESKTOP_WINDOW_NOT_FOUND', 'DESKTOP_WINDOW_AMBIGUOUS'):
                code = mapped.get(code, 'DESKTOP_WINDOW_CHANGED')
            emit({'type': 'reply', 'id': message['id'], 'error': code})


if __name__ == '__main__':
    main()
