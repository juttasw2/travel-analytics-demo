from __future__ import annotations

from pathlib import Path
from typing import Any, List
import hashlib
import hmac
import json
import logging
import os
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import calendar

from datetime import date, timedelta
from collections import defaultdict, Counter
import time

from flask import (
    Blueprint,
    Response,
    current_app,
    flash,
    g,
    jsonify,
    make_response,
    redirect,
    render_template,
    request,
    session,
    url_for,
)
from services.supabase_service import SupabaseService, SupabaseServiceError
from services.upload_jobs import UploadJobQueue
from services.bestemmingen_dashboard import apply_secondary_filters, build_dashboard_from_destinations
from services.bestemmingen_periodes import (
    aggregate_payload,
    effective_donut_brand,
    effective_kp_donut_brand,
    traveler_origin_donut_payload,
)
from services.klantenprofiel import enrich_klantenprofiel_payload
from services.excursies_mock import mock_excursies_lines_payload
from services.pre_boekingen_service import parse_vlucht_allotment_excel
from app.routes.auth import register_auth_routes
from app.routes.excursies import register_excursies_routes
from app.routes.financieel import register_financieel_routes
from app.routes.upload import register_upload_routes
from services.rbac import AppRole, is_restricted_role, normalize_app_role, resolve_allowed_year


dashboard_bp = Blueprint(
    "dashboard",
    __name__,
    template_folder=str(Path(__file__).resolve().parents[1] / "templates"),
)
logger = logging.getLogger(__name__)
_options_cache: dict[str, tuple[float, dict]] = {}
_OPTIONS_TTL_SECONDS = 600.0
_OPTIONS_CACHE_MAX_ENTRIES = 200
_AUTH_EXEMPT_ENDPOINTS = frozenset(
    {
        "dashboard.login",
        "dashboard.mfa",
        "dashboard.logout",
    }
)
# Routes zonder volledige app-toestemming: login, MFA-stap, uitloggen, meldingspagina.
_ACCESS_EXEMPT_ENDPOINTS = frozenset(
    {
        "dashboard.login",
        "dashboard.mfa",
        "dashboard.logout",
        "dashboard.pending_access",
    }
)
_VERSIE_B_BLOCKED_ENDPOINTS = frozenset(
    {
        "dashboard.financieel",
        "dashboard.financieel_options",
        "dashboard.financieel_data",
        "dashboard.financieel_jouw_verblijf_kost",
        "dashboard.financieel_leveranciers_data",
        "dashboard.tijdsvergelijkingen",
        "dashboard.tijdsvergelijkingen_options",
        "dashboard.tijdsvergelijkingen_years",
        "dashboard.tijdsvergelijkingen_data",
        "dashboard.inzichten",
    }
)
_LOGIN_RATE_LIMIT_WINDOW_SECONDS = 15 * 60
_LOGIN_RATE_LIMIT_MAX_ATTEMPTS = 8
_LOGIN_RATE_LIMIT_BLOCK_SECONDS = 15 * 60
_login_attempts: dict[str, dict[str, float | int]] = {}

# Korte TTL voor /bestemmingen/dashboard (herhaalde navigatie sneller; geen lange stale data).
_dashboard_cache: dict[str, tuple[float, dict]] = {}
_DASHBOARD_CACHE_TTL_SECONDS = 90.0
_DASHBOARD_CACHE_MAX_ENTRIES = 200


def _env_positive_int(name: str, default: int, min_value: int = 1) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        parsed = int(raw.strip())
    except (TypeError, ValueError):
        return default
    return max(min_value, parsed)


_UPLOAD_JOB_WORKERS = _env_positive_int("UPLOAD_JOB_WORKERS", default=1, min_value=1)
_UPLOAD_JOB_RETENTION_SECONDS = _env_positive_int(
    "UPLOAD_JOB_RETENTION_SECONDS", default=24 * 60 * 60, min_value=600
)
_UPLOAD_JOB_MAX_TRACKED = _env_positive_int("UPLOAD_JOB_MAX_TRACKED", default=500, min_value=100)
_upload_jobs = UploadJobQueue(
    max_workers=_UPLOAD_JOB_WORKERS,
    retention_seconds=_UPLOAD_JOB_RETENTION_SECONDS,
    max_tracked_jobs=_UPLOAD_JOB_MAX_TRACKED,
)


def _get_cached_options(cache_key: str) -> dict | None:
    cached = _options_cache.get(cache_key)
    if not cached:
        return None
    expires_at, payload = cached
    if time.time() > expires_at:
        _options_cache.pop(cache_key, None)
        return None
    return payload


def _set_cached_options(cache_key: str, payload: dict) -> None:
    if cache_key not in _options_cache and len(_options_cache) >= _OPTIONS_CACHE_MAX_ENTRIES:
        oldest_key = next(iter(_options_cache), None)
        if oldest_key is not None:
            _options_cache.pop(oldest_key, None)
    _options_cache[cache_key] = (time.time() + _OPTIONS_TTL_SECONDS, payload)


def _bestemmingen_dashboard_cache_key() -> str:
    """Stabiele cache-sleutel op basis van querystring (volgorde onafhankelijk)."""
    pairs = sorted(request.args.items(multi=True))
    raw = json.dumps(pairs, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return "bestemmingen_dashboard|" + hashlib.sha256(raw).hexdigest()


def _get_cached_dashboard(cache_key: str) -> dict | None:
    cached = _dashboard_cache.get(cache_key)
    if not cached:
        return None
    expires_at, payload = cached
    if time.time() > expires_at:
        _dashboard_cache.pop(cache_key, None)
        return None
    return payload


def _set_cached_dashboard(cache_key: str, payload: dict) -> None:
    if cache_key not in _dashboard_cache and len(_dashboard_cache) >= _DASHBOARD_CACHE_MAX_ENTRIES:
        oldest_key = next(iter(_dashboard_cache), None)
        if oldest_key is not None:
            _dashboard_cache.pop(oldest_key, None)
    _dashboard_cache[cache_key] = (time.time() + _DASHBOARD_CACHE_TTL_SECONDS, payload)


def _bestemmingen_data_http_response(
    payload: dict,
    *,
    path: str,
    started: float,
    scope: str,
    cache: str,
) -> Response:
    elapsed_ms = (time.perf_counter() - started) * 1000
    try:
        nbytes = len(json.dumps(payload, default=str))
    except (TypeError, ValueError):
        nbytes = 0
    resp = make_response(jsonify(payload))
    resp.headers["X-Bestemmingen-Data-Path"] = path
    resp.headers["X-Bestemmingen-Data-Scope"] = scope
    resp.headers["X-Bestemmingen-Cache"] = cache
    resp.headers["X-Response-Time-Ms"] = f"{elapsed_ms:.1f}"
    resp.headers["X-Payload-Bytes"] = str(nbytes)
    return resp


def _is_api_request() -> bool:
    # Financiën JSON-endpoints (ook onder APPLICATION_ROOT / subpad, bv. /app/financieel/data).
    if "/financieel/" in request.path and (
        request.path.endswith("/options")
        or request.path.endswith("/data")
        or request.path.endswith("/leveranciers-data")
        or request.path.endswith("/jouw-verblijf-kost")
    ):
        return True
    if "/excursies/" in request.path and (
        request.path.endswith("/options") or request.path.endswith("/data") or request.path.endswith("/manage")
    ):
        return True
    if request.path.endswith("/options") or request.path.endswith("/data"):
        return True
    if request.path.endswith("/years") or "/detail/" in request.path:
        return True
    if request.path.endswith("/list") or request.path.endswith("/brands"):
        return True
    if request.path.endswith("/boekingentrends-data") or request.path.endswith("/heatmap-month"):
        return True
    if "/bestemmingen/periodes-" in request.path:
        return True
    if "/dagtrends/" in request.path or "/tijdsvergelijkingen/" in request.path:
        return True
    if "/klantenprofiel/" in request.path:
        return True
    if "application/json" in request.headers.get("Accept", ""):
        return True
    return request.headers.get("X-Requested-With") == "XMLHttpRequest"


def _build_request_id() -> str:
    return request.headers.get("X-Request-Id") or f"req-{uuid4()}"


def _safe_relative_redirect_path(raw: str | None) -> str | None:
    """
    Alleen interne pad-redirects na login. Blokkeert open redirects (//evil) en backslash-paden.
    """
    p = (raw or "").strip()
    if not p.startswith("/") or p.startswith("//"):
        return None
    if "\\" in p or "\x00" in p:
        return None
    return p


def _get_request_csrf_token() -> str:
    token = request.headers.get("X-CSRF-Token") or request.form.get("csrf_token") or ""
    return str(token).strip()


def _is_valid_csrf_token(token: str) -> bool:
    if not current_app.config.get("ENABLE_CSRF_PROTECTION", True):
        return True
    expected = str(session.get("csrf_token") or "")
    if not token or not expected:
        return False
    return hmac.compare_digest(token, expected)


def _get_client_ip() -> str:
    forwarded = request.headers.get("X-Forwarded-For", "")
    if forwarded:
        first = forwarded.split(",")[0].strip()
        if first:
            return first
    return (request.remote_addr or "unknown").strip() or "unknown"


def _login_rate_limit_state(key: str) -> dict[str, float | int]:
    now = time.time()
    state = _login_attempts.get(key)
    if not state:
        state = {"count": 0, "window_start": now, "blocked_until": 0.0}
        _login_attempts[key] = state
        return state
    blocked_until = float(state.get("blocked_until", 0.0))
    window_start = float(state.get("window_start", 0.0))
    if blocked_until and blocked_until <= now:
        state["blocked_until"] = 0.0
    if now - window_start > _LOGIN_RATE_LIMIT_WINDOW_SECONDS:
        state["window_start"] = now
        state["count"] = 0
    return state


def _is_rate_limited(keys: list[str]) -> tuple[bool, int]:
    now = time.time()
    retry_after = 0
    for key in keys:
        state = _login_rate_limit_state(key)
        blocked_until = float(state.get("blocked_until", 0.0))
        if blocked_until > now:
            retry_after = max(retry_after, int(blocked_until - now))
    return retry_after > 0, retry_after


def _register_login_failure(keys: list[str]) -> None:
    now = time.time()
    for key in keys:
        state = _login_rate_limit_state(key)
        state["count"] = int(state.get("count", 0)) + 1
        if int(state["count"]) >= _LOGIN_RATE_LIMIT_MAX_ATTEMPTS:
            state["blocked_until"] = now + _LOGIN_RATE_LIMIT_BLOCK_SECONDS
            state["count"] = 0
            state["window_start"] = now


def _clear_login_failures(keys: list[str]) -> None:
    for key in keys:
        _login_attempts.pop(key, None)


def _session_user_has_access_effective() -> bool:
    """Mag deze sessie het dashboard gebruiken? Waarde komt uit login (database)."""
    if not session.get("user_id"):
        return False
    v = session.get("user_has_access")
    if v is None:
        # Oude sessie vóór introductie van user_has_access: geen lockout bij uitrol;
        # na opnieuw inloggen staat de echte waarde uit de database in de sessie.
        return True
    return bool(v)


def _session_user_role() -> AppRole:
    return normalize_app_role(session.get("user_role"))


def _is_versie_b_session() -> bool:
    return is_restricted_role(_session_user_role())


def _resolve_year_for_session(
    raw_year: int | None,
    *,
    allow_previous_year: bool = False,
) -> int:
    policy = resolve_allowed_year(
        requested_year=raw_year,
        role=_session_user_role(),
        allow_previous_year=allow_previous_year,
    )
    return int(policy.year)


@dashboard_bp.before_app_request
def _require_login() -> Response | None:
    if request.endpoint == "static":
        return None
    if request.endpoint is None:
        return None
    if request.endpoint in _AUTH_EXEMPT_ENDPOINTS:
        return None
    if not request.endpoint.startswith("dashboard."):
        return None

    user_id = session.get("user_id")
    user_email = session.get("user_email")
    if user_id and user_email:
        g.current_user_email = str(user_email)
        return None

    if _is_api_request():
        return jsonify({"error": "Niet ingelogd. Meld je aan om verder te gaan."}), 401
    return redirect(url_for("dashboard.login", next=request.path))


@dashboard_bp.before_app_request
def _require_app_access() -> Response | None:
    if request.endpoint == "static":
        return None
    if request.endpoint is None:
        return None
    if not request.endpoint.startswith("dashboard."):
        return None
    if request.endpoint in _ACCESS_EXEMPT_ENDPOINTS:
        return None
    if not session.get("user_id"):
        return None
    if _session_user_has_access_effective():
        return None
    if _is_api_request():
        return (
            jsonify(
                {
                    "error": "Momenteel heb je geen toestemming voor deze applicatie. "
                    "Neem contact op met een beheerder.",
                }
            ),
            403,
        )
    return redirect(url_for("dashboard.pending_access"))


@dashboard_bp.before_app_request
def _require_role_route_access() -> Response | None:
    if request.endpoint == "static":
        return None
    if request.endpoint is None or not request.endpoint.startswith("dashboard."):
        return None
    if not session.get("user_id"):
        return None
    if not _is_versie_b_session():
        return None
    if request.endpoint not in _VERSIE_B_BLOCKED_ENDPOINTS:
        return None
    if _is_api_request():
        return jsonify({"error": "Geen toegang tot deze route voor jouw accountrol."}), 403
    return redirect(url_for("dashboard.overzicht"))


@dashboard_bp.context_processor
def _inject_rbac_flags() -> dict[str, Any]:
    current_year = date.today().year
    role = _session_user_role()
    return {
        "current_user_role": role.value,
        "is_versie_b": is_restricted_role(role),
        "rbac_current_year": current_year,
    }


register_auth_routes(
    dashboard_bp,
    session_user_has_access_effective=_session_user_has_access_effective,
    safe_relative_redirect_path=_safe_relative_redirect_path,
    get_request_csrf_token=_get_request_csrf_token,
    is_valid_csrf_token=_is_valid_csrf_token,
    get_client_ip=_get_client_ip,
    is_rate_limited=_is_rate_limited,
    register_login_failure=_register_login_failure,
    clear_login_failures=_clear_login_failures,
    logger=logger,
)


@dashboard_bp.route("/", methods=["GET"])
def index() -> str:
    """
    Root route – redirect naar de hoofd upload pagina.
    """
    return redirect(url_for("dashboard.overzicht" if current_app.config.get("DEMO_MODE") else "dashboard.upload"))


register_upload_routes(
    dashboard_bp,
    upload_jobs=_upload_jobs,
    get_request_csrf_token=_get_request_csrf_token,
    is_valid_csrf_token=_is_valid_csrf_token,
    logger=logger,
)


@dashboard_bp.route("/overzicht", methods=["GET"])
def overzicht() -> str:
    return render_template("dashboard/overzicht.html")


@dashboard_bp.route("/overzicht/brands", methods=["GET"])
def overzicht_brands():
    supabase = SupabaseService()
    try:
        brands = supabase.get_overzicht_brands_rpc()
    except SupabaseServiceError as e:
        return _dependency_error_response(
            log_message="overzicht_brands dependency failure",
            exc=e,
            user_message="Overzicht-merken tijdelijk niet beschikbaar.",
            extra={"brands": []},
        )
    return jsonify({"brands": brands})


@dashboard_bp.route("/overzicht/years", methods=["GET"])
def overzicht_years():
    brand = request.args.get("brand", "")
    if not brand:
        return jsonify({"years": []}), 400

    supabase = SupabaseService()
    try:
        years = supabase.get_overzicht_years_rpc(brand=brand)
    except SupabaseServiceError as e:
        return _dependency_error_response(
            log_message="overzicht_years dependency failure",
            exc=e,
            user_message="Overzicht-jaren tijdelijk niet beschikbaar.",
            extra={"years": []},
        )
    if _is_versie_b_session():
        current_year = _resolve_year_for_session(None)
        return jsonify({"years": [current_year]})
    return jsonify({"years": years})


@dashboard_bp.route("/overzicht/data", methods=["GET"])
def overzicht_data():
    brand = request.args.get("brand", "")
    year_raw = request.args.get("year", "")
    destination_id = request.args.get("destination") or None
    brand_land = (request.args.get("brand_land") or "__ALL__").strip() or "__ALL__"

    if not brand or not year_raw:
        return jsonify({"error": "brand en year zijn verplicht"}), 400

    try:
        requested_year = int(year_raw)
    except (TypeError, ValueError):
        return jsonify({"error": "year moet een getal zijn"}), 400
    year = _resolve_year_for_session(requested_year)

    try:
        supabase = SupabaseService()
        # Via get_overzicht_dashboard: RPC + vulling van kpis.prev_year als die ontbreekt
        # (los van SQL-migratie; zie _ensure_overzicht_kpis_prev_year).
        payload = supabase.get_overzicht_dashboard(
            brand=brand, year=year, destination_id=destination_id, brand_land=brand_land
        )
        return jsonify(payload)
    except SupabaseServiceError as e:
        return _dependency_error_response(
            log_message="overzicht_data dependency failure",
            exc=e,
            user_message="Overzicht-data tijdelijk niet beschikbaar.",
        )


@dashboard_bp.route("/annulaties", methods=["GET"])
def annulaties() -> str:
    return render_template("dashboard/annulaties.html")


def _canonical_annulatie_brand(raw: str | None) -> str:
    value = str(raw or "").strip().lower()
    compact = "".join(ch for ch in value if ch.isalnum())

    if compact.startswith("sunescapes") or compact == "se":
        return "Sun Escapes"
    if compact.startswith("snowescapes") or compact == "sn":
        return "Snow Escapes"
    if compact.startswith("roadrebels") or compact in {"rr", "rebels"}:
        return "Road Rebels"
    return str(raw or "").strip() or "Onbekend"


def _parse_int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _parse_float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _parse_money(value: Any) -> float:
    if value is None:
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip()
    if not text:
        return 0.0
    cleaned = "".join(ch for ch in text if ch.isdigit() or ch in ",.-")
    if not cleaned:
        return 0.0
    if "," in cleaned and "." in cleaned:
        if cleaned.rfind(",") > cleaned.rfind("."):
            cleaned = cleaned.replace(".", "").replace(",", ".")
        else:
            cleaned = cleaned.replace(",", "")
    elif "," in cleaned:
        left, _, right = cleaned.partition(",")
        cleaned = f"{left}.{right}" if len(right) <= 2 else cleaned.replace(",", "")
    elif "." in cleaned:
        parts = cleaned.split(".")
        if not (len(parts) == 2 and len(parts[1]) <= 2):
            cleaned = cleaned.replace(".", "")
    try:
        return float(cleaned)
    except (TypeError, ValueError):
        return 0.0


def _normalize_status_value(value: Any) -> str:
    raw = str(value or "").strip().lower()
    if not raw:
        return ""
    unified = raw.replace("_", " ").replace("-", " ")
    return " ".join(unified.split())


def is_cancellation_status(value: Any = None) -> bool:
    normalized = _normalize_status_value(value)
    if not normalized:
        return False
    compact = normalized.replace(" ", "")
    keywords = (
        "cancel",
        "cancelled",
        "canceled",
        "dropped",
        "drop",
        "geannuleerd",
        "annul",
        "annulled",
        "void",
    )
    return any(kw in normalized or kw in compact for kw in keywords)


def _status_candidates_from_row(row: dict[str, Any]) -> list[str]:
    fields = (
        "booking_status",
        "booking_status_naam",
        "boeking_status",
        "boekingstatus",
        "traveller_status",
        "traveler_status",
        "reiziger_status",
        "order_status",
        "reservation_status",
        "cancellation_status",
        "status",
    )
    values: list[str] = []
    for field in fields:
        val = row.get(field)
        txt = str(val).strip() if val is not None else ""
        if txt:
            values.append(txt)
    return values


def _annulatie_status_helper_self_checks() -> None:
    positives = [
        "cancelled",
        "Cancelled",
        "canceled",
        "dropped",
        "geannuleerd",
        "booking_cancelled",
        "geannuleerd door klant",
    ]
    negatives = ["confirmed", "active", "paid"]
    for value in positives:
        if not is_cancellation_status(value):
            logger.warning("annulatie status helper mismatch (expected true): %s", value)
    for value in negatives:
        if is_cancellation_status(value):
            logger.warning("annulatie status helper mismatch (expected false): %s", value)


def _fetch_annulatie_rows(
    *,
    supabase: SupabaseService,
    brand: str,
    year: int,
    bestemming_id: str | None,
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    limit = 1000
    offset = 0
    while True:
        chunk = supabase.data_verzameling_list_rpc(
            search=None,
            brand=brand,
            bestemming_id=bestemming_id,
            year=year,
            status_id=None,
            date_kind="vertrekdatum",
            date_from=None,
            date_to=None,
            limit=limit,
            offset=offset,
        )
        if not chunk:
            break
        out.extend(chunk)
        if len(chunk) < limit:
            break
        offset += limit
    return out


@dashboard_bp.route("/annulaties/options", methods=["GET"])
def annulaties_options():
    try:
        supabase = SupabaseService()
        brands = supabase.get_overzicht_brands_rpc()
        bestemmingen = supabase.get_data_verzameling_bestemmingen()
        return jsonify({"brands": brands, "bestemmingen": bestemmingen})
    except SupabaseServiceError as e:
        return _dependency_error_response(
            log_message="annulaties_options dependency failure",
            exc=e,
            user_message="Annulaties-opties tijdelijk niet beschikbaar.",
            extra={"brands": [], "bestemmingen": []},
        )


@dashboard_bp.route("/annulaties/years", methods=["GET"])
def annulaties_years():
    brand = (request.args.get("brand") or "__all__").strip() or "__all__"
    if _is_versie_b_session():
        return jsonify({"years": [_resolve_year_for_session(None)]})
    try:
        supabase = SupabaseService()
        years = supabase.get_overzicht_years_rpc(brand=brand)
        return jsonify({"years": years})
    except SupabaseServiceError as e:
        return _dependency_error_response(
            log_message="annulaties_years dependency failure",
            exc=e,
            user_message="Annulatie-jaren tijdelijk niet beschikbaar.",
            extra={"years": []},
        )


@dashboard_bp.route("/annulaties/data", methods=["GET"])
def annulaties_data():
    raw_year = request.args.get("year", type=int)
    brand = (request.args.get("brand") or "__all__").strip() or "__all__"
    destination_raw = (request.args.get("destination") or "").strip()
    destination_values = [v.strip() for v in destination_raw.split(",") if v and v.strip() and v.strip() != "__all__"]
    destination_id = destination_values[0] if len(destination_values) == 1 else None

    if _is_versie_b_session():
        year = _resolve_year_for_session(raw_year)
    elif raw_year in (None, 0):
        year = 0
    else:
        year = _resolve_year_for_session(raw_year)

    try:
        _annulatie_status_helper_self_checks()
        supabase = SupabaseService()
        rows = _fetch_annulatie_rows(
            supabase=supabase,
            brand=brand,
            year=year,
            bestemming_id=destination_id,
        )
        if destination_values:
            allowed = {str(v) for v in destination_values}
            rows = [
                r
                for r in rows
                if str(r.get("bestemming_id") or r.get("destination_id") or "").strip() in allowed
            ]
        deduped_rows: dict[str, dict[str, Any]] = {}
        for r in rows:
            bid = str(r.get("booking_id") or "").strip()
            fallback = str(r.get("order_nummer") or r.get("booking_number") or "").strip()
            key = bid or fallback
            if not key or key in deduped_rows:
                continue
            deduped_rows[key] = r
        rows = list(deduped_rows.values())
        booking_ids = [str(r.get("booking_id") or "").strip() for r in rows if str(r.get("booking_id") or "").strip()]
        booking_ctx = supabase.get_boekingen_context_for_ids(booking_ids) if booking_ids else {}
        facts = supabase.annulaties_per_booking_facts(booking_ids) if booking_ids else {}
        travellers = supabase.get_reizigers_for_booking_ids(booking_ids) if booking_ids else []
        traveller_status_rows = supabase.get_data_verzameling_reiziger_statussen()
        traveller_status_map = {str(x.get("id")): str(x.get("naam") or "") for x in traveller_status_rows if x.get("id") is not None}
        travellers_by_booking: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for t in travellers:
            bid = str(t.get("boeking_id") or "").strip()
            if bid:
                travellers_by_booking[bid].append(t)

        total_bookings = len(rows)
        cancelled_rows: list[dict[str, Any]] = []
        cancelled_travellers = 0
        cancelled_revenue = 0.0
        for r in rows:
            bid = str(r.get("booking_id") or "").strip()
            f = facts.get(bid) if bid else None
            status_candidates = _status_candidates_from_row(r)
            booking_cancelled = any(is_cancellation_status(s) for s in status_candidates)
            traveller_rows = travellers_by_booking.get(bid, [])
            traveller_cancelled = 0
            for t in traveller_rows:
                status_name = traveller_status_map.get(str(t.get("traveller_status_id") or ""), "")
                if is_cancellation_status(status_name):
                    traveller_cancelled += 1
            meets_rpc = bool(f and f.get("meets_annulatie_criteria"))
            is_cancelled_booking = booking_cancelled or traveller_cancelled > 0 or meets_rpc
            if not is_cancelled_booking:
                continue

            pax_declared = _parse_int(r.get("aantal_reizigers") or r.get("pax") or r.get("travellers"))
            traveller_count = len(traveller_rows)
            kpi_travellers = max(traveller_cancelled, _parse_int((f or {}).get("annulled_travellers")))
            if booking_cancelled:
                # Consistentie met andere dashboards: bij geannuleerde boeking telt de volledige boeking mee.
                kpi_travellers = max(kpi_travellers, pax_declared, traveller_count)

            booking_revenue = _parse_money(
                r.get("totaal_te_betalen")
                or r.get("total_to_pay")
                or r.get("omzet")
                or r.get("booking_value")
                or r.get("waarde")
            )
            revenue_cancelled = _parse_money((f or {}).get("annulled_revenue"))
            if booking_cancelled:
                revenue_cancelled = max(revenue_cancelled, booking_revenue)
            elif revenue_cancelled <= 0 and pax_declared > 0 and traveller_cancelled > 0:
                revenue_cancelled = booking_revenue * (traveller_cancelled / pax_declared)

            cancelled_travellers += int(kpi_travellers)
            cancelled_revenue += float(revenue_cancelled)
            status_display = next((s for s in status_candidates if is_cancellation_status(s)), "") or str(r.get("booking_status") or "Annulatie")
            cancelled_rows.append(
                {
                    "booking_id": bid or str(r.get("order_nummer") or "").strip(),
                    "booking_number": str(r.get("order_nummer") or r.get("booking_number") or "—"),
                    "brand": _canonical_annulatie_brand(str(r.get("brand") or ((booking_ctx.get(bid) or {}).get("brand")) or "")),
                    "destination": str(r.get("bestemming") or r.get("destination") or "Onbekend"),
                    "departure_date": str(
                        r.get("vertrekdatum")
                        or r.get("departure_date")
                        or ((booking_ctx.get(bid) or {}).get("vertrekdatum"))
                        or ""
                    )[:10],
                    "status": status_display,
                    "travellers": int(kpi_travellers),
                    "cancelled_revenue": round(float(revenue_cancelled), 2),
                }
            )
        cancelled_bookings = len(cancelled_rows)
        cancelled_share_pct = (cancelled_bookings / total_bookings * 100.0) if total_bookings > 0 else 0.0

        all_by_brand: dict[str, int] = defaultdict(int)
        cancel_by_brand_bookings: dict[str, int] = defaultdict(int)
        cancel_by_brand_travellers: dict[str, int] = defaultdict(int)
        cancel_by_brand_revenue: dict[str, float] = defaultdict(float)

        all_by_dest: dict[str, int] = defaultdict(int)
        cancel_by_dest_bookings: dict[str, int] = defaultdict(int)
        cancel_by_dest_travellers: dict[str, int] = defaultdict(int)
        cancel_by_dest_revenue: dict[str, float] = defaultdict(float)

        cancelled_by_id = {str(x.get("booking_id") or "").strip(): x for x in cancelled_rows}
        for row in rows:
            booking_id = str(row.get("booking_id") or "").strip()
            ctx = booking_ctx.get(booking_id) if booking_id else None
            brand_name = _canonical_annulatie_brand(((ctx or {}).get("brand")) or row.get("brand"))
            dest_name = str(row.get("bestemming") or "").strip() or "Onbekend"
            c_row = cancelled_by_id.get(booking_id)
            is_cancel = c_row is not None

            all_by_brand[brand_name] += 1
            all_by_dest[dest_name] += 1
            if is_cancel and c_row:
                cancel_by_brand_bookings[brand_name] += 1
                cancel_by_brand_travellers[brand_name] += int(c_row.get("travellers") or 0)
                cancel_by_brand_revenue[brand_name] += float(c_row.get("cancelled_revenue") or 0.0)
                cancel_by_dest_bookings[dest_name] += 1
                cancel_by_dest_travellers[dest_name] += int(c_row.get("travellers") or 0)
                cancel_by_dest_revenue[dest_name] += float(c_row.get("cancelled_revenue") or 0.0)

        fixed_brands = ["Sun Escapes", "Snow Escapes", "Road Rebels"]
        by_brand = []
        for b in fixed_brands:
            total_b = all_by_brand.get(b, 0)
            cancel_b = cancel_by_brand_bookings.get(b, 0)
            share_b = (cancel_b / total_b * 100.0) if total_b > 0 else 0.0
            by_brand.append(
                {
                    "brand": b,
                    "total_bookings": total_b,
                    "cancelled_bookings": cancel_b,
                    "cancelled_travellers": cancel_by_brand_travellers.get(b, 0),
                    "cancelled_revenue": round(cancel_by_brand_revenue.get(b, 0.0), 2),
                    "cancelled_share_pct": round(share_b, 4),
                }
            )

        by_destination = []
        for dest, total_d in all_by_dest.items():
            cancel_d = cancel_by_dest_bookings.get(dest, 0)
            share_d = (cancel_d / total_d * 100.0) if total_d > 0 else 0.0
            by_destination.append(
                {
                    "destination": dest,
                    "total_bookings": total_d,
                    "cancelled_bookings": cancel_d,
                    "cancelled_travellers": cancel_by_dest_travellers.get(dest, 0),
                    "cancelled_revenue": round(cancel_by_dest_revenue.get(dest, 0.0), 2),
                    "cancelled_share_pct": round(share_d, 4),
                }
            )
        by_destination.sort(key=lambda x: x["cancelled_share_pct"], reverse=True)

        return jsonify(
            {
                "meta": {
                    "brand": brand,
                    "year": year,
                    "destination": destination_raw or "__all__",
                },
                "kpis": {
                    "cancelled_bookings": cancelled_bookings,
                    "cancelled_travellers": cancelled_travellers,
                    "cancelled_revenue": round(cancelled_revenue, 2),
                    "cancelled_share_pct": round(cancelled_share_pct, 4),
                    "all_bookings": total_bookings,
                },
                "by_brand": by_brand,
                "by_destination": by_destination,
                "cancelled_rows": sorted(cancelled_rows, key=lambda x: str(x.get("departure_date") or ""), reverse=True),
            }
        )
    except SupabaseServiceError as e:
        return _dependency_error_response(
            log_message="annulaties_data dependency failure",
            exc=e,
            user_message="Annulaties-data tijdelijk niet beschikbaar.",
        )


@dashboard_bp.route("/pre-boekingen", methods=["GET"])
def pre_boekingen() -> str:
    return render_template("dashboard/pre_boekingen.html")


@dashboard_bp.route("/pre-boekingen/opties", methods=["GET"])
def pre_boekingen_opties():
    try:
        supabase = SupabaseService()
        payload = supabase.vlucht_allotment_dashboard_filters()
        if _is_versie_b_session():
            payload["jaren"] = [_resolve_year_for_session(None)]
        return _json_response_ok(payload)
    except SupabaseServiceError as exc:
        return _dependency_error_response(
            log_message="pre_boekingen_opties dependency failure",
            exc=exc,
            user_message="Pre-boekingen opties tijdelijk niet beschikbaar.",
            extra={
                "jaren": [],
                "agencies": [],
                "ways": [],
                "flights": [],
            },
        )


@dashboard_bp.route("/pre-boekingen/data", methods=["GET"])
def pre_boekingen_data():
    try:
        jaar = _resolve_year_for_session(request.args.get("jaar", type=int))
        arrival_van = (request.args.get("arrival_van") or "").strip() or None
        arrival_tot = (request.args.get("arrival_tot") or "").strip() or None
        departure_van = (request.args.get("departure_van") or "").strip() or None
        departure_tot = (request.args.get("departure_tot") or "").strip() or None
        agency = (request.args.get("agency") or "").strip() or None
        way = (request.args.get("way") or "").strip() or None
        flight = (request.args.get("flight") or "").strip() or None

        supabase = SupabaseService()
        rows = supabase.vlucht_allotment_dashboard_rows(
            jaar=jaar,
            arrival_van=arrival_van,
            arrival_tot=arrival_tot,
            departure_van=departure_van,
            departure_tot=departure_tot,
            agency=agency,
            way=way,
            flight=flight,
        )
        return _json_response_ok({"rows": rows})
    except SupabaseServiceError as exc:
        return _dependency_error_response(
            log_message="pre_boekingen_data dependency failure",
            exc=exc,
            user_message="Pre-boekingen data tijdelijk niet beschikbaar.",
            extra={"rows": []},
        )


@dashboard_bp.route("/pre-boekingen/upload-vluchten", methods=["POST"])
def pre_boekingen_upload_vluchten():
    csrf_token = _get_request_csrf_token()
    if not _is_valid_csrf_token(csrf_token):
        return _json_response_ok({"error": "Sessiebeveiliging mislukt. Vernieuw de pagina en probeer opnieuw."}, status=400)

    file = request.files.get("file")
    if not file or not file.filename:
        return _json_response_ok({"error": "Selecteer een Excelbestand."}, status=400)
    filename = str(file.filename)
    if not filename.lower().endswith(".xlsx"):
        return _json_response_ok({"error": "Alleen .xlsx bestanden zijn toegestaan."}, status=400)

    file_bytes = file.read()
    allotment_rijen, fouten = parse_vlucht_allotment_excel(file_bytes)
    if fouten:
        return _json_response_ok({"error": "Upload bevat fouten.", "fouten": fouten}, status=400)

    try:
        supabase = SupabaseService()
        upload_id = supabase.insert_vlucht_allotment_upload(bestandsnaam=filename)
        insert_rows = [
            {
                "upload_id": upload_id,
                "arrival": r.arrival,
                "departure": r.departure,
                "agency": r.agency,
                "way": r.way,
                "total_pax": r.total_pax,
                "booked_pax": r.booked_pax,
                "still_free": r.still_free,
                "outbound_flight": r.outbound_flight,
                "inbound_flight": r.inbound_flight,
                "pp_outbound": r.pp_outbound,
                "pp_inbound": r.pp_inbound,
            }
            for r in allotment_rijen
        ]
        aantal = supabase.insert_vlucht_allotments(insert_rows)
        return _json_response_ok({"ok": True, "upload_id": upload_id, "aantal_rijen": aantal})
    except SupabaseServiceError as exc:
        return _dependency_error_response(
            log_message="pre_boekingen_upload_vluchten dependency failure",
            exc=exc,
            user_message="Opslaan van vluchtupload tijdelijk niet beschikbaar.",
        )


@dashboard_bp.route("/pre-boekingen/auto-koppel", methods=["POST"])
def pre_boekingen_auto_koppel():
    csrf_token = _get_request_csrf_token()
    if not _is_valid_csrf_token(csrf_token):
        return _json_response_ok({"error": "Sessiebeveiliging mislukt. Vernieuw de pagina en probeer opnieuw."}, status=400)
    try:
        supabase = SupabaseService()
        result = supabase.koppel_reizigers_aan_vlucht_allotments()
        return _json_response_ok({"ok": True, **result})
    except SupabaseServiceError as exc:
        return _dependency_error_response(
            log_message="pre_boekingen_auto_koppel dependency failure",
            exc=exc,
            user_message="Automatisch koppelen tijdelijk niet beschikbaar.",
        )


def _json_response_ok(payload: dict[str, Any], *, status: int = 200) -> Response:
    """
    JSON-response die altijd serialiseerbaar is (Decimal, datetime, uuid uit Supabase/JSONB).
    Voorkomt Flask HTML 500 bij jsonify()-TypeError.
    """
    try:
        return Response(
            json.dumps(payload, ensure_ascii=False, default=str),
            status=status,
            mimetype="application/json; charset=utf-8",
        )
    except (TypeError, ValueError) as e:
        logger.exception("_json_response_ok serialisatie")
        return Response(
            json.dumps({"error": f"Response kon niet worden opgebouwd: {e}", "rows": []}, default=str),
            status=500,
            mimetype="application/json; charset=utf-8",
        )


def _dependency_error_response(
    *,
    log_message: str,
    exc: Exception,
    user_message: str = "Data tijdelijk niet beschikbaar door een afhankelijkheidsfout.",
    status: int = 503,
    extra: dict[str, Any] | None = None,
) -> Response:
    logger.exception("%s", log_message, exc_info=exc)
    payload: dict[str, Any] = {"error": user_message}
    if extra:
        payload.update(extra)
    return _json_response_ok(payload, status=status)


def _internal_error_response(
    *,
    log_message: str,
    exc: Exception,
    user_message: str = "Interne serverfout.",
    status: int = 500,
    extra: dict[str, Any] | None = None,
) -> Response:
    logger.exception("%s", log_message, exc_info=exc)
    payload: dict[str, Any] = {"error": user_message}
    if extra:
        payload.update(extra)
    return _json_response_ok(payload, status=status)


def _parse_money_value(
    raw: Any,
    *,
    field: str,
    required: bool = False,
    allow_null: bool = True,
) -> float | None:
    if raw is None:
        if required:
            raise ValueError(f"{field} is verplicht.")
        return None if allow_null else 0.0

    txt = str(raw).strip()
    if txt == "":
        if required:
            raise ValueError(f"{field} is verplicht.")
        return None if allow_null else 0.0

    txt = txt.replace(",", ".")
    try:
        val = float(txt)
    except ValueError as exc:
        raise ValueError(f"{field} moet een geldig getal zijn.") from exc

    if val < 0:
        raise ValueError(f"{field} moet groter of gelijk aan 0 zijn.")
    return val


register_financieel_routes(
    dashboard_bp,
    json_response_ok=_json_response_ok,
    dependency_error_response=_dependency_error_response,
    build_request_id=_build_request_id,
    get_request_csrf_token=_get_request_csrf_token,
    is_valid_csrf_token=_is_valid_csrf_token,
    parse_money_value=_parse_money_value,
    session_user_role=_session_user_role,
    is_api_request=_is_api_request,
    resolve_year_for_session=_resolve_year_for_session,
    logger=logger,
)
register_excursies_routes(
    dashboard_bp,
    json_response_ok=_json_response_ok,
    dependency_error_response=_dependency_error_response,
    build_request_id=_build_request_id,
    parse_money_value=_parse_money_value,
    mock_excursies_payload=mock_excursies_lines_payload,
    session_user_role=_session_user_role,
    resolve_year_for_session=_resolve_year_for_session,
    logger=logger,
)
@dashboard_bp.route("/klantenprofiel", methods=["GET"])
def klantenprofiel() -> str:
    return render_template("dashboard/klantenprofiel.html")


@dashboard_bp.route("/klantenprofiel/options", methods=["GET"])
def klantenprofiel_options():
    supabase = SupabaseService()
    try:
        brands = supabase.get_data_verzameling_brands()
        bestemmingen = supabase.get_data_verzameling_bestemmingen()
        reiziger_landen = supabase.get_data_verzameling_reiziger_landen()
        reiziger_provincies = supabase.get_data_verzameling_reiziger_provincies()
        yrows = supabase.bestemmingen_periodes_vertrek_jaren_rpc(brand="__all__", bestemming_id=None)
        years: list[int] = []
        for r in yrows:
            j = r.get("jaar")
            if j is None:
                continue
            try:
                years.append(int(j))
            except (TypeError, ValueError):
                continue
        years = sorted(set(years), reverse=True)
        return jsonify(
            {
                "brands": brands,
                "bestemmingen": bestemmingen,
                "years": years,
                "reiziger_landen": reiziger_landen,
                "reiziger_provincies": reiziger_provincies,
                "leeftijdsgroepen": ["15-", "16", "17", "18", "19", "20", "21+"],
            }
        )
    except SupabaseServiceError as e:
        return _dependency_error_response(
            log_message="klantenprofiel_options dependency failure",
            exc=e,
            user_message="Klantenprofiel-opties tijdelijk niet beschikbaar.",
            extra={
                "brands": [],
                "bestemmingen": [],
                "years": [],
                "reiziger_landen": {"values": [], "has_unknown": False},
                "reiziger_provincies": {"values": [], "has_unknown": False, "by_land": {}},
                "leeftijdsgroepen": ["15-", "16", "17", "18", "19", "20", "21+"],
            },
        )


@dashboard_bp.route("/klantenprofiel/data", methods=["GET"])
def klantenprofiel_data():
    raw_year = request.args.get("year", type=int)
    allow_all_years = raw_year == 0 and not _is_versie_b_session()
    year = 0 if allow_all_years else _resolve_year_for_session(raw_year)
    brand = (request.args.get("brand") or "__all__").strip() or "__all__"
    bestemmingen_raw = (request.args.get("bestemming_ids") or "").strip()
    bestemmingen_ids = [x.strip() for x in bestemmingen_raw.split(",") if x.strip()]
    period = (request.args.get("period") or "all").strip().lower() or "all"
    if period not in {"all", "maand", "zomer"}:
        period = "all"
    origin = (request.args.get("origin") or "__ALL__").strip() or "__ALL__"
    reiziger_land = (request.args.get("reiziger_land") or "__ALL__").strip() or "__ALL__"
    reiziger_provincies_raw = (request.args.get("reiziger_provincies") or "").strip()
    reiziger_provincies = [x.strip() for x in reiziger_provincies_raw.split(",") if x.strip()]
    leeftijdsgroepen_raw = (request.args.get("leeftijdsgroepen") or "").strip()
    leeftijdsgroepen = [x.strip() for x in leeftijdsgroepen_raw.split(",") if x.strip()]
    brand_land = (request.args.get("brand_land") or "__ALL__").strip() or "__ALL__"
    # Vergelijk standaard met vorig vertrekjaar zodat Δ%-kolommen op de pagina
    # (leeftijd, herkomst, provincie, merken) altijd waarden krijgen wanneer een
    # specifiek jaar geselecteerd is. Bij "Alle jaren" (year == 0) is een
    # vorig-jaar vergelijking niet zinvol.
    compare_prev = bool(year and year > 0)

    if year is None or year < 0:
        return jsonify({"error": "year is verplicht"}), 400

    try:
        hol: list[dict[str, str]] | None = None
        hol_prev: list[dict[str, str]] | None = None

        supabase = SupabaseService()
        logger.info(
            "klantenprofiel_data filters year=%s brand=%s bestemming_ids=%s period=%s origin=%s reiziger_land=%s reiziger_provincies=%s leeftijdsgroepen=%s brand_land=%s",
            year,
            brand,
            len(bestemmingen_ids),
            period,
            origin,
            reiziger_land,
            len(reiziger_provincies),
            len(leeftijdsgroepen),
            brand_land,
        )
        raw = supabase.klantenprofiel_dashboard_rpc(
            year=int(year),
            brand=brand,
            bestemmingen_ids=bestemmingen_ids,
            period=period,
            origin=origin,
            reiziger_land=reiziger_land,
            reiziger_provincies=reiziger_provincies,
            leeftijdsgroepen=leeftijdsgroepen,
            compare_prev_year=compare_prev,
            holiday_ranges=hol,
            holiday_ranges_prev=hol_prev,
            brand_land=brand_land,
        )
        # Python-side correctie van metrics die in de oude RPC verkeerd waren
        # (Gem. groepsgrootte KPI, age_by_month chart, group_hist tabel,
        # group_by_month chart, age_by_brand). Werkt zonder SQL deploy zodat
        # de pagina altijd correcte cijfers toont; na `python run_migrations.py`
        # produceert de RPC dezelfde getallen en is deze override idempotent.
        try:
            from services.klantenprofiel_metrics import apply_python_overrides

            raw = apply_python_overrides(
                supabase,
                raw,
                year=int(year),
                brand=brand,
                bestemmingen_ids=bestemmingen_ids,
                period=period,
                brand_land=brand_land,
                origin=origin,
                reiziger_land=reiziger_land,
                reiziger_provincies=reiziger_provincies,
                leeftijdsgroepen=leeftijdsgroepen,
                compare_prev=compare_prev,
            )
        except Exception:  # noqa: BLE001
            logger.exception("klantenprofiel python override failed; using RPC payload as-is")
        # Compacte diagnostiek: bewijst dat de nieuwe pipeline draait. Elke
        # /klantenprofiel/data-call print één regel met de YoY-staat zodat we
        # in de Flask-console direct zien of meta.compare/prev-data klopt.
        meta = raw.get("meta") if isinstance(raw.get("meta"), dict) else {}
        bp_prev_n = len(raw.get("brand_pax_prev") or []) if isinstance(raw.get("brand_pax_prev"), list) else 0
        op_prev_n = len(raw.get("origin_pax_prev") or []) if isinstance(raw.get("origin_pax_prev"), list) else 0
        pp_prev_n = len(raw.get("province_pax_prev") or []) if isinstance(raw.get("province_pax_prev"), list) else 0
        ah_prev_n = len(raw.get("age_hist_prev") or []) if isinstance(raw.get("age_hist_prev"), list) else 0
        logger.info(
            "klantenprofiel_data year=%s brand=%s compare_prev=%s -> meta.compare=%s "
            "year_prev=%s brand_pax_prev=%s origin_pax_prev=%s province_pax_prev=%s age_hist_prev=%s",
            year,
            brand,
            compare_prev,
            meta.get("compare"),
            meta.get("year_prev"),
            bp_prev_n,
            op_prev_n,
            pp_prev_n,
            ah_prev_n,
        )
        if compare_prev and int(year) > 0 and not meta.get("compare"):
            logger.error(
                "klantenprofiel_data: YoY gevraagd (year=%s) maar meta.compare=false. "
                "Deploy sql/rpc/klantenprofiel_rpc.sql (python deploy_klantenprofiel_rpc.py) "
                "en/of controleer DATABASE_URL voor de Python-override.",
                year,
            )
        kpis_cur = raw.get("kpis_cur") if isinstance(raw.get("kpis_cur"), dict) else {}
        logger.info(
            "klantenprofiel_data result year=%s bestemming_ids=%s total_pax=%s total_bookings=%s age_hist_n=%s origin_pax_n=%s province_pax_n=%s",
            year,
            len(bestemmingen_ids),
            kpis_cur.get("total_pax"),
            kpis_cur.get("total_bookings"),
            len(raw.get("age_hist") or []) if isinstance(raw.get("age_hist"), list) else 0,
            len(raw.get("origin_pax") or []) if isinstance(raw.get("origin_pax"), list) else 0,
            len(raw.get("province_pax") or []) if isinstance(raw.get("province_pax"), list) else 0,
        )
        payload = enrich_klantenprofiel_payload(raw)
        return jsonify(payload)
    except SupabaseServiceError as e:
        logger.exception(
            "klantenprofiel_data dependency failure (year=%s brand=%s bestemmingen_ids=%s)",
            year,
            brand,
            bestemmingen_ids,
            exc_info=e,
        )
        return jsonify(
            {
                "error": "Klantenprofiel-data tijdelijk niet beschikbaar.",
                "debug_error": str(e),
                "debug_type": type(e).__name__,
            }
        ), 503
    except Exception as e:  # noqa: BLE001
        logger.exception(
            "klantenprofiel_data unexpected failure (year=%s brand=%s bestemmingen_ids=%s)",
            year,
            brand,
            bestemmingen_ids,
            exc_info=e,
        )
        return jsonify(
            {
                "error": "Klantenprofiel-data kon niet worden geladen.",
                "debug_error": str(e),
                "debug_type": type(e).__name__,
            }
        ), 500


@dashboard_bp.route("/klantenprofiel/repeat-data", methods=["GET"])
def klantenprofiel_repeat_data():
    raw_year = request.args.get("year", type=int)
    allow_all_years = raw_year == 0 and not _is_versie_b_session()
    year = 0 if allow_all_years else _resolve_year_for_session(raw_year)
    brand = (request.args.get("brand") or "__all__").strip() or "__all__"
    bestemmingen_raw = (request.args.get("bestemming_ids") or "").strip()
    bestemmingen_ids = [x.strip() for x in bestemmingen_raw.split(",") if x.strip()]
    period = (request.args.get("period") or "all").strip().lower() or "all"
    if period not in {"all", "maand", "zomer"}:
        period = "all"
    origin = (request.args.get("origin") or "__ALL__").strip() or "__ALL__"
    reiziger_land = (request.args.get("reiziger_land") or "__ALL__").strip() or "__ALL__"
    reiziger_provincies_raw = (request.args.get("reiziger_provincies") or "").strip()
    reiziger_provincies = [x.strip() for x in reiziger_provincies_raw.split(",") if x.strip()]
    leeftijdsgroepen_raw = (request.args.get("leeftijdsgroepen") or "").strip()
    leeftijdsgroepen = [x.strip() for x in leeftijdsgroepen_raw.split(",") if x.strip()]
    brand_land = (request.args.get("brand_land") or "__ALL__").strip() or "__ALL__"

    if year is None or year < 0:
        return jsonify({"error": "year is verplicht"}), 400

    try:
        supabase = SupabaseService()
        payload = supabase.klantenprofiel_repeat_dashboard_rpc(
            year=int(year),
            brand=brand,
            bestemmingen_ids=bestemmingen_ids,
            period=period,
            origin=origin,
            reiziger_land=reiziger_land,
            reiziger_provincies=reiziger_provincies,
            leeftijdsgroepen=leeftijdsgroepen,
            brand_land=brand_land,
        )
        return jsonify(payload)
    except SupabaseServiceError as e:
        logger.exception("klantenprofiel_repeat_data dependency failure", exc_info=e)
        return _json_response_ok(
            {"error": "Repeat gedrag kon niet geladen worden", "details": str(e)},
            status=503,
        )
    except Exception as e:  # noqa: BLE001
        logger.exception("klantenprofiel_repeat_data unexpected failure", exc_info=e)
        return _json_response_ok(
            {"error": "Repeat gedrag kon niet geladen worden", "details": str(e)},
            status=500,
        )


@dashboard_bp.route("/klantenprofiel/traveler-origin-donut", methods=["GET"])
def klantenprofiel_traveler_origin_donut_view():
    """Donut: afkomst reizigers per brand_land (BE/NL), zelfde filters als klantenprofiel-data; donut_brand = segment in het blok."""
    raw_year = request.args.get("year", type=int)
    allow_all_years = raw_year == 0 and not _is_versie_b_session()
    year = 0 if allow_all_years else _resolve_year_for_session(raw_year)
    brand = (request.args.get("brand") or "__all__").strip() or "__all__"
    bestemmingen_raw = (request.args.get("bestemming_ids") or "").strip()
    bestemmingen_ids = [x.strip() for x in bestemmingen_raw.split(",") if x.strip()]
    period = (request.args.get("period") or "all").strip().lower() or "all"
    if period not in {"all", "maand", "zomer"}:
        period = "all"
    origin = (request.args.get("origin") or "__ALL__").strip() or "__ALL__"
    reiziger_land = (request.args.get("reiziger_land") or "__ALL__").strip() or "__ALL__"
    reiziger_provincies_raw = (request.args.get("reiziger_provincies") or "").strip()
    reiziger_provincies = [x.strip() for x in reiziger_provincies_raw.split(",") if x.strip()]
    leeftijdsgroepen_raw = (request.args.get("leeftijdsgroepen") or "").strip()
    leeftijdsgroepen = [x.strip() for x in leeftijdsgroepen_raw.split(",") if x.strip()]
    brand_land = (request.args.get("brand_land") or "__ALL__").strip() or "__ALL__"
    donut_brand = (request.args.get("donut_brand") or "Sun Escapes").strip()

    if year is None or year < 0:
        return jsonify({"error": "year is verplicht"}), 400

    try:
        hol: list[dict[str, str]] | None = None
        eff = effective_kp_donut_brand(brand, donut_brand)
        supabase = SupabaseService()
        rows = supabase.klantenprofiel_traveler_origin_donut_rpc(
            year=int(year),
            brand=brand,
            bestemmingen_ids=bestemmingen_ids,
            period=period,
            origin=origin,
            reiziger_land=reiziger_land,
            reiziger_provincies=reiziger_provincies,
            leeftijdsgroepen=leeftijdsgroepen,
            brand_land=brand_land,
            holiday_ranges=hol,
            effective_brand=eff,
        )
        payload = traveler_origin_donut_payload(rows or [], effective_brand=eff)
        return jsonify(payload)
    except SupabaseServiceError as e:
        return _dependency_error_response(
            log_message="klantenprofiel_traveler_origin_donut dependency failure",
            exc=e,
            user_message="Herkomstdonut tijdelijk niet beschikbaar.",
        )
    except Exception as e:  # noqa: BLE001
        return _internal_error_response(
            log_message="klantenprofiel_traveler_origin_donut unexpected failure",
            exc=e,
            user_message="Herkomstdonut kon niet worden geladen.",
        )


@dashboard_bp.route("/inzichten", methods=["GET"])
def inzichten() -> str:
    return render_template("dashboard/inzichten.html")


@dashboard_bp.route("/data-verzameling", methods=["GET"])
def data_verzameling() -> str:
    return render_template("dashboard/data_verzameling.html")


@dashboard_bp.route("/data-verzameling/options", methods=["GET"])
def data_verzameling_options():
    cached = _get_cached_options("data_verzameling_options")
    if cached is not None:
        return jsonify(cached)
    supabase = SupabaseService()
    try:
        brands = supabase.get_data_verzameling_brands()
        bestemmingen = supabase.get_data_verzameling_bestemmingen()
        boeking_statussen = supabase.get_data_verzameling_boeking_statussen()
        payload = {
            "brands": brands,
            "bestemmingen": bestemmingen,
            "boekings_statussen": boeking_statussen,
        }
        _set_cached_options("data_verzameling_options", payload)
        return jsonify(payload)
    except SupabaseServiceError as e:
        return _dependency_error_response(
            log_message="data_verzameling_options dependency failure",
            exc=e,
            user_message="Data-verzameling opties tijdelijk niet beschikbaar.",
        )


@dashboard_bp.route("/data-verzameling/years", methods=["GET"])
def data_verzameling_years():
    brand = request.args.get("brand", "__all__")
    supabase = SupabaseService()
    try:
        years = supabase.get_overzicht_years_rpc(brand=brand)
        if _is_versie_b_session():
            years = [_resolve_year_for_session(None)]
        return jsonify({"years": years})
    except SupabaseServiceError as e:
        return _dependency_error_response(
            log_message="data_verzameling_years dependency failure",
            exc=e,
            user_message="Data-verzameling jaren tijdelijk niet beschikbaar.",
            extra={"years": []},
        )


@dashboard_bp.route("/data-verzameling/list", methods=["GET"])
def data_verzameling_list():
    supabase = SupabaseService()
    try:
        search = request.args.get("search") or None
        brand = request.args.get("brand") or "__all__"

        bestemming_id = request.args.get("bestemming") or None
        bestemming_id = bestemming_id if bestemming_id else None

        year_raw = request.args.get("year", "0")
        parsed_year = int(year_raw) if year_raw else 0
        year = _resolve_year_for_session(parsed_year)

        status_id = request.args.get("status") or None
        status_id = status_id if status_id else None

        date_kind = request.args.get("date_kind") or "boekingsdatum"
        date_from_raw = request.args.get("date_from") or None
        date_to_raw = request.args.get("date_to") or None

        date_from = date.fromisoformat(date_from_raw) if date_from_raw else None
        date_to = date.fromisoformat(date_to_raw) if date_to_raw else None

        page_raw = request.args.get("page", "1")
        page = int(page_raw) if page_raw else 1
        page_size = 50
        limit = page_size + 1  # lookahead
        offset = max(0, page - 1) * page_size

        rows = supabase.data_verzameling_list_rpc(
            search=search,
            brand=brand,
            bestemming_id=bestemming_id,
            year=year,
            status_id=status_id,
            date_kind=date_kind,
            date_from=date_from,
            date_to=date_to,
            limit=limit,
            offset=offset,
        )

        has_next = len(rows) > page_size
        # Snij terug naar exact 50 records in API-response.
        return jsonify({"rows": rows[:page_size], "has_next": has_next, "page": page})
    except ValueError:
        return jsonify({"error": "Ongeldige queryparameters"}), 400
    except SupabaseServiceError as e:
        return _dependency_error_response(
            log_message="data_verzameling_list dependency failure",
            exc=e,
            user_message="Data-verzameling lijst tijdelijk niet beschikbaar.",
        )


@dashboard_bp.route("/data-verzameling/detail/<booking_id>", methods=["GET"])
def data_verzameling_detail(booking_id: str):
    supabase = SupabaseService()
    try:
        payload = supabase.data_verzameling_detail_rpc(booking_id=booking_id)
        return jsonify(payload)
    except SupabaseServiceError as e:
        return _dependency_error_response(
            log_message="data_verzameling_detail dependency failure",
            exc=e,
            user_message="Detailgegevens tijdelijk niet beschikbaar.",
        )


@dashboard_bp.route("/data-verzameling/boekingen/<booking_id>", methods=["DELETE"])
def data_verzameling_delete_booking(booking_id: str):
    csrf_token = _get_request_csrf_token()
    if not _is_valid_csrf_token(csrf_token):
        return jsonify({"error": "Sessiebeveiliging mislukt. Vernieuw de pagina en probeer opnieuw."}), 400

    supabase = SupabaseService()
    try:
        deleted = supabase.delete_data_verzameling_booking(booking_id=booking_id)
        if not deleted:
            return jsonify({"error": "Boeking niet gevonden."}), 404
        logger.info("data_verzameling_delete booking_id=%s deleted=true", booking_id)
        return jsonify({"ok": True, "deleted_booking_id": booking_id})
    except SupabaseServiceError as e:
        return _dependency_error_response(
            log_message="data_verzameling_delete dependency failure",
            exc=e,
            user_message="Boeking verwijderen is tijdelijk niet beschikbaar.",
        )


@dashboard_bp.route("/data-verzameling/edit-options", methods=["GET"])
def data_verzameling_edit_options():
    supabase = SupabaseService()
    try:
        bestemmingen_rows = supabase.get_data_verzameling_bestemmingen()
        boeking_status_rows = supabase.get_data_verzameling_boeking_statussen()
        betaling_status_rows = supabase.get_data_verzameling_betaling_statussen()
        accommodatie_types = supabase.get_data_verzameling_accommodatie_types()
        leveranciers = supabase.get_data_verzameling_leveranciers()
        excursies = supabase.get_data_verzameling_excursies()
        addons = supabase.get_data_verzameling_addons()

        boeking_statussen = sorted(
            {str(r.get("naam") or "").strip() for r in boeking_status_rows if str(r.get("naam") or "").strip()}
        )
        if not boeking_statussen:
            boeking_statussen = ["processing", "booked", "accepted", "cancelled"]

        betaling_statussen = sorted(
            {str(r.get("naam") or "").strip() for r in betaling_status_rows if str(r.get("naam") or "").strip()}
        )
        if not betaling_statussen:
            betaling_statussen = ["OKE", "openstaand", "aandacht vereist"]

        return jsonify(
            {
                "bestemmingen": [str(r.get("naam") or "").strip() for r in bestemmingen_rows if str(r.get("naam") or "").strip()],
                "boeking_statussen": boeking_statussen,
                "betaling_statussen": betaling_statussen,
                "accommodatie_types": accommodatie_types,
                "leveranciers": leveranciers,
                "excursies": excursies,
                "addons": addons,
            }
        )
    except SupabaseServiceError as e:
        return _dependency_error_response(
            log_message="data_verzameling_edit_options dependency failure",
            exc=e,
            user_message="Bewerkopties tijdelijk niet beschikbaar.",
        )


@dashboard_bp.route("/data-verzameling/update/<booking_id>", methods=["POST"])
def data_verzameling_update(booking_id: str):
    csrf_token = _get_request_csrf_token()
    if not _is_valid_csrf_token(csrf_token):
        return jsonify({"error": "Sessiebeveiliging mislukt. Vernieuw de pagina en probeer opnieuw."}), 400

    payload = request.get_json(silent=True) or {}
    bestemming = str(payload.get("bestemming") or "").strip()
    accommodatie = str(payload.get("accommodatie") or "").strip()
    boeking_status = str(payload.get("boeking_status") or "").strip()
    betaling_status = str(payload.get("betaling_status") or "").strip() or None
    order_nummer = str(payload.get("order_nummer") or "").strip()
    accommodatie_type = str(payload.get("accommodatie_type") or "").strip() or None
    leverancier = str(payload.get("leverancier") or "").strip() or None

    if not bestemming:
        return jsonify({"error": "Bestemming is verplicht."}), 400
    if not accommodatie:
        return jsonify({"error": "Accommodatie is verplicht."}), 400
    if not boeking_status:
        return jsonify({"error": "Boekingsstatus is verplicht."}), 400

    def _parse_required_date(field: str) -> date:
        raw = str(payload.get(field) or "").strip()
        if not raw:
            raise ValueError(f"{field} is verplicht.")
        try:
            return date.fromisoformat(raw[:10])
        except ValueError as exc:
            raise ValueError(f"{field} heeft geen geldige datum.") from exc

    try:
        vertrekdatum = _parse_required_date("vertrekdatum")
        terugkeerdatum = _parse_required_date("terugkeerdatum")
        boekingsdatum = _parse_required_date("boekingsdatum")
        if vertrekdatum >= terugkeerdatum:
            return jsonify({"error": "Vertrekdatum moet vóór terugkeerdatum liggen."}), 400

        aantal_reizigers_raw = payload.get("aantal_reizigers")
        aantal_reizigers: int | None = None
        if aantal_reizigers_raw not in (None, ""):
            try:
                aantal_reizigers = int(str(aantal_reizigers_raw).strip())
            except ValueError as exc:
                raise ValueError("Reizigers aantal moet numeriek zijn.") from exc
            if aantal_reizigers < 0:
                raise ValueError("Reizigers aantal moet groter of gelijk aan 0 zijn.")

        prepaid_bedrag = _parse_money_value(
            payload.get("prepaid_bedrag"),
            field="Prepaid bedrag",
            required=False,
            allow_null=True,
        )

        excursies_raw = payload.get("excursies")
        addons_raw = payload.get("addons")
        excursies = [str(x).strip() for x in excursies_raw] if isinstance(excursies_raw, list) else []
        addons = [str(x).strip() for x in addons_raw] if isinstance(addons_raw, list) else []

        supabase = SupabaseService()
        result = supabase.update_data_verzameling_booking(
            booking_id=booking_id,
            order_nummer=order_nummer,
            bestemming=bestemming,
            accommodatie=accommodatie,
            accommodatie_type=accommodatie_type,
            leverancier=leverancier,
            vertrekdatum=vertrekdatum.isoformat(),
            terugkeerdatum=terugkeerdatum.isoformat(),
            boekingsdatum=boekingsdatum.isoformat(),
            boeking_status=boeking_status,
            betaling_status=betaling_status,
            aantal_reizigers=aantal_reizigers,
            prepaid_bedrag=prepaid_bedrag,
            excursies=excursies,
            addons=addons,
        )
        return jsonify({"ok": True, "booking": result})
    except ValueError as e:
        logger.warning("data_verzameling_update validation failure: %s", e)
        return jsonify({"error": "Ongeldige invoer voor boeking-update."}), 400
    except SupabaseServiceError as e:
        dep = _dependency_error_response(
            log_message="data_verzameling_update dependency failure",
            exc=e,
            user_message="Boeking aanpassen tijdelijk niet beschikbaar.",
        )
        return dep
    except Exception:  # noqa: BLE001
        request_id = _build_request_id()
        logger.exception("data_verzameling_update request_id=%s", request_id)
        return jsonify({"error": "Boeking aanpassen mislukt.", "request_id": request_id}), 500


@dashboard_bp.route("/tijdsvergelijkingen", methods=["GET"])
def tijdsvergelijkingen() -> str:
    return render_template("dashboard/tijdsvergelijkingen.html")


@dashboard_bp.route("/tijdsvergelijkingen/options", methods=["GET"])
def tijdsvergelijkingen_options():
    cached = _get_cached_options("tijdsvergelijkingen_options")
    if cached is not None:
        return jsonify(cached)
    supabase = SupabaseService()
    try:
        brands = supabase.get_overzicht_brands_rpc()
        bestemmingen = supabase.get_data_verzameling_bestemmingen()
        payload = {"brands": brands, "bestemmingen": bestemmingen}
        _set_cached_options("tijdsvergelijkingen_options", payload)
        return jsonify(payload)
    except SupabaseServiceError as e:
        return _dependency_error_response(
            log_message="tijdsvergelijkingen_options dependency failure",
            exc=e,
            user_message="Vergelijkingsopties tijdelijk niet beschikbaar.",
        )
    except Exception as e:  # noqa: BLE001 — opties moeten JSON blijven voor fetch()
        return _internal_error_response(
            log_message="tijdsvergelijkingen_options unexpected failure",
            exc=e,
            user_message="Vergelijkingsopties konden niet worden geladen.",
        )


def _normalize_year_list_for_json(years: list[Any]) -> list[int]:
    """Unieke jaren als int, aflopend (zoals verwacht door de Vergelijkingen-dropdowns)."""
    seen: set[int] = set()
    for y in years:
        try:
            yi = int(y)
        except (TypeError, ValueError):
            continue
        if yi > 0:
            seen.add(yi)
    return sorted(seen, reverse=True)


@dashboard_bp.route("/tijdsvergelijkingen/years", methods=["GET"])
def tijdsvergelijkingen_years():
    """
    Jaarlijst voor Primair/Referentiejaar — **zelfde bron als /overzicht/years** (`overzicht_years` RPC).

    De aparte RPC `tijdsvergelijkingen_years` bleek in de praktijk vaak leeg (andere filters,
    ontbrekende deploy, lege boekingsdatum) waardoor dropdowns stil leeg bleven. De
    Overzicht-flow is bewezen robuust; `date_type` / `bestemming_ids` hier zijn alleen
    voor logging/compat; de echte filtering gebeurt in `/tijdsvergelijkingen/data`.
    """
    brand = (request.args.get("brand") or "__all__").strip() or "__all__"
    date_type = (request.args.get("date_type") or "boekingsdatum").strip()
    bestemming_ids_raw = request.args.get("bestemming_ids") or ""
    supabase = SupabaseService()
    logger.info(
        "tijdsvergelijkingen/years query: brand=%r date_type=%r bestemming_ids=%r",
        brand,
        date_type,
        bestemming_ids_raw[:200] if bestemming_ids_raw else "",
    )
    years: list[int] = []
    try:
        years = supabase.get_overzicht_years_rpc(brand)
        logger.info("tijdsvergelijkingen/years: overzicht_years_rpc(%r) -> count=%s", brand, len(years))
    except SupabaseServiceError as e:
        logger.warning("tijdsvergelijkingen/years: overzicht voor merk faalde — probeer __all__: %s", e)
        try:
            years = supabase.get_overzicht_years_rpc("__all__")
            logger.info("tijdsvergelijkingen/years: overzicht_years_rpc('__all__') -> count=%s", len(years))
        except SupabaseServiceError as e2:
            return _dependency_error_response(
                log_message="tijdsvergelijkingen_years dependency failure fallback",
                exc=e2,
                user_message="Vergelijkingsjaren tijdelijk niet beschikbaar.",
                extra={"years": []},
            )
    normalized = _normalize_year_list_for_json(years)
    if _is_versie_b_session():
        cy = _resolve_year_for_session(None, allow_previous_year=True)
        normalized = [cy, cy - 1]
    logger.info("tijdsvergelijkingen/years response: count=%s first=%s", len(normalized), normalized[:8])
    return jsonify({"years": normalized})


def _enrich_tijdsvergelijkingen_period_year(payload: dict[str, Any]) -> None:
    """
    Als de Supabase-RPC nog geen period_year_compare teruggeeft, bouw jaartotalen
    uit period_compare (zelfde totalen als de som van de maandrijen).
    """
    if not isinstance(payload, dict) or payload.get("error"):
        return
    existing = payload.get("period_year_compare")
    if isinstance(existing, list) and len(existing) > 0:
        return
    months = payload.get("period_compare")
    if not isinstance(months, list) or not months:
        return
    by_y: dict[int, dict[str, float]] = {}
    for row in months:
        pk = row.get("period_key")
        if pk is None:
            continue
        try:
            y = int(pk) // 100
        except (TypeError, ValueError):
            continue
        acc = by_y.setdefault(
            y,
            {
                "pax_current": 0.0,
                "pax_previous": 0.0,
                "omzet_current": 0.0,
                "omzet_previous": 0.0,
                "boekingen_current": 0.0,
                "boekingen_previous": 0.0,
            },
        )
        acc["pax_current"] += float(row.get("pax_current") or 0)
        acc["pax_previous"] += float(row.get("pax_previous") or 0)
        acc["omzet_current"] += float(row.get("omzet_current") or 0)
        acc["omzet_previous"] += float(row.get("omzet_previous") or 0)
        acc["boekingen_current"] += float(row.get("boekingen_current") or 0)
        acc["boekingen_previous"] += float(row.get("boekingen_previous") or 0)
    out: list[dict[str, Any]] = []
    for y in sorted(by_y.keys()):
        a = by_y[y]
        pax_c, pax_p = a["pax_current"], a["pax_previous"]
        omz_c, omz_p = a["omzet_current"], a["omzet_previous"]
        gem_c = omz_c / pax_c if pax_c else 0.0
        gem_p = omz_p / pax_p if pax_p else 0.0
        out.append(
            {
                "period_key": y,
                "period_label": str(y),
                "pax_current": pax_c,
                "pax_previous": pax_p,
                "omzet_current": omz_c,
                "omzet_previous": omz_p,
                "gem_prijs_current": gem_c,
                "gem_prijs_previous": gem_p,
                "delta_omzet": omz_c - omz_p,
                "delta_gem_prijs": gem_c - gem_p,
                "boekingen_current": int(a["boekingen_current"]),
                "boekingen_previous": int(a["boekingen_previous"]),
            }
        )
    payload["period_year_compare"] = out


@dashboard_bp.route("/tijdsvergelijkingen/data", methods=["GET"])
def tijdsvergelijkingen_data():
    supabase = SupabaseService()
    try:
        date_type = request.args.get("date_type", "boekingsdatum")
        period = request.args.get("period", "maand")
        brand = request.args.get("brand", "__all__")
        requested_current_year = int(request.args.get("current_year", "0") or "0")
        requested_compare_year = int(request.args.get("compare_year", "0") or "0")
        current_year = _resolve_year_for_session(
            requested_current_year,
            allow_previous_year=True,
        )
        compare_year = requested_compare_year
        if _is_versie_b_session():
            compare_year = current_year - 1
        if current_year <= 0 or compare_year <= 0:
            return jsonify({"error": "current_year en compare_year zijn verplicht"}), 400

        bestemming_ids_raw = request.args.get("bestemming_ids") or ""
        bestemming_ids = [x for x in bestemming_ids_raw.split(",") if x]

        # Trend-KPI is puur client-side; RPC gebruikt p_kpi niet voor reeksen (zie tijdsvergelijkingen_data).
        kpi = "pax"

        date_from_raw = (request.args.get("date_from") or "").strip() or None
        date_to_raw = (request.args.get("date_to") or "").strip() or None

        payload = supabase.tijdsvergelijkingen_data_rpc(
            date_type=date_type,
            period=period.strip().lower() if period else "maand",
            current_year=current_year,
            compare_year=compare_year,
            bestemming_ids=bestemming_ids,
            brand=brand,
            kpi=kpi,
            date_from=date_from_raw,
            date_to=date_to_raw,
        )
        if isinstance(payload, dict):
            _enrich_tijdsvergelijkingen_period_year(payload)
        return jsonify(payload)
    except SupabaseServiceError as e:
        return _dependency_error_response(
            log_message="tijdsvergelijkingen_data dependency failure",
            exc=e,
            user_message="Vergelijkingsdata tijdelijk niet beschikbaar.",
        )
    except ValueError:
        return jsonify({"error": "Ongeldige queryparameters"}), 400
    except Exception as e:  # noqa: BLE001 — API moet JSON teruggeven, geen Flask 500 HTML
        return _internal_error_response(
            log_message="tijdsvergelijkingen_data unexpected failure",
            exc=e,
            user_message="Vergelijkingsdata kon niet worden geladen.",
        )


@dashboard_bp.route("/dagtrends", methods=["GET"])
def dagtrends() -> str:
    """
    Dag-per-dag vergelijkingstool met backend-data.
    """
    return render_template("dashboard/dagtrends.html")


def _safe_parse_date(value: str | None) -> date | None:
    if not value:
        return None
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def _safe_float(value: object, fallback: float = 0.0) -> float:
    try:
        if value is None:
            return fallback
        return float(value)
    except (TypeError, ValueError):
        return fallback


def _safe_int(value: object, fallback: int = 0) -> int:
    try:
        if value is None:
            return fallback
        return int(float(value))
    except (TypeError, ValueError):
        return fallback


def _fetch_all_data_verzameling_rows(
    *,
    supabase: SupabaseService,
    brand: str,
    bestemming_id: str | None,
    year: int,
    date_kind: str,
    date_from: date | None,
    date_to: date | None,
    max_pages: int = 20,
) -> list[dict]:
    date_from_iso = date_from.isoformat() if date_from else None
    date_to_iso = date_to.isoformat() if date_to else None
    rows: list[dict] = []
    page_size = 1000
    offset = 0
    for _ in range(max_pages):
        page = supabase.data_verzameling_list_rpc(
            search=None,
            brand=brand,
            bestemming_id=bestemming_id,
            year=year,
            status_id=None,
            date_kind=date_kind,
            date_from=date_from_iso,
            date_to=date_to_iso,
            limit=page_size,
            offset=offset,
        )
        if not page:
            break
        rows.extend(page)
        if len(page) < page_size:
            break
        offset += page_size
    return rows


@dashboard_bp.route("/dagtrends/options", methods=["GET"])
def dagtrends_options():
    cached = _get_cached_options("dagtrends_options")
    if cached is not None:
        return jsonify(cached)
    supabase = SupabaseService()
    try:
        brands = supabase.get_overzicht_brands_rpc()
        bestemmingen = supabase.get_data_verzameling_bestemmingen()
        years = supabase.get_overzicht_years_rpc("__all__")
        today = date.today()
        payload = {
            "brands": brands,
            "bestemmingen": bestemmingen,
            "years": years,
            "default_date_from": date(today.year, 1, 1).isoformat(),
            "default_date_to": today.isoformat(),
        }
        if _is_versie_b_session():
            payload["years"] = [_resolve_year_for_session(None)]
        _set_cached_options("dagtrends_options", payload)
        return jsonify(payload)
    except SupabaseServiceError as e:
        return _dependency_error_response(
            log_message="dagtrends_options dependency failure",
            exc=e,
            user_message="Dagtrends-opties tijdelijk niet beschikbaar.",
        )


def _shift_year_safe(d: date, delta_years: int) -> date:
    y = d.year + delta_years
    try:
        return d.replace(year=y)
    except ValueError:
        # 29 feb -> 28 feb in non-leap year
        return d.replace(year=y, day=28)


def _parse_country(row: dict) -> str | None:
    """
    Afleid BE / NL / IT uit dossierrij (zelfde bron als heatmap: eerst land van eerste reiziger).
    data_verzameling_list levert kolom 'land'; ontbrekende/ onbekende waarden → None.
    """
    candidate = (
        row.get("land")
        or row.get("country")
        or row.get("Land")
        or row.get("Country")
    )
    if candidate is None:
        return None
    raw = str(candidate).strip()
    if not raw:
        return None
    t = raw.lower()
    if t in {"be", "belgium", "belgie", "belgië", "belgïe"}:
        return "BE"
    if t in {"nl", "nederland", "netherlands", "holland"}:
        return "NL"
    if t in {"it", "italy", "italia", "italië", "italie"}:
        return "IT"
    u = raw.upper()
    if u in {"BE", "BELGIUM", "BELGIE", "BELGIË"}:
        return "BE"
    if u in {"NL", "NEDERLAND", "NETHERLANDS"}:
        return "NL"
    if u in {"IT", "ITALY", "ITALIA"}:
        return "IT"
    return None


def _daterange_inclusive(start: date, end: date) -> list[date]:
    out: list[date] = []
    cur = start
    while cur <= end:
        out.append(cur)
        cur = cur + timedelta(days=1)
    return out


def _fetch_heatmap_month_candidate_rows(
    supabase: SupabaseService,
    *,
    brand: str,
    bestemming_id: str | None,
    left_year: int,
    right_year: int,
    month: int,
    max_pages: int = 400,
    page_size: int = 2000,
) -> list[dict]:
    rows: list[dict] = []
    offset = 0
    brand_rpc = brand if brand and str(brand).lower() not in {"__all__", "all"} else "__all__"
    for _ in range(max_pages):
        page = supabase.dagtrends_heatmap_month_rows_rpc(
            brand=brand_rpc,
            bestemming_id=bestemming_id,
            left_year=left_year,
            right_year=right_year,
            month=month,
            limit=page_size,
            offset=offset,
        )
        if not page:
            break
        rows.extend(page)
        if len(page) < page_size:
            break
        offset += page_size
    return rows


def _heatmap_aggregate_month_days(
    rows: list[dict],
    *,
    year: int,
    month: int,
    country: str,
) -> list[dict]:
    """Boekingen/pax op boekingsdatum; reizigers = som pax op elke kalenderdag van verblijf (inclusief vertrek en terug)."""
    last_d = calendar.monthrange(year, month)[1]
    first = date(year, month, 1)
    last = date(year, month, last_d)

    def include_row(row: dict) -> bool:
        if country == "__ALL__":
            return True
        return _parse_country(row) == country

    filtered = [r for r in rows if include_row(r)]

    bookings: dict[date, int] = defaultdict(int)
    pax_on_booking_day: dict[date, int] = defaultdict(int)
    travellers: dict[date, int] = defaultdict(int)

    for r in filtered:
        pax = _safe_int(r.get("aantal_reizigers"), 0)
        bd = _safe_parse_date(str(r.get("boekingsdatum") or ""))
        if bd and bd.year == year and bd.month == month:
            bookings[bd] += 1
            pax_on_booking_day[bd] += pax

        vd = _safe_parse_date(str(r.get("vertrekdatum") or ""))
        td_raw = _safe_parse_date(str(r.get("terugkeerdatum") or ""))
        if not vd:
            continue
        td = td_raw if td_raw is not None else vd
        if td < vd:
            td = vd
        lo = max(vd, first)
        hi = min(td, last)
        if lo > hi:
            continue
        d = lo
        while d <= hi:
            travellers[d] += pax
            d = d + timedelta(days=1)

    out: list[dict] = []
    for d in _daterange_inclusive(first, last):
        b = int(bookings.get(d, 0))
        tr = int(travellers.get(d, 0))
        ps = int(pax_on_booking_day.get(d, 0))
        out.append(
            {
                "date": d.isoformat(),
                "day": d.day,
                "bookings": b,
                "travellers": tr,
                "pax_on_booking_day": ps,
                "pax_per_booking": ps,
            }
        )
    return out


def _heatmap_debug_raw_totals_for_month(
    rows: list[dict],
    *,
    year: int,
    month: int,
    country: str,
) -> dict:
    """Totalen uit de gefetchte RPC-rijen (na landfilter), vergelijkbaar met KPI-definities."""
    last_d = calendar.monthrange(year, month)[1]
    first = date(year, month, 1)
    last = date(year, month, last_d)

    def include_row(row: dict) -> bool:
        if country == "__ALL__":
            return True
        return _parse_country(row) == country

    filtered = [r for r in rows if include_row(r)]
    bookings_cnt = 0
    pax_on_booking = 0
    travellers_daily: dict[date, int] = defaultdict(int)

    for r in filtered:
        pax = _safe_int(r.get("aantal_reizigers"), 0)
        bd = _safe_parse_date(str(r.get("boekingsdatum") or ""))
        if bd and bd.year == year and bd.month == month:
            bookings_cnt += 1
            pax_on_booking += pax

        vd = _safe_parse_date(str(r.get("vertrekdatum") or ""))
        td_raw = _safe_parse_date(str(r.get("terugkeerdatum") or ""))
        if not vd:
            continue
        td = td_raw if td_raw is not None else vd
        if td < vd:
            td = vd
        lo = max(vd, first)
        hi = min(td, last)
        if lo > hi:
            continue
        d = lo
        while d <= hi:
            travellers_daily[d] += pax
            d = d + timedelta(days=1)

    return {
        "records_found_raw": len(rows),
        "records_after_country_filter": len(filtered),
        "bookings_on_booking_date_in_month": bookings_cnt,
        "pax_on_booking_day_sum": pax_on_booking,
        "travellers_sum_over_days": sum(travellers_daily.values()),
        "travellers_calendar_days_gt0": sum(1 for v in travellers_daily.values() if v > 0),
    }


def _heatmap_day_series_stats(days: list[dict]) -> dict:
    if not days:
        return {
            "len": 0,
            "sum_bookings": 0,
            "sum_travellers": 0,
            "sum_pax_on_booking_day": 0,
            "nonzero_bookings_days": 0,
            "nonzero_travellers_days": 0,
            "nonzero_pax_days": 0,
            "first_date": None,
            "last_date": None,
        }
    sum_b = sum(int(d.get("bookings") or 0) for d in days)
    sum_t = sum(int(d.get("travellers") or 0) for d in days)
    sum_p = sum(int(d.get("pax_on_booking_day") or d.get("pax_per_booking") or 0) for d in days)
    return {
        "len": len(days),
        "sum_bookings": sum_b,
        "sum_travellers": sum_t,
        "sum_pax_on_booking_day": sum_p,
        "nonzero_bookings_days": sum(1 for d in days if int(d.get("bookings") or 0) > 0),
        "nonzero_travellers_days": sum(1 for d in days if int(d.get("travellers") or 0) > 0),
        "nonzero_pax_days": sum(1 for d in days if int(d.get("pax_on_booking_day") or d.get("pax_per_booking") or 0) > 0),
        "first_date": days[0].get("date"),
        "last_date": days[-1].get("date"),
    }


def _heatmap_truth_booking_map_from_rpc_rows(rows: list[dict]) -> dict[date, tuple[int, int]]:
    out: dict[date, tuple[int, int]] = {}
    for r in rows:
        raw_d = r.get("boekingsdag") or r.get("Boekingsdag")
        bd = _safe_parse_date(str(raw_d or ""))
        if not bd:
            continue
        out[bd] = (
            _safe_int(r.get("booking_count") or r.get("bookingcount"), 0),
            _safe_int(r.get("pax_sum") or r.get("paxsum"), 0),
        )
    return out


def _heatmap_fetch_truth_bookings_map(
    supabase: SupabaseService,
    *,
    brand: str,
    bestemming_id: str | None,
    year: int,
    month: int,
    country: str,
) -> dict[date, tuple[int, int]]:
    brand_rpc = brand if brand and str(brand).lower() not in {"__all__", "all"} else "__all__"
    rpc_rows = supabase.dagtrends_heatmap_bookings_by_booking_date_month_rpc(
        brand=brand_rpc,
        bestemming_id=bestemming_id,
        year=year,
        month=month,
        country=country,
    )
    return _heatmap_truth_booking_map_from_rpc_rows(rpc_rows)


def _merge_booking_kpi_from_truth(days: list[dict], truth: dict[date, tuple[int, int]]) -> None:
    for entry in days:
        bd = _safe_parse_date(str(entry.get("date") or ""))
        if not bd:
            continue
        c, p = truth.get(bd, (0, 0))
        entry["bookings"] = int(c)
        entry["pax_on_booking_day"] = int(p)
        entry["pax_per_booking"] = int(p)


def _heatmap_same_year_panels_identical(left: list[dict], right: list[dict]) -> bool:
    if len(left) != len(right):
        return False
    keys = ("date", "day", "bookings", "travellers", "pax_on_booking_day", "pax_per_booking")
    for a, b in zip(left, right, strict=True):
        for k in keys:
            if a.get(k) != b.get(k):
                return False
    return True


def _heatmap_debug_endpoint_allowed() -> bool:
    return os.environ.get("ALLOW_HEATMAP_DEBUG", "").strip().lower() in ("1", "true", "yes", "on")


@dashboard_bp.route("/dagtrends/debug/heatmap-month", methods=["GET"])
def dagtrends_debug_heatmap_month():
    """Eén jaar + maand, ruwe fetch + totalen. Alleen in debug of met ALLOW_HEATMAP_DEBUG=1."""
    if not (current_app.debug or _heatmap_debug_endpoint_allowed()):
        return jsonify({"error": "Not found"}), 404
    try:
        requested_year = int(request.args.get("year") or 0)
        year = _resolve_year_for_session(requested_year, allow_previous_year=True)
        month = int(request.args.get("month") or 0)
        if month < 1 or month > 12 or year < 1990 or year > 2100:
            return jsonify({"error": "year en month (1–12) zijn verplicht"}), 400

        destination_id = request.args.get("destination") or "__all__"
        country = (request.args.get("country") or "__all__").upper()
        brand_raw = (request.args.get("brand") or "__all__").strip()
        brand_for = "__all__" if not brand_raw or brand_raw.lower() in {"__all__", "all"} else brand_raw
        destination_for = None if destination_id == "__all__" else destination_id
        kpi = (request.args.get("kpi") or "bookings").lower()

        supabase = SupabaseService()
        rows = _fetch_heatmap_month_candidate_rows(
            supabase,
            brand=brand_for,
            bestemming_id=destination_for,
            left_year=year,
            right_year=year,
            month=month,
        )
        days = _heatmap_aggregate_month_days(rows, year=year, month=month, country=country)
        raw = _heatmap_debug_raw_totals_for_month(rows, year=year, month=month, country=country)
        stats = _heatmap_day_series_stats(days)

        def nz_book(dlist: list[dict]) -> int:
            return sum(1 for d in dlist if int(d.get("bookings") or 0) > 0)

        truth_rows: list[dict] = []
        truth_error: str | None = None
        try:
            truth_map = _heatmap_fetch_truth_bookings_map(
                supabase,
                brand=brand_for,
                bestemming_id=destination_for,
                year=year,
                month=month,
                country=country,
            )
            truth_rows = [
                {"date": d.isoformat(), "bookings": truth_map.get(d, (0, 0))[0], "pax": truth_map.get(d, (0, 0))[1]}
                for d in _daterange_inclusive(date(year, month, 1), date(year, month, calendar.monthrange(year, month)[1]))
            ]
        except SupabaseServiceError as e:
            logger.warning("dagtrends_debug_heatmap_month truth map dependency failure: %s", e)
            truth_error = "Truth-map tijdelijk niet beschikbaar."

        return jsonify(
            {
                "year": year,
                "month": month,
                "kpi_echo": kpi,
                "destination": destination_id,
                "country": country,
                "rows_fetched": len(rows),
                "raw_aggregates_on_fetched_rows": raw,
                "aggregated_day_stats_before_truth_merge": stats,
                "truth_bookings_by_booking_date_sql": truth_rows,
                "truth_rpc_error": truth_error,
                "nonzero_bookings_days": nz_book(days),
                "note": "truth_bookings_by_booking_date_sql = DB-grondwaarheid op boekingsdatum; aggregated_* gebruikt nog overlap-RPC vóór merge.",
            }
        )
    except SupabaseServiceError as e:
        return _dependency_error_response(
            log_message="dagtrends_debug_heatmap_month dependency failure",
            exc=e,
            user_message="Dagtrends debugdata tijdelijk niet beschikbaar.",
            status=503,
        )
    except (TypeError, ValueError):
        return jsonify({"error": "Ongeldige queryparameters"}), 400


@dashboard_bp.route("/dagtrends/heatmap-month", methods=["GET"])
def dagtrends_heatmap_month():
    """Dag-heatmap: twee gekozen jaren, zelfde maand; correcte KPI's volgens boekingsdatum / verblijf / pax op boekingsdag."""
    try:
        supabase = SupabaseService()
        month = int(request.args.get("month") or 0)
        if month < 1 or month > 12:
            return jsonify({"error": "month moet 1–12 zijn"}), 400

        left_year = int(request.args.get("left_year") or date.today().year)
        right_year = int(request.args.get("right_year") or date.today().year - 1)
        if _is_versie_b_session():
            right_year = _resolve_year_for_session(None, allow_previous_year=True) - 1
        if left_year < 1990 or left_year > 2100 or right_year < 1990 or right_year > 2100:
            return jsonify({"error": "Ongeldig jaar"}), 400

        destination_id = request.args.get("destination") or "__all__"
        country = (request.args.get("country") or "__all__").upper()
        brand_raw = (request.args.get("brand") or "__all__").strip()
        brand_for = "__all__" if not brand_raw or brand_raw.lower() in {"__all__", "all"} else brand_raw
        destination_for = None if destination_id == "__all__" else destination_id

        # Twee aparte pulls: de RPC sorteert op boekingsdatum DESC. Eén gecombineerde query laat bij
        # paginering vaak alleen "nieuwste" rijen binnen de union zien → het oudere jaar (rechts) viel
        # buiten de offset-range. Per jaar eigen venster (left_year==right_year in de call) lost dat op.
        if left_year == right_year:
            rows_one = _fetch_heatmap_month_candidate_rows(
                supabase,
                brand=brand_for,
                bestemming_id=destination_for,
                left_year=left_year,
                right_year=left_year,
                month=month,
            )
            n_rows_left = len(rows_one)
            n_rows_right = n_rows_left
            left_days = _heatmap_aggregate_month_days(rows_one, year=left_year, month=month, country=country)
            right_days = list(left_days)
        else:
            rows_left = _fetch_heatmap_month_candidate_rows(
                supabase,
                brand=brand_for,
                bestemming_id=destination_for,
                left_year=left_year,
                right_year=left_year,
                month=month,
            )
            rows_right = _fetch_heatmap_month_candidate_rows(
                supabase,
                brand=brand_for,
                bestemming_id=destination_for,
                left_year=right_year,
                right_year=right_year,
                month=month,
            )
            n_rows_left = len(rows_left)
            n_rows_right = len(rows_right)
            left_days = _heatmap_aggregate_month_days(rows_left, year=left_year, month=month, country=country)
            right_days = _heatmap_aggregate_month_days(rows_right, year=right_year, month=month, country=country)

        truth_left_map: dict[date, tuple[int, int]] = {}
        truth_right_map: dict[date, tuple[int, int]] = {}
        try:
            if left_year == right_year:
                truth_left_map = _heatmap_fetch_truth_bookings_map(
                    supabase,
                    brand=brand_for,
                    bestemming_id=destination_for,
                    year=left_year,
                    month=month,
                    country=country,
                )
                truth_right_map = truth_left_map
            else:
                truth_left_map = _heatmap_fetch_truth_bookings_map(
                    supabase,
                    brand=brand_for,
                    bestemming_id=destination_for,
                    year=left_year,
                    month=month,
                    country=country,
                )
                truth_right_map = _heatmap_fetch_truth_bookings_map(
                    supabase,
                    brand=brand_for,
                    bestemming_id=destination_for,
                    year=right_year,
                    month=month,
                    country=country,
                )
            _merge_booking_kpi_from_truth(left_days, truth_left_map)
            _merge_booking_kpi_from_truth(right_days, truth_right_map)
        except SupabaseServiceError as truth_err:
            logger.warning(
                "heatmap-month TRUTH_BOOKINGS_RPC ontbreekt of faalt (%s). "
                "Deploy dagtrends_heatmap_bookings_by_booking_date_month in Supabase. Boekingen blijven uit overlap-RPC.",
                truth_err,
            )

        st_left = _heatmap_day_series_stats(left_days)
        st_right = _heatmap_day_series_stats(right_days)
        test_a_identical = (
            _heatmap_same_year_panels_identical(left_days, right_days) if left_year == right_year else None
        )

        try:
            yrows = supabase.dagtrends_heatmap_booking_years_rpc()
            raw_years: set[int] = set()
            for r in yrows:
                j = r.get("jaar") if isinstance(r, dict) else None
                if j is None:
                    j = r.get("Jaar") if isinstance(r, dict) else None
                if j is not None:
                    try:
                        raw_years.add(int(j))
                    except (TypeError, ValueError):
                        pass
            available_years = sorted(raw_years, reverse=True)
        except SupabaseServiceError:
            available_years = sorted({left_year, right_year, date.today().year}, reverse=True)

        if not available_years:
            available_years = sorted({date.today().year, date.today().year - 1}, reverse=True)

        year_opts: set[int] = set()
        for y in available_years:
            try:
                year_opts.add(int(y))
            except (TypeError, ValueError):
                pass
        year_opts.add(left_year)
        year_opts.add(right_year)
        available_years = sorted(year_opts, reverse=True)

        payload: dict = {
            "month": month,
            "left_year": left_year,
            "right_year": right_year,
            "left_days": left_days,
            "right_days": right_days,
            "available_years": available_years,
        }
        if request.args.get("heatmap_debug") == "1" and (
            current_app.debug or _heatmap_debug_endpoint_allowed()
        ):
            payload["_debug"] = {
                "aggregated_left": st_left,
                "aggregated_right": st_right,
                "test_a_panels_identical": test_a_identical,
                "fetched_row_counts": {"left": n_rows_left, "right": n_rows_right},
            }

        return jsonify(payload)
    except SupabaseServiceError as e:
        request_id = _build_request_id()
        logger.warning("dagtrends_heatmap_month_rpc failed request_id=%s error=%s", request_id, e)
        return jsonify(
            {
                "error": "Heatmap-data ophalen mislukt. Controleer of RPC dagtrends_heatmap_month_rows en "
                "dagtrends_heatmap_booking_years in Supabase geïmplementeerd zijn (zie sql/rpc/dagtrends_heatmap_rpc.sql).",
                "request_id": request_id,
            }
        ), 503
    except (TypeError, ValueError):
        return jsonify({"error": "Ongeldige queryparameters"}), 400


LEAD_TIME_DIST_LABELS = [
    "0 - 14 dagen",
    "14 dagen - 1 maand",
    "1 - 2 maanden",
    "2 - 3 maanden",
    "3 - 4 maanden",
    "4 - 5 maanden",
    "5 - 6 maanden",
    "6 - 7 maanden",
    "7 - 8 maanden",
    "8+ maanden",
]


def _lead_time_bucket_index(delta_days: int) -> int:
    if delta_days <= 14:
        return 0
    if delta_days <= 30:
        return 1
    if delta_days <= 60:
        return 2
    if delta_days <= 90:
        return 3
    if delta_days <= 120:
        return 4
    if delta_days <= 150:
        return 5
    if delta_days <= 180:
        return 6
    if delta_days <= 210:
        return 7
    if delta_days <= 240:
        return 8
    return 9


def _boekingentrends_payload_from_aggregate(
    agg: dict[str, Any],
    date_from: date,
    date_to: date,
    granularity: str,
) -> dict[str, Any]:
    """Zet JSON van dagtrends_boekingentrends_aggregate om naar het bestaande API-schema."""
    selected_year = date_from.year

    def getFilteredBookingsForDepartureYear(series: Any, departure_year: int) -> list[tuple[date, int]]:
        filtered: list[tuple[date, int]] = []
        if not isinstance(series, list):
            return filtered
        for row in series:
            if not isinstance(row, dict):
                continue
            booking_date = _safe_parse_date(str(row.get("booking_date") or ""))
            departure_date = _safe_parse_date(str(row.get("departure_date") or ""))
            if not booking_date or not departure_date:
                continue
            if departure_date.year != departure_year:
                continue
            filtered.append((booking_date, int(row.get("pax") or 0)))
        filtered.sort(key=lambda x: x[0])
        return filtered

    def buildCumulativeSeries(series: list[tuple[date, int]]) -> tuple[list[str], list[int]]:
        labels: list[str] = []
        values: list[int] = []
        running = 0
        for booking_day, pax in series:
            running += int(pax or 0)
            labels.append(booking_day.strftime("%d-%m"))
            values.append(running)
        return labels, values

    daily_cur: dict[date, int] = {}
    for x in agg.get("daily_current") or []:
        if not isinstance(x, dict):
            continue
        d = _safe_parse_date(str(x.get("d") or ""))
        if d:
            daily_cur[d] = int(x.get("pax") or 0)
    daily_prev: dict[date, int] = {}
    for x in agg.get("daily_previous") or []:
        if not isinstance(x, dict):
            continue
        d = _safe_parse_date(str(x.get("d") or ""))
        if d:
            daily_prev[d] = int(x.get("pax") or 0)

    all_days = _daterange_inclusive(date_from, date_to)
    daily_pax_current: list[int] = [daily_cur.get(d, 0) for d in all_days]
    daily_pax_previous: list[int] = [daily_prev.get(_shift_year_safe(d, -1), 0) for d in all_days]

    pax_labels: list[str] = []
    pax_values: list[int] = []
    pax_values_previous: list[int] = []
    if granularity == "day":
        pax_labels = [d.strftime("%d-%m") for d in all_days]
        pax_values = list(daily_pax_current)
        pax_values_previous = list(daily_pax_previous)
    elif granularity == "week":
        week_pax: dict[tuple[int, int], int] = defaultdict(int)
        week_pax_prev: dict[tuple[int, int], int] = defaultdict(int)
        for idx, d in enumerate(all_days):
            yw = d.isocalendar()
            ky = (yw.year, yw.week)
            week_pax[ky] += daily_pax_current[idx]
            week_pax_prev[ky] += daily_pax_previous[idx]
        keys_sorted = sorted(week_pax.keys())
        pax_labels = [f"{y}-W{w:02d}" for y, w in keys_sorted]
        pax_values = [week_pax[k] for k in keys_sorted]
        pax_values_previous = [week_pax_prev[k] for k in keys_sorted]
    else:
        month_pax: dict[tuple[int, int], int] = defaultdict(int)
        month_pax_prev: dict[tuple[int, int], int] = defaultdict(int)
        for idx, d in enumerate(all_days):
            ky = (d.year, d.month)
            month_pax[ky] += daily_pax_current[idx]
            month_pax_prev[ky] += daily_pax_previous[idx]
        keys_sorted = sorted(month_pax.keys())
        pax_labels = [f"{y}-{m:02d}" for y, m in keys_sorted]
        pax_values = [month_pax[k] for k in keys_sorted]
        pax_values_previous = [month_pax_prev[k] for k in keys_sorted]

    current_series = getFilteredBookingsForDepartureYear(agg.get("booking_series_current"), selected_year)
    pax_cumulative_labels, pax_cumulative_values = buildCumulativeSeries(current_series)
    if not pax_cumulative_values:
        pax_cumulative_labels = pax_labels
        pax_cumulative_values = []
        run_p = 0
        for v in pax_values:
            run_p += v
            pax_cumulative_values.append(run_p)

    previous_series_raw = agg.get("booking_series_previous")
    previous_series: list[tuple[date, int]] = []
    if isinstance(previous_series_raw, list):
        for row in previous_series_raw:
            if not isinstance(row, dict):
                continue
            booking_date = _safe_parse_date(str(row.get("booking_date") or ""))
            if not booking_date:
                continue
            previous_series.append((booking_date, int(row.get("pax") or 0)))
    previous_series.sort(key=lambda x: x[0])
    _, pax_cumulative_values_previous = buildCumulativeSeries(previous_series)
    if not pax_cumulative_values_previous:
        run_pp = 0
        pax_cumulative_values_previous = []
        for v in pax_values_previous:
            run_pp += v
            pax_cumulative_values_previous.append(run_pp)

    bookings_in_period = int(agg.get("bookings_in_period") or 0)
    total_pax_period = int(agg.get("pax_in_period") or 0)
    total_pax_prev_period = int(agg.get("pax_prev_period") or 0)
    if total_pax_prev_period > 0:
        pct_vs_last_year_pax = round(
            (total_pax_period - total_pax_prev_period) / total_pax_prev_period * 100.0,
            1,
        )
    elif total_pax_period > 0:
        pct_vs_last_year_pax = None
    else:
        pct_vs_last_year_pax = 0.0

    lead = agg.get("lead") if isinstance(agg.get("lead"), dict) else {}
    raw_dist = lead.get("dist_counts") or []
    dist_counts: list[int] = []
    if isinstance(raw_dist, list):
        dist_counts = [int(c or 0) for c in raw_dist][: len(LEAD_TIME_DIST_LABELS)]
    while len(dist_counts) < len(LEAD_TIME_DIST_LABELS):
        dist_counts.append(0)
    dist_total = int(lead.get("total_bookings_with_dates") or sum(dist_counts))
    dist_percents = [
        round((c / dist_total) * 100.0, 1) if dist_total > 0 else 0.0 for c in dist_counts
    ]

    avg_be = lead.get("avg_be")
    avg_nl = lead.get("avg_nl")
    if avg_be is not None:
        avg_be = float(avg_be)
    if avg_nl is not None:
        avg_nl = float(avg_nl)

    bins_legacy = ["0-7", "8-14", "15-30", "31-60", "61-90", "90+"]

    def _json_int_list(val: object, n: int) -> list[int]:
        if not isinstance(val, list):
            return [0] * n
        out = [int(x or 0) for x in val][:n]
        while len(out) < n:
            out.append(0)
        return out

    be_legacy = _json_int_list(lead.get("be_legacy"), 6)
    nl_legacy = _json_int_list(lead.get("nl_legacy"), 6)

    return {
        "kpis": {
            "bookings_in_period": bookings_in_period,
            "pax_in_period": int(total_pax_period),
            "pct_vs_last_year_pax": pct_vs_last_year_pax,
        },
        "granularity": granularity,
        "pax_tempo": {
            "labels": pax_labels,
            "values": pax_values,
            "values_previous": pax_values_previous,
        },
        "booking_series_current": agg.get("booking_series_current") or [],
        "pax_cumulative": {
            "labels": pax_cumulative_labels,
            "values": pax_cumulative_values,
            "values_previous": pax_cumulative_values_previous,
        },
        "lead_time": {
            "avg_be": avg_be,
            "avg_nl": avg_nl,
            "distribution": {
                "labels": LEAD_TIME_DIST_LABELS,
                "counts": dist_counts,
                "percents": dist_percents,
                "total_bookings_with_dates": dist_total,
            },
            "labels": bins_legacy,
            "be": be_legacy,
            "nl": nl_legacy,
        },
    }


@dashboard_bp.route("/dagtrends/boekingentrends-data", methods=["GET"])
def dagtrends_boekingentrends_data():
    try:
        date_from = _safe_parse_date(request.args.get("date_from")) or date(date.today().year, 1, 1)
        date_to = _safe_parse_date(request.args.get("date_to")) or date.today()
        if date_to < date_from:
            return jsonify({"error": "date_to moet na date_from liggen"}), 400

        destination_id = request.args.get("destination") or "__all__"
        brand_raw = (request.args.get("brand") or "__all__").strip()
        brand_for_rpc = "__all__" if not brand_raw or brand_raw.lower() in {"__all__", "all"} else brand_raw
        country = (request.args.get("country") or "__all__").upper()
        granularity = (request.args.get("granularity") or "day").lower()
        if granularity not in {"day", "week", "month"}:
            granularity = "day"

        destination_for_main = None if destination_id == "__all__" else destination_id

        prev_from = _shift_year_safe(date_from, -1)
        prev_to = _shift_year_safe(date_to, -1)

        agg: dict[str, Any] | None = None
        try:
            agg = SupabaseService().dagtrends_boekingentrends_aggregate_rpc(
                brand=brand_for_rpc,
                bestemming_id=destination_for_main,
                date_from=date_from,
                date_to=date_to,
                prev_from=prev_from,
                prev_to=prev_to,
                country=country,
            )
        except SupabaseServiceError as rpc_err:
            logger.warning(
                "dagtrends_boekingentrends_aggregate RPC faalt of ontbreekt; langzame fallback: %s",
                rpc_err,
            )
            agg = None

        if isinstance(agg, dict) and "daily_current" in agg:
            return jsonify(_boekingentrends_payload_from_aggregate(agg, date_from, date_to, granularity))

        def include_row(row: dict) -> bool:
            if country == "__ALL__":
                return True
            row_country = _parse_country(row)
            return row_country == country

        # Aparte queries per jaarvenster: data_verzameling_list sorteert op boekingsdatum DESC.
        # Eén brede gecombineerde query + paginering kan bv. alleen 2026 vullen en 2025 nooit bereiken.
        _trend_pages = 80
        # RPC-filter is <= p_date_to (inclusief einddag); geen +1 day — anders viel er een extra kalenderdag mee.
        # Twee pagineringen parallel (eigen Supabase-client per thread i.v.m. thread-safety).
        def _pull_current_window() -> list[dict]:
            sb = SupabaseService()
            return _fetch_all_data_verzameling_rows(
                supabase=sb,
                brand=brand_for_rpc,
                bestemming_id=destination_for_main,
                year=0,
                date_kind="boekingsdatum",
                date_from=date_from,
                date_to=date_to,
                max_pages=_trend_pages,
            )

        def _pull_previous_window() -> list[dict]:
            sb = SupabaseService()
            return _fetch_all_data_verzameling_rows(
                supabase=sb,
                brand=brand_for_rpc,
                bestemming_id=destination_for_main,
                year=0,
                date_kind="boekingsdatum",
                date_from=prev_from,
                date_to=prev_to,
                max_pages=_trend_pages,
            )

        with ThreadPoolExecutor(max_workers=2) as pool:
            fut_cur = pool.submit(_pull_current_window)
            fut_prev = pool.submit(_pull_previous_window)
            current_rows = fut_cur.result()
            previous_rows = fut_prev.result()
        current_rows = [r for r in current_rows if include_row(r)]
        previous_rows = [r for r in previous_rows if include_row(r)]

        current_day_counts: dict[date, int] = defaultdict(int)
        prev_day_counts: dict[date, int] = defaultdict(int)
        current_day_pax: dict[date, int] = defaultdict(int)
        prev_day_pax: dict[date, int] = defaultdict(int)
        lead_days_be: list[int] = []
        lead_days_nl: list[int] = []
        lead_days_all: list[int] = []

        for row in current_rows:
            bd = _safe_parse_date(str(row.get("boekingsdatum") or ""))
            vd = _safe_parse_date(str(row.get("vertrekdatum") or ""))
            if bd:
                current_day_counts[bd] += 1
                current_day_pax[bd] += _safe_int(row.get("aantal_reizigers"), 0)
            if bd and vd and vd >= bd:
                lead_days = (vd - bd).days
                lead_days_all.append(lead_days)
                c = _parse_country(row)
                if c == "BE":
                    lead_days_be.append(lead_days)
                elif c == "NL":
                    lead_days_nl.append(lead_days)

        for row in previous_rows:
            bd = _safe_parse_date(str(row.get("boekingsdatum") or ""))
            if bd:
                prev_day_counts[bd] += 1
                prev_day_pax[bd] += _safe_int(row.get("aantal_reizigers"), 0)

        all_days = _daterange_inclusive(date_from, date_to)
        daily_pax_current: list[int] = []
        daily_pax_previous: list[int] = []
        for d in all_days:
            cur_pax = current_day_pax.get(d, 0)
            prev_pax = prev_day_pax.get(_shift_year_safe(d, -1), 0)
            daily_pax_current.append(cur_pax)
            daily_pax_previous.append(prev_pax)

        pax_labels: list[str] = []
        pax_values: list[int] = []
        pax_values_previous: list[int] = []
        if granularity == "day":
            pax_labels = [d.strftime("%d-%m") for d in all_days]
            pax_values = list(daily_pax_current)
            pax_values_previous = list(daily_pax_previous)
        elif granularity == "week":
            week_pax: dict[tuple[int, int], int] = defaultdict(int)
            week_pax_prev: dict[tuple[int, int], int] = defaultdict(int)
            for idx, d in enumerate(all_days):
                yw = d.isocalendar()
                ky = (yw.year, yw.week)
                week_pax[ky] += daily_pax_current[idx]
                week_pax_prev[ky] += daily_pax_previous[idx]
            keys_sorted = sorted(week_pax.keys())
            pax_labels = [f"{y}-W{w:02d}" for y, w in keys_sorted]
            pax_values = [week_pax[k] for k in keys_sorted]
            pax_values_previous = [week_pax_prev[k] for k in keys_sorted]
        else:
            month_pax: dict[tuple[int, int], int] = defaultdict(int)
            month_pax_prev: dict[tuple[int, int], int] = defaultdict(int)
            for idx, d in enumerate(all_days):
                ky = (d.year, d.month)
                month_pax[ky] += daily_pax_current[idx]
                month_pax_prev[ky] += daily_pax_previous[idx]
            keys_sorted = sorted(month_pax.keys())
            pax_labels = [f"{y}-{m:02d}" for y, m in keys_sorted]
            pax_values = [month_pax[k] for k in keys_sorted]
            pax_values_previous = [month_pax_prev[k] for k in keys_sorted]

        pax_cumulative_values: list[int] = []
        run_p = 0
        for v in pax_values:
            run_p += v
            pax_cumulative_values.append(run_p)

        pax_cumulative_values_previous: list[int] = []
        run_pp = 0
        for v in pax_values_previous:
            run_pp += v
            pax_cumulative_values_previous.append(run_pp)

        bookings_in_period = len(current_rows)
        # Zelfde definitie als KPI's: totale pax in de opgehaalde dossiers (boekingsdatum binnen venster).
        # Niet via som van dagelijkse uitlijning t.o.v. vorig jaar — dat gaf afwijkingen t.o.v. previous_rows.
        total_pax_period = sum(_safe_int(r.get("aantal_reizigers"), 0) for r in current_rows)
        total_pax_prev_period = sum(_safe_int(r.get("aantal_reizigers"), 0) for r in previous_rows)
        if total_pax_prev_period > 0:
            pct_vs_last_year_pax = round(
                (total_pax_period - total_pax_prev_period) / total_pax_prev_period * 100.0,
                1,
            )
        elif total_pax_period > 0:
            pct_vs_last_year_pax = None
        else:
            pct_vs_last_year_pax = 0.0

        dist_counts = [0] * len(LEAD_TIME_DIST_LABELS)
        for v in lead_days_all:
            dist_counts[_lead_time_bucket_index(v)] += 1
        dist_total = sum(dist_counts)
        dist_percents = [round((c / dist_total) * 100.0, 1) if dist_total > 0 else 0.0 for c in dist_counts]

        avg_be = round(sum(lead_days_be) / len(lead_days_be), 1) if lead_days_be else None
        avg_nl = round(sum(lead_days_nl) / len(lead_days_nl), 1) if lead_days_nl else None
        logger.debug(
            "boekingentrends lead_time: rows=%s valid_lead=%s be_n=%s nl_n=%s avg_be=%s avg_nl=%s",
            len(current_rows),
            len(lead_days_all),
            len(lead_days_be),
            len(lead_days_nl),
            avg_be,
            avg_nl,
        )

        bins_legacy = ["0-7", "8-14", "15-30", "31-60", "61-90", "90+"]

        def bin_counts_legacy(values: list[int]) -> list[int]:
            counts = [0] * len(bins_legacy)
            for v in values:
                if v <= 7:
                    counts[0] += 1
                elif v <= 14:
                    counts[1] += 1
                elif v <= 30:
                    counts[2] += 1
                elif v <= 60:
                    counts[3] += 1
                elif v <= 90:
                    counts[4] += 1
                else:
                    counts[5] += 1
            return counts

        return jsonify(
            {
                "kpis": {
                    "bookings_in_period": bookings_in_period,
                    "pax_in_period": int(total_pax_period),
                    "pct_vs_last_year_pax": pct_vs_last_year_pax,
                },
                "granularity": granularity,
                "pax_tempo": {
                    "labels": pax_labels,
                    "values": pax_values,
                    "values_previous": pax_values_previous,
                },
                "booking_series_current": [
                    {
                        "booking_date": bd.isoformat(),
                        "departure_date": vd.isoformat(),
                        "pax": int(_safe_int(row.get("aantal_reizigers"), 0)),
                    }
                    for row in current_rows
                    for bd in [_safe_parse_date(str(row.get("boekingsdatum") or ""))]
                    for vd in [_safe_parse_date(str(row.get("vertrekdatum") or ""))]
                    if bd and vd and vd.year == date_from.year
                ],
                "pax_cumulative": {
                    "labels": pax_labels,
                    "values": pax_cumulative_values,
                    "values_previous": pax_cumulative_values_previous,
                },
                "lead_time": {
                    "avg_be": avg_be,
                    "avg_nl": avg_nl,
                    "distribution": {
                        "labels": LEAD_TIME_DIST_LABELS,
                        "counts": dist_counts,
                        "percents": dist_percents,
                        "total_bookings_with_dates": dist_total,
                    },
                    "labels": bins_legacy,
                    "be": bin_counts_legacy(lead_days_be),
                    "nl": bin_counts_legacy(lead_days_nl),
                },
            }
        )
    except SupabaseServiceError as e:
        return _dependency_error_response(
            log_message="dagtrends_boekingentrends_data dependency failure",
            exc=e,
            user_message="Boekingentrends tijdelijk niet beschikbaar.",
        )
    except ValueError:
        return jsonify({"error": "Ongeldige queryparameters"}), 400
    except KeyError as e:
        logger.exception("dagtrends_boekingentrends_data KeyError (response-vorm); sleutel=%r", e.args[0] if e.args else None)
        return jsonify(
            {
                "error": "Onverwachte database-response (ontbrekend veld). Controleer Supabase-log en of "
                "sql/rpc/dagtrends_boekingentrends_rpc.sql is gedeployed en uitvoerrechten heeft."
            }
        ), 500
    except Exception as e:  # noqa: BLE001
        return _internal_error_response(
            log_message="dagtrends_boekingentrends_data unexpected failure",
            exc=e,
            user_message="Boekingentrends konden niet worden geladen.",
        )


@dashboard_bp.route("/bestemmingen", methods=["GET"])
def bestemmingen() -> str:
    """
    Bestemmingen & periodes — vertrek-gebaseerde analytics (waar en wanneer wordt gereisd).
    """
    return render_template("dashboard/bestemmingen.html")


@dashboard_bp.route("/bestemmingen/periodes-options", methods=["GET"])
def bestemmingen_periodes_options():
    """Filters: brands, bestemmingen, jaren obv vertrekdatum (RPC)."""
    supabase = SupabaseService()
    try:
        brands = supabase.get_overzicht_brands_rpc()
        bestemmingen = supabase.get_data_verzameling_bestemmingen()
        yrows = supabase.bestemmingen_periodes_vertrek_jaren_rpc(brand="__all__", bestemming_id=None)
        years: list[int] = []
        for r in yrows:
            y = r.get("jaar")
            if y is not None:
                years.append(int(y))
        years.sort(reverse=True)
        if _is_versie_b_session():
            current_year = _resolve_year_for_session(None)
            return jsonify(
                {
                    "brands": brands,
                    "bestemmingen": bestemmingen,
                    "years": [current_year],
                    "default_year": current_year,
                }
            )
        today_y = date.today().year
        default_year = years[0] if years else today_y
        return jsonify(
            {
                "brands": brands,
                "bestemmingen": bestemmingen,
                "years": years,
                "default_year": default_year,
            }
        )
    except SupabaseServiceError as e:
        return _dependency_error_response(
            log_message="bestemmingen_periodes_options dependency failure",
            exc=e,
            user_message="Bestemmingen-periodes opties tijdelijk niet beschikbaar.",
        )


@dashboard_bp.route("/bestemmingen/periodes-data", methods=["GET"])
def bestemmingen_periodes_data():
    """Geaggregeerde payload voor alle visuals (vertrekdatum/terugkeer; geen boekingsdatum)."""
    year = _resolve_year_for_session(_safe_int(request.args.get("year"), 0), allow_previous_year=True)
    if year < 1990 or year > 2100:
        return jsonify({"error": "year ongeldig"}), 400
    brand = (request.args.get("brand") or "__all__").strip()
    destination_raw = (request.args.get("destination") or "").strip()
    destination_values = [v.strip() for v in destination_raw.split(",") if v and v.strip() and v.strip() != "__all__"]
    destination_id = destination_values[0] if len(destination_values) == 1 else None
    country = (request.args.get("country") or "__ALL__").strip()
    brand_land = (request.args.get("brand_land") or "__ALL__").strip()
    _cp = (request.args.get("compare_prev") or "").strip().lower()
    compare_prev = _cp in ("1", "true", "yes", "on")
    if _is_versie_b_session():
        compare_prev = True
    show_holidays = request.args.get("show_holidays") in ("1", "true", "yes")

    supabase = SupabaseService()
    try:
        rows_cur = supabase.bestemmingen_periodes_bookings_year_rpc(
            year=year,
            brand=brand,
            bestemming_id=destination_id,
            country=country,
            brand_land=brand_land,
        )
        destination_name_allowed: set[str] = set()
        if destination_values:
            # RPC-resultaat bevat enkel bestemming_naam (geen bestemming_id), dus map gekozen ids -> namen.
            try:
                all_dests = supabase.get_data_verzameling_bestemmingen() or []
                id_to_name = {
                    str(d.get("id") or "").strip(): str(d.get("naam") or "").strip().lower()
                    for d in all_dests
                    if str(d.get("id") or "").strip()
                }
                destination_name_allowed = {id_to_name.get(v, "") for v in destination_values}
                destination_name_allowed.discard("")
            except SupabaseServiceError:
                destination_name_allowed = set()
        if destination_name_allowed:
            rows_cur = [
                r
                for r in rows_cur
                if str(r.get("bestemming_naam") or "").strip().lower() in destination_name_allowed
            ]
        rows_prev: list[dict] = []
        transport_cur = supabase.bestemmingen_periodes_transport_split_year_rpc(
            year=year,
            brand=brand,
            bestemming_id=destination_id,
            country=country,
            brand_land=brand_land,
        )
        transport_prev: list[dict] = []
        if compare_prev:
            rows_prev = supabase.bestemmingen_periodes_bookings_year_rpc(
                year=year - 1,
                brand=brand,
                bestemming_id=destination_id,
                country=country,
                brand_land=brand_land,
            )
            if destination_name_allowed:
                rows_prev = [
                    r
                    for r in rows_prev
                    if str(r.get("bestemming_naam") or "").strip().lower() in destination_name_allowed
                ]
            transport_prev = supabase.bestemmingen_periodes_transport_split_year_rpc(
                year=year - 1,
                brand=brand,
                bestemming_id=destination_id,
                country=country,
                brand_land=brand_land,
            )
        brand_norm = "" if brand.lower() in {"__all__", "all"} else brand
        payload = aggregate_payload(
            rows_cur=rows_cur or [],
            rows_prev=rows_prev or [],
            year=year,
            compare_prev=compare_prev,
            show_holidays=show_holidays,
            filter_brand_norm=brand_norm,
        )
        # Transportgrafiek rechtstreeks op reizigers.transport (persistente kolom), niet op booking-inferentie.
        ordered = ("plane", "bus", "self")
        cur_map = {str(r.get("transport") or ""): int(r.get("pax") or 0) for r in (transport_cur or [])}
        prev_map = {str(r.get("transport") or ""): int(r.get("pax") or 0) for r in (transport_prev or [])}
        payload.setdefault("charts", {})
        payload["charts"]["transport_split"] = {
            "labels": list(ordered),
            "current": [int(cur_map.get(k, 0)) for k in ordered],
            "previous": [int(prev_map.get(k, 0)) for k in ordered] if compare_prev else None,
        }
        payload["meta"] = {
            "year": year,
            "brand": brand,
            "destination": destination_raw or "__all__",
            "country": country,
            "brand_land": brand_land,
            "compare_prev": compare_prev,
            "show_holidays": show_holidays,
        }
        return jsonify(payload)
    except SupabaseServiceError as e:
        return _dependency_error_response(
            log_message="bestemmingen_periodes_data dependency failure",
            exc=e,
            user_message="Bestemmingen-periodes data tijdelijk niet beschikbaar.",
        )
    except Exception as e:  # noqa: BLE001
        return _internal_error_response(
            log_message="bestemmingen_periodes_data unexpected failure",
            exc=e,
            user_message="Bestemmingen-periodes data kon niet worden geladen.",
        )


@dashboard_bp.route("/bestemmingen/periodes-traveler-origin", methods=["GET"])
def bestemmingen_periodes_traveler_origin():
    """Reizigersafkomst per brand_land (BE/NL): alleen jaar + bestemming + vertrekperiode + merk uit dit blok."""
    year = _resolve_year_for_session(_safe_int(request.args.get("year"), 0), allow_previous_year=True)
    if year < 1990 or year > 2100:
        return jsonify({"error": "year ongeldig"}), 400
    destination_raw = (request.args.get("destination") or "").strip()
    destination_id = None if destination_raw in ("", "__all__") else destination_raw
    donut_brand = (request.args.get("donut_brand") or "Sun Escapes").strip()
    eff = effective_donut_brand(donut_brand)

    d0 = _safe_parse_date(request.args.get("date_from"))
    d1 = _safe_parse_date(request.args.get("date_to"))
    if d0 is None:
        d0 = date(year, 1, 1)
    if d1 is None:
        d1 = date(year, 12, 31)
    if d0 > d1:
        d0, d1 = d1, d0

    supabase = SupabaseService()
    try:
        rows = supabase.bestemmingen_periodes_traveler_origin_donut_rpc(
            date_from=d0.isoformat(),
            date_to=d1.isoformat(),
            bestemming_id=destination_id,
            effective_brand=eff,
        )
        payload = traveler_origin_donut_payload(rows or [], effective_brand=eff)
        payload["meta"] = {
            "year": year,
            "donut_brand": donut_brand,
            "effective_brand": eff,
            "destination": destination_raw or "__all__",
            "date_from": d0.isoformat(),
            "date_to": d1.isoformat(),
        }
        return jsonify(payload)
    except SupabaseServiceError as e:
        return _dependency_error_response(
            log_message="bestemmingen_periodes_traveler_origin dependency failure",
            exc=e,
            user_message="Bestemmingen herkomstdata tijdelijk niet beschikbaar.",
        )
    except Exception as e:  # noqa: BLE001
        return _internal_error_response(
            log_message="bestemmingen_periodes_traveler_origin unexpected failure",
            exc=e,
            user_message="Bestemmingen herkomstdata kon niet worden geladen.",
        )


@dashboard_bp.route("/bestemmingen/periodes-transport-debug", methods=["GET"])
def bestemmingen_periodes_transport_debug():
    """Debug payload: raw transportwaarden + geclassificeerde pax-verdeling."""
    year = _resolve_year_for_session(_safe_int(request.args.get("year"), 0), allow_previous_year=True)
    if year < 1990 or year > 2100:
        return jsonify({"error": "year ongeldig"}), 400
    brand = (request.args.get("brand") or "__all__").strip()
    destination_raw = (request.args.get("destination") or "").strip()
    destination_id = None if destination_raw in ("", "__all__") else destination_raw
    brand_land = (request.args.get("brand_land") or "__ALL__").strip()
    supabase = SupabaseService()
    try:
        payload = supabase.bestemmingen_periodes_transport_debug_rpc(
            year=year,
            brand=brand,
            bestemming_id=destination_id,
            brand_land=brand_land,
        )
        return jsonify(payload)
    except SupabaseServiceError as e:
        return _dependency_error_response(
            log_message="bestemmingen_periodes_transport_debug dependency failure",
            exc=e,
            user_message="Bestemmingen transport-debug tijdelijk niet beschikbaar.",
        )
    except Exception as e:  # noqa: BLE001
        return _internal_error_response(
            log_message="bestemmingen_periodes_transport_debug unexpected failure",
            exc=e,
            user_message="Bestemmingen transport-debug kon niet worden geladen.",
        )


@dashboard_bp.route("/bestemmingen/options", methods=["GET"])
def bestemmingen_options():
    cached = _get_cached_options("bestemmingen_options")
    if cached is not None:
        return jsonify(cached)
    supabase = SupabaseService()
    try:
        brands = supabase.get_overzicht_brands_rpc()
        bestemmingen = supabase.get_data_verzameling_bestemmingen()
        years = supabase.get_overzicht_years_rpc("__all__")
        payload = {
            "brands": brands,
            "bestemmingen": bestemmingen,
            "years": years,
            "regions": [],
            "audiences": [],
            "hotel_categories": [],
            "seasons": ["Winter", "Lente", "Zomer", "Herfst"],
        }
        if _is_versie_b_session():
            payload["years"] = [_resolve_year_for_session(None)]
        _set_cached_options("bestemmingen_options", payload)
        return jsonify(payload)
    except SupabaseServiceError as e:
        return _dependency_error_response(
            log_message="bestemmingen_options dependency failure",
            exc=e,
            user_message="Bestemmingen-opties tijdelijk niet beschikbaar.",
        )


def _bestemmingen_dashboard_python_fallback(
    supabase: SupabaseService,
    *,
    brand: str,
    destination_id: str | None,
    date_from: date | None,
    date_to: date | None,
    year_filter: int,
    search: str | None,
    sort_key: str,
    sort_dir: str,
    page: int,
    page_size: int,
    region: str | None,
    audience: str | None,
    category: str | None,
    season: str | None,
) -> dict:
    t_rpc0 = time.perf_counter()
    rpc_full = supabase.get_bestemmingen_data_rpc(
        brand=brand,
        destination_id=destination_id,
        date_from=date_from.isoformat() if date_from else None,
        date_to=date_to.isoformat() if date_to else None,
        year=year_filter,
    )
    rpc_ms = (time.perf_counter() - t_rpc0) * 1000
    dests = list(rpc_full.get("destinations") or [])
    dests = apply_secondary_filters(
        dests,
        region=region,
        audience=audience,
        category=category,
        season=season,
    )
    t_ag0 = time.perf_counter()
    out = build_dashboard_from_destinations(
        dests,
        search=search,
        sort_key=sort_key,
        sort_dir=sort_dir,
        page=page,
        page_size=page_size,
    )
    ag_ms = (time.perf_counter() - t_ag0) * 1000
    logger.info(
        "bestemmingen_dashboard_fallback_timing rpc_ms=%.1f aggregate_ms=%.1f destinations_filtered=%s",
        rpc_ms,
        ag_ms,
        len(dests),
    )
    return out


@dashboard_bp.route("/bestemmingen/dashboard", methods=["GET"])
def bestemmingen_dashboard():
    """
    Geaggregeerde metrics + gepagineerde tabel (kleine payload).
    Gebruikt bestemmingen_dashboard_rpc (incl. regio/doelgroep/categorie/seizoen in SQL).
    Python-fallback alleen bij RPC-fout (bijv. functie niet gedeployed).
    """
    t0 = time.perf_counter()
    path_used = "rpc"
    rpc_only_ms: float | None = None
    brand = request.args.get("brand", "__all__")
    destination_id = request.args.get("destination") or None
    if destination_id == "__all__":
        destination_id = None
    date_from = _safe_parse_date(request.args.get("date_from"))
    date_to = _safe_parse_date(request.args.get("date_to"))
    year_filter = _resolve_year_for_session(_safe_int(request.args.get("year"), 0))
    search = (request.args.get("search") or "").strip() or None
    sort_key = (request.args.get("sort") or "bookings").strip()
    sort_dir = (request.args.get("sort_dir") or "desc").strip()
    page = max(1, _safe_int(request.args.get("page"), 1))
    page_size = min(100, max(1, _safe_int(request.args.get("page_size"), 25)))
    region = request.args.get("region") or None
    audience = request.args.get("audience") or None
    category = request.args.get("category") or None
    season = request.args.get("season") or None

    if region in ("", "__all__"):
        region = None
    if audience in ("", "__all__"):
        audience = None
    if category in ("", "__all__"):
        category = None
    if season in ("", "__all__"):
        season = None

    nocache = request.args.get("nocache") in ("1", "true", "yes")
    dash_key = _bestemmingen_dashboard_cache_key()

    if not nocache:
        cached = _get_cached_dashboard(dash_key)
        if cached is not None:
            elapsed_ms = (time.perf_counter() - t0) * 1000
            try:
                nbytes = len(json.dumps(cached, default=str))
            except (TypeError, ValueError):
                nbytes = 0
            resp = make_response(jsonify(cached))
            resp.headers["X-Bestemmingen-Path"] = "cache_hit"
            resp.headers["X-Bestemmingen-Cache"] = "HIT"
            resp.headers["X-Response-Time-Ms"] = f"{elapsed_ms:.1f}"
            resp.headers["X-Payload-Bytes"] = str(nbytes)
            logger.info(
                "bestemmingen_dashboard cache_hit ms=%.1f payload_bytes=%s",
                elapsed_ms,
                nbytes,
            )
            return resp

    supabase = SupabaseService()
    try:
        try:
            t_rpc = time.perf_counter()
            raw = supabase.get_bestemmingen_dashboard_rpc(
                brand=brand,
                destination_id=destination_id,
                date_from=date_from.isoformat() if date_from else None,
                date_to=date_to.isoformat() if date_to else None,
                year=year_filter,
                search=search,
                sort=sort_key,
                sort_dir=sort_dir,
                page=page,
                page_size=page_size,
                region=region,
                audience=audience,
                category=category,
                season=season,
            )
            rpc_only_ms = (time.perf_counter() - t_rpc) * 1000
            if isinstance(raw, dict) and raw.get("error"):
                raise SupabaseServiceError(str(raw.get("error")))
            payload = raw
        except SupabaseServiceError:
            path_used = "fallback_python_rpc_error"
            logger.warning(
                "bestemmingen_dashboard RPC failed; using Python fallback (deploy bestemmingen_dashboard_rpc with secondary filters)"
            )
            payload = _bestemmingen_dashboard_python_fallback(
                supabase,
                brand=brand,
                destination_id=destination_id,
                date_from=date_from,
                date_to=date_to,
                year_filter=year_filter,
                search=search,
                sort_key=sort_key,
                sort_dir=sort_dir,
                page=page,
                page_size=page_size,
                region=region,
                audience=audience,
                category=category,
                season=season,
            )

        elapsed_ms = (time.perf_counter() - t0) * 1000
        try:
            nbytes = len(json.dumps(payload, default=str))
        except (TypeError, ValueError):
            nbytes = 0
        if not nocache:
            _set_cached_dashboard(dash_key, payload)
        logger.info(
            "bestemmingen_dashboard %s ms=%.1f payload_bytes=%s page=%s page_size=%s rpc_ms=%s",
            path_used,
            elapsed_ms,
            nbytes,
            page,
            page_size,
            f"{rpc_only_ms:.1f}" if rpc_only_ms is not None else "-",
        )
        resp = make_response(jsonify(payload))
        resp.headers["X-Bestemmingen-Path"] = path_used
        resp.headers["X-Bestemmingen-Cache"] = "MISS" if not nocache else "BYPASS"
        resp.headers["X-Response-Time-Ms"] = f"{elapsed_ms:.1f}"
        resp.headers["X-Payload-Bytes"] = str(nbytes)
        if rpc_only_ms is not None and path_used == "rpc":
            resp.headers["X-Supabase-Dashboard-RPC-Ms"] = f"{rpc_only_ms:.1f}"
        return resp
    except SupabaseServiceError as e:
        return _dependency_error_response(
            log_message="bestemmingen_dashboard dependency failure",
            exc=e,
            user_message="Bestemmingen-dashboard tijdelijk niet beschikbaar.",
        )
    except ValueError:
        return jsonify({"error": "Ongeldige queryparameters"}), 400


@dashboard_bp.route("/bestemmingen/data", methods=["GET"])
def bestemmingen_data():
    supabase = SupabaseService()
    t_start = time.perf_counter()
    try:
        brand = request.args.get("brand", "__all__")
        destination_id = request.args.get("destination") or None
        if destination_id == "__all__":
            destination_id = None
        date_from = _safe_parse_date(request.args.get("date_from"))
        date_to = _safe_parse_date(request.args.get("date_to"))
        date_kind = "boekingsdatum"
        year_filter = _resolve_year_for_session(_safe_int(request.args.get("year"), 0))
        scope = "detail" if destination_id else "list"
        cache_key = (
            f"bestemmingen_data|{brand}|{destination_id or '__all__'}|"
            f"{date_from.isoformat() if date_from else ''}|{date_to.isoformat() if date_to else ''}|{year_filter}"
        )
        cached = _get_cached_options(cache_key)
        if cached is not None:
            return _bestemmingen_data_http_response(
                cached,
                path="options_cache_hit",
                started=t_start,
                scope=scope,
                cache="HIT",
            )

        by_dest: dict[str, dict] = {}
        global_audiences: Counter[str] = Counter()
        global_hotels: Counter[str] = Counter()
        totals_rows: list[dict] = []
        try:
            rpc_payload = supabase.get_bestemmingen_data_rpc(
                brand=brand,
                destination_id=destination_id,
                date_from=date_from.isoformat() if date_from else None,
                date_to=date_to.isoformat() if date_to else None,
                year=year_filter,
            )
            logger.info(
                "bestemmingen_data rpc_path_used brand=%s destination_id=%s date_from=%s date_to=%s year=%s",
                brand,
                destination_id or "__all__",
                date_from.isoformat() if date_from else "",
                date_to.isoformat() if date_to else "",
                year_filter,
            )
            payload = {
                "destinations": rpc_payload.get("destinations") or [],
                "meta": rpc_payload.get("meta") or {"topAudience": "-", "topHotel": "-", "rowCount": 0},
            }
            _set_cached_options(cache_key, payload)
            return _bestemmingen_data_http_response(
                payload,
                path="rpc",
                started=t_start,
                scope=scope,
                cache="MISS",
            )
        except SupabaseServiceError as rpc_error:
            # Tijdelijke fallback: verwijderen zodra RPC-functie in alle omgevingen actief is.
            logger.warning(
                "bestemmingen_data fallback_path_used reason=%s brand=%s destination_id=%s date_from=%s date_to=%s year=%s",
                str(rpc_error),
                brand,
                destination_id or "__all__",
                date_from.isoformat() if date_from else "",
                date_to.isoformat() if date_to else "",
                year_filter,
            )
            rows = _fetch_all_data_verzameling_rows(
                supabase=supabase,
                brand=brand,
                bestemming_id=destination_id,
                year=year_filter,
                date_kind=date_kind,
                date_from=date_from,
                date_to=date_to,
            )
            excluded_statuses = {"cancelled", "canceled", "geannuleerd", "annulatie", "annulering", "draft", "test", "dropped"}
            for r in rows:
                status_raw = str(
                    r.get("booking_status")
                    or r.get("boeking_status")
                    or r.get("boeking_status_naam")
                    or ""
                ).strip().lower()
                if status_raw in excluded_statuses:
                    continue
                dest_name = str(r.get("bestemming") or "Onbekende bestemming")
                dest_id = str(r.get("bestemming_id") or f"dest::{dest_name.lower()}")
                audience = str(r.get("doelgroep") or "Onbekend")
                hotel = str(r.get("accommodatie") or "Onbekend hotel")
                booking_date = _safe_parse_date(str(r.get("boekingsdatum") or ""))
                vertrek_date = _safe_parse_date(str(r.get("vertrekdatum") or ""))

                if dest_id not in by_dest:
                    by_dest[dest_id] = {
                        "id": dest_id,
                        "naam": dest_name,
                        "regio": "Onbekend",
                        "bookedAudiencesCounter": Counter(),
                        "totalBookings": 0,
                        "pricedBookings": 0,
                        "totalRevenue": 0.0,
                        "topHotelsCounter": Counter(),
                        "trendCounter": defaultdict(int),
                        "fitBaseCounter": Counter(),
                        "seasonCounter": Counter(),
                    }
                d = by_dest[dest_id]
                d["totalBookings"] += 1
                total_to_pay = r.get("totaal_te_betalen")
                revenue_value = _safe_float(total_to_pay, 0.0)
                if total_to_pay is not None and revenue_value > 0:
                    d["pricedBookings"] += 1
                    d["totalRevenue"] += revenue_value
                d["bookedAudiencesCounter"][audience] += 1
                d["fitBaseCounter"][audience] += 1
                d["topHotelsCounter"][hotel] += 1
                if booking_date:
                    month_key = f"{booking_date.year}-{booking_date.month:02d}"
                    d["trendCounter"][month_key] += 1
                if vertrek_date:
                    if vertrek_date.month in (12, 1, 2):
                        d["seasonCounter"]["Winter"] += 1
                    elif vertrek_date.month in (3, 4, 5):
                        d["seasonCounter"]["Lente"] += 1
                    elif vertrek_date.month in (6, 7, 8):
                        d["seasonCounter"]["Zomer"] += 1
                    else:
                        d["seasonCounter"]["Herfst"] += 1
                global_audiences[audience] += 1
                global_hotels[hotel] += 1

        destinations_payload = []
        for dest in by_dest.values():
            booked_sorted = dest["bookedAudiencesCounter"].most_common()
            target = [x[0] for x in booked_sorted[:2]] if booked_sorted else ["Onbekend"]
            top_hotels = [
                {"hotel": name, "bookings": count, "category": "Onbekend"}
                for name, count in dest["topHotelsCounter"].most_common(5)
            ]
            trend = [{"month": k, "bookings": v} for k, v in sorted(dest["trendCounter"].items(), key=lambda x: x[0])]
            total_bookings = int(dest["totalBookings"])
            priced_bookings = int(dest.get("pricedBookings") or 0)
            fit_count = sum(count for audience, count in dest["fitBaseCounter"].items() if audience in set(target))
            fit_score = round((fit_count / total_bookings) * 100) if total_bookings > 0 else 0

            note = "Sterke doelgroep-fit." if fit_score >= 80 else "Mogelijke mismatch tussen target en boekgedrag."
            destinations_payload.append(
                {
                    "id": dest["id"],
                    "naam": dest["naam"],
                    "regio": dest["regio"],
                    "targetAudience": target,
                    "bookedAudiences": [{"label": label, "count": count} for label, count in booked_sorted],
                    "totalBookings": int(dest["totalBookings"]),
                    "totalPricedBookings": priced_bookings,
                    "totalRevenue": round(float(dest["totalRevenue"]), 2),
                    "averageBookingValue": round(float(dest["totalRevenue"]) / priced_bookings, 2) if priced_bookings > 0 else 0.0,
                    "topHotels": top_hotels,
                    "bookingTrendOverTime": trend,
                    "audienceFitScore": fit_score,
                    "notes": [note],
                    "vertrekmaanden": [name for name, _ in dest["seasonCounter"].most_common(2)],
                }
            )

        payload = {
            "destinations": destinations_payload,
            "meta": {
                "topAudience": global_audiences.most_common(1)[0][0] if global_audiences else "-",
                "topHotel": global_hotels.most_common(1)[0][0] if global_hotels else "-",
                "rowCount": sum(dest["totalBookings"] for dest in by_dest.values()),
            },
        }
        _set_cached_options(cache_key, payload)
        return _bestemmingen_data_http_response(
            payload,
            path="fallback_python",
            started=t_start,
            scope=scope,
            cache="MISS",
        )
    except SupabaseServiceError as e:
        return _dependency_error_response(
            log_message="bestemmingen_data dependency failure",
            exc=e,
            user_message="Bestemmingen-data tijdelijk niet beschikbaar.",
        )
    except ValueError:
        return jsonify({"error": "Ongeldige queryparameters"}), 400

