from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from services.booking_finance_aggregate import (
    consensus_booking_date,
    consensus_booking_scalar,
    consensus_booking_text,
    sum_numeric_field,
)
from services.excel_parser import ExcelRow

_VALID_BRAND_LAND = frozenset({"BE", "NL", "IT"})


def _normalize_transport_name(raw: str | None) -> str | None:
    s = (raw or "").strip()
    if not s:
        return None
    n = s.lower()
    if any(
        k in n
        for k in (
            "vliegtuig",
            "vlucht",
            "flight",
            "plane",
            "air",
            "luchthaven",
            "airline",
            "ryanair",
            "transavia",
            "brussels airlines",
            "brussels",
            "tui",
            "tuifly",
            "klm",
            "easyjet",
            "wizz",
            "vueling",
        )
    ):
        return "vliegtuig"
    if any(k in n for k in ("bus", "coach", "autocar")):
        return "bus"
    if any(k in n for k in ("self", "eigen vervoer", "own transport", "own", "auto", "car", "self-drive", "self drive")):
        return "self"
    return "self"


def _order_alphanumeric_core(order_nummer: str | None) -> str:
    """
    Alleen letters en cijfers, in oorspronkelijke volgorde, uppercased.
    Hiermee vallen spaties, streepjes e.d. weg zonder de merk-/landprefix te breken.
    """
    if order_nummer is None:
        return ""
    return "".join(ch for ch in str(order_nummer).strip() if ch.isalnum()).upper()


def extract_brand(order_number: str | None) -> str | None:
    """
    Bepaal merk op basis van de eerste twee letters van het ordernummer (na normalisatie).

    SE → Sun Escapes, SN → Snow Escapes, RR → Road Rebels.
    """
    core = _order_alphanumeric_core(order_number)
    if len(core) < 2:
        return None
    prefix = core[:2]
    if prefix == "SE":
        return "Sun Escapes"
    if prefix == "SN":
        return "Snow Escapes"
    if prefix == "RR":
        return "Road Rebels"
    return None


def normalize_brand_land_value(raw: str | None) -> str | None:
    """
    Normaliseer een waarde uit Excel naar BE/NL/IT, of None als het geen geldige code is.
    Voorkomt dat langere teksten per ongeluk tot 'BE' worden afgekapt.
    """
    if raw is None:
        return None
    compact = "".join(ch for ch in str(raw).strip() if ch.isalnum()).upper()
    if not compact:
        return None
    if compact in _VALID_BRAND_LAND:
        return compact
    return None


def resolve_brand_land_from_excel(raw: str | None) -> str | None:
    """
    Leidt BE/NL/IT af uit expliciete landcodes in Excel óf uit 'Brand name'-achtige waarden
    (bijv. SBBE, Sunweb Belgium, …). Wordt vóór de ordernummer-heuristiek toegepast.
    """
    direct = normalize_brand_land_value(raw)
    if direct:
        return direct
    if raw is None:
        return None
    s = str(raw).strip()
    if not s:
        return None
    compact = "".join(ch for ch in s if ch.isalnum()).upper()
    low = s.lower()

    # Exportcodes (o.a. merk + land in één token, zoals SBBE = Sunweb Belgium).
    if compact.startswith("SBBE"):
        return "BE"
    if compact.startswith("SBNL"):
        return "NL"

    if "belg" in low or "belgium" in low:
        return "BE"
    if "nederland" in low or "netherlands" in low or "holland" in low:
        return "NL"
    if "italy" in low or "italia" in low or "italië" in low or "italie" in low:
        return "IT"

    return None


def extract_brand_land(order_number: str | None, existing_brand_land: str | None) -> str | None:
    """
    Prioriteit:
    1) Excel-kolom brand_land / Brand name (landcode BE/NL/IT of herkenbare merk-/landtekst)
    2) Posities 3–4 van de alfanumerieke kern van het ordernummer, alleen als BE/NL/IT
    """
    from_excel = resolve_brand_land_from_excel(existing_brand_land)
    if from_excel:
        return from_excel
    core = _order_alphanumeric_core(order_number)
    if len(core) < 4:
        return None
    cand = core[2:4]
    if cand in _VALID_BRAND_LAND:
        return cand
    return None


@dataclass(frozen=True)
class BookingImport:
    order_nummer: str
    aantal_reizigers: int

    vertrekdatum: Any
    terugkeerdatum: Any
    boekingsdatum: Any

    brand: str | None
    brand_land: str | None

    bestemming_naam: str
    accommodatie_naam: str
    accommodatie_type: str | None
    accommodatie_leverancier: str | None

    doelgroep_naam: str | None
    transport_naam: str | None

    booking_status_naam: str | None
    payment_status_naam: str | None

    totaal_te_betalen: float | None
    reeds_betaald: float | None
    nog_te_betalen: float | None
    package_prijs: float | None
    accommodatie_status_naam: str | None
    maaltijdtype: str | None
    kamer: str | None
    kamer_prijs: float | None
    opstapplaats_bus: str | None
    vertrek_bus: str | None
    retour_bus: str | None
    transfer_prijs: float | None
    bagage_prijs: float | None
    vlucht_heen_prijs: float | None
    vlucht_terug_prijs: float | None
    schoonmaakkosten_te_betalen: float | None
    waarborg_te_betalen: float | None
    waarborg_betaald: float | None
    waarborg_methode: str | None
    excursions_total: float | None
    voorschot_percentage: float | None
    voorschot: float | None
    gebruikte_kortingscode: str | None
    discount_amount: float | None
    factuur_verzonden_op: Any

    # Per Excel-rij (traveller) behorende gegevens voor latere inserts in `reizigers`.
    traveller_rows: list[ExcelRow]


def group_rows_into_bookings(
    rows: list[ExcelRow], warnings: list[str] | None = None
) -> list[BookingImport]:
    by_order: dict[str, list[ExcelRow]] = {}
    for r in rows:
        by_order.setdefault(r.order_nummer, []).append(r)

    bookings: list[BookingImport] = []

    for order_nummer, grouped_rows in by_order.items():
        aantal_reizigers = len(grouped_rows)

        def pick_first(attr: str):
            for gr in grouped_rows:
                val = getattr(gr, attr)
                if val is not None:
                    return val
            return None

        vertrekdatum = pick_first("vertrekdatum")
        terugkeerdatum = pick_first("terugkeerdatum")
        boekingsdatum = pick_first("boekingsdatum")

        bestemming_naam = pick_first("bestemming_naam")
        accommodatie_naam = pick_first("accommodatie_naam")
        accommodatie_type = pick_first("accommodatie_type")
        accommodatie_leverancier = pick_first("accommodatie_leverancier")

        doelgroep_naam = pick_first("doelgroep_naam")
        transport_naam_raw = pick_first("transport_naam")

        booking_status_naam = pick_first("booking_status_naam")
        payment_status_naam = pick_first("payment_status_naam")

        # Financiële velden per reiziger (Excel-rij): som voor bedragen die per persoon gelden.
        totaal_te_betalen = sum_numeric_field(grouped_rows, "totaal_te_betalen")
        reeds_betaald = sum_numeric_field(grouped_rows, "reeds_betaald")
        nog_te_betalen = sum_numeric_field(grouped_rows, "nog_te_betalen")
        package_prijs = sum_numeric_field(grouped_rows, "package_prijs")
        accommodatie_status_naam = pick_first("accommodatie_status_naam")
        maaltijdtype = pick_first("maaltijdtype")
        kamer = pick_first("kamer")
        kamer_prijs = pick_first("kamer_prijs")
        opstapplaats_bus = pick_first("opstapplaats_bus")
        vertrek_bus = pick_first("vertrek_bus")
        retour_bus = pick_first("retour_bus")
        transfer_prijs = sum_numeric_field(grouped_rows, "transfer_prijs")
        bagage_prijs = sum_numeric_field(grouped_rows, "bagage_prijs")
        vlucht_heen_prijs = sum_numeric_field(grouped_rows, "vlucht_heen_prijs")
        vlucht_terug_prijs = sum_numeric_field(grouped_rows, "vlucht_terug_prijs")
        transport_naam = _normalize_transport_name(transport_naam_raw)
        if not transport_naam:
            if any((opstapplaats_bus, vertrek_bus, retour_bus)):
                transport_naam = "bus"
            elif (vlucht_heen_prijs or 0) > 0 or (vlucht_terug_prijs or 0) > 0:
                transport_naam = "vliegtuig"
            else:
                # Leeg transport uit Excel krijgt default self, tenzij flight/bus-relaties later aanwezig zijn.
                transport_naam = "self"

        schoonmaakkosten_te_betalen = consensus_booking_scalar(
            grouped_rows,
            "schoonmaakkosten_te_betalen",
            order_nummer=order_nummer,
            field_label="Clean fee to pay",
            warnings=warnings,
        )
        waarborg_te_betalen = consensus_booking_scalar(
            grouped_rows,
            "waarborg_te_betalen",
            order_nummer=order_nummer,
            field_label="Warranty to pay",
            warnings=warnings,
        )
        waarborg_betaald = consensus_booking_scalar(
            grouped_rows,
            "waarborg_betaald",
            order_nummer=order_nummer,
            field_label="Warranty paid",
            warnings=warnings,
        )
        waarborg_methode = consensus_booking_text(
            grouped_rows,
            "waarborg_methode",
            order_nummer=order_nummer,
            field_label="Warranty method",
            warnings=warnings,
        )

        # `Excursions total` staat in bookings op reizigerniveau: sommeer naar boekingsniveau.
        excursions_total = sum_numeric_field(grouped_rows, "excursions_total")
        voorschot_percentage = consensus_booking_scalar(
            grouped_rows,
            "voorschot_percentage",
            order_nummer=order_nummer,
            field_label="Advance percentage",
            warnings=warnings,
        )
        voorschot = consensus_booking_scalar(
            grouped_rows,
            "voorschot",
            order_nummer=order_nummer,
            field_label="Advance",
            warnings=warnings,
        )
        gebruikte_kortingscode = consensus_booking_text(
            grouped_rows,
            "gebruikte_kortingscode",
            order_nummer=order_nummer,
            field_label="Discount code used",
            warnings=warnings,
        )
        # `Discount amount` in bookings is reiziger-georiënteerd; tel op per boeking.
        discount_amount = sum_numeric_field(grouped_rows, "discount_amount")
        factuur_verzonden_op = consensus_booking_date(
            grouped_rows,
            "factuur_verzonden_op",
            order_nummer=order_nummer,
            field_label="Invoice sent on",
            warnings=warnings,
        )

        excel_brand_land = pick_first("brand_land")

        # Minimal validity checks for storing bookings.
        if not (order_nummer and vertrekdatum and terugkeerdatum and boekingsdatum and bestemming_naam and accommodatie_naam):
            continue

        brand = extract_brand(order_nummer)
        brand_land = extract_brand_land(order_nummer, excel_brand_land)

        bookings.append(
            BookingImport(
                order_nummer=order_nummer,
                aantal_reizigers=aantal_reizigers,
                vertrekdatum=vertrekdatum,
                terugkeerdatum=terugkeerdatum,
                boekingsdatum=boekingsdatum,
                brand=brand,
                brand_land=brand_land,
                bestemming_naam=bestemming_naam,
                accommodatie_naam=accommodatie_naam,
                accommodatie_type=accommodatie_type,
                accommodatie_leverancier=accommodatie_leverancier,
                doelgroep_naam=doelgroep_naam,
                transport_naam=transport_naam,
                booking_status_naam=booking_status_naam,
                payment_status_naam=payment_status_naam,
                totaal_te_betalen=totaal_te_betalen,
                reeds_betaald=reeds_betaald,
                nog_te_betalen=nog_te_betalen,
                package_prijs=package_prijs,
                accommodatie_status_naam=accommodatie_status_naam,
                maaltijdtype=maaltijdtype,
                kamer=kamer,
                kamer_prijs=kamer_prijs,
                opstapplaats_bus=opstapplaats_bus,
                vertrek_bus=vertrek_bus,
                retour_bus=retour_bus,
                transfer_prijs=transfer_prijs,
                bagage_prijs=bagage_prijs,
                vlucht_heen_prijs=vlucht_heen_prijs,
                vlucht_terug_prijs=vlucht_terug_prijs,
                schoonmaakkosten_te_betalen=schoonmaakkosten_te_betalen,
                waarborg_te_betalen=waarborg_te_betalen,
                waarborg_betaald=waarborg_betaald,
                waarborg_methode=waarborg_methode,
                excursions_total=excursions_total,
                voorschot_percentage=voorschot_percentage,
                voorschot=voorschot,
                gebruikte_kortingscode=gebruikte_kortingscode,
                discount_amount=discount_amount,
                factuur_verzonden_op=factuur_verzonden_op,
                traveller_rows=grouped_rows,
            )
        )

    return bookings
