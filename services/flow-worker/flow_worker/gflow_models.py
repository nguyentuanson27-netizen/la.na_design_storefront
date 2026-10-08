"""Model patches for gflow-cli 0.82.1's flow.google.com image path (try-on).

1. **Nano Banana 2.1 as the fallback.** Google released Nano Banana 2.1 on 2026-10-06 and Flow's
   model menu lists it as "Nano Banana 2.1". gflow-cli 0.82.1 predates it: its ``nano2`` entry
   matches any "Nano Banana 2" label, which is ambiguous once both are listed. In this process
   ``nano2`` means exactly the "Nano Banana 2.1" entry.
2. **Model read-back.** gflow clicks the model menu entry and never reads the picker again. Both
   models are now read back after selection; a picker that does not show the requested model
   fails the run before upload or submit (``UiSelectorDriftError``, exit 23).
3. **Wire check for 2.1.** gflow asserts the ``ogiZ0b`` body carries ``NARWHAL`` for ``nano2``.
   Nano Banana 2.1's wire key is not published, so for 2.1 the body must instead carry none of
   the other image model keys (Pro, 2 Lite, Imagen). Reference ids are still required.
4. **Quota refusal.** gflow-cli 0.82.1 maps only "unusual activity" and content-safety refusals
   of the ``ogiZ0b`` submit; a gRPC RESOURCE_EXHAUSTED refusal ends as a generic "no ogiZ0b
   frame" WireFormatError. It now raises a WireFormatError carrying
   ``policy.QUOTA_EXHAUSTED_MARKER`` and the refusal reasons, which the worker reads as "Pro
   quota exhausted". WireFormatError is used on purpose: gflow retries RateLimitError, which would
   spend the request budget re-running a Pro attempt that cannot succeed.

Installed only inside the gflow subprocess the worker starts (``flow_worker.gflow_launcher``).
"""

from __future__ import annotations

import re
from importlib import metadata
from typing import Any

from .policy import QUOTA_EXHAUSTED_MARKER

GFLOW_VERSION = "0.82.1"
NANO_BANANA_2_1_LABEL = "Nano Banana 2.1"
RESOURCE_EXHAUSTED = 8
IMAGE_SUBMIT_RPC = "ogiZ0b"
# Wire keys of the image models that are NOT Nano Banana 2.1, as gflow-cli 0.82.1 names them.
_OTHER_MODEL_KEYS = re.compile(r"(?<![A-Z0-9_])(?:GEM_PIX_2|HARBOR_SEAL|IMAGEN_3_5)(?![A-Z0-9_])")

_installed = False


def other_model_in_body(body: str) -> str | None:
    """The first non-2.1 image model key a form-decoded submit body carries, or ``None``."""
    match = _OTHER_MODEL_KEYS.search(body)
    return match.group(0) if match else None


def quota_refusal_detail(rpcid: str, code: int | None, reasons: tuple[str, ...]) -> str | None:
    """The marked detail for a RESOURCE_EXHAUSTED image submit refusal, or ``None``."""
    if rpcid != IMAGE_SUBMIT_RPC or code != RESOURCE_EXHAUSTED:
        return None
    named = ", ".join(reasons[:4]) or "no reason"
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
        other = other_model_in_body(body)
        if other is not None:
            return (
                f"try-on guard: the image submit body carries model {other}, not "
                f"{NANO_BANANA_2_1_LABEL}; refusing to submit"
            )
        return None

    composer_cls._select_image_model = select_image_model
    # Module globals on purpose: gflow's submit observers look them up at call time.
    mc._submit_refusal = submit_refusal
    mc._image_body_problem = image_body_problem
    _installed = True
