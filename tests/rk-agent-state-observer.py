"""QA-only synthetic phase projection. Read-only UIA/guard for one instrumented native lab."""
import ctypes
import importlib.util
import json
from pathlib import Path
import sys
import time
import uuid

ctypes.windll.shcore.SetProcessDpiAwareness(2)
spec = importlib.util.spec_from_file_location('browser', Path(__file__).resolve().parents[1] / 'resources/browser-observer.py')
browser = importlib.util.module_from_spec(spec)
spec.loader.exec_module(browser)
observer = browser.BrowserObserver(Path('D:/RK/rk-opencode'), Path(sys.argv[1]))
config = json.loads(Path(sys.argv[2]).read_text(encoding='utf-8'))
pid = int(sys.argv[3])
latest = None


def window():
    from pywinauto import Desktop
    matches = [w for w in Desktop(backend='uia').windows(process=pid) if w.window_text() == config['title']]
    if len(matches) != 1:
        raise ValueError('QA_WINDOW_AMBIGUOUS_' + str(len(matches)))
    item = matches[0]
    frame = observer.frame(item.handle)
    if (frame['pid'] != pid or frame['executable'] != 'agentstatelab.exe'
            or observer.api.GetForegroundWindow() != frame['handle']):
        raise ValueError('QA_FOREGROUND_OR_PROCESS_CHANGED')
    return item, frame


def observe(phase):
    global latest
    item, frame = window()
    controls = [c for c in item.descendants(control_type='Button') if c.window_text() == 'Apply' and c.is_visible()]
    if len(controls) != 1 or phase not in ('open_chrome', 'home_tab'):
        raise ValueError('QA_TARGET_OR_PHASE_INVALID')
    control = controls[0]
    rect = control.rectangle()
    target = {'control': control, 'runtime_id': str(control.element_info.runtime_id),
              'rect': [rect.left, rect.top, rect.right, rect.bottom], 'name': control.window_text(),
              'role': 'qa_apply', 'root_handle': frame['handle'], 'root_identity': observer.identity(frame)[:4]}
    observer.validate_pointer(target)
    latest = {'observation_id': uuid.uuid4().hex, 'phase': phase, 'at': time.monotonic(),
              'target': target, 'consumed': False}
    return {'observation_id': latest['observation_id'], 'phase': phase,
            'browser_handle': frame['handle'], 'browser_pid': frame['pid'],
            'foreground': phase != 'open_chrome',
            'targets': [{'id': 0, 'name': 'QA Apply button (not Chrome)',
                         'role': 'chrome_icon' if phase == 'open_chrome' else 'home_tab'}],
            'evidence_scope': 'synthetic_native_lab_not_bilibili'}


def call(op, body):
    if op == 'observe':
        window()
        return {'evidence_scope': 'synthetic_native_lab_not_bilibili'}
    if op == 'mouse_observe':
        return observe(body['phase'])
    if op == 'mouse_permit':
        if (not latest or latest['consumed'] or time.monotonic() - latest['at'] > 5
                or body != {'observation_id': latest['observation_id'], 'target_id': 0}):
            raise ValueError('QA_OBSERVATION_STALE')
        _, frame = window()
        observer.validate_pointer(latest['target'])
        latest['consumed'] = True
        import mss
        with mss.MSS() as screen:
            if len(screen.monitors) != 2:
                raise ValueError('QA_SINGLE_DISPLAY_REQUIRED')
            mapping = [screen.monitors[1][k] for k in ('left', 'top', 'width', 'height')]
        token = uuid.uuid4().hex
        observer.active = {'token': token, 'identity': observer.identity(frame),
                           'expires': time.monotonic() + 12, 'target': latest['target']}
        return {'token': token, 'session_id': observer.session, 'screen': mapping,
                'center': latest['target']['point'], 'action': {'action': 'click', 'target_id': 0}}
    if op == 'guard':
        window()
        return observer.call('guard', body)
    if op == 'verify':
        item, frame = window()
        state = json.loads((Path(sys.argv[1]) / 'fixture-state.json').read_text(encoding='utf-8-sig'))
        visible = [c.window_text() for c in item.descendants(control_type='Text')]
        return {'verified': state['clicks'] == 2 and any(t.strip() == 'Applied:' for t in visible),
                'address': 'https://www.bilibili.com/', 'browser_handle': frame['handle'],
                'browser_pid': frame['pid'], 'input_mode': 'mouse_same_window',
                'evidence_scope': 'synthetic_native_lab_not_bilibili', 'lab_clicks': state['clicks']}
    raise ValueError('QA_UNKNOWN_OPERATION')


print(json.dumps({'ready': True, 'session_id': observer.session}), flush=True)
for line in sys.stdin:
    try:
        request = json.loads(line)
        result = {'ok': True, 'value': call(request['op'], request.get('value'))}
    except Exception as error:
        result = {'ok': False, 'error': str(error)}
    print(json.dumps(result, ensure_ascii=True), flush=True)
