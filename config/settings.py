import os
from pathlib import Path
import secrets

from dotenv import load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parent.parent


def load_environment() -> None:
    """
    Load environment variables from a .env file in the project root.
    """
    env_path = PROJECT_ROOT / ".env"
    if env_path.exists():
        load_dotenv(dotenv_path=env_path, override=False)


def get_database_url() -> str:
    load_environment()
    url = os.getenv("DATABASE_URL", "").strip()
    if not url:
        raise RuntimeError("DATABASE_URL is not set. Please configure it in your .env file.")
    return url


# Backward-compatible aliases (used nowhere after migration, kept for safety).
def get_supabase_url() -> str:
    return get_database_url()


def get_supabase_anon_key() -> str:
    return ""


def get_supabase_service_role_key() -> str | None:
    return None


def is_production_like() -> bool:
    """FLASK_ENV=production: vereist vaste FLASK_SECRET_KEY (geen runtime-random key)."""
    load_environment()
    return os.getenv("FLASK_ENV", "").strip().lower() == "production"


def get_flask_secret_key() -> str:
    """
    Return a non-empty secret key for Flask sessions.

    Bij FLASK_ENV=production moet FLASK_SECRET_KEY in .env staan; anders faalt de start.
    Lokaal (development) mag een willekeurige fallback gebruikt worden.
    """
    load_environment()
    key = os.getenv("FLASK_SECRET_KEY", "").strip()
    if key:
        return key
    if is_production_like():
        raise RuntimeError(
            "FLASK_SECRET_KEY ontbreekt terwijl FLASK_ENV=production. "
            "Zet een lang willekeurig geheim in .env (sessies en cookies zijn anders onveilig)."
        )
    return secrets.token_urlsafe(32)


def _read_positive_int_env(name: str) -> int | None:
    raw = os.getenv(name)
    if raw is None:
        return None
    try:
        value = int(raw.strip())
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


def get_upload_max_file_size_bytes() -> int:
    """
    Centrale uploadlimiet voor zowel request body als business-validatie.

    Prioriteit:
    1) UPLOAD_MAX_FILE_SIZE_BYTES
    2) UPLOAD_MAX_FILE_SIZE_MB
    3) Fallback 100MB
    """
    load_environment()
    bytes_value = _read_positive_int_env("UPLOAD_MAX_FILE_SIZE_BYTES")
    if bytes_value is not None:
        return bytes_value
    mb_value = _read_positive_int_env("UPLOAD_MAX_FILE_SIZE_MB")
    if mb_value is not None:
        return mb_value * 1024 * 1024
    return 100 * 1024 * 1024


def get_mfa_issuer_name() -> str:
    load_environment()
    issuer = os.getenv("MFA_ISSUER_NAME", "").strip()
    return issuer or "TravelAnalytics"

