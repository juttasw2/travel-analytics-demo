from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any
import logging
import os
from uuid import uuid4
from io import BytesIO

import pandas as pd

from services.excel_parser import parse_workbook
from services.grouping import group_rows_into_bookings
from services.booking_service import import_bookings_and_build_map
from services.flight_service import replace_boeking_vluchten
from services.traveller_service import upsert_reizigers
from services.excursion_service import upsert_excursies_relations
from services.addon_service import upsert_addons_relations
from services.supabase_service import SupabaseService, SupabaseServiceError
from services.upload_security import (
    ALLOWED_EXTENSIONS,
    MAX_FILE_SIZE_BYTES,
    UploadValidationResult,
    is_probably_xlsx,
    validate_upload_content,
)
from services.pre_boekingen_service import parse_vlucht_allotment_excel


logger = logging.getLogger(__name__)


def _format_max_size_label(size_bytes: int) -> str:
    mb_value = size_bytes / (1024 * 1024)
    if float(mb_value).is_integer():
        return f"{int(mb_value)}MB"
    return f"{mb_value:.1f}MB"


def _import_timeout_seconds() -> float:
    raw = os.getenv("UPLOAD_DB_TIMEOUT_SECONDS", "").strip()
    if not raw:
        return 60.0
    try:
        parsed = float(raw)
    except ValueError:
        return 60.0
    return max(20.0, parsed)


@dataclass(frozen=True)
class UploadResult:
    success: bool
    message: str
    errors: list[str]
    warnings: list[str]
    bookings_count: int
    upload_id: str
    counts: dict[str, int]
    debug: dict[str, Any] = field(default_factory=dict)

    def to_dict(self, *, include_debug: bool = False) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "success": self.success,
            "message": self.message,
            "errors": self.errors,
            "warnings": self.warnings,
            "bookings_count": self.bookings_count,
            "upload_id": self.upload_id,
            "counts": self.counts,
        }
        if include_debug:
            payload["debug"] = self.debug
        return payload


def validate_filename(filename: str, size_bytes: int, content_type: str | None = None) -> UploadValidationResult:
    lower = (filename or "").lower().strip()
    if not lower.endswith(ALLOWED_EXTENSIONS):
        return UploadValidationResult(ok=False, error="Ongeldig bestandstype. Alleen .xlsx-bestanden zijn toegestaan.")
    if size_bytes > MAX_FILE_SIZE_BYTES:
        return UploadValidationResult(
            ok=False,
            error=f"Bestand is te groot. Maximaal {_format_max_size_label(MAX_FILE_SIZE_BYTES)}.",
        )
    return validate_upload_content(content_type=content_type, filename=filename)


def handle_excel_upload(*, file_bytes: bytes, filename: str, size_bytes: int, content_type: str | None = None) -> UploadResult:
    return verwerk_boekingen_excel(
        file_bytes=file_bytes,
        filename=filename,
        size_bytes=size_bytes,
        content_type=content_type,
    )


def verwerk_boekingen_excel(*, file_bytes: bytes, filename: str, size_bytes: int, content_type: str | None = None) -> UploadResult:
    validation = validate_filename(filename, size_bytes, content_type=content_type)
    upload_id = f"proc-{uuid4()}"
    if not validation.ok:
        return UploadResult(
            success=False,
            message="Upload mislukt.",
            errors=[validation.error or "Ongeldig bestand."],
            warnings=[],
            bookings_count=0,
            upload_id=upload_id,
            counts={},
        )

    if not is_probably_xlsx(file_bytes):
        return UploadResult(
            success=False,
            message="Upload mislukt.",
            errors=["Bestandsinhoud is geen geldig .xlsx-formaat."],
            warnings=[],
            bookings_count=0,
            upload_id=upload_id,
            counts={},
        )

    zip_validation = validate_upload_content(file_bytes=file_bytes, filename=filename, content_type=content_type)
    if not zip_validation.ok:
        return UploadResult(
            success=False,
            message="Upload mislukt.",
            errors=[zip_validation.error or "Bestand kon niet veilig verwerkt worden."],
            warnings=[],
            bookings_count=0,
            upload_id=upload_id,
            counts={},
        )

    parse_errors: list[str] = []
    warnings: list[str] = []

    supabase = SupabaseService(timeout_seconds=_import_timeout_seconds())
    try:
        upload_id = supabase.insert_upload(bestandsnaam=filename, type="boekingen")
    except SupabaseServiceError:
        logger.exception("upload metadata opslaan mislukt; ga door met tijdelijke upload_id")

    # 2) Parse all sheets
    try:
        (
            bookings_rows,
            excursion_rows,
            addon_rows,
            flight_rows,
            parse_sheet_errors,
            sheet_statuses,
        ) = parse_workbook(file_bytes, filename)
        parse_errors = parse_sheet_errors
    except Exception:  # noqa: BLE001
        logger.exception("upload_id=%s parse exception", upload_id)
        return UploadResult(
            success=False,
            message="Upload mislukt tijdens verwerking.",
            errors=["Bestand kon niet veilig verwerkt worden."],
            warnings=[],
            bookings_count=0,
            upload_id=upload_id,
            counts={},
            debug={"parse_errors_count": len(parse_errors)},
        )

    logger.info(
        "upload_id=%s parse done bookings=%d excursions=%d addons=%d flights=%d parse_sheet_errors_count=%d",
        upload_id,
        len(bookings_rows),
        len(excursion_rows),
        len(addon_rows),
        len(flight_rows),
        len(parse_sheet_errors),
    )
    for section_name in ("bookings", "excursies", "addons", "flights"):
        st = sheet_statuses.get(section_name)
        if st is None:
            continue
        logger.info(
            "upload_id=%s section=%s found=%s valid=%s rows=%d parse_errors=%d sheet=%s",
            upload_id,
            section_name,
            st.found,
            st.valid,
            st.rows_count,
            len(st.errors),
            st.sheet_name,
        )

    # 3) Group traveller rows into bookings (also keep traveller rows per booking)
    bookings = group_rows_into_bookings(bookings_rows, warnings=warnings)
    if not bookings:
        try:
            sheet_names = [str(s).strip().lower() for s in pd.ExcelFile(BytesIO(file_bytes)).sheet_names]
        except Exception:  # noqa: BLE001
            sheet_names = []
        lijkt_allotment = False
        if lijkt_allotment:
            return UploadResult(
                success=False,
                message="Dit lijkt geen boekingenbestand. Kies 'Vlucht allotments' als uploadtype.",
                errors=["Boekingen-sheet niet gevonden of leeg."],
                warnings=[],
                bookings_count=0,
                upload_id=upload_id,
                counts={},
            )
        booking_parse_errors = [e for e in parse_errors if "Rij " in e or "Ontbrekende vereiste kolommen" in e]
        return UploadResult(
            success=False,
            message="Upload mislukt: geen valide boekingen gevonden.",
            errors=booking_parse_errors[:5],
            warnings=[],
            bookings_count=0,
            upload_id=upload_id,
            counts={},
            debug={"parse_errors_count": len(parse_errors), "sheet_statuses": {k: vars(v) for k, v in sheet_statuses.items()}},
        )

    unique_orders = len({b.order_nummer for b in bookings})
    logger.info(
        "upload_id=%s bookings_sheet_rows=%d grouped_bookings=%d unique_orders=%d booking_finance_warnings=%d",
        upload_id,
        len(bookings_rows),
        len(bookings),
        unique_orders,
        len(warnings),
    )

    # Diagnostiek: signaleer wanneer de bron-Excel (vrijwel) geen verzekeringsdata bevat.
    # Dit is een veelvoorkomende oorzaak van extreem lage cijfers op Financiën > Verzekeringen
    # en kan niet door de applicatie zelf gerepareerd worden — de gebruiker moet dan een
    # juiste bron-export (re)uploaden.
    if len(bookings_rows) >= 50:
        ins_pos = sum(
            1
            for r in bookings_rows
            if (r.prijs_annulatieverzekering or 0) > 0
            or (r.prijs_reisverzekering or 0) > 0
            or (r.prijs_annulatie_en_reisverzekering or 0) > 0
        )
        ins_pct = ins_pos / len(bookings_rows)
        logger.info(
            "upload_id=%s insurance_diagnostics rows=%d insured_rows=%d pct=%.4f",
            upload_id,
            len(bookings_rows),
            ins_pos,
            ins_pct,
        )
        if ins_pct < 0.02:
            warnings.append(
                "Let op: minder dan 2% van de boekingsrijen bevat een verzekeringsbedrag. "
                "Controleer of de bron-Excel verzekeringskolommen ('Price annulation insurance', "
                "'Price travel insurance', 'Price annulation and travel insurances') correct zijn ingevuld. "
                "De cijfers op Financiën > Verzekeringen zullen anders extreem laag uitvallen voor deze import."
            )

    current_order_nummers = [b.order_nummer for b in bookings]

    # 4) Process bookings FIRST (overwrite + upsert) and build booking map
    try:
        # `transporten` is a generic lookup by transport type and should not store
        # booking-specific airline values from the Flights sheet.
        transport_maatschappij_map: dict[str, str | None] = {}
        flight_non_null_transport = sum(1 for f in flight_rows if getattr(f, "transport_type", None))
        flight_non_null_airline = sum(1 for f in flight_rows if getattr(f, "airline", None))
        logger.info(
            "upload_id=%s flight_rows=%d non_null_transport=%d non_null_airline=%d",
            upload_id,
            len(flight_rows),
            flight_non_null_transport,
            flight_non_null_airline,
        )
        booking_map, booking_ids, booking_counts = import_bookings_and_build_map(
            supabase=supabase,
            bookings=bookings,
            transport_maatschappij_map=transport_maatschappij_map,
            upload_id=upload_id,
            parse_errors=parse_errors,
            warnings=warnings,
        )
    except SupabaseServiceError as exc:
        logger.exception("upload_id=%s bookings import failed: %s", upload_id, exc)
        err_txt = str(exc).lower()
        is_transient_network = (
            "connection aborted" in err_txt
            or "connection reset" in err_txt
            or "tijdelijk" in err_txt
            or "timed out" in err_txt
            or "read timed out" in err_txt
        )
        user_error = (
            "Tijdelijke verbindingsfout met de database tijdens boekingen import. Probeer de upload opnieuw."
            if is_transient_network
            else "Databasefout tijdens boekingen import."
        )
        return UploadResult(
            success=False,
            message="Upload mislukt tijdens boekingen import.",
            errors=[user_error],
            warnings=[],
            bookings_count=0,
            upload_id=upload_id,
            counts={},
            debug={
                "parse_errors_count": len(parse_errors),
                "technical_warnings_count": len(warnings),
                "bookings_import_error": str(exc),
            },
        )

    logger.info("upload_id=%s booking_map_pre_refresh=%d booking_ids=%d", upload_id, len(booking_map), len(booking_ids))
    refreshed_booking_map = supabase.get_boekingen_ids_by_order_nummers(current_order_nummers)
    refreshed_booking_ids = list(refreshed_booking_map.values())
    logger.info("upload_id=%s booking_map_post_refresh=%d booking_ids=%d", upload_id, len(refreshed_booking_map), len(refreshed_booking_ids))
    missing_orders = sorted(set(current_order_nummers) - set(refreshed_booking_map.keys()))
    if missing_orders:
        # Server-side diagnose: laat zien wélke order_nummers ontbreken en welke
        # geparste boekingen géén bestemming/accommodatie hadden (silent skip).
        sample_missing = missing_orders[:20]
        skipped_no_destination = sorted(
            {b.order_nummer for b in bookings if b.order_nummer in set(missing_orders) and not getattr(b, "bestemming_naam", None)}
        )[:20]
        skipped_no_accommodation = sorted(
            {b.order_nummer for b in bookings if b.order_nummer in set(missing_orders) and not getattr(b, "accommodatie_naam", None)}
        )[:20]
        logger.warning(
            "upload_id=%s readback_missing=%d/%d sample=%s no_destination=%s no_accommodation=%s",
            upload_id,
            len(missing_orders),
            len(current_order_nummers),
            sample_missing,
            skipped_no_destination,
            skipped_no_accommodation,
        )
        return UploadResult(
            success=False,
            message="Upload mislukt: niet alle boekingen zijn bevestigd in database.",
            errors=[],
            warnings=[],
            bookings_count=0,
            upload_id=upload_id,
            counts={},
            debug={
                "missing_orders_count": len(missing_orders),
                "missing_orders_sample": sample_missing,
                "missing_no_destination_sample": skipped_no_destination,
                "missing_no_accommodation_sample": skipped_no_accommodation,
                "parse_errors_count": len(parse_errors),
                "technical_warnings_count": len(warnings),
            },
        )
    booking_map = refreshed_booking_map
    booking_ids = refreshed_booking_ids

    # 5) Process flights (booking-specific rows)
    flights_status = sheet_statuses.get("flights")
    try:
        if flights_status and flights_status.found and flights_status.valid:
            logger.info("upload_id=%s start flights replace", upload_id)
            replace_boeking_vluchten(
                supabase=supabase,
                booking_map=booking_map,
                booking_ids=booking_ids,
                flight_rows=flight_rows,
            )
            logger.info("upload_id=%s flights replace done rows=%d", upload_id, len(flight_rows))
        else:
            logger.warning(
                "upload_id=%s flights skipped found=%s valid=%s errors=%s",
                upload_id,
                bool(flights_status and flights_status.found),
                bool(flights_status and flights_status.valid),
                (flights_status.errors if flights_status else []),
            )
    except SupabaseServiceError as exc:
        logger.exception("upload_id=%s flights failed: %s", upload_id, exc)
        return UploadResult(
            success=False,
            message="Upload mislukt tijdens flights import.",
            warnings=[],
            errors=["Databasefout tijdens flights import."],
            bookings_count=0,
            upload_id=upload_id,
            counts={},
            debug={"parse_errors_count": len(parse_errors), "technical_warnings_count": len(warnings)},
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("upload_id=%s flights crashed: %s", upload_id, exc)
        return UploadResult(
            success=False,
            message="Upload mislukt tijdens flights import (serverfout).",
            warnings=[],
            errors=["Interne serverfout tijdens flights import."],
            bookings_count=0,
            upload_id=upload_id,
            counts={},
            debug={"parse_errors_count": len(parse_errors), "technical_warnings_count": len(warnings)},
        )

    # 6) Process reizigers -> excursies -> addons
    logger.info("upload_id=%s start travellers upsert", upload_id)
    try:
        upsert_reizigers(
            supabase=supabase,
            bookings=bookings,
            booking_map=booking_map,
            booking_ids=booking_ids,
            parse_errors=parse_errors,
            warnings=warnings,
        )
    except SupabaseServiceError as exc:
        logger.exception("upload_id=%s travellers failed: %s", upload_id, exc)
        return UploadResult(
            success=False,
            message="Upload mislukt tijdens reizigers import.",
            warnings=[],
            errors=["Databasefout tijdens reizigers import."],
            bookings_count=0,
            upload_id=upload_id,
            counts={},
            debug={
                "parse_errors_count": len(parse_errors),
                "technical_warnings_count": len(warnings),
                "travellers_error": type(exc).__name__,
            },
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("upload_id=%s travellers crashed: %s", upload_id, exc)
        return UploadResult(
            success=False,
            message="Upload mislukt tijdens reizigers import (serverfout).",
            warnings=[],
            errors=["Interne serverfout tijdens reizigers import."],
            bookings_count=0,
            upload_id=upload_id,
            counts={},
            debug={
                "parse_errors_count": len(parse_errors),
                "technical_warnings_count": len(warnings),
                "travellers_error": type(exc).__name__,
            },
        )

    try:
        excursies_status = sheet_statuses.get("excursies")
        # Gate: zodra de Excursies-sheet gevonden is en er minstens één rij geparseerd is,
        # gaan we door met de upsert. Parse-errors van losse rijen worden als warning
        # gepresenteerd in plaats van de complete excursies-import te skippen (anders
        # gaat één foute datum/ordernr ten koste van honderden goede rijen — zie de
        # situatie waarin 2024-vertrek-boekingen zonder enige excursie-rij in de DB
        # belandden ondanks een gevulde Excursies-sheet).
        proceed_excursies = bool(
            excursies_status
            and excursies_status.found
            and (excursies_status.valid or excursies_status.rows_count > 0)
        )
        if proceed_excursies and excursies_status:
            logger.info(
                "upload_id=%s start excursies upsert sheet=%s rows_parsed=%d parse_errors=%d",
                upload_id,
                excursies_status.sheet_name,
                excursies_status.rows_count,
                len(excursies_status.errors or []),
            )
            if excursies_status.errors:
                err_count = len(excursies_status.errors)
                sample = "; ".join(excursies_status.errors[:3])
                warnings.append(
                    f"Excursies: {err_count} rij(en) konden niet worden geparseerd en zijn overgeslagen. "
                    f"Voorbeeld: {sample}"
                )
            upsert_excursies_relations(
                supabase=supabase,
                excursion_rows=excursion_rows,
                booking_map=booking_map,
                booking_ids=booking_ids,
                parse_errors=parse_errors,
                warnings=warnings,
                upload_id=upload_id,
            )
            logger.info("upload_id=%s excursions replace done", upload_id)
        else:
            logger.warning(
                "upload_id=%s excursions skipped found=%s valid=%s rows=%s errors=%s",
                upload_id,
                bool(excursies_status and excursies_status.found),
                bool(excursies_status and excursies_status.valid),
                (excursies_status.rows_count if excursies_status else 0),
                (excursies_status.errors if excursies_status else []),
            )
            if excursies_status and excursies_status.found and excursies_status.rows_count == 0:
                err_count = len(excursies_status.errors or [])
                sample = "; ".join((excursies_status.errors or [])[:3])
                warnings.append(
                    f"Excursies-sheet '{excursies_status.sheet_name}' bevat geen importeerbare rijen "
                    f"(parse-errors: {err_count}). Voorbeeld: {sample or 'geen'}"
                )
            elif excursies_status and not excursies_status.found:
                warnings.append(
                    "Excursies-sheet niet gevonden in dit Excelbestand "
                    "(verwachte naam bevat 'Excursies' of 'Excursions')."
                )
    except SupabaseServiceError as exc:
        logger.exception("upload_id=%s excursies failed: %s", upload_id, exc)
        return UploadResult(
            success=False,
            message="Upload mislukt tijdens excursies import.",
            warnings=[],
            errors=[],
            bookings_count=0,
            upload_id=upload_id,
            counts={},
            debug={"parse_errors_count": len(parse_errors), "technical_warnings_count": len(warnings)},
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("upload_id=%s excursies crashed: %s", upload_id, exc)
        return UploadResult(
            success=False,
            message="Upload mislukt tijdens excursies import (serverfout).",
            warnings=[],
            errors=[],
            bookings_count=0,
            upload_id=upload_id,
            counts={},
            debug={"parse_errors_count": len(parse_errors), "technical_warnings_count": len(warnings)},
        )

    try:
        addons_status = sheet_statuses.get("addons")
        if addons_status and addons_status.found and addons_status.valid:
            logger.info("upload_id=%s start addons upsert", upload_id)
            upsert_addons_relations(
                supabase=supabase,
                addon_rows=addon_rows,
                booking_map=booking_map,
                booking_ids=booking_ids,
                parse_errors=parse_errors,
                warnings=warnings,
            )
            logger.info("upload_id=%s addons upsert done", upload_id)
        else:
            logger.warning(
                "upload_id=%s addons skipped found=%s valid=%s errors=%s",
                upload_id,
                bool(addons_status and addons_status.found),
                bool(addons_status and addons_status.valid),
                (addons_status.errors if addons_status else []),
            )
    except SupabaseServiceError as exc:
        logger.exception("upload_id=%s addons failed: %s", upload_id, exc)
        return UploadResult(
            success=False,
            message="Upload mislukt tijdens addons import.",
            warnings=[],
            errors=[],
            bookings_count=0,
            upload_id=upload_id,
            counts={},
            debug={"parse_errors_count": len(parse_errors), "technical_warnings_count": len(warnings)},
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("upload_id=%s addons crashed: %s", upload_id, exc)
        return UploadResult(
            success=False,
            message="Upload mislukt tijdens addons import (serverfout).",
            warnings=[],
            errors=[],
            bookings_count=0,
            upload_id=upload_id,
            counts={},
            debug={"parse_errors_count": len(parse_errors), "technical_warnings_count": len(warnings)},
        )

    optional_parts_skipped = False
    excursies_status = sheet_statuses.get("excursies")
    addons_status = sheet_statuses.get("addons")
    flights_status = sheet_statuses.get("flights")
    if excursies_status and excursies_status.found and not excursies_status.valid:
        optional_parts_skipped = True
    if addons_status and addons_status.found and not addons_status.valid:
        optional_parts_skipped = True
    if flights_status and flights_status.found and not flights_status.valid:
        optional_parts_skipped = True

    user_warnings = ["Sommige optionele onderdelen zijn overgeslagen."] if optional_parts_skipped else []
    debug_details = {
        "parse_errors_count": len(parse_errors),
        "technical_warnings_count": len(warnings),
        "sheet_statuses": {k: vars(v) for k, v in sheet_statuses.items()},
    }
    logger.info(
        "upload_id=%s final_status=success warnings=%d parse_errors=%d",
        upload_id,
        len(warnings),
        len(parse_errors),
    )
    return UploadResult(
        success=True,
        message=("Upload geslaagd." if len(bookings) == 0 else f"Upload geslaagd. {len(bookings)} boekingen geïmporteerd."),
        errors=[],
        warnings=user_warnings,
        bookings_count=len(bookings),
        upload_id=upload_id,
        counts=booking_counts if "booking_counts" in locals() else {},
        debug=debug_details,
    )


def verwerk_vlucht_allotments_excel(
    *,
    file_bytes: bytes,
    filename: str,
    size_bytes: int,
    content_type: str | None = None,
) -> UploadResult:
    validation = validate_filename(filename, size_bytes, content_type=content_type)
    upload_id = f"proc-{uuid4()}"
    if not validation.ok:
        return UploadResult(
            success=False,
            message="Upload mislukt.",
            errors=[validation.error or "Ongeldig bestand."],
            warnings=[],
            bookings_count=0,
            upload_id=upload_id,
            counts={},
        )
    if not is_probably_xlsx(file_bytes):
        return UploadResult(
            success=False,
            message="Upload mislukt.",
            errors=["Bestandsinhoud is geen geldig .xlsx-formaat."],
            warnings=[],
            bookings_count=0,
            upload_id=upload_id,
            counts={},
        )
    rows, errors = parse_vlucht_allotment_excel(file_bytes)
    if errors:
        return UploadResult(
            success=False,
            message="Dit lijkt geen geldig vluchtallotmentbestand met het vereiste template.",
            errors=errors[:8],
            warnings=[],
            bookings_count=0,
            upload_id=upload_id,
            counts={},
        )
    try:
        supabase = SupabaseService(timeout_seconds=_import_timeout_seconds())
        upload_id = supabase.insert_vlucht_allotment_upload(bestandsnaam=filename)
        insert_rows = [
            {
                "upload_id": upload_id,
                "arrival": r.arrival,
                "departure": r.departure,
                "agency": r.agency,
                "way": r.way,
                "total_pax": r.total_pax,
                "booked_pax": r.booked_pax,
                "still_free": r.still_free,
                "outbound_flight": r.outbound_flight,
                "inbound_flight": r.inbound_flight,
                "pp_outbound": r.pp_outbound,
                "pp_inbound": r.pp_inbound,
            }
            for r in rows
        ]
        aantal = supabase.insert_vlucht_allotments(insert_rows)
        return UploadResult(
            success=True,
            message=f"Upload geslaagd. {aantal} vluchtallotments verwerkt.",
            errors=[],
            warnings=[],
            bookings_count=0,
            upload_id=upload_id,
            counts={"vlucht_allotments_verwerkt": int(aantal)},
        )
    except SupabaseServiceError as exc:
        return UploadResult(
            success=False,
            message="Upload mislukt tijdens vluchtallotments import.",
            errors=[str(exc)],
            warnings=[],
            bookings_count=0,
            upload_id=upload_id,
            counts={},
        )

