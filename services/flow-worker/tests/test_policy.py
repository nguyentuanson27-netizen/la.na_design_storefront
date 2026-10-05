import unittest

from flow_worker.policy import should_fallback_to_nano2


class FallbackPolicyTest(unittest.TestCase):
    def test_daily_pro_quota_exhaustion_falls_back(self):
        for text in (
            "You have reached the daily limit for Nano Banana Pro.",
            "Daily generation quota reached for Nano Banana Pro",
            '{"status":429,"title":"Rate limit or quota hit","detail":"daily limit for Nano Banana Pro"}',
        ):
            with self.subTest(text=text):
                self.assertTrue(should_fallback_to_nano2(4, text))

    def test_ambiguous_daily_quota_without_pro_model_name_does_not_fall_back(self):
        self.assertFalse(should_fallback_to_nano2(4, "Daily generation quota reached"))

    def test_per_minute_rate_limit_does_not_fall_back(self):
        self.assertFalse(
            should_fallback_to_nano2(
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
                self.assertFalse(should_fallback_to_nano2(code, text))

    def test_rate_limit_exit_code_without_daily_evidence_is_not_enough(self):
        self.assertFalse(should_fallback_to_nano2(4, "Rate limit or quota hit"))


if __name__ == "__main__":
    unittest.main()
