"""Exercise the real Browser Use SDK against an isolated, synthetic local page.

This is a host-side CDP capability probe, not an LLM/HID quality benchmark.
No user browser profile, cloud model or existing Coloop process is used.
"""

import argparse
import asyncio
import base64
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import secrets
import threading
import time


class Fixture(BaseHTTPRequestHandler):
    def handle(self):
        try:
            super().handle()
        except (ConnectionResetError, BrokenPipeError):
            # Chrome can close its speculative connection during browser teardown.
            pass

    def do_GET(self):
        body = """<!doctype html><meta charset="utf-8"><title>RK Browser Use probe</title>
<h1>Browser Use 本地测试</h1><label for="value">验证串</label><input id="value">
<button id="apply" onclick="document.querySelector('#result').textContent=
document.querySelector('#value').value">应用</button><output id="result"></output>
<a id="next" href="/next">下一页</a>"""
        if self.path == "/next":
            body = "<!doctype html><meta charset='utf-8'><h1 id='done'>下一页已到达</h1>"
        encoded = body.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, *_args):
        pass


async def probe(output, chrome):
    # Set before importing the SDK. These switches disable optional reporting;
    # they are not a network sandbox for arbitrary future websites.
    for name in ("ANONYMIZED_TELEMETRY", "BROWSER_USE_CLOUD_SYNC", "BROWSER_USE_CLOUD_HINTS"):
        os.environ[name] = "false"
    os.environ["BROWSER_USE_CONFIG_DIR"] = str(output / "sdk-config")
    from browser_use import BrowserSession

    server = ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    browser = BrowserSession(
        executable_path=str(chrome),
        headless=True,
        user_data_dir=str(output / "chrome-profile"),
        downloads_path=str(output / "downloads"),
        enable_default_extensions=False,
        use_cloud=False,
        allowed_domains=["127.0.0.1"],
    )
    report = {
        "at": datetime.now(timezone.utc).isoformat(),
        "host": platform.node(),
        "python": platform.python_version(),
        "browser_use": importlib.metadata.version("browser-use"),
        "backend": "Windows CDP; no RK USB input",
        "model_calls": 0,
        "steps": [],
        "success": False,
    }
    total = time.monotonic()

    async def timed(name, action):
        start_at = datetime.now(timezone.utc).isoformat()
        start = time.monotonic()
        step = {"name": name, "start": start_at, "clock_host": report["host"]}
        try:
            value = await action()
            step["success"] = True
            return value
        except BaseException as exc:
            step.update(success=False, error=f"{type(exc).__name__}: {exc}")
            raise
        finally:
            step.update(
                end=datetime.now(timezone.utc).isoformat(),
                elapsed_ms=round((time.monotonic() - start) * 1000, 3),
            )
            report["steps"].append(step)

    async def unique(page, selector):
        elements = await page.get_elements_by_css_selector(selector)
        if len(elements) != 1:
            raise RuntimeError(f"Expected one element for {selector}, got {len(elements)}")
        return elements[0]

    try:
        await timed("browser_start", browser.start)
        url = f"http://127.0.0.1:{server.server_port}/"
        await timed("navigate_fixture", lambda: browser.navigate_to(url))
        state = await timed(
            "dom_observation", lambda: browser.get_browser_state_summary(include_screenshot=False)
        )
        dom = state.dom_state.llm_representation()
        (output / "dom.txt").write_text(dom, encoding="utf-8")
        report["dom_utf8_bytes"] = len(dom.encode("utf-8"))
        page = await browser.get_current_page()
        token = "RK-BU-" + secrets.token_hex(10) + "-中文"
        field = await unique(page, "#value")
        await timed("fill_synthetic_value", lambda: field.fill(token))
        button = await unique(page, "#apply")
        await timed("click_apply", button.click)

        async def verify():
            actual = await page.evaluate("() => document.querySelector('#result').textContent")
            if actual != token:
                raise RuntimeError(f"Value mismatch: {actual!r}")
            report["verification_token"] = token

        await timed("verify_exact_value", verify)
        (output / "page.png").write_bytes(base64.b64decode(await page.screenshot()))
        link = await unique(page, "#next")
        await timed("click_next_page", link.click)

        async def verify_next():
            for _ in range(30):
                if (await page.get_url()).endswith("/next"):
                    found = await page.evaluate("() => document.querySelector('#done')?.textContent")
                    if found == "下一页已到达":
                        return
                await asyncio.sleep(0.1)
            raise RuntimeError("Next page was not verified")

        await timed("verify_navigation", verify_next)
        report["success"] = True
    except BaseException as exc:
        report["error"] = f"{type(exc).__name__}: {exc}"
        raise
    finally:
        try:
            await timed("browser_cleanup", browser.kill)
        except BaseException as exc:
            report.update(success=False, cleanup_error=f"{type(exc).__name__}: {exc}")
            raise
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)
            report["elapsed_ms"] = round((time.monotonic() - total) * 1000, 3)
            (output / "summary.json").write_text(
                json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
            )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument(
        "--chrome", type=Path,
        default=Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
    )
    args = parser.parse_args()
    if not args.chrome.is_file():
        parser.error("Chrome executable does not exist; specify --chrome")
    # A new directory is mandatory: old experimental evidence is never overwritten.
    args.output_dir = args.output_dir.resolve()
    args.output_dir.mkdir(parents=True, exist_ok=False)
    asyncio.run(probe(args.output_dir, args.chrome))
    print(args.output_dir / "summary.json")


if __name__ == "__main__":
    main()
