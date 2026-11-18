-- RPC voor Boekingsgedrag maand-heatmap: alle rijen nodig voor
-- (1) boekingen/KPI op boekingsdatum, (2) reizigers op reis (overlap verblijf met kalendermaand).
-- Deploy handmatig in Supabase SQL editor indien nodig.

create or replace function public.dagtrends_heatmap_booking_years()
returns table (jaar integer)
language sql
stable
as $$
  select distinct extract(year from b.boekingsdatum)::int as jaar
  from public.boekingen b
  where b.boekingsdatum is not null
  order by 1 desc;
$$;


create or replace function public.dagtrends_heatmap_month_rows(
  p_brand text,
  p_bestemming_id uuid,
  p_left_year integer,
  p_right_year integer,
  p_month integer,
  p_limit integer,
  p_offset integer
)
returns table (
  boekingsdatum date,
  vertrekdatum date,
  terugkeerdatum date,
  aantal_reizigers integer,
  land text
)
language sql
stable
as $$
  with bounds as (
    select
      make_date(p_left_year, p_month, 1) as left_start,
      (make_date(p_left_year, p_month, 1) + interval '1 month' - interval '1 day')::date as left_end,
      make_date(p_right_year, p_month, 1) as right_start,
      (make_date(p_right_year, p_month, 1) + interval '1 month' - interval '1 day')::date as right_end
  )
  select
    b.boekingsdatum::date,
    b.vertrekdatum::date,
    b.terugkeerdatum::date,
    coalesce((
      select count(*)::integer
      from public.reizigers r3
      left join public.statussen stx on stx.id = r3.traveller_status_id
      where r3.boeking_id = b.id
        and not public.reiziger_status_uitgesloten_standaard_dashboards(stx.naam)
    ), 0)::integer as aantal_reizigers,
    (
      select r2.land
      from public.reizigers r2
      where r2.boeking_id = b.id
        and r2.land is not null
        and trim(r2.land) <> ''
      order by r2.id
      limit 1
    ) as land
  from public.boekingen b
  cross join bounds x
  where
    not public.boeking_id_excluded_from_standard_dashboards(b.id)
    and (p_brand = '__all__'
      or lower(trim(coalesce(b.brand, ''))) = lower(trim(p_brand)))
    and (p_bestemming_id is null or b.bestemming_id = p_bestemming_id)
    and p_month between 1 and 12
    and (
      (
        b.boekingsdatum is not null
        and extract(year from b.boekingsdatum)::int = p_left_year
        and extract(month from b.boekingsdatum)::int = p_month
      )
      or (
        b.boekingsdatum is not null
        and extract(year from b.boekingsdatum)::int = p_right_year
        and extract(month from b.boekingsdatum)::int = p_month
      )
      or (
        b.vertrekdatum is not null
        and b.vertrekdatum <= x.left_end
        and coalesce(b.terugkeerdatum, b.vertrekdatum) >= x.left_start
      )
      or (
        b.vertrekdatum is not null
        and b.vertrekdatum <= x.right_end
        and coalesce(b.terugkeerdatum, b.vertrekdatum) >= x.right_start
      )
    )
  order by
    case
      when b.boekingsdatum is not null
        and (
          (extract(year from b.boekingsdatum)::int = p_left_year
            and extract(month from b.boekingsdatum)::int = p_month)
          or (extract(year from b.boekingsdatum)::int = p_right_year
            and extract(month from b.boekingsdatum)::int = p_month)
        )
      then 0
      else 1
    end,
    b.boekingsdatum desc nulls last,
    b.vertrekdatum desc nulls last
  limit coalesce(nullif(p_limit, 0), 1000)
  offset coalesce(p_offset, 0);
$$;


-- Grondwaarheid voor KPI boekingen / pax op boekingsdag: alleen boekingen waar boekingsdatum in de maand valt.
-- Geen overlap-verblijfslogica; niet onderhevig aan limit/offset van dagtrends_heatmap_month_rows.
create or replace function public.dagtrends_heatmap_bookings_by_booking_date_month(
  p_brand text,
  p_bestemming_id uuid,
  p_year integer,
  p_month integer,
  p_country text
)
returns table (
  boekingsdag date,
  booking_count bigint,
  pax_sum bigint
)
language sql
stable
as $$
  select
    b.boekingsdatum::date as boekingsdag,
    count(*)::bigint as booking_count,
    coalesce(sum(
      coalesce((
        select count(*)::bigint
        from public.reizigers r3
        left join public.statussen stx on stx.id = r3.traveller_status_id
        where r3.boeking_id = b.id
          and not public.reiziger_status_uitgesloten_standaard_dashboards(stx.naam)
      ), 0)
    ), 0)::bigint as pax_sum
  from public.boekingen b
  where
    not public.boeking_id_excluded_from_standard_dashboards(b.id)
    and b.boekingsdatum is not null
    and extract(year from b.boekingsdatum)::int = p_year
    and extract(month from b.boekingsdatum)::int = p_month
    and (
      p_brand = '__all__'
      or lower(trim(coalesce(b.brand, ''))) = lower(trim(p_brand))
    )
    and (p_bestemming_id is null or b.bestemming_id = p_bestemming_id)
    and (
      p_country is null
      or trim(p_country) = ''
      or lower(trim(p_country)) in ('__all__', 'all')
      or (
        upper(trim(p_country)) = 'BE'
        and exists (
          select 1
          from public.reizigers r
          where r.boeking_id = b.id
            and upper(trim(coalesce(r.land, ''))) in ('BE', 'BELGIUM', 'BELGIE')
        )
      )
      or (
        upper(trim(p_country)) = 'NL'
        and exists (
          select 1
          from public.reizigers r
          where r.boeking_id = b.id
            and upper(trim(coalesce(r.land, ''))) in ('NL', 'NEDERLAND', 'NETHERLANDS')
        )
      )
    )
  group by b.boekingsdatum::date
  order by 1;
$$;
