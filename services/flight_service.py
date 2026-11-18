from __future__ import annotations

from datetime import datetime
from typing import Any

from services.supabase_service import SupabaseService


def _datetime_to_iso(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def replace_boeking_vluchten(
    *,
    supabase: SupabaseService,
    booking_map: dict[str, str],
    booking_ids: list[str],
    flight_rows: list[Any],
) -> None:
    """
    Replace all booking flights for current import scope to stay idempotent.
    """
    supabase.delete_boeking_vluchten_for_booking_ids(booking_ids)

    rows: list[dict[str, Any]] = []
    seen_keys: set[tuple[str, str | None, str | None]] = set()
    for flight in flight_rows:
        order_nummer = getattr(flight, "order_nummer", None)
        if not order_nummer:
            continue
        boeking_id = booking_map.get(str(order_nummer))
        if not boeking_id:
            continue

        richting = getattr(flight, "direction", None)
        vluchtnummer = getattr(flight, "flight_number", None)
        dedupe_key = (str(boeking_id), richting, vluchtnummer)
        if dedupe_key in seen_keys:
            continue
        seen_keys.add(dedupe_key)

        rows.append(
            {
                "boeking_id": boeking_id,
                "richting": richting,
                "vluchtnummer": vluchtnummer,
                "maatschappij": getattr(flight, "airline", None),
                "vertrek_tijd": _datetime_to_iso(getattr(flight, "departure_time", None)),
                "aankomst_tijd": _datetime_to_iso(getattr(flight, "arrival_time", None)),
                "vertrek_luchthaven": getattr(flight, "departure_airport", None),
                "aankomst_luchthaven": getattr(flight, "arrival_airport", None),
                "transfer_type": getattr(flight, "transfer_type", None),
                "transfer_prijs": getattr(flight, "transfer_price", None),
                "bagage_prijs": getattr(flight, "baggage_price", None),
            }
        )

    if rows:
        supabase.insert_boeking_vluchten(rows)
