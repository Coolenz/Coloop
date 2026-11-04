"""Read-only permits for taskbar -> same Chrome -> existing Bilibili home tab.

No Windows input, process launch, clipboard or browser automation APIs.
"""
import argparse
import contextlib
import ctypes
from ctypes import wintypes as w
import json
from pathlib import Path
import sys
import time
from urllib.parse import urlsplit
import uuid
import re

def page_verified(address, title, texts):
    parsed = urlsplit(address if "://" in address else "https://" + address)
    if (parsed.scheme != "https" or parsed.hostname not in ("www.bilibili.com", "bilibili.com")
            or parsed.path not in ("", "/", "/index.html") or parsed.username or parsed.password):
        return False
    if not any(s.lower() in title.lower() for s in ("bilibili", "哔哩哔哩")):
        return False
    # Address/title alone can appear on network errors. Require distinct page labels too.
    text = " ".join(texts)
    return sum(word in text for word in ("番剧", "动态", "投稿", "直播", "游戏中心")) >= 2


def icon_color_state(image):
    """Default Bilibili theme only. Ambiguous color is unknown, never inactive."""
    import numpy as np
    pixels = image[:, :, :3].astype(np.int16)
    blue, green, red = pixels[:, :, 0], pixels[:, :, 1], pixels[:, :, 2]
    pink = (red > 180) & (red > green * 1.3) & (blue > green * 1.15) & (blue > 80)
    cyan = (blue > 170) & (green > 100) & (blue > red * 1.5) & (green > red * 1.5)
    gray = (pixels.max(axis=2) - pixels.min(axis=2) < 20) & (pixels.max(axis=2) < 235) & (pixels.min(axis=2) > 40)
    if (pink | cyan).mean() > 0.025:
        return True
    if pink.mean() < 0.002 and gray.mean() > 0.025:
        return False
    return None


class BrowserObserver:
    def __init__(self, root, folder):
        self.root, self.folder = root, folder
        self.session = uuid.uuid4().hex
        self.initial = None
        self.next = 0
        self.active = None
        self.browser = None
        self.reader = None
        self.interaction = None
        self.selected_video = None
        self.engagement_receipts = []
        self.resume = None
        self.activation_count = 0
        self.home_clicked = False
        self.api = ctypes.windll.user32
        self.api.GetForegroundWindow.restype = w.HWND
        self.api.GetWindowTextW.argtypes = [w.HWND, w.LPWSTR, ctypes.c_int]
        self.api.GetClassNameW.argtypes = [w.HWND, w.LPWSTR, ctypes.c_int]
        self.api.GetWindowThreadProcessId.argtypes = [w.HWND, ctypes.POINTER(w.DWORD)]
        self.api.GetGUIThreadInfo.argtypes = [w.DWORD, ctypes.c_void_p]
        ctypes.windll.kernel32.OpenProcess.restype = w.HANDLE
        ctypes.windll.kernel32.QueryFullProcessImageNameW.argtypes = [w.HANDLE, w.DWORD, w.LPWSTR, ctypes.POINTER(w.DWORD)]
        ctypes.windll.kernel32.CloseHandle.argtypes = [w.HANDLE]

    def frame(self, handle=None):
        handle = handle or self.api.GetForegroundWindow()
        pid = w.DWORD()
        thread = self.api.GetWindowThreadProcessId(handle, ctypes.byref(pid))
        name, title = ctypes.create_unicode_buffer(256), ctypes.create_unicode_buffer(1024)
        self.api.GetClassNameW(handle, name, len(name))
        self.api.GetWindowTextW(handle, title, len(title))
        process = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid.value)
        if not process:
            raise ValueError("RELAY_PROCESS_UNAVAILABLE")
        try:
            path, size = ctypes.create_unicode_buffer(32768), w.DWORD(32768)
            if not ctypes.windll.kernel32.QueryFullProcessImageNameW(process, 0, path, ctypes.byref(size)):
                raise ValueError("RELAY_PROCESS_UNAVAILABLE")
            executable = Path(path.value).name.lower()
        finally:
            ctypes.windll.kernel32.CloseHandle(process)

        class GUI(ctypes.Structure):
            _fields_ = [("cbSize", w.DWORD), ("flags", w.DWORD),
                        ("active", w.HWND), ("focus", w.HWND), ("capture", w.HWND),
                        ("menu", w.HWND), ("move", w.HWND), ("caret", w.HWND), ("rect", w.RECT)]
        gui = GUI()
        gui.cbSize = ctypes.sizeof(gui)
        if not self.api.GetGUIThreadInfo(thread, ctypes.byref(gui)):
            raise ValueError("RELAY_FOCUS_UNAVAILABLE")
        return dict(handle=handle, pid=pid.value, executable=executable, window_class=name.value,
                    title=title.value, focus=gui.focus)

    @staticmethod
    def identity(frame):
        return [frame[k] for k in ("handle", "pid", "executable", "window_class", "focus")]

    def browser_window(self):
        if not self.browser:
            raise ValueError('RELAY_BROWSER_NOT_BOUND')
        from pywinauto import Desktop
        frame = self.frame(self.browser[0])
        if (frame['handle'], frame['pid']) != self.browser or frame['executable'] != 'chrome.exe':
            raise ValueError('RELAY_BROWSER_CHANGED')
        window = Desktop(backend='uia').window(handle=frame['handle']).wrapper_object()
        address = self.address_edit(window).get_value()
        url = urlsplit(address if '://' in address else 'https://' + address)
        if url.scheme != 'https' or url.hostname not in ('www.bilibili.com', 'bilibili.com'):
            raise ValueError('RELAY_WRONG_SITE')
        return frame, window, url

    @staticmethod
    def address_edit(window):
        # Focused Chrome omnibox chips and suggestion popups also expose Document.
        # Bind the large web viewport, then the unique toolbar Edit above it.
        bounds = window.rectangle()
        documents = [d for d in window.descendants(control_type='Document')
                     if d.is_visible() and d.rectangle().width() >= bounds.width() / 2
                     and d.rectangle().height() >= bounds.height() / 2]
        if not documents:
            raise ValueError('RELAY_DOCUMENT_NOT_READY')
        document = max(documents, key=lambda d: d.rectangle().width() * d.rectangle().height())
        top = document.rectangle().top
        edits = [e for e in window.descendants(control_type='Edit')
                 if e.is_visible() and e.rectangle().height() > 0
                 and bounds.top <= e.rectangle().top < e.rectangle().bottom <= top]
        if len(edits) != 1:
            raise ValueError('RELAY_ADDRESS_AMBIGUOUS')
        return edits[0]

    def interaction_snapshot(self, phase):
        frame, window, url = self.browser_window()
        video_id = re.fullmatch(r'/video/(BV[0-9A-Za-z]{10})/?', url.path)
        if phase not in ('choose_video', 'restore_video'):
            if not video_id or not self.selected_video or video_id[1] != self.selected_video:
                raise ValueError('RELAY_WRONG_VIDEO')
        targets, controls = [], {}
        labels = []
        bounds = window.rectangle()
        all_controls = window.descendants()
        for item in all_controls:
            try:
                rect = item.rectangle()
                if (item.element_info.control_type in ('Text', 'Hyperlink', 'Document')
                        and item.is_visible() and rect.bottom > bounds.top and rect.top < bounds.bottom):
                    labels.append(item.window_text())
            except Exception:
                pass
        coin_dialog = '1硬币' in labels and '2硬币' in labels
        favorite_dialog = any('添加到收藏夹' in t or '选择收藏夹' in t for t in labels)
        login_required = any(t.strip() in ('登录', '立即登录', '扫码登录') for t in labels[:45])
        video_titles = {}
        if phase == 'choose_video':
            for item in all_controls:
                try:
                    if item.element_info.control_type == 'Hyperlink':
                        value = item.legacy_properties().get('Value', '')
                        if '/video/BV' in value and item.rectangle().height() < 130:
                            video_titles[value] = item.window_text()
                except Exception:
                    pass
        for control in all_controls:
            try:
                if not control.is_visible() or not control.is_enabled():
                    continue
                name = control.window_text().strip()
                rect = control.rectangle()
                bounds = window.rectangle()
                if not (bounds.left <= rect.left < rect.right <= bounds.right
                        and bounds.top <= rect.top < rect.bottom <= bounds.bottom):
                    continue
                role, value, state = None, None, None
                if phase == 'choose_video' and control.element_info.control_type == 'Hyperlink':
                    value = control.legacy_properties().get('Value', '')
                    parsed = urlsplit(value)
                    match = re.fullmatch(r'/video/(BV[0-9A-Za-z]{10})/?', parsed.path)
                    if (parsed.hostname in ('www.bilibili.com', 'bilibili.com') and match
                            and value in video_titles and len(video_titles[value]) >= 5
                            and not re.search(r'广告|推广|好课上新|限时抢', video_titles[value])
                            and 130 <= rect.height() <= 400):
                        role = 'video'
                elif phase != 'choose_video':
                    legacy = control.legacy_properties()
                    help_text = legacy.get('Help', '') or ''
                    description = (name + ' ' + help_text).strip()
                    if control.element_info.control_type not in ('Button', 'Text', 'CheckBox', 'Group', 'RadioButton', 'ListItem'):
                        continue
                    patterns = {'like': r'点赞|取消点赞', 'coin': r'投币|已投币',
                                'favorite': r'收藏|取消收藏', 'confirm_coin': r'^确定|确认投币',
                                'confirm_favorite': r'^确定|完成', 'one_coin': r'^1硬币$|^1枚|^1个|投1枚',
                                'default_folder': r'^默认收藏夹\d*$'}
                    if phase in ('like', 'coin', 'favorite') and not help_text:
                        continue
                    if re.search(patterns.get(phase, r'(?!)'), description) and rect.top > bounds.top + 180:
                        role = phase
                        name = description[:160]
                        if re.search(r'取消点赞|已点赞|已投币|取消收藏|已收藏', description):
                            state = True
                        else:
                            try:
                                state = bool(control.iface_toggle.CurrentToggleState)
                            except Exception:
                                pass
                        if phase in ('like', 'coin', 'favorite') and help_text:
                            visual = self.icon_state(control, frame)
                            if state is None:
                                state = visual
                            elif visual is not None and state != visual:
                                state = None
                        elif phase == 'one_coin':
                            state = self.icon_state(control, frame)
                        elif phase == 'default_folder' and control.element_info.control_type == 'ListItem':
                            state = self.icon_state(control, frame)
                        if phase == 'default_folder' and control.element_info.control_type != 'ListItem':
                            continue
                        if phase == 'confirm_coin' and not coin_dialog:
                            continue
                if role:
                    identifier = len(targets)
                    targets.append(dict(id=identifier, name=name[:160], role=role, value=value,
                                        state=state, title=video_titles.get(value)))
                    controls[identifier] = dict(control=control, runtime_id=str(control.element_info.runtime_id),
                        rect=[rect.left, rect.top, rect.right, rect.bottom], name=control.window_text(),
                        role=role, url=value)
                    if len(targets) >= 16:
                        break
            except Exception:
                continue
        observation_id = uuid.uuid4().hex
        if (coin_dialog or favorite_dialog) and phase in ('like', 'coin', 'favorite'):
            targets, controls = [], {}
        self.interaction = dict(observation_id=observation_id, phase=phase, controls=controls,
                                at=time.monotonic(), consumed=False, frame=frame)
        return dict(observation_id=observation_id, phase=phase, targets=targets,
                    browser_handle=frame['handle'], browser_pid=frame['pid'], input_mode='mouse_same_window',
                    login_required=login_required if phase != 'choose_video' else False,
                    foreground=self.api.GetForegroundWindow() == frame['handle'],
                    address=url.geturl(), video_id=video_id[1] if video_id else None,
                    screen_text=labels[:60], dialog='coin' if coin_dialog else 'favorite' if favorite_dialog else None,
                    coin_quantity=self.coin_quantity(window) if coin_dialog else None)

    def default_folder_selected(self, window, frame):
        controls = [c for c in window.descendants(control_type='ListItem')
                    if re.fullmatch(r'默认收藏夹\d*', c.window_text())]
        return len(controls) == 1 and self.icon_state(controls[0], frame) is True

    def coin_quantity(self, window):
        texts = window.descendants(control_type='Text')
        markers = [c for c in texts if c.window_text().strip() == '枚硬币']
        if len(markers) != 1:
            return None
        marker = markers[0].rectangle()
        values = []
        for c in texts:
            if c.window_text().strip() not in ('1', '2'):
                continue
            rect = c.rectangle()
            if (abs((rect.top + rect.bottom) - (marker.top + marker.bottom)) < 50
                    and -8 <= marker.left - rect.right < 100):
                values.append(int(c.window_text().strip()))
        return values[0] if len(values) == 1 else None

    def icon_state(self, control, frame):
        if self.api.GetForegroundWindow() != frame['handle']:
            return None
        from screen_ocr import capture
        rect = control.rectangle()
        image, _ = capture(region=[rect.left, rect.top, min(60, rect.width()), rect.height()])
        if self.api.GetForegroundWindow() != frame['handle']:
            return None
        return icon_color_state(image)

    def interaction_permit(self, body):
        observed = self.interaction
        if (not observed or observed['consumed'] or time.monotonic() - observed['at'] > 90
                or body.get('observation_id') != observed['observation_id']
                or set(body) != {'observation_id', 'target_id'}
                or type(body['target_id']) is not int or body['target_id'] not in observed['controls']):
            raise ValueError('RELAY_INTERACTION_STALE')
        target = observed['controls'][body['target_id']]
        frame, _, _ = self.browser_window()
        if self.api.GetForegroundWindow() != frame['handle']:
            raise ValueError('RELAY_BROWSER_NOT_FOREGROUND')
        if target['role'] in ('like', 'coin', 'favorite'):
            if self.icon_state(target['control'], frame) is not False:
                raise ValueError('RELAY_ENGAGEMENT_STATE_CHANGED')
        if target['role'] == 'confirm_coin':
            _, window, _ = self.browser_window()
            if self.coin_quantity(window) != 1:
                raise ValueError('RELAY_ONE_COIN_REQUIRED')
        if target['role'] == 'confirm_favorite':
            frame, window, _ = self.browser_window()
            if not self.default_folder_selected(window, frame):
                raise ValueError('RELAY_DEFAULT_FOLDER_REQUIRED')
        self.validate_pointer(target)
        observed['consumed'] = True
        if target['role'] == 'video':
            self.selected_video = re.search(r'/video/(BV[0-9A-Za-z]{10})', target['url'])[1]
        import mss
        with mss.MSS() as screen:
            if len(screen.monitors) != 2:
                raise ValueError('RELAY_SINGLE_DISPLAY_REQUIRED')
            monitor = screen.monitors[1]
            mapping = [monitor[k] for k in ('left', 'top', 'width', 'height')]
        center = target['point']
        token = uuid.uuid4().hex
        self.active = dict(token=token, identity=self.identity(frame),
                           expires=time.monotonic() + 12, target=target, center=center)
        return dict(token=token, session_id=self.session, center=center, screen=mapping,
                    action={'action': 'click', 'target_id': body['target_id']})

    def validate_pointer(self, target):
        if target['role'] == 'activate_browser' and not target['control'].is_selected():
            raise ValueError('RELAY_TARGET_CHANGED')
        if target['role'] == 'confirm_coin':
            _, window, _ = self.browser_window()
            if self.coin_quantity(window) != 1:
                raise ValueError('RELAY_ONE_COIN_REQUIRED')
        if target['role'] == 'confirm_favorite':
            frame, window, _ = self.browser_window()
            if not self.default_folder_selected(window, frame):
                raise ValueError('RELAY_DEFAULT_FOLDER_REQUIRED')
        control = target['control']
        rect = control.rectangle()
        if (str(control.element_info.runtime_id) != target['runtime_id']
                or control.window_text() != target['name'] or not control.is_visible()
                or not control.is_enabled()
                or [rect.left, rect.top, rect.right, rect.bottom] != target['rect']):
            raise ValueError('RELAY_TARGET_CHANGED')
        self.api.WindowFromPoint.restype = w.HWND
        self.api.GetAncestor.restype = w.HWND
        hit = self.api.WindowFromPoint(w.POINT((rect.left + rect.right)//2, (rect.top + rect.bottom)//2))
        root_handle = target['root_handle'] if 'root_handle' in target else self.browser[0]
        if target.get('root_identity'):
            root_frame = self.frame(root_handle)
            if self.identity(root_frame)[:4] != target['root_identity']:
                raise ValueError('RELAY_TARGET_CHANGED')
        if self.api.GetAncestor(w.HWND(hit), 2) != root_handle:
            raise ValueError('RELAY_TARGET_OCCLUDED')
        from pywinauto.uia_defines import IUIA
        from comtypes.gen.UIAutomationClient import tagPOINT
        def matches(point):
            node = IUIA().iuia.ElementFromPoint(tagPOINT(*point))
            for _ in range(8):
                if not node:
                    return False
                if str(tuple(node.GetRuntimeId())) == target['runtime_id']:
                    return True
                node = IUIA().iuia.ControlViewWalker.GetParentElement(node)
            return False
        candidates = [target['point']] if 'point' in target else [
            [(rect.left + rect.right)//2, (rect.top + rect.bottom)//2],
            [rect.left + rect.width()//3, rect.top + rect.height()//3],
            [rect.left + 8, rect.top + 8]]
        for point in candidates:
            if matches(point):
                target['point'] = point
                return
        raise ValueError('RELAY_TARGET_HITTEST_FAILED')

    def chrome_candidates(self):
        from pywinauto import Desktop
        return [self.frame(window.handle) for window in
                Desktop(backend='win32').windows(class_name='Chrome_WidgetWin_1')
                if window.window_text() and self.frame(window.handle)['executable'] == 'chrome.exe']

    def mouse_snapshot(self, phase):
        from pywinauto import Desktop
        if phase not in ('open_chrome', 'home_tab'):
            raise ValueError('RELAY_MOUSE_PHASE_REJECTED')
        candidates = self.chrome_candidates()
        if len(candidates) > 1:
            raise ValueError('RELAY_BROWSER_AMBIGUOUS')
        if self.browser:
            if not candidates or (candidates[0]['handle'], candidates[0]['pid']) != self.browser:
                raise ValueError('RELAY_BROWSER_CHANGED')
        elif candidates:
            self.browser = candidates[0]['handle'], candidates[0]['pid']
        foreground = self.frame()
        if phase == 'open_chrome':
            bars = Desktop(backend='win32').windows(class_name='Shell_TrayWnd')
            if len(bars) != 1:
                raise ValueError('RELAY_TASKBAR_AMBIGUOUS')
            root_frame = self.frame(bars[0].handle)
            if root_frame['executable'] != 'explorer.exe':
                raise ValueError('RELAY_TASKBAR_CHANGED')
            window = Desktop(backend='uia').window(handle=bars[0].handle).wrapper_object()
            controls = [c for c in window.descendants(control_type='Button')
                        if re.fullmatch(r'(?:Google Chrome|谷歌浏览器)(?:\s*-.*)?', c.window_text())
                        and c.is_visible() and c.is_enabled()]
            role = 'chrome_icon'
        else:
            if not self.browser:
                raise ValueError('RELAY_BROWSER_NOT_READY')
            root_frame = self.frame(self.browser[0])
            window = Desktop(backend='uia').window(handle=self.browser[0]).wrapper_object()
            controls = [c for c in window.descendants(control_type='TabItem')
                        if re.fullmatch(r'哔哩哔哩\s*\(゜-゜\)つロ\s*干杯[~～-]*bilibili', c.window_text())
                        and c.is_visible() and c.is_enabled()]
            role = 'home_tab'
        if len(controls) != 1:
            raise ValueError('RELAY_MOUSE_TARGET_UNAVAILABLE')
        control = controls[0]
        rect = control.rectangle()
        target = dict(control=control, runtime_id=str(control.element_info.runtime_id),
                      rect=[rect.left, rect.top, rect.right, rect.bottom], name=control.window_text(),
                      role=role, root_handle=root_frame['handle'],
                      root_identity=self.identity(root_frame)[:4])
        observation_id = uuid.uuid4().hex
        self.interaction = dict(observation_id=observation_id, phase=phase, controls={0: target},
                                at=time.monotonic(), consumed=False, frame=foreground)
        return dict(observation_id=observation_id, phase=phase,
                    targets=[dict(id=0, name=target['name'], role=role)],
                    browser_handle=self.browser[0] if self.browser else None,
                    foreground=bool(self.browser and foreground['handle'] == self.browser[0]),
                    input_mode='mouse_same_window')

    def mouse_permit(self, body):
        observed = self.interaction
        if (not observed or set(body) != {'observation_id', 'target_id'}
                or body['observation_id'] != observed['observation_id']
                or type(body['target_id']) is not int or body['target_id'] != 0
                or observed['phase'] not in ('open_chrome', 'home_tab')
                or observed['consumed'] or time.monotonic() - observed['at'] > 90):
            raise ValueError('RELAY_INTERACTION_STALE')
        frame = self.frame()
        if self.identity(frame) != self.identity(observed['frame']):
            raise ValueError('RELAY_INITIAL_FOCUS_CHANGED')
        if observed['phase'] == 'open_chrome' and self.browser and frame['handle'] == self.browser[0]:
            raise ValueError('RELAY_ALREADY_FOREGROUND')  # taskbar click would minimize it
        if observed['phase'] == 'home_tab' and frame['handle'] != self.browser[0]:
            raise ValueError('RELAY_BROWSER_NOT_FOREGROUND')
        target = observed['controls'][0]
        self.validate_pointer(target)
        import mss
        with mss.MSS() as screen:
            if len(screen.monitors) != 2:
                raise ValueError('RELAY_SINGLE_DISPLAY_REQUIRED')
            mapping = [screen.monitors[1][k] for k in ('left', 'top', 'width', 'height')]
        observed['consumed'] = True
        if observed['phase'] == 'home_tab':
            self.home_clicked = True
        token = uuid.uuid4().hex
        self.active = dict(token=token, identity=self.identity(frame), expires=time.monotonic() + 12,
                           target=target, center=target['point'])
        return dict(token=token, session_id=self.session, screen=mapping, center=target['point'],
                    action={'action': 'click', 'target_id': 0})

    def call(self, op, body):
        if op == "observe":
            if self.initial or self.next:
                raise ValueError("RELAY_NO_RESTART")
            import mss
            with mss.MSS() as capture:
                if len(capture.monitors) != 2:
                    raise ValueError("RELAY_SINGLE_DISPLAY_REQUIRED")
            if self.api.GetKeyState(0x14) & 1:
                raise ValueError("RELAY_CAPSLOCK_ON")
            if self.resume:
                self.initial = self.frame(self.resume['handle'])
                self.browser = self.initial['handle'], self.initial['pid']
                self.selected_video = self.resume['video_id']
                _, _, url = self.browser_window()
                self.next = 4
                return {'resuming_video': True, 'video_id': self.selected_video, 'session_id': self.session,
                        'video_mismatch': url.path.strip('/') != 'video/' + self.selected_video}
            self.initial = self.frame()
            if self.initial["window_class"] == "#32770":
                raise ValueError("RELAY_EXISTING_DIALOG")
            return {"session_id": self.session, "state": "ready", "browser": "Chrome",
                    "input_backend": "rk_usb_hid", "input_mode": "mouse_same_window",
                    "ocr": "taskbar Chrome icon and bound existing Chrome only"}
        if op == 'mouse_observe':
            return self.mouse_snapshot(body['phase'])
        if op == 'mouse_permit':
            return self.mouse_permit(body)
        if op in ('permit', 'navigation_permit'):
            raise ValueError('RELAY_MOUSE_ONLY')
        if op == "guard":
            if (not self.active or body != {"token": self.active["token"]}
                    or time.monotonic() > self.active["expires"]
                    or self.identity(self.frame()) != self.active["identity"]):
                self.active = None
                raise ValueError("RELAY_GUARD_CHANGED")
            if self.active.get('address_focus'):
                from pywinauto.uia_defines import IUIA
                focus = IUIA().iuia.GetFocusedElement()
                if not focus or str(tuple(focus.GetRuntimeId())) != self.active['address_focus']:
                    raise ValueError('RELAY_ADDRESS_FOCUS_CHANGED')
            if self.active.get('target'):
                self.validate_pointer(self.active['target'])
            return {"valid": True, "session_id": self.session}
        if op == 'activate_permit':
            observed = self.interaction
            if (not observed or body != {'observation_id': observed['observation_id']}
                    or observed['consumed'] or time.monotonic() - observed['at'] > 90
                    or self.activation_count >= 12):
                raise ValueError('RELAY_ACTIVATION_REJECTED')
            _, window, _ = self.browser_window()
            if self.api.GetForegroundWindow() == self.browser[0]:
                raise ValueError('RELAY_ALREADY_FOREGROUND')
            frame = self.frame()
            observed['consumed'] = True
            # A visible selected tab can bring the exact Chrome to foreground
            # without cycling unrelated windows or changing its selected page.
            tabs = [c for c in window.descendants(control_type='TabItem')
                    if c.is_visible() and c.is_enabled() and c.is_selected()]
            if len(tabs) == 1:
                tab = tabs[0]
                rect = tab.rectangle()
                target = dict(control=tab, runtime_id=str(tab.element_info.runtime_id),
                    rect=[rect.left, rect.top, rect.right, rect.bottom], name=tab.window_text(),
                    role='activate_browser')
                try:
                    self.validate_pointer(target)
                except ValueError:
                    pass  # Occluded tab: use bounded system window switching below.
                else:
                    import mss
                    with mss.MSS() as screen:
                        if len(screen.monitors) != 2:
                            raise ValueError('RELAY_SINGLE_DISPLAY_REQUIRED')
                        mapping = [screen.monitors[1][k] for k in ('left', 'top', 'width', 'height')]
                    token = uuid.uuid4().hex
                    self.activation_count += 1
                    center = target['point']
                    self.active = dict(token=token, identity=self.identity(frame),
                        expires=time.monotonic() + 3, target=target, center=center)
                    return dict(token=token, session_id=self.session, center=center, screen=mapping,
                                action={'action': 'click', 'target_id': 0})
            raise ValueError('RELAY_MOUSE_ACTIVATION_TARGET_UNAVAILABLE')
        if op == 'interact_observe':
            if not isinstance(body, dict) or set(body) != {'phase'}:
                raise ValueError('RELAY_INTERACTION_REJECTED')
            return self.interaction_snapshot(body['phase'])
        if op == 'interact_permit':
            return self.interaction_permit(body)
        if op == 'interact_verify':
            phase = body.get('phase') if isinstance(body, dict) else None
            if phase not in ('like', 'coin', 'favorite', 'all'):
                raise ValueError('RELAY_INTERACTION_REJECTED')
            phases = ('like', 'coin', 'favorite') if phase == 'all' else (phase,)
            states = {}
            for item in phases:
                snapshot = self.interaction_snapshot(item)
                states[item] = bool(snapshot['targets']) and any(t.get('state') is True for t in snapshot['targets'])
            return dict(verified=all(states.values()), states=states, video_id=self.selected_video,
                        browser_handle=self.browser[0], browser_pid=self.browser[1], input_mode='mouse_same_window')
        if op == "verify":
            self.active = None
            if not self.home_clicked or not self.browser:
                raise ValueError('RELAY_NOT_EXECUTED')
            from pywinauto import Desktop
            frame = self.frame(self.browser[0])
            if (frame['handle'], frame['pid']) != self.browser or frame['executable'] != 'chrome.exe':
                raise ValueError('RELAY_BROWSER_CHANGED')
            window = Desktop(backend="uia").window(handle=frame["handle"]).wrapper_object()
            try:
                address = self.address_edit(window).get_value()
            except ValueError as error:
                if str(error) == 'RELAY_DOCUMENT_NOT_READY':
                    return {'verified': False, 'state': 'waiting_for_document'}
                raise
            texts = [t.window_text()[:128] for t in window.descendants()
                     if t.element_info.control_type in ("Text", "Hyperlink", "Document")][:40]
            if self.frame(frame["handle"])["pid"] != frame["pid"]:
                raise ValueError("RELAY_BROWSER_IDENTITY_CHANGED")
            foreground = self.api.GetForegroundWindow() == frame["handle"]
            source = "fresh_uia"
            if foreground:
                from screen_ocr import ScreenOCR, capture
                if self.reader is None:
                    self.reader = ScreenOCR()
                rect = window.rectangle()
                if self.api.GetForegroundWindow() == frame["handle"]:
                    image, origin = capture(region=[rect.left, rect.top, rect.width(), rect.height()])
                    recognized = self.reader.read(image, origin)
                    if self.api.GetForegroundWindow() == frame["handle"]:
                        texts += [t["text"][:128] for t in recognized["items"][:32]
                                  if t["confidence"] >= 0.85]
                        source = "fresh_uia_and_ocr"
            return {"verified": page_verified(address, frame["title"], texts),
                    "address": address, "window": frame["title"], "screen_text": texts,
                    "foreground": foreground, "new_chrome_window": False, "browser_handle": frame["handle"], "browser_pid": frame["pid"], "input_mode": "mouse_same_window", "source": source}
        raise ValueError("RELAY_UNKNOWN_OPERATION")


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stdin.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--folder", type=Path, required=True)
    parser.add_argument("--title", required=True)
    parser.add_argument('--resume-window', type=int)
    parser.add_argument('--resume-video')
    args = parser.parse_args()
    if args.title != "Chrome → Bilibili":
        raise ValueError("RELAY_SCOPE_REJECTED")
    sys.path.insert(0, str(args.root / "agent"))
    sys.path.insert(0, str(args.root / "pc"))
    sys.path.insert(0, str(args.root.parent / "tools"))
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
    from comtypes import CoInitialize
    CoInitialize()
    observer = BrowserObserver(args.root, args.folder)
    if args.resume_window or args.resume_video:
        if not args.resume_window or not re.fullmatch(r'BV[0-9A-Za-z]{10}', args.resume_video or ''):
            raise ValueError('RELAY_RESUME_REJECTED')
        observer.resume = {'handle': args.resume_window, 'video_id': args.resume_video}

    def emit(value):
        print(json.dumps(value, ensure_ascii=False), flush=True)

    emit({"type": "ready", "value": {"session_id": observer.session}})
    for line in sys.stdin:
        if len(line.encode()) > 131072:
            raise ValueError("RELAY_INPUT_LIMIT")
        packet = json.loads(line)
        try:
            with contextlib.redirect_stdout(sys.stderr):
                result = observer.call(packet["op"], packet.get("value"))
            emit({"type": "reply", "id": packet["id"], "value": result})
        except Exception as error:
            code = str(error)
            emit({"type": "reply", "id": packet["id"],
                  "error": code if code.startswith("RELAY_") else "RELAY_OBSERVATION_FAILED"})


if __name__ == "__main__":
    main()
