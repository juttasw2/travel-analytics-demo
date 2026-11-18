from __future__ import annotations

import base64
import io
import re

import pyotp
import qrcode


_TOKEN_RE = re.compile(r"^\d{6}$")


class MfaService:
    @staticmethod
    def generate_secret() -> str:
        return pyotp.random_base32()

    @staticmethod
    def provisioning_uri(*, email: str, secret: str, issuer_name: str) -> str:
        totp = pyotp.TOTP(secret)
        return totp.provisioning_uri(name=email, issuer_name=issuer_name)

    @staticmethod
    def verify_token(*, secret: str, token: str) -> bool:
        cleaned = (token or "").strip().replace(" ", "")
        if not _TOKEN_RE.match(cleaned):
            return False
        totp = pyotp.TOTP(secret)
        return bool(totp.verify(cleaned, valid_window=1))

    @staticmethod
    def build_qr_data_uri(payload: str) -> str:
        qr = qrcode.QRCode(box_size=8, border=2)
        qr.add_data(payload)
        qr.make(fit=True)
        image = qr.make_image(fill_color="black", back_color="white")

        stream = io.BytesIO()
        image.save(stream, format="PNG")
        encoded = base64.b64encode(stream.getvalue()).decode("ascii")
        return f"data:image/png;base64,{encoded}"
