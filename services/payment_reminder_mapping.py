"""
Mapping van Excel-celwaarden voor betalingsherinneringen naar gehele getallen 0..3.

Gebruikt door de Bookings-sheet import (`Advance payment reminders`, `Total payment reminders`).
"""
from __future__ import annotations

import logging
import math
import re
from typing import Any

logger = logging.getLogger(__name__)

_KNOWN_STATUSES: dict[str, int] = {
    "none sent": 0,
    "first sent": 1,
    "second sent": 2,
    "third sent": 3,
}


def map_payment_reminder_status_to_count(value: Any, *, context: str | None = None) -> int:
    """
    Trim, case-insensitive mapping naar 0..3.

    - Leeg / null / NaN → 0
    - Gehele 0..3 (Excel kan soms getallen leveren) → ongewijzigd
    - Bekende teksten (None/First/Second/Third sent) → 0..3
    - Onbekend → waarschuwing in log + 0
    """
    if value is None:
        return 0
    if isinstance(value, bool):
        _log_unknown(value, context)
        return 0
    if isinstance(value, (int, float)):
        if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
            return 0
        iv = int(value)
        if 0 <= iv <= 3:
            return iv
        _log_unknown(value, context)
        return 0

    s = str(value).strip()
    if not s:
        return 0
    low = s.lower()
    if low in ("nan", "none", "nat", "null"):
        return 0

    normalized = re.sub(r"\s+", " ", low.strip())
    if normalized in _KNOWN_STATUSES:
        return _KNOWN_STATUSES[normalized]

    _log_unknown(value, context)
    return 0


def _log_unknown(value: Any, context: str | None) -> None:
    ctx = f" ({context})" if context else ""
    logger.warning("Onbekende betalingsherinnering-waarde%s: %r — gebruikt 0.", ctx, value)
