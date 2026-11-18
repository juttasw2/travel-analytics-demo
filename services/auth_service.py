from __future__ import annotations

import re
from dataclasses import dataclass

from services.supabase_service import SupabaseService, SupabaseServiceError
from services.rbac import AppRole, normalize_app_role


_ALLOWED_NEW_USER_ROLES = frozenset({AppRole.VERSIE_A.value, AppRole.VERSIE_B.value})


class AuthServiceError(RuntimeError):
    pass


@dataclass(frozen=True)
class AuthenticatedUser:
    id: str
    email: str
    has_access: bool
    role: AppRole = AppRole.VERSIE_B
    display_name: str | None = None
    mfa_enabled: bool = False
    mfa_secret: str | None = None


_DISPLAY_NAME_MIN = 1
_DISPLAY_NAME_MAX = 200
_PASSWORD_MIN_LEN = 8
_PASSWORD_MAX_LEN = 512

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@]+$")


def _to_bool(value: object, *, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "t", "yes", "y", "on"}:
            return True
        if normalized in {"0", "false", "f", "no", "n", "off", ""}:
            return False
    return bool(value)


def validate_display_name(raw: str) -> tuple[bool, str]:
    name = (raw or "").strip()
    if len(name) < _DISPLAY_NAME_MIN:
        return False, "Naam of gebruikersnaam is verplicht."
    if len(name) > _DISPLAY_NAME_MAX:
        return False, f"Naam mag maximaal {_DISPLAY_NAME_MAX} tekens zijn."
    return True, ""


def validate_password_pair(password: str, password_confirm: str) -> tuple[bool, str]:
    p = password or ""
    if len(p) < _PASSWORD_MIN_LEN:
        return False, f"Wachtwoord moet minstens {_PASSWORD_MIN_LEN} tekens lang zijn."
    if len(p) > _PASSWORD_MAX_LEN:
        return False, "Wachtwoord is te lang."
    if p != (password_confirm or ""):
        return False, "Wachtwoorden komen niet overeen."
    return True, ""


def validate_email_format(email: str) -> tuple[bool, str]:
    cleaned = (email or "").strip().lower()
    if not cleaned:
        return False, "E-mailadres is verplicht."
    if not _EMAIL_RE.match(cleaned):
        return False, "Voer een geldig e-mailadres in."
    return True, ""


def validate_new_password(password: str) -> tuple[bool, str]:
    p = password or ""
    if len(p) < _PASSWORD_MIN_LEN:
        return False, f"Wachtwoord moet minstens {_PASSWORD_MIN_LEN} tekens lang zijn."
    if len(p) > _PASSWORD_MAX_LEN:
        return False, "Wachtwoord is te lang."
    return True, ""


def validate_role_choice(role: str) -> tuple[bool, str]:
    cleaned = (role or "").strip().upper()
    if cleaned not in _ALLOWED_NEW_USER_ROLES:
        return False, "Kies een geldige rol (VERSIE_A of VERSIE_B)."
    return True, ""


class AuthService:
    def __init__(self, supabase: SupabaseService | None = None) -> None:
        self.supabase = supabase or SupabaseService()

    @staticmethod
    def normalize_email(email: str) -> str:
        return (email or "").strip().lower()

    def authenticate(self, *, email: str, password: str) -> AuthenticatedUser | None:
        normalized_email = self.normalize_email(email)
        if not normalized_email or not password:
            return None

        try:
            rows = self.supabase.call_rpc(
                "authenticate_app_user",
                {
                    "p_email": normalized_email,
                    "p_password": password,
                },
            )
        except SupabaseServiceError as exc:
            raise AuthServiceError(str(exc))

        if not rows:
            return None

        row = rows[0]
        user_id = row.get("id")
        user_email = row.get("email")
        if not user_id or not user_email:
            return None

        raw_access = row.get("has_access")
        has_access = _to_bool(raw_access, default=True)
        role = normalize_app_role(row.get("role"))
        display_name = row.get("display_name")
        dn = None if display_name in (None, "") else str(display_name)
        raw_mfa_enabled = row.get("mfa_enabled")
        mfa_enabled = _to_bool(raw_mfa_enabled, default=False)
        mfa_secret = row.get("mfa_secret")
        ms = None if mfa_secret in (None, "") else str(mfa_secret)

        return AuthenticatedUser(
            id=str(user_id),
            email=str(user_email),
            has_access=has_access,
            role=role,
            display_name=dn,
            mfa_enabled=mfa_enabled,
            mfa_secret=ms,
        )

    def enable_mfa(self, *, user_id: str, mfa_secret: str) -> bool:
        cleaned_uid = (user_id or "").strip()
        cleaned_secret = (mfa_secret or "").strip()
        if not cleaned_uid or not cleaned_secret:
            return False
        try:
            rows = self.supabase.call_rpc(
                "set_app_user_mfa",
                {
                    "p_user_id": cleaned_uid,
                    "p_mfa_secret": cleaned_secret,
                    "p_enabled": True,
                },
            )
        except SupabaseServiceError as exc:
            raise AuthServiceError(str(exc))
        if not rows:
            return False
        return bool(rows[0].get("updated"))

    def admin_create_user(
        self,
        *,
        display_name: str,
        email: str,
        password: str,
        role: str,
    ) -> tuple[bool, str | None]:
        """
        Maakt een nieuw account aan met `has_access=true` en `mfa_enabled=false`
        (zodat MFA bij eerste login alsnog ingesteld wordt). Mag uitsluitend
        worden aangeroepen vanuit een geverifieerde VERSIE_A sessie - de aanroeper
        is verantwoordelijk voor die autorisatiecheck. Retourneert (True, None)
        bij succes, anders (False, foutbericht).
        """
        ok, msg = validate_display_name(display_name)
        if not ok:
            return False, msg

        ok, msg = validate_email_format(email)
        if not ok:
            return False, msg

        ok, msg = validate_new_password(password)
        if not ok:
            return False, msg

        ok, msg = validate_role_choice(role)
        if not ok:
            return False, msg

        normalized_email = self.normalize_email(email)
        cleaned_name = display_name.strip()
        cleaned_role = role.strip().upper()

        try:
            rows = self.supabase.call_rpc(
                "admin_create_app_user",
                {
                    "p_display_name": cleaned_name,
                    "p_email": normalized_email,
                    "p_password": password,
                    "p_role": cleaned_role,
                },
            )
        except SupabaseServiceError as exc:
            raise AuthServiceError(str(exc))

        if not rows:
            return False, "Account aanmaken mislukt. Probeer het later opnieuw."

        row = rows[0]
        err = row.get("error_code")
        if err:
            code = str(err)
            if code == "email_exists":
                return False, "Dit e-mailadres is al geregistreerd."
            if code == "invalid_email":
                return False, "Voer een geldig e-mailadres in."
            if code == "invalid_name":
                return False, "Controleer de naam of gebruikersnaam."
            if code == "weak_password":
                return False, f"Wachtwoord moet minstens {_PASSWORD_MIN_LEN} tekens lang zijn."
            if code == "password_too_long":
                return False, "Wachtwoord is te lang."
            if code == "invalid_role":
                return False, "Kies een geldige rol (VERSIE_A of VERSIE_B)."
            return False, "Account aanmaken is geweigerd. Controleer de gegevens."

        uid = row.get("user_id")
        if uid:
            return True, None
        return False, "Account aanmaken mislukt. Probeer het later opnieuw."

    def change_password(
        self,
        *,
        user_id: str,
        current_password: str,
        new_password: str,
        new_password_confirm: str,
    ) -> tuple[bool, str | None]:
        """
        Wijzigt het wachtwoord van de huidige ingelogde gebruiker. De RPC
        verifieert het huidige wachtwoord server-side; hier doen we daarnaast
        nog een client-side validatie (matchend confirm-veld + lengte) voor
        snellere UX-feedback. Plain wachtwoorden worden nooit gelogd.
        """
        cleaned_uid = (user_id or "").strip()
        if not cleaned_uid:
            return False, "Sessie verlopen. Log opnieuw in."

        if not (current_password or ""):
            return False, "Huidig wachtwoord is verplicht."

        ok, msg = validate_password_pair(new_password, new_password_confirm)
        if not ok:
            return False, msg

        if (new_password or "") == (current_password or ""):
            return False, "Het nieuwe wachtwoord moet verschillen van het huidige."

        try:
            rows = self.supabase.call_rpc(
                "change_app_user_password",
                {
                    "p_user_id": cleaned_uid,
                    "p_current_password": current_password,
                    "p_new_password": new_password,
                },
            )
        except SupabaseServiceError as exc:
            raise AuthServiceError(str(exc))

        if not rows:
            return False, "Wachtwoord wijzigen mislukt. Probeer het later opnieuw."

        row = rows[0]
        err = row.get("error_code")
        if err:
            code = str(err)
            if code == "wrong_password":
                return False, "Het huidige wachtwoord klopt niet."
            if code == "weak_password":
                return False, f"Wachtwoord moet minstens {_PASSWORD_MIN_LEN} tekens lang zijn."
            if code == "password_too_long":
                return False, "Wachtwoord is te lang."
            if code == "invalid_user":
                return False, "Sessie verlopen. Log opnieuw in."
            return False, "Wachtwoord wijzigen is geweigerd."

        if bool(row.get("updated")):
            return True, None
        return False, "Wachtwoord wijzigen mislukt. Probeer het later opnieuw."
