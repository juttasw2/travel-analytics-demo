-- Restore helper required by public.data_verzameling_detail(uuid).
-- Cloud SQL environments can miss this function when older transport-cost
-- migrations were not applied during the Supabase -> Cloud SQL transition.

begin;

create or replace function public.compute_kost_transport_rule(
  p_transport_naam text,
  p_kost_transport numeric
)
returns numeric
language sql
immutable
as $$
  select case
    when lower(trim(coalesce(p_transport_naam, ''))) in ('self', 'zelf') then 1::numeric
    when lower(trim(coalesce(p_transport_naam, ''))) = 'bus'
         and coalesce(p_kost_transport, 0) = 0 then 130::numeric
    else coalesce(p_kost_transport, 0)::numeric
  end;
$$;

comment on function public.compute_kost_transport_rule(text, numeric) is
  'Zet kost_transport afhankelijk van transporten.naam: self/zelf->1, bus+0->130, anders ongewijzigd.';

commit;
