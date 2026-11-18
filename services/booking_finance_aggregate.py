"""
Aggregatie van Excel-rijwaarden (reizigers) naar één boeking voor `boeking_financien`.

Semantiek:
- Per-persoon bedragen (Excel per rij) → som over alle reizigersrijen van dezelfde order.
- Boekingbreed herhaalde of enkelvoudige schaalwaarden → consensus (gelijke waarde);
  bij mengvorm 0/null met niet-null wordt de niet-null waarde gekozen (met waarschuwing).
- Bij echte tegenstrijdigheden: waarschuwing + eerste niet-null in sheetvolgorde.
- Betalingsherinneringen zitten per reiziger op `reiziger_financien`, niet hier.
"""
from __future__ import annotations

import logging
import math
from typing import Any

from services.excel_parser import ExcelRow

logger = logging.getLogger(__name__)


def _uniq_floats(values: list[float]) -> list[float]:
    out: list[float] = []
    for v in values:
        if not any(math.isclose(v, u, rel_tol=0, abs_tol=1e-6) for u in out):
            out.append(v)
    return out


def sum_numeric_field(rows: list[ExcelRow], attr: str) -> float | None:
    total = 0.0
    seen = False
    for gr in rows:
        val = getattr(gr, attr)
        if val is None:
            continue
        seen = True
        total += float(val)
    return total if seen else None


def consensus_booking_scalar(
    rows: list[ExcelRow],
    attr: str,
    *,
    order_nummer: str,
    field_label: str,
    warnings: list[str] | None = None,
) -> float | None:
    values: list[float] = []
    for gr in rows:
        v = getattr(gr, attr)
        if v is not None:
            values.append(float(v))
    if not values:
        return None
    uniq = _uniq_floats(values)
    if len(uniq) == 1:
        return values[0]
    non_zero = [v for v in values if not math.isclose(v, 0.0, abs_tol=1e-9)]
    nz_uniq = _uniq_floats(non_zero)
    if len(nz_uniq) == 1:
        msg = (
            f"Boeking {order_nummer}: gemengde 0/null en niet-null voor '{field_label}' "
            f"(gebruikt {nz_uniq[0]})."
        )
        if warnings is not None:
            warnings.append(msg)
        logger.warning("%s", msg)
        return nz_uniq[0]
    msg = (
        f"Boeking {order_nummer}: tegenstrijdige '{field_label}' waarden {sorted(_uniq_floats(values))} "
        f"(gebruikt eerste niet-null in sheetvolgorde: {values[0]})."
    )
    if warnings is not None:
        warnings.append(msg)
    logger.warning("%s", msg)
    return values[0]


def consensus_booking_int(
    rows: list[ExcelRow],
    attr: str,
    *,
    order_nummer: str,
    field_label: str,
    warnings: list[str] | None = None,
) -> int | None:
    values: list[int] = []
    for gr in rows:
        v = getattr(gr, attr)
        if v is not None:
            values.append(int(v))
    if not values:
        return None
    uniq = list(dict.fromkeys(values))
    if len(uniq) == 1:
        return values[0]
    msg = (
        f"Boeking {order_nummer}: tegenstrijdige '{field_label}' waarden {sorted(set(values))} "
        f"(gebruikt eerste niet-null: {values[0]})."
    )
    if warnings is not None:
        warnings.append(msg)
    logger.warning("%s", msg)
    return values[0]


def consensus_booking_text(
    rows: list[ExcelRow],
    attr: str,
    *,
    order_nummer: str,
    field_label: str,
    warnings: list[str] | None = None,
) -> str | None:
    vals: list[str] = []
    for gr in rows:
        v = getattr(gr, attr)
        if v is None:
            continue
        s = str(v).strip()
        if s:
            vals.append(s)
    if not vals:
        return None
    uniq = list(dict.fromkeys(vals))
    if len(uniq) == 1:
        return uniq[0]
    msg = (
        f"Boeking {order_nummer}: tegenstrijdige '{field_label}' waarden {uniq} "
        f"(gebruikt eerste niet-null: {vals[0]})."
    )
    if warnings is not None:
        warnings.append(msg)
    logger.warning("%s", msg)
    return vals[0]


def consensus_booking_date(
    rows: list[ExcelRow],
    attr: str,
    *,
    order_nummer: str,
    field_label: str,
    warnings: list[str] | None = None,
) -> Any:
    vals: list[Any] = []
    for gr in rows:
        v = getattr(gr, attr)
        if v is not None:
            vals.append(v)
    if not vals:
        return None
    uniq: list[Any] = []
    for v in vals:
        if v not in uniq:
            uniq.append(v)
    if len(uniq) == 1:
        return vals[0]
    msg = (
        f"Boeking {order_nummer}: tegenstrijdige '{field_label}' waarden (gebruikt eerste niet-null)."
    )
    if warnings is not None:
        warnings.append(msg)
    logger.warning("%s", msg)
    return vals[0]
