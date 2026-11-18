-- Klantenprofiel dashboard — één JSON-payload (TravelAnalytics).
--
-- DEPLOYMENT (Supabase → SQL Editor)
-- 0) sql/rpc/dashboard_booking_filters.sql (vw_actieve_reizigers_per_boeking + filterfuncties)
-- 1) Zorg dat de helper bestaat: voer de eerste ~20 regels van sql/rpc/bestemmingen_periodes_rpc.sql uit
--    (functie public._bp_traveler_country_bucket), of het volledige bestand sql/rpc/bestemmingen_periodes_rpc.sql.
-- 2) Voer dit hele bestand uit (één keer, of na elke wijziging).
-- 3) Ververs eventueel de API-schema-cache in Supabase (Settings → API → “Reload schema” als beschikbaar).
--
-- Fout PGRST202 / "Could not find the function public.klantenprofiel_dashboard":
--   → deze functie staat nog niet in je database; stap 1–2 hierboven ontbreken.
--
-- Vereist: public._bp_traveler_country_bucket (sql/rpc/bestemmingen_periodes_rpc.sql).
--
-- p_period: all | maand | zomer
--   all, maand: enkel vertrekkalenderjaar = p_year (maand is UI-granulariteit)
--   zomer: vertrek in jun–sept van dat jaar
-- p_origin: __ALL__ | ALL | BE | NL | IT | OTHER — filter op reizigers-bucket
-- p_brand_land: __ALL__ | BE | NL | IT — filter op boeking-markt (boekingen.brand_land)
--
-- Boekingen: unieke bid in scope. Pax = zelfde definitie als overzicht (vw_actieve_reizigers_per_boeking +
-- reiziger_status_uitgesloten_standaard_dashboards); party-grootte uit actieve reizigers, fallback aantal_reizigers
-- alleen als er geen reizigerregels zijn.

-- Oude uuid[]-signatuur droppen zodat enkel de text[]-versie overblijft (anders krijgen we
-- "function ... does not exist" of "function is not unique" wanneer Python met text[] cast).
drop function if exists public.klantenprofiel_dashboard(
  integer,
  text,
  uuid[],
  text,
  text,
  text,
  text[],
  text[],
  text,
  boolean,
  jsonb,
  jsonb
);

create or replace function public.klantenprofiel_dashboard(
  p_year integer,
  p_brand text,
  p_bestemming_ids text[],
  p_period text,
  p_origin text,
  p_reiziger_land text,
  p_reiziger_provincies text[],
  p_leeftijdsgroepen text[],
  p_brand_land text,
  p_compare_prev boolean,
  p_holiday_ranges jsonb,
  p_holiday_ranges_prev jsonb
)
returns jsonb
language plpgsql
stable
as $$
declare
  v_period text := lower(trim(coalesce(p_period, 'all')));
  v_origin text := upper(trim(coalesce(p_origin, '__ALL__')));
  v_reiziger_land text := upper(trim(coalesce(p_reiziger_land, '__ALL__')));
  v_reiziger_prov_arr text[] := coalesce(p_reiziger_provincies, array[]::text[]);
  v_leeftijd_arr text[] := coalesce(p_leeftijdsgroepen, array[]::text[]);
  v_cmp boolean := coalesce(p_compare_prev, false);
  yc int := p_year;
  yp int := p_year - 1;
  -- Heeft de gebruiker een traveler-niveau filter actief gezet?
  -- Bij geen traveler-filter willen we KPI total_pax / bookings / avg_party
  -- exact gelijk laten lopen met Overzicht (booking-niveau scope met fallback
  -- aantal_reizigers). Met een traveler-filter is dat per definitie onmogelijk
  -- (Overzicht kent die filters niet) en gebruiken we de gefilterde traveler-scope.
  v_has_traveler_filter boolean := (
    coalesce(v_origin, '') not in ('__ALL__', 'ALL', '')
    or coalesce(v_reiziger_land, '') not in ('__ALL__', 'ALL', '')
    or (
      coalesce(array_length(v_reiziger_prov_arr, 1), 0) > 0
      and not (
        '__ALL__' = any(v_reiziger_prov_arr) or 'ALL' = any(v_reiziger_prov_arr)
      )
    )
    or (
      coalesce(array_length(v_leeftijd_arr, 1), 0) > 0
      and not (
        '__ALL__' = any(v_leeftijd_arr) or 'ALL' = any(v_leeftijd_arr)
      )
    )
  );
begin
  if yc is null or yc < 0 then
    return jsonb_build_object('error', 'invalid_year');
  end if;

  return (
    with
    bc_active as (
      select v.boeking_id as bid, v.actieve_reizigers::bigint as cnt
      from public.vw_actieve_reizigers_per_boeking v
    ),
    bc_any as (
      select r.boeking_id as bid, count(*)::bigint as cnt
      from public.reizigers r
      group by r.boeking_id
    ),
    raw_bookings as (
      select
        b.id as bid,
        b.vertrekdatum::date as vd,
        coalesce(b.brand, '')::text as brand_raw,
        coalesce(d.naam, '')::text as dest_naam,
        b.bestemming_id as dest_id,
        coalesce(b.aantal_reizigers, 0)::int as pax_decl,
        extract(year from b.vertrekdatum)::int as y,
        extract(month from b.vertrekdatum)::int as vm
      from public.boekingen b
      left join public.bestemmingen d on d.id = b.bestemming_id
      where b.vertrekdatum is not null
        and not public.boeking_id_excluded_from_standard_dashboards(b.id)
        and (
          p_brand is null
          or trim(p_brand) = ''
          or lower(trim(p_brand)) = '__all__'
          or lower(trim(coalesce(b.brand, ''))) = lower(trim(p_brand))
        )
        and (
          p_bestemming_ids is null
          or coalesce(array_length(p_bestemming_ids, 1), 0) = 0
          or b.bestemming_id::text = any(p_bestemming_ids)
        )
        and (
          p_brand_land is null
          or trim(p_brand_land) = ''
          or lower(trim(p_brand_land)) in ('__all__', 'all')
          or upper(trim(coalesce(b.brand_land, ''))) = upper(trim(p_brand_land))
        )
    ),
    -- slice: year + period filter
    -- Party size matches Overzicht exactly:
    --   actieve reizigers indien aanwezig, anders 0 als er rijen bestaan (alles geannuleerd),
    --   anders aantal_reizigers (fallback voor legacy bookings zonder traveler-rijen).
    -- Geen `greatest(.., 1)` meer: Overzicht gebruikt ook geen ondergrens.
    booking_slice as (
      select
        rb.*,
        case
          when coalesce(bca.cnt, 0) > 0 then bca.cnt::int
          when coalesce(bcy.cnt, 0) > 0 then 0
          else rb.pax_decl
        end::int as party_size,
        case
          when coalesce(bca.cnt, 0) > 0 then 'reizigers_actief'
          when coalesce(bcy.cnt, 0) > 0 then 'alle_reizigers_geannuleerd'
          else 'aantal_reizigers'
        end as party_src
      from raw_bookings rb
      left join bc_active bca on bca.bid = rb.bid
      left join bc_any bcy on bcy.bid = rb.bid
      where (yc = 0 or rb.y = yc)
        and (
          v_period in ('all', 'maand')
          or (v_period = 'zomer' and rb.vm between 6 and 9)
        )
    ),
    booking_slice_prev as (
      select
        rb.*,
        case
          when coalesce(bca.cnt, 0) > 0 then bca.cnt::int
          when coalesce(bcy.cnt, 0) > 0 then 0
          else rb.pax_decl
        end::int as party_size,
        case
          when coalesce(bca.cnt, 0) > 0 then 'reizigers_actief'
          when coalesce(bcy.cnt, 0) > 0 then 'alle_reizigers_geannuleerd'
          else 'aantal_reizigers'
        end as party_src
      from raw_bookings rb
      left join bc_active bca on bca.bid = rb.bid
      left join bc_any bcy on bcy.bid = rb.bid
      where v_cmp
        and yc > 0
        and rb.y = yp
        and (
          v_period in ('all', 'maand')
          or (v_period = 'zomer' and rb.vm between 6 and 9)
        )
    ),
    travelers_cur as (
      select
        r.id as rid,
        r.boeking_id as bid,
        bs.vd,
        bs.vm,
        bs.dest_naam,
        bs.dest_id,
        bs.brand_raw,
        bs.party_size,
        public._bp_traveler_country_bucket(r.land) as origin,
        coalesce(nullif(upper(trim(r.land)), ''), 'Onbekend') as origin_country,
        r.geboortedatum::date as dob,
        -- Defensieve age: alleen waardes [0..100] tellen mee. Reizigers met
        -- corrupte geboortedatum (bv. jaar 11 AD → age 2015) krijgen NULL.
        case
          when r.geboortedatum is null then null::int
          when extract(year from age(bs.vd, r.geboortedatum::date))::int between 0 and 100
            then extract(year from age(bs.vd, r.geboortedatum::date))::int
          else null::int
        end as age_y,
        nullif(trim(coalesce(r.provincie, '')), '') as provincie_raw,
        nullif(trim(coalesce(r.school, '')), '') as school_raw
      from public.reizigers r
      join booking_slice bs on bs.bid = r.boeking_id
      left join public.statussen st_tr on st_tr.id = r.traveller_status_id
      where not public.reiziger_status_uitgesloten_standaard_dashboards(st_tr.naam)
    ),
    travelers_f as (
      select *
      from travelers_cur t
      where (
        v_origin in ('__ALL__', 'ALL', '')
        or t.origin = v_origin
      )
      and (
        v_reiziger_land in ('__ALL__', 'ALL', '')
        or (v_reiziger_land = '__UNKNOWN__' and trim(coalesce(t.origin_country, '')) = 'Onbekend')
        or upper(trim(coalesce(t.origin_country, ''))) = v_reiziger_land
      )
      and (
        coalesce(array_length(v_reiziger_prov_arr, 1), 0) = 0
        or '__ALL__' = any(v_reiziger_prov_arr)
        or 'ALL' = any(v_reiziger_prov_arr)
        or (('__UNKNOWN__' = any(v_reiziger_prov_arr)) and t.provincie_raw is null)
        or coalesce(t.provincie_raw, '') = any(v_reiziger_prov_arr)
      )
      and (
        coalesce(array_length(v_leeftijd_arr, 1), 0) = 0
        or '__ALL__' = any(v_leeftijd_arr)
        or 'ALL' = any(v_leeftijd_arr)
        or (
          ('15-' = any(v_leeftijd_arr))
          and t.age_y is not null and t.age_y <= 15
        )
        or (('16' = any(v_leeftijd_arr)) and t.age_y = 16)
        or (('17' = any(v_leeftijd_arr)) and t.age_y = 17)
        or (('18' = any(v_leeftijd_arr)) and t.age_y = 18)
        or (('19' = any(v_leeftijd_arr)) and t.age_y = 19)
        or (('20' = any(v_leeftijd_arr)) and t.age_y = 20)
        or (('21+' = any(v_leeftijd_arr)) and t.age_y is not null and t.age_y >= 21)
      )
    ),
    travelers_prev as (
      -- Vorig jaar: pas dezelfde traveler-level filters toe als op huidig jaar zodat
      -- delta-vergelijkingen (Δ%) per leeftijdsbucket / herkomst / provincie / merk correct blijven.
      select
        r.id as rid,
        r.boeking_id as bid,
        bs.vd,
        bs.vm,
        bs.dest_naam,
        bs.brand_raw,
        nullif(trim(r.provincie), '') as provincie_raw,
        public._bp_traveler_country_bucket(r.land) as origin,
        coalesce(nullif(upper(trim(r.land)), ''), 'Onbekend') as origin_country,
        case
          when r.geboortedatum is null then null::int
          when extract(year from age(bs.vd, r.geboortedatum::date))::int between 0 and 100
            then extract(year from age(bs.vd, r.geboortedatum::date))::int
          else null::int
        end as age_y
        ,
        md5(
          lower(trim(coalesce(r.voornaam, ''))) || '|'
          || lower(trim(coalesce(r.achternaam, ''))) || '|'
          || coalesce(r.geboortedatum::text, '')
        ) as cust_key
      from public.reizigers r
      join booking_slice_prev bs on bs.bid = r.boeking_id
      left join public.statussen st_tr on st_tr.id = r.traveller_status_id
      where v_cmp
        and not public.reiziger_status_uitgesloten_standaard_dashboards(st_tr.naam)
        and (
          v_origin in ('__ALL__', 'ALL', '')
          or public._bp_traveler_country_bucket(r.land) = v_origin
        )
        and (
          v_reiziger_land in ('__ALL__', 'ALL', '')
          or (
            v_reiziger_land = '__UNKNOWN__'
            and coalesce(nullif(upper(trim(r.land)), ''), 'Onbekend') = 'Onbekend'
          )
          or upper(trim(coalesce(r.land, ''))) = v_reiziger_land
        )
        and (
          coalesce(array_length(v_reiziger_prov_arr, 1), 0) = 0
          or '__ALL__' = any(v_reiziger_prov_arr)
          or 'ALL' = any(v_reiziger_prov_arr)
          or (
            ('__UNKNOWN__' = any(v_reiziger_prov_arr))
            and nullif(trim(coalesce(r.provincie, '')), '') is null
          )
          or nullif(trim(coalesce(r.provincie, '')), '') = any(v_reiziger_prov_arr)
        )
        and (
          coalesce(array_length(v_leeftijd_arr, 1), 0) = 0
          or '__ALL__' = any(v_leeftijd_arr)
          or 'ALL' = any(v_leeftijd_arr)
          or (
            ('15-' = any(v_leeftijd_arr))
            and r.geboortedatum is not null
            and extract(year from age(bs.vd, r.geboortedatum::date))::int <= 15
          )
          or (('16' = any(v_leeftijd_arr)) and r.geboortedatum is not null and extract(year from age(bs.vd, r.geboortedatum::date))::int = 16)
          or (('17' = any(v_leeftijd_arr)) and r.geboortedatum is not null and extract(year from age(bs.vd, r.geboortedatum::date))::int = 17)
          or (('18' = any(v_leeftijd_arr)) and r.geboortedatum is not null and extract(year from age(bs.vd, r.geboortedatum::date))::int = 18)
          or (('19' = any(v_leeftijd_arr)) and r.geboortedatum is not null and extract(year from age(bs.vd, r.geboortedatum::date))::int = 19)
          or (('20' = any(v_leeftijd_arr)) and r.geboortedatum is not null and extract(year from age(bs.vd, r.geboortedatum::date))::int = 20)
          or (
            ('21+' = any(v_leeftijd_arr))
            and r.geboortedatum is not null
            and extract(year from age(bs.vd, r.geboortedatum::date))::int between 21 and 100
          )
        )
    ),
    kp_cur as (
      -- Gem. groepsgrootte moet 1-op-1 overeenkomen met Overzicht.
      --
      -- Strategie:
      --  - Zonder traveler-filter (origin / reiziger_land / provincie / leeftijdsgroep
      --    op "alles"): bereken total_pax en bookings vanuit `booking_slice` met dezelfde
      --    fallback-logica als Overzicht (sum(party_size), count(distinct bid)).
      --    Dat geeft exact dezelfde KPI als de Overzicht-pagina.
      --  - Met traveler-filter actief: gebruik travelers_f scope (alleen matchende
      --    pax + boekingen die minstens één matchende reiziger hebben). Dat is de enige
      --    zinvolle interpretatie omdat Overzicht die filters niet kent.
      --
      -- avg_age en pax_with_age blijven per definitie traveler-niveau (vereist
      -- geboortedatum) en gebruiken altijd travelers_f.
      select
        case
          when v_has_traveler_filter
            then (select count(*)::bigint from travelers_f)
          else (select coalesce(sum(party_size), 0)::bigint from booking_slice)
        end as total_pax,
        case
          when v_has_traveler_filter
            then (select count(distinct bid)::bigint from travelers_f)
          else (select count(*)::bigint from booking_slice)
        end as bookings,
        case
          when v_has_traveler_filter then
            case
              when (select count(distinct bid) from travelers_f) > 0
                then (select round(count(*)::numeric / count(distinct bid)::numeric, 2) from travelers_f)
              else null
            end
          else
            case
              when (select count(*) from booking_slice) > 0
                then (
                  select round(coalesce(sum(party_size), 0)::numeric / count(*)::numeric, 2)
                  from booking_slice
                )
              else null
            end
        end as avg_party,
        (
          select round(avg(tf.age_y::numeric) filter (where tf.age_y is not null), 2)
          from travelers_f tf
        ) as avg_age,
        (
          select count(*) filter (where tf.age_y is not null)::bigint
          from travelers_f tf
        ) as pax_with_age
    ),
    origin_pax_cur as (
      select tf.origin, count(*)::bigint as pax
      from travelers_f tf
      group by tf.origin
    ),
    origin_other_breakdown as (
      select
        tf.origin_country as country,
        count(*)::bigint as pax
      from travelers_f tf
      where tf.origin = 'OTHER'
      group by tf.origin_country
    ),
    origin_pax_prev as (
      -- Vorig jaar: gebruik dezelfde traveler-filtering (via travelers_prev) zodat Δ% per herkomst klopt.
      select tp.origin, count(*)::bigint as pax
      from travelers_prev tp
      group by tp.origin
    ),
    week_pax_total as (
      select
        date_trunc('week', tf.vd)::date as week_start,
        count(*)::bigint as pax_total
      from travelers_f tf
      group by 1
    ),
    top_origin_row as (
      select tf.origin as v
      from travelers_f tf
      group by tf.origin
      order by count(*) desc
      limit 1
    ),
    top_province_row as (
      select tf.provincie_raw as v
      from travelers_f tf
      where tf.provincie_raw is not null
      group by tf.provincie_raw
      order by count(*) desc
      limit 1
    ),
    top_school_row as (
      select tf.school_raw as v
      from travelers_f tf
      where tf.school_raw is not null
      group by tf.school_raw
      order by count(*) desc
      limit 1
    ),
    kp_prev as (
      -- Zelfde definitie als kp_cur, maar voor het vorige jaar (booking_slice_prev / travelers_prev).
      select
        case
          when v_has_traveler_filter
            then (select count(*)::bigint from travelers_prev)
          else (select coalesce(sum(party_size), 0)::bigint from booking_slice_prev)
        end as total_pax,
        case
          when v_has_traveler_filter
            then (select count(distinct bid)::bigint from travelers_prev)
          else (select count(*)::bigint from booking_slice_prev)
        end as bookings,
        case
          when v_has_traveler_filter then
            case
              when (select count(distinct bid) from travelers_prev) > 0
                then (select round(count(*)::numeric / count(distinct bid)::numeric, 2) from travelers_prev)
              else null
            end
          else
            case
              when (select count(*) from booking_slice_prev) > 0
                then (
                  select round(coalesce(sum(party_size), 0)::numeric / count(*)::numeric, 2)
                  from booking_slice_prev
                )
              else null
            end
        end as avg_party,
        (
          select round(avg(tp.age_y::numeric) filter (where tp.age_y is not null), 2)
          from travelers_prev tp
        ) as avg_age,
        (
          select count(*) filter (where tp.age_y is not null)::bigint
          from travelers_prev tp
        ) as pax_with_age
    ),
    brand_pax_cur as (
      select brand_raw as brand, count(*)::bigint as pax, count(distinct bid)::bigint as bookings
      from travelers_f
      group by brand_raw
    ),
    brand_pax_prev as (
      select tp.brand_raw as brand, count(*)::bigint as pax
      from travelers_prev tp
      group by tp.brand_raw
    ),
    brand_origin_cur as (
      select brand_raw as brand, origin, count(*)::bigint as pax
      from travelers_f
      group by brand_raw, origin
    ),
    dest_be_nl as (
      select
        dest_naam,
        count(*) filter (where origin = 'BE')::bigint as pax_be,
        count(*) filter (where origin = 'NL')::bigint as pax_nl
      from travelers_f
      group by dest_naam
    ),
    month_be_nl as (
      select
        vm as month,
        count(*) filter (where origin = 'BE')::bigint as pax_be,
        count(*) filter (where origin = 'NL')::bigint as pax_nl
      from travelers_f
      group by vm
    ),
    month_pax_total as (
      select
        vm as month,
        count(*)::bigint as pax_total
      from travelers_f
      group by vm
    ),
    month_bookings as (
      select
        vm as month,
        count(distinct bid)::bigint as bookings
      from travelers_f
      group by vm
    ),
    age_bucket_lbl as (
      select *
      from (
        values
          ('15-', -200, 15),
          ('16', 16, 16),
          ('17', 17, 17),
          ('18', 18, 18),
          ('19', 19, 19),
          ('20', 20, 20),
          ('21+', 21, 150)
      ) as t(lbl, lo, hi)
    ),
    age_hist as (
      select ab.lbl as bucket, ab.lo as bucket_ord, count(*)::bigint as n
      from travelers_f tf
      join age_bucket_lbl ab on tf.age_y is not null
        and tf.age_y between ab.lo and ab.hi
      group by ab.lbl, ab.lo
    ),
    age_hist_prev as (
      select ab.lbl as bucket, ab.lo as bucket_ord, count(*)::bigint as n
      from travelers_prev tp
      join age_bucket_lbl ab on tp.age_y is not null
        and tp.age_y between ab.lo and ab.hi
      group by ab.lbl, ab.lo
    ),
    age_by_dest as (
      select
        dest_naam,
        round(avg(age_y::numeric), 2) as avg_age,
        percentile_cont(0.5) within group (order by age_y::numeric) as p50_age,
        percentile_cont(0.25) within group (order by age_y::numeric) as p25_age,
        percentile_cont(0.75) within group (order by age_y::numeric) as p75_age,
        count(*)::bigint as n_age
      from travelers_f
      where age_y is not null
      group by dest_naam
    ),
    age_by_month as (
      -- Alleen maanden met minstens één reiziger met bekende geboortedatum behouden,
      -- zodat de grafiek niet onterecht "Geen data beschikbaar" toont.
      select
        vm as month,
        round(avg(age_y::numeric) filter (where age_y is not null), 2) as avg_age,
        count(*) filter (where age_y is not null)::bigint as n_age
      from travelers_f
      where age_y is not null
      group by vm
      having count(*) filter (where age_y is not null) > 0
    ),
    age_by_brand as (
      select
        brand_raw as brand,
        round(avg(age_y::numeric), 2) as avg_age,
        count(*) filter (where age_y is not null)::bigint as n_age
      from travelers_f
      group by brand_raw
    ),
    -- Boekingen per groepsgrootte: bepaal pax per boeking en groepeer in buckets 1..9 en 10+.
    -- Bij geen traveler-filter gebruiken we booking_slice.party_size (dezelfde scope als
    -- de Gem. groepsgrootte KPI / Overzicht). Met traveler-filter actief vallen we terug
    -- op het aantal matchende reizigers per boeking (travelers_f).
    pax_per_booking as (
      select tf.bid, count(*)::int as pax_in_booking
      from travelers_f tf
      group by tf.bid
    ),
    pax_per_booking_effective as (
      -- Geen traveler-filter: scope = booking_slice.party_size (zelfde als KPI / Overzicht).
      select bs.bid, bs.party_size as pax_in_booking
      from booking_slice bs
      where not v_has_traveler_filter
        and bs.party_size >= 1
      union all
      -- Met traveler-filter: scope = aantal matchende reizigers per boeking.
      select ppb.bid, ppb.pax_in_booking
      from pax_per_booking ppb
      where v_has_traveler_filter
        and ppb.pax_in_booking >= 1
    ),
    group_hist as (
      select
        case
          when ppe.pax_in_booking >= 10 then '10+'
          else ppe.pax_in_booking::text
        end as bucket,
        count(distinct ppe.bid)::bigint as n_bookings
      from pax_per_booking_effective ppe
      group by 1
    ),
    -- Gem. groepsgrootte per vertrekmaand = totaal pax in die maand / aantal boekingen in die maand.
    -- Volgt dezelfde scope als de KPI: booking_slice zonder traveler-filter, travelers_f met.
    group_by_month_no_filter as (
      select
        bs.vm as month,
        round(coalesce(sum(bs.party_size), 0)::numeric / nullif(count(*), 0)::numeric, 2) as avg_party
      from booking_slice bs
      group by bs.vm
      having count(*) > 0
    ),
    group_by_month_filtered as (
      select
        tf.vm as month,
        round(count(*)::numeric / nullif(count(distinct tf.bid), 0)::numeric, 2) as avg_party
      from travelers_f tf
      group by tf.vm
      having count(distinct tf.bid) > 0
    ),
    group_by_month as (
      select month, avg_party
      from group_by_month_no_filter
      where not v_has_traveler_filter
      union all
      select month, avg_party
      from group_by_month_filtered
      where v_has_traveler_filter
    ),
    prov_pax as (
      select coalesce(tf.provincie_raw, '(onbekend)') as provincie, count(*)::bigint as pax
      from travelers_f tf
      group by coalesce(tf.provincie_raw, '(onbekend)')
    ),
    prov_pax_prev as (
      select coalesce(tp.provincie_raw, '(onbekend)') as provincie, count(*)::bigint as pax
      from travelers_prev tp
      group by coalesce(tp.provincie_raw, '(onbekend)')
    ),
    prov_book as (
      select coalesce(tf.provincie_raw, '(onbekend)') as provincie, count(distinct tf.bid)::bigint as bookings
      from travelers_f tf
      group by coalesce(tf.provincie_raw, '(onbekend)')
    ),
    prov_book_prev as (
      select coalesce(tp.provincie_raw, '(onbekend)') as provincie, count(distinct tp.bid)::bigint as bookings
      from travelers_prev tp
      group by coalesce(tp.provincie_raw, '(onbekend)')
    ),
    school_top as (
      select school_raw as school, count(*)::bigint as pax, count(distinct bid)::bigint as bookings
      from travelers_f
      where school_raw is not null
      group by school_raw
      order by pax desc
      limit 40
    ),
    school_prov as (
      select
        school_raw as school,
        coalesce(provincie_raw, '(onbekend)') as provincie,
        count(*)::bigint as pax,
        count(distinct bid)::bigint as bookings
      from travelers_f
      where school_raw is not null
      group by school_raw, coalesce(provincie_raw, '(onbekend)')
    ),
    brand_share_cur as (
      select boc.brand,
        boc.origin,
        boc.pax::numeric / nullif(sum(boc.pax) over (partition by boc.brand), 0) * 100 as share_pct
      from brand_origin_cur boc
    ),
    brand_origin_prev as (
      -- Vorig jaar: gebruik travelers_prev zodat alle traveler-filters consistent worden toegepast.
      select tp.brand_raw as brand, tp.origin, count(*)::bigint as pax
      from travelers_prev tp
      group by tp.brand_raw, tp.origin
    ),
    brand_share_prev_y as (
      select bop.brand,
        bop.origin,
        bop.pax::numeric / nullif(sum(bop.pax) over (partition by bop.brand), 0) * 100 as share_pct
      from brand_origin_prev bop
    ),
    brand_share_delta as (
      select
        coalesce(cur.brand, py.brand) as brand,
        coalesce(cur.origin, py.origin) as origin,
        round(coalesce(cur.share_pct, 0) - coalesce(py.share_pct, 0), 2) as share_pp
      from brand_share_cur cur
      full join brand_share_prev_y py on py.brand = cur.brand and py.origin = cur.origin
    )
    select jsonb_build_object(
      'meta', jsonb_build_object(
        'year', yc,
        'year_prev', case when v_cmp then yp end,
        'period', v_period,
        'origin_filter', v_origin,
        'reiziger_land_filter', v_reiziger_land,
        'reiziger_provincies_filter', to_jsonb(v_reiziger_prov_arr),
        'leeftijdsgroepen_filter', to_jsonb(v_leeftijd_arr),
        'brand_land', coalesce(nullif(trim(p_brand_land), ''), '__ALL__'),
        'compare', v_cmp
      ),
      'kpis_cur', (select to_jsonb(kc.*) from kp_cur kc),
      'kpis_prev', case when v_cmp then (select to_jsonb(kp.*) from kp_prev kp) else null end,
      'kpi_extras_cur', jsonb_build_object(
        'repeat_ratio', null,
        'age_coverage_pct',
          (select case when k.total_pax > 0 then round(k.pax_with_age::numeric / k.total_pax * 100, 2) end from kp_cur k),
        'top_origin', (select v from top_origin_row),
        'top_province', (select v from top_province_row),
        'top_school_raw', (select v from top_school_row)
      ),
      'kpi_extras_prev', case when v_cmp then jsonb_build_object('repeat_ratio', null) else null end,
      'brand_pax_cur', coalesce((select jsonb_agg(to_jsonb(bpc) order by bpc.pax desc) from brand_pax_cur bpc), '[]'::jsonb),
      'brand_pax_prev', coalesce((select jsonb_agg(jsonb_build_object('brand', brand, 'pax', pax) order by pax desc) from brand_pax_prev), '[]'::jsonb),
      'brand_origin_cur', coalesce((select jsonb_agg(to_jsonb(b) order by b.brand, b.origin) from brand_origin_cur b), '[]'::jsonb),
      'brand_share_delta_pp', coalesce((select jsonb_agg(to_jsonb(bsd) order by bsd.brand, bsd.origin) from brand_share_delta bsd), '[]'::jsonb),
      'dest_be_nl', coalesce((select jsonb_agg(to_jsonb(d) order by (d.pax_be + d.pax_nl) desc) from dest_be_nl d), '[]'::jsonb),
      'month_be_nl', coalesce((select jsonb_agg(to_jsonb(m) order by m.month) from month_be_nl m), '[]'::jsonb),
      'month_pax_total', coalesce((select jsonb_agg(to_jsonb(mpt) order by mpt.month) from month_pax_total mpt), '[]'::jsonb),
      'month_bookings', coalesce((select jsonb_agg(to_jsonb(mb) order by mb.month) from month_bookings mb), '[]'::jsonb),
      'month_repeat_ratio_cur', '[]'::jsonb,
      'age_hist', coalesce((select jsonb_agg(to_jsonb(ah) order by ah.bucket_ord) from age_hist ah), '[]'::jsonb),
      'age_hist_prev', case when v_cmp then coalesce((select jsonb_agg(to_jsonb(ahp) order by ahp.bucket_ord) from age_hist_prev ahp), '[]'::jsonb) else '[]'::jsonb end,
      'age_by_dest', coalesce((select jsonb_agg(to_jsonb(ad) order by ad.dest_naam) from age_by_dest ad), '[]'::jsonb),
      'age_by_month', coalesce((select jsonb_agg(to_jsonb(am) order by am.month) from age_by_month am), '[]'::jsonb),
      'age_by_brand', coalesce((select jsonb_agg(to_jsonb(ab) order by ab.brand) from age_by_brand ab), '[]'::jsonb),
      'group_hist', coalesce((
        select jsonb_agg(to_jsonb(g) order by (
          case when g.bucket = '10+' then 10 else g.bucket::int end
        ))
        from group_hist g
      ), '[]'::jsonb),
      'group_by_month', coalesce((select jsonb_agg(to_jsonb(gm) order by gm.month) from group_by_month gm), '[]'::jsonb),
      'origin_pax', coalesce((select jsonb_agg(to_jsonb(o) order by o.pax desc) from origin_pax_cur o), '[]'::jsonb),
      'origin_other_breakdown',
        coalesce(
          (
            select jsonb_agg(
              jsonb_build_object(
                'country', o.country,
                'pax', o.pax,
                'pct_within_other', round(o.pax::numeric / nullif((select sum(pax) from origin_other_breakdown), 0) * 100, 2),
                'pct_of_total', round(o.pax::numeric / nullif((select total_pax from kp_cur), 0) * 100, 2)
              )
              order by o.pax desc, o.country
            )
            from origin_other_breakdown o
          ),
          '[]'::jsonb
        ),
      'origin_pax_prev', case when v_cmp then coalesce((select jsonb_agg(to_jsonb(o) order by o.pax desc) from origin_pax_prev o), '[]'::jsonb) else '[]'::jsonb end,
      'week_pax_total', coalesce((select jsonb_agg(to_jsonb(w) order by w.week_start) from week_pax_total w), '[]'::jsonb),
      'loyalty_by_brand', '[]'::jsonb,
      'province_pax', coalesce((select jsonb_agg(to_jsonb(p) order by p.pax desc) from prov_pax p), '[]'::jsonb),
      'province_pax_prev', case when v_cmp then coalesce((select jsonb_agg(to_jsonb(p) order by p.pax desc) from prov_pax_prev p), '[]'::jsonb) else '[]'::jsonb end,
      'province_bookings', coalesce((select jsonb_agg(to_jsonb(pb) order by pb.bookings desc) from prov_book pb), '[]'::jsonb),
      'province_bookings_prev', case when v_cmp then coalesce((select jsonb_agg(to_jsonb(pb) order by pb.bookings desc) from prov_book_prev pb), '[]'::jsonb) else '[]'::jsonb end,
      'school_top_raw', coalesce((select jsonb_agg(to_jsonb(s) order by s.pax desc) from school_top s), '[]'::jsonb),
      'school_prov_matrix', coalesce((select jsonb_agg(to_jsonb(sp)) from school_prov sp), '[]'::jsonb),
      'loyalty', null
    )
  );
end;
$$;

-- Oude uuid[]-signatuur droppen zodat enkel de text[]-versie overblijft.
drop function if exists public.klantenprofiel_repeat_dashboard(
  integer,
  text,
  uuid[],
  text,
  text,
  text,
  text[],
  text[],
  text
);

create or replace function public.klantenprofiel_repeat_dashboard(
  p_year integer,
  p_brand text,
  p_bestemming_ids text[],
  p_period text,
  p_origin text,
  p_reiziger_land text,
  p_reiziger_provincies text[],
  p_leeftijdsgroepen text[],
  p_brand_land text
)
returns jsonb
language plpgsql
stable
as $$
declare
  v_period text := lower(trim(coalesce(p_period, 'all')));
  v_origin text := upper(trim(coalesce(p_origin, '__ALL__')));
  v_reiziger_land text := upper(trim(coalesce(p_reiziger_land, '__ALL__')));
  v_reiziger_prov_arr text[] := coalesce(p_reiziger_provincies, array[]::text[]);
  v_leeftijd_arr text[] := coalesce(p_leeftijdsgroepen, array[]::text[]);
  yc int := p_year;
begin
  if yc is null or yc < 0 then
    return jsonb_build_object('error', 'invalid_year');
  end if;

  return (
    with
    base_scope as (
      select
        r.id as rid,
        r.boeking_id as bid,
        b.vertrekdatum::date as vd,
        coalesce(d.naam, '')::text as dest_naam,
        coalesce(acc.naam, '')::text as accommodatie_naam,
        b.bestemming_id as dest_id,
        coalesce(b.brand, '')::text as brand_raw,
        public._bp_traveler_country_bucket(r.land) as origin,
        coalesce(nullif(upper(trim(r.land)), ''), 'Onbekend') as origin_country,
        nullif(trim(coalesce(r.provincie, '')), '') as provincie_raw,
        lower(trim(coalesce(r.voornaam, ''))) as vn,
        lower(trim(coalesce(r.achternaam, ''))) as an,
        r.geboortedatum::date as dob,
        case
          when r.geboortedatum is null then null::int
          when extract(year from age(b.vertrekdatum::date, r.geboortedatum::date))::int between 0 and 100
            then extract(year from age(b.vertrekdatum::date, r.geboortedatum::date))::int
          else null::int
        end as age_y,
        md5(
          lower(trim(coalesce(r.voornaam, ''))) || '|'
          || lower(trim(coalesce(r.achternaam, ''))) || '|'
          || coalesce(r.geboortedatum::text, '')
        ) as cust_key
      from public.reizigers r
      join public.boekingen b on b.id = r.boeking_id
      left join public.bestemmingen d on d.id = b.bestemming_id
      left join public.accommodaties acc on acc.id = b.accommodatie_id
      left join public.statussen st_tr on st_tr.id = r.traveller_status_id
      where b.vertrekdatum is not null
        and not public.boeking_id_excluded_from_standard_dashboards(b.id)
        and not public.reiziger_status_uitgesloten_standaard_dashboards(st_tr.naam)
        and (
          p_brand is null
          or trim(p_brand) = ''
          or lower(trim(p_brand)) = '__all__'
          or lower(trim(coalesce(b.brand, ''))) = lower(trim(p_brand))
        )
        and (
          p_bestemming_ids is null
          or coalesce(array_length(p_bestemming_ids, 1), 0) = 0
          or b.bestemming_id::text = any(p_bestemming_ids)
        )
        and (
          p_brand_land is null
          or trim(p_brand_land) = ''
          or lower(trim(p_brand_land)) in ('__all__', 'all')
          or upper(trim(coalesce(b.brand_land, ''))) = upper(trim(p_brand_land))
        )
        and (yc = 0 or extract(year from b.vertrekdatum)::int = yc)
        and (
          v_period in ('all', 'maand')
          or (v_period = 'zomer' and extract(month from b.vertrekdatum)::int between 6 and 9)
        )
    ),
    travelers_f as (
      select *
      from base_scope t
      where (v_origin in ('__ALL__', 'ALL', '') or t.origin = v_origin)
        and (
          v_reiziger_land in ('__ALL__', 'ALL', '')
          or (v_reiziger_land = '__UNKNOWN__' and trim(coalesce(t.origin_country, '')) = 'Onbekend')
          or upper(trim(coalesce(t.origin_country, ''))) = v_reiziger_land
        )
        and (
          coalesce(array_length(v_reiziger_prov_arr, 1), 0) = 0
          or '__ALL__' = any(v_reiziger_prov_arr)
          or 'ALL' = any(v_reiziger_prov_arr)
          or (('__UNKNOWN__' = any(v_reiziger_prov_arr)) and t.provincie_raw is null)
          or coalesce(t.provincie_raw, '') = any(v_reiziger_prov_arr)
        )
        and (
          coalesce(array_length(v_leeftijd_arr, 1), 0) = 0
          or '__ALL__' = any(v_leeftijd_arr)
          or 'ALL' = any(v_leeftijd_arr)
          or (('15-' = any(v_leeftijd_arr)) and t.age_y is not null and t.age_y <= 15)
          or (('16' = any(v_leeftijd_arr)) and t.age_y = 16)
          or (('17' = any(v_leeftijd_arr)) and t.age_y = 17)
          or (('18' = any(v_leeftijd_arr)) and t.age_y = 18)
          or (('19' = any(v_leeftijd_arr)) and t.age_y = 19)
          or (('20' = any(v_leeftijd_arr)) and t.age_y = 20)
          or (('21+' = any(v_leeftijd_arr)) and t.age_y is not null and t.age_y >= 21)
        )
    ),
    loyalty_cur as (
      select
        t.rid,
        t.bid,
        t.vd,
        t.cust_key,
        exists (
          select 1
          from public.reizigers r2
          join public.boekingen b2 on b2.id = r2.boeking_id
          left join public.statussen st2 on st2.id = r2.traveller_status_id
          where b2.vertrekdatum is not null
            and not public.boeking_id_excluded_from_standard_dashboards(b2.id)
            and not public.reiziger_status_uitgesloten_standaard_dashboards(st2.naam)
            and md5(
              lower(trim(coalesce(r2.voornaam, ''))) || '|'
              || lower(trim(coalesce(r2.achternaam, ''))) || '|'
              || coalesce(r2.geboortedatum::text, '')
            ) = t.cust_key
            and b2.vertrekdatum::date < t.vd
            and b2.id <> t.bid
        ) as is_repeat
      from travelers_f t
    ),
    loyalty_scope as (
      select
        count(*) filter (where l.is_repeat)::bigint as pax_repeat,
        count(*) filter (where not l.is_repeat)::bigint as pax_new,
        count(*)::bigint as pax_total
      from travelers_f tf
      join loyalty_cur l on l.rid = tf.rid
    ),
    loyalty_by_brand as (
      select
        tf.brand_raw as brand,
        count(*)::bigint as pax_total,
        count(*) filter (where l.is_repeat)::bigint as pax_repeat,
        round(
          count(*) filter (where l.is_repeat)::numeric / nullif((select ls.pax_total from loyalty_scope ls), 0) * 100,
          2
        ) as repeat_share_of_scope_pct
      from travelers_f tf
      join loyalty_cur l on l.rid = tf.rid
      group by tf.brand_raw
    ),
    loyalty_repeat_leaders as (
      select
        left(tf.cust_key, 8) as cust_short,
        max(nullif(trim(tf.vn || ' ' || tf.an), '')) as name_hint,
        count(distinct tf.bid)::bigint as trips_scope,
        count(*)::bigint as pax_scope,
        count(distinct tf.dest_id)::bigint as dest_count_scope,
        min(tf.vd) as first_vd,
        max(tf.vd) as last_vd
      from travelers_f tf
      join loyalty_cur l on l.rid = tf.rid
      where l.is_repeat
      group by left(tf.cust_key, 8)
      order by count(distinct tf.bid) desc
      limit 50
    ),
    cust_trips_detail as (
      select
        left(tf.cust_key, 8) as cust_short,
        coalesce(
          jsonb_agg(
            jsonb_build_object(
              'dest_naam', coalesce(tf.dest_naam, ''),
              'vertrekdatum', tf.vd,
              'brand', coalesce(tf.brand_raw, '')
            )
            order by tf.vd asc, tf.bid asc
          ),
          '[]'::jsonb
        ) as trips_detail
      from travelers_f tf
      where left(tf.cust_key, 8) in (select lr.cust_short from loyalty_repeat_leaders lr)
      group by left(tf.cust_key, 8)
    ),
    booking_rows_global as (
      select distinct on (x.cust_short, x.bid)
        x.cust_short,
        x.bid,
        x.vd,
        x.jaar,
        x.dest_naam,
        x.accommodatie_naam,
        x.brand_raw
      from (
        select
          left(
            md5(
              lower(trim(coalesce(r.voornaam, ''))) || '|'
              || lower(trim(coalesce(r.achternaam, ''))) || '|'
              || coalesce(r.geboortedatum::text, '')
            ),
            8
          ) as cust_short,
          b.id as bid,
          b.vertrekdatum::date as vd,
          extract(year from b.vertrekdatum::date)::int as jaar,
          coalesce(d.naam, '')::text as dest_naam,
          coalesce(acc.naam, '')::text as accommodatie_naam,
          coalesce(b.brand, '')::text as brand_raw
        from public.reizigers r
        join public.boekingen b on b.id = r.boeking_id
        left join public.statussen str on str.id = r.traveller_status_id
        left join public.bestemmingen d on d.id = b.bestemming_id
        left join public.accommodaties acc on acc.id = b.accommodatie_id
        where b.vertrekdatum is not null
          and not public.boeking_id_excluded_from_standard_dashboards(b.id)
          and not public.reiziger_status_uitgesloten_standaard_dashboards(str.naam)
          and left(
            md5(
              lower(trim(coalesce(r.voornaam, ''))) || '|'
              || lower(trim(coalesce(r.achternaam, ''))) || '|'
              || coalesce(r.geboortedatum::text, '')
            ),
            8
          ) in (select lr.cust_short from loyalty_repeat_leaders lr)
      ) x
      order by x.cust_short, x.bid, x.vd
    ),
    cust_full_history as (
      select
        br.cust_short,
        coalesce(
          jsonb_agg(
            jsonb_build_object(
              'jaar', br.jaar,
              'dest_naam', br.dest_naam,
              'accommodatie', br.accommodatie_naam,
              'brand', br.brand_raw,
              'vertrekdatum', br.vd
            )
            order by br.vd asc, br.bid asc
          ),
          '[]'::jsonb
        ) as history
      from booking_rows_global br
      group by br.cust_short
    )
    select jsonb_build_object(
      'meta', jsonb_build_object(
        'year', yc,
        'period', v_period,
        'origin_filter', v_origin,
        'reiziger_land_filter', v_reiziger_land,
        'reiziger_provincies_filter', to_jsonb(v_reiziger_prov_arr),
        'leeftijdsgroepen_filter', to_jsonb(v_leeftijd_arr),
        'brand_land', coalesce(nullif(trim(p_brand_land), ''), '__ALL__')
      ),
      'loyalty', (select to_jsonb(ls.*) from loyalty_scope ls),
      'loyalty_by_brand', coalesce((select jsonb_agg(to_jsonb(lb) order by lb.brand) from loyalty_by_brand lb), '[]'::jsonb),
      'loyalty_sample', coalesce(
        (
          select coalesce(
            jsonb_agg(
              (
                to_jsonb(lr)
                || jsonb_build_object(
                  'trips_detail', coalesce(td.trips_detail, '[]'::jsonb),
                  'history_all', coalesce(hist.history, '[]'::jsonb)
                )
              )
              order by lr.trips_scope desc
            ),
            '[]'::jsonb
          )
          from loyalty_repeat_leaders lr
          left join cust_trips_detail td on td.cust_short = lr.cust_short
          left join cust_full_history hist on hist.cust_short = lr.cust_short
        ),
        '[]'::jsonb
      )
    )
  );
end;
$$;

-- Afkomst reizigers per brand_land (BE/NL) voor donut op Klantenprofiel — zelfde booking-slice als klantenprofiel_dashboard.
-- p_effective_brand: merk voor de twee donuts (pagina-brand als gekozen, anders segmentkeuze in UI).
-- Let op: return-structuur kan wijzigen (OUT kolommen). Daarom eerst expliciet droppen.
drop function if exists public.klantenprofiel_traveler_origin_donut(
  integer,
  text,
  uuid[],
  text,
  text,
  text,
  text[],
  text[],
  text,
  jsonb,
  text
);

create or replace function public.klantenprofiel_traveler_origin_donut(
  p_year integer,
  p_brand text,
  p_bestemming_ids text[],
  p_period text,
  p_origin text,
  p_reiziger_land text,
  p_reiziger_provincies text[],
  p_leeftijdsgroepen text[],
  p_brand_land text,
  p_holiday_ranges jsonb,
  p_effective_brand text
)
returns table (
  booking_brand_land text,
  origin_bucket text,
  origin_country text,
  traveler_count bigint
)
language plpgsql
stable
as $$
declare
  v_period text := lower(trim(coalesce(p_period, 'all')));
  v_origin text := upper(trim(coalesce(p_origin, '__ALL__')));
  v_reiziger_land text := upper(trim(coalesce(p_reiziger_land, '__ALL__')));
  v_reiziger_prov_arr text[] := coalesce(p_reiziger_provincies, array[]::text[]);
  v_leeftijd_arr text[] := coalesce(p_leeftijdsgroepen, array[]::text[]);
  yc int := p_year;
begin
  if yc is null or yc < 0 then
    return;
  end if;

  return query
  with
  bc_active as (
    select v.boeking_id as bid, v.actieve_reizigers::bigint as cnt
    from public.vw_actieve_reizigers_per_boeking v
  ),
  bc_any as (
    select r.boeking_id as bid, count(*)::bigint as cnt
    from public.reizigers r
    group by r.boeking_id
  ),
  raw_bookings as (
    select
      b.id as bid,
      b.vertrekdatum::date as vd,
      coalesce(b.brand, '')::text as brand_raw,
      coalesce(d.naam, '')::text as dest_naam,
      b.bestemming_id as dest_id,
      coalesce(b.aantal_reizigers, 0)::int as pax_decl,
      extract(year from b.vertrekdatum)::int as y,
      extract(month from b.vertrekdatum)::int as vm
    from public.boekingen b
    left join public.bestemmingen d on d.id = b.bestemming_id
    where b.vertrekdatum is not null
      and not public.boeking_id_excluded_from_standard_dashboards(b.id)
      and (
        p_brand is null
        or trim(p_brand) = ''
        or lower(trim(p_brand)) = '__all__'
        or lower(trim(coalesce(b.brand, ''))) = lower(trim(p_brand))
      )
      and (
        p_bestemming_ids is null
        or coalesce(array_length(p_bestemming_ids, 1), 0) = 0
        or b.bestemming_id::text = any(p_bestemming_ids)
      )
      and (
        p_brand_land is null
        or trim(p_brand_land) = ''
        or lower(trim(p_brand_land)) in ('__all__', 'all')
        or upper(trim(coalesce(b.brand_land, ''))) = upper(trim(p_brand_land))
      )
  ),
  booking_slice as (
    select
      rb.*,
      case
        when coalesce(bca.cnt, 0) > 0 then bca.cnt::int
        when coalesce(bcy.cnt, 0) > 0 then 0
        else greatest(rb.pax_decl, 1)
      end::int as party_size,
      case
        when coalesce(bca.cnt, 0) > 0 then 'reizigers_actief'
        when coalesce(bcy.cnt, 0) > 0 then 'alle_reizigers_geannuleerd'
        else 'aantal_reizigers'
      end as party_src
    from raw_bookings rb
    left join bc_active bca on bca.bid = rb.bid
    left join bc_any bcy on bcy.bid = rb.bid
    where (yc = 0 or rb.y = yc)
      and (
        v_period in ('all', 'maand')
        or (v_period = 'zomer' and rb.vm between 6 and 9)
      )
  )
  select
    upper(trim(coalesce(b.brand_land, '')))::text as booking_brand_land,
    public._bp_traveler_country_bucket(r.land)::text as origin_bucket,
    coalesce(nullif(upper(trim(r.land)), ''), 'Onbekend')::text as origin_country,
    count(*)::bigint as traveler_count
  from public.reizigers r
  join booking_slice bs on bs.bid = r.boeking_id
  join public.boekingen b on b.id = bs.bid
  left join public.statussen st_tr on st_tr.id = r.traveller_status_id
  where not public.reiziger_status_uitgesloten_standaard_dashboards(st_tr.naam)
    and lower(trim(coalesce(b.brand, ''))) = lower(trim(coalesce(nullif(trim(p_effective_brand), ''), 'Sun Escapes')))
    and upper(trim(coalesce(b.brand_land, ''))) in ('BE', 'NL')
    and (
      v_origin in ('__ALL__', 'ALL', '')
      or public._bp_traveler_country_bucket(r.land) = v_origin
    )
    and (
      v_reiziger_land in ('__ALL__', 'ALL', '')
      or (v_reiziger_land = '__UNKNOWN__' and trim(coalesce(r.land, '')) = '')
      or upper(trim(coalesce(r.land, ''))) = v_reiziger_land
    )
    and (
      coalesce(array_length(v_reiziger_prov_arr, 1), 0) = 0
      or '__ALL__' = any(v_reiziger_prov_arr)
      or 'ALL' = any(v_reiziger_prov_arr)
      or (('__UNKNOWN__' = any(v_reiziger_prov_arr)) and trim(coalesce(r.provincie, '')) = '')
      or trim(coalesce(r.provincie, '')) = any(v_reiziger_prov_arr)
    )
    and (
      coalesce(array_length(v_leeftijd_arr, 1), 0) = 0
      or '__ALL__' = any(v_leeftijd_arr)
      or 'ALL' = any(v_leeftijd_arr)
      or (('15-' = any(v_leeftijd_arr)) and r.geboortedatum is not null and extract(year from age(bs.vd, r.geboortedatum::date))::int <= 15)
      or (('16' = any(v_leeftijd_arr)) and r.geboortedatum is not null and extract(year from age(bs.vd, r.geboortedatum::date))::int = 16)
      or (('17' = any(v_leeftijd_arr)) and r.geboortedatum is not null and extract(year from age(bs.vd, r.geboortedatum::date))::int = 17)
      or (('18' = any(v_leeftijd_arr)) and r.geboortedatum is not null and extract(year from age(bs.vd, r.geboortedatum::date))::int = 18)
      or (('19' = any(v_leeftijd_arr)) and r.geboortedatum is not null and extract(year from age(bs.vd, r.geboortedatum::date))::int = 19)
      or (('20' = any(v_leeftijd_arr)) and r.geboortedatum is not null and extract(year from age(bs.vd, r.geboortedatum::date))::int = 20)
      or (('21+' = any(v_leeftijd_arr)) and r.geboortedatum is not null and extract(year from age(bs.vd, r.geboortedatum::date))::int between 21 and 100)
    )
  group by 1, 2, 3;
end;
$$;

-- CLOUD SQL: PostgREST grants removed (roles do not exist on Cloud SQL)
-- GRANT EXECUTE ON FUNCTION public.klantenprofiel_dashboard(...) TO authenticated, service_role;
-- GRANT EXECUTE ON FUNCTION public.klantenprofiel_repeat_dashboard(...) TO authenticated, service_role;
-- GRANT EXECUTE ON FUNCTION public.klantenprofiel_traveler_origin_donut(...) TO authenticated, service_role;

create index if not exists idx_reizigers_boeking_id on public.reizigers (boeking_id);
create index if not exists idx_reizigers_traveller_status_id on public.reizigers (traveller_status_id);
create index if not exists idx_boekingen_vertrekdatum on public.boekingen (vertrekdatum);
create index if not exists idx_boekingen_bestemming_id on public.boekingen (bestemming_id);
create index if not exists idx_boekingen_brand on public.boekingen (brand);
