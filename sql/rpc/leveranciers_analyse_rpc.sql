-- Leveranciers-tab Financiën (legacy RPC): aggregatie per bestemming + accommodatieleverancier.
-- De Financiën-UI aggregeert leveranciers nu client-side uit `financieel_bookings_rpc` (zelfde winst/omzet als de rest).
-- Deze functie kan nog bruikbaar zijn voor rapportage of API; houd filters gelijk aan financieel_bookings_rpc.
-- Voer uit in Supabase SQL Editor na deploy.

create or replace function public.leveranciers_analyse_rpc(
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
  with land_first as (
    select distinct on (r.boeking_id)
      r.boeking_id,
      nullif(trim(r.land), '') as land
    from public.reizigers r
    where r.land is not null and trim(r.land) <> ''
    order by r.boeking_id, r.id
  ),
  rez as (
    select r.boeking_id, count(*)::bigint as cnt
    from public.reizigers r
    group by r.boeking_id
  ),
  fb as (
    select b.id as boeking_id, b.bestemming_id, b.accommodatie_id
    from public.boekingen b
    join public.bestemmingen d on d.id = b.bestemming_id
    join public.accommodaties acc on acc.id = b.accommodatie_id
    left join land_first lf on lf.boeking_id = b.id
    where
      not public.boeking_id_excluded_from_standard_dashboards(b.id)
      and (p_brand is null or trim(p_brand) = '' or lower(trim(p_brand)) in ('__all__', '')
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
  )
  select jsonb_build_object(
    'summary',
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'bestemming_naam', s.bestemming_naam,
            'leverancier', s.leverancier,
            'aantal_boekingen', s.aantal_boekingen,
            'aantal_reizigers', s.aantal_reizigers
          ) order by s.bestemming_naam, s.leverancier
        )
        from (
          select
            d.naam as bestemming_naam,
            coalesce(nullif(trim(acc.leverancier), ''), '(geen leverancier)') as leverancier,
            count(distinct fb.boeking_id)::int as aantal_boekingen,
            coalesce(sum(rz.cnt), 0)::bigint as aantal_reizigers
          from fb
          join public.bestemmingen d on d.id = fb.bestemming_id
          join public.accommodaties acc on acc.id = fb.accommodatie_id
          left join rez rz on rz.boeking_id = fb.boeking_id
          group by d.naam, coalesce(nullif(trim(acc.leverancier), ''), '(geen leverancier)')
        ) s
      ),
      '[]'::jsonb
    ),
    'details',
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'bestemming_naam', s.bestemming_naam,
            'leverancier', s.leverancier,
            'accommodatie_naam', s.accommodatie_naam,
            'accommodatie_type', s.accommodatie_type,
            'aantal_boekingen', s.aantal_boekingen
          ) order by s.bestemming_naam, s.leverancier, s.accommodatie_naam
        )
        from (
          select
            d.naam as bestemming_naam,
            coalesce(nullif(trim(acc.leverancier), ''), '(geen leverancier)') as leverancier,
            acc.naam as accommodatie_naam,
            coalesce(nullif(trim(acc.type), ''), '—') as accommodatie_type,
            count(distinct fb.boeking_id)::int as aantal_boekingen
          from fb
          join public.bestemmingen d on d.id = fb.bestemming_id
          join public.accommodaties acc on acc.id = fb.accommodatie_id
          group by d.naam, coalesce(nullif(trim(acc.leverancier), ''), '(geen leverancier)'), acc.id, acc.naam, acc.type
        ) s
      ),
      '[]'::jsonb
    )
  );
$$;

comment on function public.leveranciers_analyse_rpc(text, text, text, int, text) is
  'Financiën Leveranciers: summary + detail per bestemming/leverancier/accommodatie; filters als financieel_bookings_rpc.';
