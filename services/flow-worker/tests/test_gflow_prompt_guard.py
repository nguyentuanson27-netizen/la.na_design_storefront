import asyncio
import glob
import importlib.util
import json
import os
import threading
import time
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from flow_worker import gflow_prompt_guard as guard
from flow_worker.server import TRY_ON_PROMPT

PERSON_ID = "11111111-1111-4111-8111-111111111111"
GARMENT_ID = "22222222-2222-4222-8222-222222222222"
MEDIA_ID = "33333333-3333-4333-8333-333333333333"
WORKFLOW_ID = "44444444-4444-4444-8444-444444444444"
PROJECT_ID = "55555555-5555-4555-8555-555555555555"
ASSETS = {"person-ab12cd34.jpg": PERSON_ID, "garment-ef56ab78.jpg": GARMENT_ID}
FAKE_COMPOSER = Path(__file__).parent / "fixtures" / "fake_flow_composer.html"


def submit_body(prompt: str, references: list[str]) -> str:
    """A form-decoded batchexecute ogiZ0b body, nested the way batchexecute nests JSON."""
    inner = json.dumps([[prompt, [[[None, 1, ref]] for ref in references]], "GEM_PIX_2"])
    return "f.req=" + json.dumps([[["ogiZ0b", inner, None, "generic"]]]) + "&at=token"


class PromptComparisonTest(unittest.TestCase):
    def test_prompt_with_editor_line_breaks_counts_as_present(self):
        rendered = "person-ab12cd34.jpg garment-ef56ab78.jpg " + TRY_ON_PROMPT.replace("\n", "\n\n")
        self.assertTrue(guard.prompt_present(rendered, TRY_ON_PROMPT))

    def test_missing_or_truncated_prompt_is_not_present(self):
        self.assertFalse(guard.prompt_present("person-ab12cd34.jpg garment-ef56ab78.jpg", TRY_ON_PROMPT))
        self.assertFalse(guard.prompt_present(TRY_ON_PROMPT[:-10], TRY_ON_PROMPT))
        self.assertFalse(guard.prompt_present("anything", "   "))


class SubmitBodyPromptTest(unittest.TestCase):
    def test_body_with_both_references_and_the_full_prompt_passes(self):
        self.assertIsNone(
            guard.submit_body_prompt_problem(submit_body(TRY_ON_PROMPT, [PERSON_ID, GARMENT_ID]), TRY_ON_PROMPT)
        )

    def test_reference_only_body_is_refused(self):
        problem = guard.submit_body_prompt_problem(submit_body("", [PERSON_ID, GARMENT_ID]), TRY_ON_PROMPT)
        self.assertIn("does not carry", problem)

    def test_truncated_prompt_is_refused(self):
        body = submit_body(TRY_ON_PROMPT.split("\n")[0], [PERSON_ID, GARMENT_ID])
        self.assertIsNotNone(guard.submit_body_prompt_problem(body, TRY_ON_PROMPT))

    def test_undecodable_or_missing_payload_is_refused(self):
        self.assertIsNotNone(guard.submit_body_prompt_problem("f.req=[[[\"ogiZ0b\"&at=x", TRY_ON_PROMPT))
        self.assertIsNotNone(guard.submit_body_prompt_problem("at=token", TRY_ON_PROMPT))


class InstallTest(unittest.TestCase):
    def test_refuses_to_patch_any_other_gflow_version(self):
        with (
            patch.object(guard, "_installed", False),
            patch.object(guard.metadata, "version", return_value="0.83.0"),
        ):
            with self.assertRaisesRegex(RuntimeError, "0.82.1"):
                guard.install()


def _browser_executable() -> str | None:
    candidates = [os.environ.get("FLOW_TEST_CHROME", "")]
    candidates += sorted(glob.glob("/opt/pw-browsers/chromium-*/chrome-linux/chrome"))
    candidates.append("/opt/google/chrome/chrome")
    return next((path for path in candidates if path and os.access(path, os.X_OK)), None)


BROWSER = _browser_executable()
HAS_GFLOW = all(importlib.util.find_spec(name) for name in ("gflow_cli", "playwright"))
if os.environ.get("FLOW_REQUIRE_BROWSER_TESTS") and not (HAS_GFLOW and BROWSER):
    raise RuntimeError("FLOW_REQUIRE_BROWSER_TESTS is set but gflow-cli, playwright or a browser is missing")


class _FakeFlow(BaseHTTPRequestHandler):
    submits: list[dict] = []

    def log_message(self, *_args):
        return

    def do_GET(self):
        body = FAKE_COMPOSER.read_bytes()
        self.send_response(200)
        self.send_header("content-type", "text/html")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        raw = self.rfile.read(int(self.headers["content-length"])).decode()
        inner = json.loads(json.loads(urllib.parse.parse_qs(raw)["f.req"][0])[0][0][1])
        prompt = inner[0][0]
        self.submits.append({"prompt": prompt, "references": [r[0][2] for r in inner[0][1]]})
        url = f"https://flow-content.google/image/{MEDIA_ID}?Expires=1&Signature=x"
        details = [None, 7, None, None, None, None, 1, prompt, 25, None, None, WORKFLOW_ID, None, url, 3]
        media = [MEDIA_ID, None, WORKFLOW_ID, None, None, None, [details, None, [896, 1200]]]
        workflow = [WORKFLOW_ID, None, None, ["Try-on", [1, 2], None, None, MEDIA_ID], PROJECT_ID]
        frame = json.dumps([["wrb.fr", "ogiZ0b", json.dumps([[[media]], [[workflow]]]), None, None, None, "generic"]])
        body = f")]}}'\n\n{len(frame)}\n{frame}\n".encode()
        self.send_response(200)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


@unittest.skipUnless(HAS_GFLOW and BROWSER, "needs gflow-cli 0.82.1, playwright and a Chromium/Chrome binary")
class GflowTwoReferencesPlusPromptTest(unittest.TestCase):
    """Drives gflow's real attach_references -> send_prompt(append=True) -> ogiZ0b submit."""

    @classmethod
    def setUpClass(cls):
        guard.install()
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _FakeFlow)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        _FakeFlow.submits = []

    def run_try_on(self, **page_modes):
        from gflow_cli.api.image import GenerateImageRequest, Model
        from gflow_cli.api.transports import migrated_composer as mc
        from playwright.async_api import async_playwright

        query = urllib.parse.urlencode({"assets": json.dumps(ASSETS), **page_modes})
        url = f"http://127.0.0.1:{self.server.server_port}/?{query}"

        async def scenario():
            async with async_playwright() as playwright:
                browser = await playwright.chromium.launch(executable_path=BROWSER, args=["--no-sandbox"])
                try:
                    page = await browser.new_page()
                    await page.goto(url)
                    composer = mc.MigratedComposer()
                    uploads = iter(ASSETS.items())

                    async def uploaded(_page, _project_id, _path):
                        name, media_id = next(uploads)
                        return media_id, name

                    composer._upload_via_toolbar = uploaded
                    request = GenerateImageRequest(
                        prompt=TRY_ON_PROMPT,
                        model=Model.GEM_PIX_2,
                        ref_paths=(Path("person.jpg"), Path("garment.jpg")),
                    )
                    try:
                        # The same steps run_images takes for local-file --ref images.
                        reference_ids = await composer.attach_references(page, PROJECT_ID, request.ref_paths)
                        await composer.send_prompt(page, request.prompt, append=True)
                        images = await composer.submit_images_and_observe(
                            page, request, reference_ids=reference_ids
                        )
                        return images, None
                    except Exception as error:  # noqa: BLE001 - asserted by the caller
                        return None, error
                finally:
                    await browser.close()

        return asyncio.run(scenario())

    def with_page(self, scenario_body, **page_modes):
        """Run ``scenario_body(page, composer)`` on the fake composer; return (result, error)."""
        from gflow_cli.api.transports import migrated_composer as mc
        from playwright.async_api import async_playwright

        query = urllib.parse.urlencode({"assets": json.dumps(ASSETS), **page_modes})
        url = f"http://127.0.0.1:{self.server.server_port}/?{query}"

        async def scenario():
            async with async_playwright() as playwright:
                browser = await playwright.chromium.launch(executable_path=BROWSER, args=["--no-sandbox"])
                try:
                    page = await browser.new_page()
                    await page.goto(url)
                    try:
                        return await scenario_body(page, mc.MigratedComposer()), None
                    except Exception as error:  # noqa: BLE001 - asserted by the caller
                        return None, error
                finally:
                    await browser.close()

        return asyncio.run(scenario())

    def test_slow_flow_attaches_the_right_references_without_the_fixed_sleeps(self):
        # The picker opens late, keeps the unfiltered list on screen after each keystroke, and the chip
        # lands late. Enter commits the first option on screen, so acting early attaches the wrong asset.
        started = time.monotonic()
        images, error = self.run_try_on(open_lag=300, filter_lag=400, chip_lag=400)
        elapsed = time.monotonic() - started

        self.assertIsNone(error)
        self.assertEqual(len(images), 1)
        self.assertEqual(_FakeFlow.submits[0]["references"], [PERSON_ID, GARMENT_ID])
        self.assertTrue(guard.prompt_present(_FakeFlow.submits[0]["prompt"], TRY_ON_PROMPT))
        # gflow's own sleeps alone are 2 x (2.2 + 2.5 + 2.5) + 0.6 = 15 s.
        self.assertLess(elapsed, 9, f"mention gestures took {elapsed:.1f}s")

    def test_fixed_sleeps_come_back_with_flow_mention_fast_off(self):
        with patch.dict(os.environ, {"FLOW_MENTION_FAST": "0"}):
            started = time.monotonic()
            images, error = self.run_try_on()
            elapsed = time.monotonic() - started

        self.assertIsNone(error)
        self.assertEqual(_FakeFlow.submits[0]["references"], [PERSON_ID, GARMENT_ID])
        self.assertGreater(elapsed, 14)

    def test_asset_the_picker_never_lists_is_retried_then_refused(self):
        from gflow_cli.api.transports import migrated_composer as mc
        from gflow_cli.errors import ReferenceNotFoundError

        async def mention_missing(page, composer):
            await composer._mention_by_name(page, "no-such-asset.jpg", expect_chips=1)

        with (
            patch.object(guard, "_PICKER_FILTER_CAP_MS", 300),
            patch.object(guard, "_CHIP_COMMIT_CAP_MS", 300),
            patch.object(mc, "FRAME_SEARCH_RETRY_PAUSE_S", 0.05),
        ):
            result, error = self.with_page(mention_missing)

        self.assertIsNone(result)
        self.assertIsInstance(error, ReferenceNotFoundError)
        self.assertIn("3 attempts", str(error))
        self.assertEqual(_FakeFlow.submits, [])

    def test_prompt_lands_and_is_submitted_with_both_references_when_the_caret_left_the_composer(self):
        # Without the guard this exact page state generated with an empty prompt (reproduced).
        images, error = self.run_try_on(focus="lost")

        self.assertIsNone(error)
        self.assertEqual(len(images), 1)
        self.assertEqual(len(_FakeFlow.submits), 1)
        self.assertEqual(_FakeFlow.submits[0]["references"], [PERSON_ID, GARMENT_ID])
        self.assertTrue(guard.prompt_present(_FakeFlow.submits[0]["prompt"], TRY_ON_PROMPT))

    def test_prompt_the_editor_did_not_apply_fails_closed_before_submit(self):
        from gflow_cli.errors import UiSelectorDriftError

        images, error = self.run_try_on(input="ignored")

        self.assertIsNone(images)
        self.assertIsInstance(error, UiSelectorDriftError)
        self.assertIn("prompt was not applied", str(error))
        self.assertEqual(_FakeFlow.submits, [])

    def test_submit_without_the_prompt_is_aborted_before_it_reaches_flow(self):
        from gflow_cli.errors import WireFormatError

        images, error = self.run_try_on(wire="drop-prompt")

        self.assertIsNone(images)
        self.assertIsInstance(error, WireFormatError)
        self.assertIn("does not carry the", str(error))
        self.assertEqual(_FakeFlow.submits, [])


if __name__ == "__main__":
    unittest.main()
