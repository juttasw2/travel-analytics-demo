-- Migratie: transportkost-regel afdwingen + bestaande foutieve records corrigeren.
-- Regel:
-- - bus + kost_transport = 0/null => 140
-- - self/zelf => 0
-- - plane/vliegtuig => waarde behouden

begin;

-- Skip entirely if kost_transport has already been moved to reiziger_financien
do $$
begin
    if not exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'boeking_financien' and column_name = 'kost_transport'
    ) then
        raise notice 'kost_transport not on boeking_financien – skipping migration';
        return;
    end if;
end $$;

do $$
begin
    if to_regclass('public.boeking_financien') is null then
        raise exception 'Tabel public.boeking_financien bestaat niet.';
    end if;
    if to_regclass('public.boekingen') is null then
        raise exception 'Tabel public.boekingen bestaat niet.';
    end if;
    if to_regclass('public.transporten') is null then
        raise exception 'Tabel public.transporten bestaat niet.';
    end if;
end $$;

-- Preview: welke records zullen door de update veranderen?
select
    bf.boeking_id,
    t.naam as transport,
    bf.kost_transport as huidige_kost_transport,
    case
        when lower(trim(coalesce(t.naam, ''))) = 'bus'
             and coalesce(bf.kost_transport, 0) = 0
            then 140::numeric
        when lower(trim(coalesce(t.naam, ''))) in ('self', 'zelf')
            then 0::numeric
        else bf.kost_transport
    end as nieuwe_kost_transport
from public.boeking_financien bf
join public.boekingen b on b.id = bf.boeking_id
left join public.transporten t on t.id = b.transport_id
where
    (
        lower(trim(coalesce(t.naam, ''))) = 'bus'
        and coalesce(bf.kost_transport, 0) = 0
    )
    or (
        lower(trim(coalesce(t.naam, ''))) in ('self', 'zelf')
        and coalesce(bf.kost_transport, 0) <> 0
    )
order by transport, bf.boeking_id;

-- Fix bestaande data volgens de business rule.
update public.boeking_financien bf
set kost_transport = case
    when lower(trim(coalesce(t.naam, ''))) = 'bus'
         and coalesce(bf.kost_transport, 0) = 0
        then 140
    when lower(trim(coalesce(t.naam, ''))) in ('self', 'zelf')
        then 0
    else bf.kost_transport
end
from public.boekingen b
left join public.transporten t on t.id = b.transport_id
where b.id = bf.boeking_id
  and (
      (
          lower(trim(coalesce(t.naam, ''))) = 'bus'
          and coalesce(bf.kost_transport, 0) = 0
      )
      or (
          lower(trim(coalesce(t.naam, ''))) in ('self', 'zelf')
          and coalesce(bf.kost_transport, 0) <> 0
      )
  );

-- Toekomstige inserts/updates automatisch corrigeren.
create or replace function public.fn_boeking_financien_apply_transport_kost_rule()
returns trigger
language plpgsql
as $$
declare
    v_transport text;
begin
    select lower(trim(coalesce(t.naam, '')))
    into v_transport
    from public.boekingen b
    left join public.transporten t on t.id = b.transport_id
    where b.id = new.boeking_id;

    if v_transport in ('self', 'zelf') then
        new.kost_transport := 0;
    elsif v_transport = 'bus' and coalesce(new.kost_transport, 0) = 0 then
        new.kost_transport := 140;
    elsif v_transport in ('plane', 'vliegtuig') then
        -- expliciet niets overschrijven
        new.kost_transport := new.kost_transport;
    end if;

    return new;
end;
$$;

drop trigger if exists trg_boeking_financien_transport_kost_rule on public.boeking_financien;

create trigger trg_boeking_financien_transport_kost_rule
before insert or update of boeking_id, kost_transport
on public.boeking_financien
for each row
execute function public.fn_boeking_financien_apply_transport_kost_rule();

commit;
