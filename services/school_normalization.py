"""Canonicalisatie schoolnamen voor Klantenprofiel (uitbreidbaar via alias-tabel)."""

from __future__ import annotations

import re
from functools import lru_cache

# Ruwe variant → één weergavenaam (uitbreidbaar zonder schema-wijziging)
_SCHOOL_ALIASES: dict[str, str] = {
    "sint jozefscollege": "Sint-Jozefscollege",
    "st jozefscollege": "Sint-Jozefscollege",
    "sint jozefs college": "Sint-Jozefscollege",
    "atheneum zuid": "Atheneum Zuid",
    "sint lievenscollege": "Sint-Lievenscollege",
    "st lievenscollege": "Sint-Lievenscollege",
    "heilig hartinstituut": "Heilig-Hartinstituut",
    "stedelijk lyceum": "Stedelijk Lyceum",
}

_WS_RE = re.compile(r"\s+")
_PUNCT_RE = re.compile(r"[,;]+")
_UNKNOWN_LABEL = "Niet ingevuld"
_UNKNOWN_KEYS = {
    "",
    "-",
    "/",
    "\\",
    "none",
    "null",
    "nvt",
    "n.v.t",
    "(leeg)",
    "(onbekend)",
}


def normalize_school_key(raw: str | None) -> str:
    """Vergelijkingssleutel: lowercase, trim, whitespace gecomprimeerd, minimale punctuatie."""
    if raw is None:
        return ""
    s = str(raw).strip().lower()
    if not s:
        return ""
    s = _PUNCT_RE.sub(" ", s)
    s = _WS_RE.sub(" ", s).strip()
    return s


def get_canonical_school(raw: str | None) -> str:
    """Publieke label: alias-mapping + title case licht opgeschoond."""
    key = normalize_school_key(raw)
    if key in _UNKNOWN_KEYS:
        return _UNKNOWN_LABEL
    if key in _SCHOOL_ALIASES:
        return _SCHOOL_ALIASES[key]
    for needle, canon in _SCHOOL_ALIASES.items():
        if len(needle) > 4 and needle in key:
            return canon
    # Title case per woord, behoud hoofdletters in bekende afkortingen
    parts = key.split(" ")
    out: list[str] = []
    for p in parts:
        if p in {"de", "van", "der", "den", "v/h", "v"}:
            out.append(p)
        elif len(p) <= 3 and p.isalpha() and p.isupper():
            out.append(p)
        else:
            out.append(p[:1].upper() + p[1:] if p else p)
    return " ".join(out)


@lru_cache(maxsize=1)
def alias_config_snapshot() -> dict[str, str]:
    """Leesbare kopie voor UI / documentatie."""
    return dict(_SCHOOL_ALIASES)
