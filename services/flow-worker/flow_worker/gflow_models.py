"""Model patches for gflow-cli 0.82.1's flow.google.com image path (try-on).

1. **Nano Banana 2.1 as the fallback.** Google released Nano Banana 2.1 on 2026-10-06 and Flow's
   model menu lists it as "Nano Banana 2.1". gflow-cli 0.82.1 predates it: its ``nano2`` entry
   matches any "Nano Banana 2" label, which is ambiguous once both are listed. In this process
   ``nano2`` means exactly the "Nano Banana 2.1" entry.
2. **Model read-back.** gflow clicks the model menu entry and never reads the picker again. Both
   models are now read back after selection; a picker that does not show the requested model
   fails the run before upload or submit (``UiSelectorDriftError``, exit 23).
3. **Wire check for 2.1.** gflow asserts the ``ogiZ0b`` body carries ``NARWHAL`` (Nano Banana 2)
   for ``nano2``. Nano Banana 2.1's wire key is not published, so a 2.1 submit is allowed only
   when its body carries the key configured in ``FLOW_NANO_BANANA_2_1_MODEL_KEY`` and no other
   image model key. Unset, every 2.1 submit is aborted before it reaches Flow, and the abort
   lists the body's enum tokens (``WIRE_MODEL_CANDIDATES=``) so the operator can capture the real
   key from one live fallback without logging shopper data. Reference ids and prompt are still
   required.
4. **Quota refusal.** gflow-cli 0.82.1 maps only "unusual activity" and content-safety refusals
   of the ``ogiZ0b`` submit; a gRPC RESOURCE_EXHAUSTED refusal ends as a generic "no ogiZ0b
   frame" WireFormatError. It now raises a WireFormatError carrying
   ``policy.QUOTA_EXHAUSTED_MARKER`` and the refusal reasons, which the worker reads as "Pro
   quota exhausted". WireFormatError is used on purpose: gflow retries RateLimitError, which would
   spend the request budget re-running a Pro attempt that cannot succeed.

Installed only inside the gflow subprocess the worker starts (``flow_worker.gflow_launcher``).
"""

from __future__ import annotations

import json
import os
import re
from importlib import metadata
from typing import Any

from .policy import QUOTA_EXHAUSTED_MARKER

GFLOW_VERSION = "0.82.1"
NANO_BANANA_2_1_LABEL = "Nano Banana 2.1"
RESOURCE_EXHAUSTED = 8
IMAGE_SUBMIT_RPC = "ogiZ0b"
# Wire keys of gflow-cli 0.82.1's image models: Nano Banana 2, Pro, 2 Lite, Imagen 4.
KNOWN_MODEL_KEYS = ("NARWHAL", "GEM_PIX_2", "HARBOR_SEAL", "IMAGEN_3_5")
MODEL_KEY_PATTERN = re.compile(r"^[A-Z][A-Z0-9_]{2,63}$")
CANDIDATES_MARKER = "WIRE_MODEL_CANDIDATES="
MAX_CANDIDATES = 24

_installed = False


def configured_model_key() -> str | None:
    """Nano Banana 2.1's wire key as captured from a live submit, or ``None`` when unset/invalid."""
    key = os.environ.get("FLOW_NANO_BANANA_2_1_MODEL_KEY", "").strip()
    return key if MODEL_KEY_PATTERN.fullmatch(key) else None


def _strings(node: Any, out: list[str]) -> None:
    if isinstance(node, str):
        if node.lstrip()[:1] in ("[", "{"):
            try:
                _strings(json.loads(node), out)
                return
            except ValueError:
                pass
        out.append(node)
    elif isinstance(node, list):
        for item in node:
            _strings(item, out)
    elif isinstance(node, dict):
        for item in node.values():
            _strings(item, out)


def enum_tokens(body: str) -> list[str]:
    """Distinct enum-like strings (``SCREAMING_SNAKE``) in a form-decoded batchexecute body.

    The model key is one of them. Shopper data is not: prompt text has spaces and lowercase,
    media ids are lowercase UUIDs, and the reCAPTCHA token is mixed case.
    """
    start = body.find("f.req=")
    if start < 0:
        return []
    try:
        payload, _ = json.JSONDecoder().raw_decode(body, start + len("f.req="))
    except ValueError:
        return []
    strings: list[str] = []
    _strings(payload, strings)
    tokens: list[str] = []
    for value in strings:
        if MODEL_KEY_PATTERN.fullmatch(value) and value not in tokens:
            tokens.append(value)
    return tokens[:MAX_CANDIDATES]


def nano_banana_2_1_body_problem(body: str, expected_key: str | None) -> str | None:
    """Why a submit body is not proven to be Nano Banana 2.1, or ``None``."""
    tokens = enum_tokens(body)
    candidates = f"{CANDIDATES_MARKER}{','.join(tokens)}"
    if expected_key is None:
        return (
            "try-on guard: FLOW_NANO_BANANA_2_1_MODEL_KEY is not configured, so the Nano Banana 2.1 "
            f"submit cannot be attributed; aborted before Flow acted. {candidates}"
        )
    others = [key for key in KNOWN_MODEL_KEYS if key != expected_key and key in tokens]
    if expected_key not in tokens or others:
        return (
            f"try-on guard: the image submit body does not carry exactly the Nano Banana 2.1 key "
            f"{expected_key}; aborted before Flow acted. {candidates}"
        )
    return None


def quota_refusal_detail(rpcid: str, code: int | None, reasons: tuple[str, ...]) -> str | None:
    """The marked detail for a RESOURCE_EXHAUSTED image submit refusal, or ``None``."""
    if rpcid != IMAGE_SUBMIT_RPC or code != RESOURCE_EXHAUSTED:
        return None
    named = ", ".join(reasons[:4]) or "NO_REASON"
    return f"{QUOTA_EXHAUSTED_MARKER}: Flow refused the image submit with RESOURCE_EXHAUSTED ({named})"


def install() -> None:
    """Patch gflow's migrated composer in this process. Fails closed on any other gflow."""
    global _installed
    if _installed:
        return
    version = metadata.version("gflow-cli")
    if version != GFLOW_VERSION:
        raise RuntimeError(f"try-on model patches target gflow-cli {GFLOW_VERSION}, found {version}")

    from gflow_cli.api.image import Model as ImageModel
    from gflow_cli.api.transports import batchexecute
    from gflow_cli.api.transports import migrated_composer as mc
    from gflow_cli.errors import UiSelectorDriftError, WireFormatError

    composer_cls = mc.MigratedComposer
    original_select_image_model = composer_cls._select_image_model
    original_submit_refusal = mc._submit_refusal
    original_body_problem = mc._image_body_problem

    mc.IMAGE_MODEL_MENU_MATCHERS[ImageModel.NARWHAL] = mc.ModelMenuMatcher(
        NANO_BANANA_2_1_LABEL, excludes=("Lite",)
    )

    async def select_image_model(self: Any, page: Any, pane: Any, model: Any) -> None:
        await original_select_image_model(self, page, pane, model)
        button = pane.locator("button").filter(has=mc._ligature(page, "arrow_drop_down")).first
        shown = (await button.text_content() or "").strip()
        if not mc.IMAGE_MODEL_MENU_MATCHERS[model].matches(shown):
            raise UiSelectorDriftError(
                detail=(
                    f"try-on guard: the image model picker shows {shown!r} after selecting "
                    f"{model.value}; refusing to generate with another model"
                ),
            )

    def submit_refusal(text: str, rpcids: tuple[str, ...]) -> Any:
        refusal = original_submit_refusal(text, rpcids)
        if refusal is not None:
            return refusal
        for err in batchexecute.rpc_errors(text):
            if err.rpcid not in rpcids:
                continue
            detail = quota_refusal_detail(err.rpcid, err.code, err.reasons)
            if detail is not None:
                return WireFormatError(detail=detail, route=f"batchexecute:{err.rpcid}")
        return None

    def image_body_problem(body: str, reference_ids: tuple[str, ...], model: Any = None) -> str | None:
        if model is not ImageModel.NARWHAL:
            return original_body_problem(body, reference_ids, model)
        problem = original_body_problem(body, reference_ids, None)
        if problem is not None:
            return problem
        return nano_banana_2_1_body_problem(body, configured_model_key())

    composer_cls._select_image_model = select_image_model
    # Module globals on purpose: gflow's submit observers look them up at call time.
    mc._submit_refusal = submit_refusal
    mc._image_body_problem = image_body_problem
    _installed = True
