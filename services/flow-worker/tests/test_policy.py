import unittest

from flow_worker.policy import QUOTA_EXHAUSTED_MARKER, should_fallback_from_pro


class FallbackPolicyTest(unittest.TestCase):
    def test_daily_pro_quota_exhaustion_falls_back(self):
        for text in (
            "You have reached the daily limit for Nano Banana Pro.",
            "Daily generation quota reached for Nano Banana Pro",
            '{"status":429,"title":"Rate limit or quota hit","detail":"daily limit for Nano Banana Pro"}',
        ):
            with self.subTest(text=text):
                self.assertTrue(should_fallback_from_pro(4, text))

    def test_ambiguous_daily_quota_without_pro_model_name_does_not_fall_back(self):
        self.assertFalse(should_fallback_from_pro(4, "Daily generation quota reached"))

    def test_per_minute_rate_limit_does_not_fall_back(self):
        self.assertFalse(
            should_fallback_from_pro(
                4,
                "Rate limit or quota hit: per-minute model quota reached; retry later",
            )
        )

    def test_non_quota_failures_never_fall_back(self):
        for code, text in (
            (1, "PUBLIC_ERROR_UNUSUAL_ACTIVITY"),
            (1, "reCAPTCHA token rejected"),
            (3, "NOT_SIGNED_IN"),
            (5, "Content policy blocked this image"),
            (8, "Transport timeout"),
            (6, "Network error"),
            (23, "Flow setting selector drift"),
            (1, "unknown provider error"),
        ):
            with self.subTest(code=code, text=text):
                self.assertFalse(should_fallback_from_pro(code, text))

    def test_flow_google_com_quota_and_credit_exhaustion_fall_back(self):
        # gflow-cli 0.82.1 reports these on flow.google.com without exit 4 or quota wording.
        for code, text in (
            (7, f"{QUOTA_EXHAUSTED_MARKER}: Flow refused the image submit with RESOURCE_EXHAUSTED (no reason)"),
            (7, "migrated image submit answered HTTP 429"),
            (37, "migrated host: Flow replaced the submit control with its insufficient-credits warning"),
        ):
            with self.subTest(code=code):
                self.assertTrue(should_fallback_from_pro(code, text))

    def test_per_minute_quota_never_falls_back_even_when_marked(self):
        self.assertFalse(
            should_fallback_from_pro(
                7, f"{QUOTA_EXHAUSTED_MARKER}: Flow refused the image submit with RESOURCE_EXHAUSTED (PER_MINUTE_LIMIT)"
            )
        )

    def test_rate_limit_exit_code_without_daily_evidence_is_not_enough(self):
        self.assertFalse(should_fallback_from_pro(4, "Rate limit or quota hit"))


if __name__ == "__main__":
    unittest.main()
