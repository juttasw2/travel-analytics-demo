from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
import zipfile

from config.settings import get_upload_max_file_size_bytes

MAX_FILE_SIZE_BYTES = get_upload_max_file_size_bytes()
ALLOWED_EXTENSIONS = (".xlsx",)
ALLOWED_MIME_TYPES = {
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}
_ZIP_MAX_ENTRIES = 5000
_ZIP_MAX_UNCOMPRESSED_BYTES = 150 * 1024 * 1024
_ZIP_MAX_RATIO = 200.0

# Sheet allowlist: unknown sheets are ignored.
BOOKINGS_SHEET_ALIASES = ("boekingen", "bookings", "reservations")
EXCURSIES_SHEET_ALIASES = ("excursies", "excursions")
ADDONS_SHEET_ALIASES = ("addons", "add-ons", "add ons")
FLIGHTS_SHEET_ALIASES = ("flights", "vluchten")

# Column allowlists per section (normalized names).
BOOKINGS_ALLOWED_COLUMNS = {
    "ordernumber",
    "orderno",
    "ordernr",
    "order",
    "ordernummer",
    "periode",
    "period",
    # Alternatieve koppen voor dezelfde periode-kolom (export wisselt per jaar/versie).
    "travelperiod",
    "tripperiod",
    "reisperiode",
    "verblijfsperiode",
    "bookingperiod",
    "traveldates",
    "tripdates",
    "stayperiod",
    "holidayperiod",
    # Periode als twee aparte datums (o.a. oudere / andere exports). Alleen
    # ondubbelzinnige koppen — bare 'departure', 'return', 'outbound', 'inbound',
    # 'aankomst', 'vertrek', 'van', 'tot' zijn bewust weggelaten omdat ze in
    # bus-/transportkolommen voorkomen.
    "periodeheen",
    "periodeterug",
    "departuredate",
    "outbounddate",
    "vertrekdatum",
    "datumvertrek",
    "heenreis",
    "heenreisdatum",
    "datumheen",
    "afreisdatum",
    "returndate",
    "inbounddate",
    "aankomstdatum",
    "datumaankomst",
    "terugreis",
    "terugreisdatum",
    "datumterug",
    "terugkeer",
    "terugkeerdatum",
    "terugkomst",
    "terugkomstdatum",
    "startdate",
    "enddate",
    "startdatum",
    "begindatum",
    "einddatum",
    "fromdate",
    "datefrom",
    "todate",
    "dateto",
    "bookingdate",
    "bookingdatum",
    "boekingsdatum",
    "destination",
    "destinationname",
    "bestemming",
    "bestemmingnaam",
    "accommodation",
    "accommodationname",
    "accomodation",
    "accomodationname",
    "accommodatie",
    "accommodatienaam",
    "accommodationtype",
    "accommodationsupplier",
    "targetaudience",
    "transport",
    "bookingstatus",
    "paymentstatus",
    "totaltopay",
    "totaaltopay",
    "totaaltopayeur",
    "totaaltebetalen",
    "totaaltebetaleneur",
    "paidsofar",
    "tobepaid",
    "packageprice",
    "collections",
    "excludefromcommuncations",
    "excludefromcommunications",
    "city",
    "province",
    "country",
    "school",
    "accostatus",
    "mealtype",
    "room",
    "roomprice",
    "busstop",
    "departurebus",
    "returnbus",
    "transferprice",
    "baggageprice",
    "flighttoprice",
    "flightfromprice",
    "touristtaxtopay",
    "cleanfeetopay",
    "warrantytopay",
    "warrantypaid",
    "warrantymethod",
    "priceannulationinsurance",
    "pricetravelinsurance",
    "priceannulationandtravelinsurances",
    "hasannulationinsurance",
    "hastravelinsurance",
    "hasannulationandtravelinsurances",
    "costaccommodation",
    "costtransport",
    "costtransfer",
    "costextracharges",
    "excursionstotal",
    "advancepercentage",
    "advance",
    "advancepaymentreminders",
    "totalpaymentreminders",
    "discountcodeused",
    "discountamount",
    "invoicesent",
    "invoicesenton",
    "dateofbirth",
    "geboortedatum",
    "datumgeboorte",
    "dob",
    "gender",
    "geslacht",
    "sex",
    "firstname",
    "voornaam",
    "lastname",
    "achternaam",
    "travellerstatus",
    "reizigerstatus",
    "travellerstate",
    "reizigerstatusnaam",
    "brandland",
    "brandname",
    "transportstatus",
}

EXCURSIES_ALLOWED_COLUMNS = {
    "ordernumber",
    "firstname",
    "lastname",
    "travelleremail",
    "traveleremail",
    "email",
    "destination",
    "destinationname",
    "bestemming",
    "bestemmingnaam",
    "name",
    "excursionname",
    "excursienaam",
    "excursie",
    "type",
    "excursiontypegroup",
    "excursietype",
    "departuredate",
    "vertrekdatum",
    "returndate",
    "terugkeerdatum",
    "price",
    "prijs",
    "excursiontype",
    "betalingpending",
    "ispaymentpending",
    "bookingstatus",
    "travellerstatus",
    "travelerstatus",
    "reizigerstatus",
    "reizigerstatusnaam",
    "comment",
    "commentaar",
    "paymentoption",
    "betaaloptie",
    "molliepaymentid",
    "molliebetalingid",
    "bookedinonlineaccount",
    "datumtoegevoegd",
    "dateadded",
}

ADDONS_ALLOWED_COLUMNS = {
    "ordernumber",
    "name",
    "addonname",
    "addon",
    "add-on",
    "addonnaam",
    "price",
    "prijs",
    "departuredate",
    "vertrekdatum",
    "returndate",
    "terugkeerdatum",
    "bookedinonlineaccount",
    "bookingstatus",
}

FLIGHTS_ALLOWED_COLUMNS = {
    "ordernumber",
    "transport",
    "transporttype",
    "vervoer",
    "transportnaam",
    "direction",
    "flightnumber",
    "airline",
    "maatschappij",
    "carrier",
    "departuretime",
    "arrivaltime",
    "departureairport",
    "arrivalairport",
    "transfertype",
    "transferprice",
    "baggageprice",
}


@dataclass(frozen=True)
class UploadValidationResult:
    ok: bool
    error: str | None = None


def is_probably_xlsx(file_bytes: bytes) -> bool:
    # XLSX is a ZIP container and starts with PK.
    return len(file_bytes) >= 4 and file_bytes[:2] == b"PK"


def validate_upload_content(
    *,
    filename: str,
    content_type: str | None = None,
    file_bytes: bytes | None = None,
) -> UploadValidationResult:
    normalized_mime = (content_type or "").split(";")[0].strip().lower()
    if normalized_mime and normalized_mime not in ALLOWED_MIME_TYPES:
        return UploadValidationResult(
            ok=False,
            error="Bestandstype is niet toegestaan. Upload een geldig .xlsx-bestand.",
        )

    if not file_bytes:
        return UploadValidationResult(ok=True)

    try:
        with zipfile.ZipFile(BytesIO(file_bytes)) as archive:
            members = archive.infolist()
            if len(members) > _ZIP_MAX_ENTRIES:
                return UploadValidationResult(ok=False, error="Bestand bevat te veel interne onderdelen.")

            compressed_total = 0
            uncompressed_total = 0
            for member in members:
                compressed_total += max(member.compress_size, 0)
                uncompressed_total += max(member.file_size, 0)
                if uncompressed_total > _ZIP_MAX_UNCOMPRESSED_BYTES:
                    return UploadValidationResult(ok=False, error="Bestand is te groot na uitpakken.")

            if compressed_total > 0 and (uncompressed_total / compressed_total) > _ZIP_MAX_RATIO:
                return UploadValidationResult(ok=False, error="Bestand heeft een onveilige compressieverhouding.")
    except zipfile.BadZipFile:
        return UploadValidationResult(ok=False, error="Bestandsinhoud is geen geldig .xlsx-formaat.")

    return UploadValidationResult(ok=True)

