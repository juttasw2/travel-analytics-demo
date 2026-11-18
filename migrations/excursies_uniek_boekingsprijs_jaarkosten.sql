-- Excursies model-herwerking:
-- - unieke excursie-master op (normalized_naam, bestemming_id)
-- - effectieve verkoopprijs op boekingsregel
-- - jaarlijkse kostenstructuur per excursie
-- - analyse-view met margeberekening op regelniveau
--
-- Veilig voor bestaande omgevingen: kolommen/tabellen/constraints alleen toevoegen indien nodig.

create extension if not exists pgcrypto;

create or replace function public.normalize_excursie_naam(p_naam text)
returns text
language sql
immutable
as $$
  select
    case
      when p_naam is null then null
      else upper(
        regexp_replace(
          btrim(
            translate(
              p_naam,
              'áàâäãåÁÀÂÄÃÅéèêëÉÈÊËíìîïÍÌÎÏóòôöõÓÒÔÖÕúùûüÚÙÛÜýÿÝçÇñÑ',
              'aaaaaaAAAAAAeeeeEEEEiiiiIIIIoooooOOOOOuuuuUUUUyyYcCnN'
            )
          ),
          '\s+',
          ' ',
          'g'
        )
      )
    end;
$$;

comment on function public.normalize_excursie_naam(text) is
  'Normaliseert excursienamen voor unieke identiteit: trim, accentreductie, spaties comprimeren, uppercase.';

do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'excursies'
      and column_name = 'normalized_naam'
  ) then
    alter table public.excursies
      add column normalized_naam text;
  end if;
end $$;

update public.excursies
set normalized_naam = public.normalize_excursie_naam(naam)
where normalized_naam is null
   or normalized_naam <> public.normalize_excursie_naam(naam);

-- Dedupe bestaande excursies per (normalized_naam, bestemming_id).
-- We houden per combinatie de oudste id en verleggen boeking-relaties.
create temporary table if not exists tmp_excursies_dedupe_map (
  duplicate_id uuid primary key,
  canonical_id uuid not null
) on commit drop;

truncate table tmp_excursies_dedupe_map;

do $$
declare
  has_aangemaakt_op boolean;
  order_expr text;
begin
  select exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'excursies'
      and column_name = 'aangemaakt_op'
  ) into has_aangemaakt_op;

  order_expr := case
    when has_aangemaakt_op then 'ex.aangemaakt_op nulls last, ex.id'
    else 'ex.id'
  end;

  execute format($sql$
    insert into tmp_excursies_dedupe_map (duplicate_id, canonical_id)
    with ranked as (
      select
        ex.id,
        first_value(ex.id) over (
          partition by ex.normalized_naam, ex.bestemming_id
          order by %s
        ) as canonical_id
      from public.excursies ex
      where ex.normalized_naam is not null
    )
    select id as duplicate_id, canonical_id
    from ranked
    where id <> canonical_id
  $sql$, order_expr);
end $$;

update public.boeking_excursies bex
set excursie_id = tm.canonical_id
from tmp_excursies_dedupe_map tm
where bex.excursie_id = tm.duplicate_id;

delete from public.excursies ex
using tmp_excursies_dedupe_map tm
where ex.id = tm.duplicate_id;

create unique index if not exists uq_excursies_normalized_bestemming
  on public.excursies (
    normalized_naam,
    coalesce(bestemming_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

create or replace function public.excursies_set_normalized_naam()
returns trigger
language plpgsql
as $$
begin
  new.normalized_naam := public.normalize_excursie_naam(new.naam);
  return new;
end;
$$;

drop trigger if exists trg_excursies_set_normalized_naam on public.excursies;
create trigger trg_excursies_set_normalized_naam
before insert or update of naam
on public.excursies
for each row
execute function public.excursies_set_normalized_naam();

do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'boeking_excursies'
      and column_name = 'verkoopprijs'
  ) then
    alter table public.boeking_excursies
      add column verkoopprijs numeric(12,2) not null default 0;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'boeking_excursies'
      and column_name = 'is_gratis'
  ) then
    alter table public.boeking_excursies
      add column is_gratis boolean not null default false;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'boeking_excursies'
      and column_name = 'upload_id'
  ) then
    alter table public.boeking_excursies
      add column upload_id uuid null references public.uploads(id) on delete set null;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'boeking_excursies'
      and column_name = 'bron_rij_hash'
  ) then
    alter table public.boeking_excursies
      add column bron_rij_hash text null;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'boeking_excursies'
      and column_name = 'ingevoerd_via'
  ) then
    alter table public.boeking_excursies
      add column ingevoerd_via text null;
  end if;
end $$;

do $$
declare
  has_old_price boolean;
begin
  select exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'boeking_excursies'
      and column_name = 'prijs'
  ) into has_old_price;

  if has_old_price then
    execute $sql$
      update public.boeking_excursies bex
      set verkoopprijs = coalesce(bex.verkoopprijs, bex.prijs, ex.prijs, 0)
      from public.excursies ex
      where ex.id = bex.excursie_id
    $sql$;
  else
    execute $sql$
      update public.boeking_excursies bex
      set verkoopprijs = coalesce(bex.verkoopprijs, ex.prijs, 0)
      from public.excursies ex
      where ex.id = bex.excursie_id
    $sql$;
  end if;
end $$;

update public.boeking_excursies
set is_gratis = (coalesce(verkoopprijs, 0) = 0)
where is_gratis is distinct from (coalesce(verkoopprijs, 0) = 0);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'chk_boeking_excursies_verkoopprijs_non_negative'
  ) then
    alter table public.boeking_excursies
      add constraint chk_boeking_excursies_verkoopprijs_non_negative
      check (verkoopprijs >= 0);
  end if;
end $$;

create table if not exists public.excursie_jaarkosten (
  id uuid primary key default gen_random_uuid(),
  excursie_id uuid not null references public.excursies(id) on delete cascade,
  jaar integer not null,
  inkoopprijs numeric(12,2) null check (inkoopprijs is null or inkoopprijs >= 0),
  commissie numeric(12,2) null check (commissie is null or commissie >= 0),
  commissie_percentage numeric(7,2) null check (commissie_percentage is null or (commissie_percentage >= 0 and commissie_percentage <= 100)),
  aangemaakt_op timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists uq_excursie_jaarkosten_excursie_jaar
  on public.excursie_jaarkosten(excursie_id, jaar);

create or replace function public.set_updated_at_timestamp()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_excursie_jaarkosten_updated_at on public.excursie_jaarkosten;
create trigger trg_excursie_jaarkosten_updated_at
before update on public.excursie_jaarkosten
for each row
execute function public.set_updated_at_timestamp();

-- Backfill jaarkosten:
-- - kostjaar: jaar van boeking_excursies.vertrekdatum -> boekingen.vertrekdatum -> boekingen.boekingsdatum
-- - fallback zonder datumkoppeling: huidig kalenderjaar (handmatig valideren na deploy)
with derived_year as (
  select
    ex.id as excursie_id,
    coalesce(
      (
        select yy.jaar
        from (
          select
            extract(year from coalesce(bex.vertrekdatum, b.vertrekdatum, b.boekingsdatum))::int as jaar,
            count(*) as c
          from public.boeking_excursies bex
          join public.boekingen b on b.id = bex.boeking_id
          where bex.excursie_id = ex.id
            and coalesce(bex.vertrekdatum, b.vertrekdatum, b.boekingsdatum) is not null
          group by 1
          order by c desc, jaar desc
          limit 1
        ) yy
      ),
      extract(year from now())::int
    ) as jaar
  from public.excursies ex
),
seed as (
  select
    ex.id as excursie_id,
    dy.jaar,
    ex.inkoopprijs,
    ex.commissie,
    ex.commissie_percentage
  from public.excursies ex
  join derived_year dy on dy.excursie_id = ex.id
)
insert into public.excursie_jaarkosten (excursie_id, jaar, inkoopprijs, commissie, commissie_percentage)
select
  s.excursie_id,
  s.jaar,
  s.inkoopprijs,
  s.commissie,
  s.commissie_percentage
from seed s
on conflict (excursie_id, jaar) do update
set
  inkoopprijs = excluded.inkoopprijs,
  commissie = excluded.commissie,
  commissie_percentage = excluded.commissie_percentage,
  updated_at = now();

drop view if exists public.vw_excursie_sales_analysis;
create or replace view public.vw_excursie_sales_analysis as
with base as (
  select
    bex.id as boeking_excursie_id,
    bex.boeking_id,
    bex.excursie_id,
    ex.naam as excursie_naam,
    coalesce(ex.excursie_type, ex.type, '') as excursie_type,
    coalesce(ex.bestemming_id, b.bestemming_id) as bestemming_id,
    d.naam as bestemming_naam,
    bex.vertrekdatum,
    bex.terugkeerdatum,
    b.boekingsdatum,
    b.order_nummer,
    b.brand,
    coalesce(bex.verkoopprijs, 0)::numeric as verkoopprijs,
    coalesce(bex.is_gratis, false) as is_gratis,
    extract(year from coalesce(bex.vertrekdatum, b.vertrekdatum, b.boekingsdatum))::int as kostjaar,
    coalesce(b.aantal_reizigers, 0)::int as booking_pax,
    bex.betaling_pending,
    bex.betaaloptie,
    bex.mollie_betaling_id,
    bex.geboekt_in_online_account,
    bex.commentaar,
    bex.datum_toegevoegd,
    st.naam as booking_status
  from public.boeking_excursies bex
  join public.boekingen b on b.id = bex.boeking_id
  join public.excursies ex on ex.id = bex.excursie_id
  left join public.bestemmingen d on d.id = coalesce(ex.bestemming_id, b.bestemming_id)
  left join public.statussen st on st.id = b.boeking_status_id
)
select
  b.*,
  (jk.id is not null) as jaarkosten_gevonden,
  jk.inkoopprijs::numeric as inkoopprijs,
  jk.commissie::numeric as commissie,
  jk.commissie_percentage::numeric as commissie_percentage,
  -- Business rule: winst (= berekende_commissie / marge) mag enkel bestaan zodra er een
  -- geldige inkoopprijs is. Geldig = jaarkosten-rij aanwezig, inkoopprijs not null en > 0.
  -- Zonder geldige inkoopprijs zijn alle winst-afgeleide kolommen 0/NULL, zodat omzet
  -- nooit als winst kan worden gepresenteerd.
  (
    case
      when jk.id is null or jk.inkoopprijs is null or jk.inkoopprijs <= 0 then 0::numeric
      else (
        coalesce(jk.commissie, 0)
        + (coalesce(b.verkoopprijs, 0) * coalesce(jk.commissie_percentage, 0) / 100.0)
      )::numeric
    end
  ) as berekende_commissie,
  (
    case
      when jk.id is null or jk.inkoopprijs is null or jk.inkoopprijs <= 0 then null::numeric
      else (jk.inkoopprijs + coalesce(jk.commissie, 0)
            + (coalesce(b.verkoopprijs, 0) * coalesce(jk.commissie_percentage, 0) / 100.0))::numeric
    end
  ) as totale_kost,
  (
    case
      when jk.id is null or jk.inkoopprijs is null or jk.inkoopprijs <= 0 then 0::numeric
      else (
        coalesce(jk.commissie, 0)
        + (coalesce(b.verkoopprijs, 0) * coalesce(jk.commissie_percentage, 0) / 100.0)
      )::numeric
    end
  ) as marge,
  (
    case
      when coalesce(b.verkoopprijs, 0) = 0 then null::numeric
      when jk.id is null or jk.inkoopprijs is null or jk.inkoopprijs <= 0 then 0::numeric
      else (
        (
          coalesce(jk.commissie, 0)
          + (coalesce(b.verkoopprijs, 0) * coalesce(jk.commissie_percentage, 0) / 100.0)
        ) / nullif(b.verkoopprijs, 0)
      ) * 100.0
    end
  ) as marge_percentage
from base b
left join public.excursie_jaarkosten jk
  on jk.excursie_id = b.excursie_id
 and jk.jaar = b.kostjaar;

comment on view public.vw_excursie_sales_analysis is
  'Analyse-view per boeking_excursie met effectieve verkoopprijs en commissie-gedreven winstberekening.';

comment on column public.excursies.prijs is
  'Legacy/informatief veld. Analyse-waarheid voor verkoopprijs staat op boeking_excursies.verkoopprijs.';
comment on column public.excursies.inkoopprijs is
  'Legacy fallback. Gebruik primair excursie_jaarkosten.inkoopprijs voor winstanalyse.';
comment on column public.excursies.commissie is
  'Legacy fallback. Gebruik primair excursie_jaarkosten.commissie voor winstanalyse.';
comment on column public.excursies.commissie_percentage is
  'Legacy fallback. Gebruik primair excursie_jaarkosten.commissie_percentage voor winstanalyse.';
