-- ============================================================================
-- Excursies dashboard — public.excursies_lines_rpc
-- Brontabel voor regelniveau-analyse: public.vw_excursie_sales_analysis
-- (zie migration: excursions_uniek_boekingsprijs_jaarkosten.sql).
--
-- Kernregels:
-- - verkoopprijs = effectieve prijs op boeking_excursies
-- - gratis excursies (prijs = 0) blijven geldig
-- - kostjaar = year(coalesce(bex.vertrekdatum, boekingen.vertrekdatum, boekingen.boekingsdatum))
-- - kosten/marge uit excursie_jaarkosten (met legacy fallback in de view)
-- ============================================================================

-- Blacklist: deze statussen worden als GEANNULEERD beschouwd (exact, case-insensitive).
-- Let op: 'processing' valt hier bewust NIET onder en blijft zichtbaar op Excursies.
-- Voeg hier ontbrekende DB-waarden toe na inspectie van:
--   select distinct naam from public.statussen order by 1;
create or replace function public.excursies_booking_status_is_cancelled(p_naam text)
returns boolean
language sql
stable
as $$
  select
    case
      when p_naam is null then false
      when btrim(p_naam) = '' then false
      else lower(btrim(p_naam)) in (
        'cancelled',
        'canceled',
        'cancel',
        'geannuleerd',
        'gecanceld',
        'annulatie',
        'annulering',
        'annule',
        'annulé',
        'dropped'
      )
    end;
$$;

comment on function public.excursies_booking_status_is_cancelled(text) is
  'Excursies: true als statusnaam exact (na lower+trim) op annulatie-blacklist staat. Geen substring-LIKE.';

-- CLOUD SQL: grant execute on function public.excursies_booking_status_is_cancelled(text) to anon, authenticated, service_role;

drop function if exists public.excursies_lines_rpc();
drop function if exists public.excursies_lines_rpc(text, text, text, int, text);
drop function if exists public.excursies_lines_rpc(text, text, int, text, text);
drop function if exists public.excursies_lines_rpc(text, text, int, text);

-- ---------------------------------------------------------------------------
-- MINIMALE overload: public.excursies_lines_rpc() — GEEN WHERE, GEEN filters.
-- Doel: bewijs in SQL + PostgREST dat joins rijen teruggeven (debug + fallback-keten).
-- PostgREST: POST /rest/v1/rpc/excursies_lines_rpc met lege body → deze functie.
-- Id’s als text zodat uuid/bigint-schema’s niet breken.
-- ---------------------------------------------------------------------------
create or replace function public.excursies_lines_rpc()
returns table (
  boeking_excursie_id text,
  boeking_id text,
  excursie_id text,
  order_nummer text,
  excursie_naam text,
  boekingsdatum date,
  vertrekdatum date,
  datum_toegevoegd date,
  brand text,
  destination_name text,
  excursie_type text,
  verkoop_prijs numeric,
  is_gratis boolean,
  kostjaar int,
  inkoop_prijs numeric,
  inkoopprijs_ingegeven boolean,
  commissie numeric,
  commissie_percentage numeric,
  berekende_commissie numeric,
  jaarkosten_gevonden boolean,
  totale_kost numeric,
  marge numeric,
  marge_percentage numeric,
  booking_pax int,
  betaling_pending boolean,
  betaaloptie text,
  mollie_betaling_id text,
  geboekt_in_online_account boolean,
  booking_status text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    v.boeking_excursie_id::text,
    v.boeking_id::text,
    v.excursie_id::text,
    v.order_nummer::text,
    v.excursie_naam,
    v.boekingsdatum::date,
    v.vertrekdatum::date,
    v.datum_toegevoegd::date,
    v.brand,
    coalesce(v.bestemming_naam, 'Onbekend'),
    coalesce(nullif(trim(v.excursie_type), ''), ''),
    coalesce(v.verkoopprijs, 0)::numeric,
    coalesce(v.is_gratis, false),
    v.kostjaar,
    v.inkoopprijs::numeric,
    -- "Geldig ingegeven" = jaarkosten-rij bestaat én inkoopprijs is daadwerkelijk gevuld (>0).
    -- Een lege of nul-waarde betekent "nog niet ingevoerd" en mag geen winst opleveren.
    exists (
      select 1
      from public.excursie_jaarkosten jk
      where jk.excursie_id = v.excursie_id
        and jk.jaar = v.kostjaar
        and jk.id is not null
        and jk.inkoopprijs is not null
        and jk.inkoopprijs > 0
    ) as inkoopprijs_ingegeven,
    v.commissie::numeric,
    v.commissie_percentage::numeric,
    coalesce(v.berekende_commissie, 0)::numeric,
    coalesce(v.jaarkosten_gevonden, false),
    v.totale_kost::numeric,
    v.marge::numeric,
    v.marge_percentage::numeric,
    coalesce(v.booking_pax, 0)::int,
    v.betaling_pending,
    v.betaaloptie,
    v.mollie_betaling_id::text,
    v.geboekt_in_online_account,
    lower(trim(coalesce(v.booking_status, '')))
  from public.vw_excursie_sales_analysis v;
$$;

comment on function public.excursies_lines_rpc() is
  'Debug/smoke: alle boeking_excursies-regels met joins, zonder filters. Gebruikt door backend-fallback als JSONB-RPC 0 rijen geeft.';

-- CLOUD SQL: grant execute on function public.excursies_lines_rpc() to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Productie: JSONB + filters (annulatie, jaar, merk, …)
-- ---------------------------------------------------------------------------
create or replace function public.excursies_lines_rpc(
  p_brand text,
  p_bestemming_naam text,
  p_land text,
  p_year int,
  p_excursie_naam text
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with land_first as (
    select distinct on (r.boeking_id)
      r.boeking_id,
      nullif(trim(r.land), '') as land
    from public.reizigers r
    where r.land is not null and trim(r.land) <> ''
    order by r.boeking_id, r.id
  ),
  filtered as (
    select
      v.boeking_excursie_id as line_id,
      v.boeking_id as booking_id,
      v.order_nummer,
      v.brand,
      lf.land,
      v.vertrekdatum as departure_date,
      v.boekingsdatum as booking_date,
      coalesce(v.vertrekdatum::date, v.boekingsdatum::date, v.datum_toegevoegd::date) as date_for_year_filter,
      coalesce(v.booking_pax, 0)::int as booking_pax,
      v.excursie_naam,
      coalesce(nullif(trim(v.excursie_type), ''), '') as excursie_type,
      coalesce(v.bestemming_naam, 'Onbekend') as destination_name,
      coalesce(v.verkoopprijs, 0)::numeric as verkoop_prijs,
      (coalesce(v.verkoopprijs, 0)::numeric = 0 or coalesce(v.is_gratis, false)) as is_gratis,
      v.kostjaar,
      v.inkoopprijs::numeric as inkoop_prijs,
      -- "Geldig ingegeven" = jaarkosten-rij bestaat én inkoopprijs is daadwerkelijk gevuld (>0).
      -- Een lege of nul-waarde betekent "nog niet ingevoerd" en mag geen winst opleveren.
      exists (
        select 1
        from public.excursie_jaarkosten jk
        where jk.excursie_id = v.excursie_id
          and jk.jaar = v.kostjaar
          and jk.id is not null
          and jk.inkoopprijs is not null
          and jk.inkoopprijs > 0
      ) as inkoopprijs_ingegeven,
      coalesce(v.commissie, 0)::numeric as commissie,
      v.commissie_percentage::numeric as commissie_percentage,
      coalesce(v.berekende_commissie, 0)::numeric as berekende_commissie,
      coalesce(v.jaarkosten_gevonden, false) as jaarkosten_gevonden,
      coalesce(v.totale_kost, 0)::numeric as totale_kost,
      coalesce(v.marge, 0)::numeric as marge,
      v.marge_percentage::numeric as marge_percentage,
      v.betaling_pending,
      case
        when coalesce(v.verkoopprijs, 0)::numeric = 0 then 'free'
        else v.betaaloptie
      end as betaaloptie,
      v.mollie_betaling_id,
      v.geboekt_in_online_account,
      v.datum_toegevoegd,
      lower(trim(coalesce(v.booking_status, ''))) as booking_status_norm
    from public.vw_excursie_sales_analysis v
    left join land_first lf on lf.boeking_id = v.boeking_id
    where
      not public.boeking_id_excluded_from_standard_dashboards(v.boeking_id)
      and (
        p_brand is null
        or trim(p_brand) = ''
        or lower(trim(p_brand)) = '__all__'
        or lower(trim(coalesce(v.brand, ''))) = lower(trim(p_brand))
      )
      and (
        p_bestemming_naam is null
        or trim(p_bestemming_naam) = ''
        or coalesce(v.bestemming_naam, '') = p_bestemming_naam
      )
      and (
        p_land is null
        or trim(p_land) = ''
        or lower(trim(p_land)) = '__all__'
        or upper(trim(coalesce(lf.land, ''))) = upper(trim(p_land))
      )
      and (
        p_year is null
        or p_year <= 0
        or (
          coalesce(v.vertrekdatum::date, v.boekingsdatum::date, v.datum_toegevoegd::date) is not null
          and extract(
            year from coalesce(v.vertrekdatum::date, v.boekingsdatum::date, v.datum_toegevoegd::date)
          )::int = p_year
        )
      )
      and (
        p_excursie_naam is null
        or trim(p_excursie_naam) = ''
        or v.excursie_naam = p_excursie_naam
      )
  ),
  rows_json as (
    select
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'line_id', line_id,
            'booking_id', booking_id,
            'order_nummer', order_nummer,
            'brand', brand,
            'land', land,
            'destination', destination_name,
            'departure_date', departure_date::text,
            'booking_date', booking_date::text,
            'year_filter_date', date_for_year_filter::text,
            'booking_pax', booking_pax,
            'excursie_naam', excursie_naam,
            'excursie_type', excursie_type,
            'verkoop_prijs', verkoop_prijs,
            'is_gratis', is_gratis,
            'kostjaar', kostjaar,
            'inkoop_prijs', inkoop_prijs,
            'inkoopprijs_ingegeven', inkoopprijs_ingegeven,
            'commissie', commissie,
            'commissie_percentage', commissie_percentage,
            'berekende_commissie', berekende_commissie,
            'jaarkosten_gevonden', jaarkosten_gevonden,
            'totale_kost', totale_kost,
            'marge', marge,
            'marge_percentage', marge_percentage,
            'betaling_pending', betaling_pending,
            'betaaloptie', betaaloptie,
            'mollie_betaling_id', mollie_betaling_id,
            'geboekt_in_online_account', geboekt_in_online_account,
            'datum_toegevoegd', case when datum_toegevoegd is not null then datum_toegevoegd::text else null end,
            'sales_channel', case
              when verkoop_prijs = 0 then 'Local sale'
              when lower(trim(coalesce(betaaloptie, ''))) in ('mollie', 'ideal', 'card')
                then 'Booking sale'
              when lower(trim(coalesce(betaaloptie, ''))) in ('cash', 'contant', 'free', 'overschrijving')
                then 'Local sale'
              when nullif(trim(betaaloptie), '') is null
                then 'Onbekend'
              else 'Onbekend'
            end,
            'booking_status', booking_status_norm
          )
          order by departure_date desc nulls last, booking_id, line_id
        ),
        '[]'::jsonb
      ) as rows,
      false as inkoop_incomplete
    from filtered
  ),
  active_pax_cnt as (
    select
      r.boeking_id,
      count(*)::int as actieve_reizigers
    from public.reizigers r
    left join public.statussen st_tr on st_tr.id = r.traveller_status_id
    where not public.reiziger_status_uitgesloten_standaard_dashboards(st_tr.naam)
    group by r.boeking_id
  ),
  pax_pool as (
    select coalesce(sum(coalesce(ax.actieve_reizigers, 0)), 0)::numeric as total_pax_pool
    from public.boekingen b
    left join active_pax_cnt ax on ax.boeking_id = b.id
    left join public.bestemmingen d_booking on d_booking.id = b.bestemming_id
    left join land_first lf on lf.boeking_id = b.id
    where
      not public.boeking_id_excluded_from_standard_dashboards(b.id)
      and (
        p_brand is null
        or trim(p_brand) = ''
        or lower(trim(p_brand)) = '__all__'
        or lower(trim(coalesce(b.brand, ''))) = lower(trim(p_brand))
      )
      and (
        p_bestemming_naam is null
        or trim(p_bestemming_naam) = ''
        or d_booking.naam = p_bestemming_naam
      )
      and (
        p_land is null
        or trim(p_land) = ''
        or lower(trim(p_land)) = '__all__'
        or upper(trim(coalesce(lf.land, ''))) = upper(trim(p_land))
      )
      and (
        p_year is null
        or p_year <= 0
        or (
          coalesce(b.vertrekdatum::date, b.boekingsdatum::date) is not null
          and extract(year from coalesce(b.vertrekdatum::date, b.boekingsdatum::date))::int = p_year
        )
      )
  ),
  pax_pool_by_destination as (
    select coalesce(
      jsonb_object_agg(
        x.destination_name,
        x.destination_pax
      ),
      '{}'::jsonb
    ) as totals
    from (
      select
        coalesce(d_booking.naam, 'Onbekend') as destination_name,
        coalesce(sum(coalesce(ax.actieve_reizigers, 0)), 0)::numeric as destination_pax
      from public.boekingen b
      left join active_pax_cnt ax on ax.boeking_id = b.id
      left join public.bestemmingen d_booking on d_booking.id = b.bestemming_id
      left join land_first lf on lf.boeking_id = b.id
      where
        not public.boeking_id_excluded_from_standard_dashboards(b.id)
        and (
          p_brand is null
          or trim(p_brand) = ''
          or lower(trim(p_brand)) = '__all__'
          or lower(trim(coalesce(b.brand, ''))) = lower(trim(p_brand))
        )
        and (
          p_bestemming_naam is null
          or trim(p_bestemming_naam) = ''
          or d_booking.naam = p_bestemming_naam
        )
        and (
          p_land is null
          or trim(p_land) = ''
          or lower(trim(p_land)) = '__all__'
          or upper(trim(coalesce(lf.land, ''))) = upper(trim(p_land))
        )
        and (
          p_year is null
          or p_year <= 0
          or (
            coalesce(b.vertrekdatum::date, b.boekingsdatum::date) is not null
            and extract(year from coalesce(b.vertrekdatum::date, b.boekingsdatum::date))::int = p_year
          )
        )
      group by coalesce(d_booking.naam, 'Onbekend')
    ) x
  ),
  pax_pool_by_land as (
    select coalesce(
      jsonb_object_agg(
        x.land_code,
        x.land_pax
      ),
      '{}'::jsonb
    ) as totals
    from (
      select
        upper(trim(coalesce(lf.land, 'Onbekend'))) as land_code,
        coalesce(sum(coalesce(ax.actieve_reizigers, 0)), 0)::numeric as land_pax
      from public.boekingen b
      left join active_pax_cnt ax on ax.boeking_id = b.id
      left join public.bestemmingen d_booking on d_booking.id = b.bestemming_id
      left join land_first lf on lf.boeking_id = b.id
      where
        not public.boeking_id_excluded_from_standard_dashboards(b.id)
        and (
          p_brand is null
          or trim(p_brand) = ''
          or lower(trim(p_brand)) = '__all__'
          or lower(trim(coalesce(b.brand, ''))) = lower(trim(p_brand))
        )
        and (
          p_bestemming_naam is null
          or trim(p_bestemming_naam) = ''
          or d_booking.naam = p_bestemming_naam
        )
        and (
          p_land is null
          or trim(p_land) = ''
          or lower(trim(p_land)) = '__all__'
          or upper(trim(coalesce(lf.land, ''))) = upper(trim(p_land))
        )
        and (
          p_year is null
          or p_year <= 0
          or (
            coalesce(b.vertrekdatum::date, b.boekingsdatum::date) is not null
            and extract(year from coalesce(b.vertrekdatum::date, b.boekingsdatum::date))::int = p_year
          )
        )
      group by upper(trim(coalesce(lf.land, 'Onbekend')))
    ) x
  )
  select jsonb_build_object(
    'rows', rows_json.rows,
    'meta', jsonb_build_object(
      'inkoop_incomplete', rows_json.inkoop_incomplete,
      'sales_channel_heuristic', true,
      'total_pax_pool', pax_pool.total_pax_pool,
      'pax_pool_by_destination', pax_pool_by_destination.totals,
      'pax_pool_by_land', pax_pool_by_land.totals,
      'year_filter_basis',
        'coalesce(boeking_excursies.vertrekdatum, boekingen.vertrekdatum, boekingen.boekingsdatum)',
      'cost_year_basis',
        'extract(year from coalesce(boeking_excursies.vertrekdatum, boekingen.vertrekdatum, boekingen.boekingsdatum))',
      'pricing_source',
        'boeking_excursies.verkoopprijs',
      'cost_source',
        'excursie_jaarkosten',
      'winst_basis',
        'sum(berekende_commissie) per excursieregel',
      'cancellation_rule',
        'booking: boeking_id_excluded_from_standard_dashboards only; pax: active reizigers na reiziger_status filter'
    )
  )
  from rows_json
  cross join pax_pool
  cross join pax_pool_by_destination
  cross join pax_pool_by_land;
$$;

comment on function public.excursies_lines_rpc(text, text, text, int, text) is
  'Excursies dashboard: boeking_excursies; security definer; annulatie via blacklist; jaar via coalesce datums; landfilter op reizigers.land.';

-- CLOUD SQL: grant execute on function public.excursies_lines_rpc(text, text, text, int, text) to anon, authenticated, service_role;

-- Sync van excursies.bestemming_id met boekingen: zie migrations/excursies_bestemming_sync.sql
-- (functie public.excursies_sync_bestemming_from_bookings, aangeroepen na excursie-import).
