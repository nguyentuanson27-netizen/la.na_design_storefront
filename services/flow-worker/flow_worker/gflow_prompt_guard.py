"""Prompt guard for gflow-cli 0.82.1's flow.google.com image-to-image path.

Reproduced failure (tests/test_gflow_prompt_guard.py drives the real gflow code against a fake
composer): ``run_images`` mentions both uploaded references, then ``send_prompt(append=True)``
inserts the prompt wherever the caret happens to be, logs ``migrated.prompt_typed`` without reading
anything back, and the ``ogiZ0b`` submit guard checks only reference ids and model. When the caret
is no longer in the composer after the last mention commit, the prompt never lands, the submit
carries both references with an empty prompt, and Flow generates a reference-only image.

Installed only inside the gflow subprocess the worker starts (``flow_worker.gflow_launcher``):

1. ``send_prompt`` puts the caret at the end of the composer before inserting, then reads the
   composer back. The whole prompt must be there and no mention chip may be lost, otherwise it
   raises ``UiSelectorDriftError`` (exit 23) before anything is submitted.
2. The ``ogiZ0b`` body check additionally requires the prompt. gflow's own route guard then aborts
   a submit without it before Flow acts on it (``WireFormatError``, exit 7).

3. ``_mention_by_name`` and ``clear_composer`` wait for the page instead of sleeping. gflow sleeps a
   fixed 2.2 s after ``@``, 2.5 s after the query and 2.5 s after Enter (7.2 s per reference). The
   replacements wait for the picker, for the picker to be filtered down to the typed name, and for
   the chip to exist, each capped at gflow's own fixed sleep, so a slow page is never rushed past
   what gflow allowed and a miss falls through to gflow's own verify-and-retry logic unchanged.
   ``FLOW_MENTION_FAST=0`` restores gflow's fixed sleeps.

Whitespace is ignored in the prompt comparisons: the editor represents prompt newlines as its own line
breaks, so only the prompt's non-whitespace characters, in order, are compared.
"""

from __future__ import annotations

import json
import os
import time
from importlib import metadata
from typing import Any

GFLOW_VERSION = "0.82.1"

# Collapse the selection to the end of the composer so the prompt follows the mention chips.
_CARET_TO_END_JS = """(el) => {
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}"""
_COMPOSER_TEXT_JS = "(el) => el.innerText || el.textContent || ''"

# The fixed sleeps gflow 0.82.1 uses around each mention gesture; the event waits never exceed them.
_PICKER_OPEN_CAP_MS = 2200
_PICKER_FILTER_CAP_MS = 2500
_CHIP_COMMIT_CAP_MS = 2500
_CLEAR_CAP_MS = 600
# How long the picker must stay unchanged, with the requested asset first, before Enter.
_PICKER_SETTLE_MS = 200

# True once the picker is settled on the requested asset: its first option (Enter commits the first
# option) is the asset itself -- its text ends with the typed name, so a stale or look-alike row that
# merely contains the name does not count -- and the option list has not changed for settleMs. The
# probe state lives on the page and restarts whenever the list changes or polling had a gap.
_PICKER_SETTLED_JS = """([selector, name, settleMs]) => {
  const options = [...document.querySelectorAll(selector)];
  const label = (option) => (option.textContent || '').trim();
  if (!options.length || !label(options[0]).endsWith(name)) {
    window.__tryOnPickerProbe = null;
    return false;
  }
  const signature = options.map(label).join('\\n');
  const now = performance.now();
  const probe = window.__tryOnPickerProbe;
  if (!probe || probe.signature !== signature || now - probe.last > 500) {
    window.__tryOnPickerProbe = { signature, since: now, last: now };
    return false;
  }
  probe.last = now;
  return now - probe.since >= settleMs;
}"""
_CHIP_COUNT_JS = "([selector, count]) => document.querySelectorAll(selector).length >= count"
_COMPOSER_EMPTY_JS = """(selector) => {
  const el = document.querySelector(selector);
  return !el || !(el.innerText || el.textContent || '').trim();
}"""

_installed = False
# The prompt of the image run currently being submitted. One gflow process runs one try-on.
_expected_prompt: str | None = None


def fast_mention_enabled() -> bool:
    return os.environ.get("FLOW_MENTION_FAST", "1").strip().lower() not in ("0", "false", "no", "off")


def compact(text: str) -> str:
    return "".join(text.split())


def prompt_present(text: str, prompt: str) -> bool:
    needle = compact(prompt)
    return bool(needle) and needle in compact(text)


def _leaf_strings(node: Any, out: list[str]) -> None:
    """Every string under *node*, decoding strings that are themselves JSON (batchexecute nests)."""
    if isinstance(node, str):
        if node.lstrip()[:1] in ("[", "{"):
            try:
                _leaf_strings(json.loads(node), out)
                return
            except ValueError:
                pass
        out.append(node)
    elif isinstance(node, list):
        for item in node:
            _leaf_strings(item, out)
    elif isinstance(node, dict):
        for item in node.values():
            _leaf_strings(item, out)


def submit_body_prompt_problem(body: str, prompt: str) -> str | None:
    """Why a form-decoded ``ogiZ0b`` body does not carry *prompt*, or ``None``."""
    start = body.find("f.req=")
    if start < 0:
        return "try-on guard: the image submit body carries no f.req payload; refusing to submit"
    try:
        payload, _ = json.JSONDecoder().raw_decode(body, start + len("f.req="))
    except ValueError:
        return "try-on guard: the image submit f.req payload could not be decoded; refusing to submit"
    strings: list[str] = []
    _leaf_strings(payload, strings)
    if not prompt_present("".join(strings), prompt):
        return (
            f"try-on guard: the image submit body does not carry the {len(prompt)}-char prompt; "
            "refusing a reference-only generation"
        )
    return None


def install() -> None:
    """Patch gflow's migrated composer in this process. Fails closed on any other gflow."""
    global _installed
    if _installed:
        return
    version = metadata.version("gflow-cli")
    if version != GFLOW_VERSION:
        raise RuntimeError(f"try-on prompt guard targets gflow-cli {GFLOW_VERSION}, found {version}")

    import structlog
    from gflow_cli.api.transports import migrated_composer as mc
    from gflow_cli.errors import ReferenceNotFoundError, UiSelectorDriftError
    from playwright.async_api import TimeoutError as PlaywrightTimeout

    log = structlog.get_logger(__name__)
    composer_cls = mc.MigratedComposer
    original_send_prompt = composer_cls.send_prompt
    original_submit_images = composer_cls.submit_images_and_observe
    original_body_problem = mc._image_body_problem
    original_mention_by_name = composer_cls._mention_by_name
    original_clear_composer = composer_cls.clear_composer

    async def wait_until(page: Any, expression: str, arg: Any, cap_ms: int) -> bool:
        """Wait for *expression* to hold, for at most *cap_ms*. A timeout is not an error here."""
        try:
            await page.wait_for_function(expression, arg=arg, timeout=cap_ms)
        except PlaywrightTimeout:
            return False
        return True

    async def send_prompt(self: Any, page: Any, prompt: str, *, append: bool = False) -> None:
        composer = page.locator(mc.COMPOSER).first
        chips_before = len(await self.read_chips(page))
        if append and await composer.count():
            # gflow skips its composer click on append and trusts the caret the last mention left.
            await composer.evaluate(_CARET_TO_END_JS)
        await original_send_prompt(self, page, prompt, append=append)
        text = await composer.evaluate(_COMPOSER_TEXT_JS)
        chips_after = len(await self.read_chips(page))
        if not prompt_present(str(text), prompt) or chips_after != chips_before:
            raise UiSelectorDriftError(
                detail=(
                    "try-on guard: the prompt was not applied to the composer before submit "
                    f"(prompt present: {prompt_present(str(text), prompt)}, mention chips "
                    f"{chips_before} -> {chips_after}); refusing to generate"
                ),
            )
        log.info("tryon.prompt_verified", chars=len(prompt), chips=chips_after)

    async def clear_composer(self: Any, page: Any) -> None:
        if not fast_mention_enabled():
            return await original_clear_composer(self, page)
        await page.locator(mc.COMPOSER).first.click(timeout=5000)
        await page.keyboard.press("Control+a")
        await page.keyboard.press("Backspace")
        await wait_until(page, _COMPOSER_EMPTY_JS, mc.COMPOSER, _CLEAR_CAP_MS)

    async def mention_by_name(self: Any, page: Any, name: str, *, expect_chips: int) -> None:
        """gflow's ``_mention_by_name`` with its three fixed sleeps replaced by event waits.

        Same gestures, same chip-count verification and same retry / clean-up / errors as gflow;
        only the waiting differs. Every wait is capped at gflow's sleep, and a timed-out wait just
        continues into gflow's own check, so this is never slower than gflow and never accepts
        anything gflow would not.
        """
        if not fast_mention_enabled():
            return await original_mention_by_name(self, page, name, expect_chips=expect_chips)
        offered: list[str] = []
        chips = await self.read_chips(page)
        for attempt in range(1, mc.FRAME_SEARCH_ATTEMPTS + 1):
            before = len(chips)
            started = time.monotonic()
            await page.locator(mc.COMPOSER).first.click(timeout=5000)
            # `keyboard.type`, not `insert_text`: the mention plugin needs real key events (gflow).
            await page.keyboard.type("@", delay=120)
            await wait_until(
                page,
                "(selector) => !!document.querySelector(selector)",
                mc.PICKER_OPTION,
                _PICKER_OPEN_CAP_MS,
            )
            opened = time.monotonic()
            await page.keyboard.type(name, delay=100)
            typed = time.monotonic()
            filtered = await wait_until(
                page,
                _PICKER_SETTLED_JS,
                [mc.PICKER_OPTION, name, _PICKER_SETTLE_MS],
                _PICKER_FILTER_CAP_MS,
            )
            offered = [t.strip() for t in await page.locator(mc.PICKER_OPTION).all_text_contents()]
            listed = time.monotonic()
            await page.keyboard.press("Enter")
            await wait_until(page, _CHIP_COUNT_JS, [mc.MENTION_CHIP, expect_chips], _CHIP_COMMIT_CAP_MS)
            chips = await self.read_chips(page)
            log.info(
                "tryon.mention_timing",
                name=name,
                attempt=attempt,
                picker_ms=round((opened - started) * 1000),
                type_ms=round((typed - opened) * 1000),
                filter_wait_ms=round((listed - typed) * 1000),
                commit_ms=round((time.monotonic() - listed) * 1000),
                filtered=filtered,
            )
            if len(chips) == expect_chips:
                await page.keyboard.type(" ", delay=80)
                return
            log.info(
                "migrated.mention_miss",
                name=name,
                attempt=attempt,
                chips=len(chips),
                offered=len(offered),
            )
            if attempt == mc.FRAME_SEARCH_ATTEMPTS:
                break
            for _ in range(len(name) + 1):  # the '@' and the query it opened
                await page.keyboard.press("Backspace")
            chips = await self.read_chips(page)
            if len(chips) < before:
                raise ReferenceNotFoundError(
                    detail=(
                        f"migrated host: clearing the failed {name!r} query removed an "
                        f"already-attached reference ({before} chip(s) before, "
                        f"{len(chips)} after) — the prompt is no longer the one that was "
                        "built, so this run is abandoned rather than submitted"
                    ),
                )
            await page.wait_for_timeout(mc.FRAME_SEARCH_RETRY_PAUSE_S * 1000)
        raise ReferenceNotFoundError(
            detail=(
                f"migrated host: {name!r} did not attach as a reference in "
                f"{mc.FRAME_SEARCH_ATTEMPTS} attempts ({len(chips)} chip(s), expected "
                f"{expect_chips}); the picker offered: {', '.join(offered[:6]) or '<nothing>'}"
            ),
        )

    async def submit_images_and_observe(
        self: Any, page: Any, request: Any, *, reference_ids: tuple[str, ...] = ()
    ) -> Any:
        global _expected_prompt
        _expected_prompt = request.prompt
        try:
            return await original_submit_images(self, page, request, reference_ids=reference_ids)
        finally:
            _expected_prompt = None

    def image_body_problem(body: str, reference_ids: tuple[str, ...], model: Any = None) -> str | None:
        problem = original_body_problem(body, reference_ids, model)
        if problem is not None:
            return problem
        if _expected_prompt is None:
            return "try-on guard: image submit outside a guarded run; refusing to submit"
        return submit_body_prompt_problem(body, _expected_prompt)

    composer_cls.send_prompt = send_prompt
    composer_cls._mention_by_name = mention_by_name
    composer_cls.clear_composer = clear_composer
    composer_cls.submit_images_and_observe = submit_images_and_observe
    # Module global on purpose: gflow's route guard and request observer look it up at call time.
    mc._image_body_problem = image_body_problem
    _installed = True
