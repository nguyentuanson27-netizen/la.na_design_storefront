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

Whitespace is ignored in both comparisons: the editor represents prompt newlines as its own line
breaks, so only the prompt's non-whitespace characters, in order, are compared.
"""

from __future__ import annotations

import json
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

_installed = False
# The prompt of the image run currently being submitted. One gflow process runs one try-on.
_expected_prompt: str | None = None


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
    from gflow_cli.errors import UiSelectorDriftError

    log = structlog.get_logger(__name__)
    composer_cls = mc.MigratedComposer
    original_send_prompt = composer_cls.send_prompt
    original_submit_images = composer_cls.submit_images_and_observe
    original_body_problem = mc._image_body_problem

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
    composer_cls.submit_images_and_observe = submit_images_and_observe
    # Module global on purpose: gflow's route guard and request observer look it up at call time.
    mc._image_body_problem = image_body_problem
    _installed = True
