from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
from typing import Any

import pandas as pd

from services.validation import is_nullish, normalize_header, normalize_text, parse_optional_date, parse_optional_number, to_int


@dataclass(frozen=True)
class VluchtAllotmentRij:
    arrival: Any
    departure: Any
    agency: str | None
    way: str | None
    total_pax: int
    booked_pax: int
    still_free: int
    outbound_flight: str | None
    inbound_flight: str | None
    pp_outbound: float | None
    pp_inbound: float | None


def _normalize_excel_header(value: Any) -> str:
    return normalize_header(value)


def _parse_excel_date(value: Any) -> Any:
    return parse_optional_date(value)


def _parse_excel_int(value: Any) -> int:
    return max(int(to_int(value) or 0), 0)


def _parse_excel_numeric(value: Any) -> float | None:
    parsed = parse_optional_number(value)
    return float(parsed) if parsed is not None else None


def parse_vlucht_allotment_excel(file_bytes: bytes) -> tuple[list[VluchtAllotmentRij], list[str]]:
    fouten: list[str] = []
    rijen: list[VluchtAllotmentRij] = []
    xls = pd.ExcelFile(BytesIO(file_bytes))
    if not xls.sheet_names:
        return [], ["Geen werkbladen gevonden in het Excel-bestand."]
    sheet_naam = xls.sheet_names[0]
    df_raw = pd.read_excel(BytesIO(file_bytes), sheet_name=sheet_naam, header=None)  # type: ignore[arg-type]
    if df_raw.empty:
        return [], ["Geen gegevens gevonden in het eerste werkblad."]

    vereiste_headers = {"arrival", "departure", "agency", "way", "totalpax", "bookedpax", "stillfree", "ppoutbound", "ppinbound"}
    header_row_idx: int | None = None
    for i in range(min(len(df_raw), 20)):
        row_norm = [_normalize_excel_header(v) for v in df_raw.iloc[i].tolist()]
        if vereiste_headers.issubset(set(row_norm)) and row_norm.count("flight") >= 2:
            header_row_idx = i
            break

    if header_row_idx is None:
        return [], [
            "Geen geldige header-rij gevonden. Verwacht kolommen ARRIVAL, DEPARTURE, AGENCY, WAY, TOTAL PAX, BOOKED PAX, STILL FREE, FLIGHT, FLIGHT, PP OUTBOUND, PP INBOUND."
        ]

    group_row_idx = header_row_idx - 1 if header_row_idx > 0 else None
    header_cells = df_raw.iloc[header_row_idx].tolist()
    group_cells = df_raw.iloc[group_row_idx].tolist() if group_row_idx is not None else [None] * len(header_cells)

    mapping: dict[str, int] = {}
    flight_candidates: list[tuple[int, str]] = []
    simple_keys = {
        "arrival": "arrival",
        "departure": "departure",
        "agency": "agency",
        "way": "way",
        "totalpax": "total_pax",
        "bookedpax": "booked_pax",
        "stillfree": "still_free",
        "ppoutbound": "pp_outbound",
        "ppinbound": "pp_inbound",
    }
    for idx, (header, group) in enumerate(zip(header_cells, group_cells)):
        h = _normalize_excel_header(header)
        g = _normalize_excel_header(group)
        if h in simple_keys and simple_keys[h] not in mapping:
            mapping[simple_keys[h]] = idx
        if h == "flight":
            flight_candidates.append((idx, g))

    for idx, g in flight_candidates:
        if "outbound" in g and "outbound_flight" not in mapping:
            mapping["outbound_flight"] = idx
        elif "inbound" in g and "inbound_flight" not in mapping:
            mapping["inbound_flight"] = idx
    if "outbound_flight" not in mapping and flight_candidates:
        mapping["outbound_flight"] = flight_candidates[0][0]
    if "inbound_flight" not in mapping and len(flight_candidates) > 1:
        mapping["inbound_flight"] = flight_candidates[1][0]

    required_fields = [
        "arrival",
        "departure",
        "agency",
        "way",
        "total_pax",
        "booked_pax",
        "still_free",
        "outbound_flight",
        "inbound_flight",
        "pp_outbound",
        "pp_inbound",
    ]
    display_name = {
        "arrival": "ARRIVAL",
        "departure": "DEPARTURE",
        "agency": "AGENCY",
        "way": "WAY",
        "total_pax": "TOTAL PAX",
        "booked_pax": "BOOKED PAX",
        "still_free": "STILL FREE",
        "pp_outbound": "PP OUTBOUND",
        "pp_inbound": "PP INBOUND",
    }
    for field in required_fields:
        if field not in mapping:
            if field in {"outbound_flight", "inbound_flight"}:
                fouten.append("Er moeten twee FLIGHT-kolommen aanwezig zijn: één voor OUTBOUND en één voor INBOUND.")
                break
            fouten.append(f"Kolom {display_name.get(field, field.upper())} ontbreekt.")
    if fouten:
        return [], fouten

    for row_idx in range(header_row_idx + 1, len(df_raw)):
        row = df_raw.iloc[row_idx]
        excel_rij = row_idx + 1
        vals = {k: row.iloc[v] for k, v in mapping.items()}
        if all(is_nullish(v) or str(v).strip() == "" for v in vals.values()):
            continue

        arrival = _parse_excel_date(vals["arrival"])
        departure = _parse_excel_date(vals["departure"])
        agency = normalize_text(vals["agency"])
        way = normalize_text(vals["way"])
        outbound_flight = normalize_text(vals["outbound_flight"])
        inbound_flight = normalize_text(vals["inbound_flight"])
        total_raw = to_int(vals["total_pax"])
        booked_raw = to_int(vals["booked_pax"])
        free_raw = to_int(vals["still_free"])
        pp_outbound = _parse_excel_numeric(vals["pp_outbound"])
        pp_inbound = _parse_excel_numeric(vals["pp_inbound"])

        if arrival is None:
            fouten.append(f"Sheet '{sheet_naam}' rij {excel_rij}: ARRIVAL ontbreekt of is ongeldig.")
            continue
        if departure is None:
            fouten.append(f"Sheet '{sheet_naam}' rij {excel_rij}: DEPARTURE ontbreekt of is ongeldig.")
            continue
        if not agency:
            fouten.append(f"Sheet '{sheet_naam}' rij {excel_rij}: AGENCY ontbreekt.")
            continue
        if not way:
            fouten.append(f"Sheet '{sheet_naam}' rij {excel_rij}: WAY ontbreekt.")
            continue
        if total_raw is None:
            fouten.append(f"Sheet '{sheet_naam}' rij {excel_rij}: TOTAL PAX ontbreekt of is ongeldig.")
            continue
        if booked_raw is None:
            fouten.append(f"Sheet '{sheet_naam}' rij {excel_rij}: BOOKED PAX ontbreekt of is ongeldig.")
            continue
        if free_raw is None:
            fouten.append(f"Sheet '{sheet_naam}' rij {excel_rij}: STILL FREE ontbreekt of is ongeldig.")
            continue
        if not outbound_flight:
            fouten.append(f"Sheet '{sheet_naam}' rij {excel_rij}: OUTBOUND FLIGHT ontbreekt.")
            continue
        if not inbound_flight:
            fouten.append(f"Sheet '{sheet_naam}' rij {excel_rij}: INBOUND FLIGHT ontbreekt.")
            continue
        if pp_outbound is None:
            fouten.append(f"Sheet '{sheet_naam}' rij {excel_rij}: PP OUTBOUND ontbreekt of is ongeldig.")
            continue
        if pp_inbound is None:
            fouten.append(f"Sheet '{sheet_naam}' rij {excel_rij}: PP INBOUND ontbreekt of is ongeldig.")
            continue

        rijen.append(
            VluchtAllotmentRij(
                arrival=arrival,
                departure=departure,
                agency=agency,
                way=way,
                total_pax=max(int(total_raw), 0),
                booked_pax=max(int(booked_raw), 0),
                still_free=max(int(free_raw), 0),
                outbound_flight=outbound_flight,
                inbound_flight=inbound_flight,
                pp_outbound=pp_outbound,
                pp_inbound=pp_inbound,
            )
        )

    if not rijen and not fouten:
        fouten.append("Geen geldige rijen gevonden in het bestand.")
    return rijen, fouten
