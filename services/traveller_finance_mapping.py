"""
Mapping van Excel/ExcelRow (Bookings-sheet) naar kolommen voor `public.reiziger_financien`.

Boeking-niveau financiën horen in `boeking_financien` (zie import_bookings in supabase_service).

Betalingsherinneringen staan in Excel op boekingsrij-niveau; bij meerdere reizigers onder dezelfde
order krijgt elke reiziger dezelfde geïmporteerde herinneringsaantallen (Excel is per rij/reiziger
maar de kolommen zijn semantisch boekingbreed).
"""
from __future__ import annotations

from typing import Any

from services.excel_parser import ExcelRow


def map_traveller_finance_from_excel_row(tr: ExcelRow) -> dict[str, Any]:
    """
    Velden zijn in ExcelRow al geparst (nummers/booleans); hier alleen DB-kolomnamen.
    """
    return {
        "totaal_te_betalen": tr.totaal_te_betalen,
        "reeds_betaald": tr.reeds_betaald,
        "nog_te_betalen": tr.nog_te_betalen,
        "package_prijs": tr.package_prijs,
        "transfer_prijs": tr.transfer_prijs,
        "bagage_prijs": tr.bagage_prijs,
        "vlucht_heen_prijs": tr.vlucht_heen_prijs,
        "vlucht_terug_prijs": tr.vlucht_terug_prijs,
        "prijs_annulatieverzekering": tr.prijs_annulatieverzekering,
        "prijs_reisverzekering": tr.prijs_reisverzekering,
        "prijs_annulatie_en_reisverzekering": tr.prijs_annulatie_en_reisverzekering,
        "heeft_annulatieverzekering": tr.heeft_annulatieverzekering,
        "heeft_reisverzekering": tr.heeft_reisverzekering,
        "heeft_annulatie_en_reisverzekering": tr.heeft_annulatie_en_reisverzekering,
        # Boeking_financien bevat de som over reizigers; hier de Excel-waarde per rij.
        "toeristenbelasting_te_betalen": tr.toeristenbelasting_te_betalen,
        "kost_accommodatie": tr.kost_accommodatie,
        "kost_transport": tr.kost_transport,
        "kost_transfer": tr.kost_transfer,
        "kost_extra_kosten": tr.kost_extra_kosten,
        "discount_amount": tr.discount_amount,
        "discount_code_used": tr.gebruikte_kortingscode,
        "aantal_voorschotbetalingsherinneringen": tr.aantal_voorschotbetalingsherinneringen,
        "aantal_totaalbetalingsherinneringen": tr.aantal_totaalbetalingsherinneringen,
    }
