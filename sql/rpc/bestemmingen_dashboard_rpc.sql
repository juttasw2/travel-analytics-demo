-- Bestemmingen dashboard: metrics + paginated table (kleine payload).
-- Secundaire filters (regio, doelgroep, accommodatie-type, seizoen) worden in SQL toegepast
-- op boekingsniveau: KPI's en grafieken sluiten aan op de gefilterde boekingen.
--
-- bestemmingen.regio: wordt hieronder aangemaakt als die nog ontbreekt (Supabase heeft die kolom vaak nog niet).
-- accommodaties."type" voor hotelcategorie.
-- Voer dit hele bestand uit in de Supabase SQL editor na bestemmingen_data_rpc.

do $migration$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'bestemmingen'
      and column_name = 'regio'
  ) then
    alter table public.bestemmingen add column regio text;
  end if;
end;
$migration$;

create or replace function public.bestemmingen_dashboard_rpc(
  p_brand text default '__all__',
  p_destination_id uuid default null,
  p_date_from date default null,
  p_date_to date default null,
  p_year int default 0,
  p_search text default null,
  p_sort text default 'bookings',
  p_sort_dir text default 'desc',
  p_page int default 1,
  p_page_size int default 25,
  p_region text default null,
  p_audience text default null,
  p_category text default null,
  p_season text default null
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
    'Onbekend'::text as bestemming_regio,
    b.doelgroep_id,
    dg.naam as doelgroep_naam,
    b.accommodatie_id,
    ac.naam as accommodatie_naam,
    coalesce(ac."type"::text, 'Onbekend') as accommodatie_categorie,
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
    and (
      p_region is null
      or trim(p_region) = ''
      or 'Onbekend' = trim(p_region)
    )
    and (
      p_audience is null
      or trim(p_audience) = ''
      or coalesce(dg.naam, 'Onbekend') = trim(p_audience)
    )
    and (
      p_category is null
      or trim(p_category) = ''
      or coalesce(ac."type"::text, 'Onbekend') = trim(p_category)
    )
    and (
      p_season is null
      or trim(p_season) = ''
      or (
        b.vertrekdatum is not null
        and (
          case
            when extract(month from b.vertrekdatum)::int in (12, 1, 2) then 'Winter'
            when extract(month from b.vertrekdatum)::int in (3, 4, 5) then 'Lente'
            when extract(month from b.vertrekdatum)::int in (6, 7, 8) then 'Zomer'
            else 'Herfst'
          end
        ) = trim(p_season)
      )
    )
),
totals as (
  select
    bestemming_id,
    max(bestemming_naam) as bestemming_naam,
    max(bestemming_regio) as bestemming_regio,
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
    coalesce(
      jsonb_agg(doelgroep_naam order by boekingen desc, doelgroep_naam) filter (where rn <= 2),
      '[]'::jsonb
    ) as target_audience_top2
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
              and a.doelgroep_naam = any(
                coalesce(
                  (select array_agg(x::text) from jsonb_array_elements_text(coalesce(aj.target_audience_top2, '[]'::jsonb)) as x),
                  array[]::text[]
                )
              )
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
    max(accommodatie_categorie) as hotel_category,
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
      jsonb_build_object(
        'hotel', hotel,
        'bookings', boekingen,
        'category', coalesce(hotel_category, 'Onbekend')
      )
      order by boekingen desc, hotel
    ) filter (where rn <= 5) as top_hotels
  from hotels_ranked
  group by bestemming_id
),
destinations as (
  select
    t.bestemming_id as id,
    coalesce(t.bestemming_naam, 'Onbekende bestemming') as naam,
    coalesce(t.bestemming_regio, 'Onbekend') as regio,
    coalesce(aj.target_audience_top2, '[]'::jsonb) as target_audience,
    coalesce(aj.booked_audiences, '[]'::jsonb) as booked_audiences,
    t.total_bookings,
    t.total_priced_bookings,
    t.total_revenue,
    case when t.total_priced_bookings > 0 then round(t.total_revenue / t.total_priced_bookings, 2) else 0 end as avg_booking_value,
    coalesce(hj.top_hotels, '[]'::jsonb) as top_hotels,
    coalesce(f.audience_fit_score, 0) as fit_score,
    case when coalesce(f.audience_fit_score, 0) >= 80
      then jsonb_build_array('Sterke doelgroep-fit.')
      else jsonb_build_array('Mogelijke mismatch tussen target en boekgedrag.')
    end as notes
  from totals t
  left join audiences_json aj on aj.bestemming_id = t.bestemming_id
  left join hotels_json hj on hj.bestemming_id = t.bestemming_id
  left join fit f on f.bestemming_id = t.bestemming_id
),
audience_global as (
  select coalesce(doelgroep_naam, 'Onbekend') as label, count(*)::int as c
  from filtered
  group by 1
),
trend_global as (
  select
    format('%s-%s', extract(year from boekingsdatum)::int, lpad(extract(month from boekingsdatum)::text, 2, '0')) as mkey,
    count(*)::int as c
  from filtered
  where boekingsdatum is not null
  group by extract(year from boekingsdatum), extract(month from boekingsdatum)
),
hotels_global as (
  select *
  from (
    select coalesce(accommodatie_naam, 'Onbekend hotel') as hname, count(*)::int as c
    from filtered
    group by 1
  ) hg
  order by c desc
  limit 7
),
tgt_agg as (
  select
    x.label::text as label,
    sum(t.total_bookings::numeric / nullif(greatest(jsonb_array_length(coalesce(aj.target_audience_top2, '[]'::jsonb)), 1), 0)) as v
  from totals t
  join audiences_json aj on aj.bestemming_id = t.bestemming_id
  cross join lateral jsonb_array_elements_text(coalesce(aj.target_audience_top2, '[]'::jsonb)) as x(label)
  group by x.label
),
page_params as (
  select
    greatest(1, coalesce(p_page, 1)) as pg,
    least(100, greatest(1, coalesce(p_page_size, 25))) as ps
),
destinations_search as (
  select d.*
  from destinations d
  where p_search is null
    or trim(p_search) = ''
    or lower(d.naam) like '%' || lower(trim(p_search)) || '%'
),
dest_count as (
  select count(*)::int as n from destinations_search
),
weighted_fit as (
  select
    case
      when coalesce(sum(t.total_bookings), 0) = 0 then 0
      else round(
        sum(coalesce(f.audience_fit_score, 0)::numeric * t.total_bookings::numeric)
        / nullif(sum(t.total_bookings), 0)::numeric
      )::int
    end as pct
  from totals t
  join fit f on f.bestemming_id = t.bestemming_id
),
kpis as (
  select
    coalesce((select sum(total_bookings) from totals), 0)::bigint as total_bookings,
    coalesce((select sum(total_priced_bookings) from totals), 0)::bigint as total_priced_bookings,
    coalesce((select sum(total_revenue) from totals), 0)::numeric as total_revenue,
    coalesce((select label from audience_global order by c desc limit 1), '-')::text as top_audience,
    coalesce((select hname from hotels_global order by c desc limit 1), '-')::text as top_hotel,
    (select pct from weighted_fit) as weighted_fit_pct
),
insights as (
  select jsonb_build_array(
    coalesce(
      (select format('%s genereert het hoogste volume met %s boekingen.', naam, total_bookings::text)
       from destinations_search order by total_bookings desc limit 1),
      'Geen data.'
    ),
    coalesce(
      (select format('%s heeft de hoogste gemiddelde boekingswaarde (%s).', naam, round(avg_booking_value, 2)::text)
       from destinations_search order by avg_booking_value desc nulls last limit 1),
      ''
    ),
    coalesce(
      (select format('Mismatch-opportuniteit: %s heeft een lage doelgroep-fit (%s%%).', naam, fit_score::text)
       from destinations_search where fit_score < 70 order by fit_score asc limit 1),
      ''
    )
  ) as arr
),
ordered as (
  select
    d.*,
    row_number() over (
      order by
        case when p_sort = 'name' and lower(p_sort_dir) = 'asc' then d.naam end asc,
        case when p_sort = 'name' and lower(p_sort_dir) <> 'asc' then d.naam end desc,
        case when p_sort = 'bookings' and lower(p_sort_dir) = 'asc' then d.total_bookings end asc nulls last,
        case when p_sort = 'bookings' and lower(p_sort_dir) <> 'asc' then d.total_bookings end desc nulls last,
        case when p_sort = 'revenue' and lower(p_sort_dir) = 'asc' then d.total_revenue end asc nulls last,
        case when p_sort = 'revenue' and lower(p_sort_dir) <> 'asc' then d.total_revenue end desc nulls last,
        case when p_sort = 'fit' and lower(p_sort_dir) = 'asc' then d.fit_score end asc nulls last,
        case when p_sort = 'fit' and lower(p_sort_dir) <> 'asc' then d.fit_score end desc nulls last,
        case when p_sort = 'target' and lower(p_sort_dir) = 'asc' then d.target_audience::text end asc,
        case when p_sort = 'target' and lower(p_sort_dir) <> 'asc' then d.target_audience::text end desc,
        case when p_sort = 'booked' and lower(p_sort_dir) = 'asc' then d.booked_audiences::text end asc,
        case when p_sort = 'booked' and lower(p_sort_dir) <> 'asc' then d.booked_audiences::text end desc,
        case when p_sort = 'hotel' and lower(p_sort_dir) = 'asc' then d.top_hotels::text end asc,
        case when p_sort = 'hotel' and lower(p_sort_dir) <> 'asc' then d.top_hotels::text end desc,
        d.total_bookings desc,
        d.naam asc
    ) as rn
  from destinations_search d
),
page_rows as (
  select o.*
  from ordered o
  cross join page_params pp
  where o.rn > (pp.pg - 1) * pp.ps
    and o.rn <= pp.pg * pp.ps
)
select jsonb_build_object(
  'metrics',
  jsonb_build_object(
    'kpis',
    jsonb_build_object(
      'totalBookings', (select total_bookings from kpis),
      'totalRevenue', (select total_revenue from kpis),
      'avgBookingValue',
        case when (select total_priced_bookings from kpis) > 0
          then round((select total_revenue from kpis) / (select total_priced_bookings from kpis), 2)
          else 0
        end,
      'topAudience', (select top_audience from kpis),
      'topHotel', (select top_hotel from kpis),
      'weightedFitPercent', (select weighted_fit_pct from kpis)
    ),
    'charts',
    jsonb_build_object(
      'audienceDistribution',
      jsonb_build_object(
        'labels', coalesce((select jsonb_agg(label order by c desc) from audience_global), '[]'::jsonb),
        'values', coalesce((select jsonb_agg(c order by c desc) from audience_global), '[]'::jsonb)
      ),
      'targetVsActual',
      coalesce(
        (
          select jsonb_build_object(
            'labels', jsonb_agg(lbl.label order by lbl.label),
            'target', jsonb_agg(coalesce(t.v, 0) order by lbl.label),
            'actual', jsonb_agg(coalesce(a.c, 0) order by lbl.label)
          )
          from (
            select distinct label
            from (
              select label from tgt_agg
              union
              select label from audience_global
            ) u
          ) lbl
          left join tgt_agg t on t.label = lbl.label
          left join audience_global a on a.label = lbl.label
        ),
        jsonb_build_object('labels', '[]'::jsonb, 'target', '[]'::jsonb, 'actual', '[]'::jsonb)
      ),
      'trend',
      coalesce((select jsonb_build_object(
        'labels', (select jsonb_agg(mkey order by mkey) from trend_global),
        'values', (select jsonb_agg(c order by mkey) from trend_global)
      )), '{}'::jsonb),
      'topHotels',
      jsonb_build_object(
        'labels', coalesce((select jsonb_agg(hname order by c desc) from hotels_global), '[]'::jsonb),
        'values', coalesce((select jsonb_agg(c order by c desc) from hotels_global), '[]'::jsonb)
      )
    ),
    'insights', coalesce((select arr from insights), '[]'::jsonb)
  ),
  'table_rows',
  coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'id', pr.id,
          'naam', pr.naam,
          'regio', pr.regio,
          'targetAudience', coalesce(pr.target_audience, '[]'::jsonb),
          'bookedAudiences', pr.booked_audiences,
          'totalBookings', pr.total_bookings,
          'totalPricedBookings', pr.total_priced_bookings,
          'totalRevenue', pr.total_revenue,
          'averageBookingValue', pr.avg_booking_value,
          'topHotels', pr.top_hotels,
          'audienceFitScore', pr.fit_score,
          'notes', pr.notes
        )
        order by pr.rn
      )
      from page_rows pr
    ),
    '[]'::jsonb
  ),
  'total_count', (select n from dest_count),
  'page', (select pg from page_params),
  'page_size', (select ps from page_params)
) as payload;
$$;
