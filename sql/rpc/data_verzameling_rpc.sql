-- RPC functions voor "Data verzameling" pagina.
-- Geen tabellen/kolommen worden gewijzigd; enkel SQL functies toegevoegd.

-- OUT/return type wijzigen (nieuwe kolom `land`) vereist DROP: CREATE OR REPLACE mag niet.
-- 1) Wrapper droppen (roept de 10-param variant aan).
drop function if exists public.data_verzameling_list(
  text,
  text,
  uuid,
  int,
  uuid,
  boolean,
  text,
  date,
  date,
  int,
  int
);
-- 2) Hoofdfunctie droppen (Postgres hint: integer = int).
drop function if exists public.data_verzameling_list(
  text,
  text,
  uuid,
  integer,
  uuid,
  text,
  date,
  date,
  integer,
  integer
);

-- ============================
-- 1) Lijst (paginated)
-- ============================
create or replace function public.data_verzameling_list(
  p_search text,
  p_brand text,
  p_bestemming_id uuid,
  p_year int,
  p_status_id uuid,
  p_date_kind text,
  p_date_from date,
  p_date_to date,
  p_limit int,
  p_offset int
)
returns table(
  booking_id uuid,
  order_nummer text,
  bestemming text,
  accommodatie text,
  vertrekdatum date,
  terugkeerdatum date,
  boekingsdatum date,
  aantal_reizigers integer,
  boeking_status text,
  betaling_status text,
  doelgroep text,
  transport text,
  totaal_te_betalen numeric,
  reeds_betaald numeric,
  nog_te_betalen numeric,
  package_prijs numeric,
  aangemaakt_op timestamptz,
  land text
)
language plpgsql
stable
as $$
begin
  return query
  select
    b.id as booking_id,
    b.order_nummer,
    d.naam as bestemming,
    a.naam as accommodatie,
    b.vertrekdatum,
    b.terugkeerdatum,
    b.boekingsdatum,
    b.aantal_reizigers,
    st_book.naam as boeking_status,
    st_pay.naam as betaling_status,
    dg.naam as doelgroep,
    coalesce(
      nullif(trim(t.naam), ''),
      tr_transport.transport_naam
    ) as transport,
    rf_agg.totaal_te_betalen,
    rf_agg.reeds_betaald,
    rf_agg.nog_te_betalen,
    rf_agg.package_prijs,
    b.aangemaakt_op,
    (
      select r2.land
      from public.reizigers r2
      where r2.boeking_id = b.id
        and r2.land is not null
        and trim(r2.land) <> ''
      order by r2.id
      limit 1
    ) as land
  from boekingen b
  join bestemmingen d on d.id = b.bestemming_id
  join accommodaties a on a.id = b.accommodatie_id
  left join (
    select
      r.boeking_id,
      coalesce(sum(rf.totaal_te_betalen), 0)::numeric as totaal_te_betalen,
      coalesce(sum(rf.reeds_betaald), 0)::numeric as reeds_betaald,
      coalesce(sum(rf.nog_te_betalen), 0)::numeric as nog_te_betalen,
      coalesce(sum(rf.package_prijs), 0)::numeric as package_prijs
    from reizigers r
    left join public.statussen st_tr on st_tr.id = r.traveller_status_id
    left join reiziger_financien rf on rf.reiziger_id = r.id
    where not public.reiziger_status_uitgesloten_standaard_dashboards(st_tr.naam)
    group by r.boeking_id
  ) rf_agg on rf_agg.boeking_id = b.id
  left join statussen st_book on st_book.id = b.boeking_status_id
  left join statussen st_pay on st_pay.id = b.betaling_status_id
  left join doelgroepen dg on dg.id = b.doelgroep_id
  left join transporten t on t.id = b.transport_id
  left join lateral (
    select x.transport_naam
    from (
      select
        case
          when lower(trim(coalesce(r.transport, ''))) in ('self', 'bus', 'plane')
            then lower(trim(coalesce(r.transport, '')))
          else null
        end as transport_naam,
        count(*)::int as pax_t
      from public.reizigers r
      left join public.statussen st_tr on st_tr.id = r.traveller_status_id
      where r.boeking_id = b.id
        and not public.reiziger_status_uitgesloten_standaard_dashboards(st_tr.naam)
      group by 1
    ) x
    order by
      x.pax_t desc nulls last,
      case
        when x.transport_naam = 'plane' then 1
        when x.transport_naam = 'bus' then 2
        when x.transport_naam = 'self' then 3
        else 4
      end
    limit 1
  ) tr_transport on true
  where
    -- Merk (default: __all__)
    (p_brand = '__all__'
     or lower(trim(b.brand)) = lower(trim(p_brand))
    )
    -- Bestemming
    and (p_bestemming_id is null or b.bestemming_id = p_bestemming_id)
    -- Jaar (vertrekdatum) - p_year <= 0 betekent "alle jaren"
    and (p_year <= 0 or extract(year from b.vertrekdatum)::int = p_year)
    -- Boekingsstatus
    and (p_status_id is null or b.boeking_status_id = p_status_id)
    -- Datum range (op basis van geselecteerd soort)
    and (
      p_date_from is null
      or (
        case
          when lower(trim(p_date_kind)) = 'boekingsdatum' then b.boekingsdatum
          else b.vertrekdatum
        end
      ) >= p_date_from
    )
    and (
      p_date_to is null
      or (
        case
          when lower(trim(p_date_kind)) = 'boekingsdatum' then b.boekingsdatum
          else b.vertrekdatum
        end
      ) <= p_date_to
    )
    -- Zoekveld
    and (
      p_search is null or trim(p_search) = ''
      or b.order_nummer ilike '%' || trim(p_search) || '%'
      or d.naam ilike '%' || trim(p_search) || '%'
      or a.naam ilike '%' || trim(p_search) || '%'
      -- Reizigersnaam (voornaam/achternaam)
      or exists (
        select 1
        from public.reizigers r2
        where r2.boeking_id = b.id
          and (
            r2.voornaam ilike '%' || trim(p_search) || '%'
            or r2.achternaam ilike '%' || trim(p_search) || '%'
            or (r2.voornaam || ' ' || r2.achternaam) ilike '%' || trim(p_search) || '%'
          )
      )
    )
  order by b.boekingsdatum desc
  limit p_limit offset p_offset;
end;
$$;


-- Compatibiliteitssignatuur:
-- Sommige clients/schema-cache verwachten nog p_winstgevend.
-- We negeren die parameter (veld bestaat niet meer) en routeren door.
create or replace function public.data_verzameling_list(
  p_search text,
  p_brand text,
  p_bestemming_id uuid,
  p_year int,
  p_status_id uuid,
  p_winstgevend boolean,
  p_date_kind text,
  p_date_from date,
  p_date_to date,
  p_limit int,
  p_offset int
)
returns table(
  booking_id uuid,
  order_nummer text,
  bestemming text,
  accommodatie text,
  vertrekdatum date,
  terugkeerdatum date,
  boekingsdatum date,
  aantal_reizigers integer,
  boeking_status text,
  betaling_status text,
  doelgroep text,
  transport text,
  totaal_te_betalen numeric,
  reeds_betaald numeric,
  nog_te_betalen numeric,
  package_prijs numeric,
  aangemaakt_op timestamptz,
  land text
)
language sql
stable
as $$
  select *
  from public.data_verzameling_list(
    p_search => p_search,
    p_brand => p_brand,
    p_bestemming_id => p_bestemming_id,
    p_year => p_year,
    p_status_id => p_status_id,
    p_date_kind => p_date_kind,
    p_date_from => p_date_from,
    p_date_to => p_date_to,
    p_limit => p_limit,
    p_offset => p_offset
  );
$$;


-- ============================
-- 2) Detail (drawer)
-- ============================
create or replace function public.data_verzameling_detail(p_booking_id uuid)
returns table(payload jsonb)
language plpgsql
stable
as $$
declare
  booking jsonb;
  bestemming jsonb;
  accommodatie jsonb;
  boeking_status jsonb;
  betaling_status jsonb;
  doelgroep jsonb;
  transport jsonb;
  bestemming_naam text;
  accommodatie_naam text;
  boeking_status_naam text;
  betaling_status_naam text;
  doelgroep_naam text;
  transport_naam text;
  reizigers jsonb;
  excursies jsonb;
  addons jsonb;
begin
  select to_jsonb(b) || jsonb_build_object(
    'totaal_te_betalen', rf_agg.totaal_te_betalen,
    'reeds_betaald', rf_agg.reeds_betaald,
    'nog_te_betalen', rf_agg.nog_te_betalen,
    'package_prijs', rf_agg.package_prijs,
    'transfer_prijs', rf_agg.transfer_prijs,
    'bagage_prijs', rf_agg.bagage_prijs,
    'vlucht_heen_prijs', rf_agg.vlucht_heen_prijs,
    'vlucht_terug_prijs', rf_agg.vlucht_terug_prijs,
    'toeristenbelasting_te_betalen', rf_agg.toeristenbelasting_te_betalen,
    'schoonmaakkosten_te_betalen', f.schoonmaakkosten_te_betalen,
    'waarborg_te_betalen', f.waarborg_te_betalen,
    'waarborg_betaald', f.waarborg_betaald,
    'waarborg_methode', f.waarborg_methode,
    'kost_accommodatie', rf_agg.kost_accommodatie,
    'kost_transport', (
      case
        when lower(trim(coalesce(t.naam, ''))) in ('self', 'zelf') then 1::numeric
        when lower(trim(coalesce(t.naam, ''))) = 'bus'
             and coalesce(rf_agg.kost_transport_raw, 0)::numeric = 0 then 130::numeric
        else coalesce(rf_agg.kost_transport_raw, 0)::numeric
      end
    ),
    'kost_transfer', rf_agg.kost_transfer,
    'kost_extra_kosten', rf_agg.kost_extra_kosten,
    'voorschot_percentage', f.voorschot_percentage,
    'voorschot', f.voorschot,
    'aantal_voorschotbetalingsherinneringen', coalesce(rf_agg.agg_voorschot_herinneringen, 0),
    'aantal_totaalbetalingsherinneringen', coalesce(rf_agg.agg_totaal_herinneringen, 0),
    'gebruikte_kortingscode', f.gebruikte_kortingscode,
    'factuur_verzonden_op', f.factuur_verzonden_op,
    'accommodatie_status_id', ba.accommodatie_status_id,
    'maaltijdtype', ba.maaltijdtype,
    'kamer', ba.kamer,
    'kamer_prijs', ba.kamer_prijs
  ) into booking
  from boekingen b
  left join (
    select
      r.boeking_id,
      coalesce(sum(rf.totaal_te_betalen), 0)::numeric as totaal_te_betalen,
      coalesce(sum(rf.reeds_betaald), 0)::numeric as reeds_betaald,
      coalesce(sum(rf.nog_te_betalen), 0)::numeric as nog_te_betalen,
      coalesce(sum(rf.package_prijs), 0)::numeric as package_prijs,
      coalesce(sum(rf.transfer_prijs), 0)::numeric as transfer_prijs,
      coalesce(sum(rf.bagage_prijs), 0)::numeric as bagage_prijs,
      coalesce(sum(rf.vlucht_heen_prijs), 0)::numeric as vlucht_heen_prijs,
      coalesce(sum(rf.vlucht_terug_prijs), 0)::numeric as vlucht_terug_prijs,
      coalesce(sum(rf.toeristenbelasting_te_betalen), 0)::numeric as toeristenbelasting_te_betalen,
      coalesce(sum(rf.kost_accommodatie), 0)::numeric as kost_accommodatie,
      coalesce(sum(rf.kost_transport), 0)::numeric as kost_transport_raw,
      coalesce(sum(rf.kost_transfer), 0)::numeric as kost_transfer,
      coalesce(sum(rf.kost_extra_kosten), 0)::numeric as kost_extra_kosten,
      max(coalesce(rf.aantal_voorschotbetalingsherinneringen, 0))::int as agg_voorschot_herinneringen,
      max(coalesce(rf.aantal_totaalbetalingsherinneringen, 0))::int as agg_totaal_herinneringen
    from reizigers r
    left join public.statussen st_tr on st_tr.id = r.traveller_status_id
    left join reiziger_financien rf on rf.reiziger_id = r.id
    where not public.reiziger_status_uitgesloten_standaard_dashboards(st_tr.naam)
    group by r.boeking_id
  ) rf_agg on rf_agg.boeking_id = b.id
  left join boeking_financien f on f.boeking_id = b.id
  left join transporten t on t.id = b.transport_id
  left join boeking_accommodaties ba on ba.boeking_id = b.id
  where b.id = p_booking_id;

  if booking is null then
    return query select jsonb_build_object('error', 'Boeking niet gevonden') as payload;
    return;
  end if;

  select jsonb_build_object('id', d.id, 'naam', d.naam) into bestemming
  from bestemmingen d
  join boekingen b on b.bestemming_id = d.id
  where b.id = p_booking_id;

  bestemming_naam := bestemming->>'naam';

  select jsonb_build_object(
           'id', a.id,
           'naam', a.naam,
           'type', a.type,
           'leverancier', a.leverancier,
           'bestemming', jsonb_build_object('id', d.id, 'naam', d.naam)
         ) into accommodatie
  from accommodaties a
  join boekingen b on b.accommodatie_id = a.id
  join bestemmingen d on d.id = a.bestemming_id
  where b.id = p_booking_id;

  accommodatie_naam := accommodatie->>'naam';

  select jsonb_build_object('id', s.id, 'naam', s.naam, 'type', s.type) into boeking_status
  from statussen s
  join boekingen b on b.boeking_status_id = s.id
  where b.id = p_booking_id;

  boeking_status_naam := boeking_status->>'naam';

  select jsonb_build_object('id', s.id, 'naam', s.naam, 'type', s.type) into betaling_status
  from statussen s
  join boekingen b on b.betaling_status_id = s.id
  where b.id = p_booking_id;

  betaling_status_naam := betaling_status->>'naam';

  select jsonb_build_object('id', dg.id, 'naam', dg.naam) into doelgroep
  from doelgroepen dg
  join boekingen b on b.doelgroep_id = dg.id
  where b.id = p_booking_id;

  doelgroep_naam := doelgroep->>'naam';

  select jsonb_build_object('id', t.id, 'naam', t.naam) into transport
  from transporten t
  join boekingen b on b.transport_id = t.id
  where b.id = p_booking_id;

  transport_naam := transport->>'naam';

  -- Override ID-velden in de "booking" JSON met leesbare namen.
  -- Hiermee toon je in de UI direct "doelgroep/youth" i.p.v. een UUID.
  booking := booking || jsonb_build_object(
    'bestemming_id', bestemming_naam,
    'accommodatie_id', accommodatie_naam,
    'boeking_status_id', boeking_status_naam,
    'betaling_status_id', betaling_status_naam,
    'doelgroep_id', doelgroep_naam,
    'transport_id', transport_naam
  );

  select coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'id', r.id,
          'voornaam', r.voornaam,
          'achternaam', r.achternaam,
          'geboortedatum', r.geboortedatum,
          'geslacht', r.geslacht,
          'stad', r.stad,
          'provincie', r.provincie,
          'land', r.land,
          'school', r.school,
          'uitgesloten_van_communicatie', r.uitgesloten_van_communicatie,
          'incasso_status', r.incasso_status,
          'totaal_te_betalen', rf.totaal_te_betalen,
          'reeds_betaald', rf.reeds_betaald,
          'nog_te_betalen', rf.nog_te_betalen,
          'package_prijs', rf.package_prijs,
          'transfer_prijs', rf.transfer_prijs,
          'bagage_prijs', rf.bagage_prijs,
          'vlucht_heen_prijs', rf.vlucht_heen_prijs,
          'vlucht_terug_prijs', rf.vlucht_terug_prijs,
          'prijs_annulatieverzekering', rf.prijs_annulatieverzekering,
          'prijs_reisverzekering', rf.prijs_reisverzekering,
          'prijs_annulatie_en_reisverzekering', rf.prijs_annulatie_en_reisverzekering,
          'heeft_annulatieverzekering', rf.heeft_annulatieverzekering,
          'heeft_reisverzekering', rf.heeft_reisverzekering,
          'heeft_annulatie_en_reisverzekering', rf.heeft_annulatie_en_reisverzekering,
          'status', jsonb_build_object('id', s.id, 'naam', s.naam, 'type', s.type)
        ) order by r.id
      )
      from reizigers r
      left join reiziger_financien rf on rf.reiziger_id = r.id
      left join statussen s on s.id = r.traveller_status_id
      where r.boeking_id = p_booking_id
    ),
    '[]'::jsonb
  ) into reizigers;

  select coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'id', be.id,
          'naam', ex.naam,
          'type', ex.type,
          'prijs', ex.prijs,
          'excursie_type', ex.excursie_type,
          'vertrekdatum', be.vertrekdatum,
          'terugkeerdatum', be.terugkeerdatum,
          'betaling_pending', be.betaling_pending,
          'status', jsonb_build_object('id', s.id, 'naam', s.naam, 'type', s.type),
          'commentaar', be.commentaar,
          'betaaloptie', be.betaaloptie,
          'mollie_betaling_id', be.mollie_betaling_id
        ) order by be.vertrekdatum desc
      )
      from boeking_excursies be
      join excursies ex on ex.id = be.excursie_id
      left join statussen s on s.id = be.boeking_status_id
      where be.boeking_id = p_booking_id
    ),
    '[]'::jsonb
  ) into excursies;

  select coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'id', ba.id,
          'naam', ad.naam,
          'prijs', ba.prijs,
          'vertrekdatum', ba.vertrekdatum,
          'terugkeerdatum', ba.terugkeerdatum,
          'geboekt_in_online_account', ba.geboekt_in_online_account,
          'status', jsonb_build_object('id', s.id, 'naam', s.naam, 'type', s.type),
          'addon_id', ad.id
        ) order by ba.vertrekdatum desc
      )
      from boeking_addons ba
      join addons ad on ad.id = ba.addon_id
      left join statussen s on s.id = ba.boeking_status_id
      where ba.boeking_id = p_booking_id
    ),
    '[]'::jsonb
  ) into addons;

  return query
  select jsonb_build_object(
    'booking', booking,
    'bestemming', bestemming,
    'accommodatie', accommodatie,
    'boeking_status', boeking_status,
    'betaling_status', betaling_status,
    'doelgroep', doelgroep,
    'transport', transport,
    'reizigers', reizigers,
    'excursies', excursies,
    'addons', addons
  ) as payload;
end;
$$;

