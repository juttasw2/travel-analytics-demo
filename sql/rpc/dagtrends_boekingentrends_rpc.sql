-- Boekingsgedrag /boekingentrends-data: aggregaties in Postgres i.p.v. tienduizenden rijen naar Flask.
-- Deploy in Supabase SQL editor.

CREATE OR REPLACE FUNCTION public.dagtrends_norm_land(raw text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN raw IS NULL OR btrim(raw) = '' THEN NULL
    WHEN lower(btrim(raw)) IN (
      'be', 'belgium', 'belgie', 'belgië', 'belgïe'
    ) THEN 'BE'
    WHEN lower(btrim(raw)) IN (
      'nl', 'nederland', 'netherlands', 'holland'
    ) THEN 'NL'
    WHEN lower(btrim(raw)) IN (
      'it', 'italy', 'italia', 'italië', 'italie'
    ) THEN 'IT'
    WHEN upper(btrim(raw)) IN (
      'BE', 'BELGIUM', 'BELGIE', 'BELGIË'
    ) THEN 'BE'
    WHEN upper(btrim(raw)) IN (
      'NL', 'NEDERLAND', 'NETHERLANDS'
    ) THEN 'NL'
    WHEN upper(btrim(raw)) IN (
      'IT', 'ITALY', 'ITALIA'
    ) THEN 'IT'
    ELSE NULL
  END;
$$;


CREATE OR REPLACE FUNCTION public.dagtrends_boekingentrends_aggregate(
  p_brand text,
  p_bestemming_id uuid,
  p_date_from date,
  p_date_to date,
  p_prev_from date,
  p_prev_to date,
  p_country text
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH vc AS (
    SELECT upper(coalesce(nullif(btrim(p_country), ''), '__ALL__')) AS c
  ),
  raw_cur AS (
    SELECT
      b.id,
      b.boekingsdatum::date AS bd,
      b.vertrekdatum::date AS vd,
      coalesce((
        select count(*)::bigint
        from public.reizigers r3
        left join public.statussen stx on stx.id = r3.traveller_status_id
        where r3.boeking_id = b.id
          and not public.reiziger_status_uitgesloten_standaard_dashboards(stx.naam)
      ), 0)::bigint AS pax,
      (
        SELECT r2.land
        FROM public.reizigers r2
        WHERE r2.boeking_id = b.id
          AND r2.land IS NOT NULL
          AND btrim(r2.land) <> ''
        ORDER BY r2.id
        LIMIT 1
      ) AS land_raw
    FROM public.boekingen b
    WHERE b.boekingsdatum >= p_date_from
      AND b.boekingsdatum <= p_date_to
      AND NOT public.boeking_id_excluded_from_standard_dashboards(b.id)
      AND (p_brand = '__all__' OR lower(btrim(b.brand)) = lower(btrim(p_brand)))
      AND (p_bestemming_id IS NULL OR b.bestemming_id = p_bestemming_id)
  ),
  cur AS (
    SELECT r.*
    FROM raw_cur r
    CROSS JOIN vc
    WHERE vc.c = '__ALL__' OR public.dagtrends_norm_land(r.land_raw) = vc.c
  ),
  cur_booking_series AS (
    SELECT
      r.bd AS booking_date,
      r.vd AS departure_date,
      coalesce(r.pax, 0)::bigint AS pax
    FROM cur r
    WHERE r.bd IS NOT NULL
      AND r.vd IS NOT NULL
      AND extract(year FROM r.vd)::int = extract(year FROM p_date_from)::int
    ORDER BY r.bd ASC, r.vd ASC
  ),
  daily_cur AS (
    SELECT bd AS d, count(*)::bigint AS bookings, coalesce(sum(pax), 0)::bigint AS pax
    FROM cur
    GROUP BY bd
  ),
  lead_rows AS (
    SELECT
      (r.vd - r.bd) AS lead_days,
      public.dagtrends_norm_land(r.land_raw) AS lnd
    FROM raw_cur r
    CROSS JOIN vc
    WHERE (vc.c = '__ALL__' OR public.dagtrends_norm_land(r.land_raw) = vc.c)
      AND r.vd IS NOT NULL
      AND r.bd IS NOT NULL
      AND r.vd >= r.bd
  ),
  raw_prev AS (
    SELECT
      b.boekingsdatum::date AS bd,
      coalesce((
        select count(*)::bigint
        from public.reizigers r3
        left join public.statussen stx on stx.id = r3.traveller_status_id
        where r3.boeking_id = b.id
          and not public.reiziger_status_uitgesloten_standaard_dashboards(stx.naam)
      ), 0)::bigint AS pax,
      (
        SELECT r2.land
        FROM public.reizigers r2
        WHERE r2.boeking_id = b.id
          AND r2.land IS NOT NULL
          AND btrim(r2.land) <> ''
        ORDER BY r2.id
        LIMIT 1
      ) AS land_raw
    FROM public.boekingen b
    WHERE b.boekingsdatum >= p_prev_from
      AND b.boekingsdatum <= p_prev_to
      AND NOT public.boeking_id_excluded_from_standard_dashboards(b.id)
      AND (p_brand = '__all__' OR lower(btrim(b.brand)) = lower(btrim(p_brand)))
      AND (p_bestemming_id IS NULL OR b.bestemming_id = p_bestemming_id)
  ),
  prev AS (
    SELECT p.*
    FROM raw_prev p
    CROSS JOIN vc
    WHERE vc.c = '__ALL__' OR public.dagtrends_norm_land(p.land_raw) = vc.c
  ),
  prev_booking_series AS (
    SELECT
      p.bd AS booking_date,
      coalesce(p.pax, 0)::bigint AS pax
    FROM prev p
    WHERE p.bd IS NOT NULL
    ORDER BY p.bd ASC
  ),
  daily_prev AS (
    SELECT bd AS d, count(*)::bigint AS bookings, coalesce(sum(pax), 0)::bigint AS pax
    FROM prev
    GROUP BY bd
  )
  SELECT jsonb_build_object(
    'daily_current',
    coalesce(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'd', to_char(dc.d, 'YYYY-MM-DD'),
            'bookings', dc.bookings,
            'pax', dc.pax
          )
          ORDER BY dc.d
        )
        FROM daily_cur dc
      ),
      '[]'::jsonb
    ),
    'daily_previous',
    coalesce(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'd', to_char(dp.d, 'YYYY-MM-DD'),
            'bookings', dp.bookings,
            'pax', dp.pax
          )
          ORDER BY dp.d
        )
        FROM daily_prev dp
      ),
      '[]'::jsonb
    ),
    'booking_series_current',
    coalesce(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'booking_date', to_char(s.booking_date, 'YYYY-MM-DD'),
            'departure_date', to_char(s.departure_date, 'YYYY-MM-DD'),
            'pax', s.pax
          )
          ORDER BY s.booking_date
        )
        FROM cur_booking_series s
      ),
      '[]'::jsonb
    ),
    'booking_series_previous',
    coalesce(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'booking_date', to_char(s.booking_date, 'YYYY-MM-DD'),
            'pax', s.pax
          )
          ORDER BY s.booking_date
        )
        FROM prev_booking_series s
      ),
      '[]'::jsonb
    ),
    'bookings_in_period', (SELECT count(*)::bigint FROM cur),
    'pax_in_period', (SELECT coalesce(sum(pax), 0)::bigint FROM cur),
    'bookings_prev_period', (SELECT count(*)::bigint FROM prev),
    'pax_prev_period', (SELECT coalesce(sum(pax), 0)::bigint FROM prev),
    'lead',
    (
      SELECT jsonb_build_object(
        'dist_counts',
        jsonb_build_array(
          coalesce(sum(CASE WHEN lead_days <= 14 THEN 1 ELSE 0 END), 0),
          coalesce(sum(CASE WHEN lead_days BETWEEN 15 AND 30 THEN 1 ELSE 0 END), 0),
          coalesce(sum(CASE WHEN lead_days BETWEEN 31 AND 60 THEN 1 ELSE 0 END), 0),
          coalesce(sum(CASE WHEN lead_days BETWEEN 61 AND 90 THEN 1 ELSE 0 END), 0),
          coalesce(sum(CASE WHEN lead_days BETWEEN 91 AND 120 THEN 1 ELSE 0 END), 0),
          coalesce(sum(CASE WHEN lead_days BETWEEN 121 AND 150 THEN 1 ELSE 0 END), 0),
          coalesce(sum(CASE WHEN lead_days BETWEEN 151 AND 180 THEN 1 ELSE 0 END), 0),
          coalesce(sum(CASE WHEN lead_days BETWEEN 181 AND 210 THEN 1 ELSE 0 END), 0),
          coalesce(sum(CASE WHEN lead_days BETWEEN 211 AND 240 THEN 1 ELSE 0 END), 0),
          coalesce(sum(CASE WHEN lead_days > 240 THEN 1 ELSE 0 END), 0)
        ),
        'avg_be',
        CASE
          WHEN count(*) FILTER (WHERE lnd = 'BE') > 0
            THEN round((avg(lead_days) FILTER (WHERE lnd = 'BE'))::numeric, 1)
        END,
        'avg_nl',
        CASE
          WHEN count(*) FILTER (WHERE lnd = 'NL') > 0
            THEN round((avg(lead_days) FILTER (WHERE lnd = 'NL'))::numeric, 1)
        END,
        'be_legacy',
        jsonb_build_array(
          coalesce(sum(CASE WHEN lnd = 'BE' AND lead_days <= 7 THEN 1 ELSE 0 END), 0),
          coalesce(sum(CASE WHEN lnd = 'BE' AND lead_days BETWEEN 8 AND 14 THEN 1 ELSE 0 END), 0),
          coalesce(sum(CASE WHEN lnd = 'BE' AND lead_days BETWEEN 15 AND 30 THEN 1 ELSE 0 END), 0),
          coalesce(sum(CASE WHEN lnd = 'BE' AND lead_days BETWEEN 31 AND 60 THEN 1 ELSE 0 END), 0),
          coalesce(sum(CASE WHEN lnd = 'BE' AND lead_days BETWEEN 61 AND 90 THEN 1 ELSE 0 END), 0),
          coalesce(sum(CASE WHEN lnd = 'BE' AND lead_days > 90 THEN 1 ELSE 0 END), 0)
        ),
        'nl_legacy',
        jsonb_build_array(
          coalesce(sum(CASE WHEN lnd = 'NL' AND lead_days <= 7 THEN 1 ELSE 0 END), 0),
          coalesce(sum(CASE WHEN lnd = 'NL' AND lead_days BETWEEN 8 AND 14 THEN 1 ELSE 0 END), 0),
          coalesce(sum(CASE WHEN lnd = 'NL' AND lead_days BETWEEN 15 AND 30 THEN 1 ELSE 0 END), 0),
          coalesce(sum(CASE WHEN lnd = 'NL' AND lead_days BETWEEN 31 AND 60 THEN 1 ELSE 0 END), 0),
          coalesce(sum(CASE WHEN lnd = 'NL' AND lead_days BETWEEN 61 AND 90 THEN 1 ELSE 0 END), 0),
          coalesce(sum(CASE WHEN lnd = 'NL' AND lead_days > 90 THEN 1 ELSE 0 END), 0)
        ),
        'total_bookings_with_dates', coalesce(count(*), 0)
      )
      FROM lead_rows
    )
  )
$$;

COMMENT ON FUNCTION public.dagtrends_boekingentrends_aggregate IS
  'Aggregaat voor dagtrends boekingentrends (pax per dag, KPI''s, lead time).';

-- Rechten voor PostgREST (pas aan naar je Supabase-rollen indien nodig):
-- GRANT EXECUTE ON FUNCTION public.dagtrends_norm_land(text) TO anon, authenticated, service_role;
-- GRANT EXECUTE ON FUNCTION public.dagtrends_boekingentrends_aggregate(text, uuid, date, date, date, date, text) TO anon, authenticated, service_role;
