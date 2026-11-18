-- Account management: admin maakt nieuwe gebruikers aan + iedere gebruiker kan eigen wachtwoord wijzigen.
-- Voer deze migratie uit ná `app_users_auth.sql` en `app_users_mfa.sql`.
-- Idempotent: gebruikt CREATE OR REPLACE en ADD COLUMN IF NOT EXISTS.

create extension if not exists pgcrypto;

-- Verwijder de oude publieke registratie-RPC. De applicatie roept hem niet meer
-- aan; door hem te droppen sluiten we ook het pad af waarbij een (anonieme)
-- PostgREST/REST-client deze functie nog rechtstreeks zou kunnen aanroepen.
drop function if exists public.register_app_user(text, text, text);

-- Zorg dat role-kolom bestaat met geldige waarden ('VERSIE_A' of 'VERSIE_B').
alter table public.app_users
    add column if not exists role text not null default 'VERSIE_B';

do $$
begin
    if not exists (
        select 1
        from pg_constraint
        where conname = 'app_users_role_check'
    ) then
        alter table public.app_users
            add constraint app_users_role_check
            check (role in ('VERSIE_A', 'VERSIE_B'));
    end if;
end$$;

-- ----------------------------------------------------------------------------
-- admin_create_app_user
--   Wordt aangeroepen vanuit de applicatie nadat de Python laag heeft
--   gecontroleerd dat de huidige sessie role = 'VERSIE_A' heeft. De RPC zelf
--   doet GEEN sessiecontrole (SECURITY DEFINER en geen ingebouwde Postgres
--   sessie); de aanroepende laag is verantwoordelijk voor authorisatie.
-- ----------------------------------------------------------------------------
create or replace function public.admin_create_app_user(
    p_display_name text,
    p_email text,
    p_password text,
    p_role text
)
returns table (
    user_id uuid,
    error_code text
)
language plpgsql
security definer
set search_path = public
as $$
declare
    nid uuid;
    cleaned_email text;
    cleaned_name text;
    cleaned_role text;
begin
    cleaned_email := lower(trim(coalesce(p_email, '')));
    cleaned_name := trim(coalesce(p_display_name, ''));
    cleaned_role := upper(trim(coalesce(p_role, '')));

    if length(cleaned_name) < 1 or length(cleaned_name) > 200 then
        return query select null::uuid, 'invalid_name'::text;
        return;
    end if;

    if cleaned_email !~ '^[^@\s]+@[^@\s]+\.[^@]+$' then
        return query select null::uuid, 'invalid_email'::text;
        return;
    end if;

    if p_password is null or length(p_password) < 8 then
        return query select null::uuid, 'weak_password'::text;
        return;
    end if;

    if length(p_password) > 512 then
        return query select null::uuid, 'password_too_long'::text;
        return;
    end if;

    if cleaned_role not in ('VERSIE_A', 'VERSIE_B') then
        return query select null::uuid, 'invalid_role'::text;
        return;
    end if;

    begin
        insert into public.app_users (
            email,
            password_hash,
            display_name,
            has_access,
            mfa_enabled,
            role
        )
        values (
            cleaned_email,
            crypt(p_password, gen_salt('bf')),
            cleaned_name,
            true,
            false,
            cleaned_role
        )
        returning app_users.id into nid;

        return query select nid, null::text;
    exception
        when unique_violation then
            return query select null::uuid, 'email_exists'::text;
    end;
end;
$$;

-- ----------------------------------------------------------------------------
-- change_app_user_password
--   Verifieert het huidige wachtwoord van de doelgebruiker en update naar een
--   nieuwe bcrypt hash. Wordt aangeroepen voor de ingelogde gebruiker zelf.
--   De Python laag levert het user_id van de huidige sessie (geen self-service
--   reset op basis van email).
-- ----------------------------------------------------------------------------
create or replace function public.change_app_user_password(
    p_user_id uuid,
    p_current_password text,
    p_new_password text
)
returns table (
    updated boolean,
    error_code text
)
language plpgsql
security definer
set search_path = public
as $$
declare
    matched_id uuid;
begin
    if p_user_id is null then
        return query select false, 'invalid_user'::text;
        return;
    end if;

    if p_new_password is null or length(p_new_password) < 8 then
        return query select false, 'weak_password'::text;
        return;
    end if;

    if length(p_new_password) > 512 then
        return query select false, 'password_too_long'::text;
        return;
    end if;

    select u.id
        into matched_id
    from public.app_users u
    where u.id = p_user_id
      and u.password_hash = crypt(coalesce(p_current_password, ''), u.password_hash)
    limit 1;

    if matched_id is null then
        return query select false, 'wrong_password'::text;
        return;
    end if;

    update public.app_users
       set password_hash = crypt(p_new_password, gen_salt('bf'))
     where id = matched_id;

    return query select true, null::text;
end;
$$;

-- CLOUD SQL: grant execute on function public.admin_create_app_user(text, text, text, text) to anon, authenticated, service_role;
-- CLOUD SQL: grant execute on function public.change_app_user_password(uuid, text, text) to anon, authenticated, service_role;
