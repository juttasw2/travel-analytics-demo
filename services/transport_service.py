from __future__ import annotations

from typing import Any


def build_transport_maatschappij_map(flight_rows: list[Any]) -> dict[str, str | None]:
    """
    Map transporten.naam -> airline (maatschappij) op basis van Flights-sheet.
    """
    out: dict[str, str | None] = {}
    for fr in flight_rows:
        transport_naam = getattr(fr, "transport_naam", None)
        airline = getattr(fr, "airline", None)
        if transport_naam and airline:
            out[transport_naam] = airline
    return out

