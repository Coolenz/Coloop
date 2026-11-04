"""Real local HTTP tests for the Coloop/OpenCode adapter; no NPU or cloud calls."""

from __future__ import annotations

from contextlib import contextmanager, redirect_stderr, redirect_stdout
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import coloop_agent as agent  # noqa: E402

SECRET = "never-print-this-api-key-or-private-body"
WORKSPACE = "D:/RK"


def event():
    now = datetime.now(timezone.utc)
    return {
        "version": 1,
        "id": "req-1",
        "sessionId": "ses-1",
        "kind": "permission",
        "workspace": WORKSPACE,
        "tool": "read",
        "patterns": ["src/example.py"],
        "createdAt": agent.iso_time(now),
        "expiresAt": agent.iso_time(now + timedelta(seconds=180)),
    }


def permission():
    return {
        "id": "req-1",
        "sessionID": "ses-1",
        "permission": "read",
        "patterns": ["src/example.py"],
        "metadata": {},
        "always": ["*"],
    }


def question():
    return {
        "id": "que-1",
        "sessionID": "ses-1",
        "questions": [
            {
                "header": "Choose",
                "question": "Where should private data be processed?",
                "options": [
                    {"label": "仅在本地离线分析，不上传任何数据", "description": ""},
                    {"label": "Cloud", "description": "Send to cloud"},
                ],
            }
        ],
    }


class State:
    def __init__(self):
        self.permissions = [permission()]
        self.questions = []
        self.reviews = []
        self.replies = []
        self.auth = []
        self.decision = "allow"
        self.reason_code = "LOCAL_REVIEW"
        self.mutate = None
        self.tamper = None
        self.review_status = 200
        self.redirect = ""
        self.consume = True
        self.directory = WORKSPACE
        self.queries = []

    def handler(self):
        state = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def respond(self, value, status=200):
                payload = json.dumps(value, ensure_ascii=False).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                if state.redirect:
                    self.send_header("Location", state.redirect)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def do_GET(self):
                parsed = urlsplit(self.path)
                state.queries.append(parse_qs(parsed.query))
                if parse_qs(parsed.query).get("directory") != [state.directory]:
                    return self.respond(False, 400)
                state.auth.append(self.headers.get("Authorization"))
                if parsed.path == "/permission":
                    return self.respond(state.permissions)
                if parsed.path == "/question":
                    return self.respond(state.questions)
                return self.respond(False, 404)

            def do_POST(self):
                parsed = urlsplit(self.path)
                raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                body = json.loads(raw) if raw else None
                state.auth.append(self.headers.get("Authorization"))
                if parsed.path == "/v1/review":
                    state.reviews.append(deepcopy(body))
                    if state.review_status != 200:
                        return self.respond({"private": SECRET}, state.review_status)
                    result = {
                        "version": 1,
                        "id": body["id"],
                        "sessionId": body["sessionId"],
                        "requestHash": agent.digest(body),
                        "decision": state.decision,
                        "reasonCode": state.reason_code,
                        "source": "rk",
                        "expiresAt": body["expiresAt"],
                    }
                    if state.decision == "select":
                        result["choiceId"] = "0"
                    if state.tamper:
                        state.tamper(result)
                    if state.mutate:
                        state.mutate()
                    return self.respond(result)
                state.queries.append(parse_qs(parsed.query))
                if parse_qs(parsed.query).get("directory") != [state.directory]:
                    return self.respond(False, 400)
                state.replies.append((parsed.path, body))
                if parsed.path.startswith("/permission/"):
                    if state.consume:
                        state.permissions = []
                elif parsed.path.startswith("/question/"):
                    if state.consume:
                        state.questions = []
                else:
                    return self.respond(False, 404)
                return self.respond(True)

        return Handler


@contextmanager
def server(state):
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), state.handler())
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{httpd.server_port}"
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=3)


class AdapterTests(unittest.TestCase):
    def adapter(self, state, url):
        return agent.OpenCodeAdapter(
            agent.LocalJsonClient(url), agent.LocalJsonClient(url, "Bearer " + SECRET), WORKSPACE
        )

    def poll(self, adapter):
        output = io.StringIO()
        with redirect_stderr(output):
            result = adapter.poll_once()
        self.assertNotIn(SECRET, output.getvalue())
        self.assertNotIn("src/example.py", output.getvalue())
        self.assertNotIn("req-1", output.getvalue())
        return result, output.getvalue()

    def test_permission_denial_consumed_once_over_real_http(self):
        state = State()
        state.decision = "deny"
        with server(state) as url:
            adapter = self.adapter(state, url)
            worked, log = self.poll(adapter)
            self.assertTrue(worked)
            self.assertIn('"result":"replied"', log)
            self.assertEqual(state.replies, [("/permission/req-1/reply", {"reply": "reject"})])
            self.assertEqual(state.permissions, [])
            self.assertEqual(len(state.reviews), 1)
            self.assertNotIn(SECRET, json.dumps(state.reviews))
            self.assertIn("Bearer " + SECRET, state.auth)
            self.assertFalse(self.poll(adapter)[0])
            state.permissions = [
                permission()
            ]  # Even a reused request ID cannot replay this process.
            self.assertFalse(self.poll(adapter)[0])
            self.assertEqual(len(state.replies), 1)

    def test_question_consumes_existing_label(self):
        state = State()
        state.permissions = []
        state.questions = [question()]
        state.decision = "select"
        with server(state) as url:
            self.poll(self.adapter(state, url))
        self.assertEqual(
            state.replies,
            [("/question/que-1/reply", {"answers": [["仅在本地离线分析，不上传任何数据"]]})],
        )
        self.assertEqual(state.questions, [])

    def test_deny_permission_and_question(self):
        for kind in ("permission", "question"):
            with self.subTest(kind=kind):
                state = State()
                state.decision = "deny"
                if kind == "question":
                    state.permissions = []
                    state.questions = [question()]
                with server(state) as url:
                    self.poll(self.adapter(state, url))
                expected = (
                    ("/permission/req-1/reply", {"reply": "reject"})
                    if kind == "permission"
                    else ("/question/que-1/reject", None)
                )
                self.assertEqual(state.replies, [expected])

    def test_changed_action_or_session_and_consumed_request_never_reply(self):
        mutations = (
            lambda state: state.permissions[0]["metadata"].update(private="changed"),
            lambda state: state.permissions[0].update(sessionID="different-session"),
            lambda state: state.permissions.clear(),
        )
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                state = State()
                state.decision = "deny"
                state.mutate = lambda: mutation(state)
                with server(state) as url:
                    _, log = self.poll(self.adapter(state, url))
                self.assertEqual(state.replies, [])
                self.assertIn("PENDING_CHANGED_OR_CONSUMED", log)

    def test_tampered_decision_never_replies(self):
        mutations = (
            lambda decision: decision.update(id="other-request"),
            lambda decision: decision.update(sessionId="other-session"),
            lambda decision: decision.update(requestHash="0" * 64),
            lambda decision: decision.update(expiresAt="2099-01-01T00:00:00Z"),
            lambda decision: decision.update(decision="always"),
            lambda decision: decision.update(reasonCode=SECRET + "\n"),
            lambda decision: decision.update(extra=SECRET),
        )
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                state = State()
                state.tamper = mutation
                with server(state) as url:
                    self.poll(self.adapter(state, url))
                self.assertEqual(state.replies, [])

    def test_expired_during_review_never_replies(self):
        state = State()
        with server(state) as url, patch.object(agent, "EVENT_TTL_SECONDS", 0.03):
            import time

            state.mutate = lambda: time.sleep(0.08)
            _, log = self.poll(self.adapter(state, url))
        self.assertIn("DECISION_EXPIRED", log)
        self.assertEqual(state.replies, [])

    def test_defer_stays_pending_with_stable_event_and_no_repeated_review(self):
        state = State()
        state.decision = "defer"
        with server(state) as url:
            adapter = self.adapter(state, url)
            self.poll(adapter)
            saved = deepcopy(adapter.observed)
            self.assertFalse(self.poll(adapter)[0])
            self.assertEqual(adapter.observed, saved)
        self.assertEqual(len(state.reviews), 1)
        self.assertEqual(state.replies, [])

    def test_multiple_questions_and_multiselect_stay_pending(self):
        for multiple in (True, False):
            state = State()
            state.permissions = []
            pending = question()
            if multiple:
                pending["questions"][0]["multiple"] = True
            else:
                pending["questions"] *= 2
            state.questions = [pending]
            with server(state) as url:
                _, log = self.poll(self.adapter(state, url))
            self.assertIn("UNSUPPORTED_QUESTION", log)
            self.assertEqual(state.reviews, [])
            self.assertEqual(state.replies, [])

    def test_http_success_does_not_claim_unconsumed_request_completed(self):
        state = State()
        state.decision = "deny"
        state.consume = False
        with server(state) as url:
            adapter = self.adapter(state, url)
            _, log = self.poll(adapter)
            self.assertFalse(self.poll(adapter)[0])
        self.assertIn("REPLY_NOT_CONSUMED", log)
        self.assertEqual(len(state.replies), 1)

    def test_redirect_and_upstream_error_body_never_expose_secrets(self):
        for status in (302, 500):
            state = State()
            state.review_status = status
            state.redirect = "http://127.0.0.1:1/" + SECRET
            with server(state) as url:
                _, log = self.poll(self.adapter(state, url))
            self.assertNotIn(SECRET, log)
            self.assertIn("REDIRECT_BLOCKED" if status == 302 else "HTTP_STATUS", log)
            self.assertEqual(state.replies, [])

    def test_environment_proxy_ignored_and_basic_auth_from_environment(self):
        state = State()
        with (
            server(state) as url,
            patch.dict(
                os.environ,
                {
                    "HTTP_PROXY": "http://127.0.0.1:1",
                    "HTTPS_PROXY": "http://127.0.0.1:1",
                    "ALL_PROXY": "http://127.0.0.1:1",
                    "NO_PROXY": "",
                    "RK_OPENCODE_USERNAME": "user",
                    "RK_OPENCODE_PASSWORD": SECRET,
                },
            ),
        ):
            client = agent.opencode_client(url)
            client.request("GET", "/permission?directory=D%3A%2FRK")
        self.assertTrue(state.auth[0].startswith("Basic "))

    def test_remote_or_credential_urls_and_relative_directory_rejected(self):
        for url in (
            "http://example.org",
            "http://192.168.1.2",
            "http://127.0.0.1/path",
            "http://user:password@127.0.0.1",
            "http://127.0.0.1?key=x",
            "http://127.0.0.1#x",
            "file:///tmp/private",
            "http://127.0.0.1\n",
        ):
            with self.subTest(url=url), self.assertRaises(agent.AdapterError):
                agent.LocalJsonClient(url)
        self.assertEqual(agent.loopback_url("http://localhost:1234"), "http://127.0.0.1:1234")
        for directory in ("relative", "C:relative", "../RK", "D:/RK\n"):
            with self.subTest(directory=directory), self.assertRaises(agent.AdapterError):
                agent.absolute_directory(directory)

    def test_strict_json_and_generic_cli_only_emits_decision(self):
        for raw in (b'{"id":1,"id":2}', b'{"value":NaN}', b"{} trailing"):
            with self.assertRaises(agent.AdapterError):
                agent.parse_json(raw)
        state = State()
        with server(state) as url, tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            connection = root / "connection.json"
            connection.write_text(json.dumps({"url": url, "token": SECRET}), encoding="utf-8")
            request = root / "event.json"
            request.write_text(json.dumps(event()), encoding="utf-8")
            result = subprocess.run(
                [
                    sys.executable,
                    str(Path(agent.__file__)),
                    "review",
                    "--event",
                    str(request),
                    "--connection",
                    str(connection),
                ],
                capture_output=True,
                text=True,
                timeout=10,
            )
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout)
        self.assertEqual(value["decision"], "allow")
        self.assertEqual(result.stderr, "")
        self.assertNotIn(SECRET, result.stdout)

    def test_once_cli_consumes_real_pending_request(self):
        state = State()
        state.decision = "deny"
        with server(state) as url, tempfile.TemporaryDirectory() as directory:
            connection = Path(directory) / "connection.json"
            connection.write_text(json.dumps({"url": url, "token": SECRET}), encoding="utf-8")
            result = subprocess.run(
                [
                    sys.executable,
                    str(Path(agent.__file__)),
                    "opencode",
                    "--url",
                    url,
                    "--directory",
                    WORKSPACE,
                    "--connection",
                    str(connection),
                    "--once",
                ],
                capture_output=True,
                text=True,
                timeout=10,
            )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertEqual(state.permissions, [])
        self.assertEqual(len(state.replies), 1)
        self.assertNotIn(SECRET, result.stderr)

    def test_allow_never_releases_read_data_to_unverified_upstream_agent(self):
        state = State()
        with server(state) as url:
            adapter = self.adapter(state, url)
            _, log = self.poll(adapter)
            self.assertFalse(self.poll(adapter)[0])
        self.assertIn("UNVERIFIED_AGENT_DATA_ROUTE", log)
        self.assertEqual(state.replies, [])
        self.assertEqual(len(state.permissions), 1)

    def test_unknown_metadata_is_not_silently_dropped_or_sent(self):
        state = State()
        state.permissions[0]["metadata"] = {
            "filePath": "D:/RK/.env",
            "operation": "upload",
            "private": SECRET,
        }
        with server(state) as url:
            _, log = self.poll(self.adapter(state, url))
        self.assertIn("UNKNOWN_PERMISSION_METADATA", log)
        self.assertEqual(state.replies, [])
        self.assertEqual(state.reviews, [])

    def test_transient_defer_retries_same_event_without_extending_lifetime(self):
        state = State()
        state.permissions = []
        state.questions = [question()]
        state.decision, state.reason_code = "defer", "MODEL_BUSY"
        with server(state) as url:
            adapter = self.adapter(state, url)
            self.poll(adapter)
            state.decision, state.reason_code = "select", "RK_SAFE_CHOICE"
            self.poll(adapter)
        self.assertEqual(len(state.reviews), 2)
        self.assertEqual(state.reviews[0], state.reviews[1])
        self.assertEqual(len(state.replies), 1)
        self.assertEqual(state.questions, [])

    def test_changed_or_expired_transient_request_does_not_renew_or_reply(self):
        for changed in (True, False):
            with self.subTest(changed=changed):
                state = State()
                state.decision, state.reason_code = "defer", "MODEL_BUSY"
                with server(state) as url:
                    adapter = self.adapter(state, url)
                    self.poll(adapter)
                    if changed:
                        state.permissions[0]["patterns"] = ["D:/RK/.env"]
                    else:
                        saved_hash, saved = next(iter(adapter.observed.values()))
                        saved = deepcopy(saved)
                        saved["expiresAt"] = "2000-01-01T00:00:00Z"
                        adapter.observed[next(iter(adapter.observed))] = (saved_hash, saved)
                    _, log = self.poll(adapter)
                    self.assertFalse(self.poll(adapter)[0])
                self.assertIn("PENDING_CHANGED_OR_CONSUMED" if changed else "EVENT_EXPIRED", log)
                self.assertEqual(len(state.reviews), 1)
                self.assertEqual(state.replies, [])

    def test_default_connection_and_error_output_redacted(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.dict(os.environ, {"APPDATA": directory}),
        ):
            connection = agent.default_connection()
            self.assertEqual(
                connection, Path(directory) / "coloop/agent-coordinator/connection.json"
            )
            output, error = io.StringIO(), io.StringIO()
            with redirect_stdout(output), redirect_stderr(error):
                code = agent.main(["review", "--event", SECRET])
        self.assertEqual(code, 1)
        self.assertEqual(output.getvalue(), "")
        self.assertNotIn(SECRET, error.getvalue())
        self.assertNotIn(directory, error.getvalue())

    def test_remote_directory_and_local_policy_workspace_are_distinct(self):
        state = State()
        state.directory = "/home/cat/rk-opencode"
        state.decision = "deny"
        with server(state) as url:
            adapter = agent.OpenCodeAdapter(
                agent.LocalJsonClient(url),
                agent.LocalJsonClient(url, "Bearer " + SECRET),
                state.directory,
                WORKSPACE,
            )
            self.poll(adapter)
        self.assertEqual(state.reviews[0]["workspace"], WORKSPACE)
        self.assertEqual(adapter.directory, "/home/cat/rk-opencode")
        self.assertTrue(state.queries)
        self.assertTrue(all(query["directory"] == [state.directory] for query in state.queries))
        self.assertEqual(state.replies, [("/permission/req-1/reply", {"reply": "reject"})])

    def test_explicit_workspace_does_not_release_allow_and_must_be_absolute(self):
        state = State()
        state.directory = "/home/cat/rk-opencode"
        with server(state) as url:
            upstream, coordinator = agent.LocalJsonClient(url), agent.LocalJsonClient(url)
            adapter = agent.OpenCodeAdapter(upstream, coordinator, state.directory, WORKSPACE)
            _, log = self.poll(adapter)
            with self.assertRaises(agent.AdapterError):
                agent.OpenCodeAdapter(upstream, coordinator, state.directory, "relative")
        self.assertIn("UNVERIFIED_AGENT_DATA_ROUTE", log)
        self.assertEqual(state.replies, [])

    def test_cli_workspace_option_maps_local_policy_only(self):
        state = State()
        state.directory = "/home/cat/rk-opencode"
        state.decision = "deny"
        with server(state) as url, tempfile.TemporaryDirectory() as directory:
            connection = Path(directory) / "connection.json"
            connection.write_text(json.dumps({"url": url, "token": SECRET}), encoding="utf-8")
            result = subprocess.run(
                [
                    sys.executable,
                    str(Path(agent.__file__)),
                    "opencode",
                    "--url",
                    url,
                    "--directory",
                    state.directory,
                    "--workspace",
                    WORKSPACE,
                    "--connection",
                    str(connection),
                    "--once",
                ],
                capture_output=True,
                text=True,
                timeout=10,
            )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(state.reviews[0]["workspace"], WORKSPACE)
        self.assertEqual(len(state.replies), 1)


if __name__ == "__main__":
    unittest.main()
