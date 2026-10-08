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
