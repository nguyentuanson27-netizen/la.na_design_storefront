import re

_DAILY = re.compile(r"\bdaily\b", re.IGNORECASE)
_QUOTA_OR_LIMIT = re.compile(r"\b(?:quota|limit)\b", re.IGNORECASE)
_PRO = re.compile(r"\bnano(?:\s+banana)?\s+pro\b", re.IGNORECASE)
_PER_MINUTE = re.compile(r"per[-_ ]?minute|minute[-_ ](?:quota|limit)", re.IGNORECASE)

#: Put into a gflow error detail by flow_worker.gflow_models when flow.google.com refuses the
#: Nano Banana Pro image submit for quota (gRPC RESOURCE_EXHAUSTED). gflow-cli 0.82.1 itself
#: reports that refusal as a generic WireFormatError (exit 7) with no quota wording.
QUOTA_EXHAUSTED_MARKER = "FLOW_QUOTA_EXHAUSTED"
#: gflow-cli 0.82.1 WireFormatError detail for a non-200 ogiZ0b image submit reply.
_IMAGE_SUBMIT_HTTP_429 = "image submit answered HTTP 429"
#: gflow-cli 0.82.1 InsufficientCreditsError: Flow replaced the submit control with its
#: insufficient-credits warning before anything was generated.
_INSUFFICIENT_CREDITS_EXIT_CODE = 37


def should_fallback_from_pro(exit_code: int, output: str) -> bool:
    """Only a Nano Banana Pro quota or credit exhaustion may spend a Nano Banana 2.1 attempt."""
    if _PER_MINUTE.search(output):
        return False
    if exit_code == _INSUFFICIENT_CREDITS_EXIT_CODE:
        return True
    if QUOTA_EXHAUSTED_MARKER in output or _IMAGE_SUBMIT_HTTP_429 in output:
        return True
    if exit_code != 4:
        return False
    # labs.google path: gflow's RateLimitError carries Flow's own daily-limit wording.
    return bool(_DAILY.search(output) and _QUOTA_OR_LIMIT.search(output) and _PRO.search(output))
