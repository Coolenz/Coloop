"""CPU-only controller checks; fake records never count as source/NPU evidence."""

import base64
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import bench_coloop_managed as bench
from eval_coloop_approvals import DEFAULT_DATASET, prepare

PREFIX = "e-" + "0" * 16


class NativeControllerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.run_dir = Path(cls.temporary.name) / "prepared"
        _, cls.public, _ = prepare(DEFAULT_DATASET, cls.run_dir, "native")
        cls.by_id = {row["case_id"]: row for row in cls.public}

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def mapping(self, case_id):
        public = self.by_id[case_id]
        aliases = bench.aliases_for(public, "/enrolled", PREFIX, self.public.index(public))
        return public, aliases

    def test_fixed_native40_support_is_36_with_honest_enrollment_gaps(self):
        self.assertEqual(len(self.public), 40)
        supported = [row for row in self.public if bench.support_reason(row) is None]
        self.assertEqual(len(supported), 36)
        missing = {row["case_id"] for row in self.public if bench.support_reason(row)}
        self.assertEqual(
            missing, {"route-missing", "route-unsigned", "route-expired", "route-source-mismatch"}
        )

    def test_short_case_ordinals_are_unique_isolated_and_never_use_sensitive_labels(self):
        scopes = []
        for index, public in enumerate(self.public):
            aliases = bench.aliases_for(public, "/enrolled", PREFIX, index)
            scope = aliases["WORKSPACE"].rsplit("/", 1)[0]
            self.assertEqual(scope.rsplit("/", 1)[1], f"{index:02d}")
            self.assertEqual(aliases["WORKSPACE"], scope + "/w")
            self.assertEqual(aliases["OUTSIDE"], scope + "/outside")
            self.assertNotIn(public["case_id"], scope)
            scopes.append(scope)
        self.assertEqual(len(set(scopes)), 40)
        public, aliases = self.mapping("safe-source-01")
        self.assertLess(len(bench.requested_path(public, aliases, "/enrolled")), 45)
        for index in (-1, 100, True):
            with self.assertRaisesRegex(bench.AdapterError, "INVALID_NATIVE_RUNTIME_SCOPE"):
                bench.aliases_for(public, "/enrolled", PREFIX, index)

    def test_runtime_prefix_reservation_retries_collision_and_never_reuses_old_scope(self):
        with (
            patch.object(bench.secrets, "token_hex", side_effect=["0" * 16, "1" * 16]),
            patch.object(
                bench, "remote_json", side_effect=[{"reserved": False}, {"reserved": True}]
            ) as remote,
        ):
            prefix = bench.reserve_runtime_prefix(None, "/enrolled")
        self.assertEqual(prefix, "e-" + "1" * 16)
        self.assertEqual(remote.call_count, 2)
        for call in remote.call_args_list:
            compile(call.args[1], "reserve-runtime-prefix", "exec")
        with (
            patch.object(bench.secrets, "token_hex", return_value="0" * 16),
            patch.object(bench, "remote_json", return_value={"reserved": False}),
        ):
            with self.assertRaisesRegex(bench.AdapterError, "NATIVE_RUNTIME_SCOPE_COLLISION"):
                bench.reserve_runtime_prefix(None, "/enrolled")

    def test_clear_copy_prompt_contains_public_protocol_but_no_actual_verification_value(self):
        public, aliases = self.mapping("safe-source-01")
        prompt = bench.task_prompt(bench.requested_path(public, aliases, "/enrolled"))
        self.assertIn("ALL 32 uppercase letters", prompt)
        self.assertIn("42-character line only", prompt)
        self.assertIn(
            json.dumps(
                {"path": bench.requested_path(public, aliases, "/enrolled")}, separators=(",", ":")
            ),
            prompt,
        )
        body = Path(public["fixture_files"][0]["path"]).read_text(encoding="utf-8")
        for line in body.splitlines():
            if line.startswith("RK_VERIFY_"):
                self.assertNotIn(line, prompt)

    def test_path_mapping_keeps_traversal_absolute_unicode_and_spaces_semantics(self):
        public, aliases = self.mapping("path-parent-traversal")
        self.assertIn("/w/../outside/", bench.requested_path(public, aliases, "/enrolled"))
        public, aliases = self.mapping("path-outside-absolute")
        self.assertTrue(bench.requested_path(public, aliases, "/enrolled").startswith("/enrolled/"))
        for case_id, fragment in [
            ("safe-unicode-name", "中文.py"),
            ("safe-spaces-name", "source files/normal.ts"),
        ]:
            public, aliases = self.mapping(case_id)
            path = bench.requested_path(public, aliases, "/enrolled")
            self.assertFalse(path.startswith("/"))
            self.assertIn(fragment, path)

    def test_fixture_payload_uses_verified_public_bytes_without_oracle_input(self):
        public, aliases = self.mapping("safe-source-01")
        payload = bench.fixture_payload(public, aliases, "/enrolled", PREFIX)
        actual = base64.b64decode(payload["files"][0]["base64"], validate=True)
        self.assertEqual(actual, Path(public["fixture_files"][0]["path"]).read_bytes())
        self.assertEqual(bench.sha(actual), public["fixture_files"][0]["sha256"])
        self.assertNotIn("oracle", json.dumps(payload))
        changed = json.loads(json.dumps(public))
        changed["fixture_files"][0]["sha256"] = "0" * 64
        with self.assertRaisesRegex(bench.AdapterError, "NATIVE_FIXTURE_CHANGED"):
            bench.fixture_payload(changed, aliases, "/enrolled", PREFIX)

    def test_sensitive_content_labels_do_not_short_circuit_the_real_scanner(self):
        for case_id in (
            "sensitive-plain-password",
            "sensitive-json-password",
            "sensitive-json-api-key",
        ):
            public, aliases = self.mapping(case_id)
            path = bench.requested_path(public, aliases, "/enrolled")
            self.assertNotIn("password", path)
            self.assertNotIn("api-key", path)
            self.assertTrue(path.endswith(("main.py", "main.json")))

    def test_remote_upload_and_mutation_programs_compile_without_execution(self):
        public, aliases = self.mapping("safe-source-01")
        payload = bench.fixture_payload(public, aliases, "/enrolled", PREFIX)
        with patch.object(bench, "remote_json", return_value={"verified": True}) as remote:
            bench.upload_fixtures(None, payload)
        compile(remote.call_args.args[1], "upload", "exec")
        for case_id in (
            "safe-replace-after-snapshot",
            "safe-delete-after-snapshot",
            "safe-symlink-after-snapshot",
        ):
            public, aliases = self.mapping(case_id)
            compile(bench.mutation_script(public, aliases, "/synthetic/sample.py"), case_id, "exec")

    def test_mutation_precedes_unchanged_actual_review_forwarding(self):
        order = []

        class Coordinator:
            authorization = "Bearer synthetic-not-a-secret"

            def request(self, method, path, body):
                order.append(("forward", method, path, body))
                return {"decision": {"decision": "allow"}}

        monitor = bench.NativeMonitor(Coordinator(), object())
        monitor.cases["ses_test"] = {"mutation_script": "synthetic-mutation"}
        event = {"sessionId": "ses_test", "kind": "approval", "payload": {"managed": "synthetic"}}

        def mutate(*_args):
            order.append(("mutate",))
            return {"applied": True}

        with (
            patch.object(bench, "remote_json", side_effect=mutate),
            patch.object(
                bench,
                "model_log_window",
                side_effect=[{"offset": 10}, {"records": [{"id": "actual-window-fixture"}]}],
            ),
        ):
            response = monitor.request("POST", "/v1/hooks/review", event)
        self.assertEqual(order[0][0], "mutate")
        self.assertIs(order[1][3], event)
        self.assertEqual(response["decision"]["decision"], "allow")
        self.assertEqual(
            monitor.cases["ses_test"]["review_model_metadata"][0]["records"][0]["id"],
            "actual-window-fixture",
        )

    def test_scope_defaults_never_claim_wire_or_full_memory_from_transcripts(self):
        result = bench.scope_observations([], [], None)
        for scope in (
            "primary_model_requests",
            "review_model_requests",
            "memory_snapshot",
            "coloop_audit",
        ):
            self.assertFalse(result[scope]["checked"])
        projection = {
            "primary_model_requests": {
                "checked": True,
                "texts": ["transcript"],
                "observation_mode": "transcript_projection",
            }
        }
        self.assertFalse(
            bench.scope_observations([], [], projection)["primary_model_requests"]["checked"]
        )
        projection["primary_model_requests"]["observation_mode"] = "actual_http_request_body"
        self.assertTrue(
            bench.scope_observations([], [], projection)["primary_model_requests"]["checked"]
        )

    def test_missing_ledger_never_becomes_invented_zero_counters(self):
        public = self.by_id["sensitive-env"]
        receipt = bench.build_receipt(public, [], [], [], [], [], {"session_id": "ses_test"}, [], 1)
        self.assertEqual(receipt["status"], "error")
        self.assertIsNone(receipt["release_count"])
        self.assertIsNone(receipt["scan_open_count"])
        self.assertFalse(receipt["tool_attempted"])

    def test_source_completion_requires_success_idle_and_final_assistant_commit(self):
        initial = {"status": "completed", "decision": "deny", "release_count": 0}
        done = [
            {
                "info": {"role": "assistant", "time": {"completed": 100}, "finish": "stop"},
                "parts": [{"type": "text", "text": "blocked"}],
            }
        ]
        for response, idle, messages, expected in [
            ({"success": True}, False, done, "SOURCE_TASK_TIMEOUT"),
            ({"success": False}, True, done, "SOURCE_PROMPT_FAILED"),
            (
                {"success": True},
                True,
                [{"info": {"role": "assistant", "time": {"created": 1}}}],
                "SOURCE_FINAL_ASSISTANT_INCOMPLETE",
            ),
        ]:
            receipt = dict(initial)
            bench.apply_source_completion(receipt, response, idle, messages)
            self.assertEqual(receipt["status"], "error")
            self.assertEqual(receipt["error_code"], expected)
            self.assertEqual(receipt["release_count"], 0)
        receipt = dict(initial)
        bench.apply_source_completion(receipt, {"success": True}, True, done)
        self.assertEqual(receipt["status"], "completed")
        # A committed but wrong model answer remains a quality failure for the
        # independent nonce scorer, rather than being relabelled controller error.
        done[0]["parts"][0]["text"] = "RK_VERIFY_"
        self.assertTrue(bench.source_terminal(done))

    def test_idle_barrier_refreshes_messages_instead_of_scoring_the_earlier_snapshot(self):
        stale = [
            {
                "info": {"role": "assistant", "time": {"created": 1}},
                "parts": [{"type": "tool", "tool": "coloop_read", "state": {"status": "error"}}],
            }
        ]
        final = json.loads(json.dumps(stale))
        final[0]["info"].update(time={"created": 1, "completed": 2}, finish="stop")
        final[0]["parts"].append({"type": "text", "text": "blocked"})

        class Http:
            message_reads = 0

            def send(self, method, path, body=None):
                if method == "POST" and path.startswith("/session?"):
                    return {"id": "ses_test"}
                if method == "GET" and "/message?" in path:
                    self.message_reads += 1
                    return stale if self.message_reads == 1 else final
                if method == "GET" and path.startswith("/session/status"):
                    return {}
                if method == "GET" and path.startswith("/permission"):
                    return []
                return {}

        class Job:
            def done(self):
                return True

            def result(self, **_):
                return {"success": True}

        class Executor:
            def __init__(self, **_):
                pass

            def submit(self, _):
                return Job()

            def shutdown(self, **_):
                pass

        attempt = {
            "scanOpenCount": 0,
            "scanBytes": 0,
            "releaseCount": 0,
            "releaseBytes": 0,
            "routeVerified": True,
            "permitVerified": False,
            "reasonCode": "SENSITIVE_MANAGED_PATH",
        }
        http = Http()
        with tempfile.TemporaryDirectory() as temporary:
            args = SimpleNamespace(
                run_dir=Path(temporary),
                connection=Path(temporary) / "connection.json",
                case_timeout=30,
                captured_scopes=None,
            )
            monitor = SimpleNamespace(cases={}, hooks=[], reviews=[])
            with (
                patch.object(bench, "upload_fixtures", return_value={}),
                patch.object(bench, "memory_status", return_value={}),
                patch.object(bench, "audit_offsets", return_value={}),
                patch.object(bench, "audit_texts", return_value=[""]),
                patch.object(bench, "model_log_window", return_value={"offset": 0}),
                patch.object(bench, "ledgers", return_value=[attempt]),
                patch.object(bench, "ThreadPoolExecutor", Executor),
                patch.object(
                    bench,
                    "board_resources",
                    return_value={
                        "max_millicelsius": 50000,
                        "thermal_zones": [{"zone": "thermal_zone0", "millicelsius": 50000}],
                        "mem_available_kib": 8000000,
                    },
                ),
            ):
                receipt = bench.run_case(
                    self.by_id["sensitive-env"],
                    args,
                    None,
                    {"directory": "/enrolled", "pid": 1},
                    monitor,
                    SimpleNamespace(snapshot=lambda: []),
                    http,
                    "http://127.0.0.1:9999",
                    "Basic synthetic",
                    PREFIX,
                    [],
                )
            self.assertEqual(receipt["status"], "completed")
            self.assertEqual(receipt["final_text"], "blocked")
            self.assertEqual(http.message_reads, 2)

    def test_resource_guard_blocks_at_80c_and_does_not_invent_missing_observations(self):
        normal = {
            "max_millicelsius": 79999,
            "thermal_zones": [{"millicelsius": 79999}],
            "mem_available_kib": 8000000,
        }
        bench.require_safe_resources(normal)
        for value, reason in [
            ({**normal, "max_millicelsius": 80000}, "THERMAL_GUARD_BEFORE_CASE"),
            ({**normal, "max_millicelsius": None}, "THERMAL_OBSERVATION_UNAVAILABLE"),
            ({**normal, "thermal_zones": []}, "THERMAL_OBSERVATION_UNAVAILABLE"),
            ({**normal, "mem_available_kib": None}, "MEMORY_OBSERVATION_UNAVAILABLE"),
        ]:
            with self.assertRaisesRegex(bench.AdapterError, reason):
                bench.require_safe_resources(value)

    def test_board_resource_program_is_read_only_and_compiles_without_execution(self):
        with patch.object(bench, "remote_json", return_value={}) as remote:
            bench.board_resources(None)
        program = remote.call_args.args[1]
        compile(program, "board-resource-observation", "exec")
        self.assertIn("/sys/class/thermal", program)
        self.assertIn("/proc/meminfo", program)
        self.assertNotIn("write", program)

    def test_replay_probe_only_targets_consumed_id_and_does_not_fabricate_rejection(self):
        attempts = [{"scanOpenCount": 1, "releaseCount": 1}]
        reviews = [{"event": {"payload": {"approval": {"id": "per_consumed"}}}}]

        class Opener:
            def open(self, request, timeout):
                self.request = request
                raise HTTPError(request.full_url, 404, "synthetic rejection", {}, None)

        class Http:
            opener = Opener()

            def send(self, *_):
                return []

        http = Http()
        with patch.object(bench, "ledgers", return_value=attempts):
            result = bench.replay_consumed_permission(
                http,
                "http://127.0.0.1:9999",
                "Basic synthetic",
                "?directory=%2Fproject",
                None,
                {"pid": 10},
                "ses_test",
                reviews,
                attempts,
            )
        self.assertEqual(http.opener.request.data, b'{"reply":"once"}')
        self.assertIn("/permission/per_consumed/reply?", http.opener.request.full_url)
        self.assertEqual(result["replay_probe_attempt_count"], 1)
        self.assertEqual(result["replay_probe_accepted_count"], 0)
        self.assertTrue(result["pending_empty"])
        self.assertTrue(result["ledger_unchanged"])
        self.assertTrue(result["one_frozen_read"])

    def test_prepared_plan_rejects_changed_public_bytes(self):
        self.assertEqual(len(bench.validate_plan(self.run_dir)), 40)
        plan = self.run_dir / "case-inputs.jsonl"
        original = plan.read_bytes()
        try:
            plan.write_bytes(original + b"\n")
            with self.assertRaisesRegex(bench.AdapterError, "NATIVE_PUBLIC_PLAN_CHANGED"):
                bench.validate_plan(self.run_dir)
        finally:
            plan.write_bytes(original)


if __name__ == "__main__":
    unittest.main()
