-- totaal_te_betalen in boekingen_met_omzet: zelfde reizigersfilter als overzicht / standaard dashboards
-- (public.reiziger_status_uitgesloten_standaard_dashboards). Voorheen: som over alle reizigers.

begin;

create or replace view public.boekingen_met_omzet as
select
  b.*,
  coalesce(rf_sum.totaal_te_betalen, 0)::numeric as totaal_te_betalen
from public.boekingen b
left join (
  select
    r.boeking_id,
    coalesce(sum(rf.totaal_te_betalen), 0)::numeric as totaal_te_betalen
  from public.reizigers r
  left join public.statussen st_tr on st_tr.id = r.traveller_status_id
  left join public.reiziger_financien rf on rf.reiziger_id = r.id
  where not public.reiziger_status_uitgesloten_standaard_dashboards(st_tr.naam)
  group by r.boeking_id
) rf_sum on rf_sum.boeking_id = b.id;

comment on view public.boekingen_met_omzet is
  'Boekingen + totaal_te_betalen (som reiziger_financien voor actieve reizigers t.o.v. standaard dashboards).';

commit;
