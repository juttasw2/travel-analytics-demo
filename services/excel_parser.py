from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable

import pandas as pd

from services.payment_reminder_mapping import map_payment_reminder_status_to_count
from services.validation import (
    is_nullish,
    normalize_text,
    parse_booking_date,
    parse_date_flexible,
    parse_optional_boolean,
    parse_optional_date,
    parse_optional_datetime,
    parse_optional_number,
    parse_periode,
    to_int,
)
from services.upload_security import (
    ADDONS_ALLOWED_COLUMNS,
    ADDONS_SHEET_ALIASES,
    BOOKINGS_ALLOWED_COLUMNS,
    BOOKINGS_SHEET_ALIASES,
    EXCURSIES_ALLOWED_COLUMNS,
    EXCURSIES_SHEET_ALIASES,
    FLIGHTS_ALLOWED_COLUMNS,
    FLIGHTS_SHEET_ALIASES,
)


@dataclass(frozen=True)
class ExcelRow:
    row_number: int
    order_nummer: str

    vertrekdatum: Any
    terugkeerdatum: Any
    boekingsdatum: Any

    # Reizigergegevens (optioneel).
    first_name: str | None
    last_name: str | None
    geboortedatum: Any | None
    geslacht: str | None
    traveller_status_naam: str | None
    collections: str | None
    uitgesloten_van_communicatie: bool | None
    stad: str | None
    provincie: str | None
    land: str | None
    brand_land: str | None
    school: str | None
    transport_status: str | None

    bestemming_naam: str
    accommodatie_naam: str
    accommodatie_type: str | None
    accommodatie_leverancier: str | None
    accommodatie_status_naam: str | None
    maaltijdtype: str | None
    kamer: str | None
    kamer_prijs: float | None

    doelgroep_naam: str | None
    transport_naam: str | None
    opstapplaats_bus: str | None
    vertrek_bus: str | None
    retour_bus: str | None

    booking_status_naam: str | None
    payment_status_naam: str | None

    totaal_te_betalen: float | None
    reeds_betaald: float | None
    nog_te_betalen: float | None
    package_prijs: float | None
    transfer_prijs: float | None
    bagage_prijs: float | None
    vlucht_heen_prijs: float | None
    vlucht_terug_prijs: float | None
    toeristenbelasting_te_betalen: float | None
    schoonmaakkosten_te_betalen: float | None
    waarborg_te_betalen: float | None
    waarborg_betaald: float | None
    waarborg_methode: str | None
    prijs_annulatieverzekering: float | None
    prijs_reisverzekering: float | None
    prijs_annulatie_en_reisverzekering: float | None
    heeft_annulatieverzekering: bool | None
    heeft_reisverzekering: bool | None
    heeft_annulatie_en_reisverzekering: bool | None
    kost_accommodatie: float | None
    kost_transport: float | None
    kost_transfer: float | None
    kost_extra_kosten: float | None
    # Som uit Excel 'Excursions total' (boeking); los van Excursions-sheet koppelingen.
    excursions_total: float | None
    voorschot_percentage: float | None
    voorschot: float | None
    aantal_voorschotbetalingsherinneringen: int
    aantal_totaalbetalingsherinneringen: int
    gebruikte_kortingscode: str | None
    discount_amount: float | None
    factuur_verzonden_op: Any | None


@dataclass(frozen=True)
class ExcursionRow:
    order_nummer: str
    first_name: str | None
    last_name: str | None
    traveller_email: str | None
    bestemming_naam: str | None
    naam: str
    type: str
    prijs: float | None
    excursie_type: str | None

    vertrekdatum: Any | None
    terugkeerdatum: Any | None

    betaling_pending: bool | None
    booking_status_naam: str | None
    traveller_status_naam: str | None
    commentaar: str | None
    betaaloptie: str | None
    mollie_betaling_id: str | None
    geboekt_in_online_account: bool | None
    datum_toegevoegd: Any | None


@dataclass(frozen=True)
class AddonRow:
    order_nummer: str
    naam: str
    prijs: float | None

    vertrekdatum: Any | None
    terugkeerdatum: Any | None

    geboekt_in_online_account: bool | None
    booking_status_naam: str | None


@dataclass(frozen=True)
class FlightRow:
    order_nummer: str | None
    transport_type: str | None
    direction: str | None
    flight_number: str | None
    airline: str | None
    departure_time: Any | None
    arrival_time: Any | None
    departure_airport: str | None
    arrival_airport: str | None
    transfer_type: str | None
    transfer_price: float | None
    baggage_price: float | None


@dataclass(frozen=True)
class SheetParseStatus:
    section: str
    sheet_name: str | None
    found: bool
    valid: bool
    rows_count: int
    errors: list[str]


def _norm_col(s: str) -> str:
    return "".join(ch.lower() for ch in s.strip() if ch.isalnum())


def _build_column_map(df: pd.DataFrame) -> dict[str, str]:
    return {_norm_col(str(c)): str(c) for c in df.columns}


def _get_column(df: pd.DataFrame, normalized: str) -> str | None:
    return _build_column_map(df).get(normalized)


def _require_column(df: pd.DataFrame, candidates: Iterable[str], missing: list[str]) -> str:
    for cand in candidates:
        col = _get_column(df, _norm_col(cand))
        if col:
            return col
    missing.append(" · ".join(candidates))
    return ""


# Vereiste periode: één kolom met "dd/mm/yyyy - dd/mm/yyyy" óf twee datumkolommen.
_PERIODE_SINGLE_CANDIDATES: list[str] = [
    "Periode",
    "Period",
    "Travel period",
    "Trip period",
    "Reisperiode",
    "Verblijfsperiode",
    "Booking period",
    "Travel dates",
    "Trip dates",
    "Stay period",
    "Holiday period",
    "Reisdatum",
    "Reisperiode boeking",
]
# Specifieke koppen voor de twee-kolom variant. Alleen ondubbelzinnige aliassen!
# (Bare 'Return'/'Departure'/'Outbound'/'Inbound'/'Van'/'Tot' zijn bewust weggelaten:
# die botsen met bus-/transportkolommen zoals 'Return', 'Departure bus', 'Outbound bus'.)
_VERTREK_CANDIDATES: list[str] = [
    "Periode heen",
    "Departure date",
    "Outbound date",
    "Vertrekdatum",
    "Datum vertrek",
    "Heenreis",
    "Heenreisdatum",
    "Datum heen",
    "Afreisdatum",
    "Start date",
    "Startdatum",
    "Begindatum",
    "From date",
    "Date from",
]
_TERUG_CANDIDATES: list[str] = [
    "Periode terug",
    "Return date",
    "Inbound date",
    "Terugkeerdatum",
    "Terugreis",
    "Terugreisdatum",
    "Datum terug",
    "Terugkomst",
    "Terugkomstdatum",
    "Aankomstdatum",
    "Datum aankomst",
    "End date",
    "Einddatum",
    "To date",
    "Date to",
]


def _read_excel_allowlist(
    file_bytes: bytes,
    *,
    sheet_name: str | None = None,
    allowed_normalized_columns: set[str] | None = None,
) -> pd.DataFrame:
    from io import BytesIO

    if sheet_name is None:
        if not allowed_normalized_columns:
            return pd.read_excel(BytesIO(file_bytes))  # type: ignore[arg-type]

        def _allow_default(col: object) -> bool:
            return _norm_col(str(col)) in allowed_normalized_columns

        return pd.read_excel(BytesIO(file_bytes), usecols=_allow_default)  # type: ignore[arg-type]

    if not allowed_normalized_columns:
        return pd.read_excel(BytesIO(file_bytes), sheet_name=sheet_name)  # type: ignore[arg-type]

    def _allow(col: object) -> bool:
        return _norm_col(str(col)) in allowed_normalized_columns

    return pd.read_excel(BytesIO(file_bytes), sheet_name=sheet_name, usecols=_allow)  # type: ignore[arg-type]


def _read_all_headers(file_bytes: bytes) -> list[str]:
    """Lees alle kolomkoppen (zonder allowlist) — alleen voor diagnostische foutmeldingen."""
    from io import BytesIO

    try:
        head = pd.read_excel(BytesIO(file_bytes), nrows=0)  # type: ignore[arg-type]
    except Exception:  # noqa: BLE001
        return []
    return [str(c) for c in head.columns]


def parse_excel_rows(file_bytes: bytes, filename: str) -> tuple[list[ExcelRow], list[str]]:
    errors: list[str] = []

    # Parse only explicitly allowed booking columns (data minimization).
    df = _read_excel_allowlist(
        file_bytes,
        allowed_normalized_columns=BOOKINGS_ALLOWED_COLUMNS,
    )

    df_columns = [str(c) for c in df.columns]
    if not df_columns:
        all_headers = _read_all_headers(file_bytes)
        if all_headers:
            return [], [
                "Excel bevat geen herkende kolommen. Gevonden koppen: "
                + ", ".join(repr(c) for c in all_headers)
            ]
        return [], ["Excel bevat geen kolommen."]

    missing: list[str] = []

    order_col = _require_column(df, ["Order number", "Order no", "Order nr", "Order", "Ordernummer"], missing)

    periode_col = _require_column(df, _PERIODE_SINGLE_CANDIDATES, [])
    vertrek_col = _require_column(df, _VERTREK_CANDIDATES, [])
    terug_col = _require_column(df, _TERUG_CANDIDATES, [])
    use_split_travel_dates = False
    if periode_col:
        pass
    elif vertrek_col and terug_col:
        use_split_travel_dates = True
    else:
        missing.append(
            "Periode · Period · Travel period … "
            "of het paar: Departure date + Return date / Vertrekdatum + Terugkeerdatum / Start date + End date"
        )

    booking_date_col = _require_column(df, ["Booking date", "Booking datum", "Boekingsdatum"], missing)
    destination_col = _require_column(df, ["Destination", "Destination name", "Bestemming", "Bestemming naam"], missing)
    accommodation_col = _require_column(
        df,
        ["Accommodation", "Accommodation name", "Accomodation", "Accomodation name", "Accommodatie", "Accommodatie naam"],
        missing,
    )

    # Bron voor `reiziger_financien.totaal_te_betalen`: de kolom 'Totaal to pay'
    # uit de 2024-export (let op: gemengd Nederlands/Engels). 'Total to pay' en
    # 'Totaal te betalen' worden als fallback ondersteund voor andere export-jaren.
    # 'To be paid' = openstaand bedrag en mapt op `nog_te_betalen` (niet op het totaal).
    totaal_te_betalen_col = _require_column(
        df,
        [
            "Totaal to pay",
            "Totaal to Pay",
            "Totaal to pay EUR",
            "Total to pay",
            "Total to Pay",
            "Total to pay EUR",
            "Totaal te betalen",
            "Totaal te betalen EUR",
        ],
        missing,
    )
    total_to_pay_col = totaal_te_betalen_col
    required_ok = all([order_col, booking_date_col, destination_col, accommodation_col, totaal_te_betalen_col]) and (
        periode_col or use_split_travel_dates
    )
    if not required_ok:
        all_headers = _read_all_headers(file_bytes)
        # Toon onherkende koppen (in originele Excel maar buiten onze allowlist)
        recognized_norm = {_norm_col(c) for c in df_columns}
        unrecognized = [c for c in all_headers if _norm_col(c) not in recognized_norm]
        diag_parts: list[str] = []
        if df_columns:
            diag_parts.append(f"Herkende koppen: {', '.join(repr(c) for c in df_columns)}")
        if unrecognized:
            diag_parts.append(
                f"Niet-herkende koppen (genegeerd): {', '.join(repr(c) for c in unrecognized)}"
            )
        diag = " — " + " · ".join(diag_parts) if diag_parts else ""
        errors.append(
            "Ontbrekende vereiste kolommen in Excel. Controleer de koppen. "
            "Vereist: Order number/Order nr; "
            "Periode/Period (of Travel period, enz.) óf twee kolommen Departure date + Return date (of Vertrekdatum + Terugkeerdatum); "
            "Booking date/Boekingsdatum; Destination/Bestemming; Accommodation/Accommodatie; "
            "Totaal to pay (of Total to pay/Totaal te betalen). "
            f"Ontbrekend(er): {', '.join(missing) if missing else 'onbekend'}"
            + diag
        )
        return [], errors

    # Optional columns (best-effort)
    def opt(cands: list[str]) -> str | None:
        c = _require_column(df, cands, [])
        return c or None

    accommodation_type_col = opt(["Accommodation type"])
    accommodation_supplier_col = opt(["Accommodation supplier"])
    target_audience_col = opt(["Target audience"])
    transport_col = opt(["Transport"])
    booking_status_col = opt(["Booking status"])
    payment_status_col = opt(["Payment status"])

    # Required (validated above) but keep fallback lookup robust if header variants differ.
    total_to_pay_col = total_to_pay_col or opt(
        [
            "Totaal to pay", "Totaal to Pay", "Totaal to pay EUR",
            "Total to pay", "Total to Pay", "Total to pay EUR",
            "Totaal te betalen", "Totaal te betalen EUR",
        ]
    )
    paid_so_far_col = opt(["Paid so far", "Paid so Far"])
    # 'To be paid' = openstaand bedrag → mapt op `nog_te_betalen` (apart van het totaal).
    to_be_paid_col = opt(["To be paid", "To be Paid"])
    package_price_col = opt(["Package price", "Package Price"])
    transfer_price_col = opt(["Transfer Price"])
    baggage_price_col = opt(["Baggage Price"])
    flight_to_price_col = opt(["Flight To Price"])
    flight_from_price_col = opt(["Flight From Price"])
    tourist_tax_col = opt(["Tourist tax to pay"])
    clean_fee_col = opt(["Clean fee to pay"])
    warranty_to_pay_col = opt(["Warranty to pay"])
    warranty_paid_col = opt(["Warranty paid"])
    warranty_method_col = opt(["Warranty method"])
    annulation_price_col = opt(["Price annulation insurance"])
    travel_price_col = opt(["Price travel insurance"])
    annulation_travel_price_col = opt(["Price annulation and travel insurances"])
    has_annulation_col = opt(["Has annulation insurance"])
    has_travel_col = opt(["Has travel insurance"])
    has_annulation_travel_col = opt(["Has annulation and travel insurances"])
    cost_accommodation_col = opt(["Cost Accommodation"])
    cost_transport_col = opt(["Cost transport"])
    cost_transfer_col = opt(["Cost transfer"])
    cost_extra_col = opt(["Cost extra charges"])
    excursions_total_col = opt(["Excursions total", "Excursions Total"])
    advance_percentage_col = opt(["Advance percentage"])
    advance_col = opt(["Advance"])
    advance_reminders_col = opt(["Advance payment reminders"])
    total_reminders_col = opt(["Total payment reminders"])
    discount_code_col = opt(["Discount code used"])
    discount_amount_col = opt(["Discount amount"])
    invoice_sent_col = opt(["Invoice sent on", "Invoice sent"])

    collections_col = opt(["Collections"])
    exclude_communication_col = opt(["Exclude from communcations", "Exclude from communications"])
    city_col = opt(["City"])
    province_col = opt(["Province"])
    country_col = opt(["Country"])
    brand_land_col = opt(["brand_land", "Brand land", "Brand Land"])
    brand_name_col = opt(["Brand name", "Brand Name", "brand name", "Brandname"])
    school_col = opt(["School"])
    transport_status_col = opt(["Transport status", "Transport Status", "transport status"])

    acco_status_col = opt(["Acco status"])
    meal_type_col = opt(["Meal type"])
    room_col = opt(["Room"])
    room_price_col = opt(["Room price"])
    bus_stop_col = opt(["Bus stop"])
    departure_bus_col = opt(["Departure bus"])
    return_bus_col = opt(["Return bus"])

    geboortedatum_col = opt(["Date of birth", "Geboortedatum", "Date of Birth", "Datum geboorte", "DoB"])
    geslacht_col = opt(["Gender", "Geslacht", "Geslacht (M/V)", "Sex"])
    first_name_col = opt(["First name", "First Name", "Voornaam"])
    last_name_col = opt(["Last name", "Last Name", "Achternaam"])
    traveller_status_col = opt([
        "Traveller status",
        "Traveller Status",
        "Reiziger status",
        "Reiziger Status",
        "Traveller state",
        "Reiziger status naam",
    ])

    out: list[ExcelRow] = []

    def parse_optional_float(row: pd.Series, col_name: str | None, excel_label: str, row_number: int) -> float | None:
        if not col_name:
            return None
        raw = row.get(col_name)
        val = parse_optional_number(raw)
        if not is_nullish(raw) and val is None:
            errors.append(f"Rij {row_number}: ongeldige waarde voor '{excel_label}' — veld op NULL gezet.")
            return None
        return val

    def parse_optional_int(row: pd.Series, col_name: str | None, excel_label: str, row_number: int) -> int | None:
        if not col_name:
            return None
        raw = row.get(col_name)
        val = to_int(raw)
        if not is_nullish(raw) and val is None:
            errors.append(f"Rij {row_number}: ongeldige waarde voor '{excel_label}' — veld op NULL gezet.")
            return None
        return val

    def parse_optional_bool(row: pd.Series, col_name: str | None, excel_label: str, row_number: int) -> bool | None:
        if not col_name:
            return None
        raw = row.get(col_name)
        val = parse_optional_boolean(raw)
        if not is_nullish(raw) and val is None:
            errors.append(f"Rij {row_number}: ongeldige waarde voor '{excel_label}' — veld op NULL gezet.")
            return None
        return val

    for idx, row in df.iterrows():
        row_number = idx + 2  # likely header at row 1

        order_nummer_raw = normalize_text(row.get(order_col))
        if not order_nummer_raw:
            errors.append(f"Rij {row_number}: ontbrekende 'Order number' — overgeslagen.")
            continue

        if use_split_travel_dates:
            vertrekdatum = parse_booking_date(row.get(vertrek_col))
            terugkeerdatum = parse_booking_date(row.get(terug_col))
            if not vertrekdatum or not terugkeerdatum:
                errors.append(
                    f"Rij {row_number}: ongeldige vertrek- of terugkeerdatum "
                    f"(kolommen '{vertrek_col}' / '{terug_col}') — overgeslagen."
                )
                continue
        else:
            periode_parsed = parse_periode(row.get(periode_col))
            if not periode_parsed:
                errors.append(
                    f"Rij {row_number}: ongeldige 'Periode' (verwacht dd/mm/yyyy - dd/mm/yyyy) — overgeslagen."
                )
                continue
            vertrekdatum, terugkeerdatum = periode_parsed

        boekingsdatum = parse_booking_date(row.get(booking_date_col))
        if not boekingsdatum:
            errors.append(f"Rij {row_number}: ongeldige 'Booking date' — overgeslagen.")
            continue

        geboortedatum = parse_date_flexible(row.get(geboortedatum_col)) if geboortedatum_col else None
        geslacht = normalize_text(row.get(geslacht_col)) if geslacht_col else None
        first_name = normalize_text(row.get(first_name_col)) if first_name_col else None
        last_name = normalize_text(row.get(last_name_col)) if last_name_col else None
        traveller_status_naam = normalize_text(row.get(traveller_status_col)) if traveller_status_col else None
        collections = normalize_text(row.get(collections_col)) if collections_col else None
        uitgesloten_van_communicatie = parse_optional_bool(
            row, exclude_communication_col, "Exclude from communications", row_number
        )
        stad = normalize_text(row.get(city_col)) if city_col else None
        provincie = normalize_text(row.get(province_col)) if province_col else None
        land = normalize_text(row.get(country_col)) if country_col else None
        land_raw = normalize_text(row.get(brand_land_col)) if brand_land_col else None
        name_raw = normalize_text(row.get(brand_name_col)) if brand_name_col else None
        brand_land = land_raw or name_raw or None
        school = normalize_text(row.get(school_col)) if school_col else None
        transport_status = normalize_text(row.get(transport_status_col)) if transport_status_col else None
        if transport_status:
            transport_status = transport_status.lower()

        bestemming_naam_raw = normalize_text(row.get(destination_col))
        if not bestemming_naam_raw:
            errors.append(f"Rij {row_number}: ontbrekende 'Destination' — overgeslagen.")
            continue

        accommodatie_naam_raw = normalize_text(row.get(accommodation_col))
        if not accommodatie_naam_raw:
            errors.append(f"Rij {row_number}: ontbrekende 'Accommodation' — overgeslagen.")
            continue

        accommodatie_type = normalize_text(row.get(accommodation_type_col)) if accommodation_type_col else None
        accommodatie_supplier = normalize_text(row.get(accommodation_supplier_col)) if accommodation_supplier_col else None
        acco_status_val = normalize_text(row.get(acco_status_col)) if acco_status_col else None
        # Excel "Acco status" = leverancier op accommodaties.leverancier (niet: statussen.accommodatie).
        # Fallback: kolom "Accommodation supplier" voor oudere sheets zonder Acco status.
        accommodatie_leverancier = acco_status_val or accommodatie_supplier
        # Geen aparte accommodatie-boekingstatus meer uit Acco status (die kolom is leverancier-label).
        accommodatie_status_naam = None
        maaltijdtype = normalize_text(row.get(meal_type_col)) if meal_type_col else None
        kamer = normalize_text(row.get(room_col)) if room_col else None
        kamer_prijs = parse_optional_float(row, room_price_col, "Room price", row_number)

        doelgroep_naam = normalize_text(row.get(target_audience_col)) if target_audience_col else None
        transport_naam = normalize_text(row.get(transport_col)) if transport_col else None
        opstapplaats_bus = normalize_text(row.get(bus_stop_col)) if bus_stop_col else None
        vertrek_bus = normalize_text(row.get(departure_bus_col)) if departure_bus_col else None
        retour_bus = normalize_text(row.get(return_bus_col)) if return_bus_col else None

        booking_status_naam = normalize_text(row.get(booking_status_col)) if booking_status_col else None
        payment_status_naam = normalize_text(row.get(payment_status_col)) if payment_status_col else None

        # `totaal_te_betalen` (reiziger_financien): kolom 'Totaal to pay' (2024-export),
        # met fallback op 'Total to pay' / 'Totaal te betalen'. NIET 'To be paid'.
        totaal_te_betalen = parse_optional_float(
            row, totaal_te_betalen_col, "Totaal to pay / Total to pay", row_number
        )
        reeds_betaald = parse_optional_float(row, paid_so_far_col, "Paid so far", row_number)
        # `nog_te_betalen` = 'To be paid' (openstaand bedrag). Apart van `totaal_te_betalen`.
        if to_be_paid_col:
            nog_te_betalen = parse_optional_float(row, to_be_paid_col, "To be paid", row_number)
        else:
            nog_te_betalen = None
        package_prijs = parse_optional_float(row, package_price_col, "Package price", row_number)
        transfer_prijs = parse_optional_float(row, transfer_price_col, "Transfer Price", row_number)
        bagage_prijs = parse_optional_float(row, baggage_price_col, "Baggage Price", row_number)
        vlucht_heen_prijs = parse_optional_float(row, flight_to_price_col, "Flight To Price", row_number)
        vlucht_terug_prijs = parse_optional_float(row, flight_from_price_col, "Flight From Price", row_number)
        toeristenbelasting_te_betalen = parse_optional_float(
            row, tourist_tax_col, "Tourist tax to pay", row_number
        )
        schoonmaakkosten_te_betalen = parse_optional_float(row, clean_fee_col, "Clean fee to pay", row_number)
        waarborg_te_betalen = parse_optional_float(row, warranty_to_pay_col, "Warranty to pay", row_number)
        waarborg_betaald = parse_optional_float(row, warranty_paid_col, "Warranty paid", row_number)
        prijs_annulatieverzekering = parse_optional_float(
            row, annulation_price_col, "Price annulation insurance", row_number
        )
        prijs_reisverzekering = parse_optional_float(
            row, travel_price_col, "Price travel insurance", row_number
        )
        prijs_annulatie_en_reisverzekering = parse_optional_float(
            row, annulation_travel_price_col, "Price annulation and travel insurances", row_number
        )
        kost_accommodatie = parse_optional_float(row, cost_accommodation_col, "Cost Accommodation", row_number)
        kost_transport = parse_optional_float(row, cost_transport_col, "Cost transport", row_number)
        kost_transfer = parse_optional_float(row, cost_transfer_col, "Cost transfer", row_number)
        kost_extra_kosten = parse_optional_float(row, cost_extra_col, "Cost extra charges", row_number)
        excursions_total = parse_optional_float(row, excursions_total_col, "Excursions total", row_number)
        voorschot_percentage = parse_optional_float(row, advance_percentage_col, "Advance percentage", row_number)
        voorschot = parse_optional_float(row, advance_col, "Advance", row_number)

        waarborg_methode = normalize_text(row.get(warranty_method_col)) if warranty_method_col else None
        heeft_annulatieverzekering = parse_optional_bool(
            row, has_annulation_col, "Has annulation insurance", row_number
        )
        heeft_reisverzekering = parse_optional_bool(
            row, has_travel_col, "Has travel insurance", row_number
        )
        heeft_annulatie_en_reisverzekering = parse_optional_bool(
            row, has_annulation_travel_col, "Has annulation and travel insurances", row_number
        )
        raw_adv = row.get(advance_reminders_col) if advance_reminders_col else None
        raw_tot = row.get(total_reminders_col) if total_reminders_col else None
        aantal_voorschotbetalingsherinneringen = map_payment_reminder_status_to_count(
            raw_adv, context=f"Rij {row_number}: Advance payment reminders"
        )
        aantal_totaalbetalingsherinneringen = map_payment_reminder_status_to_count(
            raw_tot, context=f"Rij {row_number}: Total payment reminders"
        )
        gebruikte_kortingscode = normalize_text(row.get(discount_code_col)) if discount_code_col else None
        discount_amount = parse_optional_float(row, discount_amount_col, "Discount amount", row_number)
        factuur_verzonden_op = parse_optional_date(row.get(invoice_sent_col)) if invoice_sent_col else None

        out.append(
            ExcelRow(
                row_number=row_number,
                order_nummer=order_nummer_raw,
                vertrekdatum=vertrekdatum,
                terugkeerdatum=terugkeerdatum,
                boekingsdatum=boekingsdatum,
                first_name=first_name,
                last_name=last_name,
                geboortedatum=geboortedatum,
                geslacht=geslacht,
                traveller_status_naam=traveller_status_naam,
                collections=collections,
                uitgesloten_van_communicatie=uitgesloten_van_communicatie,
                stad=stad,
                provincie=provincie,
                land=land,
                brand_land=brand_land,
                school=school,
                transport_status=transport_status,
                bestemming_naam=bestemming_naam_raw,
                accommodatie_naam=accommodatie_naam_raw,
                accommodatie_type=accommodatie_type,
                accommodatie_leverancier=accommodatie_leverancier,
                accommodatie_status_naam=accommodatie_status_naam,
                maaltijdtype=maaltijdtype,
                kamer=kamer,
                kamer_prijs=kamer_prijs,
                doelgroep_naam=doelgroep_naam,
                transport_naam=transport_naam,
                opstapplaats_bus=opstapplaats_bus,
                vertrek_bus=vertrek_bus,
                retour_bus=retour_bus,
                booking_status_naam=booking_status_naam,
                payment_status_naam=payment_status_naam,
                totaal_te_betalen=totaal_te_betalen,
                reeds_betaald=reeds_betaald,
                nog_te_betalen=nog_te_betalen,
                package_prijs=package_prijs,
                transfer_prijs=transfer_prijs,
                bagage_prijs=bagage_prijs,
                vlucht_heen_prijs=vlucht_heen_prijs,
                vlucht_terug_prijs=vlucht_terug_prijs,
                toeristenbelasting_te_betalen=toeristenbelasting_te_betalen,
                schoonmaakkosten_te_betalen=schoonmaakkosten_te_betalen,
                waarborg_te_betalen=waarborg_te_betalen,
                waarborg_betaald=waarborg_betaald,
                waarborg_methode=waarborg_methode,
                prijs_annulatieverzekering=prijs_annulatieverzekering,
                prijs_reisverzekering=prijs_reisverzekering,
                prijs_annulatie_en_reisverzekering=prijs_annulatie_en_reisverzekering,
                heeft_annulatieverzekering=heeft_annulatieverzekering,
                heeft_reisverzekering=heeft_reisverzekering,
                heeft_annulatie_en_reisverzekering=heeft_annulatie_en_reisverzekering,
                kost_accommodatie=kost_accommodatie,
                kost_transport=kost_transport,
                kost_transfer=kost_transfer,
                kost_extra_kosten=kost_extra_kosten,
                excursions_total=excursions_total,
                voorschot_percentage=voorschot_percentage,
                voorschot=voorschot,
                aantal_voorschotbetalingsherinneringen=aantal_voorschotbetalingsherinneringen,
                aantal_totaalbetalingsherinneringen=aantal_totaalbetalingsherinneringen,
                gebruikte_kortingscode=gebruikte_kortingscode,
                discount_amount=discount_amount,
                factuur_verzonden_op=factuur_verzonden_op,
            )
        )

    return out, errors


def parse_excursies_sheet(file_bytes: bytes, *, sheet_name: str = "Excursies") -> tuple[list[ExcursionRow], list[str]]:
    errors: list[str] = []
    df = _read_excel_allowlist(
        file_bytes,
        sheet_name=sheet_name,
        allowed_normalized_columns=EXCURSIES_ALLOWED_COLUMNS,
    )

    missing: list[str] = []
    order_col = _require_column(df, ["Order number", "Order nr", "Order no", "Order"], missing)
    naam_col = _require_column(
        df,
        ["Name", "Excursion name", "Excursienaam", "Excursie", "Excursie naam", "Excursienaam (NL)"],
        missing,
    )
    vertrek_col = _require_column(df, ["Departure date", "Vertrekdatum", "Vertrek datum", "Datum vertrek", "Vertrek"], missing)
    terug_col = _require_column(df, ["Return date", "Terugkeerdatum", "Terugkeer datum", "Datum terugkeer", "Terugkeer"], missing)

    # Optional columns (best-effort)
    def opt(cands: list[str]) -> str | None:
        for cand in cands:
            col = _get_column(df, _norm_col(cand))
            if col:
                return col
        return None

    type_col = opt(["Type", "Excursion type group", "Excursie type", "Excursietype", "Excursie Type", "Excursie type groep"])
    first_name_col = opt(["First name", "First Name", "Voornaam"])
    last_name_col = opt(["Last name", "Last Name", "Achternaam"])
    traveller_email_col = opt(["Traveller email", "Traveler email", "E-mail", "Email"])
    bestemming_col = opt(["Destination", "Bestemming", "Destination name", "Bestemming naam"])
    prijs_col = opt(["Price", "Prijs", "Price (EUR)", "Prijs (EUR)", "Kostprijs", "Prijs per persoon"])
    excursie_type_col = opt(["Excursion type", "excursie_type", "Excursietype"])
    betaling_pending_col = opt(["Is payment pending", "Payment pending", "Betaling pending"])
    booking_status_col = opt(["Booking status", "Boeking status"])
    traveller_status_col = opt(["Traveller status", "Traveler status", "Reiziger status", "Reiziger status naam"])
    commentaar_col = opt(["Comment", "Commentaar", "Opmerking"])
    betaaloptie_col = opt(["Payment option", "Betaaloptie"])
    mollie_id_col = opt(["Mollie payment ID", "Mollie betaling ID", "Mollie paymentId"])
    geboekt_col = opt(["Booked in online account", "Geplaatst in online account", "Boekingen online account"])
    datum_toegevoegd_col = opt(["Date added", "Datum toegevoegd"])

    if not order_col or not naam_col or not vertrek_col or not terug_col:
        errors.append(f"Excursies-sheet: ontbrekende vereiste kolommen: {', '.join(missing) if missing else 'onbekend'}")
        return [], errors

    out: list[ExcursionRow] = []
    for idx, row in df.iterrows():
        row_number = idx + 2
        order_nummer_raw = normalize_text(row.get(order_col))
        if not order_nummer_raw:
            errors.append(f"Excursies: rij {row_number}: ontbrekende 'Order number' — overgeslagen.")
            continue

        naam = normalize_text(row.get(naam_col))
        type_ = normalize_text(row.get(type_col)) if type_col else None
        first_name = normalize_text(row.get(first_name_col)) if first_name_col else None
        last_name = normalize_text(row.get(last_name_col)) if last_name_col else None
        traveller_email = normalize_text(row.get(traveller_email_col)) if traveller_email_col else None
        bestemming_naam = normalize_text(row.get(bestemming_col)) if bestemming_col else None
        if not naam:
            errors.append(f"Excursies: rij {row_number}: ontbrekende 'Name' — overgeslagen.")
            continue

        vertrekdatum = parse_booking_date(row.get(vertrek_col))
        terugkeerdatum = parse_booking_date(row.get(terug_col))
        if not vertrekdatum or not terugkeerdatum:
            errors.append(f"Excursies: rij {row_number}: ongeldige vertrek/terugkeerdatum — overgeslagen.")
            continue

        prijs = parse_optional_number(row.get(prijs_col)) if prijs_col else None
        excursie_type = normalize_text(row.get(excursie_type_col)) if excursie_type_col else None

        betaling_pending = parse_optional_boolean(row.get(betaling_pending_col)) if betaling_pending_col else None
        booking_status_naam = normalize_text(row.get(booking_status_col)) if booking_status_col else None
        traveller_status_naam = normalize_text(row.get(traveller_status_col)) if traveller_status_col else None
        commentaar = normalize_text(row.get(commentaar_col)) if commentaar_col else None
        betaaloptie = normalize_text(row.get(betaaloptie_col)) if betaaloptie_col else None
        mollie_betaling_id = normalize_text(row.get(mollie_id_col)) if mollie_id_col else None
        geboekt_in_online_account = parse_optional_boolean(row.get(geboekt_col)) if geboekt_col else None
        datum_toegevoegd = parse_booking_date(row.get(datum_toegevoegd_col)) if datum_toegevoegd_col else None

        out.append(
            ExcursionRow(
                order_nummer=order_nummer_raw,
                first_name=first_name,
                last_name=last_name,
                traveller_email=traveller_email,
                bestemming_naam=bestemming_naam,
                naam=naam,
                type=type_ or "Algemeen",
                prijs=prijs,
                excursie_type=excursie_type,
                vertrekdatum=vertrekdatum,
                terugkeerdatum=terugkeerdatum,
                betaling_pending=betaling_pending,
                booking_status_naam=booking_status_naam,
                traveller_status_naam=traveller_status_naam,
                commentaar=commentaar,
                betaaloptie=betaaloptie,
                mollie_betaling_id=mollie_betaling_id,
                geboekt_in_online_account=geboekt_in_online_account,
                datum_toegevoegd=datum_toegevoegd,
            )
        )

    return out, errors


def parse_addons_sheet(file_bytes: bytes, *, sheet_name: str = "Addons") -> tuple[list[AddonRow], list[str]]:
    errors: list[str] = []
    df = _read_excel_allowlist(
        file_bytes,
        sheet_name=sheet_name,
        allowed_normalized_columns=ADDONS_ALLOWED_COLUMNS,
    )

    missing: list[str] = []
    order_col = _require_column(df, ["Order number", "Order nr", "Order no", "Order"], missing)
    naam_col = _require_column(df, ["Name", "Addon name", "Addon", "Add-on", "Addon naam", "Add-on naam"], missing)
    prijs_col = _require_column(df, ["Price", "Prijs", "Price (EUR)", "Prijs (EUR)", "Kostprijs", "Prijs per persoon"], missing)

    # Dates zijn (in jouw schema) niet 'not null', dus we maken ze optioneel:
    # als de headernaam niet exact matcht, verhinderen we niet dat addons alsnog opgeslagen worden.
    vertrek_candidates = ["Departure date", "Vertrekdatum", "Vertrek datum", "Datum vertrek", "Vertrek"]
    terug_candidates = ["Return date", "Terugkeerdatum", "Terugkeer datum", "Datum terugkeer", "Terugkeer"]

    def _pick_optional(cands: list[str]) -> str | None:
        for cand in cands:
            col = _get_column(df, _norm_col(cand))
            if col:
                return col
        return None

    vertrek_col = _pick_optional(vertrek_candidates)
    terug_col = _pick_optional(terug_candidates)

    def opt(cands: list[str]) -> str | None:
        for cand in cands:
            col = _get_column(df, _norm_col(cand))
            if col:
                return col
        return None

    geboekt_col = opt(["Booked in online account", "Boekingen online account", "Boekingen online", "Geplaatst in online account"])
    booking_status_col = opt(["Booking status", "Boeking status", "Booking status naam"])

    if not order_col or not naam_col or not prijs_col:
        errors.append(
            f"Addons-sheet: ontbrekende vereiste kolommen: {', '.join(missing) if missing else 'onbekend'}"
        )
        return [], errors

    if not vertrek_col or not terug_col:
        errors.append(
            "Addons-sheet: vertrekdatum/terugkeerdatum kolommen niet volledig gematcht; "
            "we zetten deze velden op NULL als ze ontbreken."
        )

    out: list[AddonRow] = []
    for idx, row in df.iterrows():
        row_number = idx + 2
        order_nummer_raw = normalize_text(row.get(order_col))
        if not order_nummer_raw:
            errors.append(f"Addons: rij {row_number}: ontbrekende 'Order number' — overgeslagen.")
            continue

        naam = normalize_text(row.get(naam_col))
        if not naam:
            errors.append(f"Addons: rij {row_number}: ontbrekende 'Name' — overgeslagen.")
            continue

        vertrekdatum = parse_booking_date(row.get(vertrek_col)) if vertrek_col else None
        terugkeerdatum = parse_booking_date(row.get(terug_col)) if terug_col else None
        if not vertrekdatum or not terugkeerdatum:
            # Als dates kolommen ontbreken (None) willen we geen volledige rij skippen.
            if vertrek_col and terug_col:
                errors.append(f"Addons: rij {row_number}: ongeldige vertrek/terugkeerdatum — overgeslagen.")
                continue

        prijs = parse_optional_number(row.get(prijs_col))
        geboekt_in_online_account = parse_optional_boolean(row.get(geboekt_col)) if geboekt_col else None
        booking_status_naam = normalize_text(row.get(booking_status_col)) if booking_status_col else None

        out.append(
            AddonRow(
                order_nummer=order_nummer_raw,
                naam=naam,
                prijs=prijs,
                vertrekdatum=vertrekdatum,
                terugkeerdatum=terugkeerdatum,
                geboekt_in_online_account=geboekt_in_online_account,
                booking_status_naam=booking_status_naam,
            )
        )

    return out, errors


def parse_flights_sheet(file_bytes: bytes, *, sheet_name: str = "Flights") -> tuple[list[FlightRow], list[str]]:
    errors: list[str] = []
    df = _read_excel_allowlist(
        file_bytes,
        sheet_name=sheet_name,
        allowed_normalized_columns=FLIGHTS_ALLOWED_COLUMNS,
    )

    missing: list[str] = []
    order_col = _require_column(df, ["Order number"], missing)

    def opt(cands: list[str]) -> str | None:
        for cand in cands:
            col = _get_column(df, _norm_col(cand))
            if col:
                return col
        return None

    transport_col = opt(["Transport type", "Transport", "Vervoer", "Transportnaam", "Transporten", "Flight transport"])
    direction_col = opt(["direction", "Direction", "Richting"])
    flight_number_col = opt(["Flight number", "Vluchtnummer"])
    airline_col = opt(["Airline", "Maatschappij", "Luchtvaartmaatschappij", "Carrier", "Vluchtmaatschappij"])
    departure_time_col = opt(["Departure time", "Vertrektijd"])
    arrival_time_col = opt(["Arrival time", "Aankomsttijd"])
    departure_airport_col = opt(["Departure airport", "Vertrekluchthaven"])
    arrival_airport_col = opt(["Arrival airport", "Aankomstluchthaven"])
    transfer_type_col = opt(["Transfer Type", "Transfer type"])
    transfer_price_col = opt(["Transfer Price"])
    baggage_price_col = opt(["Baggage Price"])

    if not order_col:
        errors.append(f"Flights-sheet: ontbrekende 'Order number' kolom.")
        return [], errors

    out: list[FlightRow] = []
    for idx, row in df.iterrows():
        row_number = idx + 2
        order_nummer_raw = normalize_text(row.get(order_col))
        transport_type = normalize_text(row.get(transport_col)) if transport_col else None
        direction = normalize_text(row.get(direction_col)) if direction_col else None
        flight_number = normalize_text(row.get(flight_number_col)) if flight_number_col else None
        airline = normalize_text(row.get(airline_col)) if airline_col else None
        departure_time = parse_optional_datetime(row.get(departure_time_col)) if departure_time_col else None
        arrival_time = parse_optional_datetime(row.get(arrival_time_col)) if arrival_time_col else None
        departure_airport = normalize_text(row.get(departure_airport_col)) if departure_airport_col else None
        arrival_airport = normalize_text(row.get(arrival_airport_col)) if arrival_airport_col else None
        transfer_type = normalize_text(row.get(transfer_type_col)) if transfer_type_col else None
        transfer_price = parse_optional_number(row.get(transfer_price_col)) if transfer_price_col else None
        baggage_price = parse_optional_number(row.get(baggage_price_col)) if baggage_price_col else None

        if not order_nummer_raw:
            errors.append(f"Flights: rij {row_number}: ontbrekende 'Order number' — overgeslagen.")
            continue
        if (
            not transport_type
            and not direction
            and not flight_number
            and not airline
            and not departure_time
            and not arrival_time
            and not departure_airport
            and not arrival_airport
            and transfer_price is None
            and baggage_price is None
        ):
            continue

        out.append(
            FlightRow(
                order_nummer=order_nummer_raw,
                transport_type=transport_type,
                direction=direction,
                flight_number=flight_number,
                airline=airline,
                departure_time=departure_time,
                arrival_time=arrival_time,
                departure_airport=departure_airport,
                arrival_airport=arrival_airport,
                transfer_type=transfer_type,
                transfer_price=transfer_price,
                baggage_price=baggage_price,
            )
        )

    return out, errors


def parse_workbook(
    file_bytes: bytes, filename: str
) -> tuple[
    list[ExcelRow],
    list[ExcursionRow],
    list[AddonRow],
    list[FlightRow],
    list[str],
    dict[str, SheetParseStatus],
]:
    """
    Parse the whole workbook:
    - main sheet: bookings/travellers rows
    - sheet 'Excursies'
    - sheet 'Addons'
    - sheet 'Flights'

    If a sheet does not exist, we treat it as empty and do not fail the upload.
    """
    bookings_rows, booking_errors = parse_excel_rows(file_bytes, filename)

    excursion_rows: list[ExcursionRow] = []
    addon_rows: list[AddonRow] = []
    flight_rows: list[FlightRow] = []
    extra_errors: list[str] = []

    from io import BytesIO
    xls = pd.ExcelFile(BytesIO(file_bytes))
    sheet_names_list: list[str] = list(xls.sheet_names or [])
    sheet_names = set(sheet_names_list)

    def _find_sheet_matching_aliases(aliases: tuple[str, ...]) -> str | None:
        aliases_l = tuple(a.lower() for a in aliases)
        for sn in sheet_names_list:
            normalized = sn.lower().strip()
            if any(alias in normalized for alias in aliases_l):
                return sn
        return None

    bookings_sheet = sheet_names_list[0] if sheet_names_list else None
    if bookings_sheet and not any(alias in bookings_sheet.lower() for alias in BOOKINGS_SHEET_ALIASES):
        # We allow the first sheet as canonical bookings sheet, even with custom names.
        bookings_sheet = sheet_names_list[0]

    excursies_sheet = (
        "Excursies" if "Excursies" in sheet_names else _find_sheet_matching_aliases(EXCURSIES_SHEET_ALIASES)
    )
    addons_sheet = "Addons" if "Addons" in sheet_names else _find_sheet_matching_aliases(ADDONS_SHEET_ALIASES)
    flights_sheet = "Flights" if "Flights" in sheet_names else _find_sheet_matching_aliases(FLIGHTS_SHEET_ALIASES)

    sheet_statuses: dict[str, SheetParseStatus] = {
        "bookings": SheetParseStatus(
            section="bookings",
            sheet_name=bookings_sheet,
            found=bool(bookings_sheet),
            valid=True,
            rows_count=len(bookings_rows),
            errors=booking_errors,
        ),
        "excursies": SheetParseStatus(
            section="excursies",
            sheet_name=excursies_sheet,
            found=bool(excursies_sheet),
            valid=False,
            rows_count=0,
            errors=[],
        ),
        "addons": SheetParseStatus(
            section="addons",
            sheet_name=addons_sheet,
            found=bool(addons_sheet),
            valid=False,
            rows_count=0,
            errors=[],
        ),
        "flights": SheetParseStatus(
            section="flights",
            sheet_name=flights_sheet,
            found=bool(flights_sheet),
            valid=False,
            rows_count=0,
            errors=[],
        ),
    }

    if excursies_sheet:
        try:
            excursion_rows, errs = parse_excursies_sheet(file_bytes, sheet_name=excursies_sheet)
            extra_errors.extend(errs)
            sheet_statuses["excursies"] = SheetParseStatus(
                section="excursies",
                sheet_name=excursies_sheet,
                found=True,
                valid=len(errs) == 0,
                rows_count=len(excursion_rows),
                errors=errs,
            )
        except Exception as exc:  # noqa: BLE001
            parse_exc = f"Fout bij parsen van Excursies-sheet ({excursies_sheet}): {exc}"
            extra_errors.append(parse_exc)
            sheet_statuses["excursies"] = SheetParseStatus(
                section="excursies",
                sheet_name=excursies_sheet,
                found=True,
                valid=False,
                rows_count=0,
                errors=[parse_exc],
            )
    else:
        sheet_statuses["excursies"] = SheetParseStatus(
            section="excursies",
            sheet_name=None,
            found=False,
            valid=False,
            rows_count=0,
            errors=[],
        )

    if addons_sheet:
        try:
            addon_rows, errs = parse_addons_sheet(file_bytes, sheet_name=addons_sheet)
            extra_errors.extend(errs)
            sheet_statuses["addons"] = SheetParseStatus(
                section="addons",
                sheet_name=addons_sheet,
                found=True,
                valid=len(errs) == 0,
                rows_count=len(addon_rows),
                errors=errs,
            )
        except Exception as exc:  # noqa: BLE001
            parse_exc = f"Fout bij parsen van Addons-sheet ({addons_sheet}): {exc}"
            extra_errors.append(parse_exc)
            sheet_statuses["addons"] = SheetParseStatus(
                section="addons",
                sheet_name=addons_sheet,
                found=True,
                valid=False,
                rows_count=0,
                errors=[parse_exc],
            )
    else:
        sheet_statuses["addons"] = SheetParseStatus(
            section="addons",
            sheet_name=None,
            found=False,
            valid=False,
            rows_count=0,
            errors=[],
        )

    if flights_sheet:
        try:
            flight_rows, errs = parse_flights_sheet(file_bytes, sheet_name=flights_sheet)
            extra_errors.extend(errs)
            sheet_statuses["flights"] = SheetParseStatus(
                section="flights",
                sheet_name=flights_sheet,
                found=True,
                valid=len(errs) == 0,
                rows_count=len(flight_rows),
                errors=errs,
            )
        except Exception as exc:  # noqa: BLE001
            parse_exc = f"Fout bij parsen van Flights-sheet ({flights_sheet}): {exc}"
            extra_errors.append(parse_exc)
            sheet_statuses["flights"] = SheetParseStatus(
                section="flights",
                sheet_name=flights_sheet,
                found=True,
                valid=False,
                rows_count=0,
                errors=[parse_exc],
            )
    else:
        sheet_statuses["flights"] = SheetParseStatus(
            section="flights",
            sheet_name=None,
            found=False,
            valid=False,
            rows_count=0,
            errors=[],
        )

    return bookings_rows, excursion_rows, addon_rows, flight_rows, [*booking_errors, *extra_errors], sheet_statuses

