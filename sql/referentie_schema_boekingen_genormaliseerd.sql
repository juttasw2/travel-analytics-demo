-- Referentie-DDL: doelstructuur na normalisatie (greenfield of ter vergelijking).
-- Niet blind uitvoeren op bestaande DB: gebruik de migraties in migrations/.
-- Waarschuwing: CREATE TABLE IF NOT EXISTS slaat ontbrekende kolommen niet bij.

-- === Kern: boekingen ===
-- Minimale identiteit + planning + statussen + transport-keuze + merk.
/*
create table public.boekingen (
  id uuid not null default gen_random_uuid(),
  order_nummer text unique,
  bestemming_id uuid references public.bestemmingen (id),
  accommodatie_id uuid references public.accommodaties (id),
  vertrekdatum date,
  terugkeerdatum date,
  boekingsdatum date,
  aantal_reizigers integer,
  boeking_status_id uuid references public.statussen (id),
  betaling_status_id uuid references public.statussen (id),
  doelgroep_id uuid references public.doelgroepen (id),
  transport_id uuid references public.transporten (id),
  brand text,
  brand_land text,
  aangemaakt_op timestamp with time zone not null default now(),
  upload_id uuid references public.uploads (id),
  constraint boekingen_pkey primary key (id)
);
create index if not exists idx_boekingen_vertrekdatum on public.boekingen (vertrekdatum);
create index if not exists idx_boekingen_boekingsdatum on public.boekingen (boekingsdatum);
create index if not exists idx_boekingen_brand on public.boekingen (brand);
create index if not exists idx_boekingen_bestemming_id on public.boekingen (bestemming_id);
*/

-- === 1:1 satellieten (per boeking) ===
-- boeking_accommodaties, boeking_financien, boeking_bus_gegevens: elk boeking_id unique + FK cascade.

-- === View: omzet zonder kolom op boekingen ===
/*
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
  left join public.reiziger_financien rf on rf.reiziger_id = r.id
  group by r.boeking_id
) rf_sum on rf_sum.boeking_id = b.id;
*/
