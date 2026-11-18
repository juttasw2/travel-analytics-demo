from __future__ import annotations

import logging
from typing import Any

from services.excel_parser import ExcelRow
from services.kost_transport_rule import normalize_financial_costs
from services.supabase_service import SupabaseService, SupabaseServiceError
from services.traveller_finance_mapping import map_traveller_finance_from_excel_row
from services.validation import canonical_date_key_for_traveller_match


def _traveller_dedupe_key_from_row(row: dict[str, Any]) -> tuple[Any, ...]:
    """Stabiele sleutel binnen één importbatch (geen DB-id; inhoudelijke gelijkheid)."""
    return (
        str(row.get("boeking_id")),
        row.get("voornaam"),
        row.get("achternaam"),
        canonical_date_key_for_traveller_match(row.get("geboortedatum")),
        row.get("geslacht"),
        str(row.get("traveller_status_id")) if row.get("traveller_status_id") is not None else None,
        row.get("incasso_status"),
        row.get("uitgesloten_van_communicatie"),
        row.get("stad"),
        row.get("provincie"),
        row.get("land"),
        row.get("school"),
        row.get("transport_status"),
    )


def _count_non_null_finance_fields(payload: dict[str, Any]) -> int:
    return sum(1 for v in payload.values() if v is not None)


def _derive_traveller_transport(*, kost_transport: Any, kost_transfer: Any) -> str:
    """Deterministische business rules: self/bus/plane op reizigersniveau."""
    try:
        kt = float(kost_transport) if kost_transport is not None else None
    except (TypeError, ValueError):
        kt = None
    try:
        ktr = float(kost_transfer) if kost_transfer is not None else None
    except (TypeError, ValueError):
        ktr = None
    if kt == 1:
        return "self"
    if kt == 130 and (ktr or 0) == 0:
        return "bus"
    return "plane"


def upsert_reizigers(
    *,
    supabase: SupabaseService,
    bookings: list[Any],
    booking_map: dict[str, str],
    booking_ids: list[str],
    parse_errors: list[str],
    warnings: list[str],
) -> None:
    """
    Synchroniseert `reizigers` met de laatste Excel voor alle geïmporteerde boekingen:

    1. valideer dat elke boeking een `boeking_id` heeft;
    2. verwijder alle bestaande reizigers voor die `boeking_id` (incl. cascade op `reiziger_financien`);
    3. voeg daarna opnieuw alle reizigers uit de Excel in (geen merge op oude rijen);
    4. voor elke ingevoegde reiziger: upsert `reiziger_financien` op basis van dezelfde Excel-rij.

    Financiële mapping is per reiziger (Excel-rij), niet via een losse DB-lookup op inhoudelijke sleutel:
    na insert krijgen we `reiziger_id` terug (`return=representation`) en koppelen we 1-op-1.
    """
    logger = logging.getLogger(__name__)

    traveller_status_cache: dict[tuple[str, str], str | None] = {}
    status_pairs: list[tuple[str, str]] = []
    seen_names: set[str] = set()
    for b in bookings:
        for tr in getattr(b, "traveller_rows", []):
            naam = getattr(tr, "traveller_status_naam", None)
            if naam and naam not in seen_names:
                seen_names.add(naam)
                status_pairs.append(("reiziger", naam))
    if status_pairs:
        supabase.bulk_load_statussen(status_pairs, traveller_status_cache)

    traveller_row_and_finance: list[tuple[dict[str, Any], dict[str, Any]]] = []
    skipped_missing_booking_id = 0
    for b in bookings:
        boeking_id = booking_map.get(b.order_nummer)
        if not boeking_id:
            skipped_missing_booking_id += 1
            continue
        for tr in getattr(b, "traveller_rows", []):
            if not isinstance(tr, ExcelRow):
                continue
            first_name = getattr(tr, "first_name", None)
            last_name = getattr(tr, "last_name", None)
            geboortedatum = getattr(tr, "geboortedatum", None)
            geslacht = getattr(tr, "geslacht", None)
            traveller_status_naam = getattr(tr, "traveller_status_naam", None)

            traveller_status_id = None
            if traveller_status_naam:
                traveller_status_id = traveller_status_cache.get(("reiziger", traveller_status_naam))

            row = {
                "boeking_id": boeking_id,
                "voornaam": first_name,
                "achternaam": last_name,
                "geboortedatum": geboortedatum,
                "geslacht": geslacht,
                "traveller_status_id": traveller_status_id,
                "incasso_status": getattr(tr, "collections", None),
                "uitgesloten_van_communicatie": getattr(tr, "uitgesloten_van_communicatie", None),
                "stad": getattr(tr, "stad", None),
                "provincie": getattr(tr, "provincie", None),
                "land": getattr(tr, "land", None),
                "school": getattr(tr, "school", None),
                "transport_status": getattr(tr, "transport_status", None),
            }
            finance_payload = map_traveller_finance_from_excel_row(tr)
            # Import-normalisatie: defaults direct opslaan in reiziger_financien.
            norm_kost_transport, norm_kost_transfer = normalize_financial_costs(
                transport_type=getattr(tr, "transport_naam", None) or getattr(b, "transport_naam", None),
                brand=getattr(b, "brand", None),
                kost_transport=finance_payload.get("kost_transport"),
                kost_transfer=finance_payload.get("kost_transfer"),
            )
            finance_payload["kost_transport"] = norm_kost_transport
            finance_payload["kost_transfer"] = norm_kost_transfer
            row["transport"] = _derive_traveller_transport(
                kost_transport=finance_payload.get("kost_transport"),
                kost_transfer=finance_payload.get("kost_transfer"),
            )
            traveller_row_and_finance.append((row, finance_payload))

    if skipped_missing_booking_id > 0:
        raise SupabaseServiceError(
            "Reizigers import afgebroken: ontbrekende booking_id mappingen; geen child insert uitgevoerd."
        )

    sync_ids_ordered: list[str] = []
    seen_id: set[str] = set()
    for b in bookings:
        bid = booking_map.get(b.order_nummer)
        if bid and str(bid) not in seen_id:
            seen_id.add(str(bid))
            sync_ids_ordered.append(str(bid))

    existing_booking_ids = supabase.get_existing_boeking_ids(set(sync_ids_ordered))
    missing_in_db = sorted(set(sync_ids_ordered) - existing_booking_ids)
    if missing_in_db:
        raise SupabaseServiceError(
            f"Reizigers import afgebroken: booking_ids ontbreken in boekingen: {missing_in_db[:20]}"
        )

    raw_traveller_rows = len(traveller_row_and_finance)
    logger.info(
        "Reizigers sync: Bookings in batch=%d, raw traveller rows=%d; verwijder reizigers voor %d boeking(en)",
        len(bookings),
        raw_traveller_rows,
        len(sync_ids_ordered),
    )
    supabase.delete_reizigers_for_booking_ids(sync_ids_ordered)

    to_insert_pairs: list[tuple[dict[str, Any], dict[str, Any]]] = []
    inserted_keys: set[tuple[Any, ...]] = set()
    for row, finance_payload in traveller_row_and_finance:
        dk = _traveller_dedupe_key_from_row(row)
        if dk in inserted_keys:
            logger.info(
                "Dubbele reizigerregel overgeslagen (zelfde dedupe-sleutel) boeking_id=%s voornaam=%s",
                row.get("boeking_id"),
                row.get("voornaam"),
            )
            continue
        inserted_keys.add(dk)
        to_insert_pairs.append((row, finance_payload))

    logger.info(
        "Reizigers insert na dedupe: %d (raw uit Excel=%d)",
        len(to_insert_pairs),
        raw_traveller_rows,
    )

    reiziger_financien_rows: list[dict[str, Any]] = []
    if not to_insert_pairs:
        logger.info(
            "Geen reizigers om in te voegen; reiziger_financien upsert overgeslagen (0 records)."
        )
        return

    rows_only = [p[0] for p in to_insert_pairs]

    reiziger_ids = supabase.insert_reizigers(rows_only)
    if len(reiziger_ids) != len(rows_only):
        raise SupabaseServiceError(
            f"Reizigers insert: verwacht {len(rows_only)} reiziger-id's, kreeg {len(reiziger_ids)}."
        )

    travellers_created_or_found = len(reiziger_ids)
    logger.info(
        "Reizigers aangemaakt: %d (1-op-1 met geplande financiële rijen)",
        travellers_created_or_found,
    )

    finance_upsert_count = 0
    finance_with_data = 0
    finance_empty = 0
    for reiziger_id, (row, fin) in zip(reiziger_ids, to_insert_pairs, strict=True):
        non_null_fin = _count_non_null_finance_fields(fin)
        if non_null_fin == 0:
            finance_empty += 1
        else:
            finance_with_data += 1
            # Per-traveller debug-logging: alleen als DEBUG aanstaat. Bij INFO
            # zou 5000+ regels per upload de I/O overspoelen.
            if logger.isEnabledFor(logging.DEBUG):
                logger.debug(
                    "Mapped traveller finance for reiziger_id=%s: %d niet-null velden",
                    reiziger_id,
                    non_null_fin,
                )
        reiziger_financien_rows.append({"reiziger_id": reiziger_id, **fin})
        finance_upsert_count += 1
    logger.info(
        "Reizigers finance mapping: total=%d met_data=%d zonder_data=%d",
        finance_upsert_count,
        finance_with_data,
        finance_empty,
    )

    if reiziger_financien_rows:
        supabase.upsert_reiziger_financien(rows=reiziger_financien_rows)
        logger.info(
            "reiziger_financien upsert voltooid: %d record(s) (batch upsert op reiziger_id)",
            finance_upsert_count,
        )


# Backwards-compatible alias.
def replace_travellers(*args, **kwargs):  # type: ignore[no-untyped-def]
    return upsert_reizigers(*args, **kwargs)
