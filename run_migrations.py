"""Databasemigraties (PostgreSQL).

Uitgevoerde bestanden worden bijgehouden in public.schema_migrations:
- bestanden onder sql/rpc/ (CREATE OR REPLACE) draaien opnieuw zodra hun inhoud wijzigt;
- alle andere bestanden draaien precies één keer.
Stopt bij de eerste fout zodat er niet gedeployed wordt op een half-gemigreerde DB.
"""
import hashlib
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

import psycopg2

# Execution order: tables → auth functions → helper functions → views → RPCs → seed
FILES = [
    # 1. Tables + columns + constraints + indexes
    "migrations/20260502000000_consolidated_baseline.sql",

    # 2. Auth functions (final state with MFA support)
    "migrations/app_users_auth.sql",
    "migrations/app_users_mfa.sql",
    "migrations/app_users_admin_management.sql",

    # 3. Helper functions (needed by views and RPCs)
    "sql/rpc/_bootstrap_excursie_status.sql",    # excursies_booking_status_is_cancelled
    "sql/rpc/dashboard_booking_filters.sql",     # reiziger_status_uitgesloten_standaard_dashboards, boeking_id_excluded, vw_actieve_reizigers_per_boeking
    "migrations/20260508110000_restore_compute_kost_transport_rule.sql",  # compute_kost_transport_rule(text, numeric)
    "migrations/20260508113000_enforce_boekingen_cascade_delete.sql",  # all boeking_id FKs -> ON DELETE CASCADE

    # 4. Views (need helper functions above)
    "migrations/excursies_uniek_boekingsprijs_jaarkosten.sql",  # vw_excursie_sales_analysis + excursie_jaarkosten DDL
    "migrations/20260501130000_boekingen_met_omzet_actieve_reizigers.sql",  # boekingen_met_omzet view
    # NOTE: vlucht_allotment_dashboard_view skipped — references aankomstdag/richting columns
    # that only exist in the pre_boekingen schema (not in the EN-column baseline).

    # 5. All RPC functions (order doesn't matter — deps already satisfied)
    "sql/rpc/excursies_rpc.sql",
    "sql/rpc/bestemmingen_dashboard_rpc.sql",
    "sql/rpc/bestemmingen_periodes_rpc.sql",
    "sql/rpc/dagtrends_bestemmingen_rpc.sql",
    "sql/rpc/dagtrends_boekingentrends_rpc.sql",
    "sql/rpc/dagtrends_heatmap_rpc.sql",
    "sql/rpc/data_verzameling_rpc.sql",
    "sql/rpc/financieel_rpc.sql",
    "sql/rpc/insights_rpc.sql",
    "sql/rpc/inzichten_verliezen_rpc.sql",
    "sql/rpc/klantenprofiel_rpc.sql",
    "sql/rpc/leveranciers_analyse_rpc.sql",
    "sql/rpc/overzicht_rpc.sql",
    "sql/rpc/tijdsvergelijkingen_rpc.sql",

    # 6. Demo-data en demo-account: zie demo/seed_demo.py
]


REPEATABLE_PREFIX = "sql/rpc/"


def run():
    # Lees DATABASE_URL via dezelfde logica als de Flask-app (laadt .env in
    # de project-root). Voorkomt dat dit script terugvalt op een hardcoded
    # default-DSN met een wachtwoord dat in productie niet klopt.
    try:
        from config.settings import get_database_url
        dsn = get_database_url()
    except Exception:
        dsn = os.environ["DATABASE_URL"]
    conn = psycopg2.connect(dsn)
    conn.autocommit = True

    with conn.cursor() as cur:
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS public.schema_migrations (
                path text PRIMARY KEY,
                checksum text NOT NULL,
                applied_at timestamptz NOT NULL DEFAULT now()
            )
            """
        )
        cur.execute("SELECT path, checksum FROM public.schema_migrations")
        applied = dict(cur.fetchall())

    ok = 0
    for path in FILES:
        if not os.path.exists(path):
            print(f"  FAIL  {path} (not found)")
            conn.close()
            return False
        with open(path, "rb") as f:
            raw = f.read()
        checksum = hashlib.sha256(raw).hexdigest()
        repeatable = path.startswith(REPEATABLE_PREFIX)

        if path in applied and (not repeatable or applied[path] == checksum):
            print(f"  SKIP  {path}")
            continue

        try:
            with conn.cursor() as cur:
                cur.execute(raw.decode("utf-8", errors="replace"))
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO public.schema_migrations (path, checksum)
                    VALUES (%s, %s)
                    ON CONFLICT (path) DO UPDATE
                        SET checksum = EXCLUDED.checksum, applied_at = now()
                    """,
                    (path, checksum),
                )
        except Exception as exc:
            # Rollback any open transaction from explicit BEGIN in SQL files
            try:
                with conn.cursor() as cur:
                    cur.execute("ROLLBACK")
            except Exception:
                pass
            print(f"  FAIL  {path}: {exc}")
            conn.close()
            return False
        print(f"  OK    {path}")
        ok += 1

    conn.close()
    print(f"\nDone: {ok} applied.")
    return True


if __name__ == "__main__":
    success = run()
    sys.exit(0 if success else 1)
