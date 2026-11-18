-- Login tabel + authenticatie- en registratie-RPC's (nieuwe installaties).
-- Safe to run multiple times waar onderstaande objecten CREATE IF / OR REPLACE gebruiken.
-- Heeft u al een oudere `app_users` zonder kolommen? Voer daarnaast
-- `app_users_access_registration.sql` uit (additief).

create extension if not exists pgcrypto;

create table if not exists public.app_users (
    id uuid primary key default gen_random_uuid(),
    email text not null,
    password_hash text not null,
    display_name text,
    has_access boolean not null default false,
    created_at timestamptz not null default now(),
    constraint app_users_email_not_blank check (length(trim(email)) > 0),
    constraint app_users_display_name_len check (display_name is null or (length(trim(display_name)) between 1 and 200))
);

create unique index if not exists app_users_email_lower_idx
    on public.app_users ((lower(trim(email))));

drop function if exists public.authenticate_app_user(text, text);
create or replace function public.authenticate_app_user(
    p_email text,
    p_password text
)
returns table (
    id uuid,
    email text,
    has_access boolean,
    display_name text
)
language sql
security definer
set search_path = public
as $$
    select u.id, u.email, u.has_access, u.display_name
    from public.app_users u
    where lower(trim(u.email)) = lower(trim(p_email))
      and u.password_hash = crypt(p_password, u.password_hash)
    limit 1;
$$;

create or replace function public.register_app_user(
    p_display_name text,
    p_email text,
    p_password text
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
begin
    cleaned_email := lower(trim(coalesce(p_email, '')));
    cleaned_name := trim(coalesce(p_display_name, ''));

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

    begin
        insert into public.app_users (email, password_hash, display_name, has_access)
        values (
            cleaned_email,
            crypt(p_password, gen_salt('bf')),
            cleaned_name,
            false
        )
        returning app_users.id into nid;

        return query select nid, null::text;
    exception
        when unique_violation then
            return query select null::uuid, 'email_exists'::text;
    end;
end;
$$;

-- CLOUD SQL: grant execute on function public.authenticate_app_user(text, text) to anon, authenticated, service_role;
-- CLOUD SQL: grant execute on function public.register_app_user(text, text, text) to anon, authenticated, service_role;
