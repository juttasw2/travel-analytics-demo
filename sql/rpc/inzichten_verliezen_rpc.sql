-- Inzichten > Verliezen
-- Omzet/pax/kosten in UI: legacy-regex reizigers (gelijk Financiën-boekingrij).
-- Winst: standaard_dashboard_winst_formule obv reiziger_status_uitgesloten_standaard_dashboards; processing → winst 0.
-- Deployment: voer dit bestand uit in Supabase SQL Editor.

create or replace function public.inzichten_verliezen_rpc(
  p_brand text default '__all__',
  p_bestemming_id text default null,
  p_bestemming_naam text default null,
  p_accommodatie_id text default null,
  p_year int default 0,
  p_month int default 0,
  p_boekingsgrootte text default null,
  p_heeft_kortingscode boolean default null,
  p_transport_id text default null,
  p_oorzaak text default null
)
returns jsonb
language sql
stable
as $$
with traveller_active_omzet as (
  select
    r.id as reiziger_id,
    r.boeking_id
  from public.reizigers r
  left join public.statussen st_trav on st_trav.id = r.traveller_status_id
  where lower(trim(coalesce(st_trav.naam, ''))) !~ '^(cancelled|canceled|cancel|geannuleerd|gecanceld|annulatie|annulering|annule|annulé|dropped|drop)([^a-z0-9].*)?$'
),
traveller_active_winst as (
  select
    r.id as reiziger_id,
    r.boeking_id
  from public.reizigers r
  left join public.statussen st_trav on st_trav.id = r.traveller_status_id
  where not public.reiziger_status_uitgesloten_standaard_dashboards(st_trav.naam)
),
active_pax_booking as (
  select
    ta.boeking_id,
    count(*)::int as actieve_reizigers
  from traveller_active_omzet ta
  group by ta.boeking_id
),
rf_booking as (
  select
    ta.boeking_id,
    coalesce(sum(coalesce(rf.totaal_te_betalen, 0)), 0)::numeric as opbrengst,
    coalesce(sum(coalesce(rf.kost_accommodatie, 0)), 0)::numeric as kost_accommodatie,
    coalesce(sum(coalesce(rf.kost_transport, 0)), 0)::numeric as kost_transport,
    coalesce(sum(coalesce(rf.kost_transfer, 0)), 0)::numeric as kost_transfer,
    coalesce(sum(coalesce(rf.kost_extra_kosten, 0)), 0)::numeric as kost_extra_kosten,
    coalesce(sum(coalesce(rf.package_prijs, 0)), 0)::numeric as package_prijs_som,
    coalesce(sum(coalesce(rf.discount_amount, 0)), 0)::numeric as reiziger_discount_amount,
    array_remove(array_agg(distinct nullif(trim(coalesce(rf.discount_code_used, '')), '')), null)::text[] as reiziger_discount_codes
  from traveller_active_omzet ta
  left join public.reiziger_financien rf on rf.reiziger_id = ta.reiziger_id
  group by ta.boeking_id
),
rf_booking_winst as (
  select
    ta.boeking_id,
    coalesce(sum(coalesce(rf.totaal_te_betalen, 0)), 0)::numeric as totaal_te_betalen_winst,
    coalesce(sum(coalesce(rf.kost_accommodatie, 0)), 0)::numeric as kost_accommodatie_winst,
    coalesce(sum(coalesce(rf.kost_transport, 0)), 0)::numeric as kost_transport_winst,
    coalesce(sum(coalesce(rf.kost_transfer, 0)), 0)::numeric as kost_transfer_winst,
    coalesce(sum(coalesce(rf.package_prijs, 0)), 0)::numeric as package_prijs_som_winst,
    coalesce(sum(coalesce(rf.discount_amount, 0)), 0)::numeric as reiziger_discount_amount_winst
  from traveller_active_winst ta
  left join public.reiziger_financien rf on rf.reiziger_id = ta.reiziger_id
  group by ta.boeking_id
),
ins as (
  select
    ta.boeking_id,
    coalesce(sum(rf.prijs_annulatieverzekering), 0)::numeric as prijs_annulatieverzekering,
    coalesce(sum(rf.prijs_reisverzekering), 0)::numeric as prijs_reisverzekering,
    coalesce(sum(rf.prijs_annulatie_en_reisverzekering), 0)::numeric as prijs_annulatie_en_reisverzekering
  from traveller_active_omzet ta
  left join public.reiziger_financien rf on rf.reiziger_id = ta.reiziger_id
  group by ta.boeking_id
),
ins_winst as (
  select
    ta.boeking_id,
    coalesce(sum(rf.prijs_annulatieverzekering), 0)::numeric as prijs_annulatieverzekering,
    coalesce(sum(rf.prijs_reisverzekering), 0)::numeric as prijs_reisverzekering,
    coalesce(sum(rf.prijs_annulatie_en_reisverzekering), 0)::numeric as prijs_annulatie_en_reisverzekering
  from traveller_active_winst ta
  left join public.reiziger_financien rf on rf.reiziger_id = ta.reiziger_id
  group by ta.boeking_id
),
exc as (
  select
    bex.boeking_id,
    coalesce(sum(coalesce(bex.verkoopprijs, ex.prijs, 0)), 0)::numeric as excursie_prijs
  from public.boeking_excursies bex
  left join public.excursies ex on ex.id = bex.excursie_id
  group by bex.boeking_id
),
base as (
  select
    b.id as boeking_id,
    b.order_nummer,
    coalesce(nullif(trim(b.brand), ''), '(onbekend)')::text as brand,
    d.id::text as bestemming_id,
    d.naam::text as bestemming_naam,
    acc.id::text as accommodatie_id,
    acc.naam::text as accommodatie_naam,
    t.id::text as transport_id,
    coalesce(t.naam, '—')::text as transport_naam,
    b.vertrekdatum::date as vertrekdatum,
    b.terugkeerdatum::date as terugkeerdatum,
    b.boekingsdatum::date as boekingsdatum,
    coalesce(ap.actieve_reizigers, 0)::int as aantal_reizigers,
    coalesce(rf.opbrengst, 0)::numeric as opbrengst,
    coalesce(rf.kost_accommodatie, 0)::numeric as kost_accommodatie,
    coalesce(rf.kost_transport, 0)::numeric as kost_transport,
    coalesce(rf.kost_transfer, 0)::numeric as kost_transfer,
    coalesce(rf.kost_extra_kosten, 0)::numeric as kost_extra_kosten,
    coalesce(rf.reiziger_discount_amount, 0)::numeric as reiziger_discount_amount,
    coalesce(bf.discount_amount, 0)::numeric as boeking_discount_amount,
    nullif(trim(coalesce(bf.gebruikte_kortingscode, '')), '')::text as boeking_discount_code,
    coalesce(rf.reiziger_discount_codes, '{}'::text[]) as reiziger_discount_codes,
    coalesce(bf.excursions_totaal_excel, exc.excursie_prijs, 0)::numeric as excursies_totaal_voor_winst,
    coalesce(ins.prijs_annulatieverzekering, 0)::numeric as prijs_annulatieverzekering_omzet,
    coalesce(ins.prijs_reisverzekering, 0)::numeric as prijs_reisverzekering_omzet,
    coalesce(ins.prijs_annulatie_en_reisverzekering, 0)::numeric as prijs_combi_verzekering_omzet,
    coalesce(ins_w.prijs_annulatieverzekering, 0)::numeric as ins_ann,
    coalesce(ins_w.prijs_reisverzekering, 0)::numeric as ins_reis,
    coalesce(ins_w.prijs_annulatie_en_reisverzekering, 0)::numeric as ins_combi,
    coalesce(rfw.package_prijs_som_winst, 0)::numeric as package_prijs_som,
    coalesce(rfw.reiziger_discount_amount_winst, bf.discount_amount, 0)::numeric as korting_winst,
    coalesce(rfw.totaal_te_betalen_winst, 0)::numeric as opbrengst_winst,
    coalesce(rfw.kost_accommodatie_winst, 0)::numeric as kost_accommodatie_winst,
    coalesce(rfw.kost_transport_winst, 0)::numeric as kost_transport_winst,
    coalesce(rfw.kost_transfer_winst, 0)::numeric as kost_transfer_winst
  from public.boekingen b
  join public.bestemmingen d on d.id = b.bestemming_id
  left join public.accommodaties acc on acc.id = b.accommodatie_id
  left join public.transporten t on t.id = b.transport_id
  left join public.boeking_financien bf on bf.boeking_id = b.id
  left join rf_booking rf on rf.boeking_id = b.id
  left join rf_booking_winst rfw on rfw.boeking_id = b.id
  left join ins on ins.boeking_id = b.id
  left join ins_winst ins_w on ins_w.boeking_id = b.id
  left join exc on exc.boeking_id = b.id
  left join active_pax_booking ap on ap.boeking_id = b.id
  left join public.statussen st_book on st_book.id = b.boeking_status_id
  where
    not public.boeking_id_excluded_from_standard_dashboards(b.id)
    and (
      p_brand is null
      or trim(p_brand) = ''
      or lower(trim(p_brand)) = '__all__'
      or lower(trim(coalesce(b.brand, ''))) = lower(trim(p_brand))
    )
    and (p_bestemming_id is null or trim(p_bestemming_id) = '' or d.id::text = trim(p_bestemming_id))
    and (p_bestemming_naam is null or trim(p_bestemming_naam) = '' or d.naam = trim(p_bestemming_naam))
    and (p_accommodatie_id is null or trim(p_accommodatie_id) = '' or acc.id::text = trim(p_accommodatie_id))
    and (p_transport_id is null or trim(p_transport_id) = '' or t.id::text = trim(p_transport_id))
    and (p_year is null or p_year <= 0 or extract(year from b.vertrekdatum)::int = p_year)
    and (p_month is null or p_month <= 0 or extract(month from b.vertrekdatum)::int = p_month)
),
scope_enriched as (
  select
    s.*,
    (s.kost_accommodatie + s.kost_transport + s.kost_transfer + s.kost_extra_kosten)::numeric as totale_kosten,
    case
      when s.opbrengst <> 0 then s.winst / s.opbrengst
      else null
    end::numeric as winstmarge,
    (s.reiziger_discount_amount + s.boeking_discount_amount)::numeric as discount_amount,
    case when s.aantal_reizigers > 0 then s.opbrengst / s.aantal_reizigers else 0 end::numeric as omzet_per_persoon,
    case
      when s.aantal_reizigers > 0
      then (s.kost_accommodatie + s.kost_transport + s.kost_transfer + s.kost_extra_kosten) / s.aantal_reizigers
      else 0
    end::numeric as kosten_per_persoon,
    case when s.aantal_reizigers > 0 then s.winst / s.aantal_reizigers else 0 end::numeric as verlies_per_persoon,
    case when s.aantal_reizigers > 0 then s.kost_accommodatie / s.aantal_reizigers else 0 end::numeric as accommodatiekost_per_persoon,
    case when s.aantal_reizigers > 0 then s.kost_transport / s.aantal_reizigers else 0 end::numeric as transportkost_per_persoon,
    case when s.aantal_reizigers > 0 then s.kost_transfer / s.aantal_reizigers else 0 end::numeric as transferkost_per_persoon,
    case when s.aantal_reizigers > 0 then s.kost_extra_kosten / s.aantal_reizigers else 0 end::numeric as extra_kosten_per_persoon,
    case
      when s.boeking_discount_code is not null then s.boeking_discount_code
      when coalesce(array_length(s.reiziger_discount_codes, 1), 0) > 0 then s.reiziger_discount_codes[1]
      else null
    end::text as discount_code
  from (
    select
      q.*,
      (
        case
          when public.boeking_status_winst_resultaat_nul(q.boeking_id) then 0::numeric
          else public.standaard_dashboard_winst_formule(
            q.opbrengst_winst,
            q.excursies_totaal_voor_winst,
            q.ins_ann,
            q.ins_reis,
            q.ins_combi,
            q.korting_winst,
            q.kost_accommodatie_winst,
            q.kost_transport_winst,
            q.kost_transfer_winst,
            q.package_prijs_som
          )
        end
      )::numeric as winst
    from base q
  ) s
),
baseline as (
  select avg((opbrengst / nullif(aantal_reizigers, 0))::numeric) as avg_opbrengst_per_reiziger
  from scope_enriched
  where aantal_reizigers > 0 and opbrengst > 0
),
scope_labeled as (
  select
    s.*,
    case
      when s.aantal_reizigers <= 1 then '1 reiziger'
      when s.aantal_reizigers = 2 then '2 reizigers'
      when s.aantal_reizigers between 3 and 4 then '3-4 reizigers'
      else '5+ reizigers'
    end::text as group_size_label,
    case when s.totale_kosten > 0 then s.kost_accommodatie / s.totale_kosten else 0 end::numeric as accommodatiekost_aandeel,
    case when s.totale_kosten > 0 then s.kost_transport / s.totale_kosten else 0 end::numeric as transportkost_aandeel,
    case when s.totale_kosten > 0 then s.kost_transfer / s.totale_kosten else 0 end::numeric as transferkost_aandeel,
    case when s.totale_kosten > 0 then s.kost_extra_kosten / s.totale_kosten else 0 end::numeric as extra_kosten_aandeel,
    case
      when s.kost_accommodatie >= s.kost_transport and s.kost_accommodatie >= s.kost_transfer and s.kost_accommodatie >= s.kost_extra_kosten then 'accommodatie'
      when s.kost_transport >= s.kost_transfer and s.kost_transport >= s.kost_extra_kosten then 'transport'
      when s.kost_transfer >= s.kost_extra_kosten then 'transfer'
      else 'extra kosten'
    end::text as grootste_kostendrijver,
    (case when (case when s.totale_kosten > 0 then s.kost_accommodatie / s.totale_kosten else 0 end) >= 0.50 then 1 else 0 end) as cause_acco,
    (case when (case when s.totale_kosten > 0 then s.kost_transport / s.totale_kosten else 0 end) >= 0.40 then 1 else 0 end) as cause_transport,
    (case when s.discount_amount > 0 and s.opbrengst > 0 and (s.discount_amount / s.opbrengst) >= 0.10 then 1 else 0 end) as cause_discount,
    (case when s.aantal_reizigers <= 2 then 1 else 0 end) as cause_small_group,
    (case
      when s.aantal_reizigers > 0 and (select avg_opbrengst_per_reiziger from baseline) is not null
           and (s.opbrengst / s.aantal_reizigers) < (select avg_opbrengst_per_reiziger from baseline) * 0.75
      then 1 else 0
    end) as cause_low_rev_pax
  from scope_enriched s
),
scope_with_oorzaak as (
  select
    x.*,
    case
      when (x.cause_acco + x.cause_transport + x.cause_discount + x.cause_small_group + x.cause_low_rev_pax) > 1 then 'Gemengde oorzaak'
      when x.cause_acco = 1 then 'Hoge accommodatiekost'
      when x.cause_transport = 1 then 'Hoge transportkost'
      when x.cause_discount = 1 then 'Sterke korting'
      when x.cause_small_group = 1 then 'Kleine boekingsgrootte'
      when x.cause_low_rev_pax = 1 then 'Lage opbrengst per reiziger'
      else 'Onbekend'
    end::text as oorzaak_label
  from scope_labeled x
),
loss_base as (
  select *
  from scope_with_oorzaak
  where winst < 0 or coalesce(winstmarge, 0) < 0
),
loss_scoped as (
  select *
  from loss_base
  where
    (
      p_boekingsgrootte is null or trim(p_boekingsgrootte) = '' or lower(trim(p_boekingsgrootte)) = '__all__'
      or lower(group_size_label) = lower(trim(p_boekingsgrootte))
    )
    and (
      p_heeft_kortingscode is null
      or (p_heeft_kortingscode = true and discount_code is not null)
      or (p_heeft_kortingscode = false and discount_code is null)
    )
    and (
      p_oorzaak is null or trim(p_oorzaak) = '' or lower(trim(p_oorzaak)) = '__all__'
      or lower(oorzaak_label) = lower(trim(p_oorzaak))
    )
),
summary_json as (
  select jsonb_build_object(
    'total_loss_bookings', coalesce((select count(*) from loss_scoped), 0),
    'total_loss_amount', coalesce((select sum(winst) from loss_scoped), 0),
    'avg_margin', coalesce((select avg(winstmarge) from loss_scoped), 0),
    'total_pax_loss_bookings', coalesce((select sum(aantal_reizigers) from loss_scoped), 0),
    'avg_loss_per_person', coalesce((select avg(verlies_per_persoon) from loss_scoped), 0),
    'median_loss_per_person', coalesce((select percentile_cont(0.5) within group (order by verlies_per_persoon) from loss_scoped), 0),
    'share_loss_bookings',
      case
        when (select count(*) from scope_with_oorzaak) > 0
        then coalesce(
          (
            select (count(*)::numeric / (select count(*)::numeric from scope_with_oorzaak))
            from loss_scoped
          ),
          0
        )
        else 0
      end,
    'worst_loss_order_nummer', coalesce((select order_nummer from loss_scoped order by winst asc nulls last, boeking_id limit 1), '—'),
    'worst_loss_amount', coalesce((select winst from loss_scoped order by winst asc nulls last, boeking_id limit 1), 0),
    'worst_loss_per_person', coalesce((select verlies_per_persoon from loss_scoped order by verlies_per_persoon asc nulls last, boeking_id limit 1), 0)
  ) as value
),
by_destination_json as (
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'bestemming_naam', bestemming_naam,
        'loss_bookings', loss_bookings,
        'total_loss', total_loss,
        'avg_loss_per_person', avg_loss_per_person,
        'avg_margin', avg_margin,
        'total_pax', total_pax
      )
      order by total_loss asc, bestemming_naam
    ),
    '[]'::jsonb
  ) as value
  from (
    select
      bestemming_naam,
      count(*)::int as loss_bookings,
      sum(winst)::numeric as total_loss,
      avg(verlies_per_persoon)::numeric as avg_loss_per_person,
      avg(winstmarge)::numeric as avg_margin,
      sum(aantal_reizigers)::int as total_pax
    from loss_scoped
    group by bestemming_naam
  ) q
),
by_period_json as (
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'year', jaar,
        'month', maand,
        'vertrekweek', null,
        'loss_bookings', loss_bookings,
        'total_loss', total_loss,
        'total_pax', total_pax,
        'avg_loss_per_person', avg_loss_per_person,
        'avg_margin', avg_margin
      )
      order by jaar, maand
    ),
    '[]'::jsonb
  ) as value
  from (
    select
      extract(year from vertrekdatum)::int as jaar,
      extract(month from vertrekdatum)::int as maand,
      count(*)::int as loss_bookings,
      sum(winst)::numeric as total_loss,
      sum(aantal_reizigers)::int as total_pax,
      avg(verlies_per_persoon)::numeric as avg_loss_per_person,
      avg(winstmarge)::numeric as avg_margin
    from loss_scoped
    group by extract(year from vertrekdatum)::int, extract(month from vertrekdatum)::int
  ) q
),
by_transport_json as (
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'transport_naam', transport_naam,
        'loss_bookings', loss_bookings,
        'total_loss', total_loss,
        'total_pax', total_pax,
        'avg_loss_per_person', avg_loss_per_person
      )
      order by avg_loss_per_person asc, transport_naam
    ),
    '[]'::jsonb
  ) as value
  from (
    select
      coalesce(nullif(trim(transport_naam), ''), '—') as transport_naam,
      count(*)::int as loss_bookings,
      sum(winst)::numeric as total_loss,
      sum(aantal_reizigers)::int as total_pax,
      avg(verlies_per_persoon)::numeric as avg_loss_per_person
    from loss_scoped
    group by coalesce(nullif(trim(transport_naam), ''), '—')
  ) q
),
by_group_size_json as (
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'group_size_label', group_size_label,
        'loss_bookings', loss_bookings,
        'total_loss', total_loss,
        'avg_margin', avg_margin
      )
      order by
        case group_size_label
          when '1 reiziger' then 1
          when '2 reizigers' then 2
          when '3-4 reizigers' then 3
          else 4
        end
    ),
    '[]'::jsonb
  ) as value
  from (
    select
      group_size_label,
      count(*)::int as loss_bookings,
      sum(winst)::numeric as total_loss,
      avg(winstmarge)::numeric as avg_margin
    from loss_scoped
    group by group_size_label
  ) q
),
by_discount_code_json as (
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'discount_code', discount_code,
        'loss_bookings', loss_bookings,
        'total_discount', total_discount,
        'total_loss', total_loss,
        'avg_margin', avg_margin
      )
      order by total_loss asc, discount_code
    ),
    '[]'::jsonb
  ) as value
  from (
    select
      coalesce(nullif(trim(discount_code), ''), '—') as discount_code,
      count(*)::int as loss_bookings,
      sum(discount_amount)::numeric as total_discount,
      sum(winst)::numeric as total_loss,
      avg(winstmarge)::numeric as avg_margin
    from loss_scoped
    group by coalesce(nullif(trim(discount_code), ''), '—')
  ) q
),
cost_breakdown_json as (
  select jsonb_build_object(
    'totale_accommodatiekost', coalesce(sum(kost_accommodatie), 0),
    'totale_transportkost', coalesce(sum(kost_transport), 0),
    'totale_transferkost', coalesce(sum(kost_transfer), 0),
    'totale_extra_kosten', coalesce(sum(kost_extra_kosten), 0),
    'avg_omzet_per_persoon', coalesce(avg(omzet_per_persoon), 0),
    'avg_kosten_per_persoon', coalesce(avg(kosten_per_persoon), 0),
    'avg_verlies_per_persoon', coalesce(avg(verlies_per_persoon), 0),
    'avg_accommodatiekost_per_persoon', coalesce(avg(accommodatiekost_per_persoon), 0),
    'avg_transportkost_per_persoon', coalesce(avg(transportkost_per_persoon), 0),
    'avg_transferkost_per_persoon', coalesce(avg(transferkost_per_persoon), 0),
    'avg_extra_kosten_per_persoon', coalesce(avg(extra_kosten_per_persoon), 0),
    'aandeel_accommodatiekost', case when coalesce(sum(totale_kosten), 0) > 0 then coalesce(sum(kost_accommodatie), 0) / sum(totale_kosten) else 0 end,
    'aandeel_transportkost', case when coalesce(sum(totale_kosten), 0) > 0 then coalesce(sum(kost_transport), 0) / sum(totale_kosten) else 0 end,
    'aandeel_transferkost', case when coalesce(sum(totale_kosten), 0) > 0 then coalesce(sum(kost_transfer), 0) / sum(totale_kosten) else 0 end,
    'aandeel_extra_kosten', case when coalesce(sum(totale_kosten), 0) > 0 then coalesce(sum(kost_extra_kosten), 0) / sum(totale_kosten) else 0 end
  ) as value
  from loss_scoped
),
rows_json as (
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'boeking_id', boeking_id,
        'order_nummer', order_nummer,
        'brand', brand,
        'bestemming_naam', bestemming_naam,
        'accommodatie_naam', accommodatie_naam,
        'transport_naam', transport_naam,
        'vertrekdatum', vertrekdatum,
        'terugkeerdatum', terugkeerdatum,
        'boekingsdatum', boekingsdatum,
        'aantal_reizigers', aantal_reizigers,
        'opbrengst', opbrengst,
        'omzet_per_persoon', omzet_per_persoon,
        'totale_kosten', totale_kosten,
        'kosten_per_persoon', kosten_per_persoon,
        'winst', winst,
        'verlies_per_persoon', verlies_per_persoon,
        'winstmarge', winstmarge,
        'kost_accommodatie', kost_accommodatie,
        'accommodatiekost_per_persoon', accommodatiekost_per_persoon,
        'kost_transport', kost_transport,
        'transportkost_per_persoon', transportkost_per_persoon,
        'kost_transfer', kost_transfer,
        'transferkost_per_persoon', transferkost_per_persoon,
        'kost_extra_kosten', kost_extra_kosten,
        'extra_kosten_per_persoon', extra_kosten_per_persoon,
        'discount_amount', discount_amount,
        'discount_code', discount_code,
        'accommodatiekost_aandeel', accommodatiekost_aandeel,
        'transportkost_aandeel', transportkost_aandeel,
        'transferkost_aandeel', transferkost_aandeel,
        'extra_kosten_aandeel', extra_kosten_aandeel,
        'grootste_kostendrijver', grootste_kostendrijver,
        'oorzaak_label', oorzaak_label
      )
      order by verlies_per_persoon asc, vertrekdatum desc nulls last, boeking_id
    ),
    '[]'::jsonb
  ) as value
  from loss_scoped
)
select jsonb_build_object(
  'summary', coalesce((select value from summary_json), '{}'::jsonb),
  'by_destination', coalesce((select value from by_destination_json), '[]'::jsonb),
  'by_period', coalesce((select value from by_period_json), '[]'::jsonb),
  'by_transport', coalesce((select value from by_transport_json), '[]'::jsonb),
  'by_group_size', coalesce((select value from by_group_size_json), '[]'::jsonb),
  'by_discount_code', coalesce((select value from by_discount_code_json), '[]'::jsonb),
  'cost_breakdown', coalesce((select value from cost_breakdown_json), '{}'::jsonb),
  'rows', coalesce((select value from rows_json), '[]'::jsonb)
);
$$;

comment on function public.inzichten_verliezen_rpc(text, text, text, text, int, int, text, boolean, text, text) is
  'Inzichten verliezen: verliesboekingen met oorzaakanalyse, KPIs en grafiekdatasets.';
