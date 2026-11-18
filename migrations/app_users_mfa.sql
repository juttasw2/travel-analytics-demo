-- Voeg TOTP MFA toe voor app_users (Microsoft/Google Authenticator).
-- Voer uit na app_users_auth.sql of app_users_access_registration.sql.

alter table public.app_users
    add column if not exists mfa_enabled boolean not null default false;

alter table public.app_users
    add column if not exists mfa_secret text;

drop function if exists public.authenticate_app_user(text, text);

create function public.authenticate_app_user(
    p_email text,
    p_password text
)
returns table (
    id uuid,
    email text,
    has_access boolean,
    role text,
    display_name text,
    mfa_enabled boolean,
    mfa_secret text
)
language sql
security definer
set search_path = public
as $$
    select
        u.id,
        u.email,
        u.has_access,
        coalesce(nullif(trim(u.role), ''), 'VERSIE_B') as role,
        u.display_name,
        coalesce(u.mfa_enabled, false) as mfa_enabled,
        u.mfa_secret
    from public.app_users u
    where lower(trim(u.email)) = lower(trim(p_email))
      and u.password_hash = crypt(p_password, u.password_hash)
    limit 1;
$$;

create or replace function public.set_app_user_mfa(
    p_user_id uuid,
    p_mfa_secret text,
    p_enabled boolean default true
)
returns table (
    updated boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
    cleaned_secret text;
begin
    cleaned_secret := trim(coalesce(p_mfa_secret, ''));
    if p_enabled and cleaned_secret = '' then
        return query select false;
        return;
    end if;

    update public.app_users
    set
        mfa_enabled = coalesce(p_enabled, false),
        mfa_secret = case when coalesce(p_enabled, false) then cleaned_secret else null end
    where id = p_user_id;

    return query select found;
end;
$$;

-- CLOUD SQL: grant execute on function public.authenticate_app_user(text, text) to anon, authenticated, service_role;
-- CLOUD SQL: grant execute on function public.set_app_user_mfa(uuid, text, boolean) to anon, authenticated, service_role;
