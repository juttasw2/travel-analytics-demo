"""Genereer een fictieve boekingen-export (Excel) voor de portfolio-demo.

Alle namen, boekingen en bedragen zijn verzonnen. Het bestand heeft hetzelfde
formaat als een echte export, zodat het via de gewone importlogica verwerkt wordt.

Gebruik:
    python demo/generate_demo_data.py                # schrijft demo/output/demo_<jaar>.xlsx
    python demo/generate_demo_data.py --seed 7       # andere (maar reproduceerbare) data
"""
from __future__ import annotations

import argparse
import random
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path

import pandas as pd

# "Vandaag" voor de demo: boekingen na deze datum bestaan nog niet.
TODAY = date(2026, 11, 18)
YEARS = [2024, 2025, 2026, 2027]


@dataclass(frozen=True)
class Destination:
    name: str
    country: str
    hotels: tuple[tuple[str, str, str], ...]  # (naam, type, leverancier)
    base_price: float
    nights: tuple[int, ...]
    transports: tuple[tuple[str, float], ...]  # (transport, gewicht)


@dataclass(frozen=True)
class Brand:
    code: str
    name: str
    months: tuple[int, ...]  # vertrekmaanden
    destinations: tuple[Destination, ...]
    audiences: tuple[tuple[str, float], ...]
    bookings_per_year: int
    addons: tuple[tuple[str, float], ...]
    excursions: tuple[tuple[str, str, float], ...]  # (naam, type, prijs)


BRANDS: tuple[Brand, ...] = (
    Brand(
        code="SE",
        name="Sun Escapes",
        months=(6, 7, 7, 7, 8, 8),
        destinations=(
            Destination("Lloret de Mar", "Spanje", (
                ("Hotel Costa Azul", "Hotel", "Iberia Stays"),
                ("Apartamentos Mar Blau", "Appartement", "Iberia Stays"),
                ("Hostal Sol y Playa", "Hostel", "Coastline Partners"),
            ), 489, (7, 8, 10), (("bus", 0.75), ("plane", 0.2), ("self", 0.05))),
            Destination("Salou", "Spanje", (
                ("Hotel Palmera Beach", "Hotel", "Iberia Stays"),
                ("Aparthotel Daurada", "Appartement", "Coastline Partners"),
            ), 529, (7, 8, 10), (("bus", 0.7), ("plane", 0.25), ("self", 0.05))),
            Destination("Novalja", "Kroatië", (
                ("Villa Zrće", "Appartement", "Adriatic Homes"),
                ("Hotel Pag Sunset", "Hotel", "Adriatic Homes"),
            ), 579, (7, 10), (("bus", 0.55), ("plane", 0.45))),
            Destination("Rimini", "Italië", (
                ("Hotel Riviera Blu", "Hotel", "Adria Travel"),
                ("Residence Marina", "Appartement", "Adria Travel"),
            ), 459, (7, 8), (("bus", 0.8), ("plane", 0.2))),
            Destination("Sunny Beach", "Bulgarije", (
                ("Hotel Black Sea Star", "Hotel", "Balkan Resorts"),
            ), 419, (8, 10), (("plane", 1.0),)),
        ),
        audiences=(("Laatstejaars", 0.55), ("Studenten", 0.35), ("Young adults", 0.10)),
        bookings_per_year=520,
        addons=(("Party pass", 59), ("All-in drankenpakket", 89), ("Kamer met zeezicht", 35), ("Strandbed", 25)),
        excursions=(
            ("Boottocht met lunch", "Water", 45), ("Waterpark", "Fun", 39), ("Jetski", "Sport", 69),
            ("Snorkeltrip", "Water", 49), ("Pool party", "Nightlife", 29), ("Stadswandeling", "Cultuur", 19),
        ),
    ),
    Brand(
        code="SN",
        name="Snow Escapes",
        months=(12, 1, 2, 2, 3, 4),
        destinations=(
            Destination("Val Thorens", "Frankrijk", (
                ("Chalet Les Cimes", "Chalet", "Alpine Lodges"),
                ("Résidence Altitude", "Appartement", "Alpine Lodges"),
            ), 629, (7,), (("bus", 0.85), ("self", 0.15))),
            Destination("Les Deux Alpes", "Frankrijk", (
                ("Résidence Glacier", "Appartement", "Alpine Lodges"),
                ("Hotel Le Sommet", "Hotel", "Montagne Partners"),
            ), 589, (7,), (("bus", 0.8), ("self", 0.2))),
            Destination("Sölden", "Oostenrijk", (
                ("Gasthof Bergblick", "Hotel", "Tirol Stays"),
                ("Apart Ötztal", "Appartement", "Tirol Stays"),
            ), 649, (7,), (("bus", 0.75), ("self", 0.25))),
            Destination("Livigno", "Italië", (
                ("Hotel Neve Alta", "Hotel", "Montagne Partners"),
            ), 569, (7,), (("bus", 0.8), ("self", 0.2))),
        ),
        audiences=(("Studenten", 0.5), ("Young adults", 0.3), ("Laatstejaars", 0.2)),
        bookings_per_year=340,
        addons=(("Skipas 6 dagen", 279), ("Materiaalhuur ski", 119), ("Materiaalhuur snowboard", 129), ("Skiles", 95)),
        excursions=(
            ("Après-ski party", "Nightlife", 25), ("Sneeuwschoentocht", "Sport", 35),
            ("Rodelbaan", "Fun", 20), ("Wellness", "Relax", 30),
        ),
    ),
    Brand(
        code="RR",
        name="Road Rebels",
        months=(4, 5, 6, 7, 7, 8, 9),
        destinations=(
            Destination("Andalusië roadtrip", "Spanje", (
                ("Hostels Andalucía", "Hostel", "Wanderbase"),
                ("Jouw verblijf in Andalusië", "Eigen verblijf", "Wanderbase"),
            ), 749, (8, 10), (("plane", 0.9), ("self", 0.1))),
            Destination("Portugal surftrip", "Portugal", (
                ("Surfcamp Ericeira", "Kamp", "Atlantic Camps"),
                ("Surf House Peniche", "Hostel", "Atlantic Camps"),
            ), 689, (8,), (("plane", 0.95), ("self", 0.05))),
            Destination("Toscane fietsreis", "Italië", (
                ("Agriturismo Il Poggio", "Agriturismo", "Tuscany Trails"),
            ), 819, (7,), (("plane", 0.7), ("self", 0.3))),
            Destination("Kroatië island hopping", "Kroatië", (
                ("Boot Adriatic Explorer", "Boot", "Adriatic Homes"),
            ), 899, (8,), (("plane", 1.0),)),
        ),
        audiences=(("Young adults", 0.6), ("Studenten", 0.4)),
        bookings_per_year=180,
        addons=(("Surfles", 75), ("Fietshuur", 60), ("Snorkelset", 15), ("Extra nacht", 45)),
        excursions=(
            ("Kajaktocht", "Sport", 49), ("Wijnproeverij", "Food", 39),
            ("Flamencoshow", "Cultuur", 35), ("Canyoning", "Sport", 79),
        ),
    ),
)

ORIGINS = {
    "BE": (
        ("Antwerpen", "Antwerpen", 0.18), ("Gent", "Oost-Vlaanderen", 0.14), ("Leuven", "Vlaams-Brabant", 0.1),
        ("Brugge", "West-Vlaanderen", 0.09), ("Hasselt", "Limburg", 0.08), ("Mechelen", "Antwerpen", 0.07),
        ("Kortrijk", "West-Vlaanderen", 0.07), ("Aalst", "Oost-Vlaanderen", 0.06), ("Genk", "Limburg", 0.05),
        ("Turnhout", "Antwerpen", 0.05), ("Brussel", "Brussel", 0.05), ("Roeselare", "West-Vlaanderen", 0.03),
        ("Sint-Niklaas", "Oost-Vlaanderen", 0.03),
    ),
    "NL": (
        ("Eindhoven", "Noord-Brabant", 0.2), ("Breda", "Noord-Brabant", 0.15), ("Tilburg", "Noord-Brabant", 0.13),
        ("Utrecht", "Utrecht", 0.12), ("Rotterdam", "Zuid-Holland", 0.12), ("Maastricht", "Limburg", 0.1),
        ("Amsterdam", "Noord-Holland", 0.1), ("Nijmegen", "Gelderland", 0.08),
    ),
}
SCHOOLS = {
    "BE": ("Sint-Jozefscollege", "Atheneum Zuid", "Sint-Lievenscollege", "Heilig-Hartinstituut", "Technisch Instituut Sint-Paulus"),
    "NL": ("Stedelijk Lyceum", "Christelijk College De Brug", "Het Rijnlands Lyceum", "Montessori College Oost"),
}
FIRST_NAMES = {
    "M": ("Lukas", "Noah", "Arthur", "Louis", "Liam", "Jules", "Mathis", "Finn", "Daan", "Sem", "Milan", "Lars",
          "Victor", "Wout", "Thijs", "Jasper", "Ruben", "Seppe", "Bram", "Tibo"),
    "V": ("Emma", "Olivia", "Louise", "Mila", "Elena", "Lotte", "Julie", "Fleur", "Sara", "Noor", "Anna", "Lisa",
          "Hanne", "Marie", "Febe", "Jana", "Lore", "Zoë", "Tess", "Amber"),
}
LAST_NAMES = ("Peeters", "Janssens", "Maes", "Jacobs", "Mertens", "Willems", "Claes", "Goossens", "Wouters",
              "De Smet", "Dubois", "Vermeulen", "de Vries", "Bakker", "Visser", "Smit", "Meijer", "de Boer",
              "Mulder", "Bos", "Vos", "Hendrickx", "Lambrechts", "Van Damme", "Verhoeven")
AIRLINES = (("SkyLow", "SL"), ("EuroJet", "EJ"), ("Aurora Air", "AU"))
AIRPORTS_FROM = {"BE": ("BRU", "CRL", "ANR"), "NL": ("EIN", "AMS")}
AIRPORTS_TO = {"Spanje": "BCN", "Kroatië": "ZAD", "Italië": "PSA", "Bulgarije": "BOJ", "Portugal": "LIS", "Frankrijk": "GVA",
               "Oostenrijk": "INN"}
BUS_STOPS = {"BE": ("Antwerpen Centraal", "Gent Sint-Pieters", "Leuven", "Hasselt", "Brugge"),
             "NL": ("Eindhoven", "Breda", "Utrecht")}
DISCOUNT_CODES = ("EARLYBIRD", "VRIENDEN10", "WINTERDEAL", "STUDENT25")


def pick(rng: random.Random, weighted: tuple) -> object:
    items = [w[:-1] if len(w) > 2 else w[0] for w in weighted]
    weights = [w[-1] for w in weighted]
    return rng.choices(items, weights=weights, k=1)[0]


def fmt(d: date | None) -> str | None:
    return d.strftime("%d/%m/%Y") if d else None


def departure_for(rng: random.Random, brand: Brand, year: int) -> date:
    month = rng.choice(brand.months)
    # Winterseizoen: december hoort bij het seizoen van het volgende jaar.
    y = year - 1 if month == 12 else year
    weekday_start = date(y, month, rng.randint(1, 24))
    # Vertrek op vrijdag of zaterdag.
    while weekday_start.weekday() not in (4, 5):
        weekday_start += timedelta(days=1)
    return weekday_start


def booking_date_for(rng: random.Random, departure: date) -> date:
    # Piek ±5-7 maanden voor vertrek, staart tot 2 weken ervoor.
    days_before = int(min(330, max(14, rng.gauss(185, 65))))
    return departure - timedelta(days=days_before)


def money(x: float) -> float:
    return round(x, 2)


def generate(seed: int = 42) -> dict[int, dict[str, pd.DataFrame]]:
    rng = random.Random(seed)
    per_year: dict[int, dict[str, list[dict]]] = {}
    counters = {b.code: {"BE": 10000, "NL": 50000} for b in BRANDS}

    for year in YEARS:
        growth = {2024: 0.82, 2025: 0.93, 2026: 1.0, 2027: 1.08}[year]
        rows: list[dict] = []
        excursions: list[dict] = []
        addons: list[dict] = []
        flights: list[dict] = []

        for brand in BRANDS:
            for _ in range(int(brand.bookings_per_year * growth)):
                departure = departure_for(rng, brand, year)
                booked_on = booking_date_for(rng, departure)
                if booked_on > TODAY:
                    continue  # bestaat "nog niet"
                land = "BE" if rng.random() < 0.78 else "NL"
                counters[brand.code][land] += 1
                order = f"{brand.code}{land}{counters[brand.code][land]}"
                dest: Destination = rng.choice(brand.destinations)
                hotel_name, hotel_type, supplier = rng.choice(dest.hotels)
                nights = rng.choice(dest.nights)
                ret = departure + timedelta(days=nights)
                transport = pick(rng, dest.transports)
                audience = pick(rng, brand.audiences)
                pax = rng.choices([1, 2, 3, 4, 5, 6], weights=[8, 22, 20, 28, 12, 10], k=1)[0]
                city, province = pick(rng, ORIGINS[land])
                school = rng.choice(SCHOOLS[land]) if audience == "Laatstejaars" else None
                room = f"{pax}-persoonskamer" if pax <= 4 else "Groepskamer"
                meal = rng.choice(("Logies", "Ontbijt", "Halfpension")) if hotel_type == "Hotel" else "Logies"

                travelled = ret < TODAY
                r = rng.random()
                if r < 0.06:
                    booking_status = "Cancelled"
                elif r < 0.08:
                    booking_status = "Whole booking cancelled"
                elif not travelled and r < 0.11:
                    booking_status = "Processing"
                else:
                    booking_status = "Booked"

                discount_code = rng.choice(DISCOUNT_CODES) if rng.random() < 0.12 else None
                bus_stop = rng.choice(BUS_STOPS[land]) if transport == "bus" else None
                base = dest.base_price * (1 + (year - 2026) * 0.04) * (nights / max(dest.nights))

                for t in range(pax):
                    gender = rng.choice(("M", "V"))
                    first = rng.choice(FIRST_NAMES[gender])
                    last = rng.choice(LAST_NAMES)
                    age = {"Laatstejaars": rng.randint(17, 18), "Studenten": rng.randint(18, 23)}.get(
                        audience, rng.randint(21, 29)
                    )
                    birth = date(departure.year - age, rng.randint(1, 12), rng.randint(1, 28))

                    if booking_status in ("Cancelled", "Whole booking cancelled"):
                        traveller_status = "Cancelled"
                    elif rng.random() < 0.025:
                        traveller_status = "Dropped"
                    else:
                        traveller_status = "Active"

                    package = money(base * rng.uniform(0.95, 1.08))
                    room_price = money(rng.choice((0, 0, 0, 25, 45))) if pax <= 2 else 0.0
                    flight_to = money(rng.uniform(70, 160)) if transport == "plane" else 0.0
                    flight_from = money(rng.uniform(70, 160)) if transport == "plane" else 0.0
                    transfer = 35.0 if transport == "plane" else 0.0
                    baggage = rng.choice((0.0, 0.0, 39.0)) if transport == "plane" else 0.0
                    tourist_tax = money(nights * rng.choice((1.0, 1.5, 2.5)))
                    has_cancel = rng.random() < 0.45
                    has_travel = rng.random() < 0.3
                    cancel_price = money(package * 0.055) if has_cancel else 0.0
                    travel_price = 19.0 if has_travel else 0.0
                    excursions_total = 0.0
                    discount = 25.0 if discount_code else 0.0

                    # Excursies + add-ons (alleen actieve reizigers).
                    if traveller_status == "Active":
                        for _ in range(rng.choices([0, 1, 2, 3], weights=[45, 30, 17, 8], k=1)[0]):
                            ex_name, ex_type, ex_price = rng.choice(brand.excursions)
                            excursions_total += ex_price
                            excursions.append({
                                "Order number": order, "First name": first, "Last name": last,
                                "Destination": dest.name, "Name": ex_name, "Type": ex_type,
                                "Excursion type": rng.choice(("Booking sale", "Booking sale", "Local sale")),
                                "Price": float(ex_price),
                                "Departure date": fmt(departure), "Return date": fmt(ret),
                                "Is payment pending": "no" if travelled else rng.choice(("no", "no", "yes")),
                                "Booking status": booking_status, "Traveller status": traveller_status,
                                "Payment option": rng.choice(("Bancontact", "iDEAL", "Overschrijving", "Creditcard")),
                                "Booked in online account": rng.choice(("yes", "no")),
                                "Date added": fmt(min(TODAY, booked_on + timedelta(days=rng.randint(0, 60)))),
                            })
                        if rng.random() < 0.35:
                            ad_name, ad_price = rng.choice(brand.addons)
                            addons.append({
                                "Order number": order, "Name": ad_name, "Price": float(ad_price),
                                "Departure date": fmt(departure), "Return date": fmt(ret),
                                "Booked in online account": rng.choice(("yes", "no")),
                                "Booking status": booking_status,
                            })

                    total = money(package + room_price + flight_to + flight_from + transfer + baggage
                                  + tourist_tax + cancel_price + travel_price + excursions_total - discount)
                    advance_pct = 30.0
                    advance = money(total * advance_pct / 100)
                    if booking_status in ("Cancelled", "Whole booking cancelled"):
                        paid = advance if rng.random() < 0.7 else 0.0
                        payment_status = "Paid" if paid else "Open"
                    elif travelled or (departure - TODAY).days < 45:
                        paid, payment_status = total, "Paid"
                    else:
                        paid = rng.choice((advance, advance, total, 0.0))
                        payment_status = "Paid" if paid >= total else ("Advance paid" if paid else "Open")
                    to_be_paid = money(max(total - paid, 0))

                    cost_acco = money(package * rng.uniform(0.48, 0.6))
                    cost_transport = money((flight_to + flight_from) * 0.85) if transport == "plane" else (
                        0.0 if transport != "bus" else money(rng.uniform(110, 150)))
                    cost_transfer = money(rng.uniform(25, 35)) if transport == "plane" else 0.0

                    rows.append({
                        "Order number": order,
                        "Departure date": fmt(departure),
                        "Return date": fmt(ret),
                        "Booking date": fmt(booked_on),
                        "First name": first, "Last name": last,
                        "Date of birth": fmt(birth), "Gender": gender,
                        "Traveller status": traveller_status,
                        "City": city, "Province": province, "Country": "België" if land == "BE" else "Nederland",
                        "Brand land": land, "School": school,
                        "Destination": dest.name,
                        "Accommodation": hotel_name, "Accommodation type": hotel_type,
                        "Accommodation supplier": supplier, "Acco status": "Confirmed",
                        "Meal type": meal, "Room": room, "Room price": room_price,
                        "Target audience": audience, "Transport": transport,
                        "Transport status": "Confirmed",
                        "Bus stop": bus_stop,
                        "Departure bus": f"Bus {rng.randint(1, 6)}" if bus_stop else None,
                        "Return bus": f"Bus {rng.randint(1, 6)}" if bus_stop else None,
                        "Booking status": booking_status, "Payment status": payment_status,
                        "Totaal to pay": total, "Paid so far": money(paid), "To be paid": to_be_paid,
                        "Package price": package, "Transfer Price": transfer, "Baggage Price": baggage,
                        "Flight To Price": flight_to, "Flight From Price": flight_from,
                        "Tourist tax to pay": tourist_tax, "Clean fee to pay": 0.0,
                        "Warranty to pay": 50.0 if hotel_type in ("Appartement", "Chalet") else 0.0,
                        "Warranty paid": 50.0 if hotel_type in ("Appartement", "Chalet") and travelled else 0.0,
                        "Price annulation insurance": cancel_price, "Price travel insurance": travel_price,
                        "Price annulation and travel insurances": 0.0,
                        "Has annulation insurance": "yes" if has_cancel else "no",
                        "Has travel insurance": "yes" if has_travel else "no",
                        "Has annulation and travel insurances": "no",
                        "Cost Accommodation": cost_acco, "Cost transport": cost_transport,
                        "Cost transfer": cost_transfer, "Cost extra charges": 0.0,
                        "Excursions total": float(excursions_total),
                        "Advance percentage": advance_pct, "Advance": advance,
                        "Advance payment reminders": 0 if paid else rng.randint(0, 2),
                        "Total payment reminders": 0 if to_be_paid == 0 else rng.randint(0, 2),
                        "Discount code used": discount_code, "Discount amount": discount,
                        "Invoice sent on": fmt(booked_on + timedelta(days=1)),
                        "Exclude from communications": "no",
                    })

                if transport == "plane":
                    airline, code = rng.choice(AIRLINES)
                    frm, to = rng.choice(AIRPORTS_FROM[land]), AIRPORTS_TO[dest.country]
                    for direction, day, a, b in (("heen", departure, frm, to), ("terug", ret, to, frm)):
                        dep_time = datetime(day.year, day.month, day.day, rng.choice((6, 9, 13, 17)), rng.choice((0, 30)))
                        flights.append({
                            "Order number": order, "Transport type": "plane", "direction": direction,
                            "Flight number": f"{code}{rng.randint(100, 999)}", "Airline": airline,
                            "Departure time": dep_time.strftime("%d/%m/%Y %H:%M"),
                            "Arrival time": (dep_time + timedelta(hours=2, minutes=15)).strftime("%d/%m/%Y %H:%M"),
                            "Departure airport": a, "Arrival airport": b,
                            "Transfer Type": "Shuttle", "Transfer Price": 35.0, "Baggage Price": 0.0,
                        })

        per_year[year] = {"Boekingen": rows, "Excursies": excursions, "Addons": addons, "Flights": flights}

    return {y: {k: pd.DataFrame(v) for k, v in sheets.items()} for y, sheets in per_year.items()}


def write(out_dir: Path, seed: int) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    paths = []
    for year, sheets in generate(seed).items():
        path = out_dir / f"demo_{year}.xlsx"
        with pd.ExcelWriter(path, engine="openpyxl") as xw:
            for name, df in sheets.items():
                df.to_excel(xw, sheet_name=name, index=False)
        paths.append(path)
        print(f"{path.name}: " + ", ".join(f"{k}={len(v)}" for k, v in sheets.items()))
    return paths


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--out", default=str(Path(__file__).parent / "output"))
    args = ap.parse_args()
    write(Path(args.out), args.seed)
