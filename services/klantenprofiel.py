"""Klantenprofiel: payload verrijken (scholen, provincies, inzichten) na RPC."""

from __future__ import annotations

from typing import Any

from services.province_mapping import normalize_province_label
from services.school_normalization import get_canonical_school


def _school_bookings_value(row: dict[str, Any], pax: int) -> int:
    """
    Bepaal boekingen robuust:
    - gebruik RPC-veld `bookings` indien aanwezig
    - val terug op minimaal 1 booking bij pax > 0 (oude RPC zonder bookings-kolom)
    """
    raw = row.get("bookings")
    if raw is None:
        return 1 if pax > 0 else 0
    try:
        parsed = int(raw)
    except (TypeError, ValueError):
        parsed = 0
    if pax > 0:
        return max(1, parsed)
    return max(0, parsed)


def collapse_province_series(rows: list[dict[str, Any]], value_key: str) -> list[dict[str, Any]]:
    by: dict[str, float] = {}
    for r in rows or []:
        raw = r.get("provincie")
        lab = normalize_province_label(str(raw) if raw not in (None, "", "(onbekend)") else None)
        by[lab] = by.get(lab, 0) + float(r.get(value_key) or 0)
    out = [{value_key: int(v), "provincie": k} for k, v in by.items()]
    out.sort(key=lambda x: x[value_key], reverse=True)
    return out


def merge_schools_by_canonical(raw_top: list[dict[str, Any]], *, limit: int = 25) -> list[dict[str, Any]]:
    merged: dict[str, dict[str, Any]] = {}
    for r in raw_top or []:
        school_raw = str(r.get("school") or "")
        canon = get_canonical_school(school_raw) or school_raw or "(leeg)"
        pax = int(r.get("pax") or 0)
        bookings = _school_bookings_value(r, pax)
        key = (canon or "").strip().lower()
        if key not in merged:
            merged[key] = {
                "canonical_school": canon,
                "pax": 0,
                "bookings": 0,
                "examples_raw": [],
            }
        entry = merged[key]
        entry["pax"] += pax
        entry["bookings"] += bookings
        if school_raw and school_raw not in entry["examples_raw"] and len(entry["examples_raw"]) < 3:
            entry["examples_raw"].append(school_raw)
    lst = list(merged.values())
    lst.sort(key=lambda x: x["pax"], reverse=True)
    return lst[:limit]


def school_concentration(school_rows: list[dict[str, Any]], total_pax: int) -> dict[str, Any]:
    if not total_pax or not school_rows:
        return {"top5_share_pct": None, "top10_share_pct": None}
    tops = sorted(school_rows, key=lambda x: x.get("pax", 0), reverse=True)
    s5 = sum(int(x.get("pax") or 0) for x in tops[:5])
    s10 = sum(int(x.get("pax") or 0) for x in tops[:10])
    return {
        "top5_share_pct": round(s5 / total_pax * 100, 1),
        "top10_share_pct": round(s10 / total_pax * 100, 1),
    }


def merge_school_matrix_by_province(raw_matrix: list[dict[str, Any]]) -> dict[str, Any]:
    by_province: dict[str, dict[str, dict[str, Any]]] = {}
    totals_by_province: dict[str, int] = {}
    for row in raw_matrix or []:
        school_raw = str(row.get("school") or "")
        canon = get_canonical_school(school_raw) or "Niet ingevuld"
        province = normalize_province_label(str(row.get("provincie") or ""))
        pax = int(row.get("pax") or 0)
        bookings = _school_bookings_value(row, pax)
        if province not in by_province:
            by_province[province] = {}
            totals_by_province[province] = 0
        totals_by_province[province] += pax
        key = canon.strip().lower()
        if key not in by_province[province]:
            by_province[province][key] = {
                "canonical_school": canon,
                "pax": 0,
                "bookings": 0,
                "examples_raw": [],
            }
        entry = by_province[province][key]
        entry["pax"] += pax
        entry["bookings"] += bookings
        if school_raw and school_raw not in entry["examples_raw"] and len(entry["examples_raw"]) < 3:
            entry["examples_raw"].append(school_raw)

    rows_by_province: dict[str, list[dict[str, Any]]] = {}
    conc_by_province: dict[str, dict[str, Any]] = {}
    for province, mapping in by_province.items():
        rows = list(mapping.values())
        rows.sort(key=lambda x: x["pax"], reverse=True)
        rows_by_province[province] = rows[:25]
        conc_by_province[province] = school_concentration(rows, totals_by_province.get(province, 0))

    options = sorted(rows_by_province.keys())
    return {
        "rows_by_province": rows_by_province,
        "concentration_by_province": conc_by_province,
        "totals_by_province": totals_by_province,
        "province_options": options,
    }


def _num(x: Any) -> float:
    try:
        return float(x)
    except (TypeError, ValueError):
        return 0.0


def build_insights(payload: dict[str, Any]) -> list[str]:
    """Rule-based banners (2–4) op basis van beschikbare velden."""
    out: list[str] = []

    kc = payload.get("kpis_cur") or {}
    kp = payload.get("kpis_prev")
    extras_cur = (payload.get("kpi_extras_cur") or {}) if isinstance(payload.get("kpi_extras_cur"), dict) else {}
    extras_prev = (payload.get("kpi_extras_prev") or {}) if isinstance(payload.get("kpi_extras_prev"), dict) else {}

    def add(msg: str) -> None:
        if msg and len(out) < 4:
            out.append(msg)

    # Overzicht-insights (hoogste prioriteit)
    brands = payload.get("brand_pax_cur") or []
    if brands:
        top_brand = max(brands, key=lambda x: _num(x.get("pax")), default=None)
        bname = str((top_brand or {}).get("brand") or "")
        if bname:
            add(f"Meeste pax komt van {bname}.")

    age_hist = payload.get("age_hist") or []
    if age_hist:
        hi = max(age_hist, key=lambda x: _num(x.get("n")), default=None)
        bucket = str((hi or {}).get("bucket") or "")
        if bucket:
            add(f"Grootste leeftijdsgroep: {bucket}.")

    dest_rows = payload.get("dest_be_nl") or []
    if dest_rows:
        top_dest = max(
            dest_rows,
            key=lambda x: _num(x.get("pax_be")) + _num(x.get("pax_nl")),
            default=None,
        )
        dname = str((top_dest or {}).get("dest_naam") or "")
        if dname:
            add(f"Top bestemming: {dname}.")

    # Supplementaire inzichten (invullen tot 4)

    # Groepsgrootte-trend
    if len(out) < 4 and kp and kc.get("avg_party") is not None and kp.get("avg_party") is not None:
        cur_ap, prev_ap = float(kc.get("avg_party") or 0), float(kp.get("avg_party") or 0)
        if prev_ap > 0 and cur_ap < prev_ap - 0.15:
            add(f"Gemiddelde groepsgrootte daalt t.o.v. vorig jaar ({cur_ap} vs {prev_ap}).")

    # Top scholen concentratie
    conc = payload.get("school_concentration") or {}
    if len(out) < 4 and conc.get("top5_share_pct") is not None and conc["top5_share_pct"] >= 30:
        add(f"Top 5 scholen (genormaliseerd) vertegenwoordigen {conc['top5_share_pct']}% van de pax.")

    # Repeat ratio
    rr_cur = extras_cur.get("repeat_ratio")
    rr_prev = extras_prev.get("repeat_ratio")
    if rr_cur is not None:
        try:
            rr_cur_f = float(rr_cur)
        except (TypeError, ValueError):
            rr_cur_f = None
        if rr_cur_f is not None and rr_cur_f >= 40:
            if rr_prev is not None:
                try:
                    rr_prev_f = float(rr_prev)
                except (TypeError, ValueError):
                    rr_prev_f = None
                if rr_prev_f is not None:
                    delta_pp = rr_cur_f - rr_prev_f
                    add(f"Repeat-deelname is hoog ({rr_cur_f}%). Dat is {delta_pp:+.1f} pp t.o.v. vorig jaar.")
                else:
                    add(f"Repeat-deelname is relatief hoog ({rr_cur_f}% van de pax in scope).")
            else:
                add(f"Repeat-deelname is relatief hoog ({rr_cur_f}% van de pax in scope).")

    # NL vs BE signaal in grootste merk (optioneel)
    if len(out) < 4:
        mix = payload.get("brand_origin_cur") or []
        by_brand: dict[str, dict[str, float]] = {}
        for row in mix:
            b = str(row.get("brand") or "")
            o = str(row.get("origin") or "")
            by_brand.setdefault(b, {})[o] = _num(row.get("pax"))
        top_brand = max(brands, key=lambda x: _num(x.get("pax")), default=None) if brands else None
        bname = str((top_brand or {}).get("brand") or "")
        parts = by_brand.get(bname, {}) if bname else {}
        be, nl = parts.get("BE", 0), parts.get("NL", 0)
        if len(parts) >= 2 and nl > be * 1.15:
            add(f"Binnen merk “{bname}” is NL-pax groter dan BE-pax in deze selectie.")

    # Leeftijd bestemming vs totaal (optioneel)
    if len(out) < 4:
        ages = payload.get("age_by_dest") or []
        overall = _num(kc.get("avg_age")) if kc.get("avg_age") is not None else None
        if overall is not None and ages:
            hi = max(ages, key=lambda x: _num(x.get("avg_age")) or 0, default=None)
            if hi and hi.get("dest_naam") and (_num(hi.get("avg_age")) > overall + 3):
                add(
                    f"Gemiddelde leeftijd ligt hoger voor bestemming {hi.get('dest_naam')} "
                    f"(≈ {hi.get('avg_age')} jr vs totaal ≈ {overall})."
                )

    return out[:4]


def enrich_klantenprofiel_payload(raw: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(raw, dict):
        return {"error": "invalid_payload"}
    err = raw.get("error")
    if err is not None and err is not False and err != "":
        if err in (0, "0"):
            return {**raw, "error": "Onbekende fout (code 0). Controleer Supabase RPC, rechten en serverlog."}
        return raw

    out = dict(raw)
    if out.get("kpis_cur") is None:
        out["kpis_cur"] = {
            "total_pax": 0,
            "bookings": 0,
            "avg_party": None,
            "avg_age": None,
            "pax_with_age": 0,
            "pax_repeat": 0,
        }
    if not out.get("loyalty"):
        out["loyalty"] = {"pax_repeat": 0, "pax_new": 0, "pax_total": 0}
    total_pax = int((out.get("kpis_cur") or {}).get("total_pax") or 0)

    prov_pax = collapse_province_series(list(raw.get("province_pax") or []), "pax")
    prov_b = collapse_province_series(list(raw.get("province_bookings") or []), "bookings")
    prov_pax_prev = collapse_province_series(list(raw.get("province_pax_prev") or []), "pax")
    prov_b_prev = collapse_province_series(list(raw.get("province_bookings_prev") or []), "bookings")
    out["province_pax_norm"] = prov_pax
    out["province_bookings_norm"] = prov_b
    out["province_pax_prev_norm"] = prov_pax_prev
    out["province_bookings_prev_norm"] = prov_b_prev

    raw_schools = list(raw.get("school_top_raw") or [])
    schools = merge_schools_by_canonical(raw_schools)
    out["school_top_canonical"] = schools
    out["school_concentration"] = school_concentration(schools, total_pax)
    school_matrix = merge_school_matrix_by_province(list(raw.get("school_prov_matrix") or []))
    out["school_top_canonical_by_province"] = school_matrix["rows_by_province"]
    out["school_concentration_by_province"] = school_matrix["concentration_by_province"]
    out["school_total_pax_by_province"] = school_matrix["totals_by_province"]
    out["school_province_options"] = school_matrix["province_options"]
    out["origin_other_breakdown"] = list(raw.get("origin_other_breakdown") or [])

    out["insights"] = build_insights({**out, "kpis_cur": raw.get("kpis_cur"), "kpis_prev": raw.get("kpis_prev")})

    # Merk-groei alleen vullen wanneer de RPC meta.compare=true zet (YoY actief).
    # Anders (bv. verouderde "light"-stub met compare=false maar lege brand_pax_prev)
    # zou elke prev op 0 vallen en Δ pax = volledige huidige pax — misleidend.
    meta = raw.get("meta") or {}
    compare_on = bool(meta.get("compare")) if isinstance(meta, dict) else False
    growth: list[dict[str, Any]] = []
    if compare_on:
        bcur = {str(x.get("brand")): _num(x.get("pax")) for x in (raw.get("brand_pax_cur") or [])}
        bpr = {str(x.get("brand")): _num(x.get("pax")) for x in (raw.get("brand_pax_prev") or [])}
        for bn, pv in bcur.items():
            prev_v = bpr.get(bn, 0)
            growth.append(
                {
                    "brand": bn,
                    "pax_cur": int(pv),
                    "pax_prev": int(prev_v),
                    "delta_pax": int(pv - prev_v),
                    "delta_pct": round((pv - prev_v) / prev_v * 100, 1) if prev_v > 0 else None,
                }
            )
        growth.sort(key=lambda x: x.get("delta_pax") or 0, reverse=True)
    out["brand_pax_growth"] = growth

    return out
