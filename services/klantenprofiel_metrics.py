"""Klantenprofiel: Python-side hercomputatie van metrics die in de oude RPC
verkeerd of leeg waren.

Waarom dit bestaat:
  De Supabase RPC `klantenprofiel_dashboard` rekent verschillende secties
  fout (KPI Gem. groepsgrootte ≠ Overzicht, age_by_month / group_hist /
  group_by_month leeg of verkeerd). Tot de RPC opnieuw uitgerold is via
  `python run_migrations.py`, recompute we deze metrics in Python met
  dezelfde booking_slice + travelers_f definities die ook door Overzicht
  gebruikt worden. De resultaten worden ge-merged in de payload zodat de
  frontend correcte cijfers ziet zonder dat de gebruiker SQL hoeft te
  deployen.

Definities (matchen exact die van Overzicht):
  party_size per boeking =
    - actieve_reizigers (uit vw_actieve_reizigers_per_boeking) als die > 0
    - 0 wanneer er reiziger-rijen bestaan maar geen actieve (alles geannuleerd)
    - aantal_reizigers (fallback) wanneer er geen reiziger-rijen zijn
  total_pax = sum(party_size) over alle boekingen in scope (booking-niveau)
  total_boekingen = count(*) over alle boekingen in scope
  avg_groepsgrootte = total_pax / total_boekingen
"""

from __future__ import annotations

import logging
from typing import Any

from services.supabase_service import SupabaseService

logger = logging.getLogger(__name__)

# ----------------------------
# Filter helpers
# ----------------------------


def _booking_where(
    *,
    year: int,
    brand: str,
    bestemmingen_ids: list[str] | None,
    period: str,
    brand_land: str | None,
) -> tuple[str, dict[str, Any]]:
    """Booking-niveau WHERE-clause + params.

    Equivalent met booking_slice in de RPC (zonder traveler-filters)."""
    period_norm = (period or "all").strip().lower()
    if period_norm not in {"all", "maand", "zomer"}:
        period_norm = "all"
    brand_arg = (brand or "__all__").strip() or "__all__"
    brand_land_arg = (brand_land or "__ALL__").strip()
    if not brand_land_arg or brand_land_arg.lower() in {"__all__", "all"}:
        brand_land_arg = "__ALL__"
    dest_ids = [str(x).strip() for x in (bestemmingen_ids or []) if str(x).strip()]

    clauses = [
        "b.vertrekdatum is not null",
        "not public.boeking_id_excluded_from_standard_dashboards(b.id)",
        "(%(p_brand)s = '__all__' or lower(trim(b.brand)) = lower(trim(%(p_brand)s)))",
        (
            "(%(p_brand_land)s in ('__ALL__', '__all__', 'ALL', 'all', '')"
            " or upper(trim(coalesce(b.brand_land, ''))) = upper(trim(%(p_brand_land)s)))"
        ),
        "(%(p_year)s = 0 or extract(year from b.vertrekdatum)::int = %(p_year)s)",
    ]
    params: dict[str, Any] = {
        "p_brand": brand_arg,
        "p_brand_land": brand_land_arg,
        "p_year": int(year or 0),
    }
    if dest_ids:
        clauses.append("b.bestemming_id::text = any(%(p_dest_ids)s)")
        params["p_dest_ids"] = dest_ids
    if period_norm == "zomer":
        clauses.append("extract(month from b.vertrekdatum)::int between 6 and 9")

    return " and ".join(clauses), params


def _traveler_extra_where(
    *,
    origin: str | None,
    reiziger_land: str | None,
    reiziger_provincies: list[str] | None,
    leeftijdsgroepen: list[str] | None,
) -> tuple[list[str], dict[str, Any]]:
    """Traveler-niveau WHERE-clauses voor query's die `t.land`, `t.origin_country`,
    `t.provincie_raw` en `t.age_y` als kolommen exposen.

    `origin` werkt op het bucketresultaat van `_bp_traveler_country_bucket(t.land)`
    omdat we dezelfde mapping willen als de RPC."""
    extra: list[str] = []
    params: dict[str, Any] = {}

    origin_norm = (origin or "__ALL__").strip().upper() or "__ALL__"
    if origin_norm not in {"__ALL__", "ALL", ""}:
        extra.append("public._bp_traveler_country_bucket(t.land) = %(p_origin)s")
        params["p_origin"] = origin_norm

    rl_norm = (reiziger_land or "__ALL__").strip().upper() or "__ALL__"
    if rl_norm not in {"__ALL__", "ALL", ""}:
        if rl_norm == "__UNKNOWN__":
            extra.append("trim(coalesce(t.origin_country, '')) = 'Onbekend'")
        else:
            extra.append("upper(trim(coalesce(t.origin_country, ''))) = %(p_rl)s")
            params["p_rl"] = rl_norm

    prov_arr = [str(x).strip() for x in (reiziger_provincies or []) if str(x).strip()]
    if prov_arr and not any(p.upper() in {"__ALL__", "ALL"} for p in prov_arr):
        unknown = "__UNKNOWN__" in {p.upper() for p in prov_arr}
        real = [p for p in prov_arr if p.upper() != "__UNKNOWN__"]
        if unknown and real:
            extra.append("(t.provincie_raw is null or t.provincie_raw = any(%(p_prov)s))")
            params["p_prov"] = real
        elif unknown:
            extra.append("t.provincie_raw is null")
        else:
            extra.append("t.provincie_raw = any(%(p_prov)s)")
            params["p_prov"] = prov_arr

    age_arr = [str(x).strip() for x in (leeftijdsgroepen or []) if str(x).strip()]
    if age_arr and not any(a.upper() in {"__ALL__", "ALL"} for a in age_arr):
        sub: list[str] = []
        for tag in age_arr:
            if tag == "15-":
                sub.append("(t.age_y is not null and t.age_y <= 15)")
            elif tag == "21+":
                sub.append("(t.age_y is not null and t.age_y >= 21)")
            elif tag.isdigit():
                sub.append(f"t.age_y = {int(tag)}")
        if sub:
            extra.append("(" + " or ".join(sub) + ")")

    return extra, params


# ----------------------------
# Booking-niveau metrics (Overzicht-aligned)
# ----------------------------

_BOOKING_SLICE_SQL = """
with booking_slice as (
  select
    b.id as bid,
    b.vertrekdatum::date as vd,
    extract(year from b.vertrekdatum)::int as y,
    extract(month from b.vertrekdatum)::int as vm,
    coalesce(b.aantal_reizigers, 0)::int as pax_decl,
    case
      when coalesce(bca.actieve_reizigers, 0) > 0 then bca.actieve_reizigers::int
      when coalesce(rc.n_rows, 0) > 0 then 0
      else coalesce(b.aantal_reizigers, 0)
    end::int as party_size
  from public.boekingen b
  left join public.vw_actieve_reizigers_per_boeking bca on bca.boeking_id = b.id
  left join (
    select boeking_id, count(*)::int as n_rows
    from public.reizigers
    group by boeking_id
  ) rc on rc.boeking_id = b.id
  where {where}
)
"""


def compute_overzicht_aligned_kpi(
    supabase: SupabaseService,
    *,
    year: int,
    brand: str,
    bestemmingen_ids: list[str] | None,
    period: str,
    brand_land: str | None,
) -> dict[str, Any]:
    """Total pax + boekingen + avg_party op booking-niveau (matched met Overzicht)."""
    where, params = _booking_where(
        year=year,
        brand=brand,
        bestemmingen_ids=bestemmingen_ids,
        period=period,
        brand_land=brand_land,
    )
    sql = (
        _BOOKING_SLICE_SQL.format(where=where)
        + """
        select
          coalesce(sum(party_size), 0)::bigint as total_pax,
          count(*)::bigint as bookings
        from booking_slice
        """
    )
    rows = supabase._execute(sql, params)  # noqa: SLF001 (intentioneel)
    if not rows:
        return {"total_pax": 0, "bookings": 0, "avg_party": None}
    row = rows[0]
    pax = int(row.get("total_pax") or 0)
    bk = int(row.get("bookings") or 0)
    return {
        "total_pax": pax,
        "bookings": bk,
        "avg_party": round(pax / bk, 2) if bk > 0 else None,
    }


def compute_group_buckets_overzicht(
    supabase: SupabaseService,
    *,
    year: int,
    brand: str,
    bestemmingen_ids: list[str] | None,
    period: str,
    brand_land: str | None,
) -> list[dict[str, Any]]:
    """Boekingen per groepsgrootte (1..9, 10+) — gebruikt party_size per
    boeking met dezelfde fallback als Overzicht."""
    where, params = _booking_where(
        year=year,
        brand=brand,
        bestemmingen_ids=bestemmingen_ids,
        period=period,
        brand_land=brand_land,
    )
    sql = (
        _BOOKING_SLICE_SQL.format(where=where)
        + """
        select
          case when party_size >= 10 then '10+' else party_size::text end as bucket,
          count(*)::bigint as n_bookings
        from booking_slice
        where party_size >= 1
        group by 1
        order by 1
        """
    )
    return supabase._execute(sql, params)  # noqa: SLF001


def compute_group_by_month_overzicht(
    supabase: SupabaseService,
    *,
    year: int,
    brand: str,
    bestemmingen_ids: list[str] | None,
    period: str,
    brand_land: str | None,
) -> list[dict[str, Any]]:
    """Gem. groepsgrootte per vertrekmaand = sum(party_size) / count(*)."""
    where, params = _booking_where(
        year=year,
        brand=brand,
        bestemmingen_ids=bestemmingen_ids,
        period=period,
        brand_land=brand_land,
    )
    sql = (
        _BOOKING_SLICE_SQL.format(where=where)
        + """
        select
          vm as month,
          round(sum(party_size)::numeric / nullif(count(*), 0)::numeric, 2) as avg_party,
          sum(party_size)::bigint as pax_total,
          count(*)::bigint as bookings
        from booking_slice
        group by vm
        having count(*) > 0
        order by vm
        """
    )
    rows = supabase._execute(sql, params)  # noqa: SLF001
    out: list[dict[str, Any]] = []
    for r in rows:
        ap = r.get("avg_party")
        out.append(
            {
                "month": int(r.get("month") or 0),
                "avg_party": float(ap) if ap is not None else None,
                "pax_total": int(r.get("pax_total") or 0),
                "bookings": int(r.get("bookings") or 0),
            }
        )
    return out


# ----------------------------
# Traveler-niveau metrics
# ----------------------------

_TRAVELERS_F_SQL = """
with booking_slice as (
  select
    b.id as bid,
    b.vertrekdatum::date as vd,
    extract(month from b.vertrekdatum)::int as vm,
    coalesce(b.brand, '') as brand_raw
  from public.boekingen b
  where {booking_where}
),
travelers_f as (
  select
    bs.bid,
    bs.vd,
    bs.vm,
    bs.brand_raw,
    r.land as land,
    coalesce(nullif(upper(trim(r.land)), ''), 'Onbekend') as origin_country,
    nullif(trim(coalesce(r.provincie, '')), '') as provincie_raw,
    -- Defensieve age: alleen waardes [0..100] tellen mee (filter corrupte
    -- geboortedatum zoals jaar 11 AD die age 2015 oplevert).
    case
      when r.geboortedatum is null then null::int
      when extract(year from age(bs.vd, r.geboortedatum::date))::int between 0 and 100
        then extract(year from age(bs.vd, r.geboortedatum::date))::int
      else null::int
    end as age_y
  from public.reizigers r
  join booking_slice bs on bs.bid = r.boeking_id
  left join public.statussen st_tr on st_tr.id = r.traveller_status_id
  where not public.reiziger_status_uitgesloten_standaard_dashboards(st_tr.naam)
)
"""


def compute_age_by_month(
    supabase: SupabaseService,
    *,
    year: int,
    brand: str,
    bestemmingen_ids: list[str] | None,
    period: str,
    brand_land: str | None,
    origin: str | None,
    reiziger_land: str | None,
    reiziger_provincies: list[str] | None,
    leeftijdsgroepen: list[str] | None,
) -> list[dict[str, Any]]:
    """Gem. leeftijd per vertrekmaand op basis van geboortedatum vs vertrekdatum."""
    booking_where, b_params = _booking_where(
        year=year,
        brand=brand,
        bestemmingen_ids=bestemmingen_ids,
        period=period,
        brand_land=brand_land,
    )
    extra, extra_params = _traveler_extra_where(
        origin=origin,
        reiziger_land=reiziger_land,
        reiziger_provincies=reiziger_provincies,
        leeftijdsgroepen=leeftijdsgroepen,
    )
    extra = ["t.age_y is not null"] + extra

    sql = (
        _TRAVELERS_F_SQL.format(booking_where=booking_where)
        + f"""
        select
          t.vm as month,
          round(avg(t.age_y::numeric), 2) as avg_age,
          count(*)::bigint as n_age
        from travelers_f t
        where {' and '.join(extra)}
        group by t.vm
        having count(*) > 0
        order by t.vm
        """
    )
    params = {**b_params, **extra_params}
    rows = supabase._execute(sql, params)  # noqa: SLF001
    out: list[dict[str, Any]] = []
    for r in rows:
        aa = r.get("avg_age")
        out.append(
            {
                "month": int(r.get("month") or 0),
                "avg_age": float(aa) if aa is not None else None,
                "n_age": int(r.get("n_age") or 0),
            }
        )
    return out


def compute_age_by_brand(
    supabase: SupabaseService,
    *,
    year: int,
    brand: str,
    bestemmingen_ids: list[str] | None,
    period: str,
    brand_land: str | None,
    origin: str | None,
    reiziger_land: str | None,
    reiziger_provincies: list[str] | None,
    leeftijdsgroepen: list[str] | None,
) -> list[dict[str, Any]]:
    """Gem. leeftijd per merk."""
    booking_where, b_params = _booking_where(
        year=year,
        brand=brand,
        bestemmingen_ids=bestemmingen_ids,
        period=period,
        brand_land=brand_land,
    )
    extra, extra_params = _traveler_extra_where(
        origin=origin,
        reiziger_land=reiziger_land,
        reiziger_provincies=reiziger_provincies,
        leeftijdsgroepen=leeftijdsgroepen,
    )
    extra = ["t.age_y is not null"] + extra

    sql = (
        _TRAVELERS_F_SQL.format(booking_where=booking_where)
        + f"""
        select
          t.brand_raw as brand,
          round(avg(t.age_y::numeric), 2) as avg_age,
          count(*)::bigint as n_age
        from travelers_f t
        where {' and '.join(extra)}
        group by t.brand_raw
        order by 1
        """
    )
    params = {**b_params, **extra_params}
    rows = supabase._execute(sql, params)  # noqa: SLF001
    out: list[dict[str, Any]] = []
    for r in rows:
        aa = r.get("avg_age")
        out.append(
            {
                "brand": str(r.get("brand") or ""),
                "avg_age": float(aa) if aa is not None else None,
                "n_age": int(r.get("n_age") or 0),
            }
        )
    return out


# ----------------------------
# Andere traveler-niveau aggregaties
# ----------------------------


def _compute_traveler_aggregate(
    supabase: SupabaseService,
    *,
    select_clause: str,
    group_by: str,
    having: str | None,
    order_by: str,
    year: int,
    brand: str,
    bestemmingen_ids: list[str] | None,
    period: str,
    brand_land: str | None,
    origin: str | None,
    reiziger_land: str | None,
    reiziger_provincies: list[str] | None,
    leeftijdsgroepen: list[str] | None,
    age_required: bool = False,
) -> list[dict[str, Any]]:
    """Generieke helper voor travelers_f-aggregaties met dezelfde filters."""
    booking_where, b_params = _booking_where(
        year=year,
        brand=brand,
        bestemmingen_ids=bestemmingen_ids,
        period=period,
        brand_land=brand_land,
    )
    extra, extra_params = _traveler_extra_where(
        origin=origin,
        reiziger_land=reiziger_land,
        reiziger_provincies=reiziger_provincies,
        leeftijdsgroepen=leeftijdsgroepen,
    )
    if age_required:
        extra = ["t.age_y is not null"] + extra
    where_sql = (" where " + " and ".join(extra)) if extra else ""
    having_sql = f" having {having}" if having else ""
    sql = (
        _TRAVELERS_F_SQL.format(booking_where=booking_where)
        + f"""
        select {select_clause}
        from travelers_f t
        {where_sql}
        group by {group_by}
        {having_sql}
        order by {order_by}
        """
    )
    params = {**b_params, **extra_params}
    return supabase._execute(sql, params)  # noqa: SLF001


def compute_age_hist(
    supabase: SupabaseService, **kw: Any
) -> list[dict[str, Any]]:
    """Leeftijdsbuckets (15-, 16, 17, 18, 19, 20, 21+)."""
    rows = _compute_traveler_aggregate(
        supabase,
        select_clause="""
          case
            when t.age_y <= 15 then '15-'
            when t.age_y in (16, 17, 18, 19, 20) then t.age_y::text
            when t.age_y >= 21 then '21+'
          end as bucket,
          case
            when t.age_y <= 15 then -200
            when t.age_y between 16 and 20 then t.age_y
            when t.age_y >= 21 then 21
          end as bucket_ord,
          count(*)::bigint as n
        """,
        group_by="1, 2",
        having=None,
        order_by="2",
        age_required=True,
        **kw,
    )
    return [
        {
            "bucket": str(r.get("bucket") or ""),
            "bucket_ord": int(r.get("bucket_ord") or 0),
            "n": int(r.get("n") or 0),
        }
        for r in rows
    ]


def compute_origin_pax(supabase: SupabaseService, **kw: Any) -> list[dict[str, Any]]:
    rows = _compute_traveler_aggregate(
        supabase,
        select_clause="public._bp_traveler_country_bucket(t.land) as origin, count(*)::bigint as pax",
        group_by="public._bp_traveler_country_bucket(t.land)",
        having=None,
        order_by="2 desc",
        **kw,
    )
    return [{"origin": str(r.get("origin") or ""), "pax": int(r.get("pax") or 0)} for r in rows]


def compute_province_pax(supabase: SupabaseService, **kw: Any) -> list[dict[str, Any]]:
    rows = _compute_traveler_aggregate(
        supabase,
        select_clause="coalesce(t.provincie_raw, '(onbekend)') as provincie, count(*)::bigint as pax",
        group_by="coalesce(t.provincie_raw, '(onbekend)')",
        having=None,
        order_by="2 desc",
        **kw,
    )
    return [{"provincie": str(r.get("provincie") or ""), "pax": int(r.get("pax") or 0)} for r in rows]


def compute_province_bookings(supabase: SupabaseService, **kw: Any) -> list[dict[str, Any]]:
    rows = _compute_traveler_aggregate(
        supabase,
        select_clause=(
            "coalesce(t.provincie_raw, '(onbekend)') as provincie, "
            "count(distinct t.bid)::bigint as bookings"
        ),
        group_by="coalesce(t.provincie_raw, '(onbekend)')",
        having=None,
        order_by="2 desc",
        **kw,
    )
    return [
        {"provincie": str(r.get("provincie") or ""), "bookings": int(r.get("bookings") or 0)}
        for r in rows
    ]


def compute_brand_pax(supabase: SupabaseService, **kw: Any) -> list[dict[str, Any]]:
    rows = _compute_traveler_aggregate(
        supabase,
        select_clause=(
            "t.brand_raw as brand, count(*)::bigint as pax, "
            "count(distinct t.bid)::bigint as bookings"
        ),
        group_by="t.brand_raw",
        having=None,
        order_by="2 desc",
        **kw,
    )
    return [
        {
            "brand": str(r.get("brand") or ""),
            "pax": int(r.get("pax") or 0),
            "bookings": int(r.get("bookings") or 0),
        }
        for r in rows
    ]


def compute_brand_origin(supabase: SupabaseService, **kw: Any) -> list[dict[str, Any]]:
    rows = _compute_traveler_aggregate(
        supabase,
        select_clause=(
            "t.brand_raw as brand, "
            "public._bp_traveler_country_bucket(t.land) as origin, "
            "count(*)::bigint as pax"
        ),
        group_by="t.brand_raw, public._bp_traveler_country_bucket(t.land)",
        having=None,
        order_by="t.brand_raw, 2",
        **kw,
    )
    return [
        {
            "brand": str(r.get("brand") or ""),
            "origin": str(r.get("origin") or ""),
            "pax": int(r.get("pax") or 0),
        }
        for r in rows
    ]


def compute_dest_be_nl(supabase: SupabaseService, **kw: Any) -> list[dict[str, Any]]:
    """Pax per bestemming gesplitst BE/NL."""
    booking_where, b_params = _booking_where(
        year=kw["year"],
        brand=kw["brand"],
        bestemmingen_ids=kw["bestemmingen_ids"],
        period=kw["period"],
        brand_land=kw["brand_land"],
    )
    extra, extra_params = _traveler_extra_where(
        origin=kw.get("origin"),
        reiziger_land=kw.get("reiziger_land"),
        reiziger_provincies=kw.get("reiziger_provincies"),
        leeftijdsgroepen=kw.get("leeftijdsgroepen"),
    )
    where_sql = (" where " + " and ".join(extra)) if extra else ""
    sql = f"""
    with booking_slice as (
      select
        b.id as bid,
        b.vertrekdatum::date as vd,
        extract(month from b.vertrekdatum)::int as vm,
        coalesce(b.brand, '') as brand_raw,
        coalesce(d.naam, '') as dest_naam
      from public.boekingen b
      left join public.bestemmingen d on d.id = b.bestemming_id
      where {booking_where}
    ),
    travelers_f as (
      select
        bs.bid, bs.vd, bs.vm, bs.brand_raw, bs.dest_naam,
        r.land,
        coalesce(nullif(upper(trim(r.land)), ''), 'Onbekend') as origin_country,
        nullif(trim(coalesce(r.provincie, '')), '') as provincie_raw,
        case
          when r.geboortedatum is null then null::int
          when extract(year from age(bs.vd, r.geboortedatum::date))::int between 0 and 100
            then extract(year from age(bs.vd, r.geboortedatum::date))::int
          else null::int
        end as age_y
      from public.reizigers r
      join booking_slice bs on bs.bid = r.boeking_id
      left join public.statussen st_tr on st_tr.id = r.traveller_status_id
      where not public.reiziger_status_uitgesloten_standaard_dashboards(st_tr.naam)
    )
    select
      t.dest_naam,
      count(*) filter (where public._bp_traveler_country_bucket(t.land) = 'BE')::bigint as pax_be,
      count(*) filter (where public._bp_traveler_country_bucket(t.land) = 'NL')::bigint as pax_nl
    from travelers_f t
    {where_sql}
    group by t.dest_naam
    order by (count(*) filter (where public._bp_traveler_country_bucket(t.land) = 'BE')
              + count(*) filter (where public._bp_traveler_country_bucket(t.land) = 'NL')) desc
    """
    rows = supabase._execute(sql, {**b_params, **extra_params})  # noqa: SLF001
    return [
        {
            "dest_naam": str(r.get("dest_naam") or ""),
            "pax_be": int(r.get("pax_be") or 0),
            "pax_nl": int(r.get("pax_nl") or 0),
        }
        for r in rows
    ]


def compute_month_be_nl(supabase: SupabaseService, **kw: Any) -> list[dict[str, Any]]:
    rows = _compute_traveler_aggregate(
        supabase,
        select_clause=(
            "t.vm as month, "
            "count(*) filter (where public._bp_traveler_country_bucket(t.land) = 'BE')::bigint as pax_be, "
            "count(*) filter (where public._bp_traveler_country_bucket(t.land) = 'NL')::bigint as pax_nl"
        ),
        group_by="t.vm",
        having=None,
        order_by="t.vm",
        **kw,
    )
    return [
        {
            "month": int(r.get("month") or 0),
            "pax_be": int(r.get("pax_be") or 0),
            "pax_nl": int(r.get("pax_nl") or 0),
        }
        for r in rows
    ]


def compute_month_bookings(supabase: SupabaseService, **kw: Any) -> list[dict[str, Any]]:
    rows = _compute_traveler_aggregate(
        supabase,
        select_clause="t.vm as month, count(distinct t.bid)::bigint as bookings",
        group_by="t.vm",
        having=None,
        order_by="t.vm",
        **kw,
    )
    return [
        {"month": int(r.get("month") or 0), "bookings": int(r.get("bookings") or 0)}
        for r in rows
    ]


def compute_age_by_dest(supabase: SupabaseService, **kw: Any) -> list[dict[str, Any]]:
    """Leeftijdsstats per bestemming (median + p25/p75)."""
    booking_where, b_params = _booking_where(
        year=kw["year"],
        brand=kw["brand"],
        bestemmingen_ids=kw["bestemmingen_ids"],
        period=kw["period"],
        brand_land=kw["brand_land"],
    )
    extra, extra_params = _traveler_extra_where(
        origin=kw.get("origin"),
        reiziger_land=kw.get("reiziger_land"),
        reiziger_provincies=kw.get("reiziger_provincies"),
        leeftijdsgroepen=kw.get("leeftijdsgroepen"),
    )
    extra = ["t.age_y is not null"] + extra
    where_sql = " where " + " and ".join(extra)
    sql = f"""
    with booking_slice as (
      select b.id as bid, b.vertrekdatum::date as vd, coalesce(d.naam, '') as dest_naam
      from public.boekingen b
      left join public.bestemmingen d on d.id = b.bestemming_id
      where {booking_where}
    ),
    travelers_f as (
      select bs.bid, bs.dest_naam,
        r.land,
        coalesce(nullif(upper(trim(r.land)), ''), 'Onbekend') as origin_country,
        nullif(trim(coalesce(r.provincie, '')), '') as provincie_raw,
        case
          when r.geboortedatum is null then null::int
          when extract(year from age(bs.vd, r.geboortedatum::date))::int between 0 and 100
            then extract(year from age(bs.vd, r.geboortedatum::date))::int
          else null::int
        end as age_y
      from public.reizigers r
      join booking_slice bs on bs.bid = r.boeking_id
      left join public.statussen st_tr on st_tr.id = r.traveller_status_id
      where not public.reiziger_status_uitgesloten_standaard_dashboards(st_tr.naam)
    )
    select
      t.dest_naam,
      round(avg(t.age_y::numeric), 2) as avg_age,
      percentile_cont(0.25) within group (order by t.age_y::numeric) as p25_age,
      percentile_cont(0.5)  within group (order by t.age_y::numeric) as median_age,
      percentile_cont(0.75) within group (order by t.age_y::numeric) as p75_age,
      count(*)::bigint as n_age
    from travelers_f t
    {where_sql}
    group by t.dest_naam
    order by t.dest_naam
    """
    rows = supabase._execute(sql, {**b_params, **extra_params})  # noqa: SLF001
    out: list[dict[str, Any]] = []
    for r in rows:
        out.append(
            {
                "dest_naam": str(r.get("dest_naam") or ""),
                "avg_age": float(r["avg_age"]) if r.get("avg_age") is not None else None,
                "p25_age": float(r["p25_age"]) if r.get("p25_age") is not None else None,
                "median_age": float(r["median_age"]) if r.get("median_age") is not None else None,
                "p75_age": float(r["p75_age"]) if r.get("p75_age") is not None else None,
                "n_age": int(r.get("n_age") or 0),
            }
        )
    return out


# ----------------------------
# Public entry point
# ----------------------------


def _safe(label: str, fn, *args: Any, **kw: Any) -> Any:
    """Roep een metric-functie aan en log bij failure (geeft None terug)."""
    try:
        return fn(*args, **kw)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Klantenprofiel %s override failed: %s", label, exc)
        return None


def apply_python_overrides(
    supabase: SupabaseService,
    payload: dict[str, Any],
    *,
    year: int,
    brand: str,
    bestemmingen_ids: list[str] | None,
    period: str,
    brand_land: str | None,
    origin: str | None,
    reiziger_land: str | None,
    reiziger_provincies: list[str] | None,
    leeftijdsgroepen: list[str] | None,
    compare_prev: bool,
) -> dict[str, Any]:
    """Vervang in het RPC-payload alle velden waarvan we weten dat de huidige
    Supabase-deployment een degenerate stub draait die hardcoded `[]` of
    foutieve waarden teruggeeft.

    Werkt zonder SQL-deploy. Na `python run_migrations.py` produceert de
    nieuwe RPC dezelfde getallen, dus deze override blijft idempotent."""
    if not isinstance(payload, dict) or payload.get("error"):
        return payload

    yc = int(year or 0)
    yp = yc - 1
    enable_prev = compare_prev and yc > 0

    booking_kw = dict(
        brand=brand,
        bestemmingen_ids=bestemmingen_ids,
        period=period,
        brand_land=brand_land,
    )
    traveler_kw = dict(
        origin=origin,
        reiziger_land=reiziger_land,
        reiziger_provincies=reiziger_provincies,
        leeftijdsgroepen=leeftijdsgroepen,
    )
    full_kw = {**booking_kw, **traveler_kw}

    out = dict(payload)
    out.setdefault("meta", {})
    if isinstance(out["meta"], dict):
        out["meta"] = {**out["meta"], "compare": bool(enable_prev), "year_prev": yp if enable_prev else None}

    # -------------------- KPI (Overzicht-aligned) -------------------------
    kpi_cur = _safe("kpi_cur", compute_overzicht_aligned_kpi, supabase, year=yc, **booking_kw)
    if kpi_cur:
        kc = dict(out.get("kpis_cur") or {})
        kc.update(kpi_cur)
        out["kpis_cur"] = kc

    if enable_prev:
        kpi_prev = _safe("kpi_prev", compute_overzicht_aligned_kpi, supabase, year=yp, **booking_kw)
        if kpi_prev:
            # Behoud avg_age/pax_with_age uit RPC indien aanwezig; vervang KPI-trio.
            kp = dict(out.get("kpis_prev") or {})
            kp.update(kpi_prev)
            out["kpis_prev"] = kp
        else:
            # Geen prev data → consistent null (en niet een hardcoded null uit RPC).
            if out.get("kpis_prev") is None:
                out["kpis_prev"] = None

    # -------------------- Group sectie (booking-niveau) -------------------
    gh = _safe("group_hist", compute_group_buckets_overzicht, supabase, year=yc, **booking_kw)
    if gh is not None:
        out["group_hist"] = gh
    gm = _safe("group_by_month", compute_group_by_month_overzicht, supabase, year=yc, **booking_kw)
    if gm is not None:
        out["group_by_month"] = gm

    # -------------------- Leeftijd-secties --------------------------------
    am = _safe("age_by_month", compute_age_by_month, supabase, year=yc, **full_kw)
    if am is not None:
        out["age_by_month"] = am
    ab = _safe("age_by_brand", compute_age_by_brand, supabase, year=yc, **full_kw)
    if ab is not None:
        out["age_by_brand"] = ab
    ad = _safe("age_by_dest", compute_age_by_dest, supabase, year=yc, **full_kw)
    if ad is not None:
        out["age_by_dest"] = ad
    ah = _safe("age_hist", compute_age_hist, supabase, year=yc, **full_kw)
    if ah is not None and ah:
        out["age_hist"] = ah  # alleen overschrijven als we daadwerkelijk data hebben
    if enable_prev:
        ahp = _safe("age_hist_prev", compute_age_hist, supabase, year=yp, **full_kw)
        if ahp is not None:
            out["age_hist_prev"] = ahp

    # -------------------- Origin / Provincie ------------------------------
    op_cur = _safe("origin_pax_cur", compute_origin_pax, supabase, year=yc, **full_kw)
    if op_cur is not None and op_cur:
        out["origin_pax"] = op_cur
    if enable_prev:
        op_prev = _safe("origin_pax_prev", compute_origin_pax, supabase, year=yp, **full_kw)
        if op_prev is not None:
            out["origin_pax_prev"] = op_prev

    pp_cur = _safe("province_pax_cur", compute_province_pax, supabase, year=yc, **full_kw)
    if pp_cur is not None and pp_cur:
        out["province_pax"] = pp_cur
    pb_cur = _safe("province_bookings_cur", compute_province_bookings, supabase, year=yc, **full_kw)
    if pb_cur is not None and pb_cur:
        out["province_bookings"] = pb_cur
    if enable_prev:
        pp_prev = _safe("province_pax_prev", compute_province_pax, supabase, year=yp, **full_kw)
        if pp_prev is not None:
            out["province_pax_prev"] = pp_prev
        pb_prev = _safe(
            "province_bookings_prev", compute_province_bookings, supabase, year=yp, **full_kw
        )
        if pb_prev is not None:
            out["province_bookings_prev"] = pb_prev

    # -------------------- Brand-vergelijking ------------------------------
    bp_cur = _safe("brand_pax_cur", compute_brand_pax, supabase, year=yc, **full_kw)
    if bp_cur is not None and bp_cur:
        out["brand_pax_cur"] = bp_cur
    if enable_prev:
        bp_prev = _safe("brand_pax_prev", compute_brand_pax, supabase, year=yp, **full_kw)
        if bp_prev is not None:
            out["brand_pax_prev"] = [
                {"brand": r.get("brand"), "pax": r.get("pax")} for r in bp_prev
            ]
    bo = _safe("brand_origin_cur", compute_brand_origin, supabase, year=yc, **full_kw)
    if bo is not None:
        out["brand_origin_cur"] = bo

    # -------------------- BE/NL distributies ------------------------------
    dn = _safe("dest_be_nl", compute_dest_be_nl, supabase, year=yc, **full_kw)
    if dn is not None:
        out["dest_be_nl"] = dn
    mn = _safe("month_be_nl", compute_month_be_nl, supabase, year=yc, **full_kw)
    if mn is not None:
        out["month_be_nl"] = mn

    # -------------------- Maand-aggregaties -------------------------------
    mb = _safe("month_bookings", compute_month_bookings, supabase, year=yc, **full_kw)
    if mb is not None:
        out["month_bookings"] = mb

    return out
