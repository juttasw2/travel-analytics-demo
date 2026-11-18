-- Cleanup: drop oude uuid[]-signaturen van klantenprofiel-RPC's.
-- Sinds commit 90b506b zijn deze functies herschreven met text[] voor p_bestemming_ids,
-- maar de oude uuid[]-versies bleven in productie staan (geen DROP) waardoor het schema
-- twee functies met dezelfde naam bevat. Dat veroorzaakt enerzijds verkeerde dispatch
-- (oude versie wordt aangeroepen met ::uuid[] cast) en anderzijds "function does not
-- exist" zodra de Python-cast naar text[] gaat. Deze migratie verwijdert de oude versies.

drop function if exists public.klantenprofiel_dashboard(
  integer,
  text,
  uuid[],
  text,
  text,
  text,
  text[],
  text[],
  text,
  boolean,
  jsonb,
  jsonb
);

drop function if exists public.klantenprofiel_repeat_dashboard(
  integer,
  text,
  uuid[],
  text,
  text,
  text,
  text[],
  text[],
  text
);

drop function if exists public.klantenprofiel_traveler_origin_donut(
  integer,
  text,
  uuid[],
  text,
  text,
  text,
  text[],
  text[],
  text,
  jsonb,
  text
);
