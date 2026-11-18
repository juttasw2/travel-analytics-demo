-- RPC functies voor "Vergelijkingen" pagina.

-- =========================================
-- Years (voor date_type + filters)
-- =========================================
create or replace function public.tijdsvergelijkingen_years(
  p_date_type text,
  p_brand text,
  p_bestemming_ids uuid[]
)
returns table(jaar int)
language plpgsql
stable
as $$
declare
  date_expr date;
begin
  return query
  select distinct extract(year from
    case
      when lower(trim(p_date_type)) = 'boekingsdatum' then b.boekingsdatum
      else b.vertrekdatum
    end
  )::int as jaar
  from boekingen b
  where
    (p_brand = '__all__' or lower(trim(b.brand)) = lower(trim(p_brand)))
    and (cardinality(p_bestemming_ids) = 0 or b.bestemming_id = any(p_bestemming_ids))
    and case
      when lower(trim(p_date_type)) = 'boekingsdatum' then b.boekingsdatum
      else b.vertrekdatum
    end is not null
  order by jaar;
end;
$$;


-- =========================================
-- Main payload (Vergelijkingen)
-- =========================================
drop function if exists public.tijdsvergelijkingen_data(
  text,
  text,
  int,
  int,
  uuid[],
  text,
  text,
  date,
  date
);

create or replace function public.tijdsvergelijkingen_data(
  p_date_type text,
  p_period text,
  p_current_year int,
  p_compare_year int,
  p_bestemming_ids uuid[],
  p_brand text,
  p_kpi text,
  p_date_from date,
  p_date_to date
)
returns table(payload jsonb)
language plpgsql
stable
as $$
declare
  v_current_year int;
  v_compare_year int;
begin
  v_current_year := p_current_year;
  v_compare_year := p_compare_year;

  return query
  with
  params as (
    select
      lower(trim(coalesce(p_date_type, 'boekingsdatum'))) as date_type_norm,
      coalesce(
        case lower(nullif(trim(coalesce(p_period, '')), ''))
          when 'day' then 'dag'
          when 'dag' then 'dag'
          when 'week' then 'week'
          when 'maand' then 'maand'
          when 'month' then 'maand'
          when 'kwartaal' then 'kwartaal'
          when 'quarter' then 'kwartaal'
          else null
        end,
        'maand'
      ) as period_norm,
      lower(trim(p_brand)) as brand_norm,
      coalesce(v_current_year, extract(year from current_date)::int) as current_year,
      coalesce(v_compare_year, coalesce(v_current_year, extract(year from current_date)::int) - 1) as compare_year
  ),
  range_bounds as (
    select
      p.*,
      coalesce(p_date_from, make_date(p.current_year, 1, 1)) as current_start,
      coalesce(p_date_to, make_date(p.current_year, 12, 31)) as current_end,
      case
        when p_date_from is null then make_date(p.compare_year, 1, 1)
        else (p_date_from + make_interval(years => (p.compare_year - p.current_year)))::date
      end as compare_start,
      case
        when p_date_to is null then make_date(p.compare_year, 12, 31)
        else (p_date_to + make_interval(years => (p.compare_year - p.current_year)))::date
      end as compare_end
    from params p
  ),
  /*
   * Boekingsdatum-modus: rijen opnemen op basis van boekingsdatum in het huidige of
   * vergelijkingsvenster (geen eis dat vertrek in hetzelfde kalenderblok valt — anders
   * verdwijnen bv. boekingen in okt 2025 met vertrek later uit de trend).
   * Vertrek-modus: vertrekdatum tussen compare_start en current_end in de pool.
   */
  filtered as (
    select
      b.id,
      b.bestemming_id,
      b.doelgroep_id,
      coalesce(v_pax.actieve_reizigers, 0)::int as actieve_reizigers,
      coalesce(pf.totaal_te_betalen, 0)::numeric as totaal_te_betalen,
      b.boekingsdatum,
      b.vertrekdatum,
      case
        when (p.date_type_norm = 'boekingsdatum') then b.boekingsdatum
        else b.vertrekdatum
      end as date_expr,
      rb.current_start,
      rb.current_end,
      rb.compare_start,
      rb.compare_end,
      p.period_norm
    from boekingen b
    left join public.vw_actieve_reizigers_per_boeking v_pax on v_pax.boeking_id = b.id
    left join (
      select
        r.boeking_id,
        coalesce(sum(rf.totaal_te_betalen), 0)::numeric as totaal_te_betalen
      from reizigers r
      left join public.statussen st_tr on st_tr.id = r.traveller_status_id
      left join reiziger_financien rf on rf.reiziger_id = r.id
      where not public.reiziger_status_uitgesloten_standaard_dashboards(st_tr.naam)
      group by r.boeking_id
    ) pf on pf.boeking_id = b.id
    cross join range_bounds rb
    cross join params p
    where
      (p_brand = '__all__' or lower(trim(b.brand)) = p.brand_norm)
      and (cardinality(p_bestemming_ids) = 0 or b.bestemming_id = any(p_bestemming_ids))
      and not public.boeking_id_excluded_from_standard_dashboards(b.id)
      and (
        case
          when p.date_type_norm = 'boekingsdatum' then
            b.boekingsdatum is not null
            and (
              b.boekingsdatum::date between rb.current_start and rb.current_end
              or b.boekingsdatum::date between rb.compare_start and rb.compare_end
            )
          else
            b.vertrekdatum is not null
            and b.vertrekdatum::date between rb.compare_start and rb.current_end
        end
      )
  ),
  current_set as (
    select f.*
    from filtered f
    cross join params p
    where
      case
        when p.date_type_norm = 'boekingsdatum' then
          f.boekingsdatum::date between f.current_start and f.current_end
        else
          f.date_expr between f.current_start and f.current_end
      end
  ),
  compare_set as (
    select f.*
    from filtered f
    cross join params p
    where
      case
        when p.date_type_norm = 'boekingsdatum' then
          f.boekingsdatum::date between f.compare_start and f.compare_end
        else
          f.date_expr between f.compare_start and f.compare_end
      end
  ),
  /*
   * Kalenderjaren 2023–huidig jaar (zelfde merk/bestemming/status als filtered),
   * zonder de range van range_bounds — voor jaaroverzicht-tabel.
   */
  filtered_years_scope as (
    select
      b.id,
      coalesce(v_pax.actieve_reizigers, 0)::int as actieve_reizigers,
      coalesce(pf.totaal_te_betalen, 0)::numeric as totaal_te_betalen,
      b.boekingsdatum,
      b.vertrekdatum,
      case
        when (p.date_type_norm = 'boekingsdatum') then b.boekingsdatum
        else b.vertrekdatum
      end as date_expr
    from boekingen b
    left join public.vw_actieve_reizigers_per_boeking v_pax on v_pax.boeking_id = b.id
    left join (
      select
        r.boeking_id,
        coalesce(sum(rf.totaal_te_betalen), 0)::numeric as totaal_te_betalen
      from reizigers r
      left join public.statussen st_tr on st_tr.id = r.traveller_status_id
      left join reiziger_financien rf on rf.reiziger_id = r.id
      where not public.reiziger_status_uitgesloten_standaard_dashboards(st_tr.naam)
      group by r.boeking_id
    ) pf on pf.boeking_id = b.id
    cross join params p
    where
      (p_brand = '__all__' or lower(trim(b.brand)) = p.brand_norm)
      and (cardinality(p_bestemming_ids) = 0 or b.bestemming_id = any(p_bestemming_ids))
      and not public.boeking_id_excluded_from_standard_dashboards(b.id)
      and (
        case
          when p.date_type_norm = 'boekingsdatum' then b.boekingsdatum
          else b.vertrekdatum
        end
      ) is not null
      and extract(year from (
        case
          when p.date_type_norm = 'boekingsdatum' then b.boekingsdatum::date
          else b.vertrekdatum::date
        end
      )) between 2023 and extract(year from current_date)::int
  ),
  all_bookings_for_winst as (
    select id from filtered
    union
    select id from filtered_years_scope
  ),
  traveller_active_scope as (
    select
      r.id as reiziger_id,
      r.boeking_id
    from reizigers r
    left join statussen st_trav on st_trav.id = r.traveller_status_id
    where r.boeking_id in (select id from all_bookings_for_winst)
      and not public.reiziger_status_uitgesloten_standaard_dashboards(st_trav.naam)
  ),
  ins_scope as (
    select
      ta.boeking_id,
      coalesce(sum(rf.prijs_annulatieverzekering), 0)::numeric as prijs_annulatieverzekering,
      coalesce(sum(rf.prijs_reisverzekering), 0)::numeric as prijs_reisverzekering,
      coalesce(sum(rf.prijs_annulatie_en_reisverzekering), 0)::numeric as prijs_annulatie_en_reisverzekering
    from traveller_active_scope ta
    left join reiziger_financien rf on rf.reiziger_id = ta.reiziger_id
    group by ta.boeking_id
  ),
  exc_scope as (
    select
      bex.boeking_id,
      coalesce(sum(coalesce(bex.verkoopprijs, ex.prijs, 0)), 0)::numeric as excursie_prijs
    from boeking_excursies bex
    left join excursies ex on ex.id = bex.excursie_id
    where bex.boeking_id in (select id from all_bookings_for_winst)
    group by bex.boeking_id
  ),
  per_booking_financien_scope as (
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
    from traveller_active_scope ta
    left join reiziger_financien rf on rf.reiziger_id = ta.reiziger_id
    group by ta.boeking_id
  ),
  /*
   * Winst per boeking: public.standaard_dashboard_winst_formule (zelfde als financieel_bookings_rpc).
   * Omzet/pax in filtered_* blijven zonder processing-exclude; processing → winst 0.
   */
  financieel_winst_joined as (
    select
      b.id as booking_id,
      (
        case
          when public.boeking_status_winst_resultaat_nul(b.id) then 0::numeric
          else public.standaard_dashboard_winst_formule(
            coalesce(pf.totaal_te_betalen, 0),
            coalesce(f.excursions_totaal_excel, exc.excursie_prijs, 0),
            coalesce(ins.prijs_annulatieverzekering, 0),
            coalesce(ins.prijs_reisverzekering, 0),
            coalesce(ins.prijs_annulatie_en_reisverzekering, 0),
            coalesce(pf.sum_discount_amount, f.discount_amount, 0),
            coalesce(pf.sum_kost_accommodatie, 0),
            coalesce(pf.sum_kost_transport_raw, 0),
            coalesce(pf.sum_kost_transfer, 0),
            coalesce(pf.package_prijs, 0)
          )
        end
      )::numeric as winst
    from public.boekingen b
    join public.bestemmingen d on d.id = b.bestemming_id
    join public.accommodaties acc on acc.id = b.accommodatie_id
    left join public.boeking_financien f on f.boeking_id = b.id
    left join per_booking_financien_scope pf on pf.boeking_id = b.id
    left join public.transporten t on t.id = b.transport_id
    left join ins_scope ins on ins.boeking_id = b.id
    left join exc_scope exc on exc.boeking_id = b.id
    where b.id in (select id from all_bookings_for_winst)
  ),
  year_metrics as (
    select
      extract(year from f.date_expr::date)::int as yr,
      coalesce(sum(f.actieve_reizigers), 0)::numeric as pax,
      coalesce(sum(f.totaal_te_betalen), 0)::numeric as omzet,
      coalesce(sum(fw.winst), 0)::numeric as winst,
      count(distinct f.id)::int as boekingen
    from filtered_years_scope f
    left join financieel_winst_joined fw on fw.booking_id = f.id
    group by 1
  ),
  year_summary as (
    select
      y.yr::int as yr,
      coalesce(ym.pax, 0)::numeric as pax,
      coalesce(ym.omzet, 0)::numeric as omzet,
      coalesce(ym.winst, 0)::numeric as winst,
      coalesce(ym.boekingen, 0)::int as boekingen,
      case
        when row_number() over (order by y.yr) = 1 then null
        else (coalesce(ym.pax, 0) - coalesce(lag(coalesce(ym.pax, 0)) over (order by y.yr), 0))::numeric
      end as delta_pax_yoy,
      case
        when row_number() over (order by y.yr) = 1 then null
        else (coalesce(ym.omzet, 0) - coalesce(lag(coalesce(ym.omzet, 0)) over (order by y.yr), 0))::numeric
      end as delta_omzet_yoy,
      case
        when row_number() over (order by y.yr) = 1 then null
        else (coalesce(ym.winst, 0) - coalesce(lag(coalesce(ym.winst, 0)) over (order by y.yr), 0))::numeric
      end as delta_winst_yoy
    from generate_series(2023, extract(year from current_date)::int) as y(yr)
    left join year_metrics ym on ym.yr = y.yr
  ),
  kpi_current as (
    select
      count(distinct id)::int as boekingen,
      coalesce(sum(actieve_reizigers), 0)::numeric as pax,
      coalesce(sum(totaal_te_betalen), 0)::numeric as omzet
    from current_set
  ),
  kpi_compare as (
    select
      count(distinct id)::int as boekingen,
      coalesce(sum(actieve_reizigers), 0)::numeric as pax,
      coalesce(sum(totaal_te_betalen), 0)::numeric as omzet
    from compare_set
  ),
  trend_current_raw as (
    select
      bucket_num,
      max(bucket_label) as bucket_label,
      coalesce(sum(actieve_reizigers), 0)::numeric as pax,
      coalesce(sum(totaal_te_betalen), 0)::numeric as omzet,
      count(distinct id)::numeric as boekingen
    from (
      select
        c.*,
        p.period_norm,
        case
          when p.period_norm = 'dag' then
            extract(month from ta.trend_anchor)::int * 100
            + extract(day from ta.trend_anchor)::int
          when p.period_norm = 'week' then
            extract(isoyear from c.date_expr)::int * 100
            + extract(week from c.date_expr)::int
          when p.period_norm = 'kwartaal' then
            extract(year from c.date_expr)::int * 10
            + extract(quarter from c.date_expr)::int
          else
            extract(year from c.date_expr)::int * 100
            + extract(month from c.date_expr)::int
        end as bucket_num,
        case
          when p.period_norm = 'dag' then
            lpad(extract(month from ta.trend_anchor)::text, 2, '0')
            || '-'
            || lpad(extract(day from ta.trend_anchor)::text, 2, '0')
          when p.period_norm = 'week' then
            concat('W', lpad(extract(week from c.date_expr)::text, 2, '0'), ' ', extract(isoyear from c.date_expr)::text)
          when p.period_norm = 'kwartaal' then
            concat('Q', extract(quarter from c.date_expr)::text, ' ', extract(year from c.date_expr)::text)
          else to_char(c.date_expr, 'Mon YYYY')
        end as bucket_label
      from current_set c
      cross join params p
      cross join lateral (
        select case
          when p.period_norm = 'dag' then coalesce(c.boekingsdatum::date, c.date_expr::date)
          else c.date_expr::date
        end as trend_anchor
      ) ta
      where (p.period_norm <> 'dag' or ta.trend_anchor is not null)
    ) s
    group by bucket_num
  ),
  trend_compare_raw as (
    select
      bucket_num,
      max(bucket_label) as bucket_label,
      coalesce(sum(actieve_reizigers), 0)::numeric as pax,
      coalesce(sum(totaal_te_betalen), 0)::numeric as omzet,
      count(distinct id)::numeric as boekingen
    from (
      select
        c.*,
        p.period_norm,
        case
          when p.period_norm = 'dag' then
            extract(month from ta.trend_anchor)::int * 100
            + extract(day from ta.trend_anchor)::int
          when p.period_norm = 'week' then
            extract(isoyear from c.date_expr)::int * 100
            + extract(week from c.date_expr)::int
          when p.period_norm = 'kwartaal' then
            extract(year from c.date_expr)::int * 10
            + extract(quarter from c.date_expr)::int
          else
            extract(year from c.date_expr)::int * 100
            + extract(month from c.date_expr)::int
        end as bucket_num,
        case
          when p.period_norm = 'dag' then
            lpad(extract(month from ta.trend_anchor)::text, 2, '0')
            || '-'
            || lpad(extract(day from ta.trend_anchor)::text, 2, '0')
          when p.period_norm = 'week' then
            concat('W', lpad(extract(week from c.date_expr)::text, 2, '0'), ' ', extract(isoyear from c.date_expr)::text)
          when p.period_norm = 'kwartaal' then
            concat('Q', extract(quarter from c.date_expr)::text, ' ', extract(year from c.date_expr)::text)
          else to_char(c.date_expr, 'Mon YYYY')
        end as bucket_label
      from compare_set c
      cross join params p
      cross join lateral (
        select case
          when p.period_norm = 'dag' then coalesce(c.boekingsdatum::date, c.date_expr::date)
          else c.date_expr::date
        end as trend_anchor
      ) ta
      where (p.period_norm <> 'dag' or ta.trend_anchor is not null)
    ) s
    group by bucket_num
  ),
  /*
   * Maand-trend: één rij per kalendermaand in current_start..current_end (ook zonder boekingen),
   * uitgelijnd met compare_year × maand zodat beide lijnen op dezelfde x-as staan.
   */
  trend_month_template as (
    select
      (extract(year from mo.m)::int * 100 + extract(month from mo.m)::int) as bucket_num,
      trim(to_char(mo.m, 'Mon YYYY')) as bucket_label,
      extract(month from mo.m)::int as m
    from range_bounds rb
    cross join params p
    cross join lateral generate_series(
      date_trunc('month', rb.current_start::timestamp)::date,
      date_trunc('month', rb.current_end::timestamp)::date,
      interval '1 month'
    ) as mo(m)
    where p.period_norm = 'maand'
  ),
  trend_buckets as (
    select bucket_num from trend_current_raw
    union
    select bucket_num from trend_compare_raw
  ),
  trend_default as (
    select
      tb.bucket_num,
      coalesce(tc.bucket_label, tp.bucket_label) as bucket_label,
      coalesce(tc.pax, 0)::numeric as current_pax,
      coalesce(tp.pax, 0)::numeric as compare_pax,
      coalesce(tc.omzet, 0)::numeric as current_omzet,
      coalesce(tp.omzet, 0)::numeric as compare_omzet,
      (coalesce(tc.omzet, 0) / nullif(coalesce(tc.pax, 0), 0))::numeric as current_gem_prijs,
      (coalesce(tp.omzet, 0) / nullif(coalesce(tp.pax, 0), 0))::numeric as compare_gem_prijs,
      coalesce(tc.boekingen, 0)::numeric as current_boekingen,
      coalesce(tp.boekingen, 0)::numeric as compare_boekingen,
      coalesce(tc.pax, 0)::numeric as current_value,
      coalesce(tp.pax, 0)::numeric as compare_value
    from trend_buckets tb
    left join trend_current_raw tc on tc.bucket_num = tb.bucket_num
    left join trend_compare_raw tp on tp.bucket_num = tb.bucket_num
  ),
  trend_maand as (
    select
      tmt.bucket_num,
      tmt.bucket_label,
      coalesce(tc.pax, 0)::numeric as current_pax,
      coalesce(tp.pax, 0)::numeric as compare_pax,
      coalesce(tc.omzet, 0)::numeric as current_omzet,
      coalesce(tp.omzet, 0)::numeric as compare_omzet,
      (coalesce(tc.omzet, 0) / nullif(coalesce(tc.pax, 0), 0))::numeric as current_gem_prijs,
      (coalesce(tp.omzet, 0) / nullif(coalesce(tp.pax, 0), 0))::numeric as compare_gem_prijs,
      coalesce(tc.boekingen, 0)::numeric as current_boekingen,
      coalesce(tp.boekingen, 0)::numeric as compare_boekingen,
      coalesce(tc.pax, 0)::numeric as current_value,
      coalesce(tp.pax, 0)::numeric as compare_value
    from trend_month_template tmt
    cross join range_bounds rb
    left join trend_current_raw tc on tc.bucket_num = tmt.bucket_num
    left join trend_compare_raw tp on tp.bucket_num = rb.compare_year * 100 + tmt.m
  ),
  trend as (
    select tm.*
    from trend_maand tm
    where exists (select 1 from params p where p.period_norm = 'maand')
    union all
    select td.*
    from trend_default td
    where exists (select 1 from params p where p.period_norm <> 'maand')
  ),
  dest_current as (
    select bestemming_id, coalesce(sum(actieve_reizigers), 0)::numeric as pax
    from current_set
    group by bestemming_id
  ),
  dest_compare as (
    select bestemming_id, coalesce(sum(actieve_reizigers), 0)::numeric as pax
    from compare_set
    group by bestemming_id
  ),
  destination_delta as (
    select
      d.naam as bestemming,
      coalesce(dc.pax, 0)::numeric as current_pax,
      coalesce(dp.pax, 0)::numeric as previous_pax,
      (coalesce(dc.pax, 0) - coalesce(dp.pax, 0))::numeric as delta,
      case when coalesce(dp.pax, 0) = 0 then null
        else ((coalesce(dc.pax, 0) - coalesce(dp.pax, 0)) / dp.pax) * 100
      end as delta_pct
    from bestemmingen d
    left join dest_current dc on dc.bestemming_id = d.id
    left join dest_compare dp on dp.bestemming_id = d.id
    where coalesce(dc.pax, 0) > 0 or coalesce(dp.pax, 0) > 0
  ),
  land_current as (
    select
      case
        when lower(trim(r.land)) in ('be', 'belgie', 'belgië', 'belgium') then 'BE'
        when lower(trim(r.land)) in ('nl', 'nederland', 'netherlands') then 'NL'
        else 'Overig'
      end as land_groep,
      count(*)::int as reizigers
    from reizigers r
    join current_set c on c.id = r.boeking_id
    left join public.statussen st_tr on st_tr.id = r.traveller_status_id
    where not public.reiziger_status_uitgesloten_standaard_dashboards(st_tr.naam)
    group by land_groep
  ),
  land_compare as (
    select
      case
        when lower(trim(r.land)) in ('be', 'belgie', 'belgië', 'belgium') then 'BE'
        when lower(trim(r.land)) in ('nl', 'nederland', 'netherlands') then 'NL'
        else 'Overig'
      end as land_groep,
      count(*)::int as reizigers
    from reizigers r
    join compare_set c on c.id = r.boeking_id
    left join public.statussen st_tr on st_tr.id = r.traveller_status_id
    where not public.reiziger_status_uitgesloten_standaard_dashboards(st_tr.naam)
    group by land_groep
  ),
  country_mix as (
    select
      g.land_groep,
      coalesce(lc.reizigers, 0)::int as current_reizigers,
      coalesce(lp.reizigers, 0)::int as previous_reizigers
    from (select unnest(array['BE','NL','Overig']) as land_groep) g
    left join land_current lc on lc.land_groep = g.land_groep
    left join land_compare lp on lp.land_groep = g.land_groep
  ),
  land_other_detail_current as (
    select
      case
        when coalesce(nullif(trim(r.land), ''), '') = '' then '(leeg)'
        else trim(r.land)
      end as land_label,
      count(*)::int as reizigers
    from reizigers r
    join current_set c on c.id = r.boeking_id
    left join public.statussen st_tr on st_tr.id = r.traveller_status_id
    where not public.reiziger_status_uitgesloten_standaard_dashboards(st_tr.naam)
      and not (
      lower(trim(coalesce(r.land, ''))) in ('be', 'belgie', 'belgië', 'belgium', 'nl', 'nederland', 'netherlands')
    )
    group by 1
  ),
  land_other_detail_compare as (
    select
      case
        when coalesce(nullif(trim(r.land), ''), '') = '' then '(leeg)'
        else trim(r.land)
      end as land_label,
      count(*)::int as reizigers
    from reizigers r
    join compare_set c on c.id = r.boeking_id
    left join public.statussen st_tr on st_tr.id = r.traveller_status_id
    where not public.reiziger_status_uitgesloten_standaard_dashboards(st_tr.naam)
      and not (
      lower(trim(coalesce(r.land, ''))) in ('be', 'belgie', 'belgië', 'belgium', 'nl', 'nederland', 'netherlands')
    )
    group by 1
  ),
  period_current as (
    select
      (extract(year from c.boekingsdatum)::int * 100 + extract(month from c.boekingsdatum)::int) as period_key,
      coalesce(sum(c.actieve_reizigers), 0)::numeric as pax_current,
      coalesce(sum(c.totaal_te_betalen), 0)::numeric as omzet_current,
      coalesce(sum(fw.winst), 0)::numeric as winst_current,
      count(distinct c.id)::int as boekingen_current
    from current_set c
    left join financieel_winst_joined fw on fw.booking_id = c.id
    where c.boekingsdatum is not null
    group by 1
  ),
  period_previous as (
    select
      (extract(year from c.boekingsdatum)::int * 100 + extract(month from c.boekingsdatum)::int) as period_key,
      coalesce(sum(c.actieve_reizigers), 0)::numeric as pax_previous,
      coalesce(sum(c.totaal_te_betalen), 0)::numeric as omzet_previous,
      coalesce(sum(fw.winst), 0)::numeric as winst_previous,
      count(distinct c.id)::int as boekingen_previous
    from compare_set c
    left join financieel_winst_joined fw on fw.booking_id = c.id
    where c.boekingsdatum is not null
    group by 1
  ),
  period_months as (
    select distinct
      (extract(year from m)::int * 100 + extract(month from m)::int) as period_key
    from range_bounds rb
    cross join lateral generate_series(
      date_trunc('month', rb.current_start::timestamp)::date,
      date_trunc('month', rb.current_end::timestamp)::date,
      interval '1 month'
    ) as g(m)
  ),
  period_compare as (
    select
      pm.period_key,
      to_char(
        make_date((pm.period_key / 100)::int, (pm.period_key % 100)::int, 1),
        'Mon YYYY'
      ) as period_label,
      (pm.period_key % 100)::int as maand,
      coalesce(pc.pax_current, 0)::numeric as pax_current,
      coalesce(pp.pax_previous, 0)::numeric as pax_previous,
      coalesce(pc.omzet_current, 0)::numeric as omzet_current,
      coalesce(pp.omzet_previous, 0)::numeric as omzet_previous,
      coalesce(pc.winst_current, 0)::numeric as winst_current,
      coalesce(pp.winst_previous, 0)::numeric as winst_previous,
      (coalesce(pc.omzet_current, 0) - coalesce(pp.omzet_previous, 0))::numeric as delta_omzet,
      (coalesce(pc.winst_current, 0) - coalesce(pp.winst_previous, 0))::numeric as delta_winst,
      coalesce(pc.boekingen_current, 0)::int as boekingen_current,
      coalesce(pp.boekingen_previous, 0)::int as boekingen_previous
    from period_months pm
    cross join range_bounds rb
    left join period_current pc on pc.period_key = pm.period_key
    left join period_previous pp on pp.period_key = (
      ((pm.period_key / 100) - (rb.current_year - rb.compare_year))::int * 100
      + (pm.period_key % 100)
    )
  ),
  period_year_agg as (
    select
      extract(year from f.boekingsdatum)::int as yr,
      coalesce(sum(f.actieve_reizigers), 0)::numeric as pax,
      coalesce(sum(f.totaal_te_betalen), 0)::numeric as omzet,
      count(distinct f.id)::int as boekingen
    from filtered f
    where f.boekingsdatum is not null
    group by 1
  ),
  period_year_span as (
    select distinct u.yr
    from (
      select gs.yr::int as yr
      from range_bounds rb
      cross join lateral generate_series(
        least(
          extract(year from rb.compare_start)::int,
          extract(year from rb.current_start)::int,
          extract(year from rb.compare_end)::int,
          extract(year from rb.current_end)::int
        ),
        greatest(
          extract(year from rb.compare_start)::int,
          extract(year from rb.current_start)::int,
          extract(year from rb.compare_end)::int,
          extract(year from rb.current_end)::int
        ),
        1
      ) as gs(yr)
      union
      select a.yr from period_year_agg a
    ) u
    where u.yr is not null
  ),
  period_year_compare as (
    select
      ps.yr as period_key,
      ps.yr::text as period_label,
      coalesce(cy.pax, 0)::numeric as pax_current,
      coalesce(pp.pax, 0)::numeric as pax_previous,
      coalesce(cy.omzet, 0)::numeric as omzet_current,
      coalesce(pp.omzet, 0)::numeric as omzet_previous,
      (coalesce(cy.omzet, 0) - coalesce(pp.omzet, 0))::numeric as delta_omzet,
      (
        coalesce(cy.omzet, 0) / nullif(coalesce(cy.pax, 0), 0)
        - coalesce(pp.omzet, 0) / nullif(coalesce(pp.pax, 0), 0)
      )::numeric as delta_gem_prijs,
      coalesce(cy.boekingen, 0)::int as boekingen_current,
      coalesce(pp.boekingen, 0)::int as boekingen_previous
    from period_year_span ps
    cross join range_bounds rb
    left join period_year_agg cy on cy.yr = ps.yr
    left join period_year_agg pp on pp.yr = ps.yr - (rb.current_year - rb.compare_year)
  ),
  tempo_current as (
    select
      extract(week from date_expr)::int as iso_week,
      coalesce(sum(actieve_reizigers), 0)::numeric as pax,
      count(distinct id)::int as boekingen
    from current_set
    group by iso_week
  ),
  tempo_compare as (
    select
      extract(week from date_expr)::int as iso_week,
      coalesce(sum(actieve_reizigers), 0)::numeric as pax,
      count(distinct id)::int as boekingen
    from compare_set
    group by iso_week
  ),
  tempo_weeks as (
    select iso_week from tempo_current
    union
    select iso_week from tempo_compare
  ),
  tempo as (
    select
      tw.iso_week,
      sum(coalesce(tc.pax, 0)) over(order by tw.iso_week)::numeric as current_cum_pax,
      sum(coalesce(tp.pax, 0)) over(order by tw.iso_week)::numeric as previous_cum_pax,
      sum(coalesce(tc.boekingen, 0)) over(order by tw.iso_week)::numeric as current_cum_boekingen,
      sum(coalesce(tp.boekingen, 0)) over(order by tw.iso_week)::numeric as previous_cum_boekingen
    from tempo_weeks tw
    left join tempo_current tc on tc.iso_week = tw.iso_week
    left join tempo_compare tp on tp.iso_week = tw.iso_week
  ),
  leadtime_summary as (
    select
      (
        select avg((vertrekdatum::date - boekingsdatum::date)::numeric)
        from current_set
        where vertrekdatum is not null and boekingsdatum is not null
      ) as current_avg_days,
      (
        select avg((vertrekdatum::date - boekingsdatum::date)::numeric)
        from compare_set
        where vertrekdatum is not null and boekingsdatum is not null
      ) as previous_avg_days
  ),
  doelgroep_current as (
    select coalesce(dg.naam, 'Onbekend') as doelgroep, coalesce(sum(c.actieve_reizigers), 0)::numeric as pax
    from current_set c
    left join doelgroepen dg on dg.id = c.doelgroep_id
    group by coalesce(dg.naam, 'Onbekend')
  ),
  doelgroep_compare as (
    select coalesce(dg.naam, 'Onbekend') as doelgroep, coalesce(sum(c.actieve_reizigers), 0)::numeric as pax
    from compare_set c
    left join doelgroepen dg on dg.id = c.doelgroep_id
    group by coalesce(dg.naam, 'Onbekend')
  ),
  doelgroep_delta as (
    select
      coalesce(c.doelgroep, p.doelgroep) as doelgroep,
      coalesce(c.pax, 0)::numeric as current_pax,
      coalesce(p.pax, 0)::numeric as previous_pax,
      (coalesce(c.pax, 0) - coalesce(p.pax, 0))::numeric as delta,
      case when coalesce(p.pax, 0) = 0 then null
        else ((coalesce(c.pax, 0) - coalesce(p.pax, 0)) / p.pax) * 100
      end as delta_pct
    from doelgroep_current c
    full join doelgroep_compare p on p.doelgroep = c.doelgroep
  ),
  dim_meta as (
    select
      rb.current_year,
      rb.compare_year,
      rb.current_start,
      rb.current_end,
      rb.compare_start,
      rb.compare_end,
      p.date_type_norm,
      p.period_norm
    from range_bounds rb
    cross join params p
  )
  select jsonb_build_object(
    'meta', jsonb_build_object(
      'current_year', (select current_year from dim_meta),
      'compare_year', (select compare_year from dim_meta),
      'current_start', (select current_start from dim_meta),
      'current_end', (select current_end from dim_meta),
      'compare_start', (select compare_start from dim_meta),
      'compare_end', (select compare_end from dim_meta),
      'date_type', (select date_type_norm from dim_meta),
      'period', (select period_norm from dim_meta)
    ),
    'kpis', jsonb_build_object(
      'pax', jsonb_build_object(
        'current', (select pax from kpi_current),
        'compare', (select pax from kpi_compare)
      ),
      'omzet', jsonb_build_object(
        'current', (select omzet from kpi_current),
        'compare', (select omzet from kpi_compare)
      ),
      'gem_prijs', jsonb_build_object(
        'current', (select omzet / nullif(pax, 0) from kpi_current),
        'compare', (select omzet / nullif(pax, 0) from kpi_compare)
      ),
      'boekingen', jsonb_build_object(
        'current', (select boekingen from kpi_current),
        'compare', (select boekingen from kpi_compare)
      )
    ),
    'trend', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'bucket_num', bucket_num,
          'bucket_label', bucket_label,
          'current_value', current_value,
          'compare_value', compare_value,
          'current_pax', current_pax,
          'compare_pax', compare_pax,
          'current_omzet', current_omzet,
          'compare_omzet', compare_omzet,
          'current_gem_prijs', current_gem_prijs,
          'compare_gem_prijs', compare_gem_prijs,
          'current_boekingen', current_boekingen,
          'compare_boekingen', compare_boekingen
        )
        order by bucket_num
      ) from trend
    ), '[]'::jsonb),
    'destination_delta', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'bestemming', bestemming,
          'current_pax', current_pax,
          'previous_pax', previous_pax,
          'delta', delta,
          'delta_pct', delta_pct
        )
        order by delta desc, current_pax desc
      ) from destination_delta
    ), '[]'::jsonb),
    'country_mix', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'land', land_groep,
          'current_reizigers', current_reizigers,
          'previous_reizigers', previous_reizigers
        )
        order by case land_groep when 'BE' then 1 when 'NL' then 2 else 3 end
      ) from country_mix
    ), '[]'::jsonb),
    'land_other_breakdown', jsonb_build_object(
      'current', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'land', land_label,
            'reizigers', reizigers
          )
          order by reizigers desc
        ) from land_other_detail_current
      ), '[]'::jsonb),
      'compare', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'land', land_label,
            'reizigers', reizigers
          )
          order by reizigers desc
        ) from land_other_detail_compare
      ), '[]'::jsonb)
    ),
    'period_compare', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'period_key', period_key,
          'period_label', period_label,
          'maand', maand,
          'pax_current', pax_current,
          'pax_previous', pax_previous,
          'omzet_current', omzet_current,
          'omzet_previous', omzet_previous,
          'winst_current', winst_current,
          'winst_previous', winst_previous,
          'delta_omzet', delta_omzet,
          'delta_winst', delta_winst,
          'boekingen_current', boekingen_current,
          'boekingen_previous', boekingen_previous
        )
        order by period_key
      ) from period_compare
    ), '[]'::jsonb),
    'period_year_compare', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'period_key', period_key,
          'period_label', period_label,
          'pax_current', pax_current,
          'pax_previous', pax_previous,
          'omzet_current', omzet_current,
          'omzet_previous', omzet_previous,
          'gem_prijs_current', omzet_current / nullif(pax_current, 0),
          'gem_prijs_previous', omzet_previous / nullif(pax_previous, 0),
          'delta_omzet', delta_omzet,
          'delta_gem_prijs', delta_gem_prijs,
          'boekingen_current', boekingen_current,
          'boekingen_previous', boekingen_previous
        )
        order by period_key
      ) from period_year_compare
    ), '[]'::jsonb),
    'year_summary', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'yr', yr,
          'pax', pax,
          'omzet', omzet,
          'winst', winst,
          'boekingen', boekingen,
          'delta_pax_yoy', delta_pax_yoy,
          'delta_omzet_yoy', delta_omzet_yoy,
          'delta_winst_yoy', delta_winst_yoy
        )
        order by yr
      ) from (
        select *
        from year_summary
        where (
          coalesce(pax, 0) <> 0
          or coalesce(omzet, 0) <> 0
          or coalesce(boekingen, 0) <> 0
          or coalesce(winst, 0) <> 0
        )
      ) ys
    ), '[]'::jsonb),
    'booking_tempo', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'iso_week', iso_week,
          'current_cum_pax', current_cum_pax,
          'previous_cum_pax', previous_cum_pax,
          'current_cum_boekingen', current_cum_boekingen,
          'previous_cum_boekingen', previous_cum_boekingen
        )
        order by iso_week
      ) from tempo
    ), '[]'::jsonb),
    'leadtime_summary', jsonb_build_object(
      'current_avg_days', (select current_avg_days from leadtime_summary),
      'previous_avg_days', (select previous_avg_days from leadtime_summary)
    ),
    'doelgroep_delta', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'doelgroep', doelgroep,
          'current_pax', current_pax,
          'previous_pax', previous_pax,
          'delta', delta,
          'delta_pct', delta_pct
        )
        order by delta desc, current_pax desc
      ) from doelgroep_delta
    ), '[]'::jsonb)
  ) as payload;
end;
$$;

