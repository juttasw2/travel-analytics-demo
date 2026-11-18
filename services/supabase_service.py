from __future__ import annotations

import json
import logging
import time
import re
import unicodedata
from collections import Counter, defaultdict
from decimal import Decimal, ROUND_HALF_UP
from datetime import date, datetime
from dataclasses import dataclass
from uuid import UUID
from typing import Any, Iterable

import psycopg2
import psycopg2.extras
import psycopg2.pool

_logger = logging.getLogger(__name__)

from config.settings import get_database_url
# PostgREST `in.(…)` in querystring: te grote batches geven 414 / gateway-fouten bij DELETE/GET.
REIZIGERS_BOEKING_ID_IN_CHUNK = 50


class SupabaseServiceError(RuntimeError):
    pass


@dataclass(frozen=True)
class UploadRecord:
    id: str
    bestandsnaam: str
    geupload_op: str
    geupload_op_formatted: str
    type: str = "Boekingen"


def _upload_type_label(value: Any) -> str:
    raw = str(value or "").strip().lower()
    if raw == "vlucht_allotments":
        return "Vlucht allotments"
    return "Boekingen"


def _format_datetime(value: Any) -> str:
    if value is None:
        return ""
    s = str(value)
    # Best-effort: 2026-03-20T10:12:13.123456+00:00 -> 2026-03-20 10:12:13
    if "T" in s:
        date_part = s.split("T")[0]
        time_part = s.split("T")[1].split("+")[0].split("-")[0]
        time_part = time_part.split(".")[0]
        return f"{date_part} {time_part}".strip()
    return s


def _unwrap_financieel_rpc_jsonb_payload(raw: Any) -> dict[str, Any]:
    """RPC `financieel_bookings_rpc`: jsonb of genest onder functienaam; behoud `payment_travellers`."""
    cur: Any = raw
    if cur is None:
        return {"rows": [], "payment_travellers": []}
    if isinstance(cur, list) and len(cur) == 1:
        cur = cur[0]
    if isinstance(cur, dict) and len(cur) == 1:
        _k, val = next(iter(cur.items()))
        if isinstance(val, str) and val.strip().startswith("{"):
            try:
                cur = json.loads(val)
            except (json.JSONDecodeError, TypeError):
                cur = {}
        elif isinstance(val, dict):
            cur = val
    if isinstance(cur, dict) and "rows" not in cur:
        for v in cur.values():
            if isinstance(v, dict) and "rows" in v:
                cur = v
                break
    if not isinstance(cur, dict):
        return {"rows": [], "payment_travellers": []}
    rows = cur.get("rows")
    pt = cur.get("payment_travellers")
    if not isinstance(rows, list):
        rows = []
    if not isinstance(pt, list):
        pt = []
    out = {**cur}
    out["rows"] = rows
    out["payment_travellers"] = pt
    return out


def _unwrap_leveranciers_rpc_jsonb_payload(raw: Any) -> dict[str, Any]:
    """RPC `leveranciers_analyse_rpc`: jsonb of genest onder functienaam."""
    cur: Any = raw
    if isinstance(cur, list) and len(cur) == 1:
        cur = cur[0]
    if isinstance(cur, dict) and len(cur) == 1:
        _k, val = next(iter(cur.items()))
        if isinstance(val, str) and val.strip().startswith("{"):
            try:
                cur = json.loads(val)
            except (json.JSONDecodeError, TypeError):
                cur = {}
        elif isinstance(val, dict):
            cur = val
    if not isinstance(cur, dict):
        return {"summary": [], "details": []}
    summary = cur.get("summary")
    details = cur.get("details")
    if not isinstance(summary, list):
        summary = []
    if not isinstance(details, list):
        details = []
    return {"summary": summary, "details": details}


class SupabaseService:
    _pool: psycopg2.pool.ThreadedConnectionPool | None = None

    def __init__(self, timeout_seconds: float = 30.0) -> None:
        self.timeout_seconds = timeout_seconds
        if SupabaseService._pool is None:
            dsn = get_database_url()
            # `statement_timeout` op pool-niveau is een vangnet; per transactie
            # passen we hem alsnog aan via `_apply_statement_timeout` (zie hieronder).
            # Pool wordt slechts éénmaal gemaakt (singleton), dus latere instances
            # erven dezelfde pool-default. Daarom moeten we het PER use overrulen.
            pool_default_ms = max(int(timeout_seconds * 1000), 30_000)
            SupabaseService._pool = psycopg2.pool.ThreadedConnectionPool(
                minconn=1,
                maxconn=10,
                dsn=dsn,
                options=f"-c statement_timeout={pool_default_ms}",
            )

    def _apply_statement_timeout(self, cur) -> None:
        """Zet `statement_timeout` voor de huidige transactie (LOCAL).

        Nodig omdat de connection-pool een class-singleton is: de eerste keer dat
        SupabaseService wordt geïnstantieerd bepaalt de pool-default. Per gebruik
        overrulen we hier zodat een upload (`timeout_seconds=120`) niet vastloopt
        op een 30s-default die een eerdere instance heeft gezet.
        """
        try:
            cur.execute(
                "SELECT set_config('statement_timeout', %s, true)",
                (f"{int(self.timeout_seconds * 1000)}ms",),
            )
        except Exception:  # noqa: BLE001
            # Niet-fataal; de pool-default werkt nog.
            pass

    @staticmethod
    def _is_connection_alive(conn) -> bool:
        """Test of een connectie nog bruikbaar is (non-blocking ping)."""
        if conn is None or getattr(conn, "closed", 1):
            return False
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
                cur.fetchone()
            return True
        except Exception:  # noqa: BLE001
            return False

    def _get_conn(self):
        """Hand een levende connectie uit. Vervangt dode connecties uit de pool transparant."""
        for _ in range(3):
            conn = self._pool.getconn()
            if self._is_connection_alive(conn):
                return conn
            try:
                self._pool.putconn(conn, close=True)
            except Exception:  # noqa: BLE001
                pass
        return self._pool.getconn()

    def _put_conn(self, conn, *, broken: bool = False):
        """Geef connectie terug aan pool. `broken=True` verwijdert haar uit de pool."""
        if conn is None:
            return
        try:
            if broken or getattr(conn, "closed", 0):
                self._pool.putconn(conn, close=True)
            else:
                self._pool.putconn(conn)
        except Exception:  # noqa: BLE001
            try:
                self._pool.putconn(conn, close=True)
            except Exception:  # noqa: BLE001
                pass

    @staticmethod
    def _safe_rollback(conn) -> bool:
        """Rollback maar nooit zelf raisen; returnt False als de connectie dood was."""
        if conn is None or getattr(conn, "closed", 1):
            return False
        try:
            conn.rollback()
            return True
        except Exception:  # noqa: BLE001
            return False

    @staticmethod
    def _is_connection_lost_error(exc: Exception) -> bool:
        """Detecteer 'connection closed/lost' fouten zodat we de connectie uit de pool gooien."""
        if isinstance(exc, (psycopg2.InterfaceError, psycopg2.OperationalError)):
            return True
        msg = str(exc).lower()
        return (
            "server closed the connection" in msg
            or "connection already closed" in msg
            or "connection is closed" in msg
            or "ssl syscall error" in msg
            or "could not receive data from server" in msg
        )

    def _execute(
        self,
        query: str,
        params: tuple | dict | None = None,
        *,
        fetch: bool = True,
        returning: bool = False,
    ) -> list[dict[str, Any]]:
        conn = self._get_conn()
        broken = False
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                self._apply_statement_timeout(cur)
                cur.execute(query, params)
                if fetch or returning:
                    rows = cur.fetchall()
                    conn.commit()
                    return [dict(r) for r in rows]
                conn.commit()
                return []
        except Exception as exc:  # noqa: BLE001
            broken = self._is_connection_lost_error(exc)
            self._safe_rollback(conn)
            raise
        finally:
            self._put_conn(conn, broken=broken)

    @staticmethod
    def _normalize_excursie_naam(value: Any) -> str | None:
        if value is None:
            return None
        raw = str(value).strip()
        if not raw:
            return None
        folded = unicodedata.normalize("NFKD", raw)
        ascii_only = "".join(ch for ch in folded if not unicodedata.combining(ch))
        collapsed = re.sub(r"\s+", " ", ascii_only).strip()
        if not collapsed:
            return None
        return collapsed.upper()

    def _normalize_for_json(self, value: Any) -> Any:
        if isinstance(value, (date, datetime)):
            return value.isoformat()
        if isinstance(value, dict):
            return {k: self._normalize_for_json(v) for k, v in value.items()}
        if isinstance(value, list):
            return [self._normalize_for_json(v) for v in value]
        return value

    def _normalize_rows_for_json(self, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return [self._normalize_for_json(r) for r in rows]

    # ----------------------------
    # SQL helpers (replace PostgREST)
    # ----------------------------

    @staticmethod
    def _postgrest_filter_to_sql(column: str, value: str) -> tuple[str, list[Any]]:
        """Convert a PostgREST-style filter value to a SQL WHERE fragment + params."""
        if value.startswith("eq."):
            val = value[3:].strip('"')
            return f'"{column}" = %s', [val]
        if value.startswith("neq."):
            val = value[4:].strip('"')
            return f'"{column}" != %s', [val]
        if value.startswith("gt."):
            return f'"{column}" > %s', [value[3:]]
        if value.startswith("gte."):
            return f'"{column}" >= %s', [value[4:]]
        if value.startswith("lt."):
            return f'"{column}" < %s', [value[3:]]
        if value.startswith("lte."):
            return f'"{column}" <= %s', [value[4:]]
        if value.startswith("in.(") and value.endswith(")"):
            inner = value[4:-1]
            items = [v.strip().strip('"') for v in inner.split(",") if v.strip()]
            placeholders = ",".join(["%s"] * len(items))
            return f'"{column}" IN ({placeholders})', items
        if value.startswith("not.in.(") and value.endswith(")"):
            inner = value[8:-1]
            items = [v.strip().strip('"') for v in inner.split(",") if v.strip()]
            placeholders = ",".join(["%s"] * len(items))
            return f'"{column}" NOT IN ({placeholders})', items
        if value.startswith("not.is."):
            return f'"{column}" IS NOT NULL', []
        if value.startswith("is."):
            return f'"{column}" IS NULL', []
        if value.startswith("ilike."):
            return f'"{column}" ILIKE %s', [value[6:]]
        # or(...) filters
        if value.startswith("(") and value.endswith(")"):
            inner = value[1:-1]
            parts = inner.split(",")
            or_clauses = []
            or_params: list[Any] = []
            for part in parts:
                dot_idx = part.index(".")
                sub_col = part[:dot_idx]
                sub_val = part[dot_idx + 1:]
                clause, params = SupabaseService._postgrest_filter_to_sql(sub_col, sub_val)
                or_clauses.append(clause)
                or_params.extend(params)
            return f"({' OR '.join(or_clauses)})", or_params
        # Fallback: exact match
        return f'"{column}" = %s', [value]

    def _sql_insert(
        self,
        table: str,
        rows: list[dict[str, Any]],
        *,
        returning: str = "*",
    ) -> list[dict[str, Any]]:
        if not rows:
            return []
        # Verzamel alle kolommen die in een willekeurige rij voorkomen — sommige
        # rijen kunnen optionele velden missen. Dit zorgt voor één uniforme
        # kolommenlijst zodat `execute_values` de hele batch in 1 round-trip kan
        # uitvoeren in plaats van N losse INSERTs.
        columns: list[str] = []
        seen_cols: set[str] = set()
        for r in rows:
            for c in r.keys():
                if c not in seen_cols:
                    seen_cols.add(c)
                    columns.append(c)
        col_list = ", ".join(f'"{c}"' for c in columns)
        ret = f" RETURNING {returning}" if returning else ""
        # `execute_values` vervangt VALUES %s door een lijst tuples.
        sql = f'INSERT INTO "{table}" ({col_list}) VALUES %s{ret}'
        template = "(" + ", ".join(["%s"] * len(columns)) + ")"
        values_list = [tuple(row.get(c) for c in columns) for row in rows]

        conn = self._get_conn()
        broken = False
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                self._apply_statement_timeout(cur)
                fetch = bool(returning)
                t0 = time.perf_counter()
                result = psycopg2.extras.execute_values(
                    cur, sql, values_list, template=template, page_size=500, fetch=fetch,
                )
                conn.commit()
                dt = time.perf_counter() - t0
                if dt > 1.0:
                    _logger.info(
                        "insert table=%s rows=%d returning=%s elapsed=%.2fs",
                        table, len(values_list), bool(returning), dt,
                    )
                if fetch:
                    return [dict(r) for r in (result or [])]
                return []
        except Exception as exc:  # noqa: BLE001
            broken = self._is_connection_lost_error(exc)
            self._safe_rollback(conn)
            raise SupabaseServiceError(f"Insert mislukt ({table}): {exc}")
        finally:
            self._put_conn(conn, broken=broken)

    def _sql_update(
        self,
        table: str,
        payload: dict[str, Any],
        filters: dict[str, str],
        *,
        returning: str = "*",
    ) -> list[dict[str, Any]]:
        set_parts = []
        params: list[Any] = []
        for col, val in payload.items():
            set_parts.append(f'"{col}" = %s')
            params.append(val)
        where_clauses = []
        for key, value in filters.items():
            clause, p = self._postgrest_filter_to_sql(key, value)
            where_clauses.append(clause)
            params.extend(p)
        where = (" WHERE " + " AND ".join(where_clauses)) if where_clauses else ""
        ret = f" RETURNING {returning}" if returning else ""
        sql = f'UPDATE "{table}" SET {", ".join(set_parts)}{where}{ret}'
        try:
            # Zonder RETURNING geen resultset → fetch uit; anders psycopg2 ProgrammingError.
            return self._execute(sql, tuple(params), fetch=bool(returning))
        except Exception as exc:
            raise SupabaseServiceError(f"Update mislukt ({table}): {exc}")

    def _sql_delete(self, table: str, filters: dict[str, str]) -> None:
        where_clauses = []
        params: list[Any] = []
        for key, value in filters.items():
            clause, p = self._postgrest_filter_to_sql(key, value)
            where_clauses.append(clause)
            params.extend(p)
        where = (" WHERE " + " AND ".join(where_clauses)) if where_clauses else ""
        sql = f'DELETE FROM "{table}"{where}'
        try:
            self._execute(sql, tuple(params), fetch=False)
        except Exception as exc:
            raise SupabaseServiceError(f"Delete mislukt ({table}): {exc}")

    def list_uploads(self, *, limit: int = 50) -> list[UploadRecord]:
        rows = self._rest_select(
            "uploads",
            select="id,bestandsnaam,geupload_op,type",
            filters={"order": "geupload_op.desc", "limit": str(limit)},
        )
        out: list[UploadRecord] = []
        for r in rows:
            geupload_op_formatted = _format_datetime(r.get("geupload_op"))
            out.append(
                UploadRecord(
                    id=str(r.get("id")),
                    bestandsnaam=str(r.get("bestandsnaam")),
                    geupload_op=str(r.get("geupload_op")),
                    geupload_op_formatted=geupload_op_formatted,
                    type=_upload_type_label(r.get("type")),
                )
            )
        return out

    def list_uploads_overzicht(self, *, limit: int = 100) -> list[UploadRecord]:
        rows = self._rest_select(
            "uploads",
            select="id,bestandsnaam,geupload_op,type",
            filters={"order": "geupload_op.desc", "limit": str(limit)},
        )
        out: list[UploadRecord] = []
        for r in rows:
            out.append(
                UploadRecord(
                    id=str(r.get("id") or ""),
                    bestandsnaam=str(r.get("bestandsnaam") or ""),
                    geupload_op=str(r.get("geupload_op") or ""),
                    geupload_op_formatted=_format_datetime(r.get("geupload_op")),
                    type=_upload_type_label(r.get("type")),
                )
            )
        out.sort(key=lambda x: x.geupload_op or "", reverse=True)
        return out[:limit]

    def insert_upload(self, *, bestandsnaam: str, type: str = "boekingen") -> str:
        payload = {"bestandsnaam": bestandsnaam, "type": type}
        try:
            rows = self._sql_insert("uploads", [payload], returning="id")
        except SupabaseServiceError:
            # Backward-compatible fallback while DB migration is rolling out.
            rows = self._sql_insert("uploads", [{"bestandsnaam": bestandsnaam}], returning="id")
        if not rows:
            raise SupabaseServiceError("Upload record opslaan mislukt: geen response.")
        return str(rows[0]["id"])

    def insert_vlucht_allotment_upload(
        self,
        *,
        bestandsnaam: str,
        merk_land: str | None = None,
        status: str = "verwerkt",
        foutmelding: str | None = None,
    ) -> str:
        _ = (merk_land, status, foutmelding)
        return self.insert_upload(bestandsnaam=bestandsnaam, type="vlucht_allotments")

    def insert_vlucht_allotments(self, rows: list[dict[str, Any]], batch_size: int = 500) -> int:
        if not rows:
            return 0
        # Latest-wins binnen dezelfde upload: bij dubbele sleutel bewaren we de laatste rij.
        deduped_map: dict[tuple[str, str, str, str], dict[str, Any]] = {}
        for row in rows:
            arrival = str(row.get("arrival") or "").strip()
            departure = str(row.get("departure") or "").strip()
            outbound_flight = str(row.get("outbound_flight") or "").strip()
            inbound_flight = str(row.get("inbound_flight") or "").strip()
            if not arrival or not departure or not outbound_flight or not inbound_flight:
                continue
            deduped_map[(arrival, departure, outbound_flight, inbound_flight)] = row
        deduped_rows = list(deduped_map.values())

        verwerkt = 0
        for i in range(0, len(deduped_rows), batch_size):
            batch_raw = deduped_rows[i : i + batch_size]
            batch = self._normalize_rows_for_json(batch_raw)
            try:
                upserted = self._rest_upsert(
                    "vlucht_allotments",
                    batch,
                    on_conflict="arrival,departure,outbound_flight,inbound_flight",
                    return_representation=True,
                )
            except SupabaseServiceError as exc:
                # Fallback: per rij upserten wanneer de API een bulkconflict terugstuurt.
                if "409" not in str(exc) and "23505" not in str(exc):
                    raise
                upserted = []
                for row in batch:
                    result = self._rest_upsert(
                        "vlucht_allotments",
                        [row],
                        on_conflict="arrival,departure,outbound_flight,inbound_flight",
                        return_representation=True,
                    )
                    upserted.extend(result)
            if not upserted:
                # Ook zonder representation tellen we de batch als verwerkt.
                verwerkt += len(batch_raw)
                continue
            verwerkt += len(upserted)
        return verwerkt

    def vlucht_allotment_dashboard_rows(
        self,
        *,
        jaar: int | None = None,
        arrival_van: str | None = None,
        arrival_tot: str | None = None,
        departure_van: str | None = None,
        departure_tot: str | None = None,
        agency: str | None = None,
        way: str | None = None,
        flight: str | None = None,
    ) -> list[dict[str, Any]]:
        params: list[tuple[str, Any]] = []
        if jaar:
            params.append(("arrival", f"gte.{jaar}-01-01"))
            params.append(("arrival", f"lte.{jaar}-12-31"))
        if arrival_van:
            params.append(("arrival", f"gte.{arrival_van}"))
        if arrival_tot:
            params.append(("arrival", f"lte.{arrival_tot}"))
        if departure_van:
            params.append(("departure", f"gte.{departure_van}"))
        if departure_tot:
            params.append(("departure", f"lte.{departure_tot}"))
        if agency and agency != "__all__":
            params.append(("agency", f"eq.{agency}"))
        if way and way != "__all__":
            params.append(("way", f"eq.{way}"))
        if flight:
            params.append(("or", f"(outbound_flight.ilike.*{flight}*,inbound_flight.ilike.*{flight}*)"))
        params.append(("order", "arrival.asc"))
        return self._rest_select_multi_params(
            "vlucht_allotments",
            select="id,upload_id,arrival,departure,agency,way,total_pax,booked_pax,still_free,outbound_flight,inbound_flight,pp_outbound,pp_inbound",
            query_params=params,
        )

    def vlucht_allotment_dashboard_filters(self) -> dict[str, list[Any]]:
        rows = self._paginate_rest_scan(
            "vlucht_allotments",
            select="arrival,agency,way,outbound_flight,inbound_flight",
            query_params=[],
            page_size=1000,
        )
        jaren = sorted(
            {
                int(str(r.get("arrival"))[:4])
                for r in rows
                if r.get("arrival") and str(r.get("arrival"))[:4].isdigit()
            },
            reverse=True,
        )
        agencies = sorted({str(r.get("agency")) for r in rows if r.get("agency")})
        ways = sorted({str(r.get("way")) for r in rows if r.get("way")})
        flights = sorted(
            {
                str(value)
                for r in rows
                for value in (r.get("outbound_flight"), r.get("inbound_flight"))
                if value
            }
        )
        return {
            "jaren": jaren,
            "agencies": agencies,
            "ways": ways,
            "flights": flights,
        }

    def koppel_reizigers_aan_vlucht_allotments(self) -> dict[str, Any]:
        rows = self.call_rpc("koppel_reizigers_aan_vlucht_allotments", {})
        if not rows:
            return {"aantal_gekoppeld": 0, "aantal_onzeker": 0, "aantal_niet_gekoppeld": 0}
        first = rows[0]
        nested = first.get("koppel_reizigers_aan_vlucht_allotments")
        if isinstance(nested, dict):
            return {
                "aantal_gekoppeld": int(nested.get("aantal_gekoppeld") or 0),
                "aantal_onzeker": int(nested.get("aantal_onzeker") or 0),
                "aantal_niet_gekoppeld": int(nested.get("aantal_niet_gekoppeld") or 0),
            }
        if "aantal_gekoppeld" in first:
            return first
        return {
            "aantal_gekoppeld": int(first.get("aantal_gekoppeld") or 0),
            "aantal_onzeker": int(first.get("aantal_onzeker") or 0),
            "aantal_niet_gekoppeld": int(first.get("aantal_niet_gekoppeld") or 0),
        }

    def _rest_upsert(
        self,
        table: str,
        rows: list[dict[str, Any]],
        *,
        on_conflict: str,
        return_representation: bool = True,
    ) -> list[dict[str, Any]]:
        if not rows:
            return []
        # Verzamel alle kolommen die in een willekeurige rij voorkomen (sommige rijen
        # missen optionele velden). Eén INSERT-batch met uniforme kolommenlijst.
        columns: list[str] = []
        seen_cols: set[str] = set()
        for r in rows:
            for c in r.keys():
                if c not in seen_cols:
                    seen_cols.add(c)
                    columns.append(c)
        col_list = ", ".join(f'"{c}"' for c in columns)
        conflict_keys = [c.strip() for c in on_conflict.split(",") if c.strip()]
        conflict_cols = ", ".join(f'"{c}"' for c in conflict_keys)
        update_set = ", ".join(
            f'"{c}" = EXCLUDED."{c}"' for c in columns if c not in conflict_keys
        )
        if update_set:
            conflict_clause = f"ON CONFLICT ({conflict_cols}) DO UPDATE SET {update_set}"
        else:
            conflict_clause = f"ON CONFLICT ({conflict_cols}) DO NOTHING"
        returning_clause = "RETURNING *" if return_representation else ""
        # `execute_values` injecteert een lijst tuples op de plek van VALUES %s.
        sql = (
            f'INSERT INTO "{table}" ({col_list}) VALUES %s {conflict_clause} {returning_clause}'
        ).strip()
        template = "(" + ", ".join(["%s"] * len(columns)) + ")"
        values_list = [tuple(row.get(c) for c in columns) for row in rows]

        # Eén retry bij verloren verbinding (server timeout / netwerk drop).
        last_exc: Exception | None = None
        for attempt in (1, 2):
            conn = self._get_conn()
            broken = False
            t0 = time.perf_counter()
            try:
                with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                    self._apply_statement_timeout(cur)
                    if return_representation:
                        result = psycopg2.extras.execute_values(
                            cur, sql, values_list, template=template, page_size=200, fetch=True,
                        )
                        out = [dict(r) for r in (result or [])]
                    else:
                        psycopg2.extras.execute_values(
                            cur, sql, values_list, template=template, page_size=200, fetch=False,
                        )
                        out = []
                    conn.commit()
                dt = time.perf_counter() - t0
                if dt > 1.0:
                    _logger.info(
                        "upsert table=%s rows=%d return_repr=%s elapsed=%.2fs",
                        table, len(values_list), return_representation, dt,
                    )
                return out
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
                conn_lost = self._is_connection_lost_error(exc)
                self._safe_rollback(conn)
                broken = conn_lost
                if conn_lost and attempt == 1:
                    _logger.warning(
                        "Upsert %s: connectie verloren (%s); retry met nieuwe connectie",
                        table, exc.__class__.__name__,
                    )
                    continue
                raise SupabaseServiceError(f"Upsert mislukt ({table}): {exc}")
            finally:
                self._put_conn(conn, broken=broken)
        # Niet bereikbaar; voor de typechecker.
        raise SupabaseServiceError(f"Upsert mislukt ({table}): {last_exc}")

    def _rest_select(self, table: str, *, select: str, filters: dict[str, str]) -> list[dict[str, Any]]:
        columns = select if select != "*" else "*"
        where_clauses: list[str] = []
        params: list[Any] = []
        order_clause = ""
        limit_clause = ""
        for key, value in filters.items():
            if key == "order":
                # PostgREST-stijl "col.asc,col2.desc" → SQL ORDER BY "col" ASC, "col2" DESC.
                order_parts: list[str] = []
                for entry in str(value).split(","):
                    entry = entry.strip()
                    if not entry:
                        continue
                    pieces = entry.split(".")
                    col = pieces[0]
                    direction = pieces[1].upper() if len(pieces) > 1 else "ASC"
                    if direction not in {"ASC", "DESC"}:
                        direction = "ASC"
                    order_parts.append(f'"{col}" {direction}')
                if order_parts:
                    order_clause = " ORDER BY " + ", ".join(order_parts)
                continue
            if key == "limit":
                limit_clause = f" LIMIT {int(value)}"
                continue
            clause, p = self._postgrest_filter_to_sql(key, value)
            where_clauses.append(clause)
            params.extend(p)
        where = (" WHERE " + " AND ".join(where_clauses)) if where_clauses else ""
        sql = f'SELECT {columns} FROM "{table}"{where}{order_clause}{limit_clause}'
        try:
            return self._execute(sql, tuple(params))
        except Exception as exc:
            raise SupabaseServiceError(f"Select mislukt ({table}): {exc}")

    def _rest_select_multi_params(
        self, table: str, *, select: str, query_params: list[tuple[str, Any]]
    ) -> list[dict[str, Any]]:
        columns = select if select != "*" else "*"
        where_clauses: list[str] = []
        params: list[Any] = []
        order_clause = ""
        limit_clause = ""
        offset_clause = ""
        for key, value in query_params:
            if key == "select":
                continue
            if key == "order":
                parts = str(value).split(".")
                col = parts[0]
                direction = parts[1].upper() if len(parts) > 1 else "ASC"
                order_clause = f' ORDER BY "{col}" {direction}'
                continue
            if key == "limit":
                limit_clause = f" LIMIT {int(value)}"
                continue
            if key == "offset":
                offset_clause = f" OFFSET {int(value)}"
                continue
            if key == "or":
                clause, p = self._postgrest_filter_to_sql("or", value)
                where_clauses.append(clause)
                params.extend(p)
                continue
            clause, p = self._postgrest_filter_to_sql(key, str(value))
            where_clauses.append(clause)
            params.extend(p)
        where = (" WHERE " + " AND ".join(where_clauses)) if where_clauses else ""
        sql = f'SELECT {columns} FROM "{table}"{where}{order_clause}{limit_clause}{offset_clause}'
        try:
            return self._execute(sql, tuple(params))
        except Exception as exc:
            raise SupabaseServiceError(f"Select mislukt ({table}): {exc}")

    def _paginate_rest_scan(
        self,
        table: str,
        *,
        select: str,
        query_params: list[tuple[str, Any]],
        page_size: int = 1000,
    ) -> list[dict[str, Any]]:
        # Direct PG doesn't need pagination; just run the full query.
        return self._rest_select_multi_params(table, select=select, query_params=query_params)

    # ----------------------------
    # RPC helper (direct PostgreSQL)
    # ----------------------------

    @staticmethod
    def _normaliseer_status_type(status_type: str) -> str:
        s = (status_type or "").strip().lower()
        mapping = {
            "booking": "boeking",
            "payment": "betaling",
            "traveller": "reiziger",
            "traveler": "reiziger",
            "acco": "accommodatie",
            "accommodation": "accommodatie",
        }
        return mapping.get(s, s)

    def call_rpc(self, function_name: str, params: dict[str, Any]) -> list[dict[str, Any]]:
        if not params:
            sql = f"SELECT * FROM {function_name}()"
            args: tuple | dict = ()
        else:
            cast_overrides: dict[str, str] = {}
            if function_name == "klantenprofiel_dashboard":
                cast_overrides = {
                    "p_year": "integer",
                    "p_brand": "text",
                    "p_bestemming_ids": "text[]",
                    "p_period": "text",
                    "p_origin": "text",
                    "p_reiziger_land": "text",
                    "p_reiziger_provincies": "text[]",
                    "p_leeftijdsgroepen": "text[]",
                    "p_brand_land": "text",
                    "p_compare_prev": "boolean",
                    "p_holiday_ranges": "jsonb",
                    "p_holiday_ranges_prev": "jsonb",
                }
            elif function_name == "klantenprofiel_repeat_dashboard":
                cast_overrides = {
                    "p_year": "integer",
                    "p_brand": "text",
                    "p_bestemming_ids": "text[]",
                    "p_period": "text",
                    "p_origin": "text",
                    "p_reiziger_land": "text",
                    "p_reiziger_provincies": "text[]",
                    "p_leeftijdsgroepen": "text[]",
                    "p_brand_land": "text",
                }
            elif function_name == "klantenprofiel_traveler_origin_donut":
                cast_overrides = {
                    "p_year": "integer",
                    "p_brand": "text",
                    "p_bestemming_ids": "text[]",
                    "p_period": "text",
                    "p_origin": "text",
                    "p_reiziger_land": "text",
                    "p_reiziger_provincies": "text[]",
                    "p_leeftijdsgroepen": "text[]",
                    "p_brand_land": "text",
                    "p_holiday_ranges": "jsonb",
                    "p_effective_brand": "text",
                }
            named_parts = []
            for key, value in params.items():
                cast_type = cast_overrides.get(key)
                if cast_type:
                    named_parts.append(f"{key} := %({key})s::{cast_type}")
                else:
                    named_parts.append(f"{key} := %({key})s")
            arg_str = ", ".join(named_parts)
            sql = f"SELECT * FROM {function_name}({arg_str})"
            args = dict(params)
        try:
            rows = self._execute(sql, args)
        except Exception as exc:
            raise SupabaseServiceError(f"RPC mislukt ({function_name}): {exc}")
        if not rows:
            return []
        if isinstance(rows, list):
            return rows
        if isinstance(rows, dict):
            return [rows]
        raise SupabaseServiceError(
            f"RPC onverwacht antwoordtype ({function_name}): {type(rows).__name__}"
        )

    def annulaties_per_booking_facts(self, booking_ids: Iterable[str]) -> dict[str, dict[str, Any]]:
        """
        Per boeking: vlag meets_annulatie_criteria + annulled_travellers / annulled_revenue
        (public.annulaties_per_booking_facts). Dubbelt bij geannuleerde boeking + reizigers niet.
        """
        unique_ids = sorted({str(x).strip() for x in booking_ids if x and str(x).strip()})
        if not unique_ids:
            return {}
        try:
            rows = self.call_rpc(
                "annulaties_per_booking_facts",
                {"p_booking_ids": unique_ids},
            )
        except SupabaseServiceError:
            return {}
        out: dict[str, dict[str, Any]] = {}
        for r in rows:
            if not isinstance(r, dict):
                continue
            bid = r.get("booking_id")
            if bid is None:
                continue
            key = str(bid)
            out[key] = {
                "meets_annulatie_criteria": bool(r.get("meets_annulatie_criteria")),
                "annulled_travellers": int(r.get("annulled_travellers") or 0),
                "annulled_revenue": float(r.get("annulled_revenue") or 0),
            }
        return out

    # ----------------------------
    # Overzicht RPC (aggregaties in DB)
    # ----------------------------
    def get_overzicht_brands_rpc(self) -> list[str]:
        rows = self.call_rpc("overzicht_brands", {})
        brands: list[str] = []
        for r in rows:
            b = r.get("brand")
            if b:
                brands.append(str(b))
        return brands

    def get_overzicht_years_rpc(self, brand: str) -> list[int]:
        rows = self.call_rpc("overzicht_years", {"p_brand": brand})
        years: list[int] = []
        for r in rows:
            y = r.get("jaar")
            if y is None:
                continue
            try:
                years.append(int(y))
            except (TypeError, ValueError):
                continue
        return sorted(set(years))

    def get_overzicht_dashboard_rpc(
        self, *, brand: str, year: int, destination_id: str | None, brand_land: str = "__ALL__"
    ) -> dict[str, Any]:
        rows = self.call_rpc(
            "overzicht_dashboard",
            {
                "p_brand": brand,
                "p_destination_id": destination_id,
                "p_year": int(year),
                "p_brand_land": (brand_land or "__ALL__").strip(),
            },
        )
        if not rows:
            return {"error": "Lege RPC-response"}
        payload = rows[0].get("payload")
        if payload is None:
            # Soms kan de functie direct de jsonb teruggeven zonder payload wrapper.
            # Probeer dan het eerste veld te gebruiken.
            for v in rows[0].values():
                if isinstance(v, (dict, list)):
                    return v  # type: ignore[return-value]
            return rows[0]  # type: ignore[return-value]
        return payload

    # ----------------------------
    # Data verzameling (data explorer)
    # ----------------------------
    def get_data_verzameling_bestemmingen(self) -> list[dict[str, Any]]:
        rows = self._rest_select(
            "bestemmingen",
            select="id,naam",
            filters={},
        )
        out = []
        for r in rows:
            if r.get("id") is None or r.get("naam") is None:
                continue
            out.append({"id": str(r["id"]), "naam": str(r["naam"])})
        out.sort(key=lambda x: x["naam"])
        return out

    def get_data_verzameling_boeking_statussen(self) -> list[dict[str, Any]]:
        status_type = self._normaliseer_status_type("booking")
        rows = self._rest_select(
            "statussen",
            select="id,naam",
            filters={"type": f"eq.{status_type}"},
        )
        out = []
        for r in rows:
            if r.get("id") is None or r.get("naam") is None:
                continue
            out.append({"id": str(r["id"]), "naam": str(r["naam"])})
        out.sort(key=lambda x: x["naam"])
        return out

    def get_data_verzameling_betaling_statussen(self) -> list[dict[str, Any]]:
        status_type = self._normaliseer_status_type("payment")
        rows = self._rest_select(
            "statussen",
            select="id,naam",
            filters={"type": f"eq.{status_type}"},
        )
        out = []
        for r in rows:
            if r.get("id") is None or r.get("naam") is None:
                continue
            out.append({"id": str(r["id"]), "naam": str(r["naam"])})
        out.sort(key=lambda x: x["naam"])
        return out

    def get_data_verzameling_reiziger_statussen(self) -> list[dict[str, Any]]:
        status_type = self._normaliseer_status_type("traveller")
        rows = self._rest_select(
            "statussen",
            select="id,naam",
            filters={"type": f"eq.{status_type}"},
        )
        out = []
        for r in rows:
            if r.get("id") is None or r.get("naam") is None:
                continue
            out.append({"id": str(r["id"]), "naam": str(r["naam"])})
        out.sort(key=lambda x: x["naam"])
        return out

    def get_data_verzameling_brands(self) -> list[str]:
        # Reuse bestaande RPC: geeft alleen de merken terug die voorkomen in boekingen.
        return self.get_overzicht_brands_rpc()

    def get_data_verzameling_landen(self) -> list[str]:
        rows = self._rest_select("reizigers", select="land", filters={})
        values = sorted({str(r.get("land") or "").strip() for r in rows if str(r.get("land") or "").strip()})
        return values

    def get_data_verzameling_reiziger_landen(self) -> dict[str, Any]:
        rows = self._rest_select("reizigers", select="land", filters={})
        values: set[str] = set()
        has_unknown = False
        for r in rows:
            raw = r.get("land")
            txt = str(raw or "").strip()
            if txt:
                values.add(txt)
            else:
                has_unknown = True
        return {"values": sorted(values), "has_unknown": has_unknown}

    def get_data_verzameling_reiziger_provincies(self) -> dict[str, Any]:
        rows = self._rest_select("reizigers", select="land,provincie", filters={})
        values: set[str] = set()
        by_land: dict[str, set[str]] = {}
        has_unknown = False
        for r in rows:
            land = str(r.get("land") or "").strip()
            prov = str(r.get("provincie") or "").strip()
            if prov:
                values.add(prov)
                key = land or "__UNKNOWN__"
                by_land.setdefault(key, set()).add(prov)
            else:
                has_unknown = True
        return {
            "values": sorted(values),
            "has_unknown": has_unknown,
            "by_land": {k: sorted(v) for k, v in by_land.items()},
        }

    def get_data_verzameling_accommodatie_types(self) -> list[str]:
        rows = self._rest_select("accommodaties", select="type", filters={})
        values = sorted({str(r.get("type") or "").strip() for r in rows if str(r.get("type") or "").strip()})
        return values

    def get_data_verzameling_leveranciers(self) -> list[str]:
        rows = self._rest_select("accommodaties", select="leverancier", filters={})
        values = sorted({str(r.get("leverancier") or "").strip() for r in rows if str(r.get("leverancier") or "").strip()})
        return values

    def get_data_verzameling_excursies(self) -> list[str]:
        rows = self._rest_select("excursies", select="naam", filters={})
        values = sorted({str(r.get("naam") or "").strip() for r in rows if str(r.get("naam") or "").strip()})
        return values

    def get_data_verzameling_addons(self) -> list[str]:
        rows = self._rest_select("addons", select="naam", filters={})
        values = sorted({str(r.get("naam") or "").strip() for r in rows if str(r.get("naam") or "").strip()})
        return values

    def get_data_verzameling_accommodaties(self) -> list[dict[str, Any]]:
        rows = self._rest_select(
            "accommodaties",
            select="id,naam",
            filters={},
        )
        out = []
        for r in rows:
            if r.get("id") is None or r.get("naam") is None:
                continue
            out.append({"id": str(r["id"]), "naam": str(r["naam"])})
        out.sort(key=lambda x: x["naam"])
        return out

    def get_data_verzameling_transporten(self) -> list[dict[str, Any]]:
        rows = self._rest_select(
            "transporten",
            select="id,naam",
            filters={},
        )
        out = []
        for r in rows:
            if r.get("id") is None or r.get("naam") is None:
                continue
            out.append({"id": str(r["id"]), "naam": str(r["naam"])})
        out.sort(key=lambda x: x["naam"])
        return out

    def data_verzameling_list_rpc(
        self,
        *,
        search: str | None,
        brand: str,
        bestemming_id: str | None,
        year: int,
        status_id: str | None,
        date_kind: str,
        date_from: date | None,
        date_to: date | None,
        limit: int,
        offset: int,
    ) -> list[dict[str, Any]]:
        params = {
            "p_search": search or None,
            "p_brand": brand,
            "p_bestemming_id": bestemming_id,
            "p_year": int(year or 0),
            "p_status_id": status_id,
            # Backward-compatible voor omgevingen waar nog de oude RPC-signatuur actief is.
            "p_winstgevend": None,
            "p_date_kind": date_kind,
            "p_date_from": date_from,
            "p_date_to": date_to,
            "p_limit": int(limit),
            "p_offset": int(offset),
        }
        return self.call_rpc("data_verzameling_list", params)

    def data_verzameling_detail_rpc(self, *, booking_id: str) -> dict[str, Any]:
        params = {"p_booking_id": booking_id}
        rows = self.call_rpc("data_verzameling_detail", params)
        if not rows:
            return {"error": "Lege RPC-response"}
        payload = rows[0].get("payload")
        if payload is None:
            return rows[0]  # type: ignore[return-value]
        return payload

    def delete_data_verzameling_booking(self, *, booking_id: str) -> bool:
        bid = str(booking_id or "").strip()
        if not bid:
            raise SupabaseServiceError("booking_id is verplicht.")

        rows = self._execute(
            """
            with deleted as (
              delete from public.boekingen
              where id = %s::uuid
              returning id
            )
            select count(*)::int as deleted_count
            from deleted
            """,
            (bid,),
            fetch=True,
        )
        deleted_count = int(rows[0].get("deleted_count") or 0) if rows else 0
        return deleted_count > 0

    def update_data_verzameling_booking(
        self,
        *,
        booking_id: str,
        order_nummer: str,
        bestemming: str,
        accommodatie: str,
        accommodatie_type: str | None,
        leverancier: str | None,
        vertrekdatum: str,
        terugkeerdatum: str,
        boekingsdatum: str,
        boeking_status: str,
        betaling_status: str | None,
        aantal_reizigers: int | None,
        prepaid_bedrag: float | None,
        excursies: list[str] | None,
        addons: list[str] | None,
    ) -> dict[str, Any]:
        bid = str(booking_id or "").strip()
        if not bid:
            raise SupabaseServiceError("booking_id is verplicht.")

        current_rows = self._rest_select(
            "boekingen",
            select="id,order_nummer,vertrekdatum,terugkeerdatum,boekingsdatum",
            filters={"id": f"eq.{bid}"},
        )
        if not current_rows:
            raise SupabaseServiceError("Boeking niet gevonden.")
        current = current_rows[0]

        bestemming_name = str(bestemming or "").strip()
        accommodatie_name = str(accommodatie or "").strip()
        boeking_status_name = str(boeking_status or "").strip()
        if not bestemming_name or not accommodatie_name or not boeking_status_name:
            raise SupabaseServiceError("Bestemming, accommodatie en boekingsstatus zijn verplicht.")

        bestemming_map = self.upsert_bestemmingen([bestemming_name])
        bestemming_id = bestemming_map.get(bestemming_name)
        if not bestemming_id:
            raise SupabaseServiceError("Bestemming kon niet worden gekoppeld.")

        accommodatie_id = self.get_or_create_accommodatie(
            naam=accommodatie_name,
            bestemming_id=bestemming_id,
            accommodatie_type=(str(accommodatie_type or "").strip() or None),
            leverancier=(str(leverancier or "").strip() or None),
            cache={},
        )

        status_cache: dict[tuple[str, str], str | None] = {}
        boeking_status_id = self.get_or_create_status(
            status_type="booking",
            status_name=boeking_status_name,
            cache=status_cache,
        )
        if not boeking_status_id:
            raise SupabaseServiceError("Boekingsstatus kon niet worden gekoppeld.")

        betaling_status_id: str | None = None
        betaling_status_name = str(betaling_status or "").strip()
        if betaling_status_name:
            betaling_status_id = self.get_or_create_status(
                status_type="payment",
                status_name=betaling_status_name,
                cache=status_cache,
            )

        boeking_payload: dict[str, Any] = {
            "bestemming_id": bestemming_id,
            "accommodatie_id": accommodatie_id,
            "vertrekdatum": vertrekdatum,
            "terugkeerdatum": terugkeerdatum,
            "boekingsdatum": boekingsdatum,
            "boeking_status_id": boeking_status_id,
        }
        if order_nummer:
            boeking_payload["order_nummer"] = order_nummer
        if betaling_status_id:
            boeking_payload["betaling_status_id"] = betaling_status_id
        if aantal_reizigers is not None:
            boeking_payload["aantal_reizigers"] = int(aantal_reizigers)

        updated_rows = self._sql_update(
            "boekingen",
            self._normalize_for_json(boeking_payload),
            {"id": f"eq.{bid}"},
            returning="id,order_nummer",
        )
        if not updated_rows:
            raise SupabaseServiceError("Boeking bijwerken mislukt: lege response.")

        if prepaid_bedrag is not None:
            self._rest_upsert(
                "boeking_financien",
                [{"boeking_id": bid, "voorschot": prepaid_bedrag}],
                on_conflict="boeking_id",
            )

        vertrek_rel = self._parse_iso_date(vertrekdatum) or self._parse_iso_date(current.get("vertrekdatum"))
        terug_rel = self._parse_iso_date(terugkeerdatum) or self._parse_iso_date(current.get("terugkeerdatum"))

        if excursies is not None:
            excursie_namen = sorted({str(n).strip() for n in excursies if str(n).strip()})
            self.delete_boeking_excursies_for_booking_ids([bid])
            if excursie_namen:
                master_rows = [
                    {
                        "naam": naam,
                        "type": "Algemeen",
                        "excursie_type": "Algemeen",
                        "bestemming_id": bestemming_id,
                    }
                    for naam in excursie_namen
                ]
                excursie_map = self.upsert_excursies_master(master_rows)
                rel_rows: list[dict[str, Any]] = []
                for naam in excursie_namen:
                    norm = self._normalize_excursie_naam(naam)
                    if not norm:
                        continue
                    ex_id = excursie_map.get((norm, bestemming_id)) or excursie_map.get((norm, None))
                    if not ex_id:
                        continue
                    rel_rows.append(
                        {
                            "boeking_id": bid,
                            "excursie_id": ex_id,
                            "vertrekdatum": vertrek_rel,
                            "terugkeerdatum": terug_rel,
                        }
                    )
                if rel_rows:
                    self.insert_boeking_excursies(rel_rows)

        if addons is not None:
            addon_namen = sorted({str(n).strip() for n in addons if str(n).strip()})
            self.delete_boeking_addons_for_booking_ids([bid])
            if addon_namen:
                addon_map = self.upsert_addons_master([{"naam": naam} for naam in addon_namen])
                rel_rows = []
                for naam in addon_namen:
                    addon_id = addon_map.get(naam)
                    if not addon_id:
                        continue
                    rel_rows.append(
                        {
                            "boeking_id": bid,
                            "addon_id": addon_id,
                            "vertrekdatum": vertrek_rel,
                            "terugkeerdatum": terug_rel,
                        }
                    )
                if rel_rows:
                    self.insert_boeking_addons(rel_rows)

        return {
            "booking_id": bid,
            "order_nummer": str(updated_rows[0].get("order_nummer") or current.get("order_nummer") or ""),
        }

    def financieel_bookings_rpc(
        self,
        *,
        brand: str,
        bestemming_naam: str | None,
        land: str | None,
        year: int,
        period: str,
    ) -> dict[str, Any]:
        """
        JSON met key 'rows': lijst boekingen met financiële velden (zie sql/rpc/financieel_rpc.sql).
        PostgREST kan één object of een rij [{ functienaam: jsonb }] teruggeven — beide afhandelen.
        """
        params = {
            "p_brand": brand or "__all__",
            "p_bestemming_naam": (bestemming_naam or "").strip() or None,
            "p_land": (land or "").strip() or None,
            "p_year": int(year or 0),
            "p_period": (period or "all").strip().lower() or "all",
        }
        raw = self.call_rpc("financieel_bookings_rpc", params)
        return _unwrap_financieel_rpc_jsonb_payload(raw)

    def leveranciers_analyse_rpc(
        self,
        *,
        brand: str,
        bestemming_naam: str | None,
        land: str | None,
        year: int,
        period: str,
    ) -> dict[str, Any]:
        """
        Summary + detail voor Financiën > Leveranciers. Zie sql/rpc/leveranciers_analyse_rpc.sql.
        """
        params = {
            "p_brand": brand or "__all__",
            "p_bestemming_naam": (bestemming_naam or "").strip() or None,
            "p_land": (land or "").strip() or None,
            "p_year": int(year or 0),
            "p_period": (period or "all").strip().lower() or "all",
        }
        raw = self.call_rpc("leveranciers_analyse_rpc", params)
        return _unwrap_leveranciers_rpc_jsonb_payload(raw)

    def inzichten_verliezen_rpc(
        self,
        *,
        brand: str,
        bestemming_id: str | None,
        bestemming_naam: str | None,
        accommodatie_id: str | None = None,
        year: int = 0,
        month: int = 0,
        boekingsgrootte: str | None = None,
        heeft_kortingscode: bool | None = None,
        transport_id: str | None,
        oorzaak: str | None = None,
    ) -> dict[str, Any]:
        params = {
            "p_brand": brand or "__all__",
            "p_bestemming_id": (bestemming_id or "").strip() or None,
            "p_bestemming_naam": (bestemming_naam or "").strip() or None,
            "p_accommodatie_id": (accommodatie_id or "").strip() or None,
            "p_year": int(year or 0),
            "p_month": int(month or 0),
            "p_boekingsgrootte": (boekingsgrootte or "").strip() or None,
            "p_heeft_kortingscode": heeft_kortingscode,
            "p_transport_id": (transport_id or "").strip() or None,
            "p_oorzaak": (oorzaak or "").strip() or None,
        }
        raw = self.call_rpc("inzichten_verliezen_rpc", params)
        payload = self._unwrap_postgrest_scalar_jsonb_response(raw)
        if isinstance(payload, str):
            try:
                payload = json.loads(payload)
            except json.JSONDecodeError:
                payload = {}
        if not isinstance(payload, dict):
            return {
                "summary": {},
                "by_destination": [],
                "by_period": [],
                "by_group_size": [],
                "by_discount_code": [],
                "cost_breakdown": {},
                "rows": [],
            }
        return payload

    @staticmethod
    def _unwrap_postgrest_scalar_jsonb_response(raw: Any) -> Any:
        """
        PostgREST retourneert `returns jsonb` vaak als één rij:
        `[{ "excursies_lines_rpc": <object of string> }]`. Pak de inner waarde los
        zodat normalisatie niet afhankelijk is van die ene kolomnaam.

        Let op: `[{ "rows": [...] }]` mag niet verder worden uitgepakt — dat is al de payload.
        """
        cur: Any = raw
        for _ in range(10):
            if isinstance(cur, list) and len(cur) == 1:
                cur = cur[0]
                continue
            if isinstance(cur, dict) and len(cur) == 1:
                _k, val = next(iter(cur.items()))
                if str(_k).lower() in ("rows", "meta"):
                    break
                if val is None:
                    break
                if isinstance(val, str) and val.strip().startswith(("{", "[")):
                    try:
                        cur = json.loads(val)
                        continue
                    except json.JSONDecodeError:
                        break
                if isinstance(val, (dict, list)):
                    cur = val
                    continue
            break
        return cur

    @staticmethod
    def _normalize_excursies_lines_rpc_response(raw: Any) -> dict[str, Any]:
        """
        PostgREST kan JSONB-RPC anders serialiseren: top-level {rows, meta}, genest onder
        functienaam, of rows als niet-list. Normaliseer naar {rows: list, meta: dict}.
        """
        raw = SupabaseService._unwrap_postgrest_scalar_jsonb_response(raw)
        default_meta: dict[str, Any] = {"inkoop_incomplete": True}

        def parse_json_if_string(val: Any) -> Any:
            if isinstance(val, str) and val.strip().startswith(("{", "[")):
                try:
                    return json.loads(val)
                except json.JSONDecodeError:
                    return val
            return val

        def coerce_rows(val: Any) -> list[Any]:
            val = parse_json_if_string(val)
            if val is None:
                return []
            if isinstance(val, list):
                return val
            if isinstance(val, dict):
                return [val]
            return []

        def coerce_meta(val: Any) -> dict[str, Any]:
            val = parse_json_if_string(val)
            if isinstance(val, dict):
                return val
            return {}

        def from_payload(obj: dict[str, Any]) -> dict[str, Any] | None:
            rows_key = "rows" if "rows" in obj else ("Rows" if "Rows" in obj else None)
            if rows_key is None:
                return None
            rows = obj.get(rows_key)
            if not isinstance(rows, list):
                rows = coerce_rows(rows)
            meta = coerce_meta(obj.get("meta"))
            if not meta:
                meta = dict(default_meta)
            else:
                meta = {**default_meta, **meta}
            return {"rows": rows, "meta": meta}

        if raw is None:
            return {"rows": [], "meta": default_meta}

        candidates: list[Any]
        if isinstance(raw, dict):
            candidates = [raw]
        elif isinstance(raw, list):
            candidates = [x for x in raw if x is not None]
        else:
            return {"rows": [], "meta": default_meta}

        for item in candidates:
            if not isinstance(item, dict):
                continue
            parsed = from_payload(item)
            if parsed is not None:
                return parsed
            stack: list[Any] = list(item.values())
            while stack:
                v = stack.pop()
                v = parse_json_if_string(v)
                if isinstance(v, dict):
                    parsed = from_payload(v)
                    if parsed is not None:
                        return parsed
                    stack.extend(v.values())
                elif isinstance(v, list):
                    stack.extend(x for x in v if x is not None)

        _logger.warning(
            "excursies_lines_rpc: kon rows/meta niet parsen; raw_type=%s keys_sample=%s",
            type(raw).__name__,
            str(raw)[:500] if raw is not None else None,
        )
        return {"rows": [], "meta": default_meta}

    @staticmethod
    def _excursies_cancelled_status_exact(name: str | None) -> bool:
        """Zelfde blacklist als public.excursies_booking_status_is_cancelled (exact, lower+trim)."""
        if name is None or not str(name).strip():
            return False
        return str(name).strip().lower() in (
            "cancelled",
            "canceled",
            "cancel",
            "geannuleerd",
            "gecanceld",
            "annulatie",
            "annulering",
            "annule",
            "annulé",
            "dropped",
        )

    @staticmethod
    def _excursies_sales_channel_from_betaal(betaal: Any) -> str:
        s = str(betaal or "").lower().strip()
        if s in ("mollie", "ideal", "card"):
            return "Booking sale"
        if s in ("cash", "contant", "free", "overschrijving"):
            return "Local sale"
        if not s:
            return "Onbekend"
        return "Onbekend"

    @staticmethod
    def _parse_year_from_dateish(v: Any) -> int | None:
        if v is None:
            return None
        s = str(v).strip()
        if len(s) >= 4 and s[:4].isdigit():
            try:
                return int(s[:4])
            except ValueError:
                return None
        return None

    def _year_from_minimal_raw_row(self, r: dict[str, Any]) -> int | None:
        for k in ("vertrekdatum", "boekingsdatum", "datum_toegevoegd"):
            y = self._parse_year_from_dateish(r.get(k))
            if y is not None:
                return y
        return None

    def _filter_minimal_excursie_raw_rows(
        self,
        raw_rows: list[dict[str, Any]],
        *,
        brand: str,
        bestemming_naam: str | None,
        land: str | None,
        year: int,
        excursie_naam: str | None,
        apply_cancelled: bool,
    ) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for r in raw_rows:
            if apply_cancelled and self._excursies_cancelled_status_exact(str(r.get("booking_status") or "")):
                continue
            b = brand or "__all__"
            if b.strip() and str(b).strip().lower() not in ("", "__all__"):
                if str(r.get("brand") or "").strip().lower() != str(b).strip().lower():
                    continue
            if bestemming_naam and str(bestemming_naam).strip():
                row_destination = r.get("destination_name") if r.get("destination_name") is not None else r.get("destination")
                if str(row_destination or "") != str(bestemming_naam).strip():
                    continue
            if land and str(land).strip():
                row_land = str(r.get("land") or r.get("country") or "").strip()
                if row_land and row_land.upper() != str(land).strip().upper():
                    continue
            yq = int(year or 0)
            if yq > 0:
                yrow = self._year_from_minimal_raw_row(r)
                if yrow is None or yrow != yq:
                    continue
            if excursie_naam and str(excursie_naam).strip():
                if str(r.get("excursie_naam") or "") != str(excursie_naam).strip():
                    continue
            out.append(r)
        return out

    def _map_minimal_rpc_row_to_dashboard_row(self, r: dict[str, Any]) -> dict[str, Any]:
        vd = r.get("vertrekdatum")
        bd = r.get("boekingsdatum")
        ad = r.get("datum_toegevoegd")
        yf = None
        for vv in (vd, bd, ad):
            if vv is not None:
                yf = str(vv)[:10]
                break
        betaal = r.get("betaaloptie")
        sch = self._excursies_sales_channel_from_betaal(betaal)
        return {
            "line_id": r.get("boeking_excursie_id"),
            "booking_id": r.get("boeking_id"),
            "order_nummer": r.get("order_nummer"),
            "brand": r.get("brand"),
            "land": r.get("land") or r.get("country"),
            "destination": r.get("destination_name") or "Onbekend",
            "departure_date": str(vd)[:10] if vd is not None else None,
            "booking_date": str(bd)[:10] if bd is not None else None,
            "year_filter_date": yf,
            "booking_pax": int(r.get("booking_pax") or 0),
            "excursie_naam": r.get("excursie_naam"),
            "excursie_type": r.get("excursie_type") or "",
            "verkoop_prijs": float(r.get("verkoop_prijs") or r.get("verkoopprijs") or 0),
            "is_gratis": bool(r.get("is_gratis")) if r.get("is_gratis") is not None else False,
            "kostjaar": r.get("kostjaar"),
            "inkoop_prijs": r.get("inkoop_prijs"),
            "inkoopprijs_ingegeven": r.get("inkoopprijs_ingegeven"),
            "commissie": r.get("commissie"),
            "commissie_percentage": r.get("commissie_percentage"),
            "berekende_commissie": r.get("berekende_commissie"),
            "jaarkosten_gevonden": r.get("jaarkosten_gevonden"),
            "totale_kost": r.get("totale_kost"),
            "marge": r.get("marge"),
            "marge_percentage": r.get("marge_percentage"),
            "betaling_pending": r.get("betaling_pending"),
            "betaaloptie": betaal,
            "mollie_betaling_id": r.get("mollie_betaling_id"),
            "geboekt_in_online_account": r.get("geboekt_in_online_account"),
            "datum_toegevoegd": str(ad) if ad is not None else None,
            "sales_channel": sch,
            "booking_status": r.get("booking_status") or "",
        }

    def _excursies_lines_try_minimal_rpc_fallback(
        self,
        *,
        brand: str,
        bestemming_naam: str | None,
        land: str | None,
        year: int,
        excursie_naam: str | None,
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        raw_min = self.call_rpc("excursies_lines_rpc", {})
        _logger.info("excursies_lines_rpc minimal overload raw_len=%s", len(raw_min))
        norm = self._normalize_excursies_lines_rpc_response(raw_min)
        row_list: list[dict[str, Any]] = [x for x in (norm.get("rows") or []) if isinstance(x, dict)]
        if not row_list and raw_min and all(isinstance(x, dict) for x in raw_min):
            row_list = [x for x in raw_min if isinstance(x, dict)]
        filtered = self._filter_minimal_excursie_raw_rows(
            row_list,
            brand=brand,
            bestemming_naam=bestemming_naam,
            land=land,
            year=int(year or 0),
            excursie_naam=excursie_naam,
            apply_cancelled=True,
        )
        mapped = [self._map_minimal_rpc_row_to_dashboard_row(x) for x in filtered]
        meta: dict[str, Any] = {
            "inkoop_incomplete": True,
            "sales_channel_heuristic": True,
            "fallback": "minimal_rpc_filtered",
            "year_filter_basis": "coalesce(vertrekdatum, boekingsdatum, datum_toegevoegd) — Python-filter na minimale RPC",
            "cancellation_rule": "alleen boekingstatus-blacklist (RPC filter regelt reizigers)",
        }
        return mapped, meta

    def _excursies_lines_try_rest_embed_fallback(
        self,
        *,
        brand: str,
        bestemming_naam: str | None,
        land: str | None,
        year: int,
        excursie_naam: str | None,
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        try:
            rows = self._rest_select(
                "boeking_excursies",
                select=(
                    "id,boeking_id,excursie_id,datum_toegevoegd,vertrekdatum,terugkeerdatum,verkoopprijs,is_gratis,betaling_pending,betaaloptie,"
                    "mollie_betaling_id,geboekt_in_online_account,"
                    "boekingen(id,order_nummer,brand,vertrekdatum,boekingsdatum,aantal_reizigers,bestemming_id,boeking_status_id),"
                    "excursies(id,naam,prijs,inkoopprijs,commissie,commissie_percentage,excursie_type,type)"
                ),
                filters={},
            )
        except SupabaseServiceError as exc:
            _logger.warning("excursies_lines REST embed fallback mislukt: %s", exc)
            return [], {}

        flat: list[dict[str, Any]] = []
        for bex in rows:
            if not isinstance(bex, dict):
                continue
            bk = bex.get("boekingen")
            if isinstance(bk, list) and bk:
                bk = bk[0]
            ex = bex.get("excursies")
            if isinstance(ex, list) and ex:
                ex = ex[0]
            if not isinstance(bk, dict) or not isinstance(ex, dict):
                continue
            st_id = bk.get("boeking_status_id")
            booking_status = ""
            if st_id:
                try:
                    st_rows = self._rest_select(
                        "statussen",
                        select="id,naam",
                        filters={"id": f"eq.{st_id}"},
                    )
                    if st_rows and isinstance(st_rows[0], dict):
                        booking_status = str(st_rows[0].get("naam") or "")
                except SupabaseServiceError:
                    booking_status = ""
            dest_name = "Onbekend"
            bid = bk.get("bestemming_id")
            if bid:
                try:
                    drows = self._rest_select(
                        "bestemmingen",
                        select="id,naam",
                        filters={"id": f"eq.{bid}"},
                    )
                    if drows and isinstance(drows[0], dict):
                        dest_name = str(drows[0].get("naam") or "Onbekend")
                except SupabaseServiceError:
                    pass
            verkoop = float(bex.get("verkoopprijs") or ex.get("prijs") or 0)
            commissie = ex.get("commissie")
            commissie_pct = ex.get("commissie_percentage")
            commissie_bedrag = (
                float(commissie)
                if commissie is not None
                else float(verkoop * float(commissie_pct or 0) / 100.0)
            )
            inkoop = float(ex.get("inkoopprijs")) if ex.get("inkoopprijs") is not None else max(verkoop - commissie_bedrag, 0)
            totale_kost = inkoop + commissie_bedrag
            marge = verkoop - totale_kost
            raw_like = {
                "boeking_excursie_id": str(bex.get("id") or ""),
                "boeking_id": str(bex.get("boeking_id") or ""),
                "excursie_id": str(bex.get("excursie_id") or ""),
                "order_nummer": str(bk.get("order_nummer") or ""),
                "excursie_naam": ex.get("naam"),
                "boekingsdatum": bk.get("boekingsdatum"),
                "vertrekdatum": bk.get("vertrekdatum"),
                "datum_toegevoegd": bex.get("datum_toegevoegd"),
                "brand": bk.get("brand"),
                "land": None,
                "destination_name": dest_name,
                "excursie_type": str(ex.get("excursie_type") or ex.get("type") or ""),
                "verkoop_prijs": verkoop,
                "is_gratis": bool(bex.get("is_gratis")) if bex.get("is_gratis") is not None else verkoop == 0,
                "kostjaar": self._year_from_minimal_raw_row(
                    {
                        "vertrekdatum": bex.get("vertrekdatum"),
                        "boekingsdatum": bk.get("boekingsdatum"),
                    }
                ),
                "inkoop_prijs": inkoop,
                "inkoopprijs_ingegeven": False,
                "commissie": commissie_bedrag,
                "commissie_percentage": commissie_pct,
                "berekende_commissie": 0.0,
                "jaarkosten_gevonden": False,
                "totale_kost": totale_kost,
                "marge": marge,
                "marge_percentage": ((marge / verkoop) * 100.0) if verkoop else None,
                "booking_pax": int(bk.get("aantal_reizigers") or 0),
                "betaling_pending": bex.get("betaling_pending"),
                "betaaloptie": bex.get("betaaloptie"),
                "mollie_betaling_id": bex.get("mollie_betaling_id"),
                "geboekt_in_online_account": bex.get("geboekt_in_online_account"),
                "booking_status": booking_status,
            }
            flat.append(raw_like)

        filtered = self._filter_minimal_excursie_raw_rows(
            flat,
            brand=brand,
            bestemming_naam=bestemming_naam,
            land=land,
            year=int(year or 0),
            excursie_naam=excursie_naam,
            apply_cancelled=True,
        )
        mapped = [self._map_minimal_rpc_row_to_dashboard_row(x) for x in filtered]
        meta: dict[str, Any] = {
            "inkoop_incomplete": True,
            "sales_channel_heuristic": True,
            "fallback": "rest_embed_filtered",
            "year_filter_basis": "coalesce(vertrekdatum, boekingsdatum, datum_toegevoegd) — Python na REST",
        }
        return mapped, meta

    def excursies_lines_rpc(
        self,
        *,
        brand: str,
        bestemming_naam: str | None,
        land: str | None,
        year: int,
        excursie_naam: str | None,
        exc_debug: bool = False,
    ) -> dict[str, Any]:
        """
        JSON met keys 'rows' (lijst excursieregels) en 'meta' (zie sql/rpc/excursies_rpc.sql).
        Fallbacks worden alleen gebruikt bij echte RPC-fouten/ongeldige payloads.
        Een geldige response met 0 rijen blijft 0 rijen (geen fallback).
        """
        t0 = time.perf_counter()
        _logger.info("excursies_lines_rpc called")
        params = {
            "p_brand": brand or "__all__",
            "p_bestemming_naam": (bestemming_naam or "").strip() or None,
            "p_land": (land or "").strip() or None,
            "p_year": int(year or 0),
            "p_excursie_naam": (excursie_naam or "").strip() or None,
        }
        _logger.info("excursies_lines_rpc params=%s", params)
        raw = None
        used_fallback = False
        try:
            rpc_t0 = time.perf_counter()
            raw = self.call_rpc("excursies_lines_rpc", params)
            _logger.info("excursies_lines_rpc rpc_ms=%s", int((time.perf_counter() - rpc_t0) * 1000))
        except SupabaseServiceError as exc:
            # Backward compatibility while environments still run the older 5-arg RPC signature.
            if "PGRST202" in str(exc) or "Could not find the function" in str(exc):
                legacy_params = {
                    "p_brand": params["p_brand"],
                    "p_bestemming_naam": params["p_bestemming_naam"],
                    "p_year": params["p_year"],
                    "p_excursie_naam": params["p_excursie_naam"],
                }
                _logger.warning("excursies_lines_rpc retry legacy signature params=%s", legacy_params)
                try:
                    used_fallback = True
                    raw = self.call_rpc("excursies_lines_rpc", legacy_params)
                except SupabaseServiceError:
                    legacy_params_v2 = {**legacy_params, "p_excursie_type": None}
                    _logger.warning("excursies_lines_rpc retry legacy v2 params=%s", legacy_params_v2)
                    used_fallback = True
                    raw = self.call_rpc("excursies_lines_rpc", legacy_params_v2)
            else:
                raise
        out = self._normalize_excursies_lines_rpc_response(raw)
        rows_out = out.get("rows") if isinstance(out.get("rows"), list) else []
        _logger.info("excursies_lines_rpc rows_count=%s", len(rows_out))
        if exc_debug:
            meta = out.setdefault("meta", {})
            if isinstance(meta, dict):
                meta["debug_rpc"] = {
                    "postgrest_params": params,
                    "raw_response_type": type(raw).__name__,
                    "raw_response_preview": str(raw)[:4000] if raw is not None else None,
                    "normalized_row_count": len(rows_out),
                }
        _logger.info(
            "excursies_lines_rpc done rows=%s duration_ms=%s fallback=%s",
            len(rows_out),
            int((time.perf_counter() - t0) * 1000),
            used_fallback,
        )
        return out

    def insights_dashboard_rpc(
        self,
        *,
        brand: str,
        bestemming_naam: str | None,
        land: str | None,
        year: int,
        period: str,
        segment: str | None,
        age_category: str | None,
    ) -> dict[str, Any]:
        """
        JSON met keys 'rows' (gefilterde boekingen) en 'identity_rows' (compact, voor repeat/new).
        Zie sql/rpc/insights_rpc.sql — geannuleerde boekingen uitgesloten in SQL.
        """
        params = {
            "p_brand": brand or "__all__",
            "p_bestemming_naam": (bestemming_naam or "").strip() or None,
            "p_land": (land or "").strip() or None,
            "p_year": int(year or 0),
            "p_period": (period or "all").strip().lower() or "all",
            "p_segment": (segment or "").strip() or None,
            "p_age_category": (age_category or "").strip() or None,
        }
        raw = self.call_rpc("insights_dashboard_rpc", params)
        return self._normalize_insights_dashboard_payload(raw)

    @staticmethod
    def _normalize_insights_dashboard_payload(raw: Any) -> dict[str, Any]:
        empty: dict[str, Any] = {"rows": [], "identity_rows": []}
        if raw is None:
            return empty
        if isinstance(raw, dict):
            if "rows" in raw and isinstance(raw.get("rows"), list):
                idrows = raw.get("identity_rows")
                if not isinstance(idrows, list):
                    idrows = []
                return {"rows": raw.get("rows") or [], "identity_rows": idrows}
            for v in raw.values():
                if isinstance(v, dict) and "rows" in v and isinstance(v.get("rows"), list):
                    idrows = v.get("identity_rows")
                    if not isinstance(idrows, list):
                        idrows = []
                    return {"rows": v.get("rows") or [], "identity_rows": idrows}
            return empty
        if not isinstance(raw, list) or not raw:
            return empty
        first = raw[0]
        if isinstance(first, dict):
            if "rows" in first and isinstance(first.get("rows"), list):
                idrows = first.get("identity_rows")
                if not isinstance(idrows, list):
                    idrows = []
                return {"rows": first.get("rows") or [], "identity_rows": idrows}
            for v in first.values():
                if isinstance(v, dict) and "rows" in v and isinstance(v.get("rows"), list):
                    idrows = v.get("identity_rows")
                    if not isinstance(idrows, list):
                        idrows = []
                    return {"rows": v.get("rows") or [], "identity_rows": idrows}
        return empty

    def get_excursies_master_for_filters(self) -> list[dict[str, Any]]:
        """
        Unieke Excursies-filteropties uit masterdata (naam + bestemming).
        `filter_key` blijft stabiel op basis van naam + bestemminglabel.
        """
        rows = self.get_excursies_for_management()
        out: list[dict[str, Any]] = []
        seen: set[str] = set()
        for r in rows:
            naam = str(r.get("naam") or "").strip()
            if not naam:
                continue
            bestemming_naam = str(r.get("bestemming_naam") or "").strip()
            filter_key = f"{naam}\u0001{bestemming_naam}" if bestemming_naam else naam
            if filter_key in seen:
                continue
            seen.add(filter_key)
            label = f"{naam} · {bestemming_naam}" if bestemming_naam else naam
            out.append(
                {
                    "filter_key": filter_key,
                    "naam": naam,
                    "bestemming_naam": bestemming_naam or None,
                    "label": label,
                }
            )
        out.sort(key=lambda x: str(x.get("label") or "").lower())
        return out

    def _majority_bestemming_naam_per_excursie_from_bookings(
        self, excursie_ids: list[str]
    ) -> dict[str, str]:
        """
        Voor excursies zonder bestemming_id: leid een weergavenaam af uit gekoppelde boekingen
        (meeste boekingen per bestemming_id). Alleen voor UI-fallback als sync nog niet gedraaid is.
        """
        if not excursie_ids:
            return {}
        counts: dict[str, Counter[str]] = defaultdict(Counter)
        step = 200
        for i in range(0, len(excursie_ids), step):
            chunk = excursie_ids[i : i + step]
            in_list = ",".join(chunk)
            try:
                bex_rows = self._rest_select(
                    "boeking_excursies",
                    select="excursie_id,boekingen(bestemming_id)",
                    filters={"excursie_id": f"in.({in_list})"},
                )
            except SupabaseServiceError:
                continue
            for row in bex_rows:
                if not isinstance(row, dict):
                    continue
                ex_id = str(row.get("excursie_id") or "")
                if not ex_id:
                    continue
                bk = row.get("boekingen")
                if isinstance(bk, list) and bk:
                    bk = bk[0]
                if not isinstance(bk, dict):
                    continue
                bid = bk.get("bestemming_id")
                if not bid:
                    continue
                counts[ex_id][str(bid)] += 1
        winner_bid: dict[str, str] = {}
        for ex_id, ctr in counts.items():
            if not ctr:
                continue
            winner_bid[ex_id] = ctr.most_common(1)[0][0]
        names_map = self._bestemming_names_map(list(winner_bid.values()))
        out: dict[str, str] = {}
        for ex_id, bid in winner_bid.items():
            nm = names_map.get(bid)
            if nm:
                out[ex_id] = nm
        return out

    def sync_excursies_bestemming_from_bookings(self, excursie_ids: list[str] | None = None) -> int:
        """
        Zet excursies.bestemming_id via DB-RPC (meerderheid onder gekoppelde boekingen).
        excursie_ids None of leeg: alle excursies met boeking-koppelingen bijwerken.
        """
        if excursie_ids is not None and len(excursie_ids) == 0:
            return 0
        params: dict[str, Any] = {"p_excursie_ids": excursie_ids}
        rows = self.call_rpc("excursies_sync_bestemming_from_bookings", params)
        if not rows:
            return 0
        raw = rows[0].get("updated") if isinstance(rows[0], dict) else None
        if raw is None and isinstance(rows[0], dict):
            # jsonb kan direct als object keys hebben
            first = rows[0]
            if len(first) == 1:
                raw = next(iter(first.values()))
        try:
            return int(raw) if raw is not None else 0
        except (TypeError, ValueError):
            return 0

    def get_excursies_for_management(self) -> list[dict[str, Any]]:
        """
        Volledige excursielijst voor beheer (aanmaken/aanvullen in UI).
        `prijs` is verkoopprijs.
        """
        try:
            rows = self._rest_select(
                "excursies",
                select="id,naam,normalized_naam,type,excursie_type,prijs,inkoopprijs,commissie,commissie_percentage,bestemming_id",
                filters={},
            )
        except SupabaseServiceError:
            return []
        latest_kost_by_excursie: dict[str, dict[str, Any]] = {}
        try:
            jaarkosten_rows = self._rest_select(
                "excursie_jaarkosten",
                select="excursie_id,jaar,inkoopprijs,commissie,commissie_percentage,is_handmatig",
                filters={},
            )
            for jr in jaarkosten_rows:
                exc_id = str(jr.get("excursie_id") or "")
                if not exc_id:
                    continue
                if not bool(jr.get("is_handmatig")):
                    continue
                try:
                    jaar = int(jr.get("jaar"))
                except (TypeError, ValueError):
                    continue
                existing = latest_kost_by_excursie.get(exc_id)
                if existing is None or int(existing.get("jaar", -1)) < jaar:
                    latest_kost_by_excursie[exc_id] = {
                        "jaar": jaar,
                        "inkoopprijs": jr.get("inkoopprijs"),
                        "commissie": jr.get("commissie"),
                        "commissie_percentage": jr.get("commissie_percentage"),
                    }
        except SupabaseServiceError:
            latest_kost_by_excursie = {}
        rows_out: list[dict[str, Any]] = []
        for r in rows:
            exc_id = r.get("id")
            naam = (r.get("naam") or "").strip() if isinstance(r.get("naam"), str) else r.get("naam")
            if not exc_id or not naam:
                continue
            kost = latest_kost_by_excursie.get(str(exc_id), {})
            rows_out.append(
                {
                    "id": str(exc_id),
                    "naam": str(naam),
                    "normalized_naam": self._normalize_excursie_naam(naam),
                    "type": (r.get("type") or "") if isinstance(r.get("type"), str) else r.get("type"),
                    "excursie_type": (r.get("excursie_type") or "") if isinstance(r.get("excursie_type"), str) else r.get("excursie_type"),
                    "verkoopprijs": r.get("prijs"),
                    "inkoopprijs": kost.get("inkoopprijs", r.get("inkoopprijs")),
                    "commissie": kost.get("commissie", r.get("commissie")),
                    "commissie_percentage": kost.get("commissie_percentage", r.get("commissie_percentage")),
                    "kostjaar": kost.get("jaar"),
                    "bestemming_id": str(r.get("bestemming_id")) if r.get("bestemming_id") else None,
                }
            )
        rows_out.sort(key=lambda x: (str(x.get("naam") or "").lower(), str(x.get("id") or "")))

        bid_list = [str(x["bestemming_id"]) for x in rows_out if x.get("bestemming_id")]
        names_by_id = self._bestemming_names_map(bid_list)
        need_fallback_ids = [x["id"] for x in rows_out if not x.get("bestemming_id")]
        fallback_naam = (
            self._majority_bestemming_naam_per_excursie_from_bookings(need_fallback_ids)
            if need_fallback_ids
            else {}
        )

        for x in rows_out:
            bid = x.get("bestemming_id")
            if bid:
                x["bestemming_naam"] = names_by_id.get(str(bid))
            else:
                x["bestemming_naam"] = fallback_naam.get(str(x["id"]))

        still_no_naam = [x["id"] for x in rows_out if not x.get("bestemming_naam")]
        if still_no_naam:
            extra_naam = self._majority_bestemming_naam_per_excursie_from_bookings(still_no_naam)
            for x in rows_out:
                if not x.get("bestemming_naam"):
                    x["bestemming_naam"] = extra_naam.get(str(x["id"]))

        return rows_out

    def create_excursie(
        self,
        *,
        naam: str,
        bestemming_id: str | None,
        verkoopprijs: float,
        inkoopprijs: float | None,
        commissie: float | None,
        commissie_percentage: float | None,
        excursie_type: str | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "naam": naam,
            "prijs": verkoopprijs,
            # Historisch veld `type` blijft bestaan; we synchroniseren met excursie_type.
            "type": (excursie_type or "").strip() or "Algemeen",
            "excursie_type": (excursie_type or "").strip() or "Algemeen",
            "bestemming_id": bestemming_id,
            "inkoopprijs": inkoopprijs,
            "commissie": commissie,
            "commissie_percentage": commissie_percentage,
        }
        rows = self._sql_insert("excursies", [self._normalize_for_json(payload)])
        if not rows:
            raise SupabaseServiceError("Excursie aanmaken mislukt: lege response")
        return rows[0]

    def update_excursie_pricing(
        self,
        *,
        excursie_id: str,
        verkoopprijs: float | None,
        inkoopprijs: float | None,
        commissie: float | None,
        commissie_percentage: float | None,
        jaar: int | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "prijs": verkoopprijs,
            "inkoopprijs": inkoopprijs,
            "commissie": commissie,
            "commissie_percentage": commissie_percentage,
        }
        rows = self._sql_update(
            "excursies",
            self._normalize_for_json(payload),
            {"id": f"eq.{excursie_id}"},
            returning="id,naam,prijs,inkoopprijs,commissie,commissie_percentage",
        )
        if not rows:
            raise SupabaseServiceError("Excursie bijwerken mislukt: excursie niet gevonden")
        updated = rows[0]

        # Nieuwe bron voor kostenstructuur: excursie_jaarkosten (1 record per excursie+jaar).
        # We houden legacy excursies.* ook nog in sync als fallback voor oudere query-paden.
        kostjaar = int(jaar) if jaar is not None else datetime.now().year
        try:
            self._rest_upsert(
                "excursie_jaarkosten",
                [
                    {
                        "excursie_id": excursie_id,
                        "jaar": kostjaar,
                        "inkoopprijs": inkoopprijs,
                        "commissie": commissie,
                        "commissie_percentage": commissie_percentage,
                        "is_handmatig": True,
                    }
                ],
                on_conflict="excursie_id,jaar",
            )
            updated["kostjaar"] = kostjaar
            updated["inkoopprijs_ingegeven"] = True
        except SupabaseServiceError:
            # Backward-compat: omgevingen zonder `is_handmatig`.
            try:
                self._rest_upsert(
                    "excursie_jaarkosten",
                    [
                        {
                            "excursie_id": excursie_id,
                            "jaar": kostjaar,
                            "inkoopprijs": inkoopprijs,
                            "commissie": commissie,
                            "commissie_percentage": commissie_percentage,
                        }
                    ],
                    on_conflict="excursie_id,jaar",
                )
                updated["kostjaar"] = kostjaar
                updated["inkoopprijs_ingegeven"] = True
            except SupabaseServiceError:
                # Niet hard-failen zolang niet elke omgeving de nieuwe tabel al heeft.
                pass
        return updated

    def get_bestemmingen_data_rpc(
        self,
        *,
        brand: str,
        destination_id: str | None,
        date_from: str | None,
        date_to: str | None,
        year: int,
    ) -> dict[str, Any]:
        rows = self.call_rpc(
            "bestemmingen_data_rpc",
            {
                "p_brand": brand,
                "p_destination_id": destination_id,
                "p_date_from": date_from,
                "p_date_to": date_to,
                "p_year": int(year or 0),
            },
        )
        if not rows:
            return {"error": "Lege RPC-response"}
        payload = rows[0].get("payload")
        if payload is None:
            return rows[0]  # type: ignore[return-value]
        return payload

    def get_bestemmingen_dashboard_rpc(
        self,
        *,
        brand: str,
        destination_id: str | None,
        date_from: str | None,
        date_to: str | None,
        year: int,
        search: str | None,
        sort: str,
        sort_dir: str,
        page: int,
        page_size: int,
        region: str | None = None,
        audience: str | None = None,
        category: str | None = None,
        season: str | None = None,
    ) -> dict[str, Any]:
        rows = self.call_rpc(
            "bestemmingen_dashboard_rpc",
            {
                "p_brand": brand,
                "p_destination_id": destination_id,
                "p_date_from": date_from,
                "p_date_to": date_to,
                "p_year": int(year or 0),
                "p_search": search or None,
                "p_sort": sort or "bookings",
                "p_sort_dir": sort_dir or "desc",
                "p_page": int(page or 1),
                "p_page_size": int(page_size or 25),
                "p_region": region or None,
                "p_audience": audience or None,
                "p_category": category or None,
                "p_season": season or None,
            },
        )
        if not rows:
            return {"error": "Lege RPC-response"}
        payload = rows[0].get("payload")
        if payload is None:
            return rows[0]  # type: ignore[return-value]
        return payload

    # ----------------------------
    # Tijdsvergelijkingen (BI)
    # ----------------------------
    def tijdsvergelijkingen_years_rpc(self, *, date_type: str, brand: str, bestemming_ids: list[str]) -> list[int]:
        params = {
            "p_date_type": date_type,
            "p_brand": brand,
            "p_bestemming_ids": bestemming_ids,
        }
        rows = self.call_rpc("tijdsvergelijkingen_years", params)
        years: list[int] = []
        for r in rows:
            if not isinstance(r, dict):
                continue
            y = r.get("jaar")
            if y is None:
                continue
            try:
                years.append(int(y))
            except (TypeError, ValueError):
                continue
        return sorted(set(years))

    def tijdsvergelijkingen_data_rpc(
        self,
        *,
        date_type: str,
        period: str,
        current_year: int,
        compare_year: int,
        bestemming_ids: list[str],
        brand: str,
        kpi: str,
        date_from: str | None,
        date_to: str | None,
    ) -> dict[str, Any]:
        df = (date_from or "").strip()[:10] or None
        dt = (date_to or "").strip()[:10] or None
        params = {
            "p_date_type": date_type,
            "p_period": period,
            "p_current_year": current_year,
            "p_compare_year": compare_year,
            "p_bestemming_ids": bestemming_ids,
            "p_brand": brand,
            "p_kpi": kpi,
            "p_date_from": df,
            "p_date_to": dt,
        }
        rows = self.call_rpc("tijdsvergelijkingen_data", params)
        if not rows:
            return {"error": "Lege RPC-response"}
        payload = rows[0].get("payload")
        if payload is None:
            return rows[0]  # type: ignore[return-value]
        return payload

    @staticmethod
    def _parse_iso_date(value: Any) -> date | None:
        if value is None:
            return None
        if isinstance(value, date):
            return value
        s = str(value).strip()
        if not s:
            return None
        try:
            # PostgREST date columns typically return 'YYYY-MM-DD'.
            return date.fromisoformat(s[:10])
        except Exception:  # noqa: BLE001
            return None

    def _upsert_naam_lookup(self, table: str, names: Iterable[str]) -> dict[str, str]:
        """
        Upsert lookup-tabel met enkel `naam` (UNIQUE). ON CONFLICT DO NOTHING returnt
        bestaande rijen niet via RETURNING, dus halen we ze in 1 extra parametrized
        SELECT erbij. Daarmee is de mapping altijd compleet voor alle aangeleverde namen.
        """
        names_set = {n for n in names if n}
        if not names_set:
            return {}

        rows = [{"naam": n} for n in names_set]
        resp_rows = self._rest_upsert(table, rows, on_conflict="naam")
        mapping: dict[str, str] = {str(r["naam"]): str(r["id"]) for r in resp_rows}

        missing = [n for n in names_set if n not in mapping]
        if missing:
            placeholders = ",".join(["%s"] * len(missing))
            sql = f'SELECT id, naam FROM "{table}" WHERE "naam" IN ({placeholders})'
            try:
                resp2 = self._execute(sql, tuple(missing))
            except Exception as exc:
                raise SupabaseServiceError(f"Lookup mislukt ({table}): {exc}")
            mapping.update({str(r["naam"]): str(r["id"]) for r in resp2})
        return mapping

    def upsert_bestemmingen(self, names: Iterable[str]) -> dict[str, str]:
        return self._upsert_naam_lookup("bestemmingen", names)

    def upsert_doelgroepen(self, names: Iterable[str]) -> dict[str, str]:
        return self._upsert_naam_lookup("doelgroepen", names)

    def upsert_transporten(self, names: Iterable[str]) -> dict[str, str]:
        return self._upsert_naam_lookup("transporten", names)

    def get_or_create_accommodatie(
        self,
        *,
        naam: str,
        bestemming_id: str,
        accommodatie_type: str | None,
        leverancier: str | None,
        cache: dict[tuple[str, str], str],
    ) -> str:
        cache_key = (naam, bestemming_id)
        if cache_key in cache:
            return cache[cache_key]

        matches = self._rest_select(
            "accommodaties",
            select="id,naam,type,leverancier,bestemming_id",
            filters={"naam": f"eq.{naam}", "bestemming_id": f"eq.{bestemming_id}"},
        )
        if matches:
            accom_id = str(matches[0]["id"])
            update_payload: dict[str, Any] = {}
            if accommodatie_type is not None:
                update_payload["type"] = accommodatie_type
            if leverancier is not None:
                update_payload["leverancier"] = leverancier
            if update_payload:
                self._sql_update("accommodaties", update_payload, {"id": f"eq.{accom_id}"}, returning="")
            cache[cache_key] = accom_id
            return accom_id

        payload: dict[str, Any] = {
            "naam": naam,
            "type": accommodatie_type,
            "leverancier": leverancier,
            "bestemming_id": bestemming_id,
        }
        try:
            rows = self._sql_insert("accommodaties", [payload])
        except SupabaseServiceError:
            retry_matches = self._rest_select(
                "accommodaties",
                select="id,naam,type,leverancier,bestemming_id",
                filters={"naam": f"eq.{naam}", "bestemming_id": f"eq.{bestemming_id}"},
            )
            if retry_matches:
                accom_id = str(retry_matches[0]["id"])
                cache[cache_key] = accom_id
                return accom_id
            raise
        if not rows:
            retry_matches = self._rest_select(
                "accommodaties",
                select="id,naam,type,leverancier,bestemming_id",
                filters={"naam": f"eq.{naam}", "bestemming_id": f"eq.{bestemming_id}"},
            )
            if retry_matches:
                accom_id = str(retry_matches[0]["id"])
                cache[cache_key] = accom_id
                return accom_id
            raise SupabaseServiceError("Accommodatie aanmaken mislukt: geen response.")
        accom_id = str(rows[0]["id"])
        cache[cache_key] = accom_id
        return accom_id

    def get_or_create_status(
        self,
        *,
        status_type: str,
        status_name: str,
        cache: dict[tuple[str, str], str | None],
    ) -> str | None:
        if not status_name:
            return None
        status_type = self._normaliseer_status_type(status_type)
        cache_key = (status_type, status_name)
        if cache_key in cache:
            return cache[cache_key]

        matches = self._rest_select(
            "statussen",
            select="id,naam,type",
            filters={"type": f"eq.{status_type}", "naam": f"eq.{status_name}"},
        )
        if matches:
            status_id = str(matches[0]["id"])
            cache[cache_key] = status_id
            return status_id

        payload = {"type": status_type, "naam": status_name}
        rows = self._sql_insert("statussen", [payload])
        if not rows:
            cache[cache_key] = None
            return None
        status_id = str(rows[0]["id"])
        cache[cache_key] = status_id
        return status_id

    # ------------------------------------------------------------------
    # Bulk lookup-helpers voor de upload-flow.
    # Vervangt per-rij `get_or_create_*` (N round-trips) door 2 round-trips
    # in totaal: 1 SELECT voor bestaande rijen + 1 INSERT voor missende.
    # ------------------------------------------------------------------
    def bulk_load_statussen(
        self,
        pairs: Iterable[tuple[str, str]],
        cache: dict[tuple[str, str], str | None],
    ) -> None:
        """Vul `cache` met (type, naam) → id in twee round-trips.

        - Eerste round-trip: SELECT alle bestaande paren in één query.
        - Tweede round-trip: bulk INSERT ... ON CONFLICT DO NOTHING + RETURNING
          voor missende paren. `statussen` heeft `unique (type, naam)`.
        """
        normalized: list[tuple[str, str]] = []
        seen: set[tuple[str, str]] = set()
        for st_type, naam in pairs:
            if not naam:
                continue
            t = self._normaliseer_status_type(st_type)
            key = (t, naam)
            if key in cache or key in seen:
                continue
            seen.add(key)
            normalized.append(key)
        if not normalized:
            return

        # SELECT bestaande
        placeholders = ", ".join(["(%s, %s)"] * len(normalized))
        params: list[Any] = []
        for t, n in normalized:
            params.extend([t, n])
        sql_select = (
            'SELECT id, type, naam FROM "statussen" '
            f"WHERE (type, naam) IN ({placeholders})"
        )
        existing = self._execute(sql_select, tuple(params))
        for row in existing:
            cache[(str(row["type"]), str(row["naam"]))] = str(row["id"])

        # Bulk INSERT voor wat nog ontbreekt
        missing = [k for k in normalized if k not in cache]
        if not missing:
            return
        rows_to_insert = [{"type": t, "naam": n} for t, n in missing]
        try:
            self._rest_upsert(
                "statussen",
                rows_to_insert,
                on_conflict="type,naam",
                return_representation=False,
            )
        except SupabaseServiceError:
            # Fallback: één-voor-één via bestaande helper.
            for t, n in missing:
                self.get_or_create_status(status_type=t, status_name=n, cache=cache)
            return

        # Haal de nieuw aangemaakte IDs in één extra SELECT op.
        placeholders = ", ".join(["(%s, %s)"] * len(missing))
        params = []
        for t, n in missing:
            params.extend([t, n])
        rows2 = self._execute(
            'SELECT id, type, naam FROM "statussen" '
            f"WHERE (type, naam) IN ({placeholders})",
            tuple(params),
        )
        for row in rows2:
            cache[(str(row["type"]), str(row["naam"]))] = str(row["id"])

    def bulk_load_accommodaties(
        self,
        items: Iterable[tuple[str, str, str | None, str | None]],
        cache: dict[tuple[str, str], str],
    ) -> None:
        """Vul `cache` met (naam, bestemming_id) → id in twee round-trips.

        `items` zijn tuples (naam, bestemming_id, type, leverancier). De tabel
        heeft géén unique constraint op (naam, bestemming_id), dus we doen
        SELECT-then-INSERT in plaats van ON CONFLICT.
        """
        unique: dict[tuple[str, str], tuple[str | None, str | None]] = {}
        for naam, bestemming_id, accom_type, leverancier in items:
            if not (naam and bestemming_id):
                continue
            key = (naam, bestemming_id)
            if key in cache:
                continue
            # Eerste niet-null type/leverancier wint.
            cur = unique.get(key)
            if cur is None:
                unique[key] = (accom_type, leverancier)
            else:
                cur_t, cur_l = cur
                unique[key] = (
                    cur_t if cur_t is not None else accom_type,
                    cur_l if cur_l is not None else leverancier,
                )
        if not unique:
            return

        keys = list(unique.keys())
        placeholders = ", ".join(["(%s, %s)"] * len(keys))
        params: list[Any] = []
        for n, b in keys:
            params.extend([n, b])
        sql_select = (
            'SELECT id, naam, bestemming_id FROM "accommodaties" '
            f"WHERE (naam, bestemming_id) IN ({placeholders})"
        )
        existing = self._execute(sql_select, tuple(params))
        for row in existing:
            k = (str(row["naam"]), str(row["bestemming_id"]))
            cache[k] = str(row["id"])

        missing_keys = [k for k in keys if k not in cache]
        if not missing_keys:
            return

        # Bulk INSERT met execute_values; krijg id + naam + bestemming_id terug.
        cols = ["naam", "bestemming_id", "type", "leverancier"]
        col_list = ", ".join(f'"{c}"' for c in cols)
        sql_insert = (
            f'INSERT INTO "accommodaties" ({col_list}) VALUES %s '
            f'RETURNING id, naam, bestemming_id'
        )
        template = "(" + ", ".join(["%s"] * len(cols)) + ")"
        values_list = [
            (n, b, unique[(n, b)][0], unique[(n, b)][1]) for (n, b) in missing_keys
        ]

        conn = self._get_conn()
        broken = False
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                self._apply_statement_timeout(cur)
                result = psycopg2.extras.execute_values(
                    cur, sql_insert, values_list, template=template, page_size=200,
                    fetch=True,
                )
                conn.commit()
            for row in result or []:
                k = (str(row["naam"]), str(row["bestemming_id"]))
                cache[k] = str(row["id"])
        except Exception as exc:  # noqa: BLE001
            broken = self._is_connection_lost_error(exc)
            self._safe_rollback(conn)
            raise SupabaseServiceError(f"Bulk insert mislukt (accommodaties): {exc}")
        finally:
            self._put_conn(conn, broken=broken)

    def delete_boekingen_not_in_order_set(self, *, order_nummers: list[str]) -> None:
        unique_orders = sorted({o.strip() for o in order_nummers if o and o.strip()})
        if not unique_orders:
            return

        # PostgREST filters for text columns typically do NOT require quoting.
        # Quoting the values can cause mismatches where the query looks for the
        # literal quote characters.
        items = ",".join(unique_orders)
        filter_value = f"not.in.({items})"
        self._sql_delete("boekingen", {"order_nummer": filter_value})

    def delete_boekingen_for_order_nummers(self, *, order_nummers: list[str]) -> None:
        """
        Force overwrite semantics for existing bookings.

        We delete bookings whose `order_nummer` is part of the latest Excel upload,
        so re-inserting guarantees all booking fields reflect the newest data.
        """
        unique_orders = sorted({o.strip() for o in order_nummers if o and o.strip()})
        if not unique_orders:
            return

        # PostgREST filters for text columns typically do NOT require SQL quoting.
        items = ",".join(unique_orders)
        filter_value = f"in.({items})"
        self._sql_delete("boekingen", {"order_nummer": filter_value})

    def delete_boekingen_for_booking_ids(self, booking_ids: Iterable[str]) -> None:
        """
        Rollback helper: delete bookings by primary key id.
        Because related tables use FK with `on delete cascade`, this removes
        travellers and relation rows as well.
        """
        unique_ids = sorted({str(bid).strip() for bid in booking_ids if bid and str(bid).strip()})
        if not unique_ids:
            return

        items = ",".join(unique_ids)
        filter_value = f"in.({items})"
        self._sql_delete("boekingen", {"id": filter_value})

    def upsert_boekingen(
        self,
        *,
        bookings: list[dict[str, Any]],
        upload_id: str | None = None,
        batch_size: int = 100,
    ) -> None:
        if not bookings:
            return

        for i in range(0, len(bookings), batch_size):
            batch = bookings[i : i + batch_size]

            if upload_id:
                # Best-effort: schema bevat mogelijk (of niet) `boekingen.upload_id`.
                batch_with_upload = [dict(b) for b in batch]
                for pb in batch_with_upload:
                    pb["upload_id"] = upload_id
                try:
                    # `return_representation=False`: we halen IDs daarna in één bulk-SELECT op
                    # via `get_boekingen_ids_by_order_nummers`. RETURNING * voor honderden
                    # boekingen is een dure overhead die we hier niet nodig hebben.
                    self._rest_upsert(
                        "boekingen",
                        batch_with_upload,
                        on_conflict="order_nummer",
                        return_representation=False,
                    )
                    continue
                except SupabaseServiceError:
                    # Fallback without upload_id if the column doesn't exist.
                    pass

            self._rest_upsert(
                "boekingen", batch, on_conflict="order_nummer", return_representation=False,
            )

    def upsert_boeking_accommodaties(
        self, *, rows: list[dict[str, Any]], batch_size: int = 200
    ) -> None:
        if not rows:
            return
        for i in range(0, len(rows), batch_size):
            batch = rows[i : i + batch_size]
            self._rest_upsert(
                "boeking_accommodaties", batch, on_conflict="boeking_id",
                return_representation=False,
            )

    def upsert_financien(self, *, rows: list[dict[str, Any]], batch_size: int = 200) -> None:
        if not rows:
            return
        for i in range(0, len(rows), batch_size):
            batch = rows[i : i + batch_size]
            self._rest_upsert(
                "boeking_financien", batch, on_conflict="boeking_id",
                return_representation=False,
            )

    def upsert_boeking_bus_gegevens(
        self, *, rows: list[dict[str, Any]], batch_size: int = 200
    ) -> None:
        if not rows:
            return
        for i in range(0, len(rows), batch_size):
            batch = rows[i : i + batch_size]
            self._rest_upsert(
                "boeking_bus_gegevens", batch, on_conflict="boeking_id",
                return_representation=False,
            )

    def upsert_reiziger_financien(self, *, rows: list[dict[str, Any]], batch_size: int = 200) -> None:
        if not rows:
            return
        for i in range(0, len(rows), batch_size):
            batch = rows[i : i + batch_size]
            self._rest_upsert(
                "reiziger_financien", batch, on_conflict="reiziger_id",
                return_representation=False,
            )

    def upsert_transporten_with_maatschappij(self, transports: dict[str, str | None]) -> dict[str, str]:
        if not transports:
            return {}

        rows: list[dict[str, Any]] = []
        for naam, maatschappij in transports.items():
            payload: dict[str, Any] = {"naam": naam}
            # Only include maatschappij field when provided; avoids overwriting with null.
            if maatschappij is not None:
                payload["maatschappij"] = maatschappij
            rows.append(payload)

        try:
            resp_rows = self._rest_upsert("transporten", rows, on_conflict="naam")
            return {str(r["naam"]): str(r["id"]) for r in resp_rows if r.get("id")}
        except SupabaseServiceError as exc:
            # Column might not exist in schema; retry with only `naam`.
            import logging

            logging.getLogger(__name__).warning(
                "Upsert transporten met maatschappij mislukt; fallback naar alleen naam. error=%s",
                str(exc),
            )
            return self.upsert_transporten(transports.keys())

    def import_bookings(
        self,
        *,
        bookings_import: list[Any],
        transport_maatschappij_map: dict[str, str | None] | None = None,
        upload_id: str | None = None,
    ) -> None:
        if not bookings_import:
            return

        # Stagewise timing zodat traceren bij grote uploads makkelijk wordt.
        _stage_start = time.perf_counter()

        def _log_stage(name: str) -> None:
            nonlocal _stage_start
            dt = time.perf_counter() - _stage_start
            _logger.info("import_bookings stage=%s elapsed=%.2fs", name, dt)
            _stage_start = time.perf_counter()

        bestemming_id_map = self.upsert_bestemmingen(
            {b.bestemming_naam for b in bookings_import if getattr(b, "bestemming_naam", None)}
        )
        _log_stage("bestemmingen")
        doelgroep_id_map = self.upsert_doelgroepen(
            {b.doelgroep_naam for b in bookings_import if getattr(b, "doelgroep_naam", None)}
        )
        _log_stage("doelgroepen")
        transport_names = {b.transport_naam for b in bookings_import if getattr(b, "transport_naam", None)}
        if transport_maatschappij_map is not None:
            transport_id_map = self.upsert_transporten_with_maatschappij(
                {name: transport_maatschappij_map.get(name) for name in transport_names}
            )
        else:
            transport_id_map = self.upsert_transporten(transport_names)
        _log_stage("transporten")

        status_cache: dict[tuple[str, str], str | None] = {}
        status_pairs: list[tuple[str, str]] = []
        for b in bookings_import:
            if getattr(b, "booking_status_naam", None):
                status_pairs.append(("booking", b.booking_status_naam))
            if getattr(b, "payment_status_naam", None):
                status_pairs.append(("betaling", b.payment_status_naam))
            if getattr(b, "accommodatie_status_naam", None):
                status_pairs.append(("accommodatie", b.accommodatie_status_naam))
        self.bulk_load_statussen(status_pairs, status_cache)
        _log_stage("statussen")

        accom_cache: dict[tuple[str, str], str] = {}
        accom_items: list[tuple[str, str, str | None, str | None]] = []
        for b in bookings_import:
            bestemming_id = bestemming_id_map.get(b.bestemming_naam)
            if not bestemming_id or not getattr(b, "accommodatie_naam", None):
                continue
            accom_items.append(
                (
                    b.accommodatie_naam,
                    bestemming_id,
                    b.accommodatie_type,
                    b.accommodatie_leverancier,
                )
            )
        self.bulk_load_accommodaties(accom_items, accom_cache)
        _log_stage(f"accommodaties unique={len(accom_cache)}")

        def date_to_str(d: Any) -> str | None:
            if d is None:
                return None
            if hasattr(d, "isoformat"):
                return d.isoformat()
            return str(d)

        booking_rows: list[dict[str, Any]] = []
        booking_extras_by_order: dict[str, dict[str, Any]] = {}
        include_excursions_totaal_excel = any(getattr(b, "excursions_total", None) is not None for b in bookings_import)
        for b in bookings_import:
            bestemming_id = bestemming_id_map.get(b.bestemming_naam)
            if not bestemming_id:
                continue
            accom_id = accom_cache.get((b.accommodatie_naam, bestemming_id))
            if not accom_id:
                continue

            booking_status_id = status_cache.get(("boeking", b.booking_status_naam)) if b.booking_status_naam else None
            betaling_status_id = status_cache.get(("betaling", b.payment_status_naam)) if b.payment_status_naam else None
            doelgroep_id = doelgroep_id_map.get(b.doelgroep_naam) if b.doelgroep_naam else None
            transport_id = transport_id_map.get(b.transport_naam) if b.transport_naam else None

            booking_rows.append(
                {
                    "order_nummer": b.order_nummer,
                    "bestemming_id": bestemming_id,
                    "accommodatie_id": accom_id,
                    "vertrekdatum": date_to_str(b.vertrekdatum),
                    "terugkeerdatum": date_to_str(b.terugkeerdatum),
                    "boekingsdatum": date_to_str(b.boekingsdatum),
                    "aantal_reizigers": int(b.aantal_reizigers),
                    "boeking_status_id": booking_status_id,
                    "betaling_status_id": betaling_status_id,
                    "doelgroep_id": doelgroep_id,
                    "transport_id": transport_id,
                    "brand": b.brand,
                    "brand_land": getattr(b, "brand_land", None),
                }
            )
            booking_extras_by_order[b.order_nummer] = {
                "transport_naam": b.transport_naam,
                "opstapplaats_bus": b.opstapplaats_bus,
                "vertrek_bus": b.vertrek_bus,
                "retour_bus": b.retour_bus,
                "accommodatie_status_id": (
                    status_cache.get(("accommodatie", b.accommodatie_status_naam))
                    if getattr(b, "accommodatie_status_naam", None)
                    else None
                ),
                "maaltijdtype": b.maaltijdtype,
                "kamer": b.kamer,
                "kamer_prijs": b.kamer_prijs,
                "schoonmaakkosten_te_betalen": b.schoonmaakkosten_te_betalen,
                "waarborg_te_betalen": b.waarborg_te_betalen,
                "waarborg_betaald": b.waarborg_betaald,
                "waarborg_methode": b.waarborg_methode,
                "excursions_totaal_excel": getattr(b, "excursions_total", None),
                "voorschot_percentage": b.voorschot_percentage,
                "voorschot": b.voorschot,
                "factuur_verzonden_op": b.factuur_verzonden_op,
            }

        self.upsert_boekingen(bookings=booking_rows, upload_id=upload_id)
        _log_stage(f"upsert_boekingen rows={len(booking_rows)}")
        booking_map = self.get_boekingen_ids_by_order_nummers([b.order_nummer for b in bookings_import])
        _log_stage(f"lookup_booking_ids count={len(booking_map)}")

        boeking_accommodaties_rows: list[dict[str, Any]] = []
        financien_rows: list[dict[str, Any]] = []
        boeking_bus_rows: list[dict[str, Any]] = []
        for order_nummer, extras in booking_extras_by_order.items():
            boeking_id = booking_map.get(order_nummer)
            if not boeking_id:
                continue
            boeking_accommodaties_rows.append(
                {
                    "boeking_id": boeking_id,
                    "accommodatie_status_id": extras.get("accommodatie_status_id"),
                    "maaltijdtype": extras.get("maaltijdtype"),
                    "kamer": extras.get("kamer"),
                    "kamer_prijs": extras.get("kamer_prijs"),
                }
            )
            financien_rows.append(
                {
                    "boeking_id": boeking_id,
                    "schoonmaakkosten_te_betalen": extras.get("schoonmaakkosten_te_betalen"),
                    "waarborg_te_betalen": extras.get("waarborg_te_betalen"),
                    "waarborg_betaald": extras.get("waarborg_betaald"),
                    "waarborg_methode": extras.get("waarborg_methode"),
                    "voorschot_percentage": extras.get("voorschot_percentage"),
                    "voorschot": extras.get("voorschot"),
                    "factuur_verzonden_op": extras.get("factuur_verzonden_op"),
                }
            )
            if include_excursions_totaal_excel:
                financien_rows[-1]["excursions_totaal_excel"] = extras.get("excursions_totaal_excel")
            boeking_bus_rows.append(
                {
                    "boeking_id": boeking_id,
                    "opstapplaats_bus": extras.get("opstapplaats_bus"),
                    "vertrek_bus": extras.get("vertrek_bus"),
                    "retour_bus": extras.get("retour_bus"),
                }
            )
        self.upsert_boeking_accommodaties(rows=boeking_accommodaties_rows)
        _log_stage(f"upsert_boeking_accommodaties rows={len(boeking_accommodaties_rows)}")
        self.upsert_financien(rows=financien_rows)
        _log_stage(f"upsert_financien rows={len(financien_rows)}")
        self.upsert_boeking_bus_gegevens(rows=boeking_bus_rows)
        _log_stage(f"upsert_boeking_bus_gegevens rows={len(boeking_bus_rows)}")

    # ----------------------------
    # Lookup helpers
    # ----------------------------
    def get_boekingen_ids_by_order_nummers(self, order_nummers: Iterable[str]) -> dict[str, str]:
        unique_orders = sorted({o.strip() for o in order_nummers if o and str(o).strip()})
        if not unique_orders:
            return {}

        # Gebruik parameterized ANY(...) i.p.v. PostgREST `in.(a,b,c)`:
        # ordernummers kunnen komma's bevatten; die breken een komma-gescheiden IN-filter.
        rows = self._execute(
            'SELECT id, "order_nummer" FROM "boekingen" WHERE "order_nummer" = ANY(%s::text[])',
            (unique_orders,),
        )
        out: dict[str, str] = {}
        for r in rows:
            on = r.get("order_nummer")
            rid = r.get("id")
            if on is None or rid is None:
                continue
            out[str(on).strip()] = str(rid)
        return out

    def get_boekingen_context_for_ids(self, booking_ids: Iterable[str]) -> dict[str, dict[str, Any]]:
        unique_ids = sorted({str(bid).strip() for bid in booking_ids if bid and str(bid).strip()})
        if not unique_ids:
            return {}
        items = ",".join(f'"{bid}"' for bid in unique_ids)
        rows = self._rest_select(
            "boekingen",
            select="id,order_nummer,brand,bestemming_id,vertrekdatum,boekingsdatum",
            filters={"id": f"in.({items})"},
        )
        out: dict[str, dict[str, Any]] = {}
        for r in rows:
            bid = r.get("id")
            if bid is None:
                continue
            out[str(bid)] = r
        return out

    def get_boeking_cost_edit_context(self, *, booking_id: str) -> dict[str, Any] | None:
        """Boeking + accommodatie/status labels voor handmatige kostinvoer in Financiën."""
        bid = str(booking_id or "").strip()
        if not bid:
            return None
        rows = self._rest_select(
            "boekingen",
            select="id,order_nummer,accommodatie_id,boeking_status_id",
            filters={"id": f"eq.{bid}"},
        )
        if not rows:
            return None
        row = rows[0]
        out: dict[str, Any] = {
            "booking_id": str(row.get("id") or ""),
            "order_nummer": str(row.get("order_nummer") or ""),
            "accommodatie_id": row.get("accommodatie_id"),
            "boeking_status_id": row.get("boeking_status_id"),
            "accommodatie_naam": "",
            "booking_status_naam": "",
        }

        acc_id = row.get("accommodatie_id")
        if acc_id:
            acc_rows = self._rest_select(
                "accommodaties",
                select="id,naam",
                filters={"id": f"eq.{acc_id}"},
            )
            if acc_rows:
                out["accommodatie_naam"] = str(acc_rows[0].get("naam") or "")

        status_id = row.get("boeking_status_id")
        if status_id:
            st_rows = self._rest_select(
                "statussen",
                select="id,naam",
                filters={"id": f"eq.{status_id}"},
            )
            if st_rows:
                out["booking_status_naam"] = str(st_rows[0].get("naam") or "")
        return out

    def set_kost_accommodatie_for_booking_reizigers(
        self,
        *,
        booking_id: str,
        totale_kost: float,
    ) -> dict[str, Any]:
        """
        Verdeel totale kost op boekingsniveau over alle reizigers en sla op per reiziger.
        Opslag gebeurt in `reiziger_financien.kost_accommodatie`.
        """
        bid = str(booking_id or "").strip()
        if not bid:
            raise SupabaseServiceError("booking_id is verplicht.")

        reizigers = self.get_reizigers_for_booking_ids([bid])
        if not reizigers:
            raise SupabaseServiceError("Geen reizigers gevonden voor deze boeking.")

        # Verdeling in centen zodat de som exact gelijk blijft aan de ingegeven totale kost.
        total_cents = int((Decimal(str(totale_kost)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP) * 100))
        sorted_reizigers = sorted(reizigers, key=lambda r: str(r.get("id") or ""))
        count = len(sorted_reizigers)
        base = total_cents // count
        remainder = total_cents % count

        upserts: list[dict[str, Any]] = []
        for idx, r in enumerate(sorted_reizigers):
            rid = str(r.get("id") or "").strip()
            if not rid:
                continue
            cents = base + (1 if idx < remainder else 0)
            upserts.append(
                {
                    "reiziger_id": rid,
                    "kost_accommodatie": float(Decimal(cents) / Decimal(100)),
                }
            )
        if not upserts:
            raise SupabaseServiceError("Geen geldige reiziger_id gevonden voor deze boeking.")

        self.upsert_reiziger_financien(rows=upserts, batch_size=max(1, len(upserts)))
        return {
            "booking_id": bid,
            "traveller_count": len(upserts),
            "totale_kost": float(Decimal(total_cents) / Decimal(100)),
        }

    def get_existing_boeking_ids(self, booking_ids: Iterable[str]) -> set[str]:
        unique_ids = sorted({str(bid).strip() for bid in booking_ids if bid and str(bid).strip()})
        if not unique_ids:
            return set()
        out: set[str] = set()
        step = REIZIGERS_BOEKING_ID_IN_CHUNK
        for i in range(0, len(unique_ids), step):
            chunk = unique_ids[i : i + step]
            items = ",".join(chunk)
            rows = self._rest_select(
                "boekingen",
                select="id",
                filters={"id": f"in.({items})"},
            )
            for r in rows:
                if r.get("id") is not None:
                    out.add(str(r["id"]))
        return out

    # ----------------------------
    # Reizigers lookups
    # ----------------------------
    def get_reizigers_for_booking_ids(self, booking_ids: Iterable[str]) -> list[dict[str, Any]]:
        """
        Haal reizigers voor de gegeven boeking-id's. In batches i.v.m. maximale URL-lengte.
        """
        unique_ids = sorted({str(bid).strip() for bid in booking_ids if bid and str(bid).strip()})
        if not unique_ids:
            return []
        out: list[dict[str, Any]] = []
        step = REIZIGERS_BOEKING_ID_IN_CHUNK
        for i in range(0, len(unique_ids), step):
            chunk = unique_ids[i : i + step]
            items = ",".join(chunk)
            filter_value = f"in.({items})"
            out.extend(
                self._rest_select(
                    "reizigers",
                    select=(
                        "id,boeking_id,voornaam,achternaam,geboortedatum,geslacht,traveller_status_id,"
                        "incasso_status,uitgesloten_van_communicatie,stad,provincie,land,school"
                    ),
                    filters={"boeking_id": filter_value},
                )
            )
        return out

    # ----------------------------
    # Reizigers
    # ----------------------------
    def delete_reizigers_for_booking_ids(self, booking_ids: Iterable[str]) -> None:
        unique_ids = sorted({str(bid).strip() for bid in booking_ids if bid and str(bid).strip()})
        if not unique_ids:
            return

        step = REIZIGERS_BOEKING_ID_IN_CHUNK
        for i in range(0, len(unique_ids), step):
            chunk = unique_ids[i : i + step]
            items = ",".join(chunk)
            filter_value = f"in.({items})"
            self._sql_delete("reizigers", {"boeking_id": filter_value})

    def insert_reizigers(self, rows: list[dict[str, Any]], batch_size: int = 500) -> list[str]:
        """
        Voeg reizigers batchgewijs in. Retourneert `id`'s in dezelfde volgorde als `rows`
        (PostgREST `return=representation`), zodat `reiziger_financien` 1-op-1 gekoppeld kan worden.
        """
        if not rows:
            return []
        out_ids: list[str] = []
        for i in range(0, len(rows), batch_size):
            batch = rows[i : i + batch_size]
            batch = self._normalize_rows_for_json(batch)
            inserted = self._sql_insert("reizigers", batch, returning="id")
            for r in inserted:
                rid = r.get("id")
                if rid is not None:
                    out_ids.append(str(rid))
        if len(out_ids) != len(rows):
            raise SupabaseServiceError(
                f"Reizigers insert: verwacht {len(rows)} rijen met id in response, kreeg {len(out_ids)}."
            )
        return out_ids

    # ----------------------------
    # Excursies relations
    # ----------------------------
    # Sentinel-uuid voor de COALESCE-expressie in het unieke index op excursies.
    _EXCURSIES_BESTEMMING_SENTINEL = "00000000-0000-0000-0000-000000000000"

    def upsert_excursies_master(self, rows: list[dict[str, Any]]) -> dict[tuple[str, str | None], str]:
        """Idempotente master-upsert voor excursies, robuust voor namen met komma's/emoji.

        Twee round-trips i.p.v. N losse:
        1. Bulk INSERT met `ON CONFLICT (normalized_naam, COALESCE(bestemming_id, sentinel))
           DO NOTHING`. Match exact op het bestaande unieke index. Duplicates crashen niet.
        2. Bulk SELECT op (normalized_naam, bestemming_id) met parameters om alle IDs
           op te halen — komma-veilig, emoji-veilig, geen IN.(...)-filterparsing.
        """
        if not rows:
            return {}

        # Bouw uniforme payloads en de needed-set.
        normalized_rows: list[dict[str, Any]] = []
        needed_pairs: set[tuple[str, str | None]] = set()
        for r in rows:
            naam_raw = r.get("naam")
            normalized = self._normalize_excursie_naam(r.get("normalized_naam") or naam_raw)
            if not normalized:
                continue
            bestemming_id = str(r.get("bestemming_id")) if r.get("bestemming_id") else None
            needed_pairs.add((str(normalized), bestemming_id))
            payload = {
                "naam": naam_raw,
                "normalized_naam": str(normalized),
                "bestemming_id": bestemming_id,
                "type": str(r.get("type") or r.get("excursie_type") or "Algemeen"),
                "excursie_type": str(r.get("excursie_type") or r.get("type") or "Algemeen"),
            }
            if r.get("prijs") is not None:
                payload["prijs"] = r.get("prijs")
            normalized_rows.append(self._normalize_for_json(payload))

        if not needed_pairs:
            return {}

        # 1) Bulk INSERT met ON CONFLICT DO NOTHING.
        # We matchen exact op de unique-index-expressie:
        #   (normalized_naam, COALESCE(bestemming_id, '<sentinel>'::uuid))
        sentinel = self._EXCURSIES_BESTEMMING_SENTINEL
        cols = ["naam", "normalized_naam", "bestemming_id", "type", "excursie_type", "prijs"]
        col_list = ", ".join(f'"{c}"' for c in cols)
        on_conflict_target = (
            f"(normalized_naam, COALESCE(bestemming_id, '{sentinel}'::uuid))"
        )
        sql_insert = (
            f'INSERT INTO "excursies" ({col_list}) VALUES %s '
            f'ON CONFLICT {on_conflict_target} DO NOTHING'
        )
        template = "(" + ", ".join(["%s"] * len(cols)) + ")"
        values_list = [tuple(r.get(c) for c in cols) for r in normalized_rows]

        if values_list:
            conn = self._get_conn()
            broken = False
            try:
                with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                    self._apply_statement_timeout(cur)
                    psycopg2.extras.execute_values(
                        cur, sql_insert, values_list, template=template, page_size=200, fetch=False,
                    )
                    conn.commit()
            except Exception as exc:  # noqa: BLE001
                broken = self._is_connection_lost_error(exc)
                self._safe_rollback(conn)
                raise SupabaseServiceError(f"Insert mislukt (excursies): {exc}")
            finally:
                self._put_conn(conn, broken=broken)

        # 2) Bulk SELECT om alle benodigde IDs op te halen — parametrisering, komma-veilig.
        keys = list(needed_pairs)
        placeholders = ", ".join(["(%s, %s)"] * len(keys))
        params: list[Any] = []
        for naam, bid in keys:
            params.append(naam)
            params.append(bid if bid is not None else sentinel)
        sql_select = (
            'SELECT id, normalized_naam, bestemming_id FROM "excursies" '
            f'WHERE (normalized_naam, COALESCE(bestemming_id, %s::uuid)) IN ({placeholders})'
        )
        select_params = (sentinel, *params)
        rows_existing = self._execute(sql_select, select_params)

        result_map: dict[tuple[str, str | None], str] = {}
        for r in rows_existing:
            normalized = str(r.get("normalized_naam") or "")
            raw_bestemming = r.get("bestemming_id")
            bid = str(raw_bestemming) if raw_bestemming else None
            if r.get("id"):
                result_map[(normalized, bid)] = str(r["id"])
        return {key: result_map[key] for key in needed_pairs if key in result_map}

    def delete_boeking_excursies_for_booking_ids(self, booking_ids: Iterable[str]) -> None:
        unique_ids = sorted({str(bid).strip() for bid in booking_ids if bid and str(bid).strip()})
        if not unique_ids:
            return

        items = ",".join(unique_ids)
        filter_value = f"in.({items})"
        self._sql_delete("boeking_excursies", {"boeking_id": filter_value})

    def insert_boeking_excursies(self, rows: list[dict[str, Any]], batch_size: int = 500) -> None:
        if not rows:
            return
        for i in range(0, len(rows), batch_size):
            batch = rows[i : i + batch_size]
            batch = self._normalize_rows_for_json(batch)
            try:
                self._sql_insert("boeking_excursies", batch, returning="")
            except SupabaseServiceError:
                # Backward-compat: sommige omgevingen hebben nog niet alle nieuwe kolommen.
                legacy_batch: list[dict[str, Any]] = []
                for row in batch:
                    legacy_row = dict(row)
                    legacy_row.pop("reiziger_id", None)
                    legacy_row.pop("reiziger_status_id", None)
                    legacy_row.pop("voornaam", None)
                    legacy_row.pop("achternaam", None)
                    legacy_row.pop("traveller_email", None)
                    legacy_row.pop("bestemming_naam", None)
                    legacy_batch.append(legacy_row)
                self._sql_insert("boeking_excursies", legacy_batch, returning="")

    def get_boeking_excursies_for_booking_ids(self, booking_ids: Iterable[str]) -> list[dict[str, Any]]:
        unique_ids = sorted({str(bid).strip() for bid in booking_ids if bid and str(bid).strip()})
        if not unique_ids:
            return []
        items = ",".join(unique_ids)
        filter_value = f"in.({items})"
        try:
            return self._rest_select(
                "boeking_excursies",
                select=(
                    "boeking_id,excursie_id,vertrekdatum,terugkeerdatum,verkoopprijs,is_gratis,betaling_pending,"
                    "boeking_status_id,reiziger_status_id,reiziger_id,voornaam,achternaam,traveller_email,bestemming_naam,"
                    "commentaar,betaaloptie,mollie_betaling_id,"
                    "geboekt_in_online_account,datum_toegevoegd,bron_rij_hash"
                ),
                filters={"boeking_id": filter_value},
            )
        except SupabaseServiceError:
            # Backward-compat zolang nog niet elke omgeving de nieuwe kolommen heeft.
            return self._rest_select(
                "boeking_excursies",
                select=(
                    "boeking_id,excursie_id,vertrekdatum,terugkeerdatum,betaling_pending,"
                    "boeking_status_id,commentaar,betaaloptie,mollie_betaling_id,"
                    "geboekt_in_online_account,datum_toegevoegd"
                ),
                filters={"boeking_id": filter_value},
            )

    # ----------------------------
    # Addons relations
    # ----------------------------
    def upsert_addons_master(self, rows: list[dict[str, Any]]) -> dict[str, str]:
        if not rows:
            return {}
        resp_rows = self._rest_upsert("addons", rows, on_conflict="naam")
        mapping: dict[str, str] = {}
        for r in resp_rows:
            if r.get("id") is not None:
                mapping[str(r["naam"])] = str(r["id"])
        # Fallback: fill missing
        missing = {str(r["naam"]) for r in rows} - set(mapping.keys())
        for naam in missing:
            matches = self._rest_select("addons", select="id,naam", filters={"naam": f"eq.{naam}"})
            if matches:
                mapping[naam] = str(matches[0]["id"])
        return mapping

    def delete_boeking_addons_for_booking_ids(self, booking_ids: Iterable[str]) -> None:
        unique_ids = sorted({str(bid).strip() for bid in booking_ids if bid and str(bid).strip()})
        if not unique_ids:
            return

        items = ",".join(unique_ids)
        filter_value = f"in.({items})"
        self._sql_delete("boeking_addons", {"boeking_id": filter_value})

    def insert_boeking_addons(self, rows: list[dict[str, Any]], batch_size: int = 500) -> None:
        if not rows:
            return
        for i in range(0, len(rows), batch_size):
            batch = rows[i : i + batch_size]
            batch = self._normalize_rows_for_json(batch)
            self._sql_insert("boeking_addons", batch, returning="")

    def get_boeking_addons_for_booking_ids(self, booking_ids: Iterable[str]) -> list[dict[str, Any]]:
        unique_ids = sorted({str(bid).strip() for bid in booking_ids if bid and str(bid).strip()})
        if not unique_ids:
            return []
        items = ",".join(unique_ids)
        filter_value = f"in.({items})"
        return self._rest_select(
            "boeking_addons",
            select="boeking_id,addon_id,prijs,vertrekdatum,terugkeerdatum,geboekt_in_online_account,boeking_status_id",
            filters={"boeking_id": filter_value},
        )

    # ----------------------------
    # Flights relations
    # ----------------------------
    def delete_boeking_vluchten_for_booking_ids(self, booking_ids: Iterable[str]) -> None:
        unique_ids = sorted({str(bid).strip() for bid in booking_ids if bid and str(bid).strip()})
        if not unique_ids:
            return
        items = ",".join(unique_ids)
        filter_value = f"in.({items})"
        self._sql_delete("boeking_vluchten", {"boeking_id": filter_value})

    def insert_boeking_vluchten(self, rows: list[dict[str, Any]], batch_size: int = 500) -> None:
        if not rows:
            return
        for i in range(0, len(rows), batch_size):
            batch = rows[i : i + batch_size]
            batch = self._normalize_rows_for_json(batch)
            self._sql_insert("boeking_vluchten", batch, returning="")

    # ----------------------------
    # Overzicht (analytics dashboard)
    # ----------------------------
    OVERZICHT_ALLOWED_BRANDS = ["Sun Escapes", "Snow Escapes", "Road Rebels"]

    @staticmethod
    def _matches_brand_land_filter(raw_value: Any, brand_land: str) -> bool:
        flt = (brand_land or "__ALL__").strip().upper()
        if flt in {"", "__ALL__", "ALL"}:
            return True
        cur = str(raw_value or "").strip().upper()
        return cur == flt

    def get_overzicht_brands(self) -> list[str]:
        """
        Geef alleen merken terug die daadwerkelijk voorkomen in `boekingen`.
        """
        allowed = [b for b in self.OVERZICHT_ALLOWED_BRANDS if b]
        if not allowed:
            return []

        # Gebruik PostgREST `in.(...)` met dubbele quotes voor waarden met spaties.
        # Voorbeeld: brand=in.("Sun Escapes","Snow Escapes")
        in_list = ",".join([f"\"{b}\"" for b in allowed])
        rows = self._paginate_rest_scan(
            "boekingen",
            select="brand",
            query_params=[("brand", f"in.({in_list})")],
        )

        existing = {str(r.get("brand")) for r in rows if r.get("brand") is not None}
        # Bewaar de vaste volgorde zoals in de UI-eisen.
        return [b for b in allowed if b in existing]

    def get_overzicht_dashboard(
        self,
        *,
        brand: str,
        year: int,
        destination_id: str | None,
        brand_land: str = "__ALL__",
    ) -> dict[str, Any]:
        """
        Backend die alle dashboarddata samenstelt voor de `/overzicht/data` endpoint.

        Business logic hoort bij voorkeur in de service/laag, zodat routes eenvoudig blijven.
        """
        try:
            rpc_payload = self.get_overzicht_dashboard_rpc(
                brand=brand,
                year=year,
                destination_id=destination_id,
                brand_land=brand_land,
            )
            # Alleen echte dashboard-payloads (met kpis); geen { "error": ... } e.d.
            if isinstance(rpc_payload, dict) and isinstance(rpc_payload.get("kpis"), dict):
                return self._ensure_overzicht_kpis_prev_year(
                    rpc_payload,
                    brand=brand,
                    year=year,
                    destination_id=destination_id,
                    brand_land=brand_land,
                )
        except SupabaseServiceError:
            # Backward-compatible fallback: houd de bestaande Python-aggregatie als laatste vangnet.
            pass

        start_date, end_date = self.get_overzicht_season_bounds(brand=brand, year=year)
        if start_date is None or end_date is None:
            return {
                "kpis": {
                    "total_boekingen": 0,
                    "total_reizigers": 0,
                    "total_omzet": 0,
                    "top_bestemming": None,
                },
                "top_bestemming": None,
                "meest_populaire_reisperiode": None,
                "booking_trend": [],
                "popular_destinations_overall": [],
                "popular_travel_periods_overall": [],
                "popular_travel_periods_destination": [],
                "destination_lijst": [],
                "destination_naam": None,
            }

        # Basisset (zonder bestemming filter) voor dropdown + "Populaire bestemmingen"
        destination_counts_overall = self.get_overzicht_destination_counts(
            brand=brand,
            start_date=start_date,
            end_date=end_date,
            destination_id=None,
            brand_land=brand_land,
        )
        destination_lijst = [
            {"id": d.get("id"), "naam": d.get("naam")} for d in destination_counts_overall if d.get("id")
        ]

        popular_travel_periods_overall = self.get_overzicht_popular_travel_periods(
            brand=brand,
            start_date=start_date,
            end_date=end_date,
            destination_id=None,
            brand_land=brand_land,
        )

        # Gesecteerd dataset (met of zonder bestemming filter) voor KPI’s en trends.
        kpi_totals = self.get_overzicht_totals(
            brand=brand,
            start_date=start_date,
            end_date=end_date,
            destination_id=destination_id,
            brand_land=brand_land,
        )
        booking_trend = self.get_overzicht_booking_trend(
            brand=brand,
            start_date=start_date,
            end_date=end_date,
            destination_id=destination_id,
            brand_land=brand_land,
        )

        # Sorteer wenselijk voor grafieken.
        popular_travel_periods_overall_sorted = sorted(
            popular_travel_periods_overall, key=lambda x: x.get("week") if x.get("week") is not None else 0
        )

        popular_travel_periods_destination_sorted: list[dict[str, Any]] = []
        destination_naam: str | None = None
        if destination_id:
            # Naam afleiden uit de overall bestemming-counts (bespaart een extra query).
            for d in destination_counts_overall:
                if d.get("id") == destination_id:
                    destination_naam = d.get("naam")
                    break

            popular_travel_periods_destination = self.get_overzicht_popular_travel_periods(
                brand=brand,
                start_date=start_date,
                end_date=end_date,
                destination_id=destination_id,
                brand_land=brand_land,
            )
            popular_travel_periods_destination_sorted = sorted(
                popular_travel_periods_destination,
                key=lambda x: x.get("week") if x.get("week") is not None else 0,
            )

        # Top bestemming KPI (op basis van datasetregels)
        top_bestemming = None
        if destination_id:
            # Bij één bestemming is top bestemming impliciet: die bestemming.
            top_bestemming = {"naam": destination_naam, "boekingen": kpi_totals.get("total_boekingen")}
        else:
            popular_destinations_overall_sorted = sorted(
                destination_counts_overall,
                key=lambda x: x.get("boekingen_count") if x.get("boekingen_count") is not None else 0,
                reverse=True,
            )
            if popular_destinations_overall_sorted:
                d = popular_destinations_overall_sorted[0]
                top_bestemming = {"naam": d.get("naam"), "boekingen": d.get("boekingen_count")}
        # Popular destinations chart data
        popular_destinations_overall_sorted = sorted(
            destination_counts_overall,
            key=lambda x: x.get("boekingen_count") if x.get("boekingen_count") is not None else 0,
            reverse=True,
        )

        # "Meest populaire reisperiode": hoogste som van reizigers per week (op basis van vertrekdatum).
        travel_period_basis = (
            popular_travel_periods_destination_sorted if destination_id else popular_travel_periods_overall_sorted
        )
        meest_populaire_reisperiode = None
        if travel_period_basis:
            meest_populaire_reisperiode = max(
                travel_period_basis,
                key=lambda x: x.get("reizigers_sum") if x.get("reizigers_sum") is not None else -1,
            )

        booking_trend_sorted = sorted(
            booking_trend, key=lambda x: (x.get("jaar") or 0, x.get("maand") or 0)
        )

        prev_year: dict[str, Any] | None = None
        if year > 0:
            prev_year = self._compute_overzicht_prev_year_kpis(
                brand=brand, year=year, destination_id=destination_id, brand_land=brand_land
            )

        kpis_out: dict[str, Any] = {
            **kpi_totals,
            "top_bestemming": top_bestemming,
        }
        if prev_year is not None:
            kpis_out["prev_year"] = prev_year

        return {
            "kpis": kpis_out,
            "top_bestemming": top_bestemming,
            "meest_populaire_reisperiode": meest_populaire_reisperiode,
            "booking_trend": booking_trend_sorted,
            "destination_lijst": destination_lijst,
            "destination_naam": destination_naam,
            "popular_destinations_overall": popular_destinations_overall_sorted,
            "popular_travel_periods_overall": popular_travel_periods_overall_sorted,
            "popular_travel_periods_destination": popular_travel_periods_destination_sorted,
        }

    def _compute_overzicht_prev_year_kpis(
        self, *, brand: str, year: int, destination_id: str | None, brand_land: str = "__ALL__"
    ) -> dict[str, Any] | None:
        """
        KPI’s over dezelfde seizoensdefinitie als `overzicht_dashboard`, één kalenderjaar terug.
        Gebruikt door de Python-fallback en om `prev_year` aan te vullen als de RPC die nog niet levert.
        """
        if year <= 0:
            return None
        py = year - 1
        start_date, end_date = self.get_overzicht_season_bounds(brand, py)
        if start_date is None or end_date is None:
            return None
        t = self.get_overzicht_totals(
            brand=brand,
            start_date=start_date,
            end_date=end_date,
            destination_id=destination_id,
            brand_land=brand_land,
        )
        return {
            "total_boekingen": int(t.get("total_boekingen") or 0),
            "total_reizigers": int(t.get("total_reizigers") or 0),
            "total_omzet": float(t.get("total_omzet") or 0.0),
        }

    def _ensure_overzicht_kpis_prev_year(
        self,
        payload: dict[str, Any],
        *,
        brand: str,
        year: int,
        destination_id: str | None,
        brand_land: str = "__ALL__",
    ) -> dict[str, Any]:
        if year <= 0:
            return payload
        kpis = payload.get("kpis")
        if not isinstance(kpis, dict):
            return payload

        computed = self._compute_overzicht_prev_year_kpis(
            brand=brand, year=year, destination_id=destination_id, brand_land=brand_land
        )
        if computed is None:
            return payload

        # RPC kan al een prev_year leveren zonder total_omzet (oudere SQL). Vul ontbrekende velden
        # vanuit Python i.p.v. vroeg te returnen.
        existing = kpis.get("prev_year")
        merged: dict[str, Any] = dict(computed)
        if isinstance(existing, dict):
            for k, v in existing.items():
                if v is not None:
                    merged[k] = v

        payload["kpis"] = {**kpis, "prev_year": merged}
        return payload

    def get_overzicht_years(self, brand: str) -> list[int]:
        if not brand:
            return []

        query_params: list[tuple[str, Any]] = [("vertrekdatum", "not.is.null")]
        if brand != "__all__":
            query_params.insert(0, ("brand", f'eq."{brand}"'))

        rows = self._paginate_rest_scan(
            "boekingen",
            select="vertrekdatum",
            query_params=query_params,
        )

        years_set: set[int] = set()
        for r in rows:
            vd = self._parse_iso_date(r.get("vertrekdatum"))
            if vd is not None:
                years_set.add(vd.year)

        return sorted(years_set)

    def _boekingen_vertrek_min_max_no_aggregate(
        self,
        *,
        brand: str,
        vertrek_gte: date,
        vertrek_lte: date,
    ) -> tuple[date | None, date | None]:
        """
        Kleinste en grootste vertrekdatum in een venster, zonder MIN()/MAX() in PostgREST
        (Supabase heeft aggregate selects vaak uit: PGRST123).
        """
        common: list[tuple[str, Any]] = [
            ("vertrekdatum", f"gte.{vertrek_gte.isoformat()}"),
            ("vertrekdatum", f"lte.{vertrek_lte.isoformat()}"),
        ]
        if brand and brand != "__all__":
            common.insert(0, ("brand", f'eq."{brand}"'))

        rows_min = self._rest_select_multi_params(
            "boekingen",
            select="vertrekdatum",
            query_params=[*common, ("order", "vertrekdatum.asc"), ("limit", "1")],
        )
        rows_max = self._rest_select_multi_params(
            "boekingen",
            select="vertrekdatum",
            query_params=[*common, ("order", "vertrekdatum.desc"), ("limit", "1")],
        )
        if not rows_min or not rows_max:
            return None, None
        start_date = self._parse_iso_date(rows_min[0].get("vertrekdatum"))
        end_date = self._parse_iso_date(rows_max[0].get("vertrekdatum"))
        return start_date, end_date

    def get_overzicht_season_bounds(self, brand: str, year: int) -> tuple[date | None, date | None]:
        if not brand or not year:
            return None, None

        start_year_date = date(year, 1, 1)
        end_year_date = date(year, 12, 31)

        brand_filter = f'eq."{brand}"'

        if brand == "__all__":
            # Gelijk aan overzicht_dashboard RPC: min/max vertrek binnen kalenderjaar, alle merken.
            return self._boekingen_vertrek_min_max_no_aggregate(
                brand="__all__", vertrek_gte=start_year_date, vertrek_lte=end_year_date
            )

        if brand == "Snow Escapes":
            # Exception: start is fixed, end is MAX(vertrekdatum) binnen geselecteerd jaar.
            start_date = date(year - 1, 12, 1)
            rows_max = self._rest_select_multi_params(
                "boekingen",
                select="vertrekdatum",
                query_params=[
                    ("brand", brand_filter),
                    ("vertrekdatum", f"gte.{start_year_date.isoformat()}"),
                    ("vertrekdatum", f"lte.{end_year_date.isoformat()}"),
                    ("order", "vertrekdatum.desc"),
                    ("limit", "1"),
                ],
            )
            end_date = self._parse_iso_date(rows_max[0].get("vertrekdatum")) if rows_max else None
            return start_date, end_date

        # Normaal merk: start=min + end=max binnen geselecteerd jaar.
        return self._boekingen_vertrek_min_max_no_aggregate(
            brand=brand, vertrek_gte=start_year_date, vertrek_lte=end_year_date
        )

    def _bestemming_names_map(self, bestemming_ids: list[str]) -> dict[str, str]:
        uniq = sorted({bid for bid in bestemming_ids if bid})
        if not uniq:
            return {}
        in_list = ",".join(uniq)
        rows = self._rest_select(
            "bestemmingen",
            select="id,naam",
            filters={"id": f"in.({in_list})"},
        )
        out: dict[str, str] = {}
        for r in rows:
            bid = r.get("id")
            naam = r.get("naam")
            if bid is None or naam is None:
                continue
            out[str(bid)] = str(naam)
        return out

    def get_overzicht_destination_counts(
        self,
        *,
        brand: str,
        start_date: date,
        end_date: date,
        destination_id: str | None,
        brand_land: str = "__ALL__",
    ) -> list[dict[str, Any]]:
        """
        Groepeer boekingen op `bestemming_id` met de bijbehorende bestemmingnaam.
        """
        query_params: list[tuple[str, Any]] = [
            ("vertrekdatum", f"gte.{start_date.isoformat()}"),
            ("vertrekdatum", f"lte.{end_date.isoformat()}"),
        ]
        if brand and brand != "__all__":
            query_params.insert(0, ("brand", f'eq."{brand}"'))
        if destination_id:
            query_params.append(("bestemming_id", f"eq.{destination_id}"))
        rows = self._paginate_rest_scan(
            "boekingen",
            select="bestemming_id,brand_land",
            query_params=query_params,
        )

        counts: Counter[str] = Counter()
        for r in rows:
            if not self._matches_brand_land_filter(r.get("brand_land"), brand_land):
                continue
            bid = r.get("bestemming_id")
            if bid is not None:
                counts[str(bid)] += 1

        names_map = self._bestemming_names_map(list(counts.keys()))

        out: list[dict[str, Any]] = []
        for bid, cnt in counts.most_common():
            naam = names_map.get(bid)
            out.append(
                {
                    "id": bid,
                    "naam": naam,
                    "boekingen_count": int(cnt),
                }
            )

        return out

    def get_overzicht_totals(
        self,
        *,
        brand: str,
        start_date: date,
        end_date: date,
        destination_id: str | None,
        brand_land: str = "__ALL__",
    ) -> dict[str, Any]:
        query_params: list[tuple[str, Any]] = [
            ("vertrekdatum", f"gte.{start_date.isoformat()}"),
            ("vertrekdatum", f"lte.{end_date.isoformat()}"),
        ]
        if brand and brand != "__all__":
            query_params.insert(0, ("brand", f'eq."{brand}"'))
        if destination_id:
            query_params.append(("bestemming_id", f"eq.{destination_id}"))
        rows = self._paginate_rest_scan(
            "boekingen_met_omzet",
            select="aantal_reizigers,totaal_te_betalen,brand_land",
            query_params=query_params,
        )
        total_boekingen_i = 0
        total_reizigers_i = 0
        total_omzet_f = 0.0
        for r in rows:
            if not self._matches_brand_land_filter(r.get("brand_land"), brand_land):
                continue
            try:
                total_reizigers_i += int(r.get("aantal_reizigers") or 0)
            except (TypeError, ValueError):
                pass
            total_boekingen_i += 1
            try:
                total_omzet_f += float(r.get("totaal_te_betalen") or 0)
            except (TypeError, ValueError):
                pass

        return {
            "total_boekingen": total_boekingen_i,
            "total_reizigers": total_reizigers_i,
            "total_omzet": total_omzet_f,
        }

    def get_overzicht_booking_trend(
        self,
        *,
        brand: str,
        start_date: date,
        end_date: date,
        destination_id: str | None,
        brand_land: str = "__ALL__",
    ) -> list[dict[str, Any]]:
        query_params: list[tuple[str, Any]] = [
            ("vertrekdatum", f"gte.{start_date.isoformat()}"),
            ("vertrekdatum", f"lte.{end_date.isoformat()}"),
        ]
        if brand and brand != "__all__":
            query_params.insert(0, ("brand", f'eq."{brand}"'))
        if destination_id:
            query_params.append(("bestemming_id", f"eq.{destination_id}"))
        rows = self._paginate_rest_scan(
            "boekingen",
            select="vertrekdatum,aantal_reizigers,brand_land",
            query_params=query_params,
        )

        by_month: dict[tuple[int, int], int] = defaultdict(int)
        for r in rows:
            if not self._matches_brand_land_filter(r.get("brand_land"), brand_land):
                continue
            vd = self._parse_iso_date(r.get("vertrekdatum"))
            if vd is None:
                continue
            try:
                pax = int(r.get("aantal_reizigers") or 0)
            except (TypeError, ValueError):
                pax = 0
            by_month[(vd.year, vd.month)] += pax

        out: list[dict[str, Any]] = []
        for (jaar, maand), totaal in sorted(by_month.items(), key=lambda x: (x[0][0], x[0][1])):
            out.append({"jaar": jaar, "maand": maand, "totaal_reizigers": totaal})

        return out

    def get_overzicht_popular_travel_periods(
        self,
        *,
        brand: str,
        start_date: date,
        end_date: date,
        destination_id: str | None,
        brand_land: str = "__ALL__",
    ) -> list[dict[str, Any]]:
        query_params: list[tuple[str, Any]] = [
            ("vertrekdatum", f"gte.{start_date.isoformat()}"),
            ("vertrekdatum", f"lte.{end_date.isoformat()}"),
        ]
        if brand and brand != "__all__":
            query_params.insert(0, ("brand", f'eq."{brand}"'))
        if destination_id:
            query_params.append(("bestemming_id", f"eq.{destination_id}"))
        rows = self._paginate_rest_scan(
            "boekingen",
            select="vertrekdatum,aantal_reizigers,brand_land",
            query_params=query_params,
        )

        by_week: dict[int, int] = defaultdict(int)
        for r in rows:
            if not self._matches_brand_land_filter(r.get("brand_land"), brand_land):
                continue
            vd = self._parse_iso_date(r.get("vertrekdatum"))
            if vd is None:
                continue
            try:
                week_i = int(vd.isocalendar()[1])
            except (TypeError, ValueError):
                continue
            try:
                pax = int(r.get("aantal_reizigers") or 0)
            except (TypeError, ValueError):
                pax = 0
            by_week[week_i] += pax

        out: list[dict[str, Any]] = []
        for week_i in sorted(by_week.keys()):
            out.append({"week": week_i, "reizigers_sum": by_week[week_i]})

        return out

    # ----------------------------
    # Dagtrends / Bestemmingen aggregaties (DB-side)
    # ----------------------------
    def get_dagtrends_daily_aggregates(
        self,
        *,
        brand: str,
        destination_id: str | None,
        date_column: str,
        date_from: date,
        date_to_exclusive: date,
    ) -> list[dict[str, Any]]:
        brand_filter = f'eq."{brand}"'
        query_params: list[tuple[str, Any]] = [
            ("brand", brand_filter),
            (date_column, f"gte.{date_from.isoformat()}"),
            (date_column, f"lt.{date_to_exclusive.isoformat()}"),
        ]
        if destination_id:
            query_params.append(("bestemming_id", f"eq.{destination_id}"))

        rows = self._rest_select_multi_params(
            "boekingen_met_omzet",
            select=(
                f"dag:date_part('day',{date_column})::int,"
                "boekingen:id.count(),"
                "reizigers:aantal_reizigers.sum(),"
                "omzet_totaal:totaal_te_betalen.sum()"
            ),
            query_params=query_params,
        )

        out: list[dict[str, Any]] = []
        for r in rows:
            try:
                dag = int(r.get("dag"))
            except (TypeError, ValueError):
                continue
            try:
                boekingen = int(r.get("boekingen") or 0)
            except (TypeError, ValueError):
                boekingen = 0
            try:
                reizigers = int(float(r.get("reizigers") or 0))
            except (TypeError, ValueError):
                reizigers = 0
            try:
                omzet = float(r.get("omzet_totaal") or 0)
            except (TypeError, ValueError):
                omzet = 0.0
            out.append(
                {
                    "dag": dag,
                    "boekingen": boekingen,
                    "reizigers": reizigers,
                    "omzet": omzet,
                }
            )
        return out

    def dagtrends_heatmap_month_rows_rpc(
        self,
        *,
        brand: str,
        bestemming_id: str | None,
        left_year: int,
        right_year: int,
        month: int,
        limit: int,
        offset: int,
    ) -> list[dict[str, Any]]:
        params: dict[str, Any] = {
            "p_brand": brand or "__all__",
            "p_bestemming_id": bestemming_id,
            "p_left_year": int(left_year),
            "p_right_year": int(right_year),
            "p_month": int(month),
            "p_limit": int(limit),
            "p_offset": int(offset),
        }
        return self.call_rpc("dagtrends_heatmap_month_rows", params)

    def dagtrends_heatmap_booking_years_rpc(self) -> list[dict[str, Any]]:
        return self.call_rpc("dagtrends_heatmap_booking_years", {})

    def dagtrends_heatmap_bookings_by_booking_date_month_rpc(
        self,
        *,
        brand: str,
        bestemming_id: str | None,
        year: int,
        month: int,
        country: str,
    ) -> list[dict[str, Any]]:
        params: dict[str, Any] = {
            "p_brand": brand or "__all__",
            "p_bestemming_id": bestemming_id,
            "p_year": int(year),
            "p_month": int(month),
            "p_country": country or "__ALL__",
        }
        return self.call_rpc("dagtrends_heatmap_bookings_by_booking_date_month", params)

    def dagtrends_boekingentrends_aggregate_rpc(
        self,
        *,
        brand: str,
        bestemming_id: str | None,
        date_from: date,
        date_to: date,
        prev_from: date,
        prev_to: date,
        country: str,
    ) -> dict[str, Any] | None:
        """DB-side aggregatie voor /dagtrends/boekingentrends-data (geen bulk rows)."""
        params: dict[str, Any] = {
            "p_brand": brand or "__all__",
            "p_bestemming_id": bestemming_id,
            "p_date_from": date_from.isoformat(),
            "p_date_to": date_to.isoformat(),
            "p_prev_from": prev_from.isoformat(),
            "p_prev_to": prev_to.isoformat(),
            "p_country": (country or "__ALL__").strip().upper() or "__ALL__",
        }
        result = self.call_rpc("dagtrends_boekingentrends_aggregate", params)
        if not result:
            return None
        # PostgREST/fout JSON is vaak één object i.p.v. een rij-array; dan gaf rows[0] KeyError(0) → API-error "0".
        if isinstance(result, dict):
            msg = result.get("message") or result.get("error")
            hint = result.get("hint")
            code = result.get("code")
            if msg or hint or code:
                detail = " — ".join(
                    str(p)
                    for p in (msg, code, hint)
                    if p is not None and str(p).strip() != ""
                )
                raise SupabaseServiceError(
                    f"RPC dagtrends_boekingentrends_aggregate: {detail or result!r}"
                )
            return None
        if not isinstance(result, list) or len(result) == 0:
            return None
        row0 = result[0]
        if not isinstance(row0, dict):
            return None
        raw = row0.get("dagtrends_boekingentrends_aggregate")
        if raw is None:
            for _k, v in row0.items():
                if isinstance(v, dict):
                    raw = v
                    break
        if raw is None:
            return None
        if isinstance(raw, str):
            import json

            raw = json.loads(raw)
        return raw if isinstance(raw, dict) else None

    def bestemmingen_periodes_vertrek_jaren_rpc(
        self,
        *,
        brand: str,
        bestemming_id: str | None,
    ) -> list[dict[str, Any]]:
        params: dict[str, Any] = {
            "p_brand": brand or "__all__",
            "p_bestemming_id": bestemming_id,
        }
        return self.call_rpc("bestemmingen_periodes_vertrek_jaren", params)

    @staticmethod
    def _klantenprofiel_inner_payload(row: dict[str, Any]) -> dict[str, Any] | None:
        """Haal de geneste json uit de PostgREST-rij (functienaam-key, of de volledige payload)."""
        if "klantenprofiel_dashboard" in row and isinstance(row["klantenprofiel_dashboard"], dict):
            return row["klantenprofiel_dashboard"]
        if "klantenprofiel_repeat_dashboard" in row and isinstance(row["klantenprofiel_repeat_dashboard"], dict):
            return row["klantenprofiel_repeat_dashboard"]
        # Reponse soms zonder wrapper: meta + kpis_cur + … op hetzelfde niveau
        if "kpis_cur" in row:
            return row
        for v in row.values():
            if isinstance(v, dict) and "kpis_cur" in v:
                return v
        for v in row.values():
            if isinstance(v, dict):
                return v
        return None

    @staticmethod
    def _normalize_uuid_list(values: list[str] | None) -> list[str] | None:
        out: list[str] = []
        for raw in values or []:
            txt = str(raw or "").strip()
            if not txt:
                continue
            try:
                out.append(str(UUID(txt)))
            except (TypeError, ValueError, AttributeError):
                continue
        return out or None

    def klantenprofiel_dashboard_rpc(
        self,
        *,
        year: int,
        brand: str,
        bestemmingen_ids: list[str] | None,
        period: str,
        origin: str,
        compare_prev_year: bool,
        holiday_ranges: list[dict[str, str]] | None,
        holiday_ranges_prev: list[dict[str, str]] | None,
        brand_land: str | None = None,
        reiziger_land: str | None = None,
        reiziger_provincies: list[str] | None = None,
        leeftijdsgroepen: list[str] | None = None,
    ) -> dict[str, Any]:
        prov_values = [str(x).strip() for x in (reiziger_provincies or []) if str(x).strip()]
        leeftijd_values = [str(x).strip() for x in (leeftijdsgroepen or []) if str(x).strip()]
        params: dict[str, Any] = {
            "p_year": int(year),
            "p_brand": brand or "__all__",
            "p_bestemming_ids": self._normalize_uuid_list(bestemmingen_ids),
            "p_period": (period or "all").strip().lower(),
            "p_origin": (origin or "__ALL__").strip(),
            "p_reiziger_land": (reiziger_land or "").strip() or None,
            "p_reiziger_provincies": prov_values or None,
            "p_leeftijdsgroepen": leeftijd_values or None,
            "p_brand_land": (brand_land or "__ALL__").strip(),
            "p_compare_prev": bool(compare_prev_year),
            "p_holiday_ranges": holiday_ranges,
            "p_holiday_ranges_prev": holiday_ranges_prev if compare_prev_year else None,
        }
        raw_response: Any = self.call_rpc("klantenprofiel_dashboard", params)

        # PostgREST: meestal een array met één rij; soms alleen een object zonder array — nooit rows[0] op een dict.
        if isinstance(raw_response, dict):
            msg = raw_response.get("message") or raw_response.get("error")
            if msg or raw_response.get("code"):
                parts = [
                    raw_response.get("message"),
                    raw_response.get("code"),
                    raw_response.get("details"),
                    raw_response.get("hint"),
                ]
                detail = " — ".join(str(p) for p in parts if p is not None and str(p).strip())
                raise SupabaseServiceError(f"RPC klantenprofiel_dashboard: {detail or raw_response!r}")
            inner = self._klantenprofiel_inner_payload(raw_response)
            if inner is not None:
                return inner
            rows: list[Any] = [raw_response]
        elif isinstance(raw_response, list):
            rows = raw_response
        else:
            return {"error": f"Onverwacht RPC-antwoord: {type(raw_response).__name__}"}

        if not rows:
            return {"error": "Lege RPC-response (deploy sql/rpc/klantenprofiel_rpc.sql in Supabase)."}
        row0 = rows[0]
        if not isinstance(row0, dict):
            return {"error": "Onverwachte RPC-response (geen object)."}
        inner = self._klantenprofiel_inner_payload(row0)
        if inner is not None:
            return inner
        _logger.warning("klantenprofiel_dashboard: geen bruikbare dict in eerste rij, keys=%s", list(row0.keys()))
        return {
            "error": "Onverwachte RPC-response van klantenprofiel_dashboard (geen JSON-object). Controleer of de functie jsonb retourneert.",
            "rpc_row_keys": list(row0.keys()),
        }

    def klantenprofiel_repeat_dashboard_rpc(
        self,
        *,
        year: int,
        brand: str,
        bestemmingen_ids: list[str] | None,
        period: str,
        origin: str,
        brand_land: str | None = None,
        reiziger_land: str | None = None,
        reiziger_provincies: list[str] | None = None,
        leeftijdsgroepen: list[str] | None = None,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {
            "p_year": int(year),
            "p_brand": brand or "__all__",
            "p_bestemming_ids": self._normalize_uuid_list(bestemmingen_ids),
            "p_period": (period or "all").strip().lower(),
            "p_origin": (origin or "__ALL__").strip(),
            "p_reiziger_land": (reiziger_land or "").strip() or None,
            "p_reiziger_provincies": [str(x).strip() for x in (reiziger_provincies or []) if str(x).strip()] or None,
            "p_leeftijdsgroepen": [str(x).strip() for x in (leeftijdsgroepen or []) if str(x).strip()] or None,
            "p_brand_land": (brand_land or "__ALL__").strip(),
        }
        raw_response: Any = self.call_rpc("klantenprofiel_repeat_dashboard", params)
        if isinstance(raw_response, dict):
            msg = raw_response.get("message") or raw_response.get("error")
            if msg or raw_response.get("code"):
                parts = [
                    raw_response.get("message"),
                    raw_response.get("code"),
                    raw_response.get("details"),
                    raw_response.get("hint"),
                ]
                detail = " — ".join(str(p) for p in parts if p is not None and str(p).strip())
                raise SupabaseServiceError(f"RPC klantenprofiel_repeat_dashboard: {detail or raw_response!r}")
            inner = self._klantenprofiel_inner_payload(raw_response)
            if inner is not None:
                return inner
            rows: list[Any] = [raw_response]
        elif isinstance(raw_response, list):
            rows = raw_response
        else:
            return {"error": f"Onverwacht RPC-antwoord: {type(raw_response).__name__}"}

        if not rows:
            return {"error": "Lege RPC-response (deploy sql/rpc/klantenprofiel_rpc.sql in Supabase)."}
        row0 = rows[0]
        if not isinstance(row0, dict):
            return {"error": "Onverwachte RPC-response (geen object)."}
        inner = self._klantenprofiel_inner_payload(row0)
        if inner is not None:
            return inner
        _logger.warning("klantenprofiel_repeat_dashboard: geen bruikbare dict in eerste rij, keys=%s", list(row0.keys()))
        return {
            "error": "Onverwachte RPC-response van klantenprofiel_repeat_dashboard (geen JSON-object).",
            "rpc_row_keys": list(row0.keys()),
        }

    def bestemmingen_periodes_bookings_year_rpc(
        self,
        *,
        year: int,
        brand: str,
        bestemming_id: str | None,
        country: str,
        brand_land: str | None = None,
    ) -> list[dict[str, Any]]:
        params: dict[str, Any] = {
            "p_year": int(year),
            "p_brand": brand or "__all__",
            "p_bestemming_id": bestemming_id,
            "p_country": (country or "__ALL__").strip(),
            "p_brand_land": (brand_land or "__ALL__").strip(),
        }
        return self.call_rpc("bestemmingen_periodes_bookings_year", params)

    def bestemmingen_periodes_transport_split_year_rpc(
        self,
        *,
        year: int,
        brand: str,
        bestemming_id: str | None,
        country: str,
        brand_land: str | None = None,
    ) -> list[dict[str, Any]]:
        params: dict[str, Any] = {
            "p_year": int(year),
            "p_brand": brand or "__all__",
            "p_bestemming_id": bestemming_id,
            "p_country": (country or "__ALL__").strip(),
            "p_brand_land": (brand_land or "__ALL__").strip(),
        }
        return self.call_rpc("bestemmingen_periodes_transport_split_year", params)

    def bestemmingen_periodes_traveler_origin_donut_rpc(
        self,
        *,
        date_from: str,
        date_to: str,
        bestemming_id: str | None,
        effective_brand: str,
    ) -> list[dict[str, Any]]:
        params: dict[str, Any] = {
            "p_date_from": date_from,
            "p_date_to": date_to,
            "p_bestemming_id": bestemming_id,
            "p_effective_brand": (effective_brand or "Sun Escapes").strip(),
        }
        return self.call_rpc("bestemmingen_periodes_traveler_origin_donut", params)

    def bestemmingen_periodes_transport_debug_rpc(
        self,
        *,
        year: int,
        brand: str,
        bestemming_id: str | None,
        brand_land: str | None = None,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {
            "p_year": int(year),
            "p_brand": brand or "__all__",
            "p_bestemming_id": bestemming_id,
            "p_brand_land": (brand_land or "__ALL__").strip(),
        }
        raw = self.call_rpc("bestemmingen_periodes_transport_debug", params)
        payload = self._unwrap_postgrest_scalar_jsonb_response(raw)
        return payload if isinstance(payload, dict) else {}

    def klantenprofiel_traveler_origin_donut_rpc(
        self,
        *,
        year: int,
        brand: str,
        bestemmingen_ids: list[str] | None,
        period: str,
        origin: str,
        brand_land: str | None,
        holiday_ranges: list[dict[str, str]] | None,
        effective_brand: str,
        reiziger_land: str | None = None,
        reiziger_provincies: list[str] | None = None,
        leeftijdsgroepen: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        params: dict[str, Any] = {
            "p_year": int(year),
            "p_brand": brand or "__all__",
            "p_bestemming_ids": self._normalize_uuid_list(bestemmingen_ids),
            "p_period": (period or "all").strip().lower(),
            "p_origin": (origin or "__ALL__").strip(),
            "p_reiziger_land": (reiziger_land or "").strip() or None,
            "p_reiziger_provincies": [str(x).strip() for x in (reiziger_provincies or []) if str(x).strip()] or None,
            "p_leeftijdsgroepen": [str(x).strip() for x in (leeftijdsgroepen or []) if str(x).strip()] or None,
            "p_brand_land": (brand_land or "__ALL__").strip(),
            "p_holiday_ranges": holiday_ranges,
            "p_effective_brand": (effective_brand or "Sun Escapes").strip(),
        }
        return self.call_rpc("klantenprofiel_traveler_origin_donut", params)

    def _name_map_for_ids(self, table: str, ids: list[str], *, select: str = "id,naam") -> dict[str, dict[str, Any]]:
        uniq = sorted({x for x in ids if x})
        if not uniq:
            return {}
        out: dict[str, dict[str, Any]] = {}
        chunk_size = 200
        for i in range(0, len(uniq), chunk_size):
            chunk = uniq[i : i + chunk_size]
            in_list = ",".join(chunk)
            rows = self._rest_select(table, select=select, filters={"id": f"in.({in_list})"})
            for r in rows:
                rid = r.get("id")
                if rid is None:
                    continue
                out[str(rid)] = r
        return out

    def get_bestemmingen_aggregates(
        self,
        *,
        brand: str,
        destination_id: str | None,
        date_from: date | None,
        date_to: date | None,
    ) -> dict[str, Any]:
        brand_filter = f'eq."{brand}"'
        query_params: list[tuple[str, Any]] = [("brand", brand_filter)]
        if destination_id:
            query_params.append(("bestemming_id", f"eq.{destination_id}"))
        if date_from:
            query_params.append(("boekingsdatum", f"gte.{date_from.isoformat()}"))
        if date_to:
            query_params.append(("boekingsdatum", f"lte.{date_to.isoformat()}"))

        totals_rows = self._rest_select_multi_params(
            "boekingen_met_omzet",
            select=(
                "bestemming_id,"
                "boekingen:id.count(),"
                "omzet_totaal:totaal_te_betalen.sum(),"
                "reizigers:aantal_reizigers.sum()"
            ),
            query_params=query_params,
        )
        audience_rows = self._rest_select_multi_params(
            "boekingen",
            select="bestemming_id,doelgroep_id,boekingen:id.count()",
            query_params=query_params,
        )
        hotels_rows = self._rest_select_multi_params(
            "boekingen",
            select="bestemming_id,accommodatie_id,boekingen:id.count()",
            query_params=query_params,
        )
        trends_rows = self._rest_select_multi_params(
            "boekingen",
            select=(
                "bestemming_id,"
                "jaar:date_part('year',boekingsdatum)::int,"
                "maand:date_part('month',boekingsdatum)::int,"
                "boekingen:id.count()"
            ),
            query_params=query_params,
        )
        season_rows = self._rest_select_multi_params(
            "boekingen",
            select=(
                "bestemming_id,"
                "maand:date_part('month',vertrekdatum)::int,"
                "boekingen:id.count()"
            ),
            query_params=query_params,
        )

        bestemming_ids = [str(r.get("bestemming_id")) for r in totals_rows if r.get("bestemming_id")]
        doelgroep_ids = [str(r.get("doelgroep_id")) for r in audience_rows if r.get("doelgroep_id")]
        accommodatie_ids = [str(r.get("accommodatie_id")) for r in hotels_rows if r.get("accommodatie_id")]

        bestemmingen_map = self._name_map_for_ids("bestemmingen", bestemming_ids, select="id,naam")
        doelgroepen_map = self._name_map_for_ids("doelgroepen", doelgroep_ids, select="id,naam")
        accommodaties_map = self._name_map_for_ids(
            "accommodaties",
            accommodatie_ids,
            select="id,naam,type,bestemming_id",
        )

        return {
            "totals_rows": totals_rows,
            "audience_rows": audience_rows,
            "hotels_rows": hotels_rows,
            "trends_rows": trends_rows,
            "season_rows": season_rows,
            "bestemmingen_map": bestemmingen_map,
            "doelgroepen_map": doelgroepen_map,
            "accommodaties_map": accommodaties_map,
        }

