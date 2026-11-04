"""Measure real native-hook/RK approval transport with a scripted source provider.

The source OpenCode, native question Deferred, production SDK hook, Coloop review,
RK NPU decision and source consumption stay real. Only the source provider's two
turns are scripted: request the user's unchanged question, then echo its real tool
result. This is not a primary-model development success-rate benchmark and does
not replace earlier failed all-NPU-source experiments. Run only when the shared
NPU has been explicitly assigned to this experiment.
"""

from __future__ import annotations

from contextlib import redirect_stdout
import hashlib
import io
import json
from pathlib import Path
import sys
from typing import Any

import bench_coloop_hooks as bench
from coloop_agent import canonical_json


SCRIPTED_SOURCE_PLUGIN = r'''// TEST ONLY: scripted source; never computes or replies to an approval.
import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const PREFIX = "Call question now using exactly these arguments: ";
const BODY_LIMIT = 65536;
function fail(code) { throw new Error(code); }
function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  return JSON.stringify(value);
}
function text(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every(v => v?.type === "text" && typeof v.text === "string"))
    return value.map(v => v.text).join("");
  fail("INVALID_SCRIPTED_REQUEST");
}
function question(raw) {
  const value = JSON.parse(raw), q = value?.questions?.[0];
  if (!value || Object.keys(value).length !== 1 || !Array.isArray(value.questions) ||
      value.questions.length !== 1 || !q || typeof q.question !== "string" ||
      !q.question || q.question.length > 4000 || q.multiple === true ||
      !Array.isArray(q.options) || q.options.length < 2 || q.options.length > 20 ||
      !q.options.every(o => typeof o?.label === "string" && o.label.length > 0 &&
        o.label.length <= 200 && typeof o.description === "string") ||
      new Set(q.options.map(o => o.label)).size !== q.options.length)
    fail("INVALID_SCRIPTED_QUESTION");
  return value;
}
function answerText(q, label) {
  return `User has answered your questions: "${q.question}"="${label}". You can now continue with the user's answers in mind.`;
}
function plan(body) {
  if (!body || !Array.isArray(body.messages) || body.messages.length > 128 ||
      !body.messages.every(v => v && typeof v.role === "string")) fail("INVALID_SCRIPTED_REQUEST");
  let user = -1;
  for (let i = body.messages.length - 1; i >= 0; i--)
    if (body.messages[i].role === "user") { user = i; break; }
  if (user < 0) fail("MISSING_CURRENT_USER");
  const prompt = text(body.messages[user].content);
  if (!prompt.startsWith(PREFIX)) fail("INVALID_CURRENT_USER");
  const raw = prompt.slice(PREFIX.length).trim(), args = question(raw), q = args.questions[0];
  const after = body.messages.slice(user + 1), results = after.filter(v => v.role === "tool");
  if (!results.length) {
    if (after.some(v => v.tool_calls?.length) || !Array.isArray(body.tools) ||
        !body.tools.some(v => v?.type === "function" && v.function?.name === "question"))
      fail("QUESTION_TOOL_REQUIRED");
    return { phase: "tool", calls: [{ id: "call_" + randomUUID().replaceAll("-", ""),
      type: "function", function: { name: "question", arguments: raw } }] };
  }
  if (results.length !== 1 || typeof results[0].tool_call_id !== "string")
    fail("AMBIGUOUS_TOOL_RESULT");
  const calls = after.filter(v => v.role === "assistant").flatMap(v => v.tool_calls ?? []);
  if (calls.length !== 1 || calls[0].id !== results[0].tool_call_id ||
      calls[0].type !== "function" || calls[0].function?.name !== "question") fail("UNKNOWN_TOOL_RESULT");
  if (canonical(question(calls[0].function.arguments)) !== canonical(args))
    fail("CHANGED_QUESTION_ARGUMENTS");
  const result = text(results[0].content);
  const matches = q.options.filter(o => result === answerText(q, o.label));
  if (matches.length !== 1) fail("UNRECOGNIZED_QUESTION_RESULT");
  return { phase: "final", content: matches[0].label };
}
export default async function () {
  const key = randomBytes(32).toString("hex"), expected = createHash("sha256").update(key).digest();
  const folder = join(dirname(fileURLToPath(import.meta.url)), "logs");
  const metricsPath = join(folder, "scripted-source-metrics.json");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const metrics = { version: 1, source_model_scripted: true, requests: 0,
    tool_responses: 0, final_responses: 0, rejected: 0, request_bytes: 0,
    streamed_responses: 0, closed: false };
  let stopped = false, latest, writing;
  function persist() {
    latest = JSON.stringify(metrics);
    if (!writing) writing = (async () => {
      while (latest !== undefined) {
        const value = latest; latest = undefined;
        const pending = metricsPath + "." + randomUUID() + ".pending";
        try { await writeFile(pending, value, { mode: 0o600, flag: "wx" }); await rename(pending, metricsPath); }
        finally { await unlink(pending).catch(() => {}); }
      }
    })().finally(() => { writing = undefined; });
    return writing;
  }
  const reply = (res, status, value) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { "content-type": "application/json", connection: "close", "cache-control": "no-store" });
    res.end(JSON.stringify(value));
  };
  async function handle(req, res) {
    metrics.requests++;
    try {
      if (stopped || metrics.requests > 1024) { reply(res, 429, { error: "SCRIPTED_SOURCE_LIMIT" }); return; }
      if (req.headers.origin !== undefined || req.headers["sec-fetch-site"] !== undefined) {
        reply(res, 403, { error: "BROWSER_ORIGIN_REJECTED" }); metrics.rejected++; return;
      }
      const auth = req.headers.authorization ?? "";
      const supplied = auth.startsWith("Bearer ") && auth.length < 128 ? auth.slice(7) : "";
      if (!supplied || !timingSafeEqual(expected, createHash("sha256").update(supplied).digest())) {
        reply(res, 401, { error: "UNAUTHORIZED" }); metrics.rejected++; return;
      }
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        reply(res, 404, { error: "NOT_FOUND" }); metrics.rejected++; return;
      }
      if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] ?? "") || req.headers["content-encoding"]) {
        reply(res, 415, { error: "JSON_REQUIRED" }); metrics.rejected++; return;
      }
      if (Number(req.headers["content-length"] ?? 0) > BODY_LIMIT) {
        reply(res, 413, { error: "BODY_LIMIT" }); metrics.rejected++; return;
      }
      const chunks = []; let size = 0;
      const timeout = setTimeout(() => req.destroy(), 5000);
      try {
        for await (const chunk of req) {
          size += chunk.length;
          if (size > BODY_LIMIT) fail("BODY_LIMIT");
          chunks.push(chunk);
        }
      } finally { clearTimeout(timeout); metrics.request_bytes += size; }
      const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
      const result = plan(body), id = "chatcmpl-" + randomUUID(), created = Math.floor(Date.now() / 1000);
      const finish = result.phase === "tool" ? "tool_calls" : "stop";
      if (result.phase === "tool") metrics.tool_responses++; else metrics.final_responses++;
      if (body.stream === true) {
        metrics.streamed_responses++;
        res.writeHead(200, { "content-type": "text/event-stream", connection: "close", "cache-control": "no-store" });
        const delta = { role: "assistant", ...(result.calls ? { tool_calls: result.calls.map((v, index) => ({ index, ...v })) } : { content: result.content }) };
        const chunk = (delta, reason) => ({ id, object: "chat.completion.chunk", created,
          model: "coloop-scripted-source", choices: [{ index: 0, delta, finish_reason: reason }] });
        res.write("data: " + JSON.stringify(chunk(delta, null)) + "\n\n");
        res.write("data: " + JSON.stringify(chunk({}, finish)) + "\n\n");
        res.end("data: [DONE]\n\n");
      } else {
        reply(res, 200, { id, object: "chat.completion", created, model: "coloop-scripted-source",
          choices: [{ index: 0, message: { role: "assistant", content: result.content ?? null,
            ...(result.calls ? { tool_calls: result.calls } : {}) }, finish_reason: finish }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
      }
    } catch (error) {
      metrics.rejected++;
      reply(res, error?.message === "BODY_LIMIT" ? 413 : 400, { error: "INVALID_SCRIPTED_REQUEST" });
    } finally { void persist().catch(() => {}); }
  }
  const server = createServer((req, res) => { void handle(req, res).catch(() => reply(res, 500, { error: "SCRIPTED_SOURCE_FAILED" })); });
  server.headersTimeout = 5000; server.requestTimeout = 5000; server.keepAliveTimeout = 500;
  server.maxConnections = 4;
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  server.on("error", () => {}); server.unref();
  await persist();
  return {
    config: async config => {
      if (!config.provider?.rkllm?.options) fail("SCRIPTED_PROVIDER_REQUIRED");
      config.provider.rkllm.options.baseURL = `http://127.0.0.1:${server.address().port}/v1`;
      config.provider.rkllm.options.apiKey = key;
    },
    dispose: async () => {
      stopped = true; server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
      metrics.closed = true; await persist();
    },
  };
}
'''

METRIC_FIELDS = {
    "version", "source_model_scripted", "requests", "tool_responses", "final_responses",
    "rejected", "request_bytes", "streamed_responses", "closed",
}
NOTE = (
    "Controlled source-provider transport benchmark: native OpenCode/pending/SDK hook and RK "
    "review/consumption are real; source planning/final output are scripted. This does not "
    "replace failed all-NPU-source runs or measure primary-model development success rate."
)


def source_fixture_manifest() -> dict[str, Any]:
    return {
        "test_only": True,
        "name": "coloop-scripted-source-provider",
        "code_sha256": hashlib.sha256(SCRIPTED_SOURCE_PLUGIN.encode("utf-8")).hexdigest(),
        "source_model_scripted": True,
        "primary_model_inference": False,
        "rk_review_scripted": False,
        "native_pending_and_sdk_consumption": True,
        "scripted_tool_call_generation": "unchanged current USER question JSON only",
        "scripted_final_generation": "exact unique label from matching real question tool result",
        "expected_answer_injected": False,
        "approval_reply_fabricated": False,
        "messages_or_tool_results_modified": False,
        "production_hook_modified": False,
        "note": NOTE,
    }


def read_provider_metrics(client: Any, startup: dict[str, Any]) -> dict[str, Any]:
    script = (
        "import json\nfrom pathlib import Path\np=Path("
        + repr(startup["temporary"])
        + ")/'logs/scripted-source-metrics.json'\n"
        "data=p.read_bytes()\n"
        "if len(data)>4096:raise RuntimeError('METADATA_LIMIT')\n"
        "print(data.decode('utf-8'))"
    )
    value = bench.remote_json(client, script)
    if not isinstance(value, dict) or set(value) != METRIC_FIELDS:
        raise ValueError("INVALID_SCRIPTED_SOURCE_METRICS")
    if value["version"] != 1 or value["source_model_scripted"] is not True:
        raise ValueError("INVALID_SCRIPTED_SOURCE_METRICS")
    if type(value["closed"]) is not bool or any(
        type(value[key]) is not int or not 0 <= value[key] <= 100_000_000
        for key in METRIC_FIELDS - {"version", "source_model_scripted", "closed"}
    ):
        raise ValueError("INVALID_SCRIPTED_SOURCE_METRICS")
    return value


def verify_source_echo(rows: Any) -> dict[str, Any]:
    """Compare source final text to its actual completed question, without an answer key."""
    checks = []
    for row in rows if isinstance(rows, list) else []:
        messages = row.get("messages", [])
        tools = [
            part
            for message in messages
            for part in message.get("parts", [])
            if part.get("type") == "tool"
        ]
        selected = None
        if len(tools) == 1 and tools[0].get("tool") == "question":
            state = tools[0].get("state", {})
            questions = state.get("input", {}).get("questions", [])
            if state.get("status") == "completed" and len(questions) == 1:
                question = questions[0]
                matches = [
                    option.get("label")
                    for option in question.get("options", [])
                    if isinstance(option.get("label"), str)
                    and state.get("output")
                    == 'User has answered your questions: "'
                    + question.get("question", "")
                    + '"="'
                    + option["label"]
                    + '". You can now continue with the user\'s answers in mind.'
                ]
                if len(matches) == 1:
                    selected = matches[0]
        finals = [
            "".join(
                part.get("text", "")
                for part in message.get("parts", [])
                if part.get("type") == "text"
            )
            for message in messages
            if message.get("info", {}).get("role") == "assistant"
            and any(part.get("type") == "text" for part in message.get("parts", []))
        ]
        checks.append(selected is not None and bool(finals) and finals[-1] == selected)
    return {"checked_samples": len(checks), "exact_tool_result_echo": bool(checks) and all(checks)}


def annotate(report: dict[str, Any], echoes: dict[str, Any]) -> None:
    report.update(
        source="native-opencode-scripted-source-transport",
        source_model_scripted=True,
        primary_model_inference=False,
        rk_review_scripted=False,
        primary_development_success_rate_measured=False,
        measurement_note=NOTE,
        source_fixture=source_fixture_manifest(),
        source_echo=echoes,
    )
    metadata = report.get("cleanup", {}).get("scripted_source", {})
    expected = report.get("requested_samples", 0) + 1
    native_calls = report.get("cleanup", {}).get("requests.jsonl", {})
    rk_calls = (
        native_calls.get("metadata_only") is True and native_calls.get("record_count") == expected
    )
    report["real_rk_review_count_verified"] = rk_calls
    evidence = (
        metadata.get("tool_responses") == expected
        and metadata.get("final_responses") == expected
        and metadata.get("requests") == expected * 2
        and metadata.get("rejected") == 0
        and metadata.get("source_model_scripted") is True
        and rk_calls
        and echoes.get("checked_samples") == expected
        and echoes.get("exact_tool_result_echo") is True
    )
    report["scripted_source_evidence_passed"] = evidence
    if not evidence:
        report["passed"] = False
        report["functionalityPassed"] = False
        report["performancePassed"] = False


def main() -> int:
    parser = bench.argument_parser()
    parser.description = __doc__
    args = parser.parse_args()
    original_code, original_manifest = bench.SOURCE_STAGE_FIXTURE, bench.source_fixture_manifest
    original_cleanup = bench.cleanup

    def cleanup(client, startup):
        result = original_cleanup(client, startup)
        try:
            result["scripted_source"] = read_provider_metrics(client, startup)
        except Exception:
            result["scripted_source"] = {"available": False}
        return result

    try:
        bench.SOURCE_STAGE_FIXTURE = SCRIPTED_SOURCE_PLUGIN
        bench.source_fixture_manifest = source_fixture_manifest
        bench.cleanup = cleanup
        with redirect_stdout(io.StringIO()):
            code = bench.main()
    finally:
        bench.SOURCE_STAGE_FIXTURE = original_code
        bench.source_fixture_manifest = original_manifest
        bench.cleanup = original_cleanup
    output = Path(args.output_dir) / "summary.json"
    report = json.loads(output.read_text(encoding="utf-8"))
    messages = Path(args.output_dir) / "messages.json"
    echoes = verify_source_echo(json.loads(messages.read_text(encoding="utf-8")))
    annotate(report, echoes)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(canonical_json({
        "passed": report["passed"], "functionalityPassed": report.get("functionalityPassed"),
        "performancePassed": report.get("performancePassed"), "pilot": args.pilot,
        "source_model_scripted": True, "rk_review_scripted": False,
        "scripted_source_evidence_passed": report["scripted_source_evidence_passed"],
        "output_dir": str(args.output_dir), "failure_code": report.get("failure_code"),
    }))
    return code if report["scripted_source_evidence_passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
