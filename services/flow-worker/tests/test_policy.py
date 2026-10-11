import unittest
from datetime import datetime, timedelta, timezone

from flow_worker.policy import (
    PRO_COOLDOWN_SHORT_SECONDS,
    PRO_COOLDOWN_UNKNOWN_SECONDS,
    QUOTA_EXHAUSTED_MARKER,
    ProCooldown,
    pro_refusal_kind,
    pro_unavailable_until,
    should_fallback_from_pro,
)

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

    def test_quota_markers_count_only_on_gflow_wire_errors(self):
        self.assertFalse(should_fallback_from_pro(1, f"{RESOURCE_EXHAUSTED} (NO_REASON)"))
        self.assertFalse(should_fallback_from_pro(5, "image submit answered HTTP 429"))

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


VIETNAM = timezone(timedelta(hours=7))


def vietnam(year, month, day, hour, minute=0):
    return datetime(year, month, day, hour, minute, tzinfo=VIETNAM).timestamp()


class ProCooldownPolicyTest(unittest.TestCase):
    def test_each_refusal_earns_the_cool_down_of_the_limit_it_names(self):
        for code, text, kind in (
            (4, "You have reached the daily limit for Nano Banana Pro.", "daily"),
            (7, f"{RESOURCE_EXHAUSTED} (PUBLIC_ERROR_DAILY_QUOTA)", "daily"),
            (7, f"{RESOURCE_EXHAUSTED} (PUBLIC_ERROR_DAILY_IMAGE_QUOTA)", "daily"),
            (37, "migrated host: Flow replaced the submit control with its insufficient-credits warning", "daily"),
            (4, "Rate limit or quota hit: per-minute model quota reached; retry later", "short"),
            (4, "HTTP 429 — rate limit hit", "short"),
            (7, f"{RESOURCE_EXHAUSTED} (PUBLIC_ERROR_PER_MINUTE_LIMIT)", "short"),
            (7, "migrated image submit answered HTTP 429", "short"),
            (7, f"{RESOURCE_EXHAUSTED} (NO_REASON)", "unknown"),
            (7, f"{RESOURCE_EXHAUSTED} (PUBLIC_ERROR_QUOTA)", "unknown"),
            (4, "Rate limit or quota hit", "unknown"),
            # Several limits named: the longest wins.
            (7, f"{RESOURCE_EXHAUSTED} (PUBLIC_ERROR_PER_MINUTE_LIMIT, PUBLIC_ERROR_DAILY_QUOTA)", "daily"),
        ):
            with self.subTest(code=code, text=text):
                self.assertEqual(pro_refusal_kind(code, text), kind)

    def test_failures_that_never_fall_back_earn_no_cool_down(self):
        for code, text in (
            (1, "PUBLIC_ERROR_UNUSUAL_ACTIVITY"),
            (5, "Content policy blocked this image"),
            (3, "NOT_SIGNED_IN daily"),
            (9, "no ogiZ0b image result within 180s"),
            (7, "migrated image submit answered HTTP 500"),
        ):
            with self.subTest(code=code, text=text):
                self.assertIsNone(pro_refusal_kind(code, text))

    def test_short_and_unknown_cool_downs_run_from_the_refusal(self):
        now = 1_000_000.0
        self.assertEqual(pro_unavailable_until("short", now), now + PRO_COOLDOWN_SHORT_SECONDS)
        self.assertEqual(pro_unavailable_until("unknown", now), now + PRO_COOLDOWN_UNKNOWN_SECONDS)
        self.assertTrue(60 <= PRO_COOLDOWN_SHORT_SECONDS <= 120)
        self.assertTrue(15 * 60 <= PRO_COOLDOWN_UNKNOWN_SECONDS <= 30 * 60)

    def test_a_daily_limit_lasts_until_the_next_3am_vietnam_time(self):
        for refused, reopens in (
            (vietnam(2026, 10, 10, 14, 30), vietnam(2026, 10, 11, 3)),
            (vietnam(2026, 10, 10, 23, 59), vietnam(2026, 10, 11, 3)),
            (vietnam(2026, 10, 11, 1, 15), vietnam(2026, 10, 11, 3)),
            (vietnam(2026, 10, 11, 3), vietnam(2026, 10, 12, 3)),
            (vietnam(2026, 12, 31, 20), vietnam(2027, 1, 1, 3)),
        ):
            with self.subTest(refused=datetime.fromtimestamp(refused, VIETNAM).isoformat()):
                self.assertEqual(pro_unavailable_until("daily", refused), reopens)

    def test_the_cool_down_holds_until_its_end_and_clears(self):
        cooldown = ProCooldown()
        self.assertFalse(cooldown.active(0.0))
        cooldown.note_refusal("short", 100.0)
        self.assertTrue(cooldown.active(100.0))
        self.assertTrue(cooldown.active(100.0 + PRO_COOLDOWN_SHORT_SECONDS - 1))
        self.assertFalse(cooldown.active(100.0 + PRO_COOLDOWN_SHORT_SECONDS))
        cooldown.note_refusal("unknown", 200.0)
        cooldown.clear()
        self.assertFalse(cooldown.active(201.0))


if __name__ == "__main__":
    unittest.main()
