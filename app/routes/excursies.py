from __future__ import annotations

from typing import Any, Callable
import time

from flask import request

from services.rbac import AppRole, is_restricted_role
from services.supabase_service import SupabaseService, SupabaseServiceError


def register_excursies_routes(
    bp,
    *,
    json_response_ok: Callable[..., Any],
    dependency_error_response: Callable[..., Any],
    build_request_id: Callable[[], str],
    parse_money_value: Callable[..., float | None],
    mock_excursies_payload: Callable[..., dict[str, Any]],
    session_user_role: Callable[[], AppRole],
    resolve_year_for_session: Callable[..., int],
    logger,
) -> None:
    @bp.route("/excursies", methods=["GET"])
    def excursies() -> str:
        from flask import render_template

        return render_template("dashboard/excursies.html")

    @bp.route("/excursies/options", methods=["GET"])
    def excursies_options():
        """Filters: brands, jaren, bestemmingen, landen, excursienamen, vaste betaalopties."""
        supabase = SupabaseService()
        try:
            brands = supabase.get_data_verzameling_brands()
            bestemmingen = supabase.get_data_verzameling_bestemmingen()
            landen = supabase.get_data_verzameling_landen()
            years_raw = supabase.get_overzicht_years_rpc("__all__")
            years: list[int] = []
            for y in years_raw:
                if y is None:
                    continue
                try:
                    years.append(int(y))
                except (TypeError, ValueError):
                    continue
            years = sorted(set(years), reverse=True)
            if is_restricted_role(session_user_role()):
                years = [resolve_year_for_session(None)]
            ex_filter_rows = supabase.get_excursies_master_for_filters()
            ex_manage_rows = supabase.get_excursies_for_management()
            excursie_filters: list[dict[str, str]] = []
            names_legacy: set[str] = set()
            for r in ex_filter_rows:
                naam = str(r.get("naam") or "").strip()
                key = str(r.get("filter_key") or "").strip()
                label = str(r.get("label") or naam).strip()
                if not naam or not key:
                    continue
                names_legacy.add(naam)
                excursie_filters.append(
                    {
                        "key": key,
                        "naam": naam,
                        "bestemming_naam": str(r.get("bestemming_naam") or "").strip(),
                        "label": label,
                    }
                )
            return {
                "brands": brands,
                "bestemmingen": bestemmingen,
                "landen": landen,
                "years": years,
                "excursie_namen": sorted(names_legacy),
                "excursie_filters": excursie_filters,
                "betaalopties": ["cash", "mollie", "overschrijving", "free"],
                "excursies_beheer": ex_manage_rows,
            }
        except SupabaseServiceError as e:
            return dependency_error_response(
                log_message="excursies_options dependency failure",
                exc=e,
                user_message="Excursies-opties tijdelijk niet beschikbaar.",
                extra={
                    "brands": [],
                    "bestemmingen": [],
                    "landen": [],
                    "years": [],
                    "excursie_namen": [],
                    "excursie_filters": [],
                    "betaalopties": ["cash", "mollie", "overschrijving", "free"],
                    "excursies_beheer": [],
                },
            )

    @bp.route("/excursies/data", methods=["GET"])
    def excursies_data():
        """
        Excursieregels voor client-side aggregatie (geen cancelled boekingen in SQL).
        Query: brand, destination, land, year, excursie.
        Query: exc_debug=1 — voegt meta.debug toe en logt ruwe RPC-samenvatting (serverlog).
        """
        brand = (request.args.get("brand") or "__all__").strip() or "__all__"
        destination_raw = (request.args.get("destination") or "").strip()
        destination_values = [x.strip() for x in destination_raw.split(",") if x.strip()]
        destination = destination_values[0] if len(destination_values) == 1 else None
        land_raw = (request.args.get("land") or "__all__").strip() or "__all__"
        land = None if land_raw in ("", "__all__") else land_raw
        year = request.args.get("year", type=int)
        if year is None:
            year = 0
        year = resolve_year_for_session(year)
        excursie_raw = (request.args.get("excursie") or "").strip()
        excursie_values = [x.strip() for x in excursie_raw.split(",") if x.strip()]
        excursie = excursie_values[0] if len(excursie_values) == 1 else None
        if excursie and "\u0001" in excursie:
            split_naam, split_bestemming = excursie.split("\u0001", 1)
            excursie = split_naam.strip() or None
            if not destination:
                destination = split_bestemming.strip() or None
        exc_debug = (request.args.get("exc_debug") or "").strip().lower() in ("1", "true", "yes")

        try:
            t0 = time.perf_counter()
            logger.info("excursies_data route entered")
            supabase = SupabaseService()
            payload = supabase.excursies_lines_rpc(
                brand=brand,
                bestemming_naam=destination,
                land=land,
                year=int(year),
                excursie_naam=excursie,
                exc_debug=exc_debug,
            )
            if len(destination_values) > 1 or len(excursie_values) > 1:
                rows = payload.get("rows") if isinstance(payload.get("rows"), list) else []
                destination_wanted = {d.casefold() for d in destination_values}
                excursie_wanted = {e for e in excursie_values}
                def _row_excursie_keys(row: dict[str, Any]) -> set[str]:
                    naam = str(row.get("excursie_naam") or "").strip()
                    best = str(row.get("destination") or row.get("bestemming_naam") or "").strip()
                    keys: set[str] = set()
                    if naam:
                        keys.add(naam)
                        keys.add(f"{naam}\u0001{best}" if best else naam)
                    return keys
                filtered_rows = []
                for row in rows:
                    r = row if isinstance(row, dict) else {}
                    if destination_wanted:
                        dest_name = str(r.get("destination") or r.get("bestemming_naam") or "").strip().casefold()
                        if dest_name not in destination_wanted:
                            continue
                    if excursie_wanted:
                        row_keys = _row_excursie_keys(r)
                        if not any(k in excursie_wanted for k in row_keys):
                            continue
                    filtered_rows.append(row)
                payload = {**payload, "rows": filtered_rows}
            rows = payload.get("rows") if isinstance(payload.get("rows"), list) else []
            logger.info(
                "excursies_data done rows=%s brand=%s destination=%s land=%s year=%s excursie=%s exc_debug=%s duration_ms=%s",
                len(rows),
                brand,
                destination,
                land,
                int(year),
                excursie,
                exc_debug,
                int((time.perf_counter() - t0) * 1000),
            )
            if exc_debug:
                meta = payload.get("meta") if isinstance(payload.get("meta"), dict) else {}
                dbg = {
                    "row_count": len(rows),
                    "payload_top_keys": list(payload.keys()) if isinstance(payload, dict) else [],
                    "first_row_keys": list(rows[0].keys()) if rows else [],
                    "first_rows_preview": rows[:3],
                    "request_query_args": dict(request.args),
                    "effective_filters": {
                        "brand": brand,
                        "destination": destination,
                        "land": land,
                        "year": int(year),
                        "excursie": excursie,
                    },
                }
                meta = {**meta, "debug": dbg}
                payload["meta"] = meta
                _qs_raw = getattr(request, "query_string", None) or b""
                _qs = (
                    _qs_raw.decode("utf-8", errors="replace")
                    if isinstance(_qs_raw, (bytes, bytearray))
                    else str(_qs_raw or "")
                )
                logger.info(
                    "excursies_data DEBUG row_count=%s first_row_keys=%s query=%s",
                    dbg["row_count"],
                    dbg["first_row_keys"],
                    _qs,
                )
            return json_response_ok(payload)
        except SupabaseServiceError as e:
            err = str(e)
            if "PGRST202" in err or "Could not find the function" in err:
                mock = mock_excursies_payload(year=int(year))
                mock.setdefault("meta", {})
                if isinstance(mock["meta"], dict):
                    mock["meta"]["fallback"] = "mock"
                    mock["meta"]["error_hint"] = "Excursies-RPC niet beschikbaar; fallback-data actief."
                    mock["meta"].setdefault("total_pax_pool", 480)
                logger.exception("excursies_data dependency fallback to mock", exc_info=e)
                return json_response_ok(mock)
            return dependency_error_response(
                log_message="excursies_data dependency failure",
                exc=e,
                user_message="Excursies-data tijdelijk niet beschikbaar.",
                extra={"rows": [], "meta": {}},
            )
        except Exception:  # noqa: BLE001
            request_id = build_request_id()
            logger.exception("excursies_data request_id=%s", request_id)
            return json_response_ok(
                {
                    "error": "Excursies-data tijdelijk niet beschikbaar.",
                    "request_id": request_id,
                    "rows": [],
                    "meta": {},
                },
                status=500,
            )

    @bp.route("/excursies/manage", methods=["POST"])
    def excursies_manage():
        """
        Beheer-endpoint voor Excursies:
        - mode=update_existing: bestaande excursie aanvullen met verkoopprijs + commissie(/%) en automatische inkoop.
        """
        payload = request.get_json(silent=True) or {}
        mode = str(payload.get("mode") or "").strip().lower()
        supabase = SupabaseService()

        try:
            if mode == "update_existing":
                excursie_id = str(payload.get("excursie_id") or "").strip()
                if not excursie_id:
                    return json_response_ok({"error": "Selecteer een bestaande excursie."}, status=400)

                verkoopprijs_raw = payload.get("verkoopprijs")
                commissie_raw = payload.get("commissie")
                kostjaar_raw = payload.get("jaar")
                commissie_percentage = parse_money_value(
                    payload.get("commissie_percentage"),
                    field="Commissiepercentage",
                    required=False,
                    allow_null=True,
                )
                kostjaar = None
                if kostjaar_raw not in (None, ""):
                    try:
                        kostjaar = int(str(kostjaar_raw).strip())
                    except ValueError as exc:
                        raise ValueError("Jaar moet een geldig getal zijn.") from exc
                    if kostjaar < 2000 or kostjaar > 2100:
                        raise ValueError("Jaar moet tussen 2000 en 2100 liggen.")
                verkoopprijs = parse_money_value(verkoopprijs_raw, field="Verkoopprijs", required=True, allow_null=False)
                commissie = parse_money_value(commissie_raw, field="Commissie", required=False, allow_null=True)

                if verkoopprijs is None:
                    return json_response_ok({"error": "Verkoopprijs is verplicht."}, status=400)
                if commissie is None and commissie_percentage is None:
                    return json_response_ok({"error": "Geef commissie als bedrag of percentage op."}, status=400)
                if commissie_percentage is not None and not (0 <= commissie_percentage <= 100):
                    return json_response_ok({"error": "Commissiepercentage moet tussen 0 en 100 liggen."}, status=400)

                if commissie is None and commissie_percentage is not None:
                    commissie = (verkoopprijs * commissie_percentage) / 100.0
                if commissie is None:
                    commissie = 0.0
                if commissie > verkoopprijs:
                    return json_response_ok({"error": "Commissie kan niet hoger zijn dan de verkoopprijs."}, status=400)
                # Canonicaliseer: percentage volgt altijd uit het commissiebedrag.
                commissie_percentage = 0.0 if verkoopprijs == 0 else (commissie / verkoopprijs) * 100.0

                inkoopprijs = verkoopprijs - commissie
                updated = supabase.update_excursie_pricing(
                    excursie_id=excursie_id,
                    verkoopprijs=verkoopprijs,
                    inkoopprijs=inkoopprijs,
                    commissie=commissie,
                    commissie_percentage=commissie_percentage,
                    jaar=kostjaar,
                )
                return json_response_ok({"ok": True, "mode": mode, "excursie": updated})

            return json_response_ok({"error": "Ongeldige mode. Gebruik update_existing."}, status=400)
        except ValueError as e:
            logger.warning("excursies_manage validation failure: %s", e)
            return json_response_ok({"error": "Ongeldige invoer voor excursiebeheer."}, status=400)
        except SupabaseServiceError as e:
            return dependency_error_response(
                log_message="excursies_manage dependency failure",
                exc=e,
                user_message="Excursiebeheer tijdelijk niet beschikbaar.",
            )
        except Exception:  # noqa: BLE001
            request_id = build_request_id()
            logger.exception("excursies_manage request_id=%s", request_id)
            return json_response_ok(
                {
                    "error": "Excursie opslaan mislukt.",
                    "request_id": request_id,
                },
                status=500,
            )
