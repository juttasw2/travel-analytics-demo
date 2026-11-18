"""Gedeelde normalisatie reizigers.land → BE | NL | IT | OTHER (uitbreidbaar)."""

from __future__ import annotations


def normalize_traveler_country_bucket(raw: str | None) -> str:
    """
    Map ruwe landstring naar analytics-bucket.
    Sluit aan bij logica in app/routes/dashboard.py::_parse_country plus 'OTHER'.
    """
    if raw is None:
        return "OTHER"
    s = str(raw).strip()
    if not s:
        return "OTHER"
    t = s.lower()
    if t in {"be", "belgium", "belgie", "belgië", "belgïe"}:
        return "BE"
    if t in {"nl", "nederland", "netherlands", "holland"}:
        return "NL"
    if t in {"it", "italy", "italia", "italië", "italie"}:
        return "IT"
    u = s.upper()
    if u in {"BE", "BELGIUM", "BELGIE", "BELGIË"}:
        return "BE"
    if u in {"NL", "NEDERLAND", "NETHERLANDS"}:
        return "NL"
    if u in {"IT", "ITALY", "ITALIA"}:
        return "IT"
    return "OTHER"


def country_filter_matches_bucket(bucket: str, filter_code: str) -> bool:
    """filter_code: __ALL__, BE, NL, IT, OTHER"""
    fc = (filter_code or "__ALL__").strip().upper()
    if fc in {"__ALL__", "ALL"}:
        return True
    return bucket == fc
