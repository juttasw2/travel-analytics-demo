from __future__ import annotations

from datetime import date, datetime, timedelta
import re
from typing import Any

_NULLISH_TEXT_VALUES = {
    "",
    "null",
    "none",
    "none sent",
    "not sent",
    "n.v.t",
    "nvt",
}


def is_nullish(value: Any) -> bool:
    if value is None:
        return True
    # pandas often uses NaN
    try:
        return bool(value != value)  # NaN check
    except Exception:  # noqa: BLE001
        return False


def normalize_text(value: Any) -> str | None:
    if is_nullish(value):
        return None
    s = str(value).strip()
    return s if s else None


def parse_ddmmyyyy(value: Any) -> date | None:
    """
    Parse `dd/mm/yyyy` into a date.
    """
    if is_nullish(value):
        return None

    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value

    s = str(value).strip()
    if not s:
        return None

    s = s.replace("–", "-").replace("—", "-").replace("-", "/").replace(".", "/")
    try:
        return datetime.strptime(s, "%d/%m/%Y").date()
    except ValueError:
        return None


def parse_periode(value: Any) -> tuple[date, date] | None:
    """
    Parse `dd/mm/yyyy - dd/mm/yyyy` into (vertrekdatum, terugkeerdatum).
    """
    if is_nullish(value):
        return None

    s = str(value).strip()
    if not s:
        return None

    # Keep separators inside each date intact and only extract date-like substrings.
    # This supports values like:
    # - 01/07/2026 - 08/07/2026
    # - 01-07-2026 - 08-07-2026
    # - 01.07.2026 t/m 08.07.2026
    date_like_parts = re.findall(r"\d{1,2}[./-]\d{1,2}[./-]\d{4}", s.replace("–", "-").replace("—", "-"))
    if len(date_like_parts) < 2:
        return None

    vertrek = parse_ddmmyyyy(date_like_parts[0])
    terug = parse_ddmmyyyy(date_like_parts[1])
    if not vertrek or not terug:
        return None

    return vertrek, terug


def parse_booking_date(value: Any) -> date | None:
    parsed = parse_ddmmyyyy(value)
    if parsed:
        return parsed

    # Excel date serial numbers (days since 1899-12-30) can appear as numbers.
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        try:
            serial = float(value)
            if 1 <= serial <= 100000:
                return (date(1899, 12, 30) + timedelta(days=serial))
        except Exception:  # noqa: BLE001
            return None

    return parse_date_flexible(value)


def parse_date_flexible(value: Any) -> date | None:
    """
    Parse verschillende datumformaten naar `date`.
    Ondersteunt o.a.:
    - dd/mm/yyyy
    - yyyy-mm-dd
    - datetime/date objecten
    """
    if is_nullish(value):
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value

    s = str(value).strip()
    if not s:
        return None

    # Primary parser (dd/mm/yyyy varianten)
    d = parse_ddmmyyyy(s)
    if d:
        return d

    # ISO parser
    try:
        return date.fromisoformat(s[:10])
    except ValueError:
        return None


def parse_optional_date(value: Any) -> date | None:
    """
    Parse optional date values and return None for known textual null markers.
    """
    if is_nullish(value):
        return None
    normalized = str(value).strip().lower()
    if normalized in _NULLISH_TEXT_VALUES:
        return None
    return parse_date_flexible(value)


def parse_optional_datetime(value: Any) -> datetime | None:
    """
    Parse optional datetime-like values with graceful null handling.
    """
    if is_nullish(value):
        return None
    if isinstance(value, datetime):
        return value
    if isinstance(value, date):
        return datetime.combine(value, datetime.min.time())

    s = str(value).strip()
    if not s:
        return None
    if s.lower() in _NULLISH_TEXT_VALUES:
        return None

    for fmt in (
        "%d/%m/%Y %H:%M:%S",
        "%d/%m/%Y %H:%M",
        "%d-%m-%Y %H:%M:%S",
        "%d-%m-%Y %H:%M",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
    ):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue

    iso_candidate = s.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(iso_candidate)
    except ValueError:
        parsed_date = parse_optional_date(s)
        if parsed_date is None:
            return None
        return datetime.combine(parsed_date, datetime.min.time())


def to_int(value: Any) -> int | None:
    if is_nullish(value):
        return None
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)

    s = str(value).strip()
    if not s:
        return None

    s = s.replace(" ", "").replace(".", "").replace(",", ".")
    try:
        return int(float(s))
    except ValueError:
        return None


def to_float(value: Any) -> float | None:
    if is_nullish(value):
        return None
    if isinstance(value, bool):
        return float(int(value))
    if isinstance(value, (int, float)):
        return float(value)

    s = str(value).strip()
    if not s:
        return None

    # Keep only digits, separators and minus sign (strip currency symbols/text).
    s = re.sub(r"[^0-9,.\-]", "", s).replace(" ", "")
    if not s or s in {"-", ".", ","}:
        return None

    has_comma = "," in s
    has_dot = "." in s
    if has_comma and has_dot:
        # Determine decimal separator by the last occurring symbol.
        last_comma = s.rfind(",")
        last_dot = s.rfind(".")
        decimal_sep = "," if last_comma > last_dot else "."
        thousands_sep = "." if decimal_sep == "," else ","
        s = s.replace(thousands_sep, "")
        if decimal_sep == ",":
            s = s.replace(",", ".")
    elif has_comma:
        # Single separator can be decimal or thousand separator.
        comma_count = s.count(",")
        if comma_count == 1 and len(s.split(",")[-1]) in {1, 2}:
            s = s.replace(",", ".")
        else:
            s = s.replace(",", "")
    elif has_dot:
        dot_count = s.count(".")
        if not (dot_count == 1 and len(s.split(".")[-1]) in {1, 2}):
            s = s.replace(".", "")

    try:
        return float(s)
    except ValueError:
        return None


def to_bool(value: Any) -> bool | None:
    if is_nullish(value):
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(int(value))

    s = str(value).strip().lower()
    if not s:
        return None

    truthy = {"true", "t", "yes", "y", "1", "waar", "ja", "x"}
    falsy = {"false", "f", "no", "n", "0", "onwaar", "nee"}
    if s in truthy:
        return True
    if s in falsy:
        return False
    return None


def parse_optional_boolean(value: Any) -> bool | None:
    if is_nullish(value):
        return None
    normalized = str(value).strip().lower()
    if normalized in _NULLISH_TEXT_VALUES:
        return None
    return to_bool(value)


def parse_optional_number(value: Any) -> float | None:
    if is_nullish(value):
        return None
    normalized = str(value).strip().lower()
    if normalized in _NULLISH_TEXT_VALUES:
        return None
    return to_float(value)


def parse_nullable_number(value: Any) -> float | None:
    """Alias voor importlaag / tests; zelfde gedrag als parse_optional_number."""
    return parse_optional_number(value)


def parse_nullable_date(value: Any) -> date | None:
    """Alias voor importlaag; zelfde gedrag als parse_optional_date."""
    return parse_optional_date(value)


def parse_nullable_boolean(value: Any) -> bool | None:
    """
    Booleans uit Excel: true/false, ja/nee, 1/0, lege cel -> None.
    Checkbox-export: alleen 'x' (of X) -> True (expliciete lege string blijft None via is_nullish).
    """
    if is_nullish(value):
        return None
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        low = stripped.lower()
        if low == "x":
            return True
    return parse_optional_boolean(value)


def normalize_header(value: Any) -> str:
    """Zelfde normalisatie als excel_parser._norm_col voor veilige header-vergelijking."""
    if value is None:
        return ""
    return "".join(ch.lower() for ch in str(value).strip() if ch.isalnum())


def canonical_date_key_for_traveller_match(value: Any) -> str | None:
    """
    Geboortedatum in één canonieke vorm (YYYY-MM-DD) voor dedupe/sleutels,
    zodat Python-date, ISO-strings en DB-roundtrip niet uit elkaar lopen.
    """
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    s = str(value).strip()
    if not s:
        return None
    if len(s) >= 10 and s[4] == "-" and s[7] == "-":
        return s[:10]
    parsed = parse_date_flexible(value)
    return parsed.isoformat() if parsed else None

