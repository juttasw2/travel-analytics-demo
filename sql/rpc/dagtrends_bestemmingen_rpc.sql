-- Dagtrends + Bestemmingen DB-side aggregaties (Supabase RPC)
-- Voer dit script uit in Supabase SQL editor.

-- =========================
-- Performance indexes
-- =========================
create index if not exists idx_boekingen_brand_boekingsdatum
  on public.boekingen (brand, boekingsdatum);

create index if not exists idx_boekingen_brand_vertrekdatum
  on public.boekingen (brand, vertrekdatum);

create index if not exists idx_boekingen_bestemming_id
  on public.boekingen (bestemming_id);

create index if not exists idx_boekingen_doelgroep_id
  on public.boekingen (doelgroep_id);

create index if not exists idx_boekingen_accommodatie_id
  on public.boekingen (accommodatie_id);


-- =========================
-- Dagtrends panel payload
-- =========================
create or replace function public.dagtrends_panel_data_rpc(
  p_year int,
  p_month int,
  p_brand text default '__all__',
  p_destination_id uuid default null,
  p_date_type text default 'booking'
)
returns table(payload jsonb)
language sql
stable
as $$
with params as (
  select
    greatest(1, least(12, coalesce(p_month, 1))) as m,
    coalesce(p_year, extract(year from now())::int) as y
),
date_bounds as (
  select
    make_date(y, m, 1) as month_start,
    (make_date(y, m, 1) + interval '1 month')::date as month_end,
    y,
    m
  from params
),
base as (
  select
    b.*,
    coalesce(pf.totaal_te_betalen, 0)::numeric as totaal_te_betalen,
    coalesce(ap.actieve_reizigers, 0)::int as effectief_aantal_reizigers
  from public.boekingen b
  left join (
    select
      r.boeking_id,
      coalesce(sum(rf.totaal_te_betalen), 0)::numeric as totaal_te_betalen
    from public.reizigers r
    left join public.statussen st_tr on st_tr.id = r.traveller_status_id
    left join public.reiziger_financien rf on rf.reiziger_id = r.id
    where not public.reiziger_status_uitgesloten_standaard_dashboards(st_tr.naam)
    group by r.boeking_id
  ) pf on pf.boeking_id = b.id
  left join public.vw_actieve_reizigers_per_boeking ap on ap.boeking_id = b.id
  cross join date_bounds d
  where (p_brand = '__all__' or b.brand = p_brand)
    and (p_destination_id is null or b.bestemming_id = p_destination_id)
    and not public.boeking_id_excluded_from_standard_dashboards(b.id)
    and (
      (p_date_type = 'travel' and b.vertrekdatum >= d.month_start and b.vertrekdatum < d.month_end)
      or
      (p_date_type <> 'travel' and b.boekingsdatum >= d.month_start and b.boekingsdatum < d.month_end)
    )
),
aggregated as (
  select
    extract(day from case when p_date_type = 'travel' then b.vertrekdatum else b.boekingsdatum end)::int as dag,
    count(*)::int as boekingen,
    coalesce(sum(coalesce(b.effectief_aantal_reizigers, 0)), 0)::int as reizigers,
    coalesce(sum(coalesce(b.totaal_te_betalen, 0)), 0)::numeric as omzet
  from base b
  group by 1
),
days as (
  select
    g::int as dag
  from date_bounds d
  cross join generate_series(1, extract(day from (d.month_end - interval '1 day'))::int) g
),
full_days as (
  select
    d.dag,
    coalesce(a.boekingen, 0)::int as boekingen,
    coalesce(a.reizigers, 0)::int as reizigers,
    coalesce(a.omzet, 0)::numeric as omzet,
    case when coalesce(a.boekingen, 0) > 0
      then round((coalesce(a.omzet, 0)::numeric / a.boekingen::numeric), 2)
      else 0::numeric
    end as avg_dag
  from days d
  left join aggregated a on a.dag = d.dag
  order by d.dag
),
month_names as (
  select m.naam, m.ord
  from unnest(array[
    'januari','februari','maart','april','mei','juni',
    'juli','augustus','september','oktober','november','december'
  ]) with ordinality as m(naam, ord)
),
peak as (
  select coalesce((select dag from full_days order by boekingen desc, dag asc limit 1), 1) as peak_day
)
select jsonb_build_object(
  'year', d.y,
  'month', d.m,
  'month_name', (select naam from month_names where ord = d.m),
  'dim', (select count(*) from full_days),
  'bookings_by_day', (select jsonb_agg(f.boekingen order by f.dag) from full_days f),
  'travellers_by_day', (select jsonb_agg(f.reizigers order by f.dag) from full_days f),
  'avg_by_day', (select jsonb_agg(f.avg_dag order by f.dag) from full_days f),
  'revenue_by_day', (select jsonb_agg(f.omzet order by f.dag) from full_days f),
  'peak_day', (select peak_day from peak)
) as payload
from date_bounds d;
$$;


-- =========================
-- Bestemmingen dashboard payload
-- =========================
create or replace function public.bestemmingen_data_rpc(
  p_brand text default '__all__',
  p_destination_id uuid default null,
  p_date_from date default null,
  p_date_to date default null,
  p_year int default 0
)
returns table(payload jsonb)
language sql
stable
as $$
with active_pax as (
  select
    v.boeking_id,
    v.actieve_reizigers
  from public.vw_actieve_reizigers_per_boeking v
),
filtered as (
  select
    b.id,
    b.bestemming_id,
    be.naam as bestemming_naam,
    b.doelgroep_id,
    dg.naam as doelgroep_naam,
    b.accommodatie_id,
    ac.naam as accommodatie_naam,
    b.boekingsdatum,
    b.vertrekdatum,
    coalesce(ap.actieve_reizigers, 0)::int as aantal_reizigers,
    coalesce(pf.totaal_te_betalen, 0)::numeric as omzet
  from public.boekingen b
  left join (
    select
      r.boeking_id,
      coalesce(sum(rf.totaal_te_betalen), 0)::numeric as totaal_te_betalen
    from public.reizigers r
    left join public.statussen st_tr on st_tr.id = r.traveller_status_id
    left join public.reiziger_financien rf on rf.reiziger_id = r.id
    where not public.reiziger_status_uitgesloten_standaard_dashboards(st_tr.naam)
    group by r.boeking_id
  ) pf on pf.boeking_id = b.id
  left join active_pax ap on ap.boeking_id = b.id
  left join public.bestemmingen be on be.id = b.bestemming_id
  left join public.doelgroepen dg on dg.id = b.doelgroep_id
  left join public.accommodaties ac on ac.id = b.accommodatie_id
  where (p_brand = '__all__' or b.brand = p_brand)
    and not public.boeking_id_excluded_from_standard_dashboards(b.id)
    and (p_destination_id is null or b.bestemming_id = p_destination_id)
    and (p_date_from is null or b.boekingsdatum >= p_date_from)
    and (p_date_to is null or b.boekingsdatum <= p_date_to)
    and (coalesce(p_year, 0) = 0 or extract(year from b.boekingsdatum)::int = p_year)
),
totals as (
  select
    bestemming_id,
    max(bestemming_naam) as bestemming_naam,
    count(*)::int as total_bookings,
    count(*) filter (where coalesce(omzet, 0) > 0)::int as total_priced_bookings,
    coalesce(sum(omzet), 0)::numeric as total_revenue
  from filtered
  group by bestemming_id
),
audiences as (
  select
    bestemming_id,
    coalesce(doelgroep_naam, 'Onbekend') as doelgroep_naam,
    count(*)::int as boekingen
  from filtered
  group by bestemming_id, coalesce(doelgroep_naam, 'Onbekend')
),
audiences_ranked as (
  select
    a.*,
    row_number() over (partition by a.bestemming_id order by a.boekingen desc, a.doelgroep_naam) as rn
  from audiences a
),
audiences_json as (
  select
    bestemming_id,
    jsonb_agg(
      jsonb_build_object('label', doelgroep_naam, 'count', boekingen)
      order by boekingen desc, doelgroep_naam
    ) as booked_audiences,
    jsonb_agg(doelgroep_naam order by boekingen desc, doelgroep_naam) filter (where rn <= 2) as target_audience_top2
  from audiences_ranked
  group by bestemming_id
),
fit as (
  select
    t.bestemming_id,
    case
      when t.total_bookings = 0 then 0
      else round(
        (
          coalesce((
            select sum(a.boekingen)
            from audiences a
            where a.bestemming_id = t.bestemming_id
              and a.doelgroep_naam = any(coalesce((select array_agg(x::text) from jsonb_array_elements_text(aj.target_audience_top2) as x), array[]::text[]))
          ), 0)::numeric / t.total_bookings::numeric
        ) * 100
      )::int
    end as audience_fit_score
  from totals t
  left join audiences_json aj on aj.bestemming_id = t.bestemming_id
),
hotels as (
  select
    bestemming_id,
    coalesce(accommodatie_naam, 'Onbekend hotel') as hotel,
    count(*)::int as boekingen
  from filtered
  group by bestemming_id, coalesce(accommodatie_naam, 'Onbekend hotel')
),
hotels_ranked as (
  select
    h.*,
    row_number() over (partition by h.bestemming_id order by h.boekingen desc, h.hotel) as rn
  from hotels h
),
hotels_json as (
  select
    bestemming_id,
    jsonb_agg(
      jsonb_build_object('hotel', hotel, 'bookings', boekingen, 'category', 'Onbekend')
      order by boekingen desc, hotel
    ) filter (where rn <= 5) as top_hotels
  from hotels_ranked
  group by bestemming_id
),
trends as (
  select
    bestemming_id,
    extract(year from boekingsdatum)::int as jaar,
    extract(month from boekingsdatum)::int as maand,
    count(*)::int as boekingen
  from filtered
  where boekingsdatum is not null
  group by bestemming_id, extract(year from boekingsdatum), extract(month from boekingsdatum)
),
trends_json as (
  select
    bestemming_id,
    jsonb_agg(
      jsonb_build_object('month', format('%s-%s', jaar, lpad(maand::text, 2, '0')), 'bookings', boekingen)
      order by jaar, maand
    ) as trend
  from trends
  group by bestemming_id
),
season_source as (
  select
    bestemming_id,
    extract(month from vertrekdatum)::int as vertrekmaand
  from filtered
  where vertrekdatum is not null
),
seasons as (
  select
    bestemming_id,
    case
      when vertrekmaand in (12,1,2) then 'Winter'
      when vertrekmaand in (3,4,5) then 'Lente'
      when vertrekmaand in (6,7,8) then 'Zomer'
      else 'Herfst'
    end as seizoen,
    count(*)::int as boekingen
  from season_source
  group by
    bestemming_id,
    case
      when vertrekmaand in (12,1,2) then 'Winter'
      when vertrekmaand in (3,4,5) then 'Lente'
      when vertrekmaand in (6,7,8) then 'Zomer'
      else 'Herfst'
    end
),
seasons_ranked as (
  select
    s.*,
    row_number() over (partition by s.bestemming_id order by s.boekingen desc, s.seizoen) as rn
  from seasons s
),
seasons_json as (
  select
    bestemming_id,
    jsonb_agg(seizoen order by boekingen desc, seizoen) filter (where rn <= 2) as vertrekmaanden
  from seasons_ranked
  group by bestemming_id
),
destinations as (
  select
    t.bestemming_id as id,
    coalesce(t.bestemming_naam, 'Onbekende bestemming') as naam,
    'Onbekend'::text as regio,
    coalesce(aj.target_audience_top2, '[]'::jsonb) as target_audience,
    coalesce(aj.booked_audiences, '[]'::jsonb) as booked_audiences,
    t.total_bookings,
    t.total_priced_bookings,
    t.total_revenue,
    case when t.total_priced_bookings > 0 then round(t.total_revenue / t.total_priced_bookings, 2) else 0 end as avg_booking_value,
    coalesce(hj.top_hotels, '[]'::jsonb) as top_hotels,
    coalesce(tj.trend, '[]'::jsonb) as trend,
    coalesce(f.audience_fit_score, 0) as fit_score,
    coalesce(sj.vertrekmaanden, '[]'::jsonb) as vertrekmaanden,
    case when coalesce(f.audience_fit_score, 0) >= 80
      then jsonb_build_array('Sterke doelgroep-fit.')
      else jsonb_build_array('Mogelijke mismatch tussen target en boekgedrag.')
    end as notes
  from totals t
  left join audiences_json aj on aj.bestemming_id = t.bestemming_id
  left join hotels_json hj on hj.bestemming_id = t.bestemming_id
  left join trends_json tj on tj.bestemming_id = t.bestemming_id
  left join fit f on f.bestemming_id = t.bestemming_id
  left join seasons_json sj on sj.bestemming_id = t.bestemming_id
),
meta as (
  select jsonb_build_object(
    'topAudience', coalesce((select doelgroep_naam from audiences order by boekingen desc limit 1), '-'),
    'topHotel', coalesce((select hotel from hotels order by boekingen desc limit 1), '-'),
    'rowCount', coalesce((select sum(total_bookings) from totals), 0)
  ) as m
)
select jsonb_build_object(
  'destinations',
  coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'id', d.id,
          'naam', d.naam,
          'regio', d.regio,
          'targetAudience', d.target_audience,
          'bookedAudiences', d.booked_audiences,
          'totalBookings', d.total_bookings,
          'totalPricedBookings', d.total_priced_bookings,
          'totalRevenue', d.total_revenue,
          'averageBookingValue', d.avg_booking_value,
          'topHotels', d.top_hotels,
          'bookingTrendOverTime', d.trend,
          'audienceFitScore', d.fit_score,
          'notes', d.notes,
          'vertrekmaanden', d.vertrekmaanden
        )
        order by d.total_bookings desc, d.naam
      )
      from destinations d
    ),
    '[]'::jsonb
  ),
  'meta',
  (select m from meta)
) as payload;
$$;
