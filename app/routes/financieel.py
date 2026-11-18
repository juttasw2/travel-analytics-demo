from __future__ import annotations

from typing import Any, Callable

from flask import jsonify, render_template, request

from services.supabase_service import SupabaseService, SupabaseServiceError
from services.rbac import AppRole, is_restricted_role


def register_financieel_routes(
    bp,
    *,
    json_response_ok: Callable[..., Any],
    dependency_error_response: Callable[..., Any],
    build_request_id: Callable[[], str],
    get_request_csrf_token: Callable[[], str],
    is_valid_csrf_token: Callable[[str], bool],
    parse_money_value: Callable[..., float | None],
    session_user_role: Callable[[], AppRole],
    is_api_request: Callable[[], bool],
    resolve_year_for_session: Callable[..., int],
    logger,
) -> None:
    @bp.route("/financieel", methods=["GET"])
    def financieel() -> str:
        return render_template("dashboard/financieel.html")

    def _deny_for_restricted_role():
        if not is_restricted_role(session_user_role()):
            return None
        if is_api_request():
            return jsonify({"error": "Geen toegang tot deze route voor jouw accountrol."}), 403
        return render_template("dashboard/overzicht.html")

    @bp.route("/financieel/options", methods=["GET"])
    def financieel_options():
        """Brands, bestemmingen en vertrek-jaren voor Financiën-filters."""
        denied = _deny_for_restricted_role()
        if denied is not None:
            return denied
        supabase = SupabaseService()
        try:
            brands = supabase.get_data_verzameling_brands()
            bestemmingen = supabase.get_data_verzameling_bestemmingen()
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
            return {
                "brands": brands,
                "bestemmingen": bestemmingen,
                "years": years,
                "countries": ["BE", "NL", "DE", "FR", "OTHER"],
            }
        except SupabaseServiceError as e:
            return dependency_error_response(
                log_message="financieel_options dependency failure",
                exc=e,
                user_message="Financieel opties tijdelijk niet beschikbaar.",
                extra={"brands": [], "bestemmingen": [], "years": [], "countries": []},
            )

    @bp.route("/financieel/data", methods=["GET"])
    def financieel_data():
        """
        Alle boekingen voor de financiële cockpit (niet-geannuleerd in SQL).
        Query: brand, destination (naam), land, year (0 = alle jaren), period.
        """
        denied = _deny_for_restricted_role()
        if denied is not None:
            return denied
        brand = (request.args.get("brand") or "__all__").strip() or "__all__"
        destination_raw = (request.args.get("destination") or "").strip()
        destination_values = [x.strip() for x in destination_raw.split(",") if x.strip()]
        destination = destination_values[0] if len(destination_values) == 1 else None
        land_raw = (request.args.get("land") or "__all__").strip() or "__all__"
        land = None if land_raw in ("", "__all__") else land_raw
        year = resolve_year_for_session(request.args.get("year", type=int))
        period = (request.args.get("period") or "all").strip().lower() or "all"

        try:
            supabase = SupabaseService()
            payload = supabase.financieel_bookings_rpc(
                brand=brand,
                bestemming_naam=destination,
                land=land,
                year=int(year),
                period=period,
            )
            if len(destination_values) > 1:
                wanted = {d.casefold() for d in destination_values}
                rows = payload.get("rows") if isinstance(payload.get("rows"), list) else []
                filtered_rows = [
                    r
                    for r in rows
                    if str((r or {}).get("destination") or (r or {}).get("bestemming_naam") or "").strip().casefold()
                    in wanted
                ]
                booking_ids = {str((r or {}).get("booking_id") or "").strip() for r in filtered_rows}
                booking_ids.discard("")
                travellers = (
                    payload.get("payment_travellers") if isinstance(payload.get("payment_travellers"), list) else []
                )
                filtered_travellers = [
                    t for t in travellers if str((t or {}).get("booking_id") or "").strip() in booking_ids
                ]
                payload = {**payload, "rows": filtered_rows, "payment_travellers": filtered_travellers}
            return json_response_ok(payload)
        except SupabaseServiceError as e:
            return dependency_error_response(
                log_message="financieel_data dependency failure",
                exc=e,
                user_message="Financiën-data tijdelijk niet beschikbaar.",
                extra={"rows": []},
            )
        except Exception:  # noqa: BLE001
            request_id = build_request_id()
            logger.exception("financieel_data request_id=%s", request_id)
            return json_response_ok(
                {
                    "error": "Financiën-data tijdelijk niet beschikbaar. Controleer serverlogs en Supabase-RPC.",
                    "request_id": request_id,
                    "rows": [],
                },
                status=500,
            )

    @bp.route("/financieel/jouw-verblijf-kost", methods=["POST"])
    def financieel_jouw_verblijf_kost():
        denied = _deny_for_restricted_role()
        if denied is not None:
            return denied
        """
        Handmatige kost op boekingsniveau voor accommodaties "jouw verblijf in*".
        De kost wordt backend-side verdeeld over reizigers en opgeslagen in
        `reiziger_financien.kost_accommodatie` (per reiziger).
        """
        csrf_token = get_request_csrf_token()
        if not is_valid_csrf_token(csrf_token):
            return json_response_ok({"error": "Sessiebeveiliging mislukt. Vernieuw de pagina en probeer opnieuw."}, status=400)

        payload = request.get_json(silent=True) or {}
        booking_id = str(payload.get("booking_id") or "").strip()
        if not booking_id:
            return json_response_ok({"error": "booking_id is verplicht."}, status=400)

        try:
            totale_kost = parse_money_value(
                payload.get("totale_kost"),
                field="Totale kost",
                required=True,
                allow_null=False,
            )
            if totale_kost is None:
                return json_response_ok({"error": "Totale kost is verplicht."}, status=400)

            supabase = SupabaseService()
            ctx = supabase.get_boeking_cost_edit_context(booking_id=booking_id)
            if not ctx:
                return json_response_ok({"error": "Boeking niet gevonden."}, status=404)

            accom_name = str(ctx.get("accommodatie_naam") or "").strip().lower()
            if not accom_name.startswith("jouw verblijf in"):
                return json_response_ok(
                    {"error": "Handmatige kost kan alleen voor accommodaties die starten met 'jouw verblijf in'."},
                    status=400,
                )

            result = supabase.set_kost_accommodatie_for_booking_reizigers(
                booking_id=booking_id,
                totale_kost=float(totale_kost),
            )
            return json_response_ok(
                {
                    "ok": True,
                    "booking_id": booking_id,
                    "order_nummer": str(ctx.get("order_nummer") or ""),
                    "totale_kost": result.get("totale_kost"),
                    "traveller_count": result.get("traveller_count"),
                }
            )
        except ValueError as e:
            logger.warning("financieel_jouw_verblijf_kost validation failure: %s", e)
            return json_response_ok({"error": "Ongeldige invoer voor handmatige kost."}, status=400)
        except SupabaseServiceError as e:
            return dependency_error_response(
                log_message="financieel_jouw_verblijf_kost dependency failure",
                exc=e,
                user_message="Opslaan van handmatige kost tijdelijk niet beschikbaar.",
            )
        except Exception:  # noqa: BLE001
            request_id = build_request_id()
            logger.exception("financieel_jouw_verblijf_kost request_id=%s", request_id)
            return json_response_ok(
                {
                    "error": "Opslaan van handmatige kost mislukt.",
                    "request_id": request_id,
                },
                status=500,
            )

    @bp.route("/financieel/leveranciers-data", methods=["GET"])
    def financieel_leveranciers_data():
        """Aggregatie bestemming × accommodatieleverancier + detail per accommodatie (zelfde filters als /financieel/data)."""
        denied = _deny_for_restricted_role()
        if denied is not None:
            return denied
        brand = (request.args.get("brand") or "__all__").strip() or "__all__"
        destination = (request.args.get("destination") or "").strip() or None
        land_raw = (request.args.get("land") or "__all__").strip() or "__all__"
        land = None if land_raw in ("", "__all__") else land_raw
        year = resolve_year_for_session(request.args.get("year", type=int))
        period = (request.args.get("period") or "all").strip().lower() or "all"

        try:
            supabase = SupabaseService()
            payload = supabase.leveranciers_analyse_rpc(
                brand=brand,
                bestemming_naam=destination,
                land=land,
                year=int(year),
                period=period,
            )
            return json_response_ok(payload)
        except SupabaseServiceError as e:
            return dependency_error_response(
                log_message="financieel_leveranciers_data dependency failure",
                exc=e,
                user_message="Leveranciers-data tijdelijk niet beschikbaar.",
                extra={"summary": [], "details": []},
            )
        except Exception:  # noqa: BLE001
            request_id = build_request_id()
            logger.exception("financieel_leveranciers_data request_id=%s", request_id)
            return json_response_ok(
                {
                    "error": "Leveranciers-data tijdelijk niet beschikbaar.",
                    "request_id": request_id,
                    "summary": [],
                    "details": [],
                },
                status=500,
            )

    @bp.route("/inzichten/verliezen/options", methods=["GET"])
    def inzichten_verliezen_options():
        denied = _deny_for_restricted_role()
        if denied is not None:
            return denied
        try:
            supabase = SupabaseService()
            brands = supabase.get_data_verzameling_brands()
            bestemmingen = supabase.get_data_verzameling_bestemmingen()
            transporten = supabase.get_data_verzameling_transporten()
            years_raw = supabase.get_overzicht_years_rpc("__all__")
            years: list[int] = []
            for y in years_raw:
                try:
                    years.append(int(y))
                except (TypeError, ValueError):
                    continue
            years = sorted(set(years), reverse=True)
            return json_response_ok(
                {
                    "brands": brands,
                    "bestemmingen": bestemmingen,
                    "transporten": transporten,
                    "years": years,
                }
            )
        except SupabaseServiceError as e:
            return dependency_error_response(
                log_message="inzichten_verliezen_options dependency failure",
                exc=e,
                user_message="Verliezen-opties tijdelijk niet beschikbaar.",
                extra={
                    "brands": [],
                    "bestemmingen": [],
                    "transporten": [],
                    "years": [],
                },
            )

    @bp.route("/inzichten/verliezen/data", methods=["GET"])
    def inzichten_verliezen_data():
        denied = _deny_for_restricted_role()
        if denied is not None:
            return denied

        brand = (request.args.get("brand") or "__all__").strip() or "__all__"
        bestemming_id = (request.args.get("bestemming_id") or "").strip() or None
        bestemming_naam = (request.args.get("bestemming_naam") or "").strip() or None
        year = resolve_year_for_session(request.args.get("year", type=int))
        transport_id = (request.args.get("transport_id") or "").strip() or None

        try:
            supabase = SupabaseService()
            payload = supabase.inzichten_verliezen_rpc(
                brand=brand,
                bestemming_id=bestemming_id,
                bestemming_naam=bestemming_naam,
                year=int(year),
                transport_id=transport_id,
            )
            rows = payload.get("rows") if isinstance(payload.get("rows"), list) else []
            logger.info(
                "inzichten_verliezen_data rows=%s brand=%s bestemming_id=%s year=%s transport_id=%s",
                len(rows),
                brand,
                bestemming_id,
                int(year),
                transport_id,
            )
            return json_response_ok(payload)
        except SupabaseServiceError as e:
            return dependency_error_response(
                log_message="inzichten_verliezen_data dependency failure",
                exc=e,
                user_message="Verliezen-data tijdelijk niet beschikbaar.",
                extra={
                    "summary": {},
                    "by_destination": [],
                    "by_period": [],
                    "by_group_size": [],
                    "by_discount_code": [],
                    "cost_breakdown": {},
                    "rows": [],
                },
            )
        except Exception:  # noqa: BLE001
            request_id = build_request_id()
            logger.exception("inzichten_verliezen_data request_id=%s", request_id)
            return json_response_ok(
                {
                    "error": "Verliezen-data tijdelijk niet beschikbaar.",
                    "request_id": request_id,
                    "summary": {},
                    "by_destination": [],
                    "by_period": [],
                    "by_group_size": [],
                    "by_discount_code": [],
                    "cost_breakdown": {},
                    "rows": [],
                },
                status=500,
            )
