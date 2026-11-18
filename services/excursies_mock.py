"""
Fallback-payload wanneer `public.excursies_lines_rpc` ontbreekt (PGRST202) of de RPC-call faalt.

Schema en velden komen overeen met de echte RPC-respons zodat de Excursies-UI bruikbaar blijft
tot deployment van `sql/rpc/excursies_rpc.sql`. `meta.mock` en `meta.fallback` markeren voorbeelddata.
"""

from __future__ import annotations

import uuid
from typing import Any


def mock_excursies_lines_payload(*, year: int) -> dict[str, Any]:
    """Retourneert dezelfde vorm als excursies_lines_rpc: rows + meta."""
    y = int(year or 2026) if year and year > 0 else 2026
    base_dep = f"{y}-07-15"
    rows: list[dict[str, Any]] = []
    templates = [
        ("City tour", "Stedentrip", "Rome", "BrandA", "Booking sale", "mollie", True, False),
        ("Kayak", "Sport", "Kroatë", "BrandA", "Local sale", "cash", False, False),
        ("Museum", "Cultuur", "Rome", "BrandB", "Booking sale", "ideal", True, True),
        ("Wijnproeverij", "Food", "Barcelona", "BrandB", "Local sale", "overschrijving", False, False),
    ]
    for i in range(16):
        t = templates[i % len(templates)]
        naam, etype, dest, brand, sch, betaal, online, pending = t
        vid = str(uuid.uuid4())
        bid = str(uuid.uuid4())
        prijs = 35.0 + (i % 5) * 12.5
        commissie = round(prijs * (0.18 if sch == "Booking sale" else 0.1), 2)
        added = f"{y}-05-{10 + (i % 20):02d}T12:00:00"
        rows.append(
            {
                "line_id": vid,
                "booking_id": bid,
                "order_nummer": f"ORD-{i + 1:05d}",
                "brand": brand,
                "destination": dest,
                "departure_date": base_dep,
                "booking_date": f"{y}-04-01",
                "year_filter_date": base_dep,
                "booking_pax": 20 + (i % 8),
                "excursie_naam": f"{naam} #{i % 4 + 1}",
                "excursie_type": etype,
                "verkoop_prijs": prijs,
                "is_gratis": prijs == 0,
                "kostjaar": y,
                "inkoop_prijs": round(prijs - commissie, 2),
                "commissie": commissie,
                "commissie_percentage": 18.0 if sch == "Booking sale" else 10.0,
                "berekende_commissie": commissie,
                "jaarkosten_gevonden": True,
                "totale_kost": round(prijs, 2),
                "marge": 0.0,
                "marge_percentage": 0.0,
                "betaling_pending": pending,
                "betaaloptie": betaal,
                "mollie_betaling_id": f"mollie_{i}" if betaal in ("mollie", "ideal") else None,
                "geboekt_in_online_account": online,
                "datum_toegevoegd": added,
                "sales_channel": sch,
                "booking_status": "confirmed",
            }
        )
    return {
        "rows": rows,
        "meta": {
            "inkoop_incomplete": False,
            "sales_channel_heuristic": True,
            "mock": True,
        },
    }
