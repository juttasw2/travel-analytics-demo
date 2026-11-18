"""Normalisatie van kosten tijdens upload/import (vóór opslag in reiziger_financien)."""

from __future__ import annotations


def normalize_financial_costs(
    *,
    transport_type: str | None,
    brand: str | None,
    kost_transport: float | int | None,
    kost_transfer: float | int | None,
) -> tuple[float, float]:
    """
    Pas importregels toe vóór insert/update in reiziger_financien.

    Regels:
    - bus + kost_transport=0 + brand != "road rebels" -> 130
    - bus + kost_transport=0 + brand == "road rebels" -> 0
    - self + kost_transport=0 -> 1
    - plane + kost_transfer=0 -> 40
    """
    transport = (transport_type or "").strip().lower()
    brand_norm = (brand or "").strip().lower()
    norm_kost_transport = float(kost_transport) if kost_transport is not None else 0.0
    norm_kost_transfer = float(kost_transfer) if kost_transfer is not None else 0.0

    if transport == "bus" and norm_kost_transport == 0.0 and brand_norm != "road rebels":
        norm_kost_transport = 130.0
    elif transport == "self" and norm_kost_transport == 0.0:
        norm_kost_transport = 1.0

    if transport == "plane" and norm_kost_transfer == 0.0:
        norm_kost_transfer = 40.0

    return norm_kost_transport, norm_kost_transfer
