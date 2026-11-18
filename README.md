# TravelAnalytics: analysetool voor reisboekingen

Een webapplicatie waarmee een reisorganisatie haar boekingsexports (Excel) inleest en analyseert:
omzet en winst, bestemmingen, boekingstrends, klantprofielen, excursies en annulaties.

> **Portfolio-demo.** Deze versie draait op volledig **fictieve data**: drie verzonnen merken
> (Sun Escapes, Snow Escapes, Road Rebels) met gegenereerde boekingen voor 2024–2027.
> De demo is alleen-lezen. Log in met `demo@example.com` / `demo1234`.

## Wat de tool doet

| Onderdeel | Inhoud |
|---|---|
| **Overzicht** | KPI's per jaar en merk: boekingen, reizigers, omzet, gemiddelde boekingswaarde, topbestemmingen |
| **Bestemmingen** | Prestaties per bestemming en accommodatie, reisperiodes, herkomst van reizigers |
| **Dagtrends** | Boekingsverloop per dag, heatmap van boekingsmomenten, jaarvergelijkingen |
| **Financieel** | Omzet, kosten en winst per boeking en leverancier, openstaande betalingen |
| **Klantenprofiel** | Leeftijd, geslacht, regio, doelgroep, herhaalboekers |
| **Excursies** | Verkoop van excursies per bestemming en type |
| **Annulaties** | Annulatiegraad per merk, bestemming en periode |
| **Upload** | Import van Excel-exports met validatie, normalisatie en voortgang (uitgeschakeld in de demo) |

## Technisch

- **Backend:** Python, Flask, PostgreSQL (psycopg2). Zware aggregaties gebeuren in SQL-functies (`sql/rpc/`).
- **Import:** pandas/openpyxl. Kolommen worden via een allowlist ingelezen (dataminimalisatie) en
  gevalideerd, daarna genormaliseerd naar boekingen, reizigers, financiën, excursies, add-ons en vluchten.
- **Beveiliging:** wachtwoorden gehasht met bcrypt (pgcrypto), tweestapsverificatie (TOTP),
  CSRF-bescherming, rate limiting op login, rollen (beheerder / beperkt), security headers.
- **Frontend:** server-side templates (Jinja), Bootstrap, Chart.js.
- **Migraties:** `run_migrations.py` houdt uitgevoerde bestanden bij in `schema_migrations`.

## Lokaal draaien

```bash
python -m venv venv
venv\Scripts\activate            # macOS/Linux: source venv/bin/activate
pip install -r requirements.txt
copy .env.example .env           # vul DATABASE_URL in (lege PostgreSQL-database)
python demo/seed_demo.py         # migraties + fictieve data + demo-account
python main.py                   # http://127.0.0.1:5000
```

## Demodata

`demo/generate_demo_data.py` genereert reproduceerbare Excel-exports in hetzelfde formaat als de echte
exports: seizoenspatronen per merk (zomer, winter, rondreizen), Belgische en Nederlandse reizigers,
groepsgroottes, annulaties, verzekeringen, excursies, add-ons en vluchten. Die bestanden lopen door
exact dezelfde importlogica als in productie.
