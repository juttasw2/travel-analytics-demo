drop function if exists public.booking_ids_with_whole_booking_cancelled(uuid[]);
drop function if exists public.traveller_status_naam_is_whole_booking_cancelled(text);

-- ============================================================================
-- Centrale filterlogica: gewone dashboards vs. annulatiepagina
-- ============================================================================
-- Deploy na public.excursies_booking_status_is_cancelled (excursies_rpc.sql).
--
-- Boeking-niveau (gewone dashboards — omzet/pax/KPI's):
--   Sluit alleen boekingen uit met cancelled/dropped-blacklist (excursies_booking_status_is_cancelled).
--   Processing hoort hier níet: die boekingen blijven in omzet/pax.
--   Voor winst alleen: zie public.boeking_status_winst_resultaat_nul(uuid).
--   GEEN uitsluiting van een volledige boeking op basis van reizigersstatus.
--
-- Reiziger-niveau (gewone dashboards):
--   Sluit individuele reizigers uit als reizigersstatus (case-insensitive) voorkomt in:
--   - whole booking cancelled
--   - cancelled  (met uitzondering van duidelijke 'not cancelled'-varianten)
--   - dropped
--
-- Zie public.reiziger_status_uitgesloten_standaard_dashboards(text).

create or replace function public.reiziger_status_uitgesloten_standaard_dashboards(p_naam text)
returns boolean
language sql
immutable
as $$
  select case
    when coalesce(trim(p_naam), '') = '' then false
    else (
      with v as (select lower(trim(p_naam)) as s)
      select
        s like '%whole booking cancelled%'
        or s like '%dropped%'
        or (
          s like '%cancelled%'
          and s not like '%not cancelled%'
          and s not like '%non-cancelled%'
          and s not like '%non cancelled%'
        )
      from v
    )
  end;
$$;

comment on function public.reiziger_status_uitgesloten_standaard_dashboards(text) is
  'Gewone dashboards: true = deze reiziger niet meetellen (substring-match, case-insensitive).';

-- CLOUD SQL: grant execute on function public.reiziger_status_uitgesloten_standaard_dashboards(text) to anon, authenticated, service_role;

-- Boeking volledig uit standaard dashboards (cancelled/dropped-blacklist + processing).
-- Los van public.excursies_booking_status_is_cancelled (die géén processing bevat — Excursies-pagina).
create or replace function public.standaard_dashboard_boekingstatus_sluit_volledig_uit(p_naam text)
returns boolean
language sql
stable
as $$
  select case
    when coalesce(trim(p_naam), '') = '' then false
    else
      public.excursies_booking_status_is_cancelled(p_naam)
      or lower(trim(p_naam)) = 'processing'
  end;
$$;

comment on function public.standaard_dashboard_boekingstatus_sluit_volledig_uit(text) is
  'Standaard dashboards: true = boeking volledig verbergen (annulatie-blacklist óf processing).';

-- CLOUD SQL: grant execute on function public.standaard_dashboard_boekingstatus_sluit_volledig_uit(text) to anon, authenticated, service_role;

-- Alleen voor winstberekening: processing → winst 0 (boeking kan wél in omzet/pax voorkomen).
create or replace function public.boeking_status_winst_resultaat_nul(p_boeking_id uuid)
returns boolean
language sql
stable
as $$
  select coalesce(
    (
      select lower(trim(coalesce(st_book.naam, ''))) = 'processing'
      from public.boekingen b
      left join public.statussen st_book on st_book.id = b.boeking_status_id
      where b.id = p_boeking_id
    ),
    false
  );
$$;

comment on function public.boeking_status_winst_resultaat_nul(uuid) is
  'Winst-kolom: true als boekingstatus processing (winst = 0; omzet/pax niet hierop filteren).';

-- CLOUD SQL: grant execute on function public.boeking_status_winst_resultaat_nul(uuid) to anon, authenticated, service_role;

-- Alleen boekingstatus (geen reizigers-logica). GEEN processing — dat beïnvloedt alleen winst (zie hieronder).
create or replace function public.boeking_id_excluded_from_standard_dashboards(p_boeking_id uuid)
returns boolean
language sql
stable
as $$
  select coalesce(
    (
      select
        st_book.id is not null
        and public.excursies_booking_status_is_cancelled(st_book.naam)
      from public.boekingen b
      left join public.statussen st_book on st_book.id = b.boeking_status_id
      where b.id = p_boeking_id
    ),
    false
  );
$$;

comment on function public.boeking_id_excluded_from_standard_dashboards(uuid) is
  'Omzet/pax/KPI''s: uitsluiten op boekingstatus cancelled/dropped-blacklist alleen. Geen processing; geen reizigersfilter op boeking-niveau.';

-- CLOUD SQL: grant execute on function public.boeking_id_excluded_from_standard_dashboards(uuid) to anon, authenticated, service_role;

-- Synoniem (duidelijke naam): boeking hoort niet op standaard dashboards door boekingstatus.
create or replace function public.boeking_is_uitgesloten_standaard_dashboard(p_boeking_id uuid)
returns boolean
language sql
stable
as $$
  select public.boeking_id_excluded_from_standard_dashboards(p_boeking_id);
$$;

comment on function public.boeking_is_uitgesloten_standaard_dashboard(uuid) is
  'True als deze boeking volledig verborgen hoort op gewone dashboards omzet/pax (cancelled/dropped-blacklist).';

-- CLOUD SQL: grant execute on function public.boeking_is_uitgesloten_standaard_dashboard(uuid) to anon, authenticated, service_role;

-- Centrale pax-definitie alle gewone dashboards: aantal reizigers per boeking zonder
-- uitgesloten reizigersstatus (zelfde als active_pax/overzicht).
create or replace view public.vw_actieve_reizigers_per_boeking as
select
  r.boeking_id,
  count(*)::int as actieve_reizigers
from public.reizigers r
left join public.statussen st_tr on st_tr.id = r.traveller_status_id
where not public.reiziger_status_uitgesloten_standaard_dashboards(st_tr.naam)
group by r.boeking_id;

comment on view public.vw_actieve_reizigers_per_boeking is
  'Per boeking: aantal actieve (niet-geannuleerde) reizigers voor standaard dashboards. Join na filter op boeking.';

-- CLOUD SQL: grant select on public.vw_actieve_reizigers_per_boeking to anon, authenticated, service_role;

-- Rijniveau: hoort deze reiziger mee op standaard dashboards (boeking + status)?
create or replace function public.reiziger_meetelt_standaard_dashboard(p_reiziger_id uuid)
returns boolean
language sql
stable
as $$
  select coalesce(
    (
      select
        not public.boeking_is_uitgesloten_standaard_dashboard(b.id)
        and not public.reiziger_status_uitgesloten_standaard_dashboards(st_tr.naam)
      from public.reizigers r
      join public.boekingen b on b.id = r.boeking_id
      left join public.statussen st_tr on st_tr.id = r.traveller_status_id
      where r.id = p_reiziger_id
    ),
    false
  );
$$;

comment on function public.reiziger_meetelt_standaard_dashboard(uuid) is
  'True als reiziger meetelt op gewone dashboards (boeking niet cancelled/dropped; reiziger niet cancelled/dropped/wbc).';

-- CLOUD SQL: grant execute on function public.reiziger_meetelt_standaard_dashboard(uuid) to anon, authenticated, service_role;

-- Één winstdefinitie voor Financiën, Vergelijkingen, Inzichten-verliezen, enz.
-- Componenten = sommen over actieve reizigers (per_booking_financien); annulatie/reis/combi uit ins_scope;
-- excursies = excursions_totaal_excel uit boeking_financien óf som boeking_excursies.
-- Bij som kost_accommodatie = 0 wordt winst 0 (onvolledige kostdata).
create or replace function public.standaard_dashboard_winst_formule(
  p_totaal_te_betalen numeric,
  p_excursies_totaal numeric,
  p_prijs_annulatieverzekering numeric,
  p_prijs_reisverzekering numeric,
  p_prijs_annulatie_en_reisverzekering numeric,
  p_kortingsbedrag numeric,
  p_kost_accommodatie_som numeric,
  p_kost_transport_som numeric,
  p_kost_transfer_som numeric,
  p_package_prijs_som numeric
) returns numeric
language sql
immutable
as $$
  select case
    when coalesce(p_kost_accommodatie_som, 0) = 0 then 0::numeric
    else
      coalesce(p_totaal_te_betalen, 0)
      - coalesce(p_excursies_totaal, 0)
      - coalesce(p_prijs_annulatieverzekering, 0)
      - coalesce(p_prijs_reisverzekering, 0)
      - coalesce(p_prijs_annulatie_en_reisverzekering, 0)
      - coalesce(p_kortingsbedrag, 0)
      - coalesce(p_kost_accommodatie_som, 0)
      - coalesce(p_kost_transport_som, 0)
      - coalesce(p_kost_transfer_som, 0)
      - coalesce(p_package_prijs_som, 0)
  end;
$$;

comment on function public.standaard_dashboard_winst_formule(
  numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric
) is
  'Winst obv actieve reizigers: omzet minus excursies, 3 verzekeringen, korting, acco/transport/transfer-kosten, package_prijs.';

-- CLOUD SQL: grant execute on function public.standaard_dashboard_winst_formule(...) to anon, authenticated, service_role;

-- Per boeking: annulatie voor KPI’s (boeking geannuleerd = alle pax/omzet; anders alleen uitgesloten reizigers).
create or replace function public.annulaties_per_booking_facts(p_booking_ids uuid[])
returns table (
  booking_id uuid,
  meets_annulatie_criteria boolean,
  annulled_travellers int,
  annulled_revenue numeric
)
language sql
stable
as $$
  with bk as (
    select b.id, b.aantal_reizigers
    from public.boekingen b
    where p_booking_ids is not null
      and cardinality(p_booking_ids) > 0
      and b.id = any(p_booking_ids)
  ),
  stb as (
    select
      bk.id as booking_id,
      coalesce(
        st.id is not null and public.excursies_booking_status_is_cancelled(st.naam),
        false
      ) as booking_cancelled
    from bk
    left join public.boekingen b on b.id = bk.id
    left join public.statussen st on st.id = b.boeking_status_id
  ),
  rx as (
    select
      r.boeking_id,
      public.reiziger_status_uitgesloten_standaard_dashboards(st.naam) as tr_excl,
      coalesce(rf.totaal_te_betalen, 0)::numeric as totaal_te_betalen
    from public.reizigers r
    join bk on bk.id = r.boeking_id
    left join public.statussen st on st.id = r.traveller_status_id
    left join public.reiziger_financien rf on rf.reiziger_id = r.id
  ),
  agg as (
    select
      bk.id as booking_id,
      coalesce(stb.booking_cancelled, false) as booking_cancelled,
      coalesce(count(*) filter (where rx.tr_excl), 0)::int as excluded_travellers,
      coalesce(sum(case when rx.tr_excl then rx.totaal_te_betalen else 0 end), 0)::numeric as excluded_revenue,
      coalesce(sum(rx.totaal_te_betalen), 0)::numeric as total_rev_all_travellers,
      coalesce(bk.aantal_reizigers, 0)::int as decl_pax,
      coalesce(count(*), 0)::int as cnt_reizigers_rows
    from bk
    left join stb on stb.booking_id = bk.id
    left join rx on rx.boeking_id = bk.id
    group by bk.id, stb.booking_cancelled, bk.aantal_reizigers
  )
  select
    a.booking_id,
    (a.booking_cancelled or a.excluded_travellers > 0) as meets_annulatie_criteria,
    case
      when a.booking_cancelled then greatest(coalesce(nullif(a.decl_pax, 0), a.cnt_reizigers_rows), a.cnt_reizigers_rows)
      else a.excluded_travellers
    end::int as annulled_travellers,
    case
      when a.booking_cancelled then a.total_rev_all_travellers
      else a.excluded_revenue
    end::numeric as annulled_revenue
  from agg a;
$$;

comment on function public.annulaties_per_booking_facts(uuid[]) is
  'Annulaties-pagina: per boeking annulatie-KPI''s; geen dubbele reiziger-telling bij geannuleerde boeking.';

-- CLOUD SQL: grant execute on function public.annulaties_per_booking_facts(uuid[]) to anon, authenticated, service_role;
