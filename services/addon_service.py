from __future__ import annotations

from typing import Any

from services.supabase_service import SupabaseService, SupabaseServiceError


def upsert_addons_relations(
    *,
    supabase: SupabaseService,
    addon_rows: list[Any],
    booking_map: dict[str, str],
    booking_ids: list[str],
    parse_errors: list[str],
    warnings: list[str],
) -> None:
    """
    Upsert/append relations for:
      - addons (master upsert)
      - boeking_addons (idempotent append: never delete existing rows)
    """
    from logging import getLogger
    logger = getLogger(__name__)

    master_names: list[str] = []
    unique_names: set[str] = set()
    for ar in addon_rows:
        if ar.naam and ar.naam not in unique_names:
            unique_names.add(ar.naam)
            master_names.append(ar.naam)

    master_rows = [{"naam": n} for n in master_names]
    addon_id_map = supabase.upsert_addons_master(master_rows)

    booking_status_cache: dict[tuple[str, str], str | None] = {}
    unique_booking_status_names = {ar.booking_status_naam for ar in addon_rows if getattr(ar, "booking_status_naam", None)}
    for st in unique_booking_status_names:
        supabase.get_or_create_status(status_type="boeking", status_name=st, cache=booking_status_cache)

    from logging import getLogger
    logger.info(
        "Addons master upsert start master_names=%d",
        len(master_names),
    )
    relation_rows: list[dict[str, Any]] = []
    skipped_missing_booking_id = 0
    skipped_missing_addon_master = 0
    for ar in addon_rows:
        boeking_id = booking_map.get(ar.order_nummer)
        if not boeking_id:
            skipped_missing_booking_id += 1
            warnings.append("Addons: booking_id niet gevonden voor een rij.")
            continue

        addon_id = addon_id_map.get(ar.naam)
        if not addon_id:
            skipped_missing_addon_master += 1
            warnings.append("Addons: addon master niet gevonden — rij overgeslagen.")
            continue

        relation_rows.append(
            {
                "boeking_id": boeking_id,
                "addon_id": addon_id,
                "prijs": ar.prijs,
                "vertrekdatum": ar.vertrekdatum,
                "terugkeerdatum": ar.terugkeerdatum,
                "geboekt_in_online_account": ar.geboekt_in_online_account,
                "boeking_status_id": booking_status_cache.get(("boeking", ar.booking_status_naam))
                if ar.booking_status_naam
                else None,
            }
        )

    if skipped_missing_booking_id > 0:
        raise SupabaseServiceError(
            "Addons import afgebroken: ontbrekende booking_id mappingen; geen child insert uitgevoerd."
        )

    relation_booking_ids = {str(r["boeking_id"]) for r in relation_rows if r.get("boeking_id")}
    existing_booking_ids = supabase.get_existing_boeking_ids(relation_booking_ids)
    missing_in_db = sorted(relation_booking_ids - existing_booking_ids)
    if missing_in_db:
        logger.error("Addons FK precheck failed missing_booking_ids=%s", missing_in_db[:20])
        raise SupabaseServiceError(
            f"Addons import afgebroken: booking_ids ontbreken in boekingen: {missing_in_db[:20]}"
        )

    def rel_key(r: dict[str, Any]) -> tuple[Any, ...]:
        return (
            str(r.get("boeking_id")),
            str(r.get("addon_id")),
            r.get("prijs"),
            r.get("vertrekdatum"),
            r.get("terugkeerdatum"),
            r.get("geboekt_in_online_account"),
            r.get("boeking_status_id"),
        )

    existing_relations = supabase.get_boeking_addons_for_booking_ids(booking_ids)
    existing_keys = {rel_key(r) for r in existing_relations}

    logger.info(
        "Addons parsed=%d relation_rows=%d master_names=%d existing_keys=%d",
        len(addon_rows),
        len(relation_rows),
        len(master_names),
        len(existing_keys),
    )

    to_insert: list[dict[str, Any]] = []
    to_insert_keys: set[tuple[Any, ...]] = set()
    for rr in relation_rows:
        k = rel_key(rr)
        if k in existing_keys or k in to_insert_keys:
            continue
        to_insert_keys.add(k)
        to_insert.append(rr)
        existing_keys.add(k)

    if to_insert:
        logger.info("Addons insert start insert_rows=%d", len(to_insert))
        supabase.insert_boeking_addons(to_insert)
        logger.info("Addons append committed insert_count=%d", len(to_insert))


# Backwards-compatible alias.
def replace_addons(*args, **kwargs):  # type: ignore[no-untyped-def]
    return upsert_addons_relations(*args, **kwargs)

