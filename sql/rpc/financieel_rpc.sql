-- Financiën-pagina: alle boekingen met financiële velden voor client-side aggregatie.
-- Omzet/pax/KPI-rijen: boekingstatus cancelled/dropped-blacklist (geen processing); reizigers via legacy-regex (zoals vóór winst-refactor).
-- Winst: aparte aggregaten obv reiziger_status_uitgesloten_standaard_dashboards + standaard_dashboard_winst_formule; processing → winst 0.
-- Voer dit uit in Supabase SQL Editor na deploy.

create or replace function public.financieel_bookings_rpc(
  p_brand text,
  p_bestemming_naam text,
  p_land text,
  p_year int,
  p_period text
)
returns jsonb
language sql
stable
as $$
  with traveller_active as (
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
  ins as (
    select
      ta.boeking_id,
      coalesce(sum(rf.prijs_annulatieverzekering), 0)::numeric as prijs_annulatieverzekering,
      coalesce(sum(rf.prijs_reisverzekering), 0)::numeric as prijs_reisverzekering,
      coalesce(sum(rf.prijs_annulatie_en_reisverzekering), 0)::numeric as prijs_annulatie_en_reisverzekering
    from traveller_active ta
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
  land_first as (
    select distinct on (r.boeking_id)
      r.boeking_id,
      nullif(trim(r.land), '') as land
    from public.reizigers r
    where r.land is not null and trim(r.land) <> ''
    order by r.boeking_id, r.id
  ),
  per_booking_financien as (
    select
      ta.boeking_id,
      coalesce(sum(rf.totaal_te_betalen), 0)::numeric as totaal_te_betalen,
      coalesce(sum(rf.reeds_betaald), 0)::numeric as reeds_betaald,
      coalesce(sum(rf.nog_te_betalen), 0)::numeric as nog_te_betalen,
      coalesce(sum(rf.package_prijs), 0)::numeric as package_prijs,
      coalesce(sum(rf.transfer_prijs), 0)::numeric as transfer_prijs,
      coalesce(sum(rf.bagage_prijs), 0)::numeric as bagage_prijs,
      coalesce(sum(rf.vlucht_heen_prijs), 0)::numeric as vlucht_heen_prijs,
      coalesce(sum(rf.vlucht_terug_prijs), 0)::numeric as vlucht_terug_prijs,
      coalesce(sum(rf.toeristenbelasting_te_betalen), 0)::numeric as sum_toeristenbelasting_te_betalen,
      coalesce(sum(rf.discount_amount), 0)::numeric as sum_discount_amount,
      coalesce(sum(rf.kost_accommodatie), 0)::numeric as sum_kost_accommodatie,
      coalesce(sum(rf.kost_transport), 0)::numeric as sum_kost_transport_raw,
      coalesce(sum(rf.kost_transfer), 0)::numeric as sum_kost_transfer,
      coalesce(sum(rf.kost_extra_kosten), 0)::numeric as sum_kost_extra_kosten
    from traveller_active ta
    left join public.reiziger_financien rf on rf.reiziger_id = ta.reiziger_id
    group by ta.boeking_id
  ),
  per_booking_financien_winst as (
    select
      ta.boeking_id,
      coalesce(sum(rf.totaal_te_betalen), 0)::numeric as totaal_te_betalen,
      coalesce(sum(rf.package_prijs), 0)::numeric as package_prijs,
      coalesce(sum(rf.discount_amount), 0)::numeric as sum_discount_amount,
      coalesce(sum(rf.kost_accommodatie), 0)::numeric as sum_kost_accommodatie,
      coalesce(sum(rf.kost_transport), 0)::numeric as sum_kost_transport_raw,
      coalesce(sum(rf.kost_transfer), 0)::numeric as sum_kost_transfer
    from traveller_active_winst ta
    left join public.reiziger_financien rf on rf.reiziger_id = ta.reiziger_id
    group by ta.boeking_id
  )
  select jsonb_build_object(
    'rows',
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'booking_id', q.booking_id,
            'order_nummer', q.order_nummer,
            'brand', q.brand,
            'destination', q.destination,
            'country', q.country,
            'departure_date', q.departure_date,
            'pax', q.pax,
            'booking_status', q.booking_status,
            'betaling_status', q.betaling_status,
            'transport', q.transport,
            'totaal_te_betalen', q.totaal_te_betalen,
            'package_prijs', q.package_prijs,
            'transfer_prijs', q.transfer_prijs,
            'bagage_prijs', q.bagage_prijs,
            'vlucht_heen_prijs', q.vlucht_heen_prijs,
            'vlucht_terug_prijs', q.vlucht_terug_prijs,
            'toeristenbelasting_te_betalen', q.toeristenbelasting_te_betalen,
            'schoonmaakkosten_te_betalen', q.schoonmaakkosten_te_betalen,
            'kost_accomodatie', q.kost_accomodatie,
            'kost_transport', q.kost_transport,
            'kost_transfer', q.kost_transfer,
            'kost_extra_kosten', q.kost_extra_kosten,
            'prijs_annulatieverzekering', q.prijs_annulatieverzekering,
            'prijs_reisverzekering', q.prijs_reisverzekering,
            'prijs_annulatie_en_reisverzekering', q.prijs_annulatie_en_reisverzekering,
            'excursie_prijs', q.excursie_prijs,
            'excursions_totaal_excel', q.excursions_totaal_excel,
            'price_annulation_insurance', q.prijs_annulatieverzekering,
            'price_travel_insurance', q.prijs_reisverzekering,
            'price_travelandannulation_insurance', q.prijs_annulatie_en_reisverzekering,
            'excursions_to_pay', q.excursie_prijs,
            'discount_amount', q.discount_amount,
            'discountAmount', q.discount_amount,
            'winst', q.winst,
            'excluded_from_profit', q.excluded_from_profit,
            'paid_amount', q.paid_amount,
            'openstaand', q.openstaand,
            'payment_reminders', q.payment_reminders,
            'incasso_flag', q.incasso_flag,
            'pending_payments', q.pending_payments,
            'days_to_first_payment', q.days_to_first_payment,
            'insurance_type', q.insurance_type,
            'supplier_acco', q.supplier_acco,
            'supplier_flight', q.supplier_flight,
            'boekingsdatum', q.boekingsdatum,
            'accommodatie_id', q.accommodatie_id,
            'acco_leverancier', q.acco_leverancier,
            'accommodatie_naam', q.accommodatie_naam,
            'accommodatie_type', q.accommodatie_type,
            'is_jouw_verblijf_accommodatie', q.is_jouw_verblijf_accommodatie
          )
          order by q.sort_dep desc nulls last, q.booking_id
        )
        from (
    select
      b.id as booking_id,
      b.order_nummer as order_nummer,
      coalesce(nullif(trim(b.brand), ''), '(onbekend)') as brand,
      d.naam as destination,
      lf.land as country,
      b.vertrekdatum::text as departure_date,
      b.vertrekdatum as sort_dep,
      (select count(*)::int from traveller_active ta_pax where ta_pax.boeking_id = b.id) as pax,
      lower(trim(coalesce(st_book.naam, ''))) as booking_status,
      st_pay.naam as betaling_status,
      coalesce(t.naam, '') as transport,
      coalesce(pf.totaal_te_betalen, 0)::numeric as totaal_te_betalen,
      coalesce(pf.package_prijs, 0)::numeric as package_prijs,
      coalesce(pf.transfer_prijs, 0)::numeric as transfer_prijs,
      coalesce(pf.bagage_prijs, 0)::numeric as bagage_prijs,
      coalesce(pf.vlucht_heen_prijs, 0)::numeric as vlucht_heen_prijs,
      coalesce(pf.vlucht_terug_prijs, 0)::numeric as vlucht_terug_prijs,
      coalesce(pf.sum_toeristenbelasting_te_betalen, 0)::numeric as toeristenbelasting_te_betalen,
      coalesce(f.schoonmaakkosten_te_betalen, 0)::numeric as schoonmaakkosten_te_betalen,
      coalesce(pf.sum_kost_accommodatie, 0)::numeric as kost_accomodatie,
      coalesce(pf.sum_kost_transport_raw, 0)::numeric as kost_transport,
      coalesce(pf.sum_kost_transfer, 0)::numeric as kost_transfer,
      coalesce(pf.sum_kost_extra_kosten, 0)::numeric as kost_extra_kosten,
      f.excursions_totaal_excel::numeric as excursions_totaal_excel,
      coalesce(ins.prijs_annulatieverzekering, 0)::numeric as prijs_annulatieverzekering,
      coalesce(ins.prijs_reisverzekering, 0)::numeric as prijs_reisverzekering,
      coalesce(ins.prijs_annulatie_en_reisverzekering, 0)::numeric as prijs_annulatie_en_reisverzekering,
      coalesce(f.excursions_totaal_excel, exc.excursie_prijs, 0)::numeric as excursie_prijs,
      coalesce(pf.sum_discount_amount, f.discount_amount, 0)::numeric as discount_amount,
      (coalesce(pf.sum_kost_accommodatie, 0) = 0) as excluded_from_profit,
      (
        case
          when public.boeking_status_winst_resultaat_nul(b.id) then 0::numeric
          else public.standaard_dashboard_winst_formule(
            coalesce(pfw.totaal_te_betalen, 0),
            coalesce(f.excursions_totaal_excel, exc.excursie_prijs, 0),
            coalesce(insw.prijs_annulatieverzekering, 0),
            coalesce(insw.prijs_reisverzekering, 0),
            coalesce(insw.prijs_annulatie_en_reisverzekering, 0),
            coalesce(pfw.sum_discount_amount, f.discount_amount, 0),
            coalesce(pfw.sum_kost_accommodatie, 0),
            coalesce(pfw.sum_kost_transport_raw, 0),
            coalesce(pfw.sum_kost_transfer, 0),
            coalesce(pfw.package_prijs, 0)
          )
        end
      )::numeric as winst,
      coalesce(pf.reeds_betaald, 0)::numeric as paid_amount,
      coalesce(pf.nog_te_betalen, 0)::numeric as openstaand,
      -- Som voorschot + totaal herinneringen per reiziger; boeking-KPI = max() over reizigers
      -- (voorkomt dubbeltelling wanneer historisch dezelfde boekingswaarde op elke reiziger stond).
      (
        select coalesce(
          max(
            coalesce(rf_pr.aantal_totaalbetalingsherinneringen, 0)
            + coalesce(rf_pr.aantal_voorschotbetalingsherinneringen, 0)
          ),
          0
        )::int
        from public.reizigers r_pr
        left join public.reiziger_financien rf_pr on rf_pr.reiziger_id = r_pr.id
        where r_pr.boeking_id = b.id
      ) as payment_reminders,
      coalesce(
        (
          select bool_or(
            lower(trim(coalesce(r.incasso_status::text, ''))) in ('ja', 'yes', 'true', '1')
            or trim(coalesce(r.incasso_status::text, '')) in ('1')
          )
          from public.reizigers r
          where r.boeking_id = b.id
        ),
        false
      ) as incasso_flag,
      case
        when coalesce(pf.nog_te_betalen, 0) > 0.01 then 1
        else 0
      end as pending_payments,
      case
        when coalesce(pf.nog_te_betalen, 0) < 0.01 then 0
        when coalesce(pf.reeds_betaald, 0) > 0 then 14
        else 45
      end as days_to_first_payment,
      case
        when coalesce(ins.prijs_annulatie_en_reisverzekering, 0) > 0 then 'combi'
        when coalesce(ins.prijs_reisverzekering, 0) > 0 then 'travel'
        when coalesce(ins.prijs_annulatieverzekering, 0) > 0 then 'annul'
        else 'none'
      end as insurance_type,
      coalesce(nullif(trim(acc.leverancier), ''), acc.naam, '—') as supplier_acco,
      coalesce(t.naam, '—') as supplier_flight,
      b.boekingsdatum::text as boekingsdatum,
      b.accommodatie_id as accommodatie_id,
      coalesce(nullif(trim(acc.leverancier), ''), '(geen leverancier)') as acco_leverancier,
      acc.naam as accommodatie_naam,
      coalesce(nullif(trim(acc.type), ''), '—') as accommodatie_type,
      (lower(trim(coalesce(acc.naam, ''))) like 'jouw verblijf in%') as is_jouw_verblijf_accommodatie
    from public.boekingen b
    join public.bestemmingen d on d.id = b.bestemming_id
    join public.accommodaties acc on acc.id = b.accommodatie_id
    left join public.boeking_financien f on f.boeking_id = b.id
    left join per_booking_financien pf on pf.boeking_id = b.id
    left join public.statussen st_book on st_book.id = b.boeking_status_id
    left join public.statussen st_pay on st_pay.id = b.betaling_status_id
    left join public.transporten t on t.id = b.transport_id
    left join ins on ins.boeking_id = b.id
    left join ins_winst insw on insw.boeking_id = b.id
    left join per_booking_financien_winst pfw on pfw.boeking_id = b.id
    left join exc on exc.boeking_id = b.id
    left join land_first lf on lf.boeking_id = b.id
    where
      not public.boeking_id_excluded_from_standard_dashboards(b.id)
      and (p_brand is null or trim(p_brand) = '' or lower(trim(p_brand)) = '__all__'
        or lower(trim(coalesce(b.brand, ''))) = lower(trim(p_brand)))
      and (p_bestemming_naam is null or trim(p_bestemming_naam) = ''
        or d.naam = p_bestemming_naam)
      and (p_year is null or p_year <= 0 or extract(year from b.vertrekdatum)::int = p_year)
      and (
        p_land is null or trim(p_land) = '' or lower(trim(p_land)) in ('__all__', '')
        or upper(trim(lf.land)) = upper(trim(p_land))
      )
      and (
        p_period is null or trim(p_period) = '' or lower(trim(p_period)) = 'all'
        or (lower(trim(p_period)) = 'q1' and extract(month from b.vertrekdatum) between 1 and 3)
        or (lower(trim(p_period)) = 'q2' and extract(month from b.vertrekdatum) between 4 and 6)
        or (lower(trim(p_period)) = 'q3' and extract(month from b.vertrekdatum) between 7 and 9)
        or (lower(trim(p_period)) = 'q4' and extract(month from b.vertrekdatum) between 10 and 12)
        or (lower(trim(p_period)) = 'summer' and extract(month from b.vertrekdatum) between 6 and 8)
      )
    ) q
      ),
      '[]'::jsonb
    ),
    -- Per reiziger/dossier voor Betalingen-tab (KPI's, grafieken, uitzonderingstabel).
    'payment_travellers',
    coalesce(
      (
        select
          jsonb_agg(
            jsonb_build_object(
              'reiziger_id', r.id,
              'booking_id', b.id,
              'order_nummer', b.order_nummer,
              'brand', coalesce(nullif(trim(b.brand), ''), '(onbekend)'),
              'destination', d.naam,
              'departure_date', b.vertrekdatum::text,
              'invoice_date', f.factuur_verzonden_op,
              'booking_status', lower(trim(coalesce(st_book.naam, ''))),
              'voornaam', r.voornaam,
              'achternaam', r.achternaam,
              'aantal_voorschotbetalingsherinneringen', coalesce(rf.aantal_voorschotbetalingsherinneringen, 0),
              'aantal_totaalbetalingsherinneringen', coalesce(rf.aantal_totaalbetalingsherinneringen, 0),
              'totaal_te_betalen', rf.totaal_te_betalen,
              'nog_te_betalen', rf.nog_te_betalen,
              'toeristenbelasting_te_betalen', coalesce(rf.toeristenbelasting_te_betalen, 0)::numeric,
              'discount_amount', coalesce(rf.discount_amount, 0)::numeric,
              'discount_code_used', nullif(trim(coalesce(rf.discount_code_used, '')), ''),
              'betaling_status', st_pay.naam,
              'incasso_status', r.incasso_status,
              'collections', r.collections,
              'prijs_annulatieverzekering', coalesce(rf.prijs_annulatieverzekering, 0)::numeric,
              'prijs_reisverzekering', coalesce(rf.prijs_reisverzekering, 0)::numeric,
              'prijs_annulatie_en_reisverzekering', coalesce(rf.prijs_annulatie_en_reisverzekering, 0)::numeric,
              'insurance_type', (
                case
                  when coalesce(rf.prijs_annulatie_en_reisverzekering, 0) > 0 then 'combi'
                  when coalesce(rf.prijs_reisverzekering, 0) > 0 then 'travel'
                  when coalesce(rf.prijs_annulatieverzekering, 0) > 0 then 'annul'
                  else 'none'
                end
              )
            )
            order by b.vertrekdatum desc nulls last, r.id
          )
        from public.reizigers r
        join public.boekingen b on b.id = r.boeking_id
        join public.bestemmingen d on d.id = b.bestemming_id
        join public.accommodaties acc on acc.id = b.accommodatie_id
        left join public.reiziger_financien rf on rf.reiziger_id = r.id
        left join public.boeking_financien f on f.boeking_id = b.id
        left join land_first lf on lf.boeking_id = b.id
        left join public.statussen st_book on st_book.id = b.boeking_status_id
        left join public.statussen st_pay on st_pay.id = b.betaling_status_id
        left join public.statussen st_trav on st_trav.id = r.traveller_status_id
        where
          not public.boeking_id_excluded_from_standard_dashboards(b.id)
          and lower(trim(coalesce(st_trav.naam, ''))) !~ '^(cancelled|canceled|cancel|geannuleerd|gecanceld|annulatie|annulering|annule|annulé|dropped|drop)([^a-z0-9].*)?$'
          and (p_brand is null or trim(p_brand) = '' or lower(trim(p_brand)) = '__all__'
            or lower(trim(coalesce(b.brand, ''))) = lower(trim(p_brand)))
          and (p_bestemming_naam is null or trim(p_bestemming_naam) = ''
            or d.naam = p_bestemming_naam)
          and (p_year is null or p_year <= 0 or extract(year from b.vertrekdatum)::int = p_year)
          and (
            p_land is null or trim(p_land) = '' or lower(trim(p_land)) in ('__all__', '')
            or upper(trim(lf.land)) = upper(trim(p_land))
          )
          and (
            p_period is null or trim(p_period) = '' or lower(trim(p_period)) = 'all'
            or (lower(trim(p_period)) = 'q1' and extract(month from b.vertrekdatum) between 1 and 3)
            or (lower(trim(p_period)) = 'q2' and extract(month from b.vertrekdatum) between 4 and 6)
            or (lower(trim(p_period)) = 'q3' and extract(month from b.vertrekdatum) between 7 and 9)
            or (lower(trim(p_period)) = 'q4' and extract(month from b.vertrekdatum) between 10 and 12)
            or (lower(trim(p_period)) = 'summer' and extract(month from b.vertrekdatum) between 6 and 8)
          )
      ),
      '[]'::jsonb
    )
  );
$$;

comment on function public.financieel_bookings_rpc(text, text, text, int, text) is
  'Financiën: omzet/pax obv legacy-regex reizigers; winst obv reiziger_status_uitgesloten + standaard_dashboard_winst_formule; processing → winst 0.';
