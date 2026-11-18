from __future__ import annotations

from typing import Any

from services.supabase_service import SupabaseService


def import_bookings_and_build_map(
    *,
    supabase: SupabaseService,
    bookings: list[Any],
    transport_maatschappij_map: dict[str, str | None],
    upload_id: str,
    parse_errors: list[str],
    warnings: list[str],
) -> tuple[dict[str, str], list[str], dict[str, int]]:
    """
    Latest upload overwrite for bookings, then upsert and return mapping:
    order_nummer -> boeking_id.
    """
    current_order_nummers = [b.order_nummer for b in bookings]

    # Safe upsert logic (append-only for other uploads):
    # - We never delete existing bookings from previous uploads.
    # - We upsert only the order_nummers found in the current Excel.
    existing = supabase.get_boekingen_ids_by_order_nummers(current_order_nummers)
    existing_orders_set = set(existing.keys())
    unique_order_nummers = sorted({o for o in current_order_nummers if o})

    # Alleen geaggregeerde logging (geen ordernummers in logs).
    insert_count = sum(1 for o in unique_order_nummers if o not in existing_orders_set)
    update_count = len(unique_order_nummers) - insert_count

    supabase.import_bookings(
        bookings_import=bookings,
        transport_maatschappij_map=transport_maatschappij_map,
        upload_id=upload_id,
    )

    booking_map = supabase.get_boekingen_ids_by_order_nummers(current_order_nummers)
    booking_ids = list(booking_map.values())

    for o in current_order_nummers:
        if o not in booking_map:
            warnings.append("Boeking niet gevonden in DB na upsert (gerelateerde inserts overgeslagen).")

    return booking_map, booking_ids, {
        "bookings_inserted": insert_count,
        "bookings_updated": update_count,
    }

