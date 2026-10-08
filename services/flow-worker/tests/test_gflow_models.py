import asyncio
import glob
import importlib.util
import json
import os
import unittest
from unittest.mock import patch

from flow_worker import gflow_models, gflow_prompt_guard
from flow_worker.policy import QUOTA_EXHAUSTED_MARKER, should_fallback_from_pro
from flow_worker.server import TRY_ON_PROMPT

PERSON_ID = "11111111-1111-4111-8111-111111111111"
GARMENT_ID = "22222222-2222-4222-8222-222222222222"
MISSING_ID = "77777777-7777-4777-8777-777777777777"
FLOW_MENU = ("Nano Banana Pro", "Nano Banana 2", "Nano Banana 2.1", "Nano Banana 2 Lite")

HAS_GFLOW = importlib.util.find_spec("gflow_cli") is not None
HAS_PLAYWRIGHT = importlib.util.find_spec("playwright") is not None
if os.environ.get("FLOW_REQUIRE_BROWSER_TESTS") and not (HAS_GFLOW and HAS_PLAYWRIGHT):
    raise RuntimeError("FLOW_REQUIRE_BROWSER_TESTS is set but gflow-cli or playwright is missing")


def submit_body(*model_keys: str) -> str:
    inner = json.dumps([[TRY_ON_PROMPT, [[[None, 1, PERSON_ID]], [[None, 1, GARMENT_ID]]]], *model_keys])
    return "f.req=" + json.dumps([[["ogiZ0b", inner, None, "generic"]]]) + "&at=token"


def refusal_reply(code: int, reason: str, rpcid: str = "ogiZ0b") -> str:
    status = [code, None, [["type.googleapis.com/google.rpc.ErrorInfo", [reason]]]]
    frame = json.dumps([["wrb.fr", rpcid, None, None, None, status, "generic"]])
    return f")]}}'\n\n{len(frame)}\n{frame}\n"


class ModelKeyAndQuotaDetailTest(unittest.TestCase):
    def test_nano_banana_2_1_is_proven_only_by_the_configured_key_alone(self):
        problem = gflow_models.nano_banana_2_1_body_problem
        key = "NANO_BANANA_2_1"
        self.assertIsNone(problem(submit_body(key), key))
        # Nano Banana 2's key, an unknown key, or a second model key are never 2.1.
        self.assertIsNotNone(problem(submit_body("NARWHAL"), key))
        self.assertIsNotNone(problem(submit_body("MYSTERY_MODEL"), key))
        self.assertIsNotNone(problem(submit_body(key, "GEM_PIX_2"), key))

    def test_unconfigured_key_fails_closed_and_lists_only_enum_tokens(self):
        detail = gflow_models.nano_banana_2_1_body_problem(submit_body("SOME_NEW_KEY"), None)
        self.assertIn("WIRE_MODEL_CANDIDATES=SOME_NEW_KEY", detail)
        for shopper_data in (PERSON_ID, GARMENT_ID, "first reference image", "token"):
            self.assertNotIn(shopper_data, detail)

    def test_configured_key_must_look_like_a_wire_enum(self):
        for value, expected in (("NANO_BANANA_2_1", "NANO_BANANA_2_1"), ("", None), ("bad key", None)):
            with patch.dict(os.environ, {"FLOW_NANO_BANANA_2_1_MODEL_KEY": value}):
                self.assertEqual(gflow_models.configured_model_key(), expected)

    def test_resource_exhausted_falls_back_only_with_daily_evidence(self):
        undifferentiated = gflow_models.quota_refusal_detail("ogiZ0b", 8, ("PUBLIC_ERROR_QUOTA",))
        self.assertIn(QUOTA_EXHAUSTED_MARKER, undifferentiated)
        self.assertFalse(should_fallback_from_pro(7, undifferentiated))
        self.assertFalse(should_fallback_from_pro(7, gflow_models.quota_refusal_detail("ogiZ0b", 8, ())))
        daily = gflow_models.quota_refusal_detail("ogiZ0b", 8, ("PUBLIC_ERROR_DAILY_IMAGE_QUOTA",))
        self.assertTrue(should_fallback_from_pro(7, daily))
        self.assertIsNone(gflow_models.quota_refusal_detail("ogiZ0b", 7, ("PUBLIC_ERROR_UNUSUAL_ACTIVITY",)))
        self.assertIsNone(gflow_models.quota_refusal_detail("MZZa6b", 8, ()))


@unittest.skipUnless(HAS_GFLOW, "needs gflow-cli 0.82.1")
class GflowModelPatchTest(unittest.TestCase):
    """Real gflow-cli 0.82.1 functions with the launcher's patches installed."""

    @classmethod
    def setUpClass(cls):
        gflow_prompt_guard.install()
        gflow_models.install()

    def test_nano2_matches_exactly_the_nano_banana_2_1_menu_entry(self):
        from gflow_cli.api.image import Model
        from gflow_cli.api.transports import migrated_composer as mc

        unpatched = mc.ModelMenuMatcher("Nano Banana 2", excludes=("Lite",))
        self.assertEqual([e for e in FLOW_MENU if unpatched.matches(e)], ["Nano Banana 2", "Nano Banana 2.1"])
        matcher = mc.IMAGE_MODEL_MENU_MATCHERS[Model.NARWHAL]
        self.assertEqual([e for e in FLOW_MENU if matcher.matches(e)], ["Nano Banana 2.1"])
        self.assertFalse(matcher.matches("Nano Banana 2.1 Lite"))

    def test_resource_exhausted_submit_reply_becomes_a_marked_non_retried_error(self):
        from gflow_cli.api.transports import migrated_composer as mc
        from gflow_cli.errors import RateLimitError, WafRejectionError, WireFormatError

        refusal = mc._submit_refusal(refusal_reply(8, "PUBLIC_ERROR_DAILY_IMAGE_QUOTA"), ("ogiZ0b",))
        self.assertIsInstance(refusal, WireFormatError)
        self.assertNotIsInstance(refusal, RateLimitError)
        self.assertIn(QUOTA_EXHAUSTED_MARKER, refusal.detail)
        self.assertTrue(should_fallback_from_pro(7, refusal.detail))

        undifferentiated = mc._submit_refusal(refusal_reply(8, "PUBLIC_ERROR_IMAGE_QUOTA"), ("ogiZ0b",))
        self.assertFalse(should_fallback_from_pro(7, undifferentiated.detail))

        unusual = mc._submit_refusal(refusal_reply(7, "PUBLIC_ERROR_UNUSUAL_ACTIVITY"), ("ogiZ0b",))
        self.assertIsInstance(unusual, WafRejectionError)
        self.assertIsNone(mc._submit_refusal(refusal_reply(8, "X", rpcid="MZZa6b"), ("ogiZ0b",)))

    def test_nano_banana_2_1_submit_needs_the_configured_key_at_the_wire(self):
        from gflow_cli.api.image import Model
        from gflow_cli.api.transports import migrated_composer as mc

        refs = (PERSON_ID, GARMENT_ID)
        with (
            patch.object(gflow_prompt_guard, "_expected_prompt", TRY_ON_PROMPT),
            patch.dict(os.environ, {"FLOW_NANO_BANANA_2_1_MODEL_KEY": "NANO_BANANA_2_1"}),
        ):
            self.assertIsNone(mc._image_body_problem(submit_body("NANO_BANANA_2_1"), refs, Model.NARWHAL))
            self.assertIsNotNone(mc._image_body_problem(submit_body("NARWHAL"), refs, Model.NARWHAL))
            self.assertIsNotNone(mc._image_body_problem(submit_body("GEM_PIX_2"), refs, Model.NARWHAL))
            # Pro keeps gflow's own exact model-key check.
            self.assertIsNone(mc._image_body_problem(submit_body("GEM_PIX_2"), refs, Model.GEM_PIX_2))
            self.assertIsNotNone(mc._image_body_problem(submit_body("NARWHAL"), refs, Model.GEM_PIX_2))
            # References and prompt are still required.
            self.assertIsNotNone(mc._image_body_problem(submit_body("NANO_BANANA_2_1"), (PERSON_ID, MISSING_ID), Model.NARWHAL))
        with (
            patch.object(gflow_prompt_guard, "_expected_prompt", TRY_ON_PROMPT),
            patch.dict(os.environ, {"FLOW_NANO_BANANA_2_1_MODEL_KEY": ""}),
        ):
            self.assertIn(
                "WIRE_MODEL_CANDIDATES=NANO_BANANA_2_1",
                mc._image_body_problem(submit_body("NANO_BANANA_2_1"), refs, Model.NARWHAL),
            )


MODEL_PICKER = """<!doctype html><html><body>
<div id="pane"><button id="model"><span id="label">Nano Banana Pro</span><mat-icon>arrow_drop_down</mat-icon></button></div>
<div id="menu" hidden></div>
<script>
const sticky = %s;
const menu = document.getElementById("menu");
for (const name of %s) {
  const item = document.createElement("button");
  item.setAttribute("role", "menuitem");
  item.textContent = name;
  item.onclick = () => { if (!sticky) document.getElementById("label").textContent = name; menu.hidden = true; };
  menu.appendChild(item);
}
document.getElementById("model").onclick = () => { menu.hidden = false; };
</script></body></html>"""


def _browser_executable():
    candidates = [os.environ.get("FLOW_TEST_CHROME", "")]
    candidates += sorted(glob.glob("/opt/pw-browsers/chromium-*/chrome-linux/chrome"))
    candidates.append("/opt/google/chrome/chrome")
    return next((path for path in candidates if path and os.access(path, os.X_OK)), None)


@unittest.skipUnless(HAS_GFLOW and HAS_PLAYWRIGHT, "needs gflow-cli 0.82.1 and playwright")
class NanoBanana21PickerTest(unittest.TestCase):
    """gflow's real _select_image_model against Flow's menu with both Nano Banana 2 entries."""

    @classmethod
    def setUpClass(cls):
        cls.browser_path = _browser_executable()
        if cls.browser_path is None:
            if os.environ.get("FLOW_REQUIRE_BROWSER_TESTS"):
                raise RuntimeError("FLOW_REQUIRE_BROWSER_TESTS is set but no browser was found")
            raise unittest.SkipTest("needs a Chromium/Chrome binary")
        gflow_prompt_guard.install()
        gflow_models.install()

    def select(self, *, sticky: bool):
        from gflow_cli.api.image import Model
        from gflow_cli.api.transports import migrated_composer as mc
        from playwright.async_api import async_playwright

        async def scenario():
            async with async_playwright() as playwright:
                browser = await playwright.chromium.launch(executable_path=self.browser_path, args=["--no-sandbox"])
                try:
                    page = await browser.new_page()
                    await page.set_content(MODEL_PICKER % ("true" if sticky else "false", json.dumps(FLOW_MENU)))
                    try:
                        await mc.MigratedComposer()._select_image_model(page, page.locator("#pane"), Model.NARWHAL)
                    except Exception as error:  # noqa: BLE001 - asserted by the caller
                        return None, error
                    return await page.locator("#label").text_content(), None
                finally:
                    await browser.close()

        return asyncio.run(scenario())

    def test_fallback_selects_nano_banana_2_1(self):
        label, error = self.select(sticky=False)
        self.assertIsNone(error)
        self.assertEqual(label, "Nano Banana 2.1")

    def test_a_picker_that_does_not_show_2_1_after_the_click_fails_the_run(self):
        from gflow_cli.errors import UiSelectorDriftError

        label, error = self.select(sticky=True)
        self.assertIsNone(label)
        self.assertIsInstance(error, UiSelectorDriftError)
        self.assertIn("refusing to generate with another model", str(error))


if __name__ == "__main__":
    unittest.main()
