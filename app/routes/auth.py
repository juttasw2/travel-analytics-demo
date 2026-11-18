from __future__ import annotations

from typing import Callable
from uuid import uuid4

from flask import (
    Response,
    abort,
    current_app,
    flash,
    make_response,
    redirect,
    render_template,
    request,
    session,
    url_for,
)

from services.auth_service import AuthService, AuthServiceError
from services.mfa_service import MfaService
from services.rbac import AppRole, normalize_app_role
from config.settings import get_mfa_issuer_name


def register_auth_routes(
    bp,
    *,
    session_user_has_access_effective: Callable[[], bool],
    safe_relative_redirect_path: Callable[[str | None], str | None],
    get_request_csrf_token: Callable[[], str],
    is_valid_csrf_token: Callable[[str], bool],
    get_client_ip: Callable[[], str],
    is_rate_limited: Callable[[list[str]], tuple[bool, int]],
    register_login_failure: Callable[[list[str]], None],
    clear_login_failures: Callable[[list[str]], None],
    logger,
) -> None:
    def _complete_login(
        *,
        user_id: str,
        email: str,
        has_access: bool,
        role: AppRole,
        safe_next: str | None,
    ) -> Response:
        session.clear()
        session["user_id"] = user_id
        session["user_email"] = email
        session["user_has_access"] = has_access
        session["user_role"] = normalize_app_role(role).value
        session["csrf_token"] = str(uuid4())
        if has_access:
            flash("Succesvol ingelogd.", "success")
        else:
            flash(
                "Je bent ingelogd. Je account heeft nog geen toestemming om het dashboard te gebruiken.",
                "info",
            )

        if not has_access:
            return redirect(url_for("dashboard.pending_access"))
        if safe_next:
            return redirect(safe_next)
        return redirect(url_for("dashboard.overzicht" if current_app.config.get("DEMO_MODE") else "dashboard.upload"))

    @bp.route("/login", methods=["GET", "POST"])
    def login() -> str | Response:
        if request.method == "GET":
            if session.get("user_id"):
                if session_user_has_access_effective():
                    sn = safe_relative_redirect_path(request.args.get("next"))
                    if sn:
                        return redirect(sn)
                    return redirect(url_for("dashboard.overzicht" if current_app.config.get("DEMO_MODE") else "dashboard.upload"))
                return redirect(url_for("dashboard.pending_access"))
            next_path = (request.args.get("next") or "").strip()
            return render_template("auth/login.html", next_path=next_path)

        email = (request.form.get("email") or "").strip()
        password = request.form.get("password") or ""
        next_raw = (request.form.get("next") or "").strip()
        safe_next = safe_relative_redirect_path(next_raw)
        csrf_token = get_request_csrf_token()
        if not is_valid_csrf_token(csrf_token):
            return render_template(
                "auth/login.html",
                error="Sessiebeveiliging mislukt. Vernieuw de pagina en probeer opnieuw.",
                email=email,
                next_path=next_raw,
            ), 400

        if not email or not password:
            msg = "E-mail en wachtwoord zijn verplicht."
            return render_template("auth/login.html", error=msg, email=email, next_path=next_raw), 400

        auth_service = AuthService()
        normalized_email = auth_service.normalize_email(email)
        throttle_keys = [f"ip:{get_client_ip()}", f"account:{normalized_email}"]
        limited, retry_after = is_rate_limited(throttle_keys)
        if limited:
            response = render_template(
                "auth/login.html",
                error="Te veel mislukte inlogpogingen. Probeer het later opnieuw.",
                email=normalized_email,
                next_path=next_raw,
            )
            resp = make_response(response, 429)
            if retry_after > 0:
                resp.headers["Retry-After"] = str(retry_after)
            return resp

        try:
            user = auth_service.authenticate(email=normalized_email, password=password)
        except AuthServiceError:
            register_login_failure(throttle_keys)
            logger.exception("Login: Supabase RPC authenticate_app_user mislukt")
            return render_template(
                "auth/login.html",
                error="Er ging iets mis tijdens het aanmelden. Probeer opnieuw.",
                email=normalized_email,
                next_path=next_raw,
            ), 500

        if not user:
            register_login_failure(throttle_keys)
            return render_template(
                "auth/login.html",
                error="Ongeldige inloggegevens.",
                email=normalized_email,
                next_path=next_raw,
            ), 401

        clear_login_failures(throttle_keys)
        if current_app.config.get("DEMO_MODE"):
            # Publieke demo: geen MFA, meteen naar het dashboard.
            return _complete_login(
                user_id=user.id,
                email=user.email,
                has_access=user.has_access,
                role=user.role,
                safe_next=safe_next,
            )
        if user.mfa_enabled:
            if not user.mfa_secret:
                logger.warning(
                    "Login: mfa_enabled zonder mfa_secret voor user_id=%s, start MFA setup opnieuw",
                    user.id,
                )
                session.clear()
                session["pending_mfa_user_id"] = user.id
                session["pending_mfa_email"] = user.email
                session["pending_mfa_has_access"] = user.has_access
                session["pending_mfa_role"] = user.role.value
                session["pending_mfa_next"] = safe_next or ""
                session["pending_mfa_mode"] = "setup"
                session["pending_mfa_secret"] = MfaService.generate_secret()
                session["csrf_token"] = str(uuid4())
                return redirect(url_for("dashboard.mfa"))
            session.clear()
            session["pending_mfa_user_id"] = user.id
            session["pending_mfa_email"] = user.email
            session["pending_mfa_has_access"] = user.has_access
            session["pending_mfa_role"] = user.role.value
            session["pending_mfa_secret"] = user.mfa_secret
            session["pending_mfa_next"] = safe_next or ""
            session["pending_mfa_mode"] = "verify"
            session["csrf_token"] = str(uuid4())
            return redirect(url_for("dashboard.mfa"))

        if not user.has_access:
            return _complete_login(
                user_id=user.id,
                email=user.email,
                has_access=False,
                role=user.role,
                safe_next=safe_next,
            )

        session.clear()
        session["pending_mfa_user_id"] = user.id
        session["pending_mfa_email"] = user.email
        session["pending_mfa_has_access"] = user.has_access
        session["pending_mfa_role"] = user.role.value
        session["pending_mfa_next"] = safe_next or ""
        session["pending_mfa_mode"] = "setup"
        session["pending_mfa_secret"] = MfaService.generate_secret()
        session["csrf_token"] = str(uuid4())
        return redirect(url_for("dashboard.mfa"))

    @bp.route("/mfa", methods=["GET", "POST"])
    def mfa() -> str | Response:
        pending_user_id = str(session.get("pending_mfa_user_id") or "").strip()
        pending_email = str(session.get("pending_mfa_email") or "").strip()
        pending_mode = str(session.get("pending_mfa_mode") or "").strip()
        pending_role = normalize_app_role(session.get("pending_mfa_role"))
        pending_next_raw = str(session.get("pending_mfa_next") or "").strip()
        pending_has_access = bool(session.get("pending_mfa_has_access"))
        safe_next = safe_relative_redirect_path(pending_next_raw)
        if not pending_user_id or not pending_email or pending_mode not in {"verify", "setup"}:
            flash("Je sessie is verlopen. Log opnieuw in.", "warning")
            return redirect(url_for("dashboard.login"))

        auth_service = AuthService()
        mfa_service = MfaService()
        error: str | None = None
        issuer_name = get_mfa_issuer_name()
        qr_data_uri = ""
        manual_code = ""

        if pending_mode == "setup":
            manual_code = str(session.get("pending_mfa_secret") or "").strip()
            if not manual_code:
                manual_code = mfa_service.generate_secret()
                session["pending_mfa_secret"] = manual_code
            provisioning_uri = mfa_service.provisioning_uri(
                email=pending_email,
                secret=manual_code,
                issuer_name=issuer_name,
            )
            qr_data_uri = mfa_service.build_qr_data_uri(provisioning_uri)

        if request.method == "POST":
            csrf_token = get_request_csrf_token()
            if not is_valid_csrf_token(csrf_token):
                error = "Sessiebeveiliging mislukt. Vernieuw de pagina en probeer opnieuw."
            else:
                code = request.form.get("mfa_code") or ""
                if pending_mode == "verify":
                    secret = str(session.get("pending_mfa_secret") or "").strip()
                    if not secret:
                        error = "Sessie verlopen. Log opnieuw in."
                    elif not mfa_service.verify_token(secret=secret, token=code):
                        error = "Ongeldige verificatiecode."
                    else:
                        return _complete_login(
                            user_id=pending_user_id,
                            email=pending_email,
                            has_access=pending_has_access,
                            role=pending_role,
                            safe_next=safe_next,
                        )
                else:
                    secret = str(session.get("pending_mfa_secret") or "").strip()
                    if not secret:
                        error = "Sessie verlopen. Log opnieuw in."
                    elif not mfa_service.verify_token(secret=secret, token=code):
                        error = "De code klopt niet. Controleer tijd op je telefoon en probeer opnieuw."
                    else:
                        try:
                            updated = auth_service.enable_mfa(user_id=pending_user_id, mfa_secret=secret)
                        except AuthServiceError:
                            logger.exception("MFA setup: opslaan van mfa_secret mislukt user_id=%s", pending_user_id)
                            updated = False
                        if not updated:
                            error = "Kon tweestapsverificatie niet opslaan. Probeer opnieuw."
                        else:
                            flash("Tweestapsverificatie is ingeschakeld.", "success")
                            return _complete_login(
                                user_id=pending_user_id,
                                email=pending_email,
                                has_access=pending_has_access,
                                role=pending_role,
                                safe_next=safe_next,
                            )

        return render_template(
            "auth/mfa.html",
            mode=pending_mode,
            error=error,
            email=pending_email,
            qr_data_uri=qr_data_uri,
            manual_code=manual_code,
            issuer_name=issuer_name,
        )

    def _require_logged_in() -> Response | None:
        if not session.get("user_id"):
            return redirect(url_for("dashboard.login", next=request.path))
        if not session_user_has_access_effective():
            return redirect(url_for("dashboard.pending_access"))
        return None

    def _current_role() -> AppRole:
        return normalize_app_role(session.get("user_role"))

    @bp.route("/account", methods=["GET"])
    def account_manage() -> str | Response:
        guard = _require_logged_in()
        if guard is not None:
            return guard
        return render_template(
            "account/manage.html",
            can_create_users=(_current_role() == AppRole.VERSIE_A),
        )

    @bp.route("/account/wachtwoord-wijzigen", methods=["GET", "POST"])
    def change_password() -> str | Response:
        guard = _require_logged_in()
        if guard is not None:
            return guard

        if request.method == "GET":
            return render_template("account/change_password.html")

        csrf_token = get_request_csrf_token()
        if not is_valid_csrf_token(csrf_token):
            return (
                render_template(
                    "account/change_password.html",
                    error="Sessiebeveiliging mislukt. Vernieuw de pagina en probeer opnieuw.",
                ),
                400,
            )

        current_password = request.form.get("current_password") or ""
        new_password = request.form.get("new_password") or ""
        new_password_confirm = request.form.get("new_password_confirm") or ""

        pwd_keys = [f"pwd_change:{get_client_ip()}", f"pwd_change_user:{session.get('user_id')}"]
        limited, retry_after = is_rate_limited(pwd_keys)
        if limited:
            response = render_template(
                "account/change_password.html",
                error="Te veel pogingen. Probeer het later opnieuw.",
            )
            resp = make_response(response, 429)
            if retry_after > 0:
                resp.headers["Retry-After"] = str(retry_after)
            return resp

        auth_service = AuthService()
        try:
            ok, err_msg = auth_service.change_password(
                user_id=str(session.get("user_id") or ""),
                current_password=current_password,
                new_password=new_password,
                new_password_confirm=new_password_confirm,
            )
        except AuthServiceError:
            register_login_failure(pwd_keys)
            logger.exception("Wachtwoord wijzigen: Supabase RPC change_app_user_password mislukt")
            return (
                render_template(
                    "account/change_password.html",
                    error="Wachtwoord wijzigen is tijdelijk niet mogelijk. Probeer het later opnieuw.",
                ),
                500,
            )

        if not ok:
            register_login_failure(pwd_keys)
            return (
                render_template(
                    "account/change_password.html",
                    error=err_msg or "Wachtwoord wijzigen mislukt.",
                ),
                400,
            )

        clear_login_failures(pwd_keys)
        flash("Je wachtwoord is gewijzigd.", "success")
        return redirect(url_for("dashboard.account_manage"))

    @bp.route("/account/nieuw-account", methods=["GET", "POST"])
    def admin_create_user() -> str | Response:
        guard = _require_logged_in()
        if guard is not None:
            return guard

        # Server-side autorisatie: alleen VERSIE_A mag nieuwe gebruikers aanmaken.
        # Frontend-checks zijn slechts UX; deze guard is bindend en kan niet
        # via DevTools/directe POST omzeild worden.
        if _current_role() != AppRole.VERSIE_A:
            logger.warning(
                "admin_create_user: ongeautoriseerde poging door user_id=%s role=%s",
                session.get("user_id"),
                _current_role().value,
            )
            abort(403)

        if request.method == "GET":
            return render_template("account/create_user.html")

        csrf_token = get_request_csrf_token()
        if not is_valid_csrf_token(csrf_token):
            return (
                render_template(
                    "account/create_user.html",
                    error="Sessiebeveiliging mislukt. Vernieuw de pagina en probeer opnieuw.",
                    display_name=(request.form.get("display_name") or "").strip(),
                    email=(request.form.get("email") or "").strip(),
                    role=(request.form.get("role") or "").strip().upper(),
                ),
                400,
            )

        display_name = (request.form.get("display_name") or "").strip()
        email = (request.form.get("email") or "").strip()
        password = request.form.get("password") or ""
        role = (request.form.get("role") or "").strip().upper()

        create_keys = [
            f"admin_create:{get_client_ip()}",
            f"admin_create_user:{session.get('user_id')}",
        ]
        limited, retry_after = is_rate_limited(create_keys)
        if limited:
            response = render_template(
                "account/create_user.html",
                error="Te veel pogingen. Probeer het later opnieuw.",
                display_name=display_name,
                email=email,
                role=role,
            )
            resp = make_response(response, 429)
            if retry_after > 0:
                resp.headers["Retry-After"] = str(retry_after)
            return resp

        auth_service = AuthService()
        try:
            ok, err_msg = auth_service.admin_create_user(
                display_name=display_name,
                email=email,
                password=password,
                role=role,
            )
        except AuthServiceError:
            register_login_failure(create_keys)
            logger.exception("Account aanmaken: Supabase RPC admin_create_app_user mislukt")
            return (
                render_template(
                    "account/create_user.html",
                    error="Account aanmaken is tijdelijk niet mogelijk. Probeer het later opnieuw.",
                    display_name=display_name,
                    email=email,
                    role=role,
                ),
                500,
            )

        if not ok:
            register_login_failure(create_keys)
            return (
                render_template(
                    "account/create_user.html",
                    error=err_msg or "Account aanmaken mislukt.",
                    display_name=display_name,
                    email=email,
                    role=role,
                ),
                400,
            )

        clear_login_failures(create_keys)
        flash(
            f"Account voor {email} is aangemaakt. De gebruiker stelt MFA in bij eerste login.",
            "success",
        )
        return redirect(url_for("dashboard.account_manage"))

    @bp.route("/geen-toestemming", methods=["GET"])
    def pending_access() -> str | Response:
        if not session.get("user_id"):
            return redirect(url_for("dashboard.login", next=request.path))
        if session_user_has_access_effective():
            return redirect(url_for("dashboard.overzicht" if current_app.config.get("DEMO_MODE") else "dashboard.upload"))
        return render_template("auth/no_access.html")

    @bp.route("/logout", methods=["POST"])
    def logout() -> Response:
        csrf_token = get_request_csrf_token()
        if not is_valid_csrf_token(csrf_token):
            flash("Sessiebeveiliging mislukt. Probeer opnieuw.", "warning")
            return redirect(url_for("dashboard.login"))
        session.clear()
        return redirect(url_for("dashboard.login"))
