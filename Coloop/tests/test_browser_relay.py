import importlib.util
from pathlib import Path
import unittest
from unittest.mock import Mock, patch


def module(name):
    path = Path(__file__).resolve().parents[1] / 'resources' / (name + '.py')
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


observer = module('browser-observer')
runtime = module('browser-runtime')


class BrowserRelayTests(unittest.TestCase):
    def test_mouse_workflow_refuses_multiple_or_replaced_chrome_windows(self):
        obj = observer.BrowserObserver.__new__(observer.BrowserObserver)
        obj.browser = (1, 2)
        obj.chrome_candidates = Mock(return_value=[{'handle': 1, 'pid': 2}, {'handle': 3, 'pid': 2}])
        with patch.dict('sys.modules', {'pywinauto': Mock()}):
            with self.assertRaisesRegex(ValueError, 'BROWSER_AMBIGUOUS'):
                obj.mouse_snapshot('open_chrome')
            obj.chrome_candidates.return_value = [{'handle': 3, 'pid': 2}]
            with self.assertRaisesRegex(ValueError, 'BROWSER_CHANGED'):
                obj.mouse_snapshot('home_tab')

    def test_mouse_permit_cannot_use_consumed_observation_or_background_home(self):
        obj = observer.BrowserObserver.__new__(observer.BrowserObserver)
        frame = dict(handle=1, pid=2, executable='chrome.exe', window_class='Chrome', focus=3)
        obj.browser = (1, 2)
        obj.frame = Mock(return_value=frame)
        import time
        obj.interaction = dict(observation_id='id', phase='home_tab', consumed=True,
                               at=time.monotonic(), frame=frame)
        body = {'observation_id': 'id', 'target_id': 0}
        with self.assertRaisesRegex(ValueError, 'INTERACTION_STALE'):
            obj.mouse_permit(body)
        obj.interaction['consumed'] = False
        obj.frame.return_value = {**frame, 'handle': 9}
        with self.assertRaisesRegex(ValueError, 'INITIAL_FOCUS_CHANGED'):
            obj.mouse_permit(body)

    def test_mouse_runtime_rejects_non_mouse_permit_before_input(self):
        controller = Mock()
        obj = runtime.BrowserRuntime(Mock(), controller)
        obj.rpc = Mock(return_value={'token': 'x', 'action': {'action': 'hotkey', 'keys': 'WIN+R'}})
        with self.assertRaisesRegex(ValueError, 'MOUSE_ONLY'):
            obj.click_interaction({'phase': 'open_chrome', 'observation_id': 'id', 'targets': [{'id': 0}]},
                                  {'command': 'click', 'observation_id': 'id', 'target_id': 0}, [])
        with self.assertRaisesRegex(ValueError, 'MOUSE_SAME_VIDEO_REQUIRED'):
            obj.restore_video()
        controller.execute.assert_not_called()

    def test_foreground_recovery_accepts_only_observer_bound_selected_tab_click(self):
        controller = Mock()
        obj = runtime.BrowserRuntime(Mock(), controller)
        obj.stop.wait = Mock()
        permit = {'token': 't', 'action': {'action': 'click', 'target_id': 0},
                  'screen': [0, 0, 2560, 1440], 'center': [590, 31]}
        obj.rpc = Mock(side_effect=[
            {'command': 'activate_browser', 'observation_id': 'old'}, permit,
            {'observation_id': 'new', 'phase': 'favorite', 'foreground': True}])
        obj.activate_browser({'observation_id': 'old', 'phase': 'favorite'})
        self.assertEqual(controller.execute.call_args.args[:2], (permit['action'], permit))
        observer_obj = observer.BrowserObserver.__new__(observer.BrowserObserver)
        control = Mock()
        control.is_selected.return_value = False
        with self.assertRaisesRegex(ValueError, 'TARGET_CHANGED'):
            observer_obj.validate_pointer({'role': 'activate_browser', 'control': control})

    def test_address_edit_ignores_omnibox_chip_document_and_page_search(self):
        def control(left, top, right, bottom):
            item = Mock()
            item.is_visible.return_value = True
            item.rectangle.return_value = Mock(left=left, top=top, right=right, bottom=bottom)
            item.rectangle.return_value.width.return_value = right - left
            item.rectangle.return_value.height.return_value = bottom - top
            return item
        window = control(-9, -9, 2569, 1389)
        chip = control(200, 77, 237, 114)
        viewport = control(0, 131, 2561, 1381)
        popup = control(173, 128, 2389, 203)
        address, search = control(257, 77, 2325, 114), control(1211, 164, 1643, 194)
        window.descendants.side_effect = lambda control_type: (
            [chip, viewport, popup] if control_type == 'Document' else [address, search])
        self.assertIs(observer.BrowserObserver.address_edit(window), address)
        # Two toolbar candidates are ambiguous, never select the first.
        window.descendants.side_effect = lambda control_type: (
            [viewport] if control_type == 'Document' else [address, control(500, 77, 800, 114)])
        with self.assertRaisesRegex(ValueError, 'ADDRESS_AMBIGUOUS'):
            observer.BrowserObserver.address_edit(window)

    def test_foreground_recovery_rejects_keyboard_fallback(self):
        events, controller = [], Mock()
        obj = runtime.BrowserRuntime(events.append, controller)
        obj.stop.wait = Mock()
        obj.rpc = Mock(side_effect=[
            {'command': 'activate_browser', 'observation_id': 'old'},
            {'token': 't', 'action': {'action': 'hotkey', 'keys': 'ALT+TAB'}},
            {'observation_id': 'new', 'phase': 'like', 'foreground': True},
        ])
        with self.assertRaisesRegex(ValueError, 'ACTIVATION_REJECTED'):
            obj.activate_browser({'observation_id': 'old', 'phase': 'like', 'foreground': False})
        controller.execute.assert_not_called()

    def test_foreground_recovery_obeys_total_step_budget_without_input(self):
        controller = Mock()
        obj = runtime.BrowserRuntime(Mock(), controller)
        obj.max_steps = obj.steps = 1
        with self.assertRaisesRegex(ValueError, 'STEP_LIMIT'):
            obj.activate_browser({'observation_id': 'id', 'phase': 'like', 'foreground': False})
        controller.execute.assert_not_called()

    def test_preinput_permit_rejection_requires_new_observation_and_new_decision(self):
        events = []
        controller = Mock()
        obj = runtime.BrowserRuntime(events.append, controller)
        obj.stop.wait = Mock()
        old = {'phase': 'confirm_favorite', 'observation_id': 'old', 'targets': [{'id': 1}]}
        fresh = {'phase': 'confirm_favorite', 'observation_id': 'new', 'targets': [{'id': 2}]}
        obj.observe_interaction = Mock(return_value=fresh)
        obj.rpc = Mock(side_effect=[ValueError('RELAY_TARGET_HITTEST_FAILED'),
            {'command': 'click', 'observation_id': 'new', 'target_id': 2},
            {'token': 't', 'action': {'action': 'click', 'target_id': 2}}])
        obj.click_interaction(old, {'command': 'click', 'observation_id': 'old', 'target_id': 1}, [])
        self.assertEqual(controller.execute.call_count, 1)
        self.assertEqual(controller.execute.call_args.args[0]['target_id'], 2)
        self.assertTrue(any(e.get('type') == 'not_executed_reobserve' for e in events))

    def test_report_guard_failure_is_never_redecided_or_replayed(self):
        controller = Mock()
        controller.execute.side_effect = ValueError('RELAY_TARGET_HITTEST_FAILED')
        obj = runtime.BrowserRuntime(Mock(), controller)
        obj.rpc = Mock(return_value={'token': 't', 'action': {'action': 'click', 'target_id': 1}})
        obj.observe_interaction = Mock()
        with self.assertRaises(ValueError):
            obj.click_interaction({'phase': 'like', 'observation_id': 'old', 'targets': [{'id': 1}]},
                {'command': 'click', 'observation_id': 'old', 'target_id': 1}, [])
        obj.observe_interaction.assert_not_called()
        self.assertEqual(controller.execute.call_count, 1)

    def test_already_active_engagement_is_never_toggled_again(self):
        obj = runtime.BrowserRuntime(Mock(), Mock())
        obj.observe_interaction = Mock(return_value={'targets': [{'state': True}]})
        obj.rpc = Mock(return_value={'verified': True})
        obj.click_interaction = Mock()
        self.assertTrue(obj.engage([], resume=True)['verified'])
        obj.click_interaction.assert_not_called()

    def test_large_coin_counter_still_requires_exact_one(self):
        def text(name, rect):
            item = Mock()
            item.window_text.return_value = name
            item.rectangle.return_value = Mock(left=rect[0], top=rect[1], right=rect[2], bottom=rect[3])
            return item
        obj = observer.BrowserObserver.__new__(observer.BrowserObserver)
        window = Mock()
        for value in ['1', '2']:
            window.descendants.return_value = [text(' 枚硬币', [1309,455,1389,487]),
                                               text(value, [1284,432,1310,493])]
            self.assertEqual(obj.coin_quantity(window), int(value))

    def test_unknown_state_stops_without_input(self):
        obj = runtime.BrowserRuntime(Mock(), Mock())
        obj.observe_interaction = Mock(return_value={'targets': [{'state': None}]})
        obj.click_interaction = Mock()
        with self.assertRaisesRegex(ValueError, 'STATE_UNAVAILABLE'):
            obj.engage([], resume=True)
        obj.click_interaction.assert_not_called()

    def test_default_theme_icon_colors_are_tristate(self):
        import numpy as np
        for bgr in ([236, 174, 0], [153, 102, 255]):
            self.assertIs(observer.icon_color_state(np.full((10, 10, 3), bgr, dtype=np.uint8)), True)
        self.assertIs(observer.icon_color_state(np.full((10, 10, 3), 100, dtype=np.uint8)), False)
        self.assertIsNone(observer.icon_color_state(np.full((10, 10, 3), 255, dtype=np.uint8)))
    def test_monotonic_timings_record_failed_step(self):
        events = []
        obj = runtime.BrowserRuntime(events.append, Mock())
        with obj.timed('test.ok', 'test'):
            pass
        with self.assertRaises(OSError):
            with obj.timed('test.fail', 'test'):
                raise OSError('lost')
        rows = [e['value'] for e in events if e['type'] == 'timing']
        self.assertEqual([r['success'] for r in rows], [True, False])
        self.assertTrue(all(r['elapsedMs'] >= 0 and r['clockHost'] == 'rk' for r in rows))

    def test_login_stops_before_any_engagement_click(self):
        obj = runtime.BrowserRuntime(Mock(), Mock())
        obj.observe_interaction = Mock(side_effect=[
            {'observation_id': 'home', 'phase': 'choose_video', 'targets': [{'id': 1}]},
            {'login_required': True, 'phase': 'like', 'targets': []}])
        obj.rpc = Mock(return_value={'command': 'click', 'observation_id': 'home', 'target_id': 1})
        obj.click_interaction = Mock()
        with self.assertRaisesRegex(ValueError, 'LOGIN_REQUIRED'):
            obj.engage([])
        self.assertEqual(obj.click_interaction.call_count, 1)

    def test_page_requires_exact_host_and_visible_content(self):
        self.assertTrue(observer.page_verified('www.bilibili.com', '哔哩哔哩', ['番剧 直播']))
        self.assertTrue(observer.page_verified('www.bilibili.com/index.html', '哔哩哔哩', ['番剧 直播']))
        for address in ['www.bilibili.com.evil.test', 'evil.test/bilibili.com',
                        'https://www.bilibili.com@evil.test', 'www.bilibili.com/login']:
            self.assertFalse(observer.page_verified(address, '哔哩哔哩', ['番剧 直播']))
        self.assertFalse(observer.page_verified('www.bilibili.com', '哔哩哔哩', ['网络错误']))

    def test_permit_is_consumed_and_focus_changes_revoke_guard(self):
        obj = observer.BrowserObserver.__new__(observer.BrowserObserver)
        frame = dict(handle=123, pid=99, executable='test.exe', window_class='Window', focus=42)
        obj.initial, obj.session, obj.next = frame, 'session', 0
        obj.active = {'token': 'once', 'identity': obj.identity(frame), 'expires': float('inf')}
        obj.frame = Mock(return_value=frame)
        self.assertTrue(obj.call('guard', {'token': 'once'})['valid'])
        obj.frame.return_value = {**frame, 'focus': 43}
        with self.assertRaisesRegex(ValueError, 'GUARD_CHANGED'):
            obj.call('guard', {'token': 'once'})
        self.assertIsNone(obj.active)
        with self.assertRaisesRegex(ValueError, 'MOUSE_ONLY'):
            obj.call('permit', {'index': 0, 'action': {'action': 'hotkey', 'keys': 'WIN+R'}})

    def test_invalid_plan_and_cancel_never_send_input(self):
        for cancel in [False, True]:
            events, controller = [], Mock()
            obj = runtime.BrowserRuntime(events.append, controller)
            obj.rpc = Mock(side_effect=[{}, {'command': {}, 'steps': runtime.EXPECTED}])
            if cancel:
                obj.stop.set()
            obj.run(dict(authorizeInput=True, planner='cloud-hid', windowTitle='Chrome → Bilibili'))
            controller.execute.assert_not_called()
            self.assertIn(events[-1]['phase'], ('cancelled', 'failed'))

    def test_partial_execution_failure_does_not_replay(self):
        events, controller = [], Mock()
        controller.execute.side_effect = OSError('USB lost')
        obj = runtime.BrowserRuntime(events.append, controller)
        obj.rpc = Mock(side_effect=[{}, {'command': {'command': 'open_browser', 'url': 'https://www.bilibili.com', 'method': 'mouse_same_window'},
                                         'steps': runtime.EXPECTED},
            {'phase': 'open_chrome', 'observation_id': 'id', 'targets': [{'id': 0}], 'foreground': False},
            {'command': 'click', 'observation_id': 'id', 'target_id': 0},
            {'token': 'x', 'session_id': 's', 'action': {'action': 'click', 'target_id': 0}}])
        obj.run(dict(authorizeInput=True, planner='cloud-hid', windowTitle='Chrome → Bilibili', observerSession='s'))
        self.assertEqual(controller.execute.call_count, 1)
        self.assertEqual(events[-1]['error'], 'DESKTOP_INPUT_OUTCOME_UNKNOWN')


if __name__ == '__main__':
    unittest.main()
