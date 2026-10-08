import unittest

from flow_worker.policy import QUOTA_EXHAUSTED_MARKER, should_fallback_from_pro

RESOURCE_EXHAUSTED = f"{QUOTA_EXHAUSTED_MARKER}: Flow refused the image submit with RESOURCE_EXHAUSTED"


class FallbackPolicyTest(unittest.TestCase):
    def test_every_quota_rate_limit_or_credit_refusal_falls_back(self):
        for code, text in (
            (4, "You have reached the daily limit for Nano Banana Pro."),
            (4, "Rate limit or quota hit"),
            (4, "Rate limit or quota hit: per-minute model quota reached; retry later"),
            (4, "HTTP 429 — rate limit hit"),
            (7, f"{RESOURCE_EXHAUSTED} (PUBLIC_ERROR_DAILY_QUOTA)"),
            (7, f"{RESOURCE_EXHAUSTED} (NO_REASON)"),
            (7, f"{RESOURCE_EXHAUSTED} (PUBLIC_ERROR_QUOTA)"),
            (7, f"{RESOURCE_EXHAUSTED} (PUBLIC_ERROR_PER_MINUTE_LIMIT)"),
            (7, "migrated image submit answered HTTP 429"),
            (37, "migrated host: Flow replaced the submit control with its insufficient-credits warning"),
        ):
            with self.subTest(code=code, text=text):
                self.assertTrue(should_fallback_from_pro(code, text))

    def test_non_quota_failures_never_fall_back(self):
        for code, text in (
            (1, "PUBLIC_ERROR_UNUSUAL_ACTIVITY"),
            (10, "Flow refused the submit: PUBLIC_ERROR_UNUSUAL_ACTIVITY (gRPC 7)"),
            (1, "reCAPTCHA token rejected"),
            (3, "NOT_SIGNED_IN"),
            (5, "Content policy blocked this image"),
            (8, "Transport timeout"),
            (9, "no ogiZ0b image result within 180s"),
            (6, "Network error"),
            (7, "migrated image submit answered HTTP 500"),
            (7, "migrated image submit returned no ogiZ0b frame"),
            (23, "Flow setting selector drift"),
            (1, "unknown provider error"),
        ):
            with self.subTest(code=code, text=text):
                self.assertFalse(should_fallback_from_pro(code, text))


if __name__ == "__main__":
    unittest.main()
