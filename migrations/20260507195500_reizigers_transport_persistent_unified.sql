-- Unified transport persistence migration (reizigersniveau).
-- Business rules:
--   1) kost_transport = 1 -> self
--   2) kost_transport = 130 AND coalesce(kost_transfer,0)=0 -> bus
--   3) else -> plane

alter table public.reizigers
  add column if not exists transport text;

update public.reizigers r
set transport = case
  when rf.kost_transport = 1 then 'self'
  when rf.kost_transport = 130 and coalesce(rf.kost_transfer, 0) = 0 then 'bus'
  else 'plane'
end
from public.reiziger_financien rf
where rf.reiziger_id = r.id;

-- Reizigers zonder finance row krijgen altijd een deterministische waarde.
update public.reizigers
set transport = 'plane'
where transport is null;

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'reizigers_transport_check'
      and conrelid = 'public.reizigers'::regclass
  ) then
    alter table public.reizigers drop constraint reizigers_transport_check;
  end if;
end $$;

alter table public.reizigers
  add constraint reizigers_transport_check
  check (transport in ('self', 'bus', 'plane'));

alter table public.reizigers
  alter column transport set not null;

create index if not exists idx_reizigers_transport
  on public.reizigers (transport);

create or replace function public._bp_traveler_country_bucket(p_land text)
returns text
language sql
immutable
as $$
  select case
    when p_land is null or trim(p_land) = '' then 'OTHER'
    when upper(trim(p_land)) in ('BE', 'BELGIUM', 'BELGIE', 'BELGIË') then 'BE'
    when upper(trim(p_land)) in ('NL', 'NEDERLAND', 'NETHERLANDS') then 'NL'
    when upper(trim(p_land)) in ('IT', 'ITALY', 'ITALIA') then 'IT'
    when lower(trim(p_land)) in ('be', 'belgium', 'belgie', 'belgië', 'belgïe') then 'BE'
    when lower(trim(p_land)) in ('nl', 'nederland', 'netherlands', 'holland') then 'NL'
    when lower(trim(p_land)) in ('it', 'italy', 'italia', 'italië', 'italie') then 'IT'
    else 'OTHER'
  end;
$$;

create or replace function public.bestemmingen_periodes_bookings_year(
  p_year integer,
  p_brand text,
  p_bestemming_id uuid,
  p_country text,
  p_brand_land text default '__ALL__'
)
returns table (
  booking_id uuid,
  vertrekdatum date,
  terugkeerdatum date,
  bestemming_naam text,
  accommodatie_naam text,
  transport_naam text,
  brand text,
  pax_scope bigint,
  pax_be bigint,
  pax_nl bigint,
  pax_it bigint,
  pax_other bigint,
  booking_unit bigint
)
language sql
stable
as $$
  with tr as (
    select
      r.boeking_id,
      count(*)::bigint as pax_from_rows,
      count(*) filter (where public._bp_traveler_country_bucket(r.land) = 'BE')::bigint as pax_be,
      count(*) filter (where public._bp_traveler_country_bucket(r.land) = 'NL')::bigint as pax_nl,
      count(*) filter (where public._bp_traveler_country_bucket(r.land) = 'IT')::bigint as pax_it,
      count(*) filter (where public._bp_traveler_country_bucket(r.land) = 'OTHER')::bigint as pax_other
    from public.reizigers r
    left join public.statussen st_tr on st_tr.id = r.traveller_status_id
    where not public.reiziger_status_uitgesloten_standaard_dashboards(st_tr.naam)
    group by r.boeking_id
  ),
  tr_transport as (
    select
      r.boeking_id,
      case
        when lower(trim(coalesce(to_jsonb(r)->>'transport', ''))) in ('self', 'bus', 'plane')
          then lower(trim(coalesce(to_jsonb(r)->>'transport', '')))
        else 'plane'
      end as transport,
      count(*)::bigint as pax_t
    from public.reizigers r
    left join public.statussen st_tr on st_tr.id = r.traveller_status_id
    where not public.reiziger_status_uitgesloten_standaard_dashboards(st_tr.naam)
    group by r.boeking_id, 2
  ),
  tr_transport_top as (
    select
      x.boeking_id,
      x.transport
    from (
      select
        tt.*,
        row_number() over (
          partition by tt.boeking_id
          order by tt.pax_t desc,
                   case tt.transport when 'plane' then 1 when 'bus' then 2 else 3 end
        ) as rn
      from tr_transport tt
    ) x
    where x.rn = 1
  ),
  base as (
    select
      b.id as bid,
      b.vertrekdatum::date as vd,
      b.terugkeerdatum::date as td_raw,
      coalesce(d.naam, '')::text as bestemming_naam,
      coalesce(a.naam, '')::text as accommodatie_naam,
      coalesce(tt.transport, 'plane')::text as transport_naam,
      coalesce(b.brand, '')::text as brand,
      coalesce(tr.pax_from_rows, 0::bigint) as pax_r,
      coalesce(tr.pax_be, 0::bigint) as pax_be,
      coalesce(tr.pax_nl, 0::bigint) as pax_nl,
      coalesce(tr.pax_it, 0::bigint) as pax_it,
      coalesce(tr.pax_other, 0::bigint) as pax_other
    from public.boekingen b
    left join public.bestemmingen d on d.id = b.bestemming_id
    left join public.accommodaties a on a.id = b.accommodatie_id
    left join tr_transport_top tt on tt.boeking_id = b.id
    left join tr on tr.boeking_id = b.id
    where b.vertrekdatum is not null
      and not public.boeking_id_excluded_from_standard_dashboards(b.id)
      and extract(year from b.vertrekdatum)::int = p_year
      and (
        p_brand = '__all__'
        or lower(trim(coalesce(b.brand, ''))) = lower(trim(p_brand))
      )
      and (p_bestemming_id is null or b.bestemming_id = p_bestemming_id)
      and (
        p_brand_land is null
        or trim(p_brand_land) = ''
        or lower(trim(p_brand_land)) in ('__all__', 'all')
        or upper(trim(coalesce(b.brand_land, ''))) = upper(trim(p_brand_land))
      )
  ),
  norm as (
    select
      base.*,
      case
        when base.pax_r > 0 then base.pax_r
        else 0::bigint
      end as pax_all_eff,
      case
        when base.pax_r > 0 then base.pax_other
        else 0::bigint
      end as pax_other_eff
    from base
  ),
  scoped as (
    select
      norm.*,
      case
        when trim(coalesce(p_country, '')) = ''
          or lower(trim(p_country)) in ('__all__', 'all')
          then norm.pax_all_eff
        when upper(trim(p_country)) = 'BE' then norm.pax_be
        when upper(trim(p_country)) = 'NL' then norm.pax_nl
        when upper(trim(p_country)) = 'IT' then norm.pax_it
        when upper(trim(p_country)) = 'OTHER' then norm.pax_other_eff
        else norm.pax_all_eff
      end::bigint as pax_scope
    from norm
  )
  select
    scoped.bid as booking_id,
    scoped.vd as vertrekdatum,
    scoped.td_raw as terugkeerdatum,
    scoped.bestemming_naam,
    scoped.accommodatie_naam,
    scoped.transport_naam,
    scoped.brand,
    scoped.pax_scope,
    scoped.pax_be,
    scoped.pax_nl,
    scoped.pax_it,
    scoped.pax_other_eff as pax_other,
    1::bigint as booking_unit
  from scoped
  where scoped.pax_scope > 0;
$$;

create or replace function public.bestemmingen_periodes_transport_split_year(
  p_year integer,
  p_brand text,
  p_bestemming_id uuid,
  p_country text,
  p_brand_land text default '__ALL__'
)
returns table (
  transport text,
  pax bigint
)
language sql
stable
as $$
  with base as (
    select
      case
        when lower(trim(coalesce(to_jsonb(r)->>'transport', ''))) in ('self', 'bus', 'plane')
          then lower(trim(coalesce(to_jsonb(r)->>'transport', '')))
        else 'plane'
      end as transport
    from public.reizigers r
    join public.boekingen b on b.id = r.boeking_id
    left join public.statussen st_tr on st_tr.id = r.traveller_status_id
    where b.vertrekdatum is not null
      and extract(year from b.vertrekdatum)::int = p_year
      and not public.boeking_id_excluded_from_standard_dashboards(b.id)
      and not public.reiziger_status_uitgesloten_standaard_dashboards(st_tr.naam)
      and (
        p_brand = '__all__'
        or lower(trim(coalesce(b.brand, ''))) = lower(trim(p_brand))
      )
      and (p_bestemming_id is null or b.bestemming_id = p_bestemming_id)
      and (
        p_brand_land is null
        or trim(p_brand_land) = ''
        or lower(trim(p_brand_land)) in ('__all__', 'all')
        or upper(trim(coalesce(b.brand_land, ''))) = upper(trim(p_brand_land))
      )
      and (
        trim(coalesce(p_country, '')) = ''
        or lower(trim(p_country)) in ('__all__', 'all')
        or upper(trim(p_country)) = public._bp_traveler_country_bucket(r.land)
      )
  )
  select transport, count(*)::bigint as pax
  from base
  group by transport
  order by case transport when 'plane' then 1 when 'bus' then 2 else 3 end;
$$;
