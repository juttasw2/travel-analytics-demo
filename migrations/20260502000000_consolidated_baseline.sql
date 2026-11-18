-- =============================================================================
-- 20260502000000_consolidated_baseline.sql
-- Idempotent consolidated baseline — targets production shape (column catalogue +
-- constraint export). Data migrations / RPCs / views / triggers are OUT OF SCOPE.
-- =============================================================================

begin;

create extension if not exists pgcrypto;

-- =============================================================================
-- Helpers: add FK / UNIQUE / CHECK only if missing (stable names from prod).
-- =============================================================================

-- ----- statussen (no FKs inbound before creation)
create table if not exists public.statussen (
  id uuid primary key default gen_random_uuid()
);
alter table public.statussen add column if not exists type text;
alter table public.statussen add column if not exists naam text;

do $$ begin
  alter table public.statussen alter column type set not null;
exception when others then null; end $$;
do $$ begin
  alter table public.statussen alter column naam set not null;
exception when others then null; end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'chk_statussen_type_toegelaten_nl') then
    alter table public.statussen add constraint chk_statussen_type_toegelaten_nl
      check (type = any (array['boeking'::text, 'betaling'::text, 'reiziger'::text, 'accommodatie'::text, 'excursie'::text, 'addon'::text, 'transport'::text]));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'uq_statussen_type_naam') then
    alter table public.statussen add constraint uq_statussen_type_naam unique (type, naam);
  end if;
end $$;

-- ----- bestemmingen
create table if not exists public.bestemmingen (
  id uuid primary key default gen_random_uuid()
);
alter table public.bestemmingen add column if not exists naam text;
alter table public.bestemmingen add column if not exists regio text;
do $$ begin
  alter table public.bestemmingen alter column naam set not null;
exception when others then null; end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'bestemmingen_naam_key') then
    alter table public.bestemmingen add constraint bestemmingen_naam_key unique (naam);
  end if;
end $$;

-- ----- doelgroepen
create table if not exists public.doelgroepen (
  id uuid primary key default gen_random_uuid()
);
alter table public.doelgroepen add column if not exists naam text;
do $$ begin
  alter table public.doelgroepen alter column naam set not null;
exception when others then null; end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'doelgroepen_naam_key') then
    alter table public.doelgroepen add constraint doelgroepen_naam_key unique (naam);
  end if;
end $$;

-- ----- transporten
create table if not exists public.transporten (
  id uuid primary key default gen_random_uuid()
);
alter table public.transporten add column if not exists naam text;
do $$ begin
  alter table public.transporten alter column naam set not null;
exception when others then null; end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'transporten_naam_key') then
    alter table public.transporten add constraint transporten_naam_key unique (naam);
  end if;
end $$;

-- ----- addons
create table if not exists public.addons (
  id uuid primary key default gen_random_uuid()
);
alter table public.addons add column if not exists naam text;
do $$ begin
  alter table public.addons alter column naam set not null;
exception when others then null; end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'addons_naam_key') then
    alter table public.addons add constraint addons_naam_key unique (naam);
  end if;
end $$;

-- ----- uploads (before vlucht_allotments / boeking_excursies.upload_id)
create table if not exists public.uploads (
  id uuid primary key default gen_random_uuid()
);
alter table public.uploads add column if not exists bestandsnaam text;
alter table public.uploads add column if not exists geupload_op timestamptz not null default now();
alter table public.uploads add column if not exists type text;

do $$ begin
  alter table public.uploads alter column type set not null;
exception when others then null; end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'uploads_type_check') then
    alter table public.uploads add constraint uploads_type_check
      check (type = any (array['boekingen'::text, 'vlucht_allotments'::text]));
  end if;
end $$;

-- ----- accommodaties
create table if not exists public.accommodaties (
  id uuid primary key default gen_random_uuid()
);
alter table public.accommodaties add column if not exists naam text;
alter table public.accommodaties add column if not exists type text;
alter table public.accommodaties add column if not exists leverancier text;
alter table public.accommodaties add column if not exists bestemming_id uuid;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'accommodaties_bestemming_id_fkey') then
    alter table public.accommodaties
      add constraint accommodaties_bestemming_id_fkey
      foreign key (bestemming_id) references public.bestemmingen(id);
  end if;
end $$;

-- ----- excursies (before boeking_excursies / excursie_jaarkosten)
create table if not exists public.excursies (
  id uuid primary key default gen_random_uuid()
);
alter table public.excursies add column if not exists naam text;
alter table public.excursies add column if not exists type text;
alter table public.excursies add column if not exists prijs numeric(12,2);
alter table public.excursies add column if not exists excursie_type text;
alter table public.excursies add column if not exists bestemming_id uuid;
alter table public.excursies add column if not exists inkoopprijs numeric(12,2);
alter table public.excursies add column if not exists commissie numeric(12,2);
alter table public.excursies add column if not exists commissie_percentage numeric(7,2);
alter table public.excursies add column if not exists normalized_naam text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'excursies_bestemming_id_fkey') then
    alter table public.excursies
      add constraint excursies_bestemming_id_fkey
      foreign key (bestemming_id) references public.bestemmingen(id) on delete set null;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'chk_excursies_verkoopprijs_non_negative') then
    alter table public.excursies add constraint chk_excursies_verkoopprijs_non_negative
      check (prijs is null or prijs >= 0::numeric);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'chk_excursies_inkoopprijs_non_negative') then
    alter table public.excursies add constraint chk_excursies_inkoopprijs_non_negative
      check (inkoopprijs is null or inkoopprijs >= 0::numeric);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'chk_excursies_commissie_non_negative') then
    alter table public.excursies add constraint chk_excursies_commissie_non_negative
      check (commissie is null or commissie >= 0::numeric);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'chk_excursies_commissie_percentage_range') then
    alter table public.excursies add constraint chk_excursies_commissie_percentage_range
      check (
        commissie_percentage is null
        or (commissie_percentage >= 0::numeric and commissie_percentage <= 100::numeric)
      );
  end if;
end $$;

-- ----- boekingen
create table if not exists public.boekingen (
  id uuid primary key default gen_random_uuid()
);
alter table public.boekingen add column if not exists order_nummer text;
alter table public.boekingen add column if not exists bestemming_id uuid;
alter table public.boekingen add column if not exists accommodatie_id uuid;
alter table public.boekingen add column if not exists vertrekdatum date;
alter table public.boekingen add column if not exists terugkeerdatum date;
alter table public.boekingen add column if not exists boekingsdatum date;
alter table public.boekingen add column if not exists aantal_reizigers integer;
alter table public.boekingen add column if not exists boeking_status_id uuid;
alter table public.boekingen add column if not exists betaling_status_id uuid;
alter table public.boekingen add column if not exists doelgroep_id uuid;
alter table public.boekingen add column if not exists transport_id uuid;
alter table public.boekingen add column if not exists aangemaakt_op timestamptz not null default now();
alter table public.boekingen add column if not exists brand text;
alter table public.boekingen add column if not exists brand_land text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'boekingen_order_nummer_key') then
    alter table public.boekingen add constraint boekingen_order_nummer_key unique (order_nummer);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'boekingen_accommodatie_id_fkey') then
    alter table public.boekingen add constraint boekingen_accommodatie_id_fkey
      foreign key (accommodatie_id) references public.accommodaties(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'boekingen_bestemming_id_fkey') then
    alter table public.boekingen add constraint boekingen_bestemming_id_fkey
      foreign key (bestemming_id) references public.bestemmingen(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'boekingen_betaling_status_id_fkey') then
    alter table public.boekingen add constraint boekingen_betaling_status_id_fkey
      foreign key (betaling_status_id) references public.statussen(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'boekingen_boeking_status_id_fkey') then
    alter table public.boekingen add constraint boekingen_boeking_status_id_fkey
      foreign key (boeking_status_id) references public.statussen(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'boekingen_doelgroep_id_fkey') then
    alter table public.boekingen add constraint boekingen_doelgroep_id_fkey
      foreign key (doelgroep_id) references public.doelgroepen(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'boekingen_transport_id_fkey') then
    alter table public.boekingen add constraint boekingen_transport_id_fkey
      foreign key (transport_id) references public.transporten(id);
  end if;
end $$;

-- ----- app_users (auth; independent of boekingen)
create table if not exists public.app_users (
  id uuid primary key default gen_random_uuid()
);
alter table public.app_users add column if not exists email text;
alter table public.app_users add column if not exists password_hash text;
alter table public.app_users add column if not exists created_at timestamptz not null default now();
alter table public.app_users add column if not exists display_name text;
alter table public.app_users add column if not exists has_access boolean not null default false;
alter table public.app_users add column if not exists mfa_enabled boolean not null default false;
alter table public.app_users add column if not exists mfa_secret text;
alter table public.app_users add column if not exists role text not null default 'VERSIE_B';

do $$ begin
  alter table public.app_users alter column email set not null;
exception when others then null; end $$;
do $$ begin
  alter table public.app_users alter column password_hash set not null;
exception when others then null; end $$;
do $$ begin
  alter table public.app_users alter column created_at set not null;
exception when others then null; end $$;
do $$ begin
  alter table public.app_users alter column has_access set not null;
exception when others then null; end $$;
do $$ begin
  alter table public.app_users alter column mfa_enabled set not null;
exception when others then null; end $$;
do $$ begin
  alter table public.app_users alter column role set not null;
exception when others then null; end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'app_users_email_not_blank') then
    alter table public.app_users add constraint app_users_email_not_blank check (length(trim(email)) > 0);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'app_users_display_name_len') then
    alter table public.app_users add constraint app_users_display_name_len
      check (display_name is null or (length(trim(display_name)) >= 1 and length(trim(display_name)) <= 200));
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'app_users_role_valid') then
    alter table public.app_users add constraint app_users_role_valid
      check (role = any (array['VERSIE_A'::text, 'VERSIE_B'::text]));
  end if;
end $$;

create unique index if not exists app_users_email_lower_idx on public.app_users ((lower(trim(email))));

-- ----- reizigers
create table if not exists public.reizigers (
  id uuid primary key default gen_random_uuid()
);
alter table public.reizigers add column if not exists boeking_id uuid;
alter table public.reizigers add column if not exists geboortedatum date;
alter table public.reizigers add column if not exists geslacht text;
alter table public.reizigers add column if not exists traveller_status_id uuid;
alter table public.reizigers add column if not exists voornaam text;
alter table public.reizigers add column if not exists achternaam text;
alter table public.reizigers add column if not exists uitgesloten_van_communicatie boolean;
alter table public.reizigers add column if not exists stad text;
alter table public.reizigers add column if not exists provincie text;
alter table public.reizigers add column if not exists land text;
alter table public.reizigers add column if not exists school text;
alter table public.reizigers add column if not exists incasso_status text;
alter table public.reizigers add column if not exists collections text;
alter table public.reizigers add column if not exists transport_status text;

do $$ begin
  alter table public.reizigers alter column boeking_id set not null;
exception when others then null; end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'fk_reizigers_boeking_id_cascade') then
    alter table public.reizigers add constraint fk_reizigers_boeking_id_cascade
      foreign key (boeking_id) references public.boekingen(id) on delete cascade;
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'reizigers_traveller_status_id_fkey') then
    alter table public.reizigers add constraint reizigers_traveller_status_id_fkey
      foreign key (traveller_status_id) references public.statussen(id);
  end if;
end $$;

create index if not exists idx_reizigers_locatie on public.reizigers (land, provincie, stad);

-- ----- boeking_accommodaties
create table if not exists public.boeking_accommodaties (
  id uuid primary key default gen_random_uuid()
);
alter table public.boeking_accommodaties add column if not exists boeking_id uuid;
alter table public.boeking_accommodaties add column if not exists accommodatie_status_id uuid;
alter table public.boeking_accommodaties add column if not exists maaltijdtype text;
alter table public.boeking_accommodaties add column if not exists kamer text;
alter table public.boeking_accommodaties add column if not exists kamer_prijs numeric(12,2);
alter table public.boeking_accommodaties add column if not exists aangemaakt_op timestamptz not null default now();

do $$ begin
  alter table public.boeking_accommodaties alter column boeking_id set not null;
exception when others then null; end $$;
do $$ begin
  alter table public.boeking_accommodaties alter column aangemaakt_op set not null;
exception when others then null; end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'boeking_accommodaties_accommodatie_status_id_fkey') then
    alter table public.boeking_accommodaties add constraint boeking_accommodaties_accommodatie_status_id_fkey
      foreign key (accommodatie_status_id) references public.statussen(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'fk_boeking_accommodaties_boeking_id_cascade') then
    alter table public.boeking_accommodaties add constraint fk_boeking_accommodaties_boeking_id_cascade
      foreign key (boeking_id) references public.boekingen(id) on delete cascade;
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'boeking_accommodaties_boeking_id_key') then
    alter table public.boeking_accommodaties add constraint boeking_accommodaties_boeking_id_key unique (boeking_id);
  end if;
end $$;

-- ----- boeking_addons
create table if not exists public.boeking_addons (
  id uuid primary key default gen_random_uuid()
);
alter table public.boeking_addons add column if not exists boeking_id uuid;
alter table public.boeking_addons add column if not exists addon_id uuid;
alter table public.boeking_addons add column if not exists prijs numeric(12,2);
alter table public.boeking_addons add column if not exists vertrekdatum date;
alter table public.boeking_addons add column if not exists terugkeerdatum date;
alter table public.boeking_addons add column if not exists geboekt_in_online_account boolean;
alter table public.boeking_addons add column if not exists boeking_status_id uuid;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'boeking_addons_addon_id_fkey') then
    alter table public.boeking_addons add constraint boeking_addons_addon_id_fkey
      foreign key (addon_id) references public.addons(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'boeking_addons_boeking_status_id_fkey') then
    alter table public.boeking_addons add constraint boeking_addons_boeking_status_id_fkey
      foreign key (boeking_status_id) references public.statussen(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'fk_boeking_addons_boeking_id_cascade') then
    alter table public.boeking_addons add constraint fk_boeking_addons_boeking_id_cascade
      foreign key (boeking_id) references public.boekingen(id) on delete cascade;
  end if;
end $$;

-- ----- boeking_bus_gegevens
create table if not exists public.boeking_bus_gegevens (
  id uuid primary key default gen_random_uuid()
);
alter table public.boeking_bus_gegevens add column if not exists boeking_id uuid;
alter table public.boeking_bus_gegevens add column if not exists opstapplaats_bus text;
alter table public.boeking_bus_gegevens add column if not exists vertrek_bus text;
alter table public.boeking_bus_gegevens add column if not exists retour_bus text;
alter table public.boeking_bus_gegevens add column if not exists aangemaakt_op timestamptz not null default now();

do $$ begin
  alter table public.boeking_bus_gegevens alter column boeking_id set not null;
exception when others then null; end $$;
do $$ begin
  alter table public.boeking_bus_gegevens alter column aangemaakt_op set not null;
exception when others then null; end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'fk_boeking_bus_gegevens_boeking_id_cascade') then
    alter table public.boeking_bus_gegevens add constraint fk_boeking_bus_gegevens_boeking_id_cascade
      foreign key (boeking_id) references public.boekingen(id) on delete cascade;
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'uq_boeking_bus_gegevens_boeking_id') then
    alter table public.boeking_bus_gegevens add constraint uq_boeking_bus_gegevens_boeking_id unique (boeking_id);
  end if;
end $$;

-- ----- boeking_excursies
create table if not exists public.boeking_excursies (
  id uuid primary key default gen_random_uuid()
);
alter table public.boeking_excursies add column if not exists boeking_id uuid;
alter table public.boeking_excursies add column if not exists excursie_id uuid;
alter table public.boeking_excursies add column if not exists vertrekdatum date;
alter table public.boeking_excursies add column if not exists terugkeerdatum date;
alter table public.boeking_excursies add column if not exists betaling_pending boolean;
alter table public.boeking_excursies add column if not exists boeking_status_id uuid;
alter table public.boeking_excursies add column if not exists commentaar text;
alter table public.boeking_excursies add column if not exists betaaloptie text;
alter table public.boeking_excursies add column if not exists mollie_betaling_id text;
alter table public.boeking_excursies add column if not exists geboekt_in_online_account boolean;
alter table public.boeking_excursies add column if not exists datum_toegevoegd timestamptz;
alter table public.boeking_excursies add column if not exists verkoopprijs numeric(12,2) not null default 0;
alter table public.boeking_excursies add column if not exists is_gratis boolean not null default false;
alter table public.boeking_excursies add column if not exists upload_id uuid;
alter table public.boeking_excursies add column if not exists bron_rij_hash text;
alter table public.boeking_excursies add column if not exists ingevoerd_via text;
alter table public.boeking_excursies add column if not exists reiziger_id uuid;
alter table public.boeking_excursies add column if not exists reiziger_status_id uuid;
alter table public.boeking_excursies add column if not exists voornaam text;
alter table public.boeking_excursies add column if not exists achternaam text;
alter table public.boeking_excursies add column if not exists traveller_email text;
alter table public.boeking_excursies add column if not exists bestemming_naam text;

do $$ begin
  alter table public.boeking_excursies alter column verkoopprijs set not null;
exception when others then null; end $$;
do $$ begin
  alter table public.boeking_excursies alter column is_gratis set not null;
exception when others then null; end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'chk_boeking_excursies_verkoopprijs_non_negative') then
    alter table public.boeking_excursies add constraint chk_boeking_excursies_verkoopprijs_non_negative
      check (verkoopprijs >= 0::numeric);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'fk_boeking_excursies_boeking_id_cascade') then
    alter table public.boeking_excursies add constraint fk_boeking_excursies_boeking_id_cascade
      foreign key (boeking_id) references public.boekingen(id) on delete cascade;
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'boeking_excursies_excursie_id_fkey') then
    alter table public.boeking_excursies add constraint boeking_excursies_excursie_id_fkey
      foreign key (excursie_id) references public.excursies(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'boeking_excursies_boeking_status_id_fkey') then
    alter table public.boeking_excursies add constraint boeking_excursies_boeking_status_id_fkey
      foreign key (boeking_status_id) references public.statussen(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'boeking_excursies_reiziger_id_fkey') then
    alter table public.boeking_excursies add constraint boeking_excursies_reiziger_id_fkey
      foreign key (reiziger_id) references public.reizigers(id) on delete set null;
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'boeking_excursies_reiziger_status_id_fkey') then
    alter table public.boeking_excursies add constraint boeking_excursies_reiziger_status_id_fkey
      foreign key (reiziger_status_id) references public.statussen(id) on delete set null;
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'boeking_excursies_upload_id_fkey') then
    alter table public.boeking_excursies add constraint boeking_excursies_upload_id_fkey
      foreign key (upload_id) references public.uploads(id) on delete set null;
  end if;
end $$;

create index if not exists ix_boeking_excursies_reiziger_id on public.boeking_excursies (reiziger_id);
create index if not exists ix_boeking_excursies_bron_rij_hash on public.boeking_excursies (bron_rij_hash);

-- ----- boeking_financien (live booking-level columns only)
create table if not exists public.boeking_financien (
  id uuid primary key default gen_random_uuid()
);
alter table public.boeking_financien add column if not exists boeking_id uuid;
alter table public.boeking_financien add column if not exists schoonmaakkosten_te_betalen numeric(12,2);
alter table public.boeking_financien add column if not exists waarborg_te_betalen numeric(12,2);
alter table public.boeking_financien add column if not exists waarborg_betaald numeric(12,2);
alter table public.boeking_financien add column if not exists waarborg_methode text;
alter table public.boeking_financien add column if not exists voorschot_percentage numeric(7,2);
alter table public.boeking_financien add column if not exists voorschot numeric(12,2);
alter table public.boeking_financien add column if not exists gebruikte_kortingscode text;
alter table public.boeking_financien add column if not exists factuur_verzonden_op date;
alter table public.boeking_financien add column if not exists aangemaakt_op timestamptz not null default now();
alter table public.boeking_financien add column if not exists excursions_totaal_excel numeric(12,2);
alter table public.boeking_financien add column if not exists discount_amount numeric(12,2);

do $$ begin
  alter table public.boeking_financien alter column boeking_id set not null;
exception when others then null; end $$;
do $$ begin
  alter table public.boeking_financien alter column aangemaakt_op set not null;
exception when others then null; end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'fk_boeking_financien_boeking_id_cascade') then
    alter table public.boeking_financien add constraint fk_boeking_financien_boeking_id_cascade
      foreign key (boeking_id) references public.boekingen(id) on delete cascade;
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'boeking_financien_boeking_id_key') then
    alter table public.boeking_financien add constraint boeking_financien_boeking_id_key unique (boeking_id);
  end if;
end $$;

create index if not exists idx_boeking_financien_factuur_verzonden_op on public.boeking_financien (factuur_verzonden_op);

-- ----- boeking_vluchten
create table if not exists public.boeking_vluchten (
  id uuid primary key default gen_random_uuid()
);
alter table public.boeking_vluchten add column if not exists boeking_id uuid;
alter table public.boeking_vluchten add column if not exists richting text;
alter table public.boeking_vluchten add column if not exists vluchtnummer text;
alter table public.boeking_vluchten add column if not exists maatschappij text;
alter table public.boeking_vluchten add column if not exists vertrek_tijd timestamptz;
alter table public.boeking_vluchten add column if not exists aankomst_tijd timestamptz;
alter table public.boeking_vluchten add column if not exists vertrek_luchthaven text;
alter table public.boeking_vluchten add column if not exists aankomst_luchthaven text;
alter table public.boeking_vluchten add column if not exists transfer_type text;
alter table public.boeking_vluchten add column if not exists transfer_prijs numeric(12,2);
alter table public.boeking_vluchten add column if not exists bagage_prijs numeric(12,2);
alter table public.boeking_vluchten add column if not exists aangemaakt_op timestamptz not null default now();

do $$ begin
  alter table public.boeking_vluchten alter column boeking_id set not null;
exception when others then null; end $$;
do $$ begin
  alter table public.boeking_vluchten alter column aangemaakt_op set not null;
exception when others then null; end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'fk_boeking_vluchten_boeking_id_cascade') then
    alter table public.boeking_vluchten add constraint fk_boeking_vluchten_boeking_id_cascade
      foreign key (boeking_id) references public.boekingen(id) on delete cascade;
  end if;
end $$;

create unique index if not exists uq_boeking_vluchten_boeking_richting_nummer
  on public.boeking_vluchten (boeking_id, richting, vluchtnummer)
  where vluchtnummer is not null;

create index if not exists idx_boeking_vluchten_boeking_id on public.boeking_vluchten (boeking_id);

-- ----- reiziger_financien
create table if not exists public.reiziger_financien (
  id uuid primary key default gen_random_uuid()
);
alter table public.reiziger_financien add column if not exists reiziger_id uuid;
alter table public.reiziger_financien add column if not exists prijs_annulatieverzekering numeric(12,2);
alter table public.reiziger_financien add column if not exists prijs_reisverzekering numeric(12,2);
alter table public.reiziger_financien add column if not exists prijs_annulatie_en_reisverzekering numeric(12,2);
alter table public.reiziger_financien add column if not exists heeft_annulatieverzekering boolean;
alter table public.reiziger_financien add column if not exists heeft_reisverzekering boolean;
alter table public.reiziger_financien add column if not exists heeft_annulatie_en_reisverzekering boolean;
alter table public.reiziger_financien add column if not exists aangemaakt_op timestamptz not null default now();
alter table public.reiziger_financien add column if not exists totaal_te_betalen numeric(12,2);
alter table public.reiziger_financien add column if not exists reeds_betaald numeric(12,2);
alter table public.reiziger_financien add column if not exists nog_te_betalen numeric(12,2);
alter table public.reiziger_financien add column if not exists package_prijs numeric(12,2);
alter table public.reiziger_financien add column if not exists transfer_prijs numeric(12,2);
alter table public.reiziger_financien add column if not exists bagage_prijs numeric(12,2);
alter table public.reiziger_financien add column if not exists vlucht_heen_prijs numeric(12,2);
alter table public.reiziger_financien add column if not exists vlucht_terug_prijs numeric(12,2);
alter table public.reiziger_financien add column if not exists toeristenbelasting_te_betalen numeric(12,2);
alter table public.reiziger_financien add column if not exists kost_accommodatie numeric(12,2);
alter table public.reiziger_financien add column if not exists kost_transport numeric(12,2);
alter table public.reiziger_financien add column if not exists kost_transfer numeric(12,2);
alter table public.reiziger_financien add column if not exists kost_extra_kosten numeric(12,2);
alter table public.reiziger_financien add column if not exists aantal_voorschotbetalingsherinneringen integer not null default 0;
alter table public.reiziger_financien add column if not exists aantal_totaalbetalingsherinneringen integer not null default 0;
alter table public.reiziger_financien add column if not exists discount_amount numeric default 0;
alter table public.reiziger_financien add column if not exists discount_code_used text;

do $$ begin
  alter table public.reiziger_financien alter column reiziger_id set not null;
exception when others then null; end $$;
do $$ begin
  alter table public.reiziger_financien alter column aangemaakt_op set not null;
exception when others then null; end $$;
do $$ begin
  alter table public.reiziger_financien alter column aantal_voorschotbetalingsherinneringen set not null;
exception when others then null; end $$;
do $$ begin
  alter table public.reiziger_financien alter column aantal_totaalbetalingsherinneringen set not null;
exception when others then null; end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'fk_reiziger_financien_reiziger_id_cascade') then
    alter table public.reiziger_financien add constraint fk_reiziger_financien_reiziger_id_cascade
      foreign key (reiziger_id) references public.reizigers(id) on delete cascade;
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'reiziger_financien_reiziger_id_key') then
    alter table public.reiziger_financien add constraint reiziger_financien_reiziger_id_key unique (reiziger_id);
  end if;
end $$;

-- ----- excursie_jaarkosten
create table if not exists public.excursie_jaarkosten (
  id uuid primary key default gen_random_uuid()
);
alter table public.excursie_jaarkosten add column if not exists excursie_id uuid;
alter table public.excursie_jaarkosten add column if not exists jaar integer;
alter table public.excursie_jaarkosten add column if not exists inkoopprijs numeric(12,2);
alter table public.excursie_jaarkosten add column if not exists commissie numeric(12,2);
alter table public.excursie_jaarkosten add column if not exists commissie_percentage numeric(7,2);
alter table public.excursie_jaarkosten add column if not exists aangemaakt_op timestamptz not null default now();
alter table public.excursie_jaarkosten add column if not exists updated_at timestamptz not null default now();
alter table public.excursie_jaarkosten add column if not exists is_handmatig boolean not null default false;

do $$ begin
  alter table public.excursie_jaarkosten alter column excursie_id set not null;
exception when others then null; end $$;
do $$ begin
  alter table public.excursie_jaarkosten alter column jaar set not null;
exception when others then null; end $$;
do $$ begin
  alter table public.excursie_jaarkosten alter column aangemaakt_op set not null;
exception when others then null; end $$;
do $$ begin
  alter table public.excursie_jaarkosten alter column updated_at set not null;
exception when others then null; end $$;
do $$ begin
  alter table public.excursie_jaarkosten alter column is_handmatig set not null;
exception when others then null; end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'excursie_jaarkosten_excursie_id_fkey') then
    alter table public.excursie_jaarkosten add constraint excursie_jaarkosten_excursie_id_fkey
      foreign key (excursie_id) references public.excursies(id) on delete cascade;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'excursie_jaarkosten_commissie_check') then
    alter table public.excursie_jaarkosten add constraint excursie_jaarkosten_commissie_check
      check (commissie is null or commissie >= 0::numeric);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'excursie_jaarkosten_commissie_percentage_check') then
    alter table public.excursie_jaarkosten add constraint excursie_jaarkosten_commissie_percentage_check
      check (
        commissie_percentage is null
        or (commissie_percentage >= 0::numeric and commissie_percentage <= 100::numeric)
      );
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'excursie_jaarkosten_inkoopprijs_check') then
    alter table public.excursie_jaarkosten add constraint excursie_jaarkosten_inkoopprijs_check
      check (inkoopprijs is null or inkoopprijs >= 0::numeric);
  end if;
end $$;

create unique index if not exists uq_excursie_jaarkosten_excursie_jaar
  on public.excursie_jaarkosten (excursie_id, jaar);

-- ----- vlucht_allotments
create table if not exists public.vlucht_allotments (
  id uuid primary key default gen_random_uuid()
);
alter table public.vlucht_allotments add column if not exists upload_id uuid;
alter table public.vlucht_allotments add column if not exists arrival date;
alter table public.vlucht_allotments add column if not exists departure date;
alter table public.vlucht_allotments add column if not exists agency text;
alter table public.vlucht_allotments add column if not exists way text;
alter table public.vlucht_allotments add column if not exists total_pax integer not null default 0;
alter table public.vlucht_allotments add column if not exists booked_pax integer not null default 0;
alter table public.vlucht_allotments add column if not exists still_free integer not null default 0;
alter table public.vlucht_allotments add column if not exists outbound_flight text;
alter table public.vlucht_allotments add column if not exists inbound_flight text;
alter table public.vlucht_allotments add column if not exists pp_outbound numeric(12,2);
alter table public.vlucht_allotments add column if not exists pp_inbound numeric(12,2);

do $$ begin
  alter table public.vlucht_allotments alter column upload_id set not null;
exception when others then null; end $$;
do $$ begin
  alter table public.vlucht_allotments alter column arrival set not null;
exception when others then null; end $$;
do $$ begin
  alter table public.vlucht_allotments alter column departure set not null;
exception when others then null; end $$;
do $$ begin
  alter table public.vlucht_allotments alter column total_pax set not null;
exception when others then null; end $$;
do $$ begin
  alter table public.vlucht_allotments alter column booked_pax set not null;
exception when others then null; end $$;
do $$ begin
  alter table public.vlucht_allotments alter column still_free set not null;
exception when others then null; end $$;
do $$ begin
  alter table public.vlucht_allotments alter column outbound_flight set not null;
exception when others then null; end $$;
do $$ begin
  alter table public.vlucht_allotments alter column inbound_flight set not null;
exception when others then null; end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'vlucht_allotments_upload_id_fkey') then
    alter table public.vlucht_allotments add constraint vlucht_allotments_upload_id_fkey
      foreign key (upload_id) references public.uploads(id) on delete cascade;
  end if;
end $$;

create unique index if not exists uq_vlucht_allotments_arrival_departure_outbound_inbound
  on public.vlucht_allotments (arrival, departure, outbound_flight, inbound_flight);

create index if not exists idx_vlucht_allotments_outbound_flight on public.vlucht_allotments (outbound_flight);
create index if not exists idx_vlucht_allotments_inbound_flight on public.vlucht_allotments (inbound_flight);
create index if not exists idx_vlucht_allotments_arrival on public.vlucht_allotments (arrival);
create index if not exists idx_vlucht_allotments_departure on public.vlucht_allotments (departure);

-- ----- reiziger_vlucht_allotments
create table if not exists public.reiziger_vlucht_allotments (
  id uuid primary key default gen_random_uuid()
);
alter table public.reiziger_vlucht_allotments add column if not exists reiziger_id uuid;
alter table public.reiziger_vlucht_allotments add column if not exists vlucht_allotment_id uuid;
alter table public.reiziger_vlucht_allotments add column if not exists richting text;
alter table public.reiziger_vlucht_allotments add column if not exists koppel_methode text not null default 'handmatig';
alter table public.reiziger_vlucht_allotments add column if not exists koppel_betrouwbaarheid numeric;
alter table public.reiziger_vlucht_allotments add column if not exists aangemaakt_op timestamptz not null default now();

do $$ begin
  alter table public.reiziger_vlucht_allotments alter column reiziger_id set not null;
exception when others then null; end $$;
do $$ begin
  alter table public.reiziger_vlucht_allotments alter column vlucht_allotment_id set not null;
exception when others then null; end $$;
do $$ begin
  alter table public.reiziger_vlucht_allotments alter column richting set not null;
exception when others then null; end $$;
do $$ begin
  alter table public.reiziger_vlucht_allotments alter column koppel_methode set not null;
exception when others then null; end $$;
do $$ begin
  alter table public.reiziger_vlucht_allotments alter column aangemaakt_op set not null;
exception when others then null; end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'reiziger_vlucht_allotments_richting_check') then
    alter table public.reiziger_vlucht_allotments add constraint reiziger_vlucht_allotments_richting_check
      check (richting = any (array['heen'::text, 'terug'::text]));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'reiziger_vlucht_allotments_reiziger_id_fkey') then
    alter table public.reiziger_vlucht_allotments add constraint reiziger_vlucht_allotments_reiziger_id_fkey
      foreign key (reiziger_id) references public.reizigers(id) on delete cascade;
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'reiziger_vlucht_allotments_vlucht_allotment_id_fkey') then
    alter table public.reiziger_vlucht_allotments add constraint reiziger_vlucht_allotments_vlucht_allotment_id_fkey
      foreign key (vlucht_allotment_id) references public.vlucht_allotments(id) on delete cascade;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'reiziger_vlucht_allotments_reiziger_id_vlucht_allotment_id__key') then
    alter table public.reiziger_vlucht_allotments
      add constraint reiziger_vlucht_allotments_reiziger_id_vlucht_allotment_id__key
      unique (reiziger_id, vlucht_allotment_id, richting);
  end if;
end $$;

create index if not exists idx_reiziger_vlucht_allotments_reiziger on public.reiziger_vlucht_allotments (reiziger_id);
create index if not exists idx_reiziger_vlucht_allotments_allotment on public.reiziger_vlucht_allotments (vlucht_allotment_id);

commit;
