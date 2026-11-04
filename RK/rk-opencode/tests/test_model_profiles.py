"""Model switching, template isolation, asset identity and long-lived clients."""

import copy
import io
import json
from pathlib import Path
import shlex
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "bridge"))
from model_profiles import (  # noqa: E402
    WORKER_PROTOCOL, build_signature, check_assets, config_path, health_matches,
    load_profile, opencode_config, running_model,
)
from protocol import prepare  # noqa: E402


class ModelProfileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "model-profiles").mkdir()
        (self.root / "src").mkdir()
        (self.root / "src/worker.cpp").write_text("first worker")
        for name in ("opencode.json", "opencode-qwen.json", "opencode-coloop-managed.json"):
            shutil.copyfile(ROOT / name, self.root / name)
        self.app = self.root / "assets with 中文 $ ` quotes'"
        for folder in ("include", "lib"):
            (self.app / folder).mkdir(parents=True)
        for name in ("model.rkllm", "include/rkllm.h", "lib/librkllmrt.so"):
            (self.app / name).write_text("test fixture, no inference")
        self.spec = json.loads((ROOT / "model-profiles/qwen35-4b.json").read_text())
        self.spec.update(app=str(self.app), model="model.rkllm", model_id="qwen3-8b-test")
        self.save()

    def save(self, name="custom-8b"):
        (self.root / "model-profiles" / (name + ".json")).write_text(json.dumps(self.spec))

    def load(self, env=None, name="custom-8b"):
        return load_profile(name, root=self.root, environ=env or {})

    def test_new_name_keeps_embedded_template_and_actual_tool_results(self):
        profile = self.load()
        body = {"model": profile["model_id"], "messages": [
            {"role": "system", "content": "Use exact observed values."},
            {"role": "user", "content": "Read data."},
            {"role": "tool", "content": "VERIFICATION_TOKEN=observed"},
        ]}
        prompt, _, _ = prepare(body, profile["model_id"], profile["prompt_format"])
        self.assertNotIn("<｜", prompt)
        self.assertNotIn("<|im_start|>", prompt)
        self.assertIn("VERIFICATION_TOKEN=observed", prompt)

    def test_renamed_deepseek_retains_prefixed_reasoning_format(self):
        self.spec.update(prompt_format="deepseek-r1", thinking=True,
                         native_cache=False, cache_mode="off")
        self.save()
        profile = self.load()
        body = {"model": profile["model_id"], "messages": [{"role": "user", "content": "hi"}]}
        self.assertTrue(prepare(body, profile["model_id"], profile["prompt_format"])[0].endswith(
            "<｜Assistant｜><think>\n"
        ))

    def test_generated_client_limits_and_permissions_follow_profile(self):
        profile = self.load({"RKLLM_CONTEXT": "8192", "RK_AGENT_MODEL_ID": "replacement-8b"})
        config = opencode_config(profile, self.root)
        original = json.loads((ROOT / "opencode-qwen.json").read_text())
        self.assertEqual(config["model"], "rkllm/replacement-8b")
        self.assertEqual(config["small_model"], config["model"])
        model = config["provider"]["rkllm"]["models"]["replacement-8b"]
        self.assertEqual(model["limit"], {"context": 8192, "output": 256})
        for key in ("agent", "mcp", "plugin", "compaction"):
            self.assertEqual(config[key], original[key])
        path = config_path(profile, self.root)
        self.assertEqual(json.loads(path.read_text(encoding="utf-8")), config)
        self.assertNotIn("api-key", path.read_text(encoding="utf-8"))

    def test_deepseek_does_not_inherit_memory_or_desktop_permissions(self):
        profile = load_profile("deepseek", environ={})
        config = opencode_config(profile)
        self.assertEqual(config["mcp"], {})
        self.assertEqual(config["agent"]["rk-local"]["permission"], {"*": "deny", "read": "allow"})

    def test_managed_config_rebinds_model_without_expanding_permission(self):
        profile = self.load()
        config = opencode_config(profile, self.root, managed=True)
        self.assertEqual(config["model"], "rkllm/qwen3-8b-test")
        self.assertEqual(config["mcp"], {})
        self.assertEqual(
            config["permission"], {"*": "deny", "coloop_read": "ask", "question": "allow"}
        )
        self.assertEqual(config["provider"]["rkllm"]["options"]["headers"],
                         {"X-RK-Privacy": "metadata-only", "X-RK-Cache": "off"})

    def test_rejects_bad_name_unknown_field_and_invalid_capabilities(self):
        for name in ("../escape", "custom;echo", "", "qwen/8b"):
            with self.assertRaises((ValueError, FileNotFoundError)):
                load_profile(name, root=self.root, environ={})
        for field, value in (("context_limit", True), ("context", 32768),
                             ("max_output", 4096), ("thinking", "false"),
                             ("prompt_format", "guess-from-name"), ("typo", 1)):
            with self.subTest(field=field):
                original = copy.deepcopy(self.spec)
                self.spec[field] = value
                self.save()
                with self.assertRaises(ValueError):
                    self.load()
                self.spec = original
        self.spec.update(native_cache=False, cache_mode="off")
        self.save()
        with self.assertRaises(ValueError):
            self.load({"RK_AGENT_CACHE_MODE": "native"})

    def test_context_is_bounded_by_the_conversion_limit(self):
        with self.assertRaises(ValueError):
            self.load({"RKLLM_CONTEXT": "32768"})
        self.assertEqual(self.load({"RKLLM_CONTEXT": "512"})["max_output"], 511)

    def test_health_rejects_stale_asset_source_context_cache_and_protocol(self):
        profile = self.load()
        health = {"ready": True, "model": profile["model_id"], "context": profile["context"],
                  "cache_mode": profile["cache_mode"], "worker_protocol": WORKER_PROTOCOL,
                  "profile_fingerprint": profile["fingerprint"]}
        self.assertTrue(health_matches(health, profile))
        for field, value in (("context", 2048), ("model", "old-4b"),
                             ("cache_mode", "off"), ("worker_protocol", 2)):
            self.assertFalse(health_matches({**health, field: value}, profile))
        (self.app / "model.rkllm").write_text("changed same-path model asset")
        self.assertFalse(health_matches(health, self.load()))
        health["profile_fingerprint"] = self.load()["fingerprint"]
        (self.root / "src/worker.cpp").write_text("new worker code")
        self.assertFalse(health_matches(health, self.load()))

    def test_asset_preflight_and_matching_build_signature(self):
        profile = self.load()
        check_assets(profile)
        signature = build_signature(profile, self.root)
        (self.app / "include/rkllm.h").write_text("different ABI")
        self.assertNotEqual(build_signature(self.load(), self.root), signature)
        (self.app / "model.rkllm").unlink()
        with self.assertRaises(ValueError):
            check_assets(self.load())

    def test_long_lived_client_discovers_new_model_each_time(self):
        (self.root / ".runtime").mkdir()
        (self.root / ".runtime/api-key").write_text("private-test-key")
        routes = [{"ready": True, "model": name, "context": 8192, "max_output": 512}
                  for name in ("old-4b", "new-8b")]
        responses = [io.BytesIO(json.dumps(value).encode()) for value in routes]
        with patch("model_profiles.urllib.request.urlopen", side_effect=responses) as opened:
            self.assertEqual(running_model(self.root)["model"], "old-4b")
            self.assertEqual(running_model(self.root)["model"], "new-8b")
        self.assertEqual(opened.call_count, 2)

    def test_shell_values_quote_special_characters(self):
        profile = self.load()
        assignment = "RKLLM_APP=" + shlex.quote(profile["app"])
        self.assertEqual(shlex.split(assignment), ["RKLLM_APP=" + profile["app"]])


if __name__ == "__main__":
    unittest.main()
