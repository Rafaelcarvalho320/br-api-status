"""Bounds on text that came from a third party, applied before it is stored.

Validator messages and divergence details quote what an API sent, and all of it
ends up in ``status.json``, which is committed every run and served to every
visitor. Without a bound, one misbehaving or hostile upstream answering with a
megabyte where a two-letter state code belongs would inflate the file on every
check for 48 hours. The page escapes everything it renders, so this is about
size, not markup.
"""

from __future__ import annotations

from typing import Any

#: Characters kept from any single third-party string.
MAX_TEXT = 160


def clip(value: Any, limit: int = MAX_TEXT) -> Any:
    """``value`` with strings cut to ``limit`` characters; numbers and None as is."""
    if value is None or isinstance(value, (bool, int, float)):
        return value
    text = value if isinstance(value, str) else str(value)
    return text if len(text) <= limit else text[: limit - 1] + "…"
