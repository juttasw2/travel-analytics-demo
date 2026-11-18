"""Bouw de demo-database op: migraties, fictieve boekingen en een demo-account.

Gebruik (DATABASE_URL in .env of als omgevingsvariabele, naar een LEGE database):
    python demo/seed_demo.py

Het script:
  1. voert alle migraties uit (run_migrations.py);
  2. genereert de fictieve Excel-exports (demo/generate_demo_data.py);
  3. importeert die via de gewone importlogica van de app;
  4. maakt het demo-account aan (DEMO_EMAIL / DEMO_PASSWORD, standaard demo@example.com / demo1234).
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.chdir(ROOT)

import psycopg2  # noqa: E402

import run_migrations  # noqa: E402
from config.settings import get_database_url  # noqa: E402
from demo.generate_demo_data import write  # noqa: E402
from services.upload_handler import verwerk_boekingen_excel  # noqa: E402

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def main() -> int:
    print("1/4 Migraties")
    if not run_migrations.run():
        print("Migraties mislukt, gestopt.")
        return 1

    print("\n2/4 Fictieve data genereren")
    paths = write(ROOT / "demo" / "output", seed=int(os.getenv("DEMO_SEED", "42")))

    print("\n3/4 Importeren")
    for path in paths:
        data = path.read_bytes()
        res = verwerk_boekingen_excel(
            file_bytes=data, filename=path.name, size_bytes=len(data), content_type=XLSX_MIME
        )
        status = "OK  " if res.success else "FOUT"
        print(f"  {status} {path.name}: {res.bookings_count} boekingen. {res.message}")
        for e in (res.errors or [])[:5]:
            print(f"       ! {e}")
        if not res.success:
            return 1

    print("\n4/4 Demo-account")
    email = os.getenv("DEMO_EMAIL", "demo@example.com")
    password = os.getenv("DEMO_PASSWORD", "demo1234")
    with psycopg2.connect(get_database_url()) as conn, conn.cursor() as cur:
        cur.execute(
            "select user_id, error_code from public.admin_create_app_user(%s, %s, %s, %s)",
            ("Demo gebruiker", email, password, "VERSIE_A"),
        )
        user_id, err = cur.fetchone()
    print(f"  {email}: " + ("aangemaakt" if user_id else f"niet aangemaakt ({err})"))
    print("\nKlaar. Start de app met DEMO_MODE=1.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
