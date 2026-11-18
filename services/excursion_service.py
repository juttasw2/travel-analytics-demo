from __future__ import annotations

import hashlib
import re
import unicodedata
from typing import Any
from uuid import UUID

from services.supabase_service import SupabaseService, SupabaseServiceError


def _normalize_excursie_naam(value: str | None) -> str | None:
    if not value:
        return None
    folded = unicodedata.normalize("NFKD", value)
    ascii_only = "".join(ch for ch in folded if not unicodedata.combining(ch))
    collapsed = re.sub(r"\s+", " ", ascii_only).strip()
    if not collapsed:
        return None
    return collapsed.upper()


def _safe_uuid_or_none(value: str | None) -> str | None:
    if not value:
        return None
    try:
        return str(UUID(str(value)))
    except ValueError:
        return None


def _build_source_row_hash(
    *,
    order_nummer: str,
    naam: str,
    vertrekdatum: Any,
    terugkeerdatum: Any,
    prijs: Any,
    first_name: str | None,
    last_name: str | None,
    traveller_email: str | None,
) -> str:
    raw = "|".join(
        [
            str(order_nummer or "").strip(),
            str(naam or "").strip(),
            str(vertrekdatum or "").strip(),
            str(terugkeerdatum or "").strip(),
            str(prijs if prijs is not None else "").strip(),
            str(first_name or "").strip(),
            str(last_name or "").strip(),
            str(traveller_email or "").strip().lower(),
        ]
    )
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()  # noqa: S324 - deterministic import id, not crypto-security.


def _norm_name(value: str | None) -> str:
    return re.sub(r"\s+", " ", (value or "").strip().lower())


def _traveller_index_by_booking(
    travellers: list[dict[str, Any]],
) -> dict[str, dict[tuple[str, str], str]]:
    out: dict[str, dict[tuple[str, str], str]] = {}
    for tr in travellers:
        bid = str(tr.get("boeking_id") or "").strip()
        if not bid:
            continue
        fn = _norm_name(str(tr.get("voornaam") or ""))
        ln = _norm_name(str(tr.get("achternaam") or ""))
        rid = str(tr.get("id") or "").strip()
        if not rid:
            continue
        out.setdefault(bid, {})[(fn, ln)] = rid
    return out


def _order_lower_index(booking_map: dict[str, str]) -> dict[str, str]:
    """Eerste boeking_id per genormaliseerd (strip + lower) ordernummer."""
    by_lower: dict[str, str] = {}
    for raw_k, bid in booking_map.items():
        kl = str(raw_k).strip().lower()
        if kl and kl not in by_lower:
            by_lower[kl] = bid
    return by_lower


def _resolve_boeking_id(
    order_nummer: str | None,
    booking_map: dict[str, str],
    by_lower: dict[str, str],
) -> str | None:
    if order_nummer is None:
        return None
    s = str(order_nummer).strip()
    if not s:
        return None
    bid = booking_map.get(s)
    if bid:
        return bid
    return by_lower.get(s.lower())


def upsert_excursies_relations(
    *,
    supabase: SupabaseService,
    excursion_rows: list[Any],
    booking_map: dict[str, str],
    booking_ids: list[str],
    parse_errors: list[str],
    warnings: list[str],
    upload_id: str | None = None,
) -> None:
    """
    Upsert/append relations for:
      - excursies (master upsert)
      - boeking_excursies (idempotent append: never delete existing rows)
    """
    from logging import getLogger
    logger = getLogger(__name__)

    by_order_lower = _order_lower_index(booking_map)

    booking_context_by_id = supabase.get_boekingen_context_for_ids(booking_ids)
    upload_uuid = _safe_uuid_or_none(upload_id)

    # Upsert excursion master (unique key: (normalized_naam, bestemming_id))
    master_pairs: dict[tuple[str, str | None], dict[str, Any]] = {}
    for er in excursion_rows:
        if not getattr(er, "naam", None):
            continue
        boeking_id = _resolve_boeking_id(getattr(er, "order_nummer", None), booking_map, by_order_lower)
        bestemming_id: str | None = None
        if boeking_id:
            ctx = booking_context_by_id.get(str(boeking_id))
            if isinstance(ctx, dict):
                raw_bestemming = ctx.get("bestemming_id")
                bestemming_id = str(raw_bestemming) if raw_bestemming else None
        normalized_naam = _normalize_excursie_naam(getattr(er, "naam", None))
        if not normalized_naam:
            continue
        key = (normalized_naam, bestemming_id)
        if key not in master_pairs:
            master_pairs[key] = {
                "naam": er.naam,
                "normalized_naam": normalized_naam,
                "bestemming_id": bestemming_id,
                "type": getattr(er, "type", None) or "Algemeen",
                "prijs": getattr(er, "prijs", None),
                "excursie_type": getattr(er, "excursie_type", None),
            }

    # Master upsert
    # If this remains empty, `excel_parser` likely returned no excursion rows or filtered them out.
    logger.info(
        "Excursies parsed=%d master_pairs=%d booking_ids=%d",
        len(excursion_rows),
        len(master_pairs),
        len(booking_ids),
    )

    logger.info("Excursies upsert master start needed_pairs=%d", len(master_pairs))
    excursie_id_map = supabase.upsert_excursies_master(list(master_pairs.values()))
    logger.info("Excursies upsert master done exc_id_map=%d", len(excursie_id_map))

    # Ensure booking + traveller statuses exist via 2 round-trips (bulk).
    booking_status_cache: dict[tuple[str, str], str | None] = {}
    traveller_status_cache: dict[tuple[str, str], str | None] = {}
    unique_booking_status_names = {
        er.booking_status_naam for er in excursion_rows if getattr(er, "booking_status_naam", None)
    }
    if unique_booking_status_names:
        supabase.bulk_load_statussen(
            [("boeking", n) for n in unique_booking_status_names], booking_status_cache
        )
    unique_traveller_status_names = {
        getattr(er, "traveller_status_naam", None)
        for er in excursion_rows
        if getattr(er, "traveller_status_naam", None)
    }
    if unique_traveller_status_names:
        supabase.bulk_load_statussen(
            [("reiziger", n) for n in unique_traveller_status_names], traveller_status_cache
        )
    travellers_for_bookings = supabase.get_reizigers_for_booking_ids(booking_ids)
    traveller_id_index = _traveller_index_by_booking(travellers_for_bookings)
    logger.info(
        "Excursies statuses ensured booking=%d traveller=%d",
        len(unique_booking_status_names),
        len(unique_traveller_status_names),
    )

    relation_rows: list[dict[str, Any]] = []
    skipped_missing_booking_id = 0
    skipped_missing_excursie_master = 0
    missing_order_samples: list[str] = []
    for er in excursion_rows:
        boeking_id = _resolve_boeking_id(getattr(er, "order_nummer", None), booking_map, by_order_lower)
        if not boeking_id:
            skipped_missing_booking_id += 1
            on = str(getattr(er, "order_nummer", "") or "").strip()
            if on and len(missing_order_samples) < 25 and on not in missing_order_samples:
                missing_order_samples.append(on)
            continue

        ctx = booking_context_by_id.get(str(boeking_id))
        bestemming_id = None
        if isinstance(ctx, dict):
            raw_bestemming = ctx.get("bestemming_id")
            bestemming_id = str(raw_bestemming) if raw_bestemming else None
        normalized_naam = _normalize_excursie_naam(getattr(er, "naam", None))
        if not normalized_naam:
            skipped_missing_excursie_master += 1
            warnings.append("Excursies: lege/genormaliseerde naam ontbreekt — rij overgeslagen.")
            continue
        exc_id = excursie_id_map.get((normalized_naam, bestemming_id))
        if not exc_id:
            skipped_missing_excursie_master += 1
            warnings.append("Excursies: excursie master niet gevonden — rij overgeslagen.")
            continue

        verkoopprijs = float(getattr(er, "prijs", 0) or 0)
        rid = None
        fn_norm = _norm_name(getattr(er, "first_name", None))
        ln_norm = _norm_name(getattr(er, "last_name", None))
        if fn_norm or ln_norm:
            rid = traveller_id_index.get(str(boeking_id), {}).get((fn_norm, ln_norm))
        relation_rows.append(
            {
                "boeking_id": boeking_id,
                "reiziger_id": rid,
                "excursie_id": exc_id,
                "vertrekdatum": er.vertrekdatum,
                "terugkeerdatum": er.terugkeerdatum,
                "verkoopprijs": verkoopprijs,
                "is_gratis": verkoopprijs == 0,
                "upload_id": upload_uuid,
                "bron_rij_hash": _build_source_row_hash(
                    order_nummer=getattr(er, "order_nummer", ""),
                    naam=getattr(er, "naam", ""),
                    vertrekdatum=getattr(er, "vertrekdatum", None),
                    terugkeerdatum=getattr(er, "terugkeerdatum", None),
                    prijs=getattr(er, "prijs", None),
                    first_name=getattr(er, "first_name", None),
                    last_name=getattr(er, "last_name", None),
                    traveller_email=getattr(er, "traveller_email", None),
                ),
                "ingevoerd_via": "excel/import",
                "betaling_pending": er.betaling_pending,
                "boeking_status_id": booking_status_cache.get(("boeking", er.booking_status_naam))
                if er.booking_status_naam
                else None,
                "reiziger_status_id": traveller_status_cache.get(("reiziger", getattr(er, "traveller_status_naam", None)))
                if getattr(er, "traveller_status_naam", None)
                else None,
                "voornaam": getattr(er, "first_name", None),
                "achternaam": getattr(er, "last_name", None),
                "traveller_email": getattr(er, "traveller_email", None),
                "bestemming_naam": getattr(er, "bestemming_naam", None),
                "commentaar": er.commentaar,
                "betaaloptie": er.betaaloptie,
                "mollie_betaling_id": er.mollie_betaling_id,
                "geboekt_in_online_account": er.geboekt_in_online_account,
                "datum_toegevoegd": er.datum_toegevoegd,
            }
        )

    logger.info(
        "Excursies relation_rows built=%d skipped_missing_booking_id=%d skipped_missing_excursie_master=%d",
        len(relation_rows),
        skipped_missing_booking_id,
        skipped_missing_excursie_master,
    )

    if skipped_missing_booking_id > 0:
        msg = (
            f"Excursies: {skipped_missing_booking_id} rij(en) overgeslagen: ordernummer komt niet voor "
            f"in de geïmporteerde boekingen (geen match in bookings-sheet / DB)."
        )
        logger.warning("%s Voorbeelden: %s", msg, missing_order_samples)
        warnings.append(f"{msg} Voorbeeld-order(s): {', '.join(missing_order_samples[:10])}.")

    relation_booking_ids = {str(r["boeking_id"]) for r in relation_rows if r.get("boeking_id")}
    existing_booking_ids = supabase.get_existing_boeking_ids(relation_booking_ids)
    missing_in_db = sorted(relation_booking_ids - existing_booking_ids)
    if missing_in_db:
        logger.error("Excursies FK precheck failed missing_booking_ids=%s", missing_in_db[:20])
        raise SupabaseServiceError(
            f"Excursies import afgebroken: booking_ids ontbreken in boekingen: {missing_in_db[:20]}"
        )

    def rel_key(r: dict[str, Any]) -> tuple[Any, ...]:
        return (
            str(r.get("boeking_id")),
            str(r.get("excursie_id")),
            r.get("vertrekdatum"),
            r.get("terugkeerdatum"),
            r.get("verkoopprijs"),
            r.get("is_gratis"),
            r.get("betaling_pending"),
            r.get("boeking_status_id"),
            r.get("reiziger_status_id"),
            r.get("reiziger_id"),
            r.get("bron_rij_hash"),
            r.get("commentaar"),
            r.get("betaaloptie"),
            r.get("mollie_betaling_id"),
            r.get("geboekt_in_online_account"),
        )

    existing_relations = supabase.get_boeking_excursies_for_booking_ids(booking_ids)
    existing_keys = {rel_key(r) for r in existing_relations}

    to_insert: list[dict[str, Any]] = []
    to_insert_keys: set[tuple[Any, ...]] = set()
    for rr in relation_rows:
        k = rel_key(rr)
        if k in existing_keys or k in to_insert_keys:
            continue
        to_insert_keys.add(k)
        to_insert.append(rr)
        existing_keys.add(k)

    logger.info(
        "Excursies append computed to_insert=%d existing_relation_keys=%d relation_rows=%d",
        len(to_insert),
        len(existing_keys),
        len(relation_rows),
    )
    if to_insert:
        logger.info("Excursies insert start insert_rows=%d", len(to_insert))
        supabase.insert_boeking_excursies(to_insert)
        logger.info("Excursies append committed insert_count=%d", len(to_insert))

    sync_ids = sorted({str(r["excursie_id"]) for r in relation_rows if r.get("excursie_id")})
    if sync_ids:
        try:
            n = supabase.sync_excursies_bestemming_from_bookings(excursie_ids=sync_ids)
            logger.info("Excursies bestemming_id gesynchroniseerd na import updated=%s excursies=%d", n, len(sync_ids))
        except SupabaseServiceError as sync_exc:
            logger.warning(
                "Excursies bestemming sync overgeslagen (deploy migrations/excursies_bestemming_sync.sql): %s",
                sync_exc,
            )


# Backwards-compatible alias.
def replace_excursies(*args, **kwargs):  # type: ignore[no-untyped-def]
    return upsert_excursies_relations(*args, **kwargs)

