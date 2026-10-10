from __future__ import annotations

from datetime import datetime, timedelta, timezone

#: Put into a gflow error detail by flow_worker.gflow_models when flow.google.com refuses the
#: image submit with gRPC RESOURCE_EXHAUSTED, followed by the refusal's ErrorInfo reasons.
#: gflow-cli 0.82.1 itself reports that refusal as a generic WireFormatError (exit 7).
QUOTA_EXHAUSTED_MARKER = "FLOW_QUOTA_EXHAUSTED"
#: gflow-cli 0.82.1 WireFormatError detail for a non-200 ogiZ0b image submit reply.
_IMAGE_SUBMIT_HTTP_429 = "image submit answered HTTP 429"
#: gflow-cli 0.82.1 RateLimitError (HTTP 429 / quota on the labs.google path).
_RATE_LIMIT_EXIT_CODE = 4
#: gflow-cli 0.82.1 WireFormatError.
_WIRE_FORMAT_EXIT_CODE = 7
#: gflow-cli 0.82.1 InsufficientCreditsError: Flow replaced the submit control with its
#: insufficient-credits warning before anything was generated.
_INSUFFICIENT_CREDITS_EXIT_CODE = 37


def is_flow_quota_refusal(exit_code: int, output: str) -> bool:
    """flow.google.com refused an image submit for quota: gflow-cli 0.82.1 reports both a
    RESOURCE_EXHAUSTED refusal (marked by gflow_models) and an HTTP 429 reply as WireFormatError
    (exit 7). Any other exit-7 wire error is not a quota refusal."""
    return exit_code == _WIRE_FORMAT_EXIT_CODE and (
        QUOTA_EXHAUSTED_MARKER in output or _IMAGE_SUBMIT_HTTP_429 in output
    )


def should_fallback_from_pro(exit_code: int, output: str) -> bool:
    """Any Nano Banana Pro quota, rate-limit or credit refusal spends one Nano Banana 2.1 attempt.

    Owner decision: a RESOURCE_EXHAUSTED refusal without a reason, any HTTP 429 and per-minute
    limits all fall back. Safety, auth, unusual-activity, timeout and generic failures never do.
    """
    if exit_code in (_RATE_LIMIT_EXIT_CODE, _INSUFFICIENT_CREDITS_EXIT_CODE):
        return True
    return is_flow_quota_refusal(exit_code, output)


#: How long Nano Banana Pro is left alone after each kind of refusal (owner decision 2026-10-10).
#: A per-minute limit or a bare HTTP 429 clears in about a minute; a refusal that names no limit is
#: given longer, so Pro is probed a few times an hour instead of on every request.
PRO_COOLDOWN_SHORT_SECONDS = 90
PRO_COOLDOWN_UNKNOWN_SECONDS = 20 * 60
#: A daily limit or exhausted credits keep Pro off until 03:00 Vietnam time (UTC+7, no DST).
PRO_DAILY_RESET_HOUR = 3
PRO_DAILY_RESET_TZ = timezone(timedelta(hours=7))


def pro_refusal_kind(exit_code: int, output: str) -> str | None:
    """Which cool-down a Pro refusal earns: ``daily``, ``short`` or ``unknown``; ``None`` when the
    failure is not one that falls back at all (safety, auth, unusual activity, timeout, ...).

    A refusal naming several limits takes the longest one it names.
    """
    if not should_fallback_from_pro(exit_code, output):
        return None
    if exit_code == _INSUFFICIENT_CREDITS_EXIT_CODE:
        return "daily"
    text = output.upper()
    if "DAILY" in text:
        return "daily"
    if "MINUTE" in text or "429" in text:
        return "short"
    return "unknown"


def pro_unavailable_until(kind: str, now: float) -> float:
    """The wall-clock time (epoch seconds) before which Pro is not asked again after ``kind``."""
    if kind == "daily":
        local = datetime.fromtimestamp(now, PRO_DAILY_RESET_TZ)
        reset = local.replace(hour=PRO_DAILY_RESET_HOUR, minute=0, second=0, microsecond=0)
        if reset <= local:
            reset += timedelta(days=1)
        return reset.timestamp()
    if kind == "short":
        return now + PRO_COOLDOWN_SHORT_SECONDS
    return now + PRO_COOLDOWN_UNKNOWN_SECONDS


class ProCooldown:
    """Remembers, across requests, that Nano Banana Pro has just refused for quota.

    Without it every request pays for a Pro attempt that is certain to be refused before it falls
    back. While a cool-down runs, requests go straight to Nano Banana 2.1; the first request after it
    ends asks Pro again, which either clears it (Pro worked) or starts a new one (refused again).

    In memory on purpose: a restarted worker simply asks Pro once more. Only touched under the
    worker's generation lock, so it needs no lock of its own.
    """

    def __init__(self) -> None:
        self.until = 0.0
        self.kind: str | None = None

    def active(self, now: float) -> bool:
        return self.kind is not None and now < self.until

    def note_refusal(self, kind: str, now: float) -> None:
        self.kind = kind
        self.until = pro_unavailable_until(kind, now)

    def clear(self) -> None:
        self.kind = None
        self.until = 0.0
