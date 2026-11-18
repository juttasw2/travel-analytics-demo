"""Afgeleide klantidentiteit (traceerbaarheid / consistentie met SQL md5-concat)."""

from __future__ import annotations

import hashlib


def traveler_identity_digest(
    voornaam: str | None,
    achternaam: str | None,
    geboortedatum_iso: str | None,
) -> str:
    """
    Zelfde logica als DB: md5(lower(voornaam)|lower(achternaam)|geboortedatum).

    Gebruikt voor documentatie; loyalty wordt in SQL berekend.
    """
    vn = (voornaam or "").strip().lower()
    an = (achternaam or "").strip().lower()
    dob = (geboortedatum_iso or "").strip()
    raw = f"{vn}|{an}|{dob}".encode("utf-8")
    return hashlib.md5(raw).hexdigest()
