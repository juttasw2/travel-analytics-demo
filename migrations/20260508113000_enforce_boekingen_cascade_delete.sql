-- Enforce ON DELETE CASCADE for all FK constraints that point to
-- public.boekingen(id) via a single local column named boeking_id.
-- This guarantees that deleting a booking removes dependent rows.

begin;

do $$
declare
  rec record;
begin
  for rec in
    select
      c.conname,
      c.conrelid::regclass as table_name
    from pg_constraint c
    join pg_attribute a
      on a.attrelid = c.conrelid
     and a.attnum = c.conkey[1]
    where c.contype = 'f'
      and c.confrelid = 'public.boekingen'::regclass
      and array_length(c.conkey, 1) = 1
      and a.attname = 'boeking_id'
      and c.confdeltype <> 'c'
  loop
    execute format('alter table %s drop constraint %I', rec.table_name, rec.conname);
    execute format(
      'alter table %s add constraint %I foreign key (boeking_id) references public.boekingen(id) on delete cascade',
      rec.table_name,
      rec.conname
    );
  end loop;
end;
$$;

commit;
