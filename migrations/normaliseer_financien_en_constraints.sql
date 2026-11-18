-- Productiemigratie: financiën opsplitsen + constraints normaliseren
-- Volledig Nederlandstalig (namen, constraints, indexen, comments).

begin;

-- 1) Boekingsniveau financiën
create table if not exists public.boeking_financien (
    id uuid primary key default gen_random_uuid(),
    boeking_id uuid not null unique,
    toeristenbelasting_te_betalen numeric(12,2),
    schoonmaakkosten_te_betalen numeric(12,2),
    waarborg_te_betalen numeric(12,2),
    waarborg_betaald numeric(12,2),
    waarborg_methode text,
    kost_accommodatie numeric(12,2),
    kost_transport numeric(12,2),
    kost_transfer numeric(12,2),
    kost_extra_kosten numeric(12,2),
    voorschot_percentage numeric(7,2),
    voorschot numeric(12,2),
    aantal_voorschotbetalingsherinneringen integer,
    aantal_totaalbetalingsherinneringen integer,
    gebruikte_kortingscode text,
    factuur_verzonden_op date,
    aangemaakt_op timestamptz not null default now()
);

comment on table public.boeking_financien is 'Financiële gegevens op boekingsniveau.';
create index if not exists idx_boeking_financien_factuur_verzonden_op on public.boeking_financien(factuur_verzonden_op);

-- 2) Reizigersniveau financiën (verzekeringen)
create table if not exists public.reiziger_financien (
    id uuid primary key default gen_random_uuid(),
    reiziger_id uuid not null unique,
    totaal_te_betalen numeric(12,2),
    reeds_betaald numeric(12,2),
    nog_te_betalen numeric(12,2),
    package_prijs numeric(12,2),
    transfer_prijs numeric(12,2),
    bagage_prijs numeric(12,2),
    vlucht_heen_prijs numeric(12,2),
    vlucht_terug_prijs numeric(12,2),
    prijs_annulatieverzekering numeric(12,2),
    prijs_reisverzekering numeric(12,2),
    prijs_annulatie_en_reisverzekering numeric(12,2),
    heeft_annulatieverzekering boolean,
    heeft_reisverzekering boolean,
    heeft_annulatie_en_reisverzekering boolean,
    aangemaakt_op timestamptz not null default now()
);

comment on table public.reiziger_financien is 'Financiële reiziger-specifieke gegevens (bedragen + verzekeringen).';

-- 3) FK's met duidelijke ON DELETE-strategie
do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conname = 'fk_boeking_financien_boeking_id_cascade'
    ) then
        alter table public.boeking_financien
            add constraint fk_boeking_financien_boeking_id_cascade
            foreign key (boeking_id) references public.boekingen(id) on delete cascade;
    end if;

    if not exists (
        select 1 from pg_constraint
        where conname = 'fk_reiziger_financien_reiziger_id_cascade'
    ) then
        alter table public.reiziger_financien
            add constraint fk_reiziger_financien_reiziger_id_cascade
            foreign key (reiziger_id) references public.reizigers(id) on delete cascade;
    end if;
end $$;

-- 4) Data-overzet bestaande model(len) -> nieuwe tabel
-- 4a) uit public.financien (indien aanwezig)
do $$
begin
    if to_regclass('public.financien') is not null then
        insert into public.boeking_financien (
            boeking_id,
            toeristenbelasting_te_betalen, schoonmaakkosten_te_betalen,
            waarborg_te_betalen, waarborg_betaald, waarborg_methode,
            kost_accommodatie, kost_transport, kost_transfer, kost_extra_kosten,
            voorschot_percentage, voorschot,
            aantal_voorschotbetalingsherinneringen, aantal_totaalbetalingsherinneringen,
            gebruikte_kortingscode, factuur_verzonden_op
        )
        select
            f.boeking_id,
            f.toeristenbelasting_te_betalen, f.schoonmaakkosten_te_betalen,
            f.waarborg_te_betalen, f.waarborg_betaald, f.waarborg_methode,
            f.kost_accommodatie, f.kost_transport, f.kost_transfer, f.kost_extra_kosten,
            f.voorschot_percentage, f.voorschot,
            f.aantal_voorschotbetalingsherinneringen, f.aantal_totaalbetalingsherinneringen,
            f.gebruikte_kortingscode, f.factuur_verzonden_op
        from public.financien f
        on conflict (boeking_id) do update set
            toeristenbelasting_te_betalen = excluded.toeristenbelasting_te_betalen,
            schoonmaakkosten_te_betalen = excluded.schoonmaakkosten_te_betalen,
            waarborg_te_betalen = excluded.waarborg_te_betalen,
            waarborg_betaald = excluded.waarborg_betaald,
            waarborg_methode = excluded.waarborg_methode,
            kost_accommodatie = excluded.kost_accommodatie,
            kost_transport = excluded.kost_transport,
            kost_transfer = excluded.kost_transfer,
            kost_extra_kosten = excluded.kost_extra_kosten,
            voorschot_percentage = excluded.voorschot_percentage,
            voorschot = excluded.voorschot,
            aantal_voorschotbetalingsherinneringen = excluded.aantal_voorschotbetalingsherinneringen,
            aantal_totaalbetalingsherinneringen = excluded.aantal_totaalbetalingsherinneringen,
            gebruikte_kortingscode = excluded.gebruikte_kortingscode,
            factuur_verzonden_op = excluded.factuur_verzonden_op;
    end if;
end $$;

-- 4b) verzekeringsvelden uit vroegere financien -> reiziger_financien (best effort verdeling)
-- Indien er geen per-reiziger bron bestaat, blijven velden null en worden later door import gevuld.

-- 5) Reizigers moeten altijd aan boeking hangen
do $$
declare
    v_wees_count bigint;
begin
    select count(*) into v_wees_count
    from public.reizigers
    where boeking_id is null;

    if v_wees_count > 0 then
        raise exception
            'Migratie gestopt: % reizigers zonder boeking_id. Los eerst op en run opnieuw.',
            v_wees_count;
    end if;
end $$;

alter table public.reizigers
    alter column boeking_id set not null;

-- FK reizigers -> boekingen expliciet op cascade
do $$
declare
    fk_name text;
begin
    select conname into fk_name
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'reizigers'
      and c.contype = 'f'
      and pg_get_constraintdef(c.oid) ilike '%(boeking_id)%boekingen%';

    if fk_name is not null then
        execute format('alter table public.reizigers drop constraint %I', fk_name);
    end if;

    if not exists (
        select 1 from pg_constraint where conname = 'fk_reizigers_boeking_id_cascade'
    ) then
        alter table public.reizigers
            add constraint fk_reizigers_boeking_id_cascade
            foreign key (boeking_id) references public.boekingen(id) on delete cascade;
    end if;
end $$;

-- 6) Cascade voor relationele kindtabellen boeking_addons/boeking_excursies/boeking_accommodaties
do $$
declare
    r record;
begin
    for r in
        select
            t.relname as tabelnaam,
            c.conname as fk_naam
        from pg_constraint c
        join pg_class t on t.oid = c.conrelid
        join pg_namespace n on n.oid = t.relnamespace
        where n.nspname = 'public'
          and t.relname in ('boeking_addons', 'boeking_excursies', 'boeking_accommodaties')
          and c.contype = 'f'
          and pg_get_constraintdef(c.oid) ilike '%(boeking_id)%boekingen%'
    loop
        execute format('alter table public.%I drop constraint %I', r.tabelnaam, r.fk_naam);
        execute format(
            'alter table public.%I add constraint fk_%I_boeking_id_cascade foreign key (boeking_id) references public.boekingen(id) on delete cascade',
            r.tabelnaam,
            r.tabelnaam
        );
    end loop;
end $$;

-- 7) Statussen normaliseren: typewaarden in Nederlands + unieke combinatie (type, naam)
update public.statussen
set type = case lower(trim(type))
    when 'booking' then 'boeking'
    when 'payment' then 'betaling'
    when 'traveller' then 'reiziger'
    when 'traveler' then 'reiziger'
    when 'acco' then 'accommodatie'
    when 'accommodation' then 'accommodatie'
    else lower(trim(type))
end;

-- (view already dropped by pre-migration cleanup if needed)

alter table public.statussen
    alter column type type text using lower(trim(type)),
    alter column naam type text using trim(naam);

-- Dubbele type+naam voorkomen
do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conname = 'uq_statussen_type_naam'
    ) then
        alter table public.statussen
            add constraint uq_statussen_type_naam unique (type, naam);
    end if;
end $$;

-- Alleen toegelaten NL types
do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conname = 'chk_statussen_type_toegelaten_nl'
    ) then
        alter table public.statussen
            add constraint chk_statussen_type_toegelaten_nl
            check (type in ('boeking', 'betaling', 'reiziger', 'accommodatie', 'excursie', 'addon', 'transport'));
    end if;
end $$;

-- 8) Oude tabel public.financien opruimen (na succesvolle migratie)
drop table if exists public.financien;

commit;
