"""Narrow cloud -> RK -> native HID browser pilot. Private inherited SSH stdio only."""
import json
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
import queue
import sys
import threading
import time
import uuid

EXPECTED = [
    {"action": "click", "role": "chrome_icon"},
    {"action": "click", "role": "home_tab"},
]


class BrowserRuntime:
    def __init__(self, emit, controller, root=None):
        self.emit, self.controller = emit, controller
        self.root = root
        self.stop = threading.Event()
        self.done = threading.Event()
        self.pending = {}
        self.mutex = threading.Lock()
        self.heartbeat = time.monotonic()
        self.started = self.heartbeat
        self.sent = False
        self.steps = 0
        self.max_steps = 20
        self.task_id = uuid.uuid4().hex
        self.agent = None
        self.timings = []
        self.metrics = dict(fullObservations=0, planningCalls=0, uiaChecks=0,
                            actions=0, observationBytes=0, elapsedMs=0)

    def accept(self, packet):
        if packet.get("type") == "heartbeat":
            self.heartbeat = time.monotonic()
        elif packet.get("type") == "stop":
            self.stop.set()
        elif packet.get("type") == "reply":
            with self.mutex:
                result = self.pending.get(packet.get("id"))
            if result:
                try:
                    result.put_nowait(packet)
                except queue.Full:
                    pass

    def check(self):
        if (self.stop.is_set() or time.monotonic() - self.heartbeat > 12
                or time.monotonic() - self.started > 600):
            raise InterruptedError("RELAY_STOPPED")
        for path in Path("/sys/class/thermal").glob("thermal_zone*/temp"):
            if int(path.read_text()) >= 80000:
                raise InterruptedError("RELAY_TEMPERATURE_STOP")

    @contextmanager
    def timed(self, name, category):
        start, started_at, success = time.monotonic(), datetime.now(timezone.utc).isoformat(), False
        try:
            yield
            success = True
        finally:
            row = dict(name=name, category=category, elapsedMs=(time.monotonic() - start) * 1000,
                       success=success, startedAt=started_at.replace('+00:00', 'Z'),
                       finishedAt=datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
                       clockHost='rk')
            self.timings.append(row)
            if self.root:
                folder = self.root / 'logs/cloud-hid-timings' / self.task_id
                folder.mkdir(mode=0o700, parents=True, exist_ok=True)
                with (folder / 'steps.jsonl').open('a', encoding='utf-8') as log:
                    log.write(json.dumps(row) + '\n')
            self.emit({'type': 'timing', 'value': row})

    def rpc(self, op, value=None):
        with self.timed('rpc.' + op, 'rpc'):
            if self.agent and op in ('relay_plan', 'relay_act', 'relay_review'):
                if op == 'relay_review' and value.get('verified') is True:
                    self.emit({'type': 'business_verified', 'verified': True,
                               'observation': value['observation'], 'agent_location': 'rk'})
                return self.agent.call({'relay_plan': 'plan', 'relay_act': 'act',
                                        'relay_review': 'review'}[op], value)
            return self._rpc(op, value)

    def _rpc(self, op, value=None):
        self.check()
        key, result = uuid.uuid4().hex, queue.Queue(maxsize=1)
        with self.mutex:
            self.pending[key] = result
        self.emit(dict(type="request", id=key, op=op, value=value))
        deadline = time.monotonic() + (240 if op.startswith("relay_") or op == 'cloud_transport' else 25)
        try:
            while time.monotonic() < deadline:
                self.check()
                try:
                    reply = result.get(timeout=0.1)
                except queue.Empty:
                    continue
                self.check()
                if reply.get("error"):
                    raise ValueError(reply["error"])
                return reply["value"]
            raise TimeoutError("RELAY_RPC_TIMEOUT")
        finally:
            with self.mutex:
                self.pending.pop(key, None)

    def phase(self, phase, error=None, cause=None):
        if self.agent and phase in ('completed', 'cancelled', 'failed'):
            try:
                self.agent.close(phase, error)
            except (OSError, ValueError):
                phase, cause = 'failed', 'AGENT_JOURNAL_FAILURE'
                error = 'DESKTOP_INPUT_OUTCOME_UNKNOWN' if self.sent else 'AGENT_JOURNAL_FAILURE'
        self.metrics["elapsedMs"] = round((time.monotonic() - self.started) * 1000)
        self.emit(dict(type="state", phase=phase, steps=self.steps, error=error,
                       metrics=self.metrics, cause=cause))

    def click_interaction(self, observed, command, receipts, redecisions=0):
        if self.steps >= self.max_steps:
            raise ValueError('RELAY_STEP_LIMIT')
        if (command.get('command') != 'click'
                or command.get('observation_id') != observed['observation_id']
                or type(command.get('target_id')) is not int
                or not any(t['id'] == command['target_id'] for t in observed['targets'])):
            raise ValueError('RELAY_INTERACTION_REJECTED')
        self.phase('validating')
        try:
            permit = self.rpc('mouse_permit' if observed['phase'] in ('open_chrome', 'home_tab') else 'interact_permit', {'observation_id': observed['observation_id'],
                                                 'target_id': command['target_id']})
        except ValueError as error:
            # Only the PC's permit phase can enter this branch. No controller call
            # or report has begun for this action. Never catch report-guard errors.
            safe = ('RELAY_TARGET_HITTEST_FAILED', 'RELAY_TARGET_CHANGED', 'RELAY_INTERACTION_STALE',
                    'RELAY_BROWSER_NOT_FOREGROUND')
            if self.agent:
                self.agent.finish_input(observed['observation_id'], 'not_sent', reason=str(error))
            if redecisions or str(error) not in safe:
                raise
            self.emit({'type': 'not_executed_reobserve', 'phase': observed['phase'],
                       'reason': str(error), 'input_sent_for_action': False})
            fresh = (self.rpc('mouse_observe', {'phase': observed['phase']})
                     if observed['phase'] in ('open_chrome', 'home_tab')
                     else self.observe_interaction(observed['phase']))
            decision = self.rpc('relay_act', fresh)
            self.metrics['planningCalls'] += 1
            return self.click_interaction(fresh, decision, receipts, redecisions=1)
        token = permit['token']
        if getattr(self, 'observer_session', None) and permit.get('session_id') != self.observer_session:
            raise ValueError('RELAY_SESSION_CHANGED')
        if permit['action'] != {'action': 'click', 'target_id': command['target_id']}:
            raise ValueError('RELAY_MOUSE_ONLY')

        def guard(_report):
            self.check()
            self.rpc('guard', {'token': token})
            self.metrics['uiaChecks'] += 1

        self.phase('executing')
        if self.agent:
            self.agent.begin_input(observed['observation_id'], observed['phase'], permit['action'])
        self.sent = True
        try:
            with self.timed('usb.' + observed['phase'] + '.click', 'usb_input'):
                self.controller.execute(permit['action'], permit, guard)
        except BaseException:
            if self.agent:
                self.agent.finish_input(observed['observation_id'], 'unknown')
            raise
        self.steps += 1
        self.metrics['actions'] += 1
        receipt = {'index': self.steps - 1, 'action': permit['action'],
                         'phase': observed['phase'], 'state': 'input_sent',
                         'observation_id': observed['observation_id'],
                         'agent_location': 'rk' if self.agent else 'host',
                         'decision_source': command.get('decision_source', 'cloud_model')}
        if self.agent:
            self.agent.finish_input(observed['observation_id'], 'input_sent', receipt)
        receipts.append(receipt)
        with self.timed('settle.' + observed['phase'], 'explicit_wait'):
            self.stop.wait(0.1)

    def observe_interaction(self, phase):
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            try:
                observed = self.rpc('interact_observe', {'phase': phase})
                if observed.get('foreground') is False:
                    observed = self.activate_browser(observed)
                if phase in ('choose_video', 'restore_video') or observed.get('targets') or observed.get('login_required') or observed.get('dialog'):
                    return observed
                with self.timed('wait.' + phase, 'explicit_wait'):
                    self.stop.wait(0.5)
            except ValueError as error:
                if str(error) not in ('RELAY_WRONG_VIDEO', 'RELAY_DOCUMENT_NOT_READY'):
                    raise
                with self.timed('wait.' + phase, 'explicit_wait'):
                    self.stop.wait(0.5)
        raise TimeoutError('RELAY_VIDEO_TIMEOUT')

    def activate_browser(self, observed):
        for _ in range(12):
            self.check()
            if self.steps >= self.max_steps:
                raise ValueError('RELAY_STEP_LIMIT')
            command = self.rpc('relay_act', {**observed, 'phase': 'activate_browser', 'targets': []})
            self.metrics['planningCalls'] += 1
            if command != {'command': 'activate_browser', 'observation_id': observed['observation_id']}:
                raise ValueError('RELAY_ACTIVATION_REJECTED')
            permit = self.rpc('activate_permit', {'observation_id': observed['observation_id']})
            if permit.get('action') != {'action': 'click', 'target_id': 0}:
                raise ValueError('RELAY_ACTIVATION_REJECTED')
            def guard(_report):
                self.check()
                self.rpc('guard', {'token': permit['token']})
                self.metrics['uiaChecks'] += 1
            self.sent = True
            if self.agent:
                self.agent.begin_input(observed['observation_id'], 'activate_browser', permit['action'])
            try:
                with self.timed('usb.activate_browser', 'usb_input'):
                    self.controller.execute(permit['action'], permit, guard)
            except BaseException:
                if self.agent:
                    self.agent.finish_input(observed['observation_id'], 'unknown')
                raise
            if self.agent:
                self.agent.finish_input(observed['observation_id'], 'input_sent', {
                    'phase': 'activate_browser', 'observation_id': observed['observation_id'],
                    'action': permit['action'], 'state': 'input_sent', 'agent_location': 'rk',
                    'decision_source': 'cloud_model'})
            self.steps += 1
            self.metrics['actions'] += 1
            self.emit({'type': 'foreground_switch_input', 'action': permit['action']})
            with self.timed('settle.activate_browser', 'explicit_wait'):
                self.stop.wait(0.4)
            fresh = self.rpc('interact_observe', {'phase': observed['phase']})
            if fresh.get('foreground') is True:
                self.emit({'type': 'foreground_verified', 'observation_id': fresh['observation_id']})
                return fresh
            observed = fresh
        raise ValueError('RELAY_FOREGROUND_NOT_ACQUIRED')

    def restore_video(self):
        raise ValueError('RELAY_MOUSE_SAME_VIDEO_REQUIRED')

    def open_with_mouse(self, receipts):
        opened = self.rpc('mouse_observe', {'phase': 'open_chrome'})
        if not opened.get('foreground'):
            command = self.rpc('relay_act', opened)
            self.metrics['planningCalls'] += 1
            self.click_interaction(opened, command, receipts)
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            try:
                home = self.rpc('mouse_observe', {'phase': 'home_tab'})
                if home.get('foreground'):
                    break
            except ValueError as error:
                if str(error) != 'RELAY_BROWSER_NOT_READY':
                    raise
            with self.timed('wait.chrome', 'explicit_wait'):
                self.stop.wait(0.5)
        else:
            raise ValueError('RELAY_BROWSER_NOT_FOREGROUND')
        command = self.rpc('relay_act', home)
        self.metrics['planningCalls'] += 1
        self.click_interaction(home, command, receipts)

    def complete_coin(self, receipts):
        observed = self.observe_interaction('one_coin')
        if observed.get('dialog') != 'coin' or len(observed['targets']) != 1:
            raise ValueError('RELAY_COIN_DIALOG_UNAVAILABLE')
        if observed.get('coin_quantity') != 1:
            command = self.rpc('relay_act', observed)
            self.metrics['planningCalls'] += 1
            self.click_interaction(observed, command, receipts)
        confirm = self.observe_interaction('confirm_coin')
        if confirm.get('coin_quantity') != 1 or len(confirm['targets']) != 1:
            raise ValueError('RELAY_ONE_COIN_REQUIRED')
        command = self.rpc('relay_act', confirm)
        self.metrics['planningCalls'] += 1
        self.click_interaction(confirm, command, receipts)

    def complete_favorite(self, receipts):
        observed = self.observe_interaction('default_folder')
        if observed.get('dialog') != 'favorite' or len(observed['targets']) != 1:
            raise ValueError('RELAY_FAVORITE_DIALOG_UNAVAILABLE')
        state = observed['targets'][0].get('state')
        if state is None:
            raise ValueError('RELAY_ENGAGEMENT_STATE_UNAVAILABLE')
        if not state:
            command = self.rpc('relay_act', observed)
            self.metrics['planningCalls'] += 1
            self.click_interaction(observed, command, receipts)
        confirm = self.observe_interaction('confirm_favorite')
        if len(confirm['targets']) != 1:
            raise ValueError('RELAY_DEFAULT_FOLDER_REQUIRED')
        command = self.rpc('relay_act', confirm)
        self.metrics['planningCalls'] += 1
        self.click_interaction(confirm, command, receipts)

    def save_procedure(self, receipts, review, verified, elapsed_ms):
        if not self.root:
            return
        folder = self.root / 'logs/cloud-hid-procedures'
        folder.mkdir(mode=0o700, parents=True, exist_ok=True)
        record = {'version': 2, 'verified': True, 'steps': [r['action'] for r in receipts],
                  'receipts': receipts, 'review': review, 'review_verified': False,
                  'observation': verified, 'elapsed_ms': elapsed_ms, 'timing_task_id': self.task_id}
        with (folder / (uuid.uuid4().hex + '.json')).open('x', encoding='utf-8') as log:
            json.dump(record, log, ensure_ascii=False, indent=2)

    def engage(self, receipts, resume=False):
        if not resume:
            observed = self.observe_interaction('choose_video')
            command = self.rpc('relay_act', observed)
            self.metrics['planningCalls'] += 1
            self.click_interaction(observed, command, receipts)
        for phase in ('like', 'coin', 'favorite'):
            observed = self.observe_interaction(phase)
            if observed.get('dialog') == 'coin':
                self.complete_coin(receipts)
                observed = self.observe_interaction(phase)
            if observed.get('dialog') == 'favorite':
                self.complete_favorite(receipts)
                observed = self.observe_interaction(phase)
            if observed.get('login_required'):
                raise ValueError('RELAY_LOGIN_REQUIRED')
            targets = observed['targets']
            if not targets:
                raise ValueError('RELAY_ENGAGEMENT_TARGET_UNAVAILABLE')
            if any(t.get('state') is True for t in targets):
                continue  # Never toggle an already active interaction off.
            if not all(t.get('state') is False for t in targets):
                raise ValueError('RELAY_ENGAGEMENT_STATE_UNAVAILABLE')
            command = self.rpc('relay_act', observed)
            self.metrics['planningCalls'] += 1
            if command.get('command') == 'blocked':
                raise ValueError('RELAY_LOGIN_REQUIRED')
            self.click_interaction(observed, command, receipts)
            if phase == 'coin':
                self.complete_coin(receipts)
            if phase == 'favorite':
                self.complete_favorite(receipts)
            # The UI must expose an explicit result before another possibly
            # irreversible action; no blind repeated click or guessed completion.
            deadline = time.monotonic() + 5
            result = self.rpc('interact_verify', {'phase': phase})
            while not result.get('verified') and time.monotonic() < deadline:
                with self.timed('wait.verify.' + phase, 'explicit_wait'):
                    self.stop.wait(0.5)
                result = self.rpc('interact_verify', {'phase': phase})
            if result.get('verified') is not True:
                raise ValueError('RELAY_ENGAGEMENT_NOT_VERIFIED')
        return self.rpc('interact_verify', {'phase': 'all'})

    def run(self, config):
        try:
            self.max_steps = config.get('maxSteps', 20)
            self.observer_session = config.get('observerSession')
            if type(self.max_steps) is not int or not 1 <= self.max_steps <= 20:
                raise ValueError('RELAY_SCOPE_REJECTED')
            if (config.get("authorizeInput") is not True
                    or config.get("planner") != "cloud-hid"
                    or config.get("windowTitle") != "Chrome → Bilibili"):
                raise ValueError("RELAY_SCOPE_REJECTED")
            if config.get('agentLocation') == 'rk':
                from rk_cloud_agent import RKCloudAgent
                self.agent = RKCloudAgent(
                    self.root, config['goal'], config.get('browserTask', 'home'), self.task_id,
                    lambda system, content: self._rpc('cloud_transport',
                                                     {'system': system, 'content': content}),
                    self.emit, self.timed, self.check)
            self.phase("planning")
            observed = self.rpc("observe")
            self.metrics["fullObservations"] += 1
            self.metrics["observationBytes"] += len(json.dumps(observed).encode())
            if observed.get('resuming_video'):
                if config.get('browserTask') != 'video-triple' or not config.get('resumeVideo'):
                    raise ValueError('RELAY_RESUME_REJECTED')
                if self.agent:
                    self.rpc('relay_plan', {'observation': observed})
                    self.metrics['planningCalls'] += 1
                receipts = []
                if observed.get('video_mismatch'):
                    self.restore_video()
                verified = self.engage(receipts, resume=True)
                if not verified.get('verified'):
                    raise ValueError('RELAY_ENGAGEMENT_NOT_VERIFIED')
                review = self.rpc('relay_review', {'verified': True, 'elapsedMs': round((time.monotonic() - self.started)*1000),
                    'receipts': receipts, 'observation': verified})
                self.save_procedure(receipts, review, verified, round((time.monotonic() - self.started)*1000))
                self.emit({'type': 'relay_reviewed', **review})
                self.phase('completed')
                return
            plan = self.rpc("relay_plan", {"observation": observed})
            self.metrics["planningCalls"] += 1
            if (plan.get("command") != {"command": "open_browser", "url": "https://www.bilibili.com", "method": "mouse_same_window"}
                    or plan.get("steps") != EXPECTED):
                raise ValueError("RELAY_PLAN_REJECTED")
            receipts = []
            self.open_with_mouse(receipts)
            self.phase("verifying")
            deadline = time.monotonic() + 45
            verified = None
            while time.monotonic() < deadline:
                self.check()
                result = self.rpc("verify")
                self.metrics["fullObservations"] += 1
                self.metrics["observationBytes"] += len(json.dumps(result, ensure_ascii=False).encode())
                if result.get("verified") is True:
                    verified = result
                    break
                with self.timed('wait.page', 'explicit_wait'):
                    self.stop.wait(1)
            if verified is None:
                raise ValueError("RELAY_PAGE_NOT_VERIFIED")
            if config.get('browserTask') == 'video-triple':
                verified = self.engage(receipts)
                if verified.get('verified') is not True:
                    raise ValueError('RELAY_ENGAGEMENT_NOT_VERIFIED')
            facts = {"verified": True, "elapsedMs": round((time.monotonic() - self.started) * 1000),
                     "receipts": receipts, "observation": verified}
            # A failed review must not turn an already verified page into a reason to replay.
            try:
                review = self.rpc("relay_review", facts)
                self.save_procedure(receipts, review, verified, facts['elapsedMs'])
                self.emit({"type": "relay_reviewed", **review})
            except (ValueError, TimeoutError, OSError):
                self.emit({"type": "review_failed", "task_verified": True})
            self.check()
            self.phase("completed")
        except InterruptedError:
            self.phase("cancelled", "DESKTOP_STOPPED_AFTER_INPUT" if self.sent else None)
        except Exception as error:
            expected_block = str(error) in ('RELAY_LOGIN_REQUIRED', 'RELAY_ENGAGEMENT_TARGET_UNAVAILABLE',
                                           'RELAY_ENGAGEMENT_NOT_VERIFIED', 'RELAY_ENGAGEMENT_STATE_UNAVAILABLE')
            self.phase("failed", str(error) if not self.sent or expected_block else "DESKTOP_INPUT_OUTCOME_UNKNOWN",
                       cause=str(error))
        finally:
            if self.agent:
                self.agent.close()
            self.done.set()


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stdin.reconfigure(encoding="utf-8")
    import fcntl
    import os
    root = Path(sys.argv[1]).expanduser().resolve()
    sys.path.insert(0, str(root / "agent"))
    from hid import HIDController
    HIDController.node("hid.rk_keyboard")
    output_lock = threading.Lock()

    def emit(value):
        with output_lock:
            print(json.dumps(value, ensure_ascii=False), flush=True)

    with (root / ".runtime/hid.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        runtime = BrowserRuntime(emit, HIDController(), root=root)
        worker = None
        emit({"type": "ready", "value": {"protocol": 1, "hid": True, "pid": os.getpid()}})
        try:
            for line in sys.stdin:
                if len(line.encode()) > 131072:
                    raise ValueError("RELAY_INPUT_LIMIT")
                packet = json.loads(line)
                if packet.get("type") == "start" and worker is None:
                    worker = threading.Thread(target=runtime.run, args=(packet["value"],), daemon=True)
                    worker.start()
                else:
                    runtime.accept(packet)
                    if packet.get("type") == "stop" and worker is None:
                        runtime.phase("cancelled")
        finally:
            runtime.stop.set()
            if worker:
                worker.join(4)


if __name__ == "__main__":
    main()
