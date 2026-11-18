-- RPC functies voor het "Overzicht" dashboard.
-- Belangrijk: we wijzigen geen tabellen/kolommen uit je DDL.
-- We verplaatsen alleen aggregatie-logica naar SQL functions zodat
-- PostgREST aggregate-functies niet via REST hoeven (db-aggregates-enabled).

-- 1) Merken die bestaan in `boekingen` (binnen de vaste set)
create or replace function public.overzicht_brands()
returns table(brand text)
language sql
stable
as $$
  with merken as (
    select
      case
        when lower(trim(brand)) = 'sun escapes' then 'Sun Escapes'
        when lower(trim(brand)) = 'snow escapes' then 'Snow Escapes'
        when lower(trim(brand)) = 'road rebels' then 'Road Rebels'
      end as brand
    from boekingen
    where lower(trim(brand)) in ('sun escapes', 'snow escapes', 'road rebels')
    group by
      case
        when lower(trim(brand)) = 'sun escapes' then 'Sun Escapes'
        when lower(trim(brand)) = 'snow escapes' then 'Snow Escapes'
        when lower(trim(brand)) = 'road rebels' then 'Road Rebels'
      end
  )
  select brand
  from merken
  order by
    case brand
      when 'Sun Escapes' then 1
      when 'Snow Escapes' then 2
      when 'Road Rebels' then 3
      else 99
    end;
$$;

-- 2) Jaren die bestaan voor een merk (op basis van vertrekdatum)
create or replace function public.overzicht_years(p_brand text)
returns table(jaar int)
language sql
stable
as $$
  select distinct extract(year from vertrekdatum)::int as jaar
  from boekingen
  where vertrekdatum is not null
    and (
      p_brand = '__all__'
      or lower(trim(brand)) = lower(trim(p_brand))
    )
  order by jaar;
$$;

-- 3) Volledige dashboard data in één RPC call.
--    Season logic:
--    - Sun Escapes & Road Rebels: start = MIN(vertrekdatum) in gekozen jaar, end = MAX(vertrekdatum) in gekozen jaar
--    - Snow Escapes: start = 1 Dec van vorig jaar, end = MAX(vertrekdatum) in gekozen jaar
create or replace function public.overzicht_dashboard(
  p_brand text,
  p_destination_id uuid,
  p_year int,
  p_brand_land text default '__ALL__'
)
returns table(payload jsonb)
language plpgsql
stable
as $$
declare
  start_date date;
  end_date date;
  start_date_prev date := null;
  end_date_prev date := null;
  destination_naam text;
begin
  -- Compute season bounds (op basis van vertrekdatum)
  -- p_year <= 0  => "Alle jaren"
  -- p_brand = '__all__' => "Alle merken" (negeert de Snow Escapes uitzondering)
  if p_year is null or p_year <= 0 then
    select min(b.vertrekdatum), max(b.vertrekdatum) into start_date, end_date
    from boekingen b
    where (p_brand = '__all__' or lower(trim(b.brand)) = lower(trim(p_brand)));
  elsif p_brand = '__all__' then
    select min(b.vertrekdatum), max(b.vertrekdatum) into start_date, end_date
    from boekingen b
    where b.vertrekdatum between make_date(p_year, 1, 1) and make_date(p_year, 12, 31);
  elsif p_brand = 'Snow Escapes' then
    start_date := make_date(p_year - 1, 12, 1);
    select max(b.vertrekdatum) into end_date
    from boekingen b
    where lower(trim(b.brand)) = lower(trim(p_brand))
      and b.vertrekdatum between make_date(p_year, 1, 1) and make_date(p_year, 12, 31);
  else
    select min(b.vertrekdatum), max(b.vertrekdatum) into start_date, end_date
    from boekingen b
    where lower(trim(b.brand)) = lower(trim(p_brand))
      and b.vertrekdatum between make_date(p_year, 1, 1) and make_date(p_year, 12, 31);
  end if;

  -- Zelfde seizoenslogica één jaar terug (alleen voor KPI-vergelijking; vereist één kalenderjaar > 0)
  if p_year is not null and p_year > 0 then
    if p_brand = '__all__' then
      select min(b.vertrekdatum), max(b.vertrekdatum) into start_date_prev, end_date_prev
      from boekingen b
      where b.vertrekdatum between make_date(p_year - 1, 1, 1) and make_date(p_year - 1, 12, 31);
    elsif p_brand = 'Snow Escapes' then
      start_date_prev := make_date(p_year - 2, 12, 1);
      select max(b.vertrekdatum) into end_date_prev
      from boekingen b
      where lower(trim(b.brand)) = lower(trim(p_brand))
        and b.vertrekdatum between make_date(p_year - 1, 1, 1) and make_date(p_year - 1, 12, 31);
    else
      select min(b.vertrekdatum), max(b.vertrekdatum) into start_date_prev, end_date_prev
      from boekingen b
      where lower(trim(b.brand)) = lower(trim(p_brand))
        and b.vertrekdatum between make_date(p_year - 1, 1, 1) and make_date(p_year - 1, 12, 31);
    end if;
    if start_date_prev is null or end_date_prev is null then
      start_date_prev := null;
      end_date_prev := null;
    end if;
  end if;

  if start_date is null or end_date is null then
    return query
    select jsonb_build_object(
      'kpis', jsonb_build_object(
        'total_boekingen', 0,
        'total_reizigers', 0,
        'total_omzet', 0,
        'top_bestemming', null
      ),
      'top_bestemming', null,
      'meest_populaire_reisperiode', null,
      'booking_trend', '[]'::jsonb,
      'destination_lijst', '[]'::jsonb,
      'destination_naam', null,
      'popular_destinations_overall', '[]'::jsonb,
      'popular_departure_dates_overall', '[]'::jsonb,
      'popular_travel_periods_overall', '[]'::jsonb,
      'popular_travel_periods_destination', '[]'::jsonb
    ) as payload;
    return;
  end if;

  if p_destination_id is not null then
    select d.naam into destination_naam
    from bestemmingen d
    where d.id = p_destination_id;
  else
    destination_naam := null;
  end if;

  return query
  with
  season as (
    select start_date::date as start_date, end_date::date as end_date
  ),
  per_booking_financien as (
    select
      r.boeking_id,
      coalesce(sum(rf.totaal_te_betalen), 0)::numeric as totaal_te_betalen
    from reizigers r
    left join public.statussen st_tr on st_tr.id = r.traveller_status_id
    left join reiziger_financien rf on rf.reiziger_id = r.id
    where not public.reiziger_status_uitgesloten_standaard_dashboards(st_tr.naam)
    group by r.boeking_id
  ),
  active_pax as (
    select
      v.boeking_id,
      v.actieve_reizigers
    from public.vw_actieve_reizigers_per_boeking v
  ),
  -- Rijen in `reizigers` (elke status): om te bepalen of we KPI-pax uit de view halen
  -- of terugvallen op boekingen.aantal_reizigers (upload zonder child-rijen / oude data).
  reiziger_rows_per_booking as (
    select
      r.boeking_id,
      count(*)::int as n_rows
    from public.reizigers r
    group by r.boeking_id
  ),
  filtered_overall as (
    select
      b.*,
      coalesce(pf.totaal_te_betalen, 0)::numeric as omzet_actieve_reizigers
    from boekingen b
    left join per_booking_financien pf on pf.boeking_id = b.id
    cross join season s
    where (p_brand = '__all__' or lower(trim(b.brand)) = lower(trim(p_brand)))
      and (
        p_brand_land is null
        or trim(p_brand_land) = ''
        or lower(trim(p_brand_land)) in ('__all__', 'all')
        or upper(trim(coalesce(b.brand_land, ''))) = upper(trim(p_brand_land))
      )
      and b.vertrekdatum between s.start_date and s.end_date
      -- Gewone dashboards: alleen boekingstatus cancelled/dropped-blacklist (geen reizigers-op-boeking exclude)
      and not public.boeking_id_excluded_from_standard_dashboards(b.id)
  ),
  filtered_dest as (
    select
      b.*,
      coalesce(pf.totaal_te_betalen, 0)::numeric as omzet_actieve_reizigers
    from boekingen b
    left join per_booking_financien pf on pf.boeking_id = b.id
    cross join season s
    where (p_brand = '__all__' or lower(trim(b.brand)) = lower(trim(p_brand)))
      and (
        p_brand_land is null
        or trim(p_brand_land) = ''
        or lower(trim(p_brand_land)) in ('__all__', 'all')
        or upper(trim(coalesce(b.brand_land, ''))) = upper(trim(p_brand_land))
      )
      and b.vertrekdatum between s.start_date and s.end_date
      and (p_destination_id is null or b.bestemming_id = p_destination_id)
      and not public.boeking_id_excluded_from_standard_dashboards(b.id)
  ),
  filtered_dest_prev as (
    select
      b.*,
      coalesce(pf.totaal_te_betalen, 0)::numeric as omzet_actieve_reizigers
    from boekingen b
    left join per_booking_financien pf on pf.boeking_id = b.id
    where start_date_prev is not null
      and end_date_prev is not null
      and b.vertrekdatum between start_date_prev and end_date_prev
      and (p_brand = '__all__' or lower(trim(b.brand)) = lower(trim(p_brand)))
      and (
        p_brand_land is null
        or trim(p_brand_land) = ''
        or lower(trim(p_brand_land)) in ('__all__', 'all')
        or upper(trim(coalesce(b.brand_land, ''))) = upper(trim(p_brand_land))
      )
      and (p_destination_id is null or b.bestemming_id = p_destination_id)
      and not public.boeking_id_excluded_from_standard_dashboards(b.id)
  ),
  totals_prev as (
    select
      count(b.id)::int as total_boekingen,
      coalesce(sum(
        coalesce(
          ap.actieve_reizigers,
          case
            when coalesce(rc.n_rows, 0) = 0 then coalesce(b.aantal_reizigers, 0)
            else 0
          end
        )
      ), 0)::int as total_reizigers,
      coalesce(sum(coalesce(b.omzet_actieve_reizigers, 0)), 0)::double precision as total_omzet
    from filtered_dest_prev b
    left join active_pax ap on ap.boeking_id = b.id
    left join reiziger_rows_per_booking rc on rc.boeking_id = b.id
  ),
  totals as (
    select
      count(b.id)::int as total_boekingen,
      coalesce(sum(
        coalesce(
          ap.actieve_reizigers,
          case
            when coalesce(rc.n_rows, 0) = 0 then coalesce(b.aantal_reizigers, 0)
            else 0
          end
        )
      ), 0)::int as total_reizigers,
      coalesce(sum(coalesce(b.omzet_actieve_reizigers, 0)), 0)::double precision as total_omzet
    from filtered_dest b
    left join active_pax ap on ap.boeking_id = b.id
    left join reiziger_rows_per_booking rc on rc.boeking_id = b.id
  ),
  dest_counts_overall as (
    select
      fo.bestemming_id,
      d.naam,
      coalesce(sum(
        coalesce(
          ap.actieve_reizigers,
          case
            when coalesce(rc.n_rows, 0) = 0 then coalesce(fo.aantal_reizigers, 0)
            else 0
          end
        )
      ), 0)::int as reizigers_totaal,
      count(fo.id)::int as boekingen_count
    from filtered_overall fo
    join bestemmingen d on d.id = fo.bestemming_id
    left join active_pax ap on ap.boeking_id = fo.id
    left join reiziger_rows_per_booking rc on rc.boeking_id = fo.id
    group by fo.bestemming_id, d.naam
  ),
  dest_counts_filtered as (
    select
      fd.bestemming_id,
      d.naam,
      count(fd.id)::int as boekingen_count
    from filtered_dest fd
    join bestemmingen d on d.id = fd.bestemming_id
    group by fd.bestemming_id, d.naam
  ),
  top_bestemming_cte as (
    select
      dc.naam,
      dc.boekingen_count as boekingen
    from dest_counts_filtered dc
    order by dc.boekingen_count desc
    limit 1
  ),
  /*
   * Reizigers-trend op basis van vertrekdatum.
   * - Gekozen jaar (>0): alle kalendermaanden jan–dec van dat jaar.
   * - Alle jaren: van eerste tot laatste vertrekmaand binnen actieve filters.
   * Inclusief vorige-jaar vergelijking op dezelfde vertrekmaanden.
   */
  booking_trend_bounds as (
    select
      case
        when p_year is null or p_year <= 0 then mb.min_vd
        else make_date(p_year, 1, 1)
      end as b_start,
      case
        when p_year is null or p_year <= 0 then mb.max_vd
        else make_date(p_year, 12, 31)
      end as b_end
    from (
      select
        min(b.vertrekdatum::date) as min_vd,
        max(b.vertrekdatum::date) as max_vd
      from boekingen b
      where (p_brand = '__all__' or lower(trim(b.brand)) = lower(trim(p_brand)))
        and (p_destination_id is null or b.bestemming_id = p_destination_id)
        and (
          p_brand_land is null
          or trim(p_brand_land) = ''
          or lower(trim(p_brand_land)) in ('__all__', 'all')
          or upper(trim(coalesce(b.brand_land, ''))) = upper(trim(p_brand_land))
        )
        and b.vertrekdatum is not null
        and not public.boeking_id_excluded_from_standard_dashboards(b.id)
    ) mb
  ),
  booking_trend_months as (
    select
      extract(year from gs.m)::int as jaar,
      extract(month from gs.m)::int as maand
    from booking_trend_bounds bb
    cross join lateral generate_series(
      date_trunc('month', bb.b_start::timestamp)::date,
      date_trunc('month', bb.b_end::timestamp)::date,
      interval '1 month'
    ) as gs(m)
    where bb.b_start is not null and bb.b_end is not null
  ),
  booking_trend_agg as (
    select
      extract(year from b.vertrekdatum)::int as jaar,
      extract(month from b.vertrekdatum)::int as maand,
      coalesce(sum(
        coalesce(
          ap.actieve_reizigers,
          case
            when coalesce(rc.n_rows, 0) = 0 then coalesce(b.aantal_reizigers, 0)
            else 0
          end
        )
      ), 0)::int as totaal_reizigers
    from boekingen b
    cross join booking_trend_bounds bb
    left join active_pax ap on ap.boeking_id = b.id
    left join reiziger_rows_per_booking rc on rc.boeking_id = b.id
    where (p_brand = '__all__' or lower(trim(b.brand)) = lower(trim(p_brand)))
      and (p_destination_id is null or b.bestemming_id = p_destination_id)
      and (
        p_brand_land is null
        or trim(p_brand_land) = ''
        or lower(trim(p_brand_land)) in ('__all__', 'all')
        or upper(trim(coalesce(b.brand_land, ''))) = upper(trim(p_brand_land))
      )
      and b.vertrekdatum is not null
      and bb.b_start is not null
      and bb.b_end is not null
      and b.vertrekdatum::date between bb.b_start and bb.b_end
      and not public.boeking_id_excluded_from_standard_dashboards(b.id)
    group by extract(year from b.vertrekdatum), extract(month from b.vertrekdatum)
  ),
  booking_trend_prev_agg as (
    select
      extract(month from b.vertrekdatum)::int as maand,
      coalesce(sum(
        coalesce(
          ap.actieve_reizigers,
          case
            when coalesce(rc.n_rows, 0) = 0 then coalesce(b.aantal_reizigers, 0)
            else 0
          end
        )
      ), 0)::int as totaal_reizigers_prev
    from boekingen b
    left join active_pax ap on ap.boeking_id = b.id
    left join reiziger_rows_per_booking rc on rc.boeking_id = b.id
    where p_year is not null
      and p_year > 0
      and extract(year from b.vertrekdatum)::int = p_year - 1
      and (p_brand = '__all__' or lower(trim(b.brand)) = lower(trim(p_brand)))
      and (p_destination_id is null or b.bestemming_id = p_destination_id)
      and (
        p_brand_land is null
        or trim(p_brand_land) = ''
        or lower(trim(p_brand_land)) in ('__all__', 'all')
        or upper(trim(coalesce(b.brand_land, ''))) = upper(trim(p_brand_land))
      )
      and not public.boeking_id_excluded_from_standard_dashboards(b.id)
    group by extract(month from b.vertrekdatum)
  ),
  booking_trend as (
    select
      mm.jaar,
      mm.maand,
      coalesce(a.totaal_reizigers, 0)::int as totaal_reizigers,
      case
        when p_year is not null and p_year > 0 and mm.jaar = p_year
          then coalesce(ap.totaal_reizigers_prev, 0)::int
        else null
      end as totaal_reizigers_prev
    from booking_trend_months mm
    left join booking_trend_agg a
      on a.jaar = mm.jaar and a.maand = mm.maand
    left join booking_trend_prev_agg ap
      on ap.maand = mm.maand
  ),
  popular_departure_overall as (
    select
      fd.vertrekdatum::date as vertrekdatum,
      coalesce(sum(
        coalesce(
          ap.actieve_reizigers,
          case
            when coalesce(rc.n_rows, 0) = 0 then coalesce(fd.aantal_reizigers, 0)
            else 0
          end
        )
      ), 0)::bigint as reizigers_totaal
    from filtered_dest fd
    left join active_pax ap on ap.boeking_id = fd.id
    left join reiziger_rows_per_booking rc on rc.boeking_id = fd.id
    where fd.vertrekdatum is not null
    group by fd.vertrekdatum::date
    order by reizigers_totaal desc, vertrekdatum asc
    limit 20
  ),
  popular_travel_overall as (
    select
      extract(week from fo.vertrekdatum)::int as week,
      coalesce(sum(
        coalesce(
          ap.actieve_reizigers,
          case
            when coalesce(rc.n_rows, 0) = 0 then coalesce(fo.aantal_reizigers, 0)
            else 0
          end
        )
      ), 0)::bigint as reizigers_sum
    from filtered_overall fo
    left join active_pax ap on ap.boeking_id = fo.id
    left join reiziger_rows_per_booking rc on rc.boeking_id = fo.id
    group by extract(week from fo.vertrekdatum)
  ),
  herkomst_per_land_destination as (
    /*
      Herkomst (land) per reiziger binnen EXACT dezelfde filters als KPI `total_reizigers`.

      - Voor bookings mét reiziger-rijen: tel actieve reizigers per `r.land`
        (actief = niet uitgesloten via public.reiziger_status_uitgesloten_standaard_dashboards).
      - Voor legacy bookings zónder reiziger-rijen: attribueer `fd.aantal_reizigers` aan 'Onbekend'
        zodat de som altijd kan matchen met KPI `total_reizigers`.
    */
    select
      x.land,
      sum(x.aantal_reizigers)::int as aantal_reizigers
    from (
      -- Actieve reizigers per land (bookingfilters zitten in filtered_dest)
      select
        coalesce(nullif(trim(r.land), ''), 'Onbekend') as land,
        count(*)::int as aantal_reizigers
      from filtered_dest fd
      join reizigers r on r.boeking_id = fd.id
      left join public.statussen st_tr on st_tr.id = r.traveller_status_id
      left join reiziger_rows_per_booking rc on rc.boeking_id = fd.id
      where p_destination_id is not null
        and coalesce(rc.n_rows, 0) > 0
        and not public.reiziger_status_uitgesloten_standaard_dashboards(st_tr.naam)
      group by coalesce(nullif(trim(r.land), ''), 'Onbekend')

      union all

      -- Legacy: geen reiziger-rijen => alles valt terug op booking.aantal_reizigers
      select
        'Onbekend'::text as land,
        coalesce(sum(fd.aantal_reizigers), 0)::int as aantal_reizigers
      from filtered_dest fd
      left join reiziger_rows_per_booking rc on rc.boeking_id = fd.id
      where p_destination_id is not null
        and coalesce(rc.n_rows, 0) = 0
      group by 'Onbekend'::text
    ) x
    group by x.land
    order by aantal_reizigers desc, land asc
  ),
  meest_populaire_week as (
    select
      p.week,
      p.reizigers_sum
    from (
      select
        extract(week from fd.vertrekdatum)::int as week,
        coalesce(sum(
          coalesce(
            ap.actieve_reizigers,
            case
              when coalesce(rc.n_rows, 0) = 0 then coalesce(fd.aantal_reizigers, 0)
              else 0
            end
          )
        ), 0)::bigint as reizigers_sum
      from filtered_dest fd
      left join active_pax ap on ap.boeking_id = fd.id
      left join reiziger_rows_per_booking rc on rc.boeking_id = fd.id
      group by extract(week from fd.vertrekdatum)
    ) p
    order by p.reizigers_sum desc
    limit 1
  ),
  destination_lijst as (
    select
      fo.bestemming_id as id,
      d.naam
    from filtered_overall fo
    join bestemmingen d on d.id = fo.bestemming_id
    group by fo.bestemming_id, d.naam
  )
  select jsonb_build_object(
    'kpis', jsonb_build_object(
      'total_boekingen', (select total_boekingen from totals),
      'total_reizigers', (select total_reizigers from totals),
      'total_omzet', (select total_omzet from totals),
      'top_bestemming',
        (select jsonb_build_object('naam', naam, 'boekingen', boekingen) from top_bestemming_cte),
      'prev_year', case
        when p_year is null or p_year <= 0 then null::jsonb
        when start_date_prev is null or end_date_prev is null then null::jsonb
        else jsonb_build_object(
          'total_boekingen', (select total_boekingen from totals_prev),
          'total_reizigers', (select total_reizigers from totals_prev),
          'total_omzet', (select total_omzet from totals_prev)
        )
      end
    ),
    'top_bestemming',
      (select jsonb_build_object('naam', naam, 'boekingen', boekingen) from top_bestemming_cte),
    'meest_populaire_reisperiode',
      (select jsonb_build_object('week', week, 'reizigers_sum', reizigers_sum) from meest_populaire_week),
    'booking_trend',
      COALESCE((
        select jsonb_agg(
          jsonb_build_object('jaar', jaar, 'maand', maand, 'totaal_reizigers', totaal_reizigers)
          || jsonb_build_object('totaal_reizigers_prev', totaal_reizigers_prev)
          order by jaar, maand
        )
        from booking_trend
      ), '[]'::jsonb),
    'destination_lijst',
      COALESCE((
        select jsonb_agg(jsonb_build_object('id', id, 'naam', naam) order by naam)
        from destination_lijst
      ), '[]'::jsonb),
    'destination_naam', destination_naam,
    'popular_destinations_overall',
      COALESCE((
        select jsonb_agg(
          jsonb_build_object(
            'id', bestemming_id,
            'naam', naam,
            'reizigers_totaal', reizigers_totaal,
            'boekingen_count', boekingen_count
          )
          order by reizigers_totaal desc, boekingen_count desc
        )
        from dest_counts_overall
      ), '[]'::jsonb),
    'popular_departure_dates_overall',
      COALESCE((
        select jsonb_agg(
          jsonb_build_object(
            'vertrekdatum', vertrekdatum,
            'reizigers_totaal', reizigers_totaal
          )
          order by reizigers_totaal desc, vertrekdatum asc
        )
        from popular_departure_overall
      ), '[]'::jsonb),
    'traveller_origins_destination',
      COALESCE((
        select jsonb_agg(
          jsonb_build_object(
            'land', land,
            'aantal_reizigers', aantal_reizigers
          )
          order by aantal_reizigers desc, land asc
        )
        from herkomst_per_land_destination
      ), '[]'::jsonb),
    'popular_travel_periods_overall',
      COALESCE((
        select jsonb_agg(
          jsonb_build_object('week', week, 'reizigers_sum', reizigers_sum)
          order by week
        )
        from popular_travel_overall
      ), '[]'::jsonb),
    'popular_travel_periods_destination', '[]'::jsonb
  ) as payload;
end;
$$;

