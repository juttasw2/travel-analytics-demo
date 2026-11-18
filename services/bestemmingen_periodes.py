"""
Datalaag voor Bestemmingen & periodes: vertrekdatum/terugkeerdatum, pax op reizigersniveau.
Semantiek 'reizigers op reis' (dagelijkse aanwezigheid) sluit aan bij heatmap Boekingsgedrag:
inclusief vertrek- én terugkeerdag, td = coalesce(terugkeerdatum, vertrekdatum), td niet voor vd.
"""

from __future__ import annotations

import calendar
from collections import defaultdict
from datetime import date, timedelta
from typing import Any


def effective_donut_brand(donut_brand: str) -> str:
    """Alleen de merkkeuze in het donut-blok (los van pagina-filters). Default: Sun Escapes."""
    db = (donut_brand or "Sun Escapes").strip()
    return db or "Sun Escapes"


def effective_kp_donut_brand(page_brand: str, donut_brand: str) -> str:
    """Klantenprofiel: pagina-brand wint; anders segment in het donut-blok."""
    pb = (page_brand or "").strip().lower()
    if pb and pb not in ("__all__", "all"):
        return (page_brand or "").strip()
    return effective_donut_brand(donut_brand)


def traveler_origin_donut_payload(rows: list[dict[str, Any]], *, effective_brand: str) -> dict[str, Any]:
    """
    Bouwt twee slices (BE / NL op brand_land) met verdeling reizigers naar _bp-bucket (BE, NL, IT, OTHER).
    """
    by_bl: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    other_detail_by_bl: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for r in rows or []:
        bl = str(r.get("booking_brand_land") or "").strip().upper()
        ob = str(r.get("origin_bucket") or "OTHER").strip().upper()
        country = str(r.get("origin_country") or "").strip().upper() or "Onbekend"
        if ob not in ("BE", "NL", "IT", "OTHER"):
            ob = "OTHER"
        by_bl[bl][ob] += int(r.get("traveler_count") or 0)
        if ob == "OTHER":
            other_detail_by_bl[bl][country] += int(r.get("traveler_count") or 0)

    origin_order = ("BE", "NL", "IT", "OTHER")
    slice_keys = ("BE", "NL")
    slices: list[dict[str, Any]] = []
    for bl_key in slice_keys:
        counts = by_bl.get(bl_key, {})
        total = sum(counts.values())
        items: list[dict[str, Any]] = []
        for ob in origin_order:
            c = int(counts.get(ob, 0))
            if c <= 0:
                continue
            other_details: list[dict[str, Any]] = []
            if ob == "OTHER":
                items_other = sorted(other_detail_by_bl.get(bl_key, {}).items(), key=lambda x: (-x[1], x[0]))
                other_total = sum(x[1] for x in items_other)
                other_details = [
                    {
                        "country": country,
                        "pax": int(px),
                        "pct_within_other": round(px / other_total * 100, 2) if other_total > 0 else 0.0,
                    }
                    for country, px in items_other
                    if px > 0
                ]
            items.append(
                {
                    "origin_bucket": ob,
                    "pax": c,
                    "pct": round(c / total * 100, 2) if total > 0 else 0.0,
                    "other_details": other_details,
                }
            )
        items.sort(key=lambda x: -x["pax"])
        slices.append(
            {
                "booking_brand_land": bl_key,
                "title": f"{effective_brand} {bl_key}",
                "total_travelers": total,
                "items": items,
            }
        )
    return {"effective_brand": effective_brand, "slices": slices}

def map_transport_category(naam: str | None) -> str:
    """Normaliseer transport naar plane | bus | self."""
    n = (naam or "").lower()
    if n == "plane":
        return "plane"
    if n == "bus":
        return "bus"
    if n == "self":
        return "self"
    if any(k in n for k in ("plane", "vliegtuig", "vlucht", "flight", "airline", "air", "luchthaven")):
        return "plane"
    if any(k in n for k in ("bus", "coach", "autocar")):
        return "bus"
    if any(k in n for k in ("self", "eigen vervoer", "own transport", "own", "auto", "car")):
        return "self"
    return "self"


def _country_shares_with_it_in_other(*, be: int, nl: int, it: int, other: int, fallback_total: int) -> dict[str, float]:
    """Landaandelen voor UI: IT wordt altijd samengevoegd in OTHER."""
    other_merged = int(other) + int(it)
    total = int(be) + int(nl) + other_merged
    if total <= 0:
        total = max(int(fallback_total), 1)
    return {
        "BE": round(int(be) / total * 100, 2) if total else 0.0,
        "NL": round(int(nl) / total * 100, 2) if total else 0.0,
        "OTHER": round(other_merged / total * 100, 2) if total else 0.0,
    }


def effective_trip_end(vertrek: date, terugkeer_raw: date | None) -> date:
    td = terugkeer_raw if terugkeer_raw is not None else vertrek
    if td < vertrek:
        td = vertrek
    return td


def add_travellers_on_trip_days(
    target: dict[date, int],
    vertrek: date,
    terugkeer_raw: date | None,
    pax: int,
    clip_start: date | None = None,
    clip_end: date | None = None,
) -> None:
    """Zelfde dag-loop als _heatmap_aggregate_month_days (inclusief eindpunten)."""
    if pax <= 0:
        return
    td = effective_trip_end(vertrek, terugkeer_raw)
    lo, hi = vertrek, td
    if clip_start is not None or clip_end is not None:
        cs = clip_start or lo
        ce = clip_end or hi
        lo = max(lo, cs)
        hi = min(hi, ce)
    if lo > hi:
        return
    d = lo
    while d <= hi:
        target[d] = target.get(d, 0) + pax
        d = d + timedelta(days=1)


def add_travellers_on_trip_days_by_dest(
    target: dict[date, dict[str, int]],
    dest_name: str,
    vertrek: date,
    terugkeer_raw: date | None,
    pax: int,
    clip_start: date | None = None,
    clip_end: date | None = None,
) -> None:
    """Pax per bestemming per kalenderdag tijdens het verblijf (zelfde clip-logica als add_travellers_on_trip_days)."""
    if pax <= 0:
        return
    dn = (dest_name or "").strip() or "(onbekend)"
    td = effective_trip_end(vertrek, terugkeer_raw)
    lo, hi = vertrek, td
    if clip_start is not None or clip_end is not None:
        cs = clip_start or lo
        ce = clip_end or hi
        lo = max(lo, cs)
        hi = min(hi, ce)
    if lo > hi:
        return
    d = lo
    while d <= hi:
        day_map = target.setdefault(d, {})
        day_map[dn] = day_map.get(dn, 0) + pax
        d = d + timedelta(days=1)


def _matrix_cell_key(row_label: str, week_num: int) -> str:
    return f"{row_label}\t{week_num}"


def build_matrix_cell_details(bookings: list[dict], *, dim: str) -> dict[str, dict[str, Any]]:
    """
    dim: 'dest' (rij = bestemming) of 'acc' (rij = accommodatie).
    Sleutel: "rijlabel\\tweeknummer" (week 1–52).
    """
    out: dict[str, dict[str, Any]] = {}
    for b in bookings:
        iw = b["vertrekdatum"].isocalendar()
        wk = min(int(iw.week), 52)
        if dim == "dest":
            label = b["bestemming_naam"] or "(onbekend)"
            ck = _matrix_cell_key(label, wk)
            if ck not in out:
                out[ck] = {
                    "week": wk,
                    "row_label": label,
                    "pax": 0,
                    "bookings": 0,
                    "brands": defaultdict(int),
                }
            o = out[ck]
            o["pax"] += b["pax"]
            o["bookings"] += 1
            br = (b.get("brand") or "").strip() or "—"
            o["brands"][br] += b["pax"]
        else:
            label = b["accommodatie_naam"] or "(onbekend)"
            ck = _matrix_cell_key(label, wk)
            if ck not in out:
                out[ck] = {
                    "week": wk,
                    "row_label": label,
                    "pax": 0,
                    "bookings": 0,
                    "brands": defaultdict(int),
                    "dest_pax": defaultdict(int),
                }
            o = out[ck]
            o["pax"] += b["pax"]
            o["bookings"] += 1
            br = (b.get("brand") or "").strip() or "—"
            o["brands"][br] += b["pax"]
            dn = b["bestemming_naam"] or "(onbekend)"
            o["dest_pax"][dn] += b["pax"]

    serialized: dict[str, dict[str, Any]] = {}
    for ck, o in out.items():
        brands = sorted(o["brands"].items(), key=lambda x: (-x[1], x[0]))[:5]
        nb = int(o["bookings"])
        px = int(o["pax"])
        row: dict[str, Any] = {
            "week": o["week"],
            "pax": px,
            "bookings": nb,
            "avg_pax_per_booking": round(px / nb, 2) if nb else 0.0,
            "top_brands": [{"naam": n, "pax": int(pbx)} for n, pbx in brands],
        }
        if dim == "dest":
            row["bestemming"] = o["row_label"]
        else:
            row["accommodatie"] = o["row_label"]
            dp = o.get("dest_pax") or {}
            top_d = sorted(dp.items(), key=lambda x: (-x[1], x[0]))[:3]
            row["top_bestemmingen"] = [{"naam": n, "pax": int(pdx)} for n, pdx in top_d]
        serialized[ck] = row
    return serialized


def _safe_date(row: dict, key: str) -> date | None:
    v = row.get(key)
    if v is None:
        return None
    if isinstance(v, date):
        return v
    s = str(v)[:10]
    parts = s.split("-")
    if len(parts) != 3:
        return None
    try:
        return date(int(parts[0]), int(parts[1]), int(parts[2]))
    except ValueError:
        return None


def _row_to_booking(row: dict) -> dict[str, Any]:
    vd = _safe_date(row, "vertrekdatum")
    td_raw = _safe_date(row, "terugkeerdatum")
    if not vd:
        return {}
    return {
        "booking_id": str(row.get("booking_id") or ""),
        "bestemming_id": str(row.get("bestemming_id") or "").strip() or None,
        "vertrekdatum": vd,
        "terugkeerdatum": td_raw,
        "bestemming_naam": str(row.get("bestemming_naam") or ""),
        "accommodatie_naam": str(row.get("accommodatie_naam") or ""),
        "transport_naam": str(row.get("transport_naam") or ""),
        "brand": str(row.get("brand") or ""),
        # RPC bestemmingen_periodes_bookings_year gebruikt pax_scope; oudere clients / REST kan pax of aantal_reizigers sturen
        "pax": int(
            row.get("pax_scope")
            or row.get("pax")
            or row.get("aantal_reizigers")
            or row.get("pax_r")
            or 0
        ),
        "pax_be": int(row.get("pax_be") or 0),
        "pax_nl": int(row.get("pax_nl") or 0),
        "pax_it": int(row.get("pax_it") or 0),
        "pax_other": int(row.get("pax_other") or 0),
    }


def aggregate_payload(
    *,
    rows_cur: list[dict],
    rows_prev: list[dict],
    year: int,
    compare_prev: bool,
    show_holidays: bool,
    filter_brand_norm: str,
) -> dict[str, Any]:
    bookings_cur = [_row_to_booking(r) for r in rows_cur]
    bookings_cur = [b for b in bookings_cur if b]
    bookings_prev = [_row_to_booking(r) for r in rows_prev]
    bookings_prev = [b for b in bookings_prev if b]

    y_start = date(year, 1, 1)
    y_end = date(year, 12, 31)

    def run_for_year(bookings: list[dict], y: int) -> dict[str, Any]:
        ys, ye = date(y, 1, 1), date(y, 12, 31)
        pax_total = sum(b["pax"] for b in bookings)
        n_book = len(bookings)
        avg_pb = round(pax_total / n_book, 2) if n_book else 0.0

        acc_pax: dict[str, int] = defaultdict(int)
        for b in bookings:
            acc_pax[b["accommodatie_naam"] or "(onbekend)"] += b["pax"]
        top_acc = max(acc_pax.items(), key=lambda x: x[1]) if acc_pax else ("—", 0)
        top_share = round(top_acc[1] / pax_total * 100, 1) if pax_total > 0 else 0.0

        dest_pax: dict[str, int] = defaultdict(int)
        for b in bookings:
            dest_pax[b["bestemming_naam"] or "(onbekend)"] += b["pax"]
        top_dest = max(dest_pax.items(), key=lambda x: x[1]) if dest_pax else ("—", 0)
        top_dest_share = round(top_dest[1] / pax_total * 100, 1) if pax_total > 0 else 0.0

        pax_be = sum(b["pax_be"] for b in bookings)
        pax_nl = sum(b["pax_nl"] for b in bookings)
        pax_it = sum(b["pax_it"] for b in bookings)
        pax_oth = sum(b["pax_other"] for b in bookings)
        pax_ct = pax_be + pax_nl + pax_it + pax_oth
        if pax_ct <= 0:
            pax_ct = pax_total
        share = _country_shares_with_it_in_other(
            be=pax_be,
            nl=pax_nl,
            it=pax_it,
            other=pax_oth,
            fallback_total=pax_ct,
        )

        by_week: dict[int, int] = defaultdict(int)
        by_month: dict[int, int] = defaultdict(int)
        by_day: dict[date, dict[str, Any]] = defaultdict(
            lambda: {
                "pax": 0,
                "bookings": 0,
                "pax_be": 0,
                "pax_nl": 0,
                "pax_it": 0,
                "pax_other": 0,
                "transport": defaultdict(int),
                "acc": defaultdict(int),
                "dest": defaultdict(int),
            }
        )
        travellers_day: dict[date, int] = {}
        travellers_dest_day: dict[date, dict[str, int]] = defaultdict(dict)

        for b in bookings:
            vd = b["vertrekdatum"]
            p = b["pax"]
            iw = vd.isocalendar()
            wk = int(iw.week)
            if wk > 52:
                wk = 52
            by_week[wk] += p
            by_month[vd.month] += p
            cell = by_day[vd]
            cell["pax"] += p
            cell["bookings"] += 1
            cell["pax_be"] += b["pax_be"]
            cell["pax_nl"] += b["pax_nl"]
            cell["pax_it"] += b["pax_it"]
            cell["pax_other"] += b["pax_other"]
            cat = map_transport_category(b["transport_naam"])
            cell["transport"][cat] += p
            acc_key = b["accommodatie_naam"] or "(onbekend)"
            cell["acc"][acc_key] += p
            dest_key = b["bestemming_naam"] or "(onbekend)"
            cell["dest"][dest_key] += p
            add_travellers_on_trip_days(travellers_day, vd, b["terugkeerdatum"], p, ys, ye)
            add_travellers_on_trip_days_by_dest(
                travellers_dest_day,
                b["bestemming_naam"] or "(onbekend)",
                vd,
                b["terugkeerdatum"],
                p,
                ys,
                ye,
            )

        top_dest_per_day: dict[str, list[dict[str, Any]]] = {}
        for d, tot in travellers_day.items():
            by_dest = travellers_dest_day.get(d, {})
            if not by_dest:
                top_dest_per_day[d.isoformat()] = []
                continue
            items = sorted(by_dest.items(), key=lambda x: (-x[1], x[0]))[:3]
            top_dest_per_day[d.isoformat()] = [
                {
                    "naam": n,
                    "pax": int(px),
                    "pct": round(100.0 * px / tot, 1) if tot > 0 else 0.0,
                }
                for n, px in items
            ]

        transport_pax: dict[str, int] = defaultdict(int)
        for b in bookings:
            transport_pax[map_transport_category(b["transport_naam"])] += b["pax"]
        transport_pax_ordered = {
            "plane": int(transport_pax.get("plane", 0)),
            "bus": int(transport_pax.get("bus", 0)),
            "self": int(transport_pax.get("self", 0)),
        }

        return {
            "pax_total": pax_total,
            "bookings": n_book,
            "avg_pax_per_booking": avg_pb,
            "top_accommodatie": {"naam": top_acc[0], "pax": top_acc[1], "aandeel_pct": top_share},
            "top_bestemming": {"naam": top_dest[0], "pax": top_dest[1], "aandeel_pct": top_dest_share},
            "country_share_pct": share,
            "by_week": dict(by_week),
            "by_month": {str(m): by_month[m] for m in sorted(by_month.keys())},
            "by_day": by_day,
            "travellers_on_trip_by_day": {d.isoformat(): v for d, v in sorted(travellers_day.items())},
            "travellers_on_trip_top_destinations": top_dest_per_day,
            "transport_pax": transport_pax_ordered,
        }

    cur = run_for_year(bookings_cur, year)
    prev = run_for_year(bookings_prev or [], year - 1) if compare_prev else None

    delta_pax = (cur["pax_total"] - prev["pax_total"]) if prev else None
    delta_pct = (
        round((cur["pax_total"] - prev["pax_total"]) / prev["pax_total"] * 100, 1)
        if prev and prev["pax_total"] > 0
        else None
    )

    # Maandserie voor grafiek (labels + waarden)
    month_labels = [calendar.month_abbr[i] for i in range(1, 13)]
    month_vals = [cur["by_month"].get(str(i), 0) for i in range(1, 13)]
    month_prev = (
        [prev["by_month"].get(str(i), 0) for i in range(1, 13)] if prev else [0] * 12
    )

    # Week series: altijd ISO-week 1 t/m 52 (stabiel i.v.m. vergelijking en UI)
    week_labels_sorted = list(range(1, 53))
    week_vals = [cur["by_week"].get(k, 0) for k in week_labels_sorted]
    week_prev_map = prev["by_week"] if prev else {}
    week_prev_vals = [week_prev_map.get(k, 0) for k in week_labels_sorted]
    week_chart_labels = [f"Week {w}" for w in week_labels_sorted]

    # Land verschuiving: pp verschil per maand
    share_shift_months: list[dict[str, Any]] = []
    if prev:
        for m in range(1, 13):
            bc_m = [b for b in bookings_cur if b["vertrekdatum"].month == m]
            bp_m = [b for b in bookings_prev if b["vertrekdatum"].month == m]
            def share_set(bs: list) -> dict[str, float]:
                be, nl, it, ot = (
                    sum(b["pax_be"] for b in bs),
                    sum(b["pax_nl"] for b in bs),
                    sum(b["pax_it"] for b in bs),
                    sum(b["pax_other"] for b in bs),
                )
                tot = be + nl + it + ot
                if tot <= 0:
                    tot = sum(b["pax"] for b in bs) or 1
                return _country_shares_with_it_in_other(
                    be=be,
                    nl=nl,
                    it=it,
                    other=ot,
                    fallback_total=tot,
                )
            sc = share_set(bc_m)
            sp = share_set(bp_m)
            share_shift_months.append(
                {
                    "month": m,
                    "month_label": calendar.month_name[m],
                    "BE_pp": round(sc["BE"] - sp["BE"], 2),
                    "NL_pp": round(sc["NL"] - sp["NL"], 2),
                    "OTHER_pp": round(sc["OTHER"] - sp["OTHER"], 2),
                    "share_cur": sc,
                    "share_prev": sp,
                }
            )

    # JJAS-block
    summer_months = [6, 7, 8, 9]
    summer_block: list[dict[str, Any]] = []
    sum_cur_season = sum(int(cur["by_month"].get(str(m), 0)) for m in summer_months)
    for m in summer_months:
        pc = int(cur["by_month"].get(str(m), 0))
        pp = int(prev["by_month"].get(str(m), 0)) if prev else 0
        dlt = pc - pp
        dlt_pct = round((pc - pp) / pp * 100, 1) if prev and pp > 0 else None
        summer_block.append(
            {
                "month": m,
                "label": calendar.month_name[m],
                "pax_current": pc,
                "pax_previous": pp if prev else None,
                "delta": dlt if prev else None,
                "delta_pct": dlt_pct,
                "season_share_pct": round(pc / sum_cur_season * 100, 1) if sum_cur_season > 0 else 0.0,
            }
        )

    # Top 20 vertrekdagen (hoogste pax eerst; tie-break: eerdere vertrekdatum)
    day_rank = sorted(cur["by_day"].items(), key=lambda kv: (-kv[1]["pax"], kv[0]))[:20]
    top20_days = []
    for d, info in day_rank:
        top20_days.append(
            {
                "vertrekdatum": d.isoformat(),
                "pax": info["pax"],
                "bookings": info["bookings"],
            }
        )

    # Volledige vertrektabel (compacte rijen) — max 400
    table_rows: list[dict[str, Any]] = []
    for d, info in sorted(cur["by_day"].items(), key=lambda x: x[0], reverse=True)[:400]:
        iw = d.isocalendar()
        pax = info["pax"]
        nb = info["bookings"]
        top_a = max(info["acc"].items(), key=lambda x: x[1]) if info["acc"] else ("—", 0)
        tot_detail = info["pax_be"] + info["pax_nl"] + info["pax_it"] + info["pax_other"] or pax
        dest_breakdown = [
            {"naam": naam, "pax": int(px)}
            for naam, px in sorted(info.get("dest", {}).items(), key=lambda x: (-x[1], x[0]))
        ]
        table_rows.append(
            {
                "vertrekdatum": d.isoformat(),
                "week": iw.week,
                "month": d.month,
                "weekday": d.weekday(),
                "weekday_label": ["Ma", "Di", "Wo", "Do", "Vr", "Za", "Zo"][d.weekday()],
                "pax": pax,
                "bookings": nb,
                "avg_pax_per_booking": round(pax / nb, 2) if nb else 0,
                "bestemming_breakdown": dest_breakdown,
                "top_accommodatie": top_a[0],
                "transport_top": max(info["transport"].items(), key=lambda x: x[1])[0]
                if info["transport"]
                else "—",
                "share_be_pct": round(info["pax_be"] / tot_detail * 100, 1),
                "share_nl_pct": round(info["pax_nl"] / tot_detail * 100, 1),
                "share_it_pct": round(info["pax_it"] / tot_detail * 100, 1),
                "share_other_pct": round(info["pax_other"] / tot_detail * 100, 1),
            }
        )

    # Matrix: destination × week (pax + boekingen)
    dest_week: dict[str, dict[int, int]] = defaultdict(lambda: defaultdict(int))
    dest_week_bookings: dict[str, dict[int, int]] = defaultdict(lambda: defaultdict(int))
    for b in bookings_cur:
        iw = b["vertrekdatum"].isocalendar()
        wk = min(int(iw.week), 52)
        dn = b["bestemming_naam"] or "(onbekend)"
        dest_week[dn][wk] += b["pax"]
        dest_week_bookings[dn][wk] += 1
    acc_week: dict[str, dict[int, int]] = defaultdict(lambda: defaultdict(int))
    acc_week_bookings: dict[str, dict[int, int]] = defaultdict(lambda: defaultdict(int))
    for b in bookings_cur:
        iw = b["vertrekdatum"].isocalendar()
        wk = min(int(iw.week), 52)
        an = b["accommodatie_naam"] or "(onbekend)"
        acc_week[an][wk] += b["pax"]
        acc_week_bookings[an][wk] += 1

    # Matrix: altijd alle ISO-weken 1–52 (kolommen); lege weken = 0
    weeks_sorted = list(range(1, 53))
    week_x_labels = [f"W{k}" for k in weeks_sorted]

    dest_totals = {k: sum(v.values()) for k, v in dest_week.items()}
    top_dests = sorted(dest_totals.keys(), key=lambda x: dest_totals[x], reverse=True)
    acc_totals = {k: sum(v.values()) for k, v in acc_week.items()}
    top_accs = sorted(acc_totals.keys(), key=lambda x: acc_totals[x], reverse=True)

    def build_matrix_with_bookings(
        pax_map: dict[str, dict[int, int]],
        book_map: dict[str, dict[int, int]],
        y_keys: list[str],
    ) -> dict[str, Any]:
        vals_p: list[list[int]] = []
        vals_b: list[list[int]] = []
        for yk in y_keys:
            mp = pax_map.get(yk, {})
            mb = book_map.get(yk, {})
            vals_p.append([int(mp.get(wk, 0)) for wk in weeks_sorted])
            vals_b.append([int(mb.get(wk, 0)) for wk in weeks_sorted])
        return {"x_labels": week_x_labels, "y_labels": y_keys, "values": vals_p, "bookings_values": vals_b}

    matrix_destinations = build_matrix_with_bookings(dest_week, dest_week_bookings, top_dests)
    matrix_accommodaties = build_matrix_with_bookings(acc_week, acc_week_bookings, top_accs)
    matrix_cell_details_destination = build_matrix_cell_details(bookings_cur, dim="dest")
    matrix_cell_details_accommodation = build_matrix_cell_details(bookings_cur, dim="acc")

    if compare_prev and bookings_prev:
        pd_map: dict[tuple[int, int], int] = defaultdict(int)
        for b in bookings_prev:
            vd_prev = b["vertrekdatum"]
            pd_map[(vd_prev.month, vd_prev.day)] += b["pax"]
        for row in table_rows:
            d = date.fromisoformat(str(row["vertrekdatum"]))
            pp = int(pd_map.get((d.month, d.day), 0))
            dp = int(row["pax"]) - pp
            row["delta_pax_vs_prev"] = dp
            row["delta_pct_vs_prev"] = round(dp / pp * 100, 1) if pp > 0 else None
    else:
        for row in table_rows:
            row["delta_pax_vs_prev"] = None
            row["delta_pct_vs_prev"] = None

    holiday_table: list[dict[str, Any]] = []
    if show_holidays:
        holiday_table = build_holiday_analytics(
            bookings_cur,
            bookings_prev if prev else [],
            year,
            filter_brand_norm,
        )

    insights = build_insights(
        cur=cur,
        prev=prev,
        summer_block=summer_block,
        month_vals=month_vals,
        month_prev=month_prev,
        top20_days=top20_days,
        cur_transport=cur["transport_pax"],
        prev_transport=prev["transport_pax"] if prev else None,
    )

    # Zelfde payload als Vergelijkingen → destination_delta (bestemming × pax vs referentiejaar)
    destination_delta_rows: list[dict[str, Any]] = []
    if compare_prev:
        def _dest_group_key(b: dict[str, Any]) -> tuple[str, str]:
            did = str(b.get("bestemming_id") or "").strip()
            if did:
                return ("id", did)
            return ("name", str(b.get("bestemming_naam") or "(onbekend)"))

        def _dest_group_label(b: dict[str, Any]) -> str:
            return str(b.get("bestemming_naam") or "(onbekend)")

        dest_cur: dict[tuple[str, str], int] = defaultdict(int)
        dest_cur_label: dict[tuple[str, str], str] = {}
        for b in bookings_cur:
            key = _dest_group_key(b)
            dest_cur[key] += b["pax"]
            dest_cur_label.setdefault(key, _dest_group_label(b))
        dest_prev: dict[tuple[str, str], int] = defaultdict(int)
        dest_prev_label: dict[tuple[str, str], str] = {}
        for b in bookings_prev:
            key = _dest_group_key(b)
            dest_prev[key] += b["pax"]
            dest_prev_label.setdefault(key, _dest_group_label(b))
        for key in set(dest_cur.keys()) | set(dest_prev.keys()):
            c = int(dest_cur.get(key, 0))
            p = int(dest_prev.get(key, 0))
            if c == 0 and p == 0:
                continue
            cb = sum(1 for b in bookings_cur if _dest_group_key(b) == key)
            pb = sum(1 for b in bookings_prev if _dest_group_key(b) == key)
            dlt = c - p
            dlt_pct = None if p == 0 else round(dlt / p * 100, 1)
            label = dest_cur_label.get(key) or dest_prev_label.get(key) or "(onbekend)"
            destination_delta_rows.append(
                {
                    "bestemming": label,
                    "current_pax": c,
                    "previous_pax": p,
                    "current_bookings": cb,
                    "previous_bookings": pb,
                    "delta": dlt,
                    "delta_pct": dlt_pct,
                }
            )
        destination_delta_rows.sort(key=lambda r: (-r["delta"], -r["current_pax"]))

    return {
        "year": year,
        "compare_enabled": bool(compare_prev),
        "destination_delta": destination_delta_rows,
        "kpis": {
            "total_pax": cur["pax_total"],
            "total_pax_previous": prev["pax_total"] if prev else None,
            "delta_pax": delta_pax,
            "delta_pct": delta_pct,
            "bookings": cur["bookings"],
            "avg_pax_per_booking": cur["avg_pax_per_booking"],
            "top_accommodatie": cur["top_accommodatie"],
            "top_bestemming": cur["top_bestemming"],
            "country_share_pct": cur["country_share_pct"],
        },
        "charts": {
            "pax_per_week": {"labels": week_chart_labels, "current": week_vals, "previous": week_prev_vals},
            "pax_per_month": {"labels": month_labels, "current": month_vals, "previous": month_prev},
            "country_share_shift_by_month": share_shift_months,
            "summer_jjas": summer_block,
            "transport_split": {
                "labels": list(cur["transport_pax"].keys()),
                "current": list(cur["transport_pax"].values()),
                "previous": [prev["transport_pax"].get(k, 0) for k in cur["transport_pax"].keys()]
                if prev
                else None,
            },
            "top20_departure_days": top20_days,
            "travellers_on_trip_heatmap": cur["travellers_on_trip_by_day"],
            "travellers_on_trip_top_destinations": cur.get("travellers_on_trip_top_destinations") or {},
        },
        "matrix": {
            "mode_all_destinations": matrix_destinations,
            "mode_single_destination": matrix_accommodaties,
            "cell_details_destination": matrix_cell_details_destination,
            "cell_details_accommodation": matrix_cell_details_accommodation,
        },
        "departure_table": table_rows,
        "holiday_periods": holiday_table,
        "insights": insights,
    }


def build_insights(
    *,
    cur: dict[str, Any],
    prev: dict[str, Any] | None,
    summer_block: list[dict[str, Any]],
    month_vals: list[int],
    month_prev: list[int],
    top20_days: list[dict[str, Any]],
    cur_transport: dict[str, int],
    prev_transport: dict[str, int] | None,
) -> list[str]:
    out: list[str] = []
    if prev and prev.get("pax_total", 0) > 0:
        dp = cur["pax_total"] - prev["pax_total"]
        pct = round(dp / prev["pax_total"] * 100, 1)
        out.append(
            f"Totaal pax op vertrekbasis: {'+' if dp >= 0 else ''}{pct}% t.o.v. vorig jaar ({dp:+d} pax)."
        )
    # Sterkste JJAS-maand
    if summer_block:
        best = max(summer_block, key=lambda x: x["pax_current"])
        if prev:
            if best.get("delta_pct") is not None:
                out.append(
                    f"{best['label']} groeit met {best['delta_pct']:+g}% t.o.v. vorig jaar binnen het JJAS-blok."
                )
        else:
            out.append(f"Binnen JJAS is {best['label']} de maand met de meeste pax ({best['pax_current']}).")
    # Week
    if cur.get("by_week"):
        best_w = max(cur["by_week"].items(), key=lambda kv: kv[1])
        out.append(f"Sterkste vertrekweek (ISO): week {best_w[0]} ({best_w[1]} pax).")
    # Land verschuiving — gebruik totaal-share
    if prev:
        for label, key in [("BE", "BE"), ("NL", "NL")]:
            dpp = round(
                cur["country_share_pct"][key] - prev["country_share_pct"][key],
                1,
            )
            if abs(dpp) >= 1.0:
                out.append(
                    f"{label}-aandeel verschuift met {dpp:+g} procentpunt t.o.v. vorig jaar."
                )
    # Transport
    if prev_transport:
        for cat, label in (("bus", "Bus"), ("plane", "Vliegtuig")):
            a, b = cur_transport.get(cat, 0), prev_transport.get(cat, 0)
            if b > 50 and a < b * 0.85:
                out.append(f"{label}: duidelijk lager dan vorig jaar binnen deze filters.")
    if len(out) > 4:
        out = out[:4]
    return out


def build_holiday_analytics(
    bookings_cur: list[dict],
    bookings_prev: list[dict],
    year: int,
    brand_norm: str,
) -> list[dict[str, Any]]:
    """Uitbreidbare periodes per merk/jaar (datumranges)."""
    periods = holiday_periods_for_brand_year(brand_norm, year)
    if not periods:
        return []
    out: list[dict[str, Any]] = []

    def pax_in_ranges(bs: list[dict], ranges: list[tuple[date, date]]) -> int:
        s = 0
        for b in bs:
            vd = b["vertrekdatum"]
            for a, z in ranges:
                if a <= vd <= z:
                    s += b["pax"]
                    break
        return s

    periods_prev = holiday_periods_for_brand_year(brand_norm, year - 1)

    for i, p in enumerate(periods):
        r_cur = [(p["start"], p["end"])]
        pc = pax_in_ranges(bookings_cur, r_cur)
        pp = 0
        if periods_prev and i < len(periods_prev):
            pp = pax_in_ranges(bookings_prev, [(periods_prev[i]["start"], periods_prev[i]["end"])])
        elif bookings_prev:
            spp = holiday_periods_for_brand_year(brand_norm, year - 1)
            if i < len(spp):
                pp = pax_in_ranges(bookings_prev, [(spp[i]["start"], spp[i]["end"])])
        dlt = pc - pp
        dlt_pct = round(dlt / pp * 100, 1) if pp > 0 else None
        # top vertrekdag in window
        ctr: dict[date, int] = defaultdict(int)
        for b in bookings_cur:
            vd = b["vertrekdatum"]
            if p["start"] <= vd <= p["end"]:
                ctr[vd] += b["pax"]
        top_d = max(ctr.items(), key=lambda x: x[1])[0] if ctr else None
        tr_cnt: dict[str, int] = defaultdict(int)
        for b in bookings_cur:
            if p["start"] <= b["vertrekdatum"] <= p["end"]:
                tr_cnt[map_transport_category(b["transport_naam"])] += b["pax"]
        dom_tr = max(tr_cnt.items(), key=lambda x: x[1])[0] if tr_cnt else "—"

        out.append(
            {
                "periode": p["label"],
                "start": p["start"].isoformat(),
                "end": p["end"].isoformat(),
                "pax_current": pc,
                "pax_previous": pp,
                "delta": dlt,
                "delta_pct": dlt_pct,
                "top_vertrek": top_d.isoformat() if top_d else None,
                "dominant_transport": dom_tr,
            }
        )
    return out


def holiday_periods_for_brand_year(brand_norm: str, year: int) -> list[dict[str, Any]]:
    """Config — uitbreiden per jaar; schatting o.b.v. typische Vlaamse schoolvakanties."""
    b = (brand_norm or "").lower().strip()
    # Placeholder ranges — product owner kan verfijnen in DB of config file
    if b == "snow escapes":
        return _periods_snow_escapes(year)
    if b in {"roadrebels", "road rebels"}:
        return _periods_roadrebels(year)
    return []


def _periods_snow_escapes(y: int) -> list[dict[str, Any]]:
    easter = _approx_easter_monday(y)
    return [
        {"label": "Lesvrije week", "start": date(y, 1, 25), "end": date(y, 2, 7)},
        {"label": "Krokusvakantie", "start": date(y, 2, 15), "end": date(y, 3, 9)},
        {"label": "Paasvakantie", "start": easter - timedelta(days=14), "end": easter + timedelta(days=5)},
        {"label": "Kerstvakantie", "start": date(y, 12, 20), "end": date(y + 1, 1, 5)},
    ]


def _periods_roadrebels(y: int) -> list[dict[str, Any]]:
    easter = _approx_easter_monday(y)
    return [
        {"label": "Krokusvakantie", "start": date(y, 2, 15), "end": date(y, 3, 9)},
        {"label": "Paasvakantie", "start": easter - timedelta(days=14), "end": easter + timedelta(days=5)},
        {"label": "Kerstvakantie", "start": date(y, 12, 20), "end": date(y + 1, 1, 5)},
    ]


def _approx_easter_monday(year: int) -> date:
    """Anonymous Gregorian algorithm → Paasmaandag (vereenvoudigde implementatie)."""
    a = year % 19
    b = year // 100
    c = year % 100
    d = b // 4
    e = b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i = c // 4
    k = c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month = (h + l - 7 * m + 114) // 31
    day = ((h + l - 7 * m + 114) % 31) + 1
    easter_sunday = date(year, month, day)
    return easter_sunday + timedelta(days=1)
