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

-- De bestemmingen_periodes-functies die hier oorspronkelijk stonden, worden
-- (in een nieuwere versie) gedefinieerd in sql/rpc/bestemmingen_periodes_rpc.sql.
