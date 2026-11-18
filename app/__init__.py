from __future__ import annotations

import json
import logging
import os
import secrets
from uuid import uuid4

from flask import Flask, Response, flash, jsonify, redirect, request, url_for
from werkzeug.exceptions import HTTPException, RequestEntityTooLarge
from werkzeug.middleware.proxy_fix import ProxyFix

from app.routes.dashboard import dashboard_bp
from config.settings import get_flask_secret_key, get_upload_max_file_size_bytes


def _env_flag(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def create_app() -> Flask:
    """
    Application factory for the Flask app.

    - Scheidt UI (templates) van business logic (services).
    - Maakt het eenvoudig om later extra blueprints/modules toe te voegen.
    """
    app = Flask(__name__)
    app.config["SECRET_KEY"] = get_flask_secret_key()
    app.config["SESSION_COOKIE_HTTPONLY"] = True
    app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
    app.config["SESSION_COOKIE_SECURE"] = _env_flag(
        "SESSION_COOKIE_SECURE",
        default=os.getenv("FLASK_ENV", "").strip().lower() == "production",
    )
    upload_max_size_bytes = get_upload_max_file_size_bytes()
    app.config["UPLOAD_MAX_SIZE_BYTES"] = upload_max_size_bytes
    app.config["MAX_CONTENT_LENGTH"] = int(os.getenv("MAX_CONTENT_LENGTH_BYTES", str(upload_max_size_bytes)))
    app.config["ENABLE_CSRF_PROTECTION"] = _env_flag("ENABLE_CSRF_PROTECTION", default=True)

    # Browser cache voor static (css/js); herhaalde pageloads worden sneller.
    app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 86400

    # Zorg dat INFO/debug logs ook zichtbaar zijn in de terminal.
    logging.basicConfig(level=logging.INFO)
    app.logger.setLevel(logging.INFO)

    app.register_blueprint(dashboard_bp)

    # Demomodus: publieke portfolio-demo met fictieve data. Alleen lezen;
    # elke wijziging (upload, accounts, bewerkingen) wordt geweigerd.
    app.config["DEMO_MODE"] = _env_flag("DEMO_MODE", default=False)
    app.config["DEMO_EMAIL"] = os.getenv("DEMO_EMAIL", "demo@example.com")
    app.config["DEMO_PASSWORD"] = os.getenv("DEMO_PASSWORD", "demo1234")

    @app.context_processor
    def _inject_demo() -> dict[str, object]:
        return {
            "demo_mode": app.config["DEMO_MODE"],
            "demo_email": app.config["DEMO_EMAIL"],
            "demo_password": app.config["DEMO_PASSWORD"],
        }

    _demo_allowed_post = {"dashboard.login", "dashboard.logout"}

    @app.before_request
    def _demo_read_only():
        if not app.config["DEMO_MODE"]:
            return None
        if request.method in {"GET", "HEAD", "OPTIONS"} or request.endpoint in _demo_allowed_post:
            return None
        msg = "Dit is een demo: wijzigingen zijn uitgeschakeld."
        wants_json = (
            request.is_json
            or request.accept_mimetypes.best == "application/json"
            or request.headers.get("X-Requested-With") == "XMLHttpRequest"
        )
        if wants_json:
            return jsonify({"error": msg}), 403
        flash(msg, "warning")
        return redirect(request.referrer or url_for("dashboard.index"))

    @app.after_request
    def _security_headers(response: Response) -> Response:
        """Minimale browser-hardening (geen CSP: veel inline script in dashboards)."""
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
        response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        return response

    def _get_or_create_csrf_token() -> str:
        from flask import session

        current = str(session.get("csrf_token") or "")
        if current:
            return current
        created = secrets.token_urlsafe(32)
        session["csrf_token"] = created
        return created

    @app.context_processor
    def _inject_csrf_token() -> dict[str, object]:
        return {"csrf_token": _get_or_create_csrf_token}

    @app.route("/favicon.ico")
    def _favicon() -> Response:
        """Browsers vragen standaard /favicon.ico; zonder route ontstaat 404 + lawaai in logs."""
        return redirect(url_for("static", filename="img/travel-analytics-logo.png"), code=302)

    @app.errorhandler(HTTPException)
    def _handle_http_exception(exc: HTTPException):
        """404/401 enz. — apart registreren zodat ze niet via de brede Exception-handler lopen."""
        return exc

    @app.errorhandler(Exception)
    def _financieel_api_force_json_on_500(exc: Exception) -> Response:
        """
        Zonder deze handler toont Flask bij DEBUG (of de standaard 500-pagina) HTML;
        fetch() in financieel.js verwacht JSON → 'Unexpected token' / '<!doctype'.
        Alleen voor /financieel/data en /financieel/options: altijd JSON teruggeven.
        """
        path = request.path or ""
        if "/financieel/" in path and (path.endswith("/data") or path.endswith("/options")):
            request_id = request.headers.get("X-Request-Id") or f"req-{uuid4()}"
            app.logger.exception("Financiën API — JSON error handler request_id=%s", request_id)
            try:
                body = json.dumps({"error": "Interne serverfout.", "request_id": request_id, "rows": []}, ensure_ascii=False)
            except Exception:
                body = '{"error":"Interne serverfout","rows":[]}'
            return Response(body, status=500, mimetype="application/json; charset=utf-8")
        raise exc

    @app.errorhandler(RequestEntityTooLarge)
    def _handle_request_too_large(_: RequestEntityTooLarge):
        request_id = request.headers.get("X-Request-Id") or f"req-{uuid4()}"
        app.logger.warning("Request te groot request_id=%s path=%s", request_id, request.path)
        if request.headers.get("X-Requested-With") == "XMLHttpRequest":
            body = json.dumps(
                {
                    "success": False,
                    "message": "Bestand is te groot.",
                    "errors": ["Bestand overschrijdt de uploadlimiet."],
                    "request_id": request_id,
                },
                ensure_ascii=False,
            )
            return Response(body, status=413, mimetype="application/json; charset=utf-8")
        return Response("Bestand is te groot.", status=413, mimetype="text/plain; charset=utf-8")

    if os.getenv("TRUST_PROXY", "").lower() in {"1", "true", "yes", "on"}:
        # Laat request.script_root / url_for kloppen achter een reverse proxy
        # (X-Forwarded-Proto, -Host, -Prefix, etc.).
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1, x_port=1)
        app.logger.info("ProxyFix enabled (TRUST_PROXY): forwarded headers worden vertrouwd.")

    return app

