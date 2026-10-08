import re

_DAILY = re.compile(r"\bdaily\b", re.IGNORECASE)
_QUOTA_OR_LIMIT = re.compile(r"\b(?:quota|limit)\b", re.IGNORECASE)
_PRO = re.compile(r"\bnano(?:\s+banana)?\s+pro\b", re.IGNORECASE)
_PER_MINUTE = re.compile(r"per[-_ ]?minute|minute[-_ ](?:quota|limit)", re.IGNORECASE)
# gRPC ErrorInfo reasons are SCREAMING_SNAKE_CASE, where \b does not separate words.
_DAILY_REASON = re.compile(r"(?<![A-Z0-9])DAILY(?![A-Z0-9])")

#: Put into a gflow error detail by flow_worker.gflow_models when flow.google.com refuses the
#: image submit with gRPC RESOURCE_EXHAUSTED, followed by the refusal's ErrorInfo reasons.
#: gflow-cli 0.82.1 itself reports that refusal as a generic WireFormatError (exit 7).
QUOTA_EXHAUSTED_MARKER = "FLOW_QUOTA_EXHAUSTED"
#: gflow-cli 0.82.1 InsufficientCreditsError: Flow replaced the submit control with its
#: insufficient-credits warning before anything was generated.
_INSUFFICIENT_CREDITS_EXIT_CODE = 37


def should_fallback_from_pro(exit_code: int, output: str) -> bool:
    """Only a proven Nano Banana Pro daily-quota or credit exhaustion may spend a Nano Banana 2.1
    attempt. RESOURCE_EXHAUSTED or HTTP 429 alone does not say which quota ran out, so without
    daily evidence it fails closed: a per-minute or global throttle must never fall back."""
    if _PER_MINUTE.search(output):
        return False
    if exit_code == _INSUFFICIENT_CREDITS_EXIT_CODE:
        return True
    if QUOTA_EXHAUSTED_MARKER in output:
        return bool(_DAILY_REASON.search(output.split(QUOTA_EXHAUSTED_MARKER, 1)[1]))
    if exit_code != 4:
        return False
    # labs.google path: gflow's RateLimitError carries Flow's own daily-limit wording.
    return bool(_DAILY.search(output) and _QUOTA_OR_LIMIT.search(output) and _PRO.search(output))
