-- Bootstrap: define excursies_booking_status_is_cancelled before dashboard_booking_filters.sql
-- (breaks circular dependency between excursies_rpc.sql and dashboard_booking_filters.sql)

create or replace function public.excursies_booking_status_is_cancelled(p_naam text)
returns boolean
language sql
stable
as $$
  select
    case
      when p_naam is null then false
      when btrim(p_naam) = '' then false
      else lower(btrim(p_naam)) in (
        'cancelled',
        'canceled',
        'cancel',
        'geannuleerd',
        'gecanceld',
        'annulatie',
        'annulering',
        'annule',
        'annulé',
        'dropped'
      )
    end;
$$;
