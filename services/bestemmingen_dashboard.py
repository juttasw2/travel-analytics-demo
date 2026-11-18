"""
Nood-fallback voor Bestemmingen-dashboard wanneer bestemmingen_dashboard_rpc faalt (niet gedeployed / fout).
Secundaire filters zitten in de RPC (SQL); deze module alleen nog voor noodgeval na volledige destinations-RPC.
"""

from __future__ import annotations

from typing import Any


def _get_top_audience(dest: dict[str, Any]) -> str:
    booked = dest.get("bookedAudiences") or []
    if not booked:
        return "-"
    return max(booked, key=lambda a: (a.get("count") or 0))["label"]


def _get_top_hotel(dest: dict[str, Any]) -> str:
    hotels = dest.get("topHotels") or []
    if not hotels:
        return "-"
    return max(hotels, key=lambda h: (h.get("bookings") or 0))["hotel"]


def matches_season(dest: dict[str, Any], season: str | None) -> bool:
    if not season or season == "__all__":
        return True
    vm = dest.get("vertrekmaanden") or []
    return season in vm


def matches_category(dest: dict[str, Any], cat: str | None) -> bool:
    if not cat or cat == "__all__":
        return True
    hotels = dest.get("topHotels") or []
    return any((h.get("category") or "") == cat for h in hotels)


def matches_audience(dest: dict[str, Any], audience: str | None) -> bool:
    if not audience or audience == "__all__":
        return True
    targets = dest.get("targetAudience") or []
    if isinstance(targets, list) and audience in targets:
        return True
    booked = dest.get("bookedAudiences") or []
    return any((a.get("label") or "") == audience for a in booked)


def matches_region(dest: dict[str, Any], region: str | None) -> bool:
    if not region or region == "__all__":
        return True
    return (dest.get("regio") or "") == region


def apply_secondary_filters(
    destinations: list[dict[str, Any]],
    *,
    region: str | None,
    audience: str | None,
    category: str | None,
    season: str | None,
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for dest in destinations:
        if not matches_region(dest, region):
            continue
        if not matches_audience(dest, audience):
            continue
        if not matches_category(dest, category):
            continue
        if not matches_season(dest, season):
            continue
        out.append(dest)
    return out


def apply_search(destinations: list[dict[str, Any]], search: str | None) -> list[dict[str, Any]]:
    if not search or not str(search).strip():
        return destinations
    s = str(search).lower().strip()
    out: list[dict[str, Any]] = []
    for dest in destinations:
        hay = " ".join(
            [
                str(dest.get("naam") or ""),
                str(dest.get("regio") or ""),
                _get_top_audience(dest),
                _get_top_hotel(dest),
                ",".join(dest.get("targetAudience") or []) if isinstance(dest.get("targetAudience"), list) else "",
            ]
        ).lower()
        if s in hay:
            out.append(dest)
    return out


def _sort_key(dest: dict[str, Any], sort_key: str) -> Any:
    if sort_key == "name":
        return (dest.get("naam") or "").lower()
    if sort_key == "target":
        ta = dest.get("targetAudience") or []
        return ",".join(ta) if isinstance(ta, list) else str(ta)
    if sort_key == "booked":
        return _get_top_audience(dest)
    if sort_key == "bookings":
        return int(dest.get("totalBookings") or 0)
    if sort_key == "revenue":
        return float(dest.get("totalRevenue") or 0)
    if sort_key == "hotel":
        return _get_top_hotel(dest)
    if sort_key == "fit":
        return int(dest.get("audienceFitScore") or 0)
    return 0


def sort_destinations(
    destinations: list[dict[str, Any]], *, sort_key: str, sort_dir: str
) -> list[dict[str, Any]]:
    reverse = str(sort_dir).lower() != "asc"
    return sorted(destinations, key=lambda d: _sort_key(d, sort_key), reverse=reverse)


def compute_metrics(destinations: list[dict[str, Any]]) -> dict[str, Any]:
    """Bouwt metrics-object zoals bestemmingen_dashboard_rpc / frontend charts."""
    if not destinations:
        return {
            "kpis": {
                "totalBookings": 0,
                "totalRevenue": 0.0,
                "avgBookingValue": 0.0,
                "topAudience": "-",
                "topHotel": "-",
                "weightedFitPercent": 0,
            },
            "charts": {
                "audienceDistribution": {"labels": [], "values": []},
                "targetVsActual": {"labels": [], "target": [], "actual": []},
                "trend": {"labels": [], "values": []},
                "topHotels": {"labels": [], "values": []},
            },
            "insights": ["Geen bestemmingen gevonden voor de gekozen filters."],
        }

    total_bookings = sum(int(d.get("totalBookings") or 0) for d in destinations)
    total_priced_bookings = sum(int(d.get("totalPricedBookings") or 0) for d in destinations)
    total_revenue = sum(float(d.get("totalRevenue") or 0) for d in destinations)
    avg_booking_value = (total_revenue / total_priced_bookings) if total_priced_bookings > 0 else 0.0

    audience_count: dict[str, int] = {}
    hotel_count: dict[str, int] = {}
    fit_weighted = 0.0
    for d in destinations:
        tb = int(d.get("totalBookings") or 0)
        fit_weighted += int(d.get("audienceFitScore") or 0) * tb
        for a in d.get("bookedAudiences") or []:
            lab = str(a.get("label") or "")
            audience_count[lab] = audience_count.get(lab, 0) + int(a.get("count") or 0)
        for h in d.get("topHotels") or []:
            hn = str(h.get("hotel") or "")
            hotel_count[hn] = hotel_count.get(hn, 0) + int(h.get("bookings") or 0)

    top_audience = max(audience_count.items(), key=lambda x: x[1])[0] if audience_count else "-"
    top_hotel = max(hotel_count.items(), key=lambda x: x[1])[0] if hotel_count else "-"
    weighted_fit = int(round(fit_weighted / total_bookings)) if total_bookings > 0 else 0

    # Audience distribution
    aud_labels = list(audience_count.keys())
    aud_values = [audience_count[k] for k in aud_labels]
    # sort by count desc
    pairs = sorted(zip(aud_labels, aud_values), key=lambda x: -x[1])
    aud_labels = [p[0] for p in pairs]
    aud_values = [p[1] for p in pairs]

    # Target vs actual (zelfde als buildTargetVsActual in JS)
    labels_set: set[str] = set()
    for d in destinations:
        for x in d.get("targetAudience") or []:
            labels_set.add(str(x))
        for a in d.get("bookedAudiences") or []:
            labels_set.add(str(a.get("label") or ""))
    labels = sorted(labels_set)
    target_map: dict[str, float] = {lab: 0.0 for lab in labels}
    actual_map: dict[str, int] = {lab: 0 for lab in labels}
    for d in destinations:
        targets = d.get("targetAudience") or []
        if not isinstance(targets, list):
            targets = []
        n_t = len(targets) if targets else 0
        tb = int(d.get("totalBookings") or 0)
        share = (tb / n_t) if n_t else 0.0
        for lab in targets:
            target_map[str(lab)] = target_map.get(str(lab), 0.0) + share
        for a in d.get("bookedAudiences") or []:
            lab = str(a.get("label") or "")
            actual_map[lab] = actual_map.get(lab, 0) + int(a.get("count") or 0)

    target_vals = [round(target_map.get(lab, 0.0)) for lab in labels]
    actual_vals = [int(actual_map.get(lab, 0)) for lab in labels]

    # Trend
    by_month: dict[str, int] = {}
    for d in destinations:
        for row in d.get("bookingTrendOverTime") or []:
            m = str(row.get("month") or "")
            by_month[m] = by_month.get(m, 0) + int(row.get("bookings") or 0)
    sorted_months = sorted(by_month.keys())
    trend_labels = sorted_months  # frontend parseMonth applied in JS if needed
    trend_values = [by_month[m] for m in sorted_months]

    # Top hotels global
    h_sorted = sorted(hotel_count.items(), key=lambda x: -x[1])[:7]
    th_labels = [x[0] for x in h_sorted]
    th_values = [x[1] for x in h_sorted]

    # Insights
    insights: list[str] = []
    if destinations:
        high_vol = max(destinations, key=lambda x: int(x.get("totalBookings") or 0))
        insights.append(
            f"{high_vol.get('naam')} genereert het hoogste volume met {int(high_vol.get('totalBookings') or 0)} boekingen."
        )
        high_val = max(destinations, key=lambda x: float(x.get("averageBookingValue") or 0))
        insights.append(
            f"{high_val.get('naam')} heeft de hoogste gemiddelde boekingswaarde ({round(float(high_val.get('averageBookingValue') or 0), 2)})."
        )
        low_fit = [d for d in destinations if int(d.get("audienceFitScore") or 0) < 70]
        low_fit.sort(key=lambda x: int(x.get("audienceFitScore") or 0))
        if low_fit:
            insights.append(
                f"Mismatch-opportuniteit: {low_fit[0].get('naam')} heeft een lage doelgroep-fit ({int(low_fit[0].get('audienceFitScore') or 0)}%)."
            )
            if len(low_fit) > 1:
                insights.append(
                    f"Ook {low_fit[1].get('naam')} vraagt herpositionering van doelgroepcommunicatie."
                )
    if not insights:
        insights.append("Geen opvallende opportuniteiten binnen de huidige selectie.")

    return {
        "kpis": {
            "totalBookings": total_bookings,
            "totalRevenue": round(total_revenue, 2),
            "avgBookingValue": round(avg_booking_value, 2),
            "topAudience": top_audience,
            "topHotel": top_hotel,
            "weightedFitPercent": weighted_fit,
        },
        "charts": {
            "audienceDistribution": {"labels": aud_labels, "values": aud_values},
            "targetVsActual": {"labels": labels, "target": target_vals, "actual": actual_vals},
            "trend": {"labels": trend_labels, "values": trend_values},
            "topHotels": {"labels": th_labels, "values": th_values},
        },
        "insights": insights,
    }


def slim_table_row(dest: dict[str, Any]) -> dict[str, Any]:
    """Minimale rij voor tabel (zonder zware tijdreeksen)."""
    return {
        "id": dest.get("id"),
        "naam": dest.get("naam"),
        "regio": dest.get("regio"),
        "targetAudience": dest.get("targetAudience"),
        "bookedAudiences": dest.get("bookedAudiences"),
        "totalBookings": dest.get("totalBookings"),
        "totalPricedBookings": dest.get("totalPricedBookings"),
        "totalRevenue": dest.get("totalRevenue"),
        "averageBookingValue": dest.get("averageBookingValue"),
        "topHotels": dest.get("topHotels"),
        "audienceFitScore": dest.get("audienceFitScore"),
        "notes": dest.get("notes"),
    }


def build_dashboard_from_destinations(
    destinations: list[dict[str, Any]],
    *,
    search: str | None,
    sort_key: str,
    sort_dir: str,
    page: int,
    page_size: int,
) -> dict[str, Any]:
    filtered = apply_search(destinations, search)
    total_count = len(filtered)
    sorted_rows = sort_destinations(filtered, sort_key=sort_key, sort_dir=sort_dir)
    page = max(1, page)
    page_size = min(100, max(1, page_size))
    start = (page - 1) * page_size
    page_slice = sorted_rows[start : start + page_size]
    metrics = compute_metrics(filtered)
    return {
        "metrics": metrics,
        "table_rows": [slim_table_row(d) for d in page_slice],
        "total_count": total_count,
        "page": page,
        "page_size": page_size,
    }
