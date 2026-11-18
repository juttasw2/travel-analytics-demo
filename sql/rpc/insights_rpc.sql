-- Inzichten-pagina: boekingen + identity-rij voor repeat/new (TravelAnalytics).
-- Boeking: cancelled/dropped uitgesloten; pax = actieve reizigers (reiziger_status-filter).
--
-- DEPLOYMENT: Supabase SQL Editor → volledige file uitvoeren.
-- Fout PGRST202: functie ontbreekt — deploy opnieuw of herlaad schema-cache.
--
-- TOELICHTING MATCHING (repeat vs new):
--   customer_key = md5(lower(voornaam)|lower(achternaam)|geboortedatum)
--   op eerste reiziger (min id) per boeking. Geen e-mail in dit schema:
--   later uitbreiden met coalesce(email_key, name_key) wanneer e-mail beschikbaar is.
--   Rijksregisternummer: voeg kolom + prioriteit in deze expressie wanneer aanwezig.
--
-- identity_rows bevat alle niet-geannuleerde boekingen binnen brand/bestemming/land
-- (zonder jaar/periode/segment/leeftijd) zodat de client repeat kan afleiden t.o.v. eerdere boekingen.

create or replace function public.insights_dashboard_rpc(
  p_brand text,
  p_bestemming_naam text,
  p_land text,
  p_year int,
  p_period text,
  p_segment text,
  p_age_category text
)
returns jsonb
language sql
stable
as $$
  with
  land_first as (
    select distinct on (r.boeking_id)
      r.boeking_id,
      nullif(trim(r.land), '') as land
    from public.reizigers r
    where r.land is not null and trim(r.land) <> ''
    order by r.boeking_id, r.id
  ),
  first_traveler as (
    select distinct on (r.boeking_id)
      r.boeking_id,
      nullif(trim(r.voornaam), '') as voornaam,
      nullif(trim(r.achternaam), '') as achternaam,
      r.geboortedatum
    from public.reizigers r
    order by r.boeking_id, r.id
  ),
  active_pax_booking as (
    select
      r.boeking_id,
      count(*)::int as actieve_reizigers
    from public.reizigers r
    left join public.statussen st_tr on st_tr.id = r.traveller_status_id
    where not public.reiziger_status_uitgesloten_standaard_dashboards(st_tr.naam)
    group by r.boeking_id
  ),
  base as (
    select
      b.id as booking_id,
      coalesce(b.brand, '')::text as brand,
      d.naam::text as destination,
      upper(trim(coalesce(lf.land, ''))) as country,
      b.vertrekdatum::date as departure_date,
      b.boekingsdatum::date as booking_date,
      coalesce(ap.actieve_reizigers, 0)::int as pax,
      lower(trim(coalesce(st_book.naam, ''))) as booking_status,
      coalesce(dg.naam, '')::text as segment,
      ft.voornaam,
      ft.achternaam,
      ft.geboortedatum,
      case
        when ft.geboortedatum is null then 'unknown'
        when b.vertrekdatum is null then 'unknown'
        when extract(year from age(b.vertrekdatum::timestamp, ft.geboortedatum::timestamp))::int < 18 then '0-17'
        when extract(year from age(b.vertrekdatum::timestamp, ft.geboortedatum::timestamp))::int between 18 and 35 then '18-35'
        when extract(year from age(b.vertrekdatum::timestamp, ft.geboortedatum::timestamp))::int between 36 and 59 then '36-59'
        when extract(year from age(b.vertrekdatum::timestamp, ft.geboortedatum::timestamp))::int >= 60 then '60+'
        else 'unknown'
      end as age_bucket,
      md5(
        lower(trim(coalesce(ft.voornaam, ''))) || '|' ||
        lower(trim(coalesce(ft.achternaam, ''))) || '|' ||
        coalesce(ft.geboortedatum::text, '')
      ) as customer_key
    from public.boekingen b
    join public.bestemmingen d on d.id = b.bestemming_id
    left join public.statussen st_book on st_book.id = b.boeking_status_id
    left join public.doelgroepen dg on dg.id = b.doelgroep_id
    left join land_first lf on lf.boeking_id = b.id
    left join first_traveler ft on ft.boeking_id = b.id
    left join active_pax_booking ap on ap.boeking_id = b.id
    where
      not public.boeking_id_excluded_from_standard_dashboards(b.id)
      and (p_brand is null or trim(p_brand) = '' or lower(trim(p_brand)) = '__all__'
        or lower(trim(coalesce(b.brand, ''))) = lower(trim(p_brand)))
      and (p_bestemming_naam is null or trim(p_bestemming_naam) = ''
        or d.naam = p_bestemming_naam)
      and (
        p_land is null or trim(p_land) = '' or lower(trim(p_land)) in ('__all__', '')
        or upper(trim(lf.land)) = upper(trim(p_land))
      )
  ),
  identity_rows as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'booking_id', q.booking_id,
          'booking_date', q.booking_date,
          'departure_year', extract(year from q.departure_date)::int,
          'customer_key', q.customer_key,
          'brand', q.brand,
          'destination', q.destination
        )
        order by q.booking_date nulls last, q.booking_id
      ),
      '[]'::jsonb
    ) as identity_json
    from base q
    where q.booking_date is not null
      and q.departure_date is not null
  ),
  filtered as (
    select q.*
    from base q
    where
      (p_year is null or p_year <= 0 or extract(year from q.departure_date)::int = p_year)
      and (
        p_period is null or trim(p_period) = '' or lower(trim(p_period)) = 'all'
        or (lower(trim(p_period)) = 'q1' and extract(month from q.departure_date) between 1 and 3)
        or (lower(trim(p_period)) = 'q2' and extract(month from q.departure_date) between 4 and 6)
        or (lower(trim(p_period)) = 'q3' and extract(month from q.departure_date) between 7 and 9)
        or (lower(trim(p_period)) = 'q4' and extract(month from q.departure_date) between 10 and 12)
        or (lower(trim(p_period)) = 'summer' and extract(month from q.departure_date) between 6 and 8)
      )
      and (
        p_segment is null or trim(p_segment) = '' or lower(trim(p_segment)) in ('__all__', '')
        or trim(q.segment) = trim(p_segment)
      )
      and (
        p_age_category is null or trim(p_age_category) = '' or lower(trim(p_age_category)) in ('__all__', '')
        or q.age_bucket = lower(trim(p_age_category))
      )
  ),
  detail_rows as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'booking_id', f.booking_id,
          'brand', f.brand,
          'destination', f.destination,
          'country', nullif(f.country, ''),
          'departure_date', f.departure_date,
          'booking_date', f.booking_date,
          'pax', f.pax,
          'booking_status', f.booking_status,
          'segment', nullif(f.segment, ''),
          'age_bucket', f.age_bucket,
          'customer_key', f.customer_key,
          'lead_time_days', case
            when f.booking_date is not null and f.departure_date is not null
            then (f.departure_date - f.booking_date)::int
            else null
          end
        )
        order by f.departure_date desc nulls last, f.booking_id
      ),
      '[]'::jsonb
    ) as rows_json
    from filtered f
  )
  select jsonb_build_object(
    'rows', coalesce((select rows_json from detail_rows), '[]'::jsonb),
    'identity_rows', coalesce((select identity_json from identity_rows), '[]'::jsonb)
  );
$$;

comment on function public.insights_dashboard_rpc(text, text, text, int, text, text, text) is
  'Inzichten: boekingstatus-filter + pax uit actieve reizigers (reiziger_status substring-filter).';
