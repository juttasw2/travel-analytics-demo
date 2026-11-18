"""Normalisatie provincie (BE/NL) — lichte string-homogenisatie + enkele aliassen."""

from __future__ import annotations

import re

_WS_RE = re.compile(r"\s+")

_ALIASES: dict[str, str] = {
    "antwerp": "Antwerpen",
    "antwerpen ": "Antwerpen",
    "vlaams brabant": "Vlaams-Brabant",
    "vl.brabant": "Vlaams-Brabant",
    "west vlaanderen": "West-Vlaanderen",
    "west-vlaanderen": "West-Vlaanderen",
    "oost vlaanderen": "Oost-Vlaanderen",
    "oost-vlaanderen": "Oost-Vlaanderen",
    "limburg ": "Limburg",
    "noord brabant": "Noord-Brabant",
    "noord-brabant": "Noord-Brabant",
    "noord holland": "Noord-Holland",
    "zuid holland": "Zuid-Holland",
    "north holland": "Noord-Holland",
    "south holland": "Zuid-Holland",
    "utrecht ": "Utrecht",
}


def normalize_province_label(raw: str | None) -> str:
    if raw is None:
        return "(onbekend)"
    s = str(raw).strip()
    if not s:
        return "(onbekend)"
    key = _WS_RE.sub(" ", s).strip().lower()
    if key in _ALIASES:
        return _ALIASES[key]
    for a, b in _ALIASES.items():
        if a in key and len(a) > 5:
            return b
    # Sentence style
    return s[:1].upper() + s[1:] if s else s
