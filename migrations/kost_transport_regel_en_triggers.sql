-- Transportkost-regel voor boeking_financien.kost_transport
-- Bron transporttype: public.boekingen.transport_id -> public.transporten.naam
-- (er is geen transport-kolom op boeking_financien).
--
-- Regels (case-insensitive op trim(naam)):
--   - 'bus' en coalesce(kost_transport,0) = 0  -> 140
--   - 'self' of 'zelf'                         -> 0
--   - 'plane' of 'vliegtuig'                 -> ongewijzigd (elke waarde blijft)
--   - overig / null                          -> ongewijzigd
--
-- Eerst PREVIEW draaien, daarna UPDATE en triggers activeren.

begin;

-- ---------------------------------------------------------------------------
-- 1) Pure functie voor één (transport_naam, huidige kost)
-- ---------------------------------------------------------------------------
create or replace function public.compute_kost_transport_rule(
  p_transport_naam text,
  p_kost_transport numeric
)
returns numeric
language sql
immutable
as $$
  select case
    when lower(trim(coalesce(p_transport_naam, ''))) in ('self', 'zelf') then 0::numeric
    when lower(trim(coalesce(p_transport_naam, ''))) = 'bus'
         and coalesce(p_kost_transport, 0) = 0 then 140::numeric
    else coalesce(p_kost_transport, 0)::numeric
  end;
$$;

comment on function public.compute_kost_transport_rule(text, numeric) is
  'Zet kost_transport afhankelijk van transporten.naam (bus/self/zelf/plane blijft ongewijzigd).';

-- ---------------------------------------------------------------------------
-- 2) BEFORE INSERT/UPDATE op boeking_financien
-- ---------------------------------------------------------------------------
create or replace function public.trg_boeking_financien_apply_kost_transport_rule()
returns trigger
language plpgsql
as $$
declare
  v_naam text;
begin
  select t.naam into v_naam
  from public.boekingen b
  left join public.transporten t on t.id = b.transport_id
  where b.id = new.boeking_id;

  new.kost_transport := public.compute_kost_transport_rule(v_naam, new.kost_transport);
  return new;
end;
$$;

drop trigger if exists trg_boeking_financien_apply_kost_transport on public.boeking_financien;

-- Only create trigger if kost_transport column still exists on boeking_financien
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'boeking_financien' and column_name = 'kost_transport'
  ) then
    execute $t$
      create trigger trg_boeking_financien_apply_kost_transport
        before insert or update of kost_transport, boeking_id
        on public.boeking_financien
        for each row
        execute procedure public.trg_boeking_financien_apply_kost_transport_rule()
    $t$;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3) Als transport_id op boekingen wijzigt: herbereken gekoppelde financiën
-- ---------------------------------------------------------------------------
create or replace function public.trg_boekingen_refresh_financien_kost_transport()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'update'
     and new.transport_id is distinct from old.transport_id then
    -- Only update if kost_transport column exists on boeking_financien
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'boeking_financien' and column_name = 'kost_transport'
    ) then
      update public.boeking_financien f
      set kost_transport = public.compute_kost_transport_rule(
        (select t.naam from public.transporten t where t.id = new.transport_id),
        f.kost_transport
      )
      where f.boeking_id = new.id;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_boekingen_refresh_financien_kost_transport on public.boekingen;
create trigger trg_boekingen_refresh_financien_kost_transport
  after update of transport_id
  on public.boekingen
  for each row
  execute procedure public.trg_boekingen_refresh_financien_kost_transport();

commit;

-- ===========================================================================
-- HANDMATIG (éénmalig bestaande data): eerst PREVIEW, dan UPDATE
-- ===========================================================================
-- PREVIEW — rijen waar de regel een andere kost_transport zou geven:
/*
select
  bf.boeking_id,
  t.id as transport_id,
  t.naam as transport_naam,
  bf.kost_transport as kost_transport_huidig,
  public.compute_kost_transport_rule(t.naam, bf.kost_transport) as kost_transport_nieuw
from public.boeking_financien bf
join public.boekingen b on b.id = bf.boeking_id
left join public.transporten t on t.id = b.transport_id
where public.compute_kost_transport_rule(t.naam, bf.kost_transport)
      is distinct from coalesce(bf.kost_transport, 0);
*/

-- UPDATE — pas uit na controle van de preview
/*
update public.boeking_financien bf
set kost_transport = public.compute_kost_transport_rule(t.naam, bf.kost_transport)
from public.boekingen b
left join public.transporten t on t.id = b.transport_id
where bf.boeking_id = b.id
  and public.compute_kost_transport_rule(t.naam, bf.kost_transport)
      is distinct from coalesce(bf.kost_transport, 0);
*/
