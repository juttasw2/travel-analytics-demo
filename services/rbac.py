from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from enum import StrEnum


class AppRole(StrEnum):
    VERSIE_A = "VERSIE_A"
    VERSIE_B = "VERSIE_B"


def normalize_app_role(raw_role: object) -> AppRole:
    role = str(raw_role or "").strip().upper()
    if role == AppRole.VERSIE_A:
        return AppRole.VERSIE_A
    return AppRole.VERSIE_B


def is_restricted_role(role: AppRole) -> bool:
    return role == AppRole.VERSIE_B


@dataclass(frozen=True)
class YearAccessPolicy:
    year: int
    allowed_previous_year: int | None = None


def resolve_allowed_year(
    *,
    requested_year: int | None,
    role: AppRole,
    current_year: int | None = None,
    allow_previous_year: bool = False,
) -> YearAccessPolicy:
    now_year = int(current_year or date.today().year)
    if role == AppRole.VERSIE_A:
        if requested_year is None:
            return YearAccessPolicy(year=now_year)
        return YearAccessPolicy(year=int(requested_year))

    if allow_previous_year:
        return YearAccessPolicy(year=now_year, allowed_previous_year=now_year - 1)
    return YearAccessPolicy(year=now_year)
