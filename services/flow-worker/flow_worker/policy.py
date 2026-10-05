import re

_DAILY = re.compile(r"\bdaily\b", re.IGNORECASE)
_QUOTA_OR_LIMIT = re.compile(r"\b(?:quota|limit)\b", re.IGNORECASE)
_PRO = re.compile(r"\bnano(?:\s+banana)?\s+pro\b", re.IGNORECASE)
_PER_MINUTE = re.compile(r"per[- ]?minute|minute\s+(?:quota|limit)", re.IGNORECASE)


def should_fallback_to_nano2(exit_code: int, output: str) -> bool:
    """Only a proven Nano Banana Pro daily-quota exhaustion may spend a Nano 2 attempt."""
    if exit_code != 4:
        return False
    if _PER_MINUTE.search(output):
        return False
    return bool(_DAILY.search(output) and _QUOTA_OR_LIMIT.search(output) and _PRO.search(output))
