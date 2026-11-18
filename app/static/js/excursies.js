/**
 * TravelAnalytics — Excursies
 *
 * Modulaire objecten: ExcursionsPage, ExcursionsFilters, ExcursionsKPIGrid,
 * ExcursionsPerformanceSection, ExcursionsRevenueSection (inclusief uptake per bestemming),
 * ExcursionsSalesChannelSection, ExcursionsTimingSection, ExcursionsPaymentsSection,
 * ExcursionsDestinationsSection, ExcursionsTableSection.
 *
 * BUSINESS RULE: server sluit cancelled/dropped + Whole booking cancelled uit; client filtert
 * extra op kanaal en betaaloptie.
 *
 * Jaarfilter: uitsluitend in public.excursies_lines_rpc (Supabase), op basis van
 * coalesce(vertrekdatum, boekingsdatum, datum_toegevoegd op boeking_excursies).
 * De frontend stuurt alleen ?year=; er is geen apart datumveld in de UI.
 *
 * Winst-definitie (business): som(verkoopprijs - inkoopprijs) voor regels met bekende inkoopprijs.
 * Regels zonder expliciete inkoopprijs tellen niet mee in winst (maar blijven zichtbaar in waarschuwingen).
 */
(() => {
  const RBAC = window.__RBAC__ || {};
  const IS_RESTRICTED_ROLE = Boolean(RBAC.isRestricted);
  const FORCED_YEAR = Number(RBAC.currentYear) || new Date().getFullYear();
  const COL = {
    orange: "#ea580c",
    orangeSoft: "rgba(234, 88, 12, 0.15)",
    green: "#16a34a",
    greenSoft: "rgba(22, 163, 74, 0.15)",
    red: "#dc2626",
    gray: "#9ca3af",
    slate: "#64748b",
  };

  const nfMoney = new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" });
  const nfPct = new Intl.NumberFormat("nl-NL", {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  const nfInt = new Intl.NumberFormat("nl-NL", { maximumFractionDigits: 0 });
  const nfDec = new Intl.NumberFormat("nl-NL", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const nfDec2 = new Intl.NumberFormat("nl-NL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function formatUiDateSlash(value, fallback = "") {
    const raw = String(value || "").trim();
    if (!raw) return fallback;
    if (window.TADate && typeof window.TADate.formatDate === "function") {
      const out = window.TADate.formatDate(raw, raw);
      if (out && out !== raw) return out.replace(/-/g, "/");
    }
    const iso = raw.match(/^(\d{4})[-/](\d{2})[-/](\d{2})(?:[T ].*)?$/);
    if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
    return raw;
  }

  function formatYearMonthSlash(value, fallback = "") {
    const raw = String(value || "").trim();
    if (!raw) return fallback;
    const ym = raw.match(/^(\d{4})-(\d{2})$/);
    if (ym) return `${ym[2]}/${ym[1]}`;
    const ymd = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (ymd) return `${ymd[2]}/${ymd[1]}`;
    return fallback || raw;
  }

  /** @param {unknown} x */
  function num(x) {
    const v = Number(x);
    return Number.isFinite(v) ? v : 0;
  }

  /** @param {unknown} value */
  function normalizedLandCodeFromValue(value) {
    const raw = String(value || "")
      .trim()
      .toUpperCase();
    if (!raw) return "";
    if (raw === "BE" || raw === "BELGIE" || raw === "BELGIË") return "BE";
    if (raw === "NL" || raw === "NEDERLAND" || raw === "THE NETHERLANDS") return "NL";
    return raw;
  }

  /** @param {Record<string, unknown>} r */
  function normalizedLandCode(r) {
    return normalizedLandCodeFromValue(r.land);
  }

  /**
   * @param {number} dividend
   * @param {number} divisor
   * @returns {number | null}
   */
  function safeDivide(dividend, divisor) {
    if (!Number.isFinite(dividend) || !Number.isFinite(divisor) || divisor <= 0) return null;
    return dividend / divisor;
  }

  /** @param {unknown} x */
  function moneyOrNull(x) {
    if (x == null || x === "") return null;
    const v = Number(x);
    return Number.isFinite(v) ? v : null;
  }

  /**
   * @param {Record<string, unknown>} r
   * @param {number} verkoop
   */
  function resolveCommissie(r, verkoop) {
    const berekend = moneyOrNull(r.berekende_commissie);
    if (berekend != null) return Math.max(0, berekend);
    const direct = moneyOrNull(r.commissie);
    if (direct != null) return Math.max(0, direct);
    const pct = moneyOrNull(r.commissie_percentage);
    if (pct == null) return 0;
    return Math.max(0, (verkoop * pct) / 100);
  }

  /** @param {Record<string, unknown>} r */
  function hasExplicitInkoopPrijs(r) {
    // Alleen expliciet ingegeven inkoopprijzen mogen winst opleveren.
    // Als deze vlag ontbreekt in oudere payloads, rekenen we conservatief: geen winst.
    const explicit = r.inkoopprijs_ingegeven;
    return explicit === true || explicit === "true" || explicit === 1;
  }

  /** @param {Record<string, unknown>} r */
  function hasUsableInkoopPrijs(r) {
    // Een geldige inkoopprijs vereist:
    //   - waarde is gezet (niet null/leeg)
    //   - waarde is strikt > 0 (0 betekent "nog niet ingevoerd", geen gratis-inkoop)
    //   - er bestaat een jaarkosten-rij waar de inkoopprijs expliciet voor dit jaar is ingevoerd
    // Zonder deze drie vallen we terug op winst = 0 om geen onterechte marge te tonen.
    const direct = moneyOrNull(r.inkoop_prijs);
    return direct != null && direct > 0 && hasExplicitInkoopPrijs(r);
  }

  /** @param {Record<string, unknown>} r */
  function resolveInkoopPrijs(r) {
    if (hasUsableInkoopPrijs(r)) {
      const direct = moneyOrNull(r.inkoop_prijs);
      if (direct != null) return Math.max(0, direct);
    }
    // Business safeguard:
    // Zolang er geen expliciete (>0) inkoopprijs is ingevuld, behandelen we de inkoop
    // gelijk aan de verkoopprijs. Daardoor wordt winst (verkoop - inkoop) altijd 0 en
    // kan ontbrekende kostdata nooit als winst worden gepresenteerd.
    const verkoop = num(r.verkoop_prijs);
    return Math.max(0, verkoop);
  }

  /** @param {Record<string, unknown>} r */
  function calcWinst(r) {
    if (!hasUsableInkoopPrijs(r)) return 0;
    const verkoop = num(r.verkoop_prijs);
    const inkoop = resolveInkoopPrijs(r);
    return verkoop - inkoop;
  }

  /** @param {Record<string, unknown>} r */
  function isActiveBookingRow(r) {
    const s = String(r.booking_status || "")
      .toLowerCase()
      .trim();
    if (!s) return true;
    // Processing-statussen blijven zichtbaar op Excursies-pagina.
    if (s.startsWith("processing")) return true;
    if (["cancelled", "canceled", "cancel", "geannuleerd", "gecanceld", "annulatie", "annulering", "annule", "annulé", "dropped"].includes(s)) return false;
    // Niet `includes("annul")`: dat matcht ook "niet geannuleerd" (substring in geannuleerd).
    if (s.includes("niet") && s.includes("geannuleerd")) return true;
    if (s.includes("geannuleerd") && !s.includes("niet")) return false;
    return true;
  }

  /** @param {Record<string, unknown>} r */
  function isPending(r) {
    const p = r.betaling_pending;
    if (p === true || p === "true" || p === 1) return true;
    const t = String(p || "").toLowerCase();
    return t === "ja" || t === "yes" || t === "pending";
  }

  /** @param {Record<string, unknown>} r */
  function normalizedPayOption(r) {
    if (num(r.verkoop_prijs) === 0) return "free";
    const pay = String(r.betaaloptie || "").trim().toLowerCase();
    return pay || "onbekend";
  }

  /** @param {Record<string, unknown>} r */
  function participantUnitsForRow(r) {
    const pax = num(r.booking_pax);
    return pax > 0 ? pax : 1;
  }

  const charts = {};
  /** @param {string} id */
  function destroyChart(id) {
    if (charts[id]) {
      charts[id].destroy();
      charts[id] = null;
    }
  }

  function createChartPaginator(pageSize) {
    if (typeof window.TAPaginatedChartData === "function") {
      return new window.TAPaginatedChartData(pageSize);
    }
    return {
      pageSize,
      offset: 0,
      items: [],
      setItems(items) {
        this.items = Array.isArray(items) ? items.slice() : [];
        const maxOffset = Math.max(0, Math.floor((Math.max(0, this.items.length - 1)) / this.pageSize) * this.pageSize);
        this.offset = Math.max(0, Math.min(this.offset, maxOffset));
      },
      setOffset(offset) {
        const raw = Number.isFinite(Number(offset)) ? Number(offset) : 0;
        const maxOffset = Math.max(0, Math.floor((Math.max(0, this.items.length - 1)) / this.pageSize) * this.pageSize);
        this.offset = Math.max(0, Math.min(raw, maxOffset));
      },
      getWindow() {
        return this.items.slice(this.offset, this.offset + this.pageSize);
      },
      canPrev() {
        return this.offset > 0;
      },
      canNext() {
        return this.offset + this.pageSize < this.items.length;
      },
      prevPage() {
        this.setOffset(this.offset - this.pageSize);
      },
      nextPage() {
        this.setOffset(this.offset + this.pageSize);
      },
      getInfo() {
        if (!this.items.length) return { start: 0, end: 0, total: 0 };
        return {
          start: this.offset + 1,
          end: Math.min(this.offset + this.pageSize, this.items.length),
          total: this.items.length,
        };
      },
    };
  }

  /** @type {Record<string, unknown>[]} */
  let POOL_CUR = [];
  /** @type {Record<string, unknown>[]} */
  let POOL_PREV = [];
  /** @type {Record<string, unknown>[]} */
  let POOL_TWO = [];
  /** @type {Record<string, unknown>} */
  let META_CUR = {};
  /** @type {Record<string, unknown>} */
  let META_PREV = {};
  /** @type {Record<string, unknown>} */
  let META_TWO = {};
  /** @type {Record<string, unknown>[]} */
  let POOL_DEST_CUR = [];

  /** Aantal rijen uit JSON vóór client-side statusfilter (laatste load van huidige jaar-pool). */
  let LAST_RAW_RPC_ROW_COUNT = 0;

  let _optionsYears = [];
  let _optionsBrands = [];
  let _optionsLanden = [];
  /** @type {Array<{ naam?: string }>} */
  let _optionsDest = [];
  /** @type {Array<Record<string, unknown>>} */
  let _manageExcursions = [];
  /** @type {Array<{ key: string, naam: string, bestemming_naam?: string, label: string }>} */
  let _excursieOptions = [];
  let _betaalopties = ["cash", "mollie", "overschrijving", "free"];
  let _destTabSelection = "";
  /** @type {InstanceType<typeof window.TAMultiSelectFilter> | null} */
  let excDestMulti = null;
  /** @type {InstanceType<typeof window.TAMultiSelectFilter> | null} */
  let excExcursieMulti = null;

  /** Paginatie top-excursies grafiek (Volumes & mix), max 7 per pagina. */
  let _perfExcPage = 0;
  const PERF_EXC_PAGE_SIZE = 7;
  const DEST_REV_PAGE_SIZE = 10;
  const revDestPaginator = createChartPaginator(DEST_REV_PAGE_SIZE);
  const DEST_UPTAKE_PAGE_SIZE = 10;
  const destUptakePaginator = createChartPaginator(DEST_UPTAKE_PAGE_SIZE);

  /** Sorteerbare tabellen (baseline in TA_wireSortableTable). */
  let excRevSummaryRows = /** @type {Record<string, unknown>[]} */ ([]);
  let excDestTabTableRows = /** @type {Record<string, unknown>[]} */ ([]);
  let excPayPendingRows = /** @type {Record<string, unknown>[]} */ ([]);
  let excDetailTableRows = /** @type {Record<string, unknown>[]} */ ([]);
  /** @type {ReturnType<typeof ExcursionsFilters.getDraftState> | null} */
  let APPLIED_FILTER_STATE = null;
  /** @type {AbortController | null} */
  let REFRESH_ABORT_CONTROLLER = null;
  let REFRESH_SEQ = 0;
  /** @type {Map<string, { rows: Record<string, unknown>[], meta: Record<string, unknown>, rawRpcRowCount: number }>} */
  const EXCURSIONS_DATA_CACHE = new Map();
  /** @type {Map<string, Promise<{ rows: Record<string, unknown>[], meta: Record<string, unknown>, rawRpcRowCount: number }>>} */
  const EXCURSIONS_INFLIGHT = new Map();
  let APPLY_DEBOUNCE_TIMER = null;

  function normalizePath(p) {
    if (p == null || typeof p !== "string") return "";
    const t = p.trim();
    if (!t) return "";
    return t.replace(/\/+$/, "") || "/";
  }

  function pickApiBase(pagePath, serverPath) {
    const page = normalizePath(pagePath);
    const srv = normalizePath(serverPath);
    if (!srv) return page;
    if (!page || page === "/") return srv;
    if (page === srv) return page;
    if (page.endsWith(srv)) return page;
    if (srv.endsWith(page)) return srv;
    return page;
  }

  const pageBase = normalizePath(window.location.pathname);
  const serverBase =
    typeof window.__EXCURSIONS_API_BASE__ === "string" ? window.__EXCURSIONS_API_BASE__.trim() : "";
  const mergedBase = pickApiBase(pageBase, serverBase);
  const mountBase = mergedBase.replace(/\/excursies$/i, "");
  const OPTIONS_URL =
    typeof window.__EXCURSIONS_OPTIONS_URL__ === "string" && window.__EXCURSIONS_OPTIONS_URL__.trim()
      ? window.__EXCURSIONS_OPTIONS_URL__.trim()
      : `${mountBase}/excursies/options`;
  const DATA_URL =
    typeof window.__EXCURSIONS_DATA_URL__ === "string" && window.__EXCURSIONS_DATA_URL__.trim()
      ? window.__EXCURSIONS_DATA_URL__.trim()
      : `${mountBase}/excursies/data`;
  const MANAGE_URL =
    typeof window.__EXCURSIONS_MANAGE_URL__ === "string" && window.__EXCURSIONS_MANAGE_URL__.trim()
      ? window.__EXCURSIONS_MANAGE_URL__.trim()
      : `${mountBase}/excursies/manage`;

  /** `?exc_debug=1` in URL: console.log ruwe RPC, geen client-side filters (status/kanaal/betaal). */
  const EXCURSIONS_DEBUG =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("exc_debug") === "1";

  const fetchJson = {
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "X-Requested-With": "XMLHttpRequest",
    },
  };

  async function readJsonResponse(res, label) {
    const text = await res.text();
    const trimmed = (text || "").trimStart();
    if (!trimmed) throw new Error(`${label}: lege response (HTTP ${res.status}).`);
    if (trimmed.startsWith("<")) {
      throw new Error(
        `${label}: server antwoordde met HTML (${res.status}). Controleer login en URL van /excursies/data.`,
      );
    }
    let data = {};
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`${label}: ongeldige JSON (HTTP ${res.status}).`);
    }
    if (!res.ok) {
      const d = data && typeof data === "object" ? data : null;
      const piece = d && (d.error ?? d.message);
      const msg =
        piece != null && String(piece).trim() !== ""
          ? String(piece).trim()
          : `${label}: HTTP ${res.status}`;
      throw new Error(msg);
    }
    return data;
  }

  function showError(msg) {
    const err = document.getElementById("excursionsError");
    if (!err) return;
    err.textContent = msg;
    err.classList.remove("d-none");
  }

  function showSuccess(msg) {
    const el = document.getElementById("excursionsSuccess");
    if (!el) return;
    el.textContent = msg;
    el.classList.remove("d-none");
  }

  function clearError() {
    const err = document.getElementById("excursionsError");
    if (!err) return;
    err.classList.add("d-none");
    err.textContent = "";
  }

  function clearSuccess() {
    const el = document.getElementById("excursionsSuccess");
    if (!el) return;
    el.classList.add("d-none");
    el.textContent = "";
  }

  /**
   * @param {Record<string, unknown>} meta
   * @param {number} filteredRowCount — na applyClientRows (kanaal/betaal/pending/online)
   * @param {number} rawRpcRowCount — rijen in JSON vóór client-side annulatie-filter
   * @param {number} afterStatusRowCount — POOL_CUR: na annulatie-filter, vóór kanaal/betaal
   */
  function setEmptyDataBanner(meta, filteredRowCount, rawRpcRowCount, afterStatusRowCount) {
    const el = document.getElementById("excursionsEmptyData");
    if (!el) return;
    if (meta && meta.fallback === "mock") {
      el.classList.add("d-none");
      return;
    }
    if (filteredRowCount === 0) {
      el.innerHTML =
        "<strong>Geen excursies gevonden.</strong> " +
        "Er zijn momenteel geen excursiegegevens beschikbaar voor de geselecteerde filters. " +
        "Pas de filters aan of controleer of er excursies aan boekingen gekoppeld zijn.";
      el.classList.remove("d-none");
    } else {
      el.classList.add("d-none");
      el.textContent = "";
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  /** @param {Record<string, unknown>} r */
  function excursionDestinationLabel(r) {
    return String(r.destination ?? r.bestemming_naam ?? "").trim() || "—";
  }

  /** Unieke sleutel: excursienaam + bestemming (geen merge over bestemmingen heen). */
  function excursionCompositeKey(r) {
    const nm = String(r.excursie_naam ?? "").trim() || "—";
    return `${nm}\u0001${excursionDestinationLabel(r)}`;
  }

  /** @param {Record<string, unknown>} r */
  function excursionDisplayLabel(r) {
    const nm = String(r.excursie_naam ?? "").trim() || "—";
    const d = excursionDestinationLabel(r);
    return d !== "—" ? `${nm} – ${d}` : nm;
  }

  /** @param {string} s */
  function truncateChartLabel(s, maxLen = 34) {
    const t = String(s || "");
    if (t.length <= maxLen) return t;
    return `${t.slice(0, Math.max(0, maxLen - 1))}…`;
  }

  /** @param {string} value */
  function normText(value) {
    return String(value || "").trim().toLowerCase();
  }

  function pickDefaultDestinationName() {
    const names = _optionsDest
      .map((d) => String((d && (d.naam || d.name)) || "").trim())
      .filter(Boolean);
    const exact = names.find((n) => normText(n) === "albufeira");
    if (exact) return exact;
    const fuzzy = names.find((n) => normText(n).includes("albufeira"));
    if (fuzzy) return fuzzy;
    return names[0] || "";
  }

  /** Alle bestemmingsnamen uit opties (voor volledige grafiek-assen). */
  function getAllDestinationNamesSorted() {
    const names = _optionsDest
      .map((d) => String((d && (d.naam || d.name)) || "").trim())
      .filter(Boolean);
    return [...new Set(names)].sort((a, b) => a.localeCompare(b, "nl"));
  }

  /**
   * Top-excursies op aantal regels — altijd naam + bestemming als identiteit.
   * @returns {{ key: string, label: string, n: number, naam: string, dest: string }[]}
   */
  function getPerfExcursionStats(rows) {
    /** @type {Map<string, { key: string, label: string, n: number, naam: string, dest: string }>} */
    const m = new Map();
    for (const raw of rows) {
      const r = /** @type {Record<string, unknown>} */ (raw);
      const key = excursionCompositeKey(r);
      const cur =
        m.get(key) ||
        ({
          key,
          label: excursionDisplayLabel(r),
          n: 0,
          naam: String(r.excursie_naam ?? "").trim() || "—",
          dest: excursionDestinationLabel(r),
        });
      cur.n += 1;
      m.set(key, cur);
    }
    return [...m.values()].sort((a, b) => b.n - a.n || a.label.localeCompare(b.label, "nl"));
  }

  /**
   * Leest optionele query params (?year=&brand=&destination=&excursie=&channel=&pay=) in de formulieren.
   */
  function readExcursionFiltersFromUrl() {
    const sp = new URLSearchParams(window.location.search);
    const y = document.getElementById("excYear");
    const brand = document.getElementById("excBrand");
    const dest = document.getElementById("excDest");
    const ex = document.getElementById("excExcursie");
    const ch = document.getElementById("excChannel");
    const pay = document.getElementById("excPay");
    const land = document.getElementById("excLand");
    if (sp.has("year") && y && !IS_RESTRICTED_ROLE) {
      const v = sp.get("year");
      if (v != null && [...y.options].some((o) => o.value === v)) y.value = v;
    }
    if (sp.has("brand") && brand) {
      const v = sp.get("brand");
      if (v != null && [...brand.options].some((o) => o.value === v)) brand.value = v;
    }
    if (sp.has("destination")) {
      const values = splitCsvValues(sp.get("destination"));
      if (excDestMulti) excDestMulti.setValue(values);
      else if (dest) {
        const v = values[0];
        if (v != null && [...dest.options].some((o) => o.value === v)) dest.value = v;
      }
    }
    if (sp.has("excursie")) {
      const values = splitCsvValues(sp.get("excursie"));
      if (excExcursieMulti) excExcursieMulti.setValue(values);
      else if (ex) ex.value = values[0] || "";
    }
    if (sp.has("channel") && ch) {
      const v = sp.get("channel");
      if (v != null && [...ch.options].some((o) => o.value === v)) ch.value = v;
    }
    if (sp.has("pay") && pay) {
      const v = sp.get("pay");
      if (v != null && [...pay.options].some((o) => o.value === v)) pay.value = v;
    }
    if (sp.has("land") && land) {
      const v = sp.get("land");
      if (v != null && [...land.options].some((o) => o.value === v)) land.value = v;
    }
  }

  /** Zet huidige toegepaste filters in de URL (replaceState, geen extra history-entry). */
  function syncExcursionFiltersToUrl() {
    const st = ExcursionsFilters.getState();
    const params = new URLSearchParams();
    if (st.year > 0) params.set("year", String(st.year));
    if (st.brand && st.brand !== "__all__") params.set("brand", st.brand);
    if (Array.isArray(st.dests) && st.dests.length) params.set("destination", st.dests.join(","));
    if (Array.isArray(st.excursies) && st.excursies.length) params.set("excursie", st.excursies.join(","));
    if (st.channel && st.channel !== "__all__") params.set("channel", st.channel);
    if (st.pay && st.pay !== "__all__") params.set("pay", st.pay);
    if (st.land && st.land !== "__all__") params.set("land", st.land);
    const qs = params.toString();
    const path = window.location.pathname || "/";
    const next = qs ? `${path}?${qs}` : path;
    try {
      window.history.replaceState({}, "", next);
    } catch {
      /* ignore */
    }
  }

  /** Vult #excursionsDebugBanner met server- + UI-info wanneer ?exc_debug=1. */
  function updateDebugBanner(meta, st) {
    if (!EXCURSIONS_DEBUG) return;
    const dbg = document.getElementById("excursionsDebugBanner");
    if (!dbg) return;
    dbg.classList.remove("d-none");
    const m = meta && typeof meta === "object" ? meta : {};
    const payload = {
      client_filters_disabled: true,
      note:
        "Client filtert geen status/kanaal/betaal in deze modus. Zie ook browserconsole [Excursies DEBUG].",
      ui_filters_snapshot: {
        brand: st.brand,
        destination: st.dest,
        land: st.land,
        year: st.year,
        excursie: st.excursie,
        channel: st.channel,
        pay: st.pay,
      },
      server_debug: m.debug,
      server_debug_rpc: m.debug_rpc,
      year_filter_basis: m.year_filter_basis,
      cancellation_rule: m.cancellation_rule,
    };
    dbg.innerHTML =
      '<p class="mb-1 small fw-semibold">Excursies DEBUG (?exc_debug=1)</p><pre class="small mb-0" style="white-space:pre-wrap;max-height:280px;overflow:auto">' +
      escapeHtml(JSON.stringify(payload, null, 2)) +
      "</pre>";
  }

  function setBanners(meta) {
    const mockEl = document.getElementById("excursionsMockBanner");
    if (mockEl) {
      if (meta && meta.fallback === "mock") {
        mockEl.textContent =
          "Demo: de Supabase-functie excursies_lines_rpc ontbreekt of faalde — voorbeelddata wordt getoond. " +
          "Deploy sql/rpc/excursies_rpc.sql voor live data.";
        mockEl.classList.remove("d-none");
      } else {
        mockEl.classList.add("d-none");
      }
    }
  }

  /** @param {Record<string, unknown>[]} rows */
  function updateMissingInkoopBanner(rows) {
    const excursionsEl = document.getElementById("excMissingInkoopExcursiesCount");
    const bookingsEl = document.getElementById("excMissingInkoopBoekingenCount");
    if (!excursionsEl || !bookingsEl) return;

    /** @type {Map<string, { rows: number, hasUsableInkoop: boolean }>} */
    const byExcursion = new Map();

    for (const raw of rows) {
      const r = /** @type {Record<string, unknown>} */ (raw);
      const key = excursionCompositeKey(r);
      const existing = byExcursion.get(key) || { rows: 0, hasUsableInkoop: false };
      existing.rows += 1;
      if (hasUsableInkoopPrijs(r)) existing.hasUsableInkoop = true;
      byExcursion.set(key, existing);
    }

    let missingExcursions = 0;
    let missingBookings = 0;
    for (const v of byExcursion.values()) {
      if (v.hasUsableInkoop) continue;
      missingExcursions += 1;
      // Zelfde basis als KPI "Aantal excursieboekingen": aantal gefilterde excursieregels.
      missingBookings += v.rows;
    }

    excursionsEl.textContent = nfInt.format(missingExcursions);
    bookingsEl.textContent = nfInt.format(missingBookings);
  }

  function ExcursionsFilters() {}

  function normalizeStateForKey(st) {
    const dests = Array.isArray(st?.dests) ? st.dests.map((x) => String(x).trim()).filter(Boolean).sort() : [];
    const excursies = Array.isArray(st?.excursies) ? st.excursies.map((x) => String(x).trim()).filter(Boolean).sort() : [];
    return {
      year: Number(st?.year || 0),
      brand: String(st?.brand || "__all__"),
      dest: String(st?.dest || ""),
      dests: dests.join(","),
      excursie: String(st?.excursie || ""),
      excursies: excursies.join(","),
      channel: String(st?.channel || "__all__"),
      pay: String(st?.pay || "__all__"),
      land: String(st?.land || "__all__"),
    };
  }

  function stateKey(st) {
    const n = normalizeStateForKey(st || {});
    return [n.year, n.brand, n.dest, n.dests, n.excursie, n.excursies, n.channel, n.pay, n.land].join("|");
  }

  function splitCsvValues(raw) {
    return String(raw || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  }

  ExcursionsFilters.getDraftState = function getDraftState() {
    const y = document.getElementById("excYear");
    const brand = document.getElementById("excBrand");
    const dest = document.getElementById("excDest");
    const ex = document.getElementById("excExcursie");
    const ch = document.getElementById("excChannel");
    const pay = document.getElementById("excPay");
    const land = document.getElementById("excLand");
    const selectedDests = excDestMulti ? excDestMulti.getValue() : dest ? [String(dest.value || "")].filter(Boolean) : [];
    const selectedExcursies = excExcursieMulti
      ? excExcursieMulti.getValue()
      : ex
        ? [String(ex.value || "").trim()].filter(Boolean)
        : [];
    return {
      year: IS_RESTRICTED_ROLE ? FORCED_YEAR : y ? Number(y.value) || 0 : 0,
      brand: brand ? String(brand.value || "__all__") : "__all__",
      dest: selectedDests[0] || "",
      dests: selectedDests,
      excursie: selectedExcursies[0] || "",
      excursies: selectedExcursies,
      channel: ch ? String(ch.value || "__all__") : "__all__",
      pay: pay ? String(pay.value || "__all__") : "__all__",
      land: land ? String(land.value || "__all__") : "__all__",
      // Vast: altijd vergelijken met vorig jaar.
      compare: "prev_year",
    };
  };

  ExcursionsFilters.getState = function getState() {
    return APPLIED_FILTER_STATE || ExcursionsFilters.getDraftState();
  };

  ExcursionsFilters.applyDraft = function applyDraft() {
    const d = ExcursionsFilters.getDraftState();
    APPLIED_FILTER_STATE = { ...d };
    return APPLIED_FILTER_STATE;
  };

  ExcursionsFilters.applyClient = function applyClient(rows) {
    const st = ExcursionsFilters.getState();
    return rows.filter((raw) => {
      const r = /** @type {Record<string, unknown>} */ (raw);
      if (!isActiveBookingRow(r)) return false;
      if (st.channel && st.channel !== "__all__") {
        if (String(r.sales_channel || "") !== st.channel) return false;
      }
      if (st.pay && st.pay !== "__all__") {
        if (normalizedPayOption(r) !== st.pay.toLowerCase()) return false;
      }
      return true;
    });
  };

  /**
   * @param {Record<string, unknown>[]} rows
   * @param {Record<string, unknown>} meta
   */
  function computeMetrics(rows, meta) {
    const lines = rows.length;
    let omzet = 0;
    let winst = 0;
    let beLines = 0;
    let nlLines = 0;
    let beExcPax = 0;
    let nlExcPax = 0;
    /** @type {Map<string, { pax: number, land: string }>} */
    const paxByEntity = new Map();
    const exKeys = new Set();
    rows.forEach((raw, idx) => {
      const r = /** @type {Record<string, unknown>} */ (raw);
      const v = num(r.verkoop_prijs);
      omzet += v;
      winst += calcWinst(r);
      const land = normalizedLandCode(r);
      if (land === "BE") beLines += 1;
      if (land === "NL") nlLines += 1;
      const bid = String(r.booking_id || "").trim();
      const rowKey = String(r.line_id || `${excursionCompositeKey(r)}::${idx}`);
      const entityKey = bid ? `booking:${bid}` : `line:${rowKey}`;
      if (!paxByEntity.has(entityKey)) {
        paxByEntity.set(entityKey, {
          pax: Math.max(0, num(r.booking_pax)),
          land,
        });
      }
      exKeys.add(excursionCompositeKey(r).toLowerCase());
    });
    let paxUnique = 0;
    for (const entity of paxByEntity.values()) {
      const pax = Math.max(0, num(entity.pax));
      paxUnique += pax;
      if (entity.land === "BE") beExcPax += pax;
      if (entity.land === "NL") nlExcPax += pax;
    }

    const pool = num(meta?.total_pax_pool);
    const paxPct = pool > 0 ? Math.min(1, paxUnique / pool) : null;
    const landPoolObj =
      meta && typeof meta.pax_pool_by_land === "object" && meta.pax_pool_by_land != null ? meta.pax_pool_by_land : {};
    let bePool = 0;
    let nlPool = 0;
    for (const [landKey, landPax] of Object.entries(landPoolObj)) {
      const norm = normalizedLandCodeFromValue(landKey);
      if (norm === "BE") bePool += num(landPax);
      if (norm === "NL") nlPool += num(landPax);
    }
    const beShare = paxUnique > 0 ? Math.min(1, beExcPax / paxUnique) : null;
    const nlShare = paxUnique > 0 ? Math.min(1, nlExcPax / paxUnique) : null;

    return {
      paxPct,
      omzet,
      winst,
      lines,
      beLines,
      nlLines,
      beExcPax,
      nlExcPax,
      bePool,
      nlPool,
      beShare,
      nlShare,
      excursiesCount: exKeys.size,
    };
  }

  const EXC_CMP_ROLE = {
    excKpiPaxPctCmp: "neutral",
    excKpiOmzetCmp: "delta",
    excKpiWinstCmp: "delta",
    excKpiLinesCmp: "neutral",
  };

  function excCmpLine(label, curV, prevV, format, cmpId) {
    const SP = globalThis.SemanticPerformance;
    const role = EXC_CMP_ROLE[cmpId] || "neutral";
    if (prevV == null || !Number.isFinite(prevV)) {
      return '<span class="text-muted">Geen vergelijkingsdata voor vorig jaar</span>';
    }
    const diff = curV - prevV;
    if (Math.abs(diff) < 1e-9) {
      return SP ? `<span class="sp-text--neutral">${label}: gelijk</span>` : `${label}: gelijk`;
    }
    const sem = role === "neutral" ? "neutral" : "delta";
    const cls = SP ? SP.textClass(diff, sem) : "";
    const wrap = (inner) => (cls ? `<span class="${cls}">${inner}</span>` : `<span>${inner}</span>`);
    if (format === "pct") {
      const rel = prevV !== 0 ? (diff / Math.abs(prevV)) * 100 : 0;
      return wrap(`${label}: ${rel >= 0 ? "+" : ""}${nfDec.format(rel)}% vs vorig jaar`);
    }
    if (format === "int") {
      return wrap(`${label}: ${diff >= 0 ? "+" : ""}${nfInt.format(diff)} vs vorig jaar`);
    }
    return wrap(`${label}: ${diff >= 0 ? "+" : ""}${nfMoney.format(diff)} vs vorig jaar`);
  }

  function excCmpPromptPickYear() {
    return '<span class="text-muted">Kies een jaar voor vergelijking met vorig jaar</span>';
  }

  function excCmpPpLine(label, curV, prevV) {
    const SP = globalThis.SemanticPerformance;
    if (prevV == null || !Number.isFinite(prevV)) {
      return '<span class="text-muted">Geen vergelijkingsdata voor vorig jaar</span>';
    }
    const diffPp = (curV - prevV) * 100;
    if (!Number.isFinite(diffPp)) return "";
    if (Math.abs(diffPp) < 1e-9) {
      return SP ? `<span class="sp-text--neutral">${label}: gelijk</span>` : `${label}: gelijk`;
    }
    const cls = SP ? SP.textClass(diffPp, "delta") : "";
    const inner = `${label}: ${diffPp >= 0 ? "+" : ""}${nfDec.format(diffPp)} pp vs vorig jaar`;
    return cls ? `<span class="${cls}">${inner}</span>` : `<span>${inner}</span>`;
  }

  function applyExcKpiWinstSemantic(raw) {
    const el = document.getElementById("excKpiWinst");
    if (!el) return;
    const SP = globalThis.SemanticPerformance;
    el.classList.remove("sp-text--pos", "sp-text--neg", "sp-text--neutral");
    if (!SP) return;
    const c = SP.textClass(raw, "profit");
    if (c) el.classList.add(c);
  }

  /** @param {Record<string, unknown>} m */
  function metricVal(m, k) {
    return num(m[k]);
  }

  const ExcursionsKPIGrid = {
    /**
     * @param {{ mCur: Record<string, unknown>, mPrev: Record<string, unknown>, mTwo: Record<string, unknown> }} agg
     * @param {ReturnType<typeof ExcursionsFilters.getState>} st
     */
    render(agg, st) {
      const { mCur, mPrev, mTwo } = agg;
      const map = [
        ["excKpiPaxPct", "paxPct", "excKpiPaxPctCmp", "pct"],
        ["excKpiOmzet", "omzet", "excKpiOmzetCmp", "money"],
        ["excKpiWinst", "winst", "excKpiWinstCmp", "money"],
        ["excKpiLines", "lines", "excKpiLinesCmp", "int"],
      ];
      for (const row of map) {
        const [id, key, cmpId, format] = row;
        const el = document.getElementById(id);
        const cEl = document.getElementById(cmpId);
        if (!el) continue;
        const val = metricVal(mCur, key);
        if (id === "excKpiPaxPct" && mCur.paxPct == null) {
          el.textContent = "—";
        } else if (format === "pct") {
          el.textContent = nfPct.format(metricVal(mCur, key));
        } else if (format === "int") {
          el.textContent = nfInt.format(metricVal(mCur, key));
        } else {
          el.textContent = nfMoney.format(metricVal(mCur, key));
        }
        if (cEl) {
          if (st.year <= 0) {
            cEl.innerHTML = excCmpPromptPickYear();
          } else {
            const pv = metricVal(mPrev, key);
            cEl.innerHTML = excCmpLine("vs vorig jaar", val, pv, format, cmpId);
          }
        }
        if (id === "excKpiWinst") applyExcKpiWinstSemantic(metricVal(mCur, key));
      }

      const landEl = document.getElementById("excKpiLandShare");
      const landCmpEl = document.getElementById("excKpiLandShareCmp");
      const beShare = Number(mCur.beShare);
      const nlShare = Number(mCur.nlShare);
      if (landEl) {
        const beTxt = Number.isFinite(beShare) ? nfPct.format(beShare) : "—";
        const nlTxt = Number.isFinite(nlShare) ? nfPct.format(nlShare) : "—";
        if (beTxt === "—" && nlTxt === "—") {
          landEl.textContent = "—";
        } else {
          landEl.innerHTML = `<span>BE ${beTxt}</span><span>NL ${nlTxt}</span>`;
        }
      }
      if (landCmpEl) {
        if (st.year <= 0) {
          landCmpEl.innerHTML = excCmpPromptPickYear();
        } else {
          const bePrev = Number(mPrev.beShare);
          const nlPrev = Number(mPrev.nlShare);
          const beLine = Number.isFinite(beShare) && Number.isFinite(bePrev) ? excCmpPpLine("BE", beShare, bePrev) : "";
          const nlLine = Number.isFinite(nlShare) && Number.isFinite(nlPrev) ? excCmpPpLine("NL", nlShare, nlPrev) : "";
          const merged = [beLine, nlLine].filter(Boolean).join(" · ");
          landCmpEl.innerHTML = merged || '<span class="text-muted">Geen vergelijkingsdata voor vorig jaar</span>';
        }
      }
    },
  };

  function topPairs(map, n = 10) {
    return Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n);
  }

  /** In debug-modus geen client-side filtering (alleen ruwe RPC-rijen). */
  function applyClientRows(rows) {
    if (EXCURSIONS_DEBUG) {
      return rows;
    }
    return ExcursionsFilters.applyClient(rows);
  }

  function buildAggregates() {
    const st = ExcursionsFilters.getState();
    const cur = applyClientRows(POOL_CUR);
    const prev = applyClientRows(POOL_PREV);
    const two = applyClientRows(POOL_TWO);
    return {
      rows: cur,
      mCur: computeMetrics(cur, META_CUR),
      mPrev: computeMetrics(prev, META_PREV),
      mTwo: computeMetrics(two, META_TWO),
      st,
    };
  }

  const ExcursionsPerformanceSection = {
    /** @param {Record<string, unknown>[]} rows */
    render(rows) {
      const avgExcPerPaxEl = document.getElementById("excPerfAvgExcursionsPerPax");
      const avgRevenuePerPaxEl = document.getElementById("excPerfAvgRevenuePerPax");
      const empty = document.getElementById("excPerfEmpty");
      const navEl = document.getElementById("excPerfChartNav");
      const navLabel = document.getElementById("excPerfPageLabel");
      if (!rows.length) {
        if (empty) empty.classList.remove("d-none");
        if (avgExcPerPaxEl) avgExcPerPaxEl.textContent = "—";
        if (avgRevenuePerPaxEl) avgRevenuePerPaxEl.textContent = "—";
        if (navEl) navEl.classList.add("d-none");
        destroyChart("excChartPerfExc");
        return;
      }
      if (empty) empty.classList.add("d-none");

      let totalOmzet = 0;
      /** @type {Map<string, number>} */
      const paxByBooking = new Map();
      for (const raw of rows) {
        const r = /** @type {Record<string, unknown>} */ (raw);
        totalOmzet += num(r.verkoop_prijs);
        const bid = String(r.booking_id || "");
        if (bid && !paxByBooking.has(bid)) paxByBooking.set(bid, num(r.booking_pax));
      }
      const totalPax = [...paxByBooking.values()].reduce((acc, v) => acc + num(v), 0);
      const avgExcursionsPerPax = safeDivide(rows.length, totalPax);
      const avgRevenuePerPax = safeDivide(totalOmzet, totalPax);

      if (avgExcPerPaxEl) avgExcPerPaxEl.textContent = avgExcursionsPerPax == null ? "—" : nfDec2.format(avgExcursionsPerPax);
      if (avgRevenuePerPaxEl) {
        avgRevenuePerPaxEl.textContent = avgRevenuePerPax == null ? "—" : nfMoney.format(avgRevenuePerPax);
      }

      const allStats = getPerfExcursionStats(rows);
      const globalMaxN = allStats.length ? Math.max(1, num(allStats[0]?.n)) : 1;
      const totalPages = Math.max(1, Math.ceil(allStats.length / PERF_EXC_PAGE_SIZE));
      if (_perfExcPage >= totalPages) _perfExcPage = totalPages - 1;
      if (_perfExcPage < 0) _perfExcPage = 0;
      const start = _perfExcPage * PERF_EXC_PAGE_SIZE;
      const excPage = allStats.slice(start, start + PERF_EXC_PAGE_SIZE);

      if (navEl && navLabel) {
        if (allStats.length > PERF_EXC_PAGE_SIZE) {
          navEl.classList.remove("d-none");
          navLabel.textContent = `${_perfExcPage + 1} / ${totalPages}`;
        } else {
          navEl.classList.add("d-none");
          navLabel.textContent = "";
        }
      }
      const prevBtn = document.getElementById("excPerfPrev");
      const nextBtn = document.getElementById("excPerfNext");
      if (prevBtn) prevBtn.disabled = _perfExcPage <= 0;
      if (nextBtn) nextBtn.disabled = _perfExcPage >= totalPages - 1;

      destroyChart("excChartPerfExc");
      const c2 = document.getElementById("excChartPerfExc");
      if (c2) {
        charts.excChartPerfExc = new Chart(c2, {
          type: "bar",
          data: {
            labels: excPage.map((x) => truncateChartLabel(x.naam)),
            datasets: [
              {
                label: "Aantal excursieboekingen",
                data: excPage.map((x) => x.n),
                backgroundColor: COL.orangeSoft,
                borderColor: COL.orange,
                borderWidth: 1,
              },
            ],
          },
          options: {
            indexAxis: "y",
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { display: false },
              tooltip: {
                callbacks: {
                  title(items) {
                    const i = Number(items[0]?.dataIndex);
                    const s = excPage[Number.isFinite(i) ? i : 0];
                    return s ? `${s.naam} · ${s.dest}` : "";
                  },
                  label(ctx) {
                    const i = ctx.dataIndex;
                    const s = excPage[i];
                    return s ? `${nfInt.format(s.n)} regels` : "";
                  },
                },
              },
            },
            scales: {
              x: {
                ticks: { color: COL.slate, precision: 0 },
                grid: { color: "rgba(0,0,0,0.06)" },
                min: 0,
                max: globalMaxN,
              },
              y: { ticks: { color: COL.slate }, grid: { display: false } },
            },
          },
        });
      }
    },
  };

  /**
   * Gedeelde aggregatie voor omzet/winst/uptake per bestemming (zelfde als globale filtercontext).
   * @param {Record<string, unknown>[]} rows
   */
  function computeExcursiesRevenueAgg(rows) {
    const byMonth = {};
    const byDest = {};
    /** @type {Map<string, Set<string>>} */
    const seenBookDest = new Map();
    /** @type {Record<string, number>} */
    const paxByDest = {};

    for (const raw of rows) {
      const r = /** @type {Record<string, unknown>} */ (raw);
      const dep = String(r.departure_date || "").slice(0, 7);
      const d = String(r.destination || "—");
      const bid = String(r.booking_id || "");
      const v = num(r.verkoop_prijs);
      const w = calcWinst(r);
      if (dep) {
        byMonth[dep] = byMonth[dep] || { om: 0, wi: 0 };
        byMonth[dep].om += v;
        byMonth[dep].wi += w;
      }
      byDest[d] = byDest[d] || { om: 0, wi: 0 };
      byDest[d].om += v;
      byDest[d].wi += w;
      if (!seenBookDest.has(d)) seenBookDest.set(d, new Set());
      const sb = seenBookDest.get(d);
      if (sb && !sb.has(bid)) {
        sb.add(bid);
        paxByDest[d] = (paxByDest[d] || 0) + num(r.booking_pax);
      }
    }

    let destLabels = getAllDestinationNamesSorted();
    const fromData = Object.keys(byDest);
    if (!destLabels.length) {
      destLabels = [...new Set(fromData)].sort((a, b) => a.localeCompare(b, "nl"));
    } else {
      for (const k of fromData) {
        if (!destLabels.includes(k)) destLabels.push(k);
      }
      destLabels = [...new Set(destLabels)].sort((a, b) => a.localeCompare(b, "nl"));
    }
    for (const d of destLabels) {
      if (!byDest[d]) byDest[d] = { om: 0, wi: 0 };
      if (paxByDest[d] == null) paxByDest[d] = 0;
    }

    return { byMonth, byDest, destLabels, paxByDest };
  }

  const ExcursionsRevenueSection = {
    /**
     * Omzet & winst per maand + % pax uptake (tab Omzet & winst).
     * @param {Record<string, unknown>[]} rows
     * @param {Record<string, unknown>} meta
     */
    render(rows, meta) {
      const empty = document.getElementById("excRevEmpty");
      const { byMonth, byDest, destLabels, paxByDest } = computeExcursiesRevenueAgg(rows);

      if (!rows.length) {
        if (empty) empty.classList.remove("d-none");
        destroyChart("excChartRevMonth");
        destroyChart("excChartDestUptake");
        excRevSummaryRows = [];
        const sb0 = document.getElementById("excRevDestSummaryBody");
        if (sb0) sb0.innerHTML = `<tr><td colspan="4" class="text-muted text-center py-3">Geen data voor deze filters.</td></tr>`;
      } else {
        if (empty) empty.classList.add("d-none");
        const months = Object.keys(byMonth).sort();
        const monthLabels = months.map((m) => formatYearMonthSlash(m, m));
        destroyChart("excChartRevMonth");
        const c1 = document.getElementById("excChartRevMonth");
        if (c1 && months.length) {
          charts.excChartRevMonth = new Chart(c1, {
            type: "line",
            data: {
              labels: monthLabels,
              datasets: [
                {
                  label: "Totale excursie omzet",
                  data: months.map((m) => byMonth[m].om),
                  borderColor: COL.orange,
                  backgroundColor: COL.orangeSoft,
                  fill: true,
                  tension: 0.2,
                },
                {
                  label: "Winst excursies",
                  data: months.map((m) => byMonth[m].wi),
                  borderColor: COL.green,
                  backgroundColor: COL.greenSoft,
                  fill: true,
                  tension: 0.2,
                },
              ],
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              interaction: {
                mode: "index",
                intersect: false,
              },
              plugins: {
                tooltip: {
                  callbacks: {
                    label() {
                      return null;
                    },
                    footer(items) {
                      const idx = Number(items?.[0]?.dataIndex);
                      const month = months[Number.isFinite(idx) ? idx : -1];
                      if (!month || !byMonth[month]) return "";
                      return [
                        `Omzet: ${nfMoney.format(num(byMonth[month].om))}`,
                        `Winst: ${nfMoney.format(num(byMonth[month].wi))}`,
                      ];
                    },
                  },
                },
              },
              scales: {
                x: { ticks: { color: COL.slate } },
                y: { ticks: { color: COL.slate }, grid: { color: "rgba(0,0,0,0.06)" } },
              },
            },
          });
        } else {
          destroyChart("excChartRevMonth");
        }
      }

      if (!rows.length) {
        return;
      }

      const paxPoolByDestination =
        meta && typeof meta.pax_pool_by_destination === "object" && meta.pax_pool_by_destination != null
          ? meta.pax_pool_by_destination
          : {};
      /** @type {Record<string, number>} */
      const uptakeRatio = {};
      /** @type {Record<string, number>} */
      const uptakePct = {};
      /** @type {Record<string, number>} */
      const denomByDest = {};
      for (const d of destLabels) {
        const denom = num(paxPoolByDestination[d]);
        denomByDest[d] = denom;
        const ratio = denom > 0 ? (paxByDest[d] || 0) / denom : 0;
        uptakeRatio[d] = ratio;
        uptakePct[d] = ratio * 100;
      }
      const maxUptakePct = destLabels.reduce((acc, d) => Math.max(acc, num(uptakePct[d])), 0);
      const yAxisMax = Math.min(100, Math.max(10, Math.ceil(maxUptakePct / 10) * 10));
      const uptakeRows = destLabels.map((d) => ({
        dest: d,
        pct: uptakePct[d] || 0,
        numer: num(paxByDest[d]),
        denom: num(denomByDest[d]),
      }));
      let visibleRows = uptakeRows;
      if (destUptakePaginator) {
        const oldOffset = destUptakePaginator.offset;
        destUptakePaginator.setItems(uptakeRows);
        destUptakePaginator.setOffset(oldOffset);
        visibleRows = destUptakePaginator.getWindow();
      } else {
        visibleRows = uptakeRows.slice(0, DEST_UPTAKE_PAGE_SIZE);
      }
      const nav = document.getElementById("excDestUptakeNav");
      const navInfo = document.getElementById("excDestUptakePageInfo");
      const navPrev = document.getElementById("excDestUptakePrev");
      const navNext = document.getElementById("excDestUptakeNext");
      if (nav && navInfo && navPrev && navNext && destUptakePaginator && uptakeRows.length > DEST_UPTAKE_PAGE_SIZE) {
        const metaPg = destUptakePaginator.getInfo();
        nav.classList.remove("d-none");
        navInfo.textContent = `${metaPg.start}-${metaPg.end} van ${metaPg.total}`;
        navPrev.disabled = !destUptakePaginator.canPrev();
        navNext.disabled = !destUptakePaginator.canNext();
      } else if (nav) {
        nav.classList.add("d-none");
      }
      destroyChart("excChartDestUptake");
      const cU = document.getElementById("excChartDestUptake");
      if (cU && visibleRows.length) {
        charts.excChartDestUptake = new Chart(cU, {
          type: "bar",
          data: {
            labels: visibleRows.map((r) => {
              const s = String(r.dest || "");
              return s.length > 32 ? `${s.slice(0, 31).trimEnd()}…` : s;
            }),
            datasets: [
              {
                label: "% pax met excursies (t.o.v. pax op bestemming)",
                data: visibleRows.map((r) => r.pct),
                backgroundColor: COL.greenSoft,
                borderColor: COL.green,
                borderWidth: 1,
                barThickness: 18,
                maxBarThickness: 22,
                categoryPercentage: 0.78,
                barPercentage: 0.9,
              },
            ],
          },
          options: {
            indexAxis: "y",
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              tooltip: {
                callbacks: {
                  label(ctx) {
                    const row = visibleRows[ctx.dataIndex];
                    const numer = num(row?.numer);
                    const denom = num(row?.denom);
                    return [
                      `% pax met excursies: ${nfDec.format(num(ctx.parsed.x))}%`,
                      `Pax met excursie: ${nfInt.format(numer)}`,
                      `Totale pax bestemming: ${nfInt.format(denom)}`,
                    ];
                  },
                },
              },
            },
            scales: {
              x: {
                ticks: {
                  color: COL.slate,
                  callback(value) {
                    return `${nfInt.format(num(value))}%`;
                  },
                  stepSize: 10,
                },
                grid: { color: "rgba(0,0,0,0.06)" },
                max: yAxisMax,
              },
              y: {
                ticks: {
                  color: COL.slate,
                  maxRotation: 0,
                  minRotation: 0,
                  autoSkip: false,
                  align: "center",
                  crossAlign: "near",
                },
                grid: { display: false },
              },
            },
          },
        });
      }

      const sumBody = document.getElementById("excRevDestSummaryBody");
      const sumTbl = document.getElementById("excRevDestSummaryTable");
      const wireSort = typeof globalThis.TA_wireSortableTable === "function" ? globalThis.TA_wireSortableTable : null;

      const renderRevSummaryBody = (rowArr) => {
        if (!sumBody) return;
        if (!rowArr.length) {
          sumBody.innerHTML = `<tr><td colspan="4" class="text-muted text-center py-3">Geen bestemmingen in deze selectie.</td></tr>`;
          return;
        }
        sumBody.innerHTML = rowArr
          .map(
            (row) => `<tr>
            <td>${escapeHtml(String(row.dest))}</td>
            <td class="text-end">${nfMoney.format(num(row.omzet))}</td>
            <td class="text-end">${nfMoney.format(num(row.winst))}</td>
            <td class="text-end">${nfPct.format(num(row.uptake))}</td>
          </tr>`,
          )
          .join("");
      };

      excRevSummaryRows = destLabels.map((d) => ({
        dest: d,
        omzet: num(byDest[d]?.om),
        winst: num(byDest[d]?.wi),
        uptake: uptakeRatio[d] || 0,
      }));
      renderRevSummaryBody(excRevSummaryRows);
      if (sumTbl && wireSort && excRevSummaryRows.length) {
        wireSort(
          sumTbl,
          () => excRevSummaryRows.map((r) => ({ ...r })),
          (sorted) => {
            excRevSummaryRows = sorted;
            renderRevSummaryBody(sorted);
          },
        );
      }
    },

    /**
     * Omzet vs winst per bestemming — tab Bestemmingen; gebruikt globale filterdata (zelfde rijen als KPI’s).
     * @param {Record<string, unknown>[]} rows
     */
    renderRevDestChart(rows) {
      const { byDest, destLabels } = computeExcursiesRevenueAgg(rows);
      const destFiltered = destLabels.filter((d) => !(num(byDest[d]?.om) === 0 && num(byDest[d]?.wi) === 0));
      const revRows = destFiltered.map((d) => ({
        dest: d,
        om: num(byDest[d]?.om),
        wi: num(byDest[d]?.wi),
      }));
      let visibleRows = revRows;
      if (revDestPaginator) {
        const oldOffset = revDestPaginator.offset;
        revDestPaginator.setItems(revRows);
        revDestPaginator.setOffset(oldOffset);
        visibleRows = revDestPaginator.getWindow();
      } else {
        visibleRows = revRows.slice(0, DEST_REV_PAGE_SIZE);
      }
      const nav = document.getElementById("excRevDestNav");
      const navInfo = document.getElementById("excRevDestPageInfo");
      const navPrev = document.getElementById("excRevDestPrev");
      const navNext = document.getElementById("excRevDestNext");
      if (nav && navInfo && navPrev && navNext && revDestPaginator && revRows.length > DEST_REV_PAGE_SIZE) {
        const metaPg = revDestPaginator.getInfo();
        nav.classList.remove("d-none");
        navInfo.textContent = `${metaPg.start}-${metaPg.end} van ${metaPg.total}`;
        navPrev.disabled = !revDestPaginator.canPrev();
        navNext.disabled = !revDestPaginator.canNext();
      } else if (nav) {
        nav.classList.add("d-none");
      }
      destroyChart("excChartRevDest");
      const revDestWrap = document.getElementById("excRevDestChartWrap");
      const nVisible = visibleRows.length;
      if (revDestWrap) {
        if (!nVisible) {
          revDestWrap.style.removeProperty("height");
          revDestWrap.style.removeProperty("min-height");
        } else {
          const compact =
            typeof window !== "undefined" &&
            window.matchMedia &&
            window.matchMedia("(max-width: 991.98px)").matches;
          const rowPx = compact ? 46 : 54;
          const chrome = 64;
          const h = Math.max(360, chrome + nVisible * rowPx);
          revDestWrap.style.height = `${h}px`;
          revDestWrap.style.minHeight = `${h}px`;
        }
      }
      const c2 = document.getElementById("excChartRevDest");
      if (c2 && visibleRows.length) {
        charts.excChartRevDest = new Chart(c2, {
          type: "bar",
          data: {
            labels: visibleRows.map((r) => {
              const s = String(r.dest || "");
              return s.length > 38 ? `${s.slice(0, 37).trimEnd()}…` : s;
            }),
            datasets: [
              {
                label: "Totale excursie omzet",
                data: visibleRows.map((r) => r.om),
                backgroundColor: COL.orangeSoft,
                borderColor: COL.orange,
                borderWidth: 1,
                borderRadius: { topLeft: 0, bottomLeft: 0, topRight: 5, bottomRight: 5 },
                borderSkipped: false,
                clip: false,
                categoryPercentage: 0.82,
                barPercentage: 0.92,
              },
              {
                label: "Winst excursies",
                data: visibleRows.map((r) => r.wi),
                backgroundColor: COL.greenSoft,
                borderColor: COL.green,
                borderWidth: 1,
                borderRadius: { topLeft: 0, bottomLeft: 0, topRight: 5, bottomRight: 5 },
                borderSkipped: false,
                clip: false,
                categoryPercentage: 0.82,
                barPercentage: 0.92,
              },
            ],
          },
          options: {
            indexAxis: "y",
            responsive: true,
            maintainAspectRatio: false,
            // Teken buiten het chart-area niet wegknippen (anders verdwijnt de bovenrand van de eerste rij).
            clip: false,
            // Voorkom dat de stroke van de bovenste balk tegen de clip-rand valt (geen zichtbare bovenrand).
            layout: {
              padding: { top: 18, bottom: 10, left: 10, right: 6 },
            },
            plugins: {
              tooltip: {
                callbacks: {
                  label(ctx) {
                    return `${ctx.dataset.label}: ${nfMoney.format(num(ctx.parsed.x))}`;
                  },
                },
              },
            },
            scales: {
              x: { stacked: false, ticks: { color: COL.slate } },
              y: {
                position: "left",
                offset: true,
                ticks: {
                  color: COL.slate,
                  maxRotation: 0,
                  minRotation: 0,
                  autoSkip: false,
                  // y-as: align = verticale baseline t.o.v. de tick; crossAlign = horizontale uitlijning.
                  // 'near' bij position:left → textAlign rechts, tegen het plotgebied (rechts uitgelijnd).
                  align: "center",
                  crossAlign: "near",
                  padding: 8,
                },
                grid: { display: false },
                border: { display: false },
              },
            },
          },
        });
      }
    },
  };

  const ExcursionsSalesChannelSection = {
    /** @param {Record<string, unknown>[]} rows */
    render(rows) {
      const empty = document.getElementById("excSaleEmpty");
      if (!rows.length) {
        if (empty) empty.classList.remove("d-none");
        destroyChart("excChartSaleDonut");
        destroyChart("excChartPayOptionDonut");
        return;
      }
      if (empty) empty.classList.add("d-none");

      const salesLabels = ["Local sale", "Booking sale", "Onbekend"];
      /** @type {Record<string, { units: number, omzet: number }>} */
      const bySales = {
        "Local sale": { units: 0, omzet: 0 },
        "Booking sale": { units: 0, omzet: 0 },
        Onbekend: { units: 0, omzet: 0 },
      };
      /** @type {Record<string, { units: number, omzet: number }>} */
      const byPay = {};
      for (const raw of rows) {
        const r = /** @type {Record<string, unknown>} */ (raw);
        const units = participantUnitsForRow(r);
        const v = num(r.verkoop_prijs);
        const sc = String(r.sales_channel || "");
        const scNorm = sc === "Local sale" || sc === "Booking sale" ? sc : "Onbekend";
        bySales[scNorm].units += units;
        bySales[scNorm].omzet += v;
        const pay = normalizedPayOption(r) || "onbekend";
        if (!byPay[pay]) byPay[pay] = { units: 0, omzet: 0 };
        byPay[pay].units += units;
        byPay[pay].omzet += v;
      }
      const totalSalesUnits = salesLabels.reduce((acc, label) => acc + num(bySales[label]?.units), 0);

      destroyChart("excChartSaleDonut");
      const c1 = document.getElementById("excChartSaleDonut");
      if (c1) {
        charts.excChartSaleDonut = new Chart(c1, {
          type: "doughnut",
          data: {
            labels: salesLabels,
            datasets: [
              {
                data: salesLabels.map((label) => num(bySales[label]?.units)),
                backgroundColor: [COL.orange, COL.green, COL.gray],
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              tooltip: {
                callbacks: {
                  label(ctx) {
                    const label = String(ctx.label || "");
                    const units = num(ctx.parsed);
                    const omzet = num(bySales[label]?.omzet);
                    const pct = totalSalesUnits > 0 ? units / totalSalesUnits : 0;
                    return [
                      `Aantal deelnemers: ${nfInt.format(units)}`,
                      `Aandeel: ${nfPct.format(pct)}`,
                      `Omzet: ${nfMoney.format(omzet)}`,
                    ];
                  },
                },
              },
            },
          },
        });
      }

      const payLabels = Object.keys(byPay).sort((a, b) => num(byPay[b]?.units) - num(byPay[a]?.units));
      const totalPayUnits = payLabels.reduce((acc, label) => acc + num(byPay[label]?.units), 0);
      destroyChart("excChartPayOptionDonut");
      const c2 = document.getElementById("excChartPayOptionDonut");
      if (c2) {
        charts.excChartPayOptionDonut = new Chart(c2, {
          type: "doughnut",
          data: {
            labels: payLabels,
            datasets: [
              {
                data: payLabels.map((label) => num(byPay[label]?.units)),
                backgroundColor: [COL.orange, COL.green, COL.gray, "#0ea5e9", "#9333ea", "#14b8a6"],
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              tooltip: {
                callbacks: {
                  label(ctx) {
                    const label = String(ctx.label || "");
                    const units = num(ctx.parsed);
                    const omzet = num(byPay[label]?.omzet);
                    const pct = totalPayUnits > 0 ? units / totalPayUnits : 0;
                    return [
                      `Aantal deelnemers: ${nfInt.format(units)}`,
                      `Aandeel: ${nfPct.format(pct)}`,
                      `Omzet: ${nfMoney.format(omzet)}`,
                    ];
                  },
                },
              },
            },
          },
        });
      }
    },
  };

  const ExcursionsTimingSection = {
    /** @param {Record<string, unknown>[]} rows */
    render(rows) {
      const empty = document.getElementById("excTimingEmpty");
      const avgEl = document.getElementById("excTimingAvgDays");
      const pctBookEl = document.getElementById("excTimingPctBooking");
      const pctLocEl = document.getElementById("excTimingPctLocal");
      const omzetBookEl = document.getElementById("excTimingOmzetBooking");
      const omzetLocEl = document.getElementById("excTimingOmzetLocal");
      const localSummaryEl = document.getElementById("excTimingLocalSummary");
      const buckets = { b07: 0, b7m: 0, b12: 0, b23: 0, b34: 0, b4p: 0 };
      const bucketRevenue = { b07: 0, b7m: 0, b12: 0, b23: 0, b34: 0, b4p: 0 };
      let bAtBooking = 0;
      let bAtBookingRevenue = 0;
      const daysList = [];
      let localCount = 0;
      let localRevenue = 0;
      let bookingCount = 0;
      let bookingRevenue = 0;
      for (const raw of rows) {
        const r = /** @type {Record<string, unknown>} */ (raw);
        const dep = String(r.departure_date || "").slice(0, 10);
        const add = String(r.datum_toegevoegd || "").slice(0, 10);
        const bookingDate = String(r.booking_date || "").slice(0, 10);
        const revenue = num(r.verkoop_prijs);
        const isLocalSale = String(r.sales_channel || "") === "Local sale";
        if (isLocalSale) {
          localCount += 1;
          localRevenue += revenue;
        } else {
          bookingCount += 1;
          bookingRevenue += revenue;
        }
        if (!dep || !add) continue;
        const dDep = new Date(dep);
        const dAdd = new Date(add);
        if (Number.isNaN(dDep.getTime()) || Number.isNaN(dAdd.getTime())) continue;
        const diffRaw = Math.round((dDep.getTime() - dAdd.getTime()) / 86400000);
        if (!Number.isFinite(diffRaw)) continue;
        daysList.push(diffRaw);

        /** Excursieregel toegevoegd op dezelfde kalenderdag als de boekingsdatum. */
        const tijdensBoeking =
          Boolean(bookingDate) && Boolean(add) && bookingDate === add;
        if (tijdensBoeking) {
          bAtBooking += 1;
          bAtBookingRevenue += revenue;
          continue;
        }

        const diff = Math.max(0, diffRaw);
        if (diff <= 7) {
          buckets.b07 += 1;
          bucketRevenue.b07 += revenue;
        } else if (diff <= 30) {
          buckets.b7m += 1;
          bucketRevenue.b7m += revenue;
        } else if (diff <= 60) {
          buckets.b12 += 1;
          bucketRevenue.b12 += revenue;
        } else if (diff <= 90) {
          buckets.b23 += 1;
          bucketRevenue.b23 += revenue;
        } else if (diff <= 120) {
          buckets.b34 += 1;
          bucketRevenue.b34 += revenue;
        } else {
          buckets.b4p += 1;
          bucketRevenue.b4p += revenue;
        }
      }

      if (!rows.length) {
        if (empty) empty.classList.remove("d-none");
        if (avgEl) avgEl.textContent = "—";
        if (pctBookEl) pctBookEl.textContent = "Booking sales: —";
        if (pctLocEl) pctLocEl.textContent = "Local sales: —";
        if (omzetBookEl) omzetBookEl.textContent = "Totale omzet booking sales: —";
        if (omzetLocEl) omzetLocEl.textContent = "Totale omzet local sales: —";
        if (localSummaryEl) localSummaryEl.textContent = "Local sales: —";
        destroyChart("excChartTimingBuckets");
        return;
      }
      if (empty) empty.classList.add("d-none");

      const n = rows.length;
      const bookingPct = bookingCount / n;
      const localPct = localCount / n;
      if (pctBookEl) pctBookEl.textContent = `Booking sales: ${nfPct.format(bookingPct)}`;
      if (pctLocEl) pctLocEl.textContent = `Local sales: ${nfPct.format(localPct)}`;
      if (omzetBookEl) omzetBookEl.textContent = `Totale omzet booking sales: ${nfMoney.format(bookingRevenue)}`;
      if (omzetLocEl) omzetLocEl.textContent = `Totale omzet local sales: ${nfMoney.format(localRevenue)}`;

      if (localSummaryEl) {
        localSummaryEl.textContent = `Local sales: ${nfInt.format(localCount)} regels · ${nfMoney.format(localRevenue)}`;
      }

      if (daysList.length) {
        const avg = daysList.reduce((a, b) => a + b, 0) / daysList.length;
        if (avgEl) avgEl.textContent = nfDec.format(avg);
      } else if (avgEl) {
        avgEl.textContent = "—";
      }

      destroyChart("excChartTimingBuckets");
      const c = document.getElementById("excChartTimingBuckets");
      if (c) {
        const labels = ["Local sales", "0–7d", "7d–1m", "1–2m", "2–3m", "3–4m", "4m+", "Tijdens boeking"];
        const dataVals = [
          localCount,
          buckets.b07,
          buckets.b7m,
          buckets.b12,
          buckets.b23,
          buckets.b34,
          buckets.b4p,
          bAtBooking,
        ];
        const revenueVals = [
          localRevenue,
          bucketRevenue.b07,
          bucketRevenue.b7m,
          bucketRevenue.b12,
          bucketRevenue.b23,
          bucketRevenue.b34,
          bucketRevenue.b4p,
          bAtBookingRevenue,
        ];
        const totalVals = dataVals.reduce((acc, v) => acc + num(v), 0);
        const atBookingSoft = "rgba(14, 165, 233, 0.18)";
        const atBookingBorder = "#0ea5e9";
        const bg = [
          COL.greenSoft,
          COL.orangeSoft,
          COL.orangeSoft,
          COL.orangeSoft,
          COL.orangeSoft,
          COL.orangeSoft,
          COL.orangeSoft,
          atBookingSoft,
        ];
        const br = [COL.green, COL.orange, COL.orange, COL.orange, COL.orange, COL.orange, COL.orange, atBookingBorder];
        charts.excChartTimingBuckets = new Chart(c, {
          type: "bar",
          data: {
            labels,
            datasets: [
              {
                label: "Aantal regels",
                data: dataVals,
                backgroundColor: bg,
                borderColor: br,
                borderWidth: 1,
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { display: false },
              tooltip: {
                callbacks: {
                  label(ctx) {
                    const i = Number(ctx.dataIndex);
                    const count = num(ctx.parsed.y);
                    const omzet = Number.isFinite(i) ? num(revenueVals[i]) : 0;
                    const pct = totalVals > 0 ? count / totalVals : 0;
                    return [
                      `Aantal regels: ${nfInt.format(count)}`,
                      `Aandeel: ${nfPct.format(pct)}`,
                      `Omzet: ${nfMoney.format(omzet)}`,
                    ];
                  },
                },
              },
            },
            scales: {
              x: {
                ticks: { color: COL.slate, maxRotation: 40, minRotation: 0, autoSkip: false },
              },
              y: { ticks: { color: COL.slate }, grid: { color: "rgba(0,0,0,0.06)" } },
            },
          },
        });
      }
    },
  };

  const ExcursionsPaymentsSection = {
    /** @param {Record<string, unknown>[]} rows */
    render(rows) {
      /** @type {Record<string, { omzet: number, lines: number, bookings: Set<string> }>} */
      const byPay = {};
      for (const raw of rows) {
        const r = /** @type {Record<string, unknown>} */ (raw);
        const p = normalizedPayOption(r) || "onbekend";
        if (!byPay[p]) byPay[p] = { omzet: 0, lines: 0, bookings: new Set() };
        byPay[p].omzet += num(r.verkoop_prijs);
        byPay[p].lines += 1;
        byPay[p].bookings.add(String(r.booking_id || ""));
      }
      const labels = Object.keys(byPay).sort((a, b) => byPay[b].omzet - byPay[a].omzet);
      const totalOmzet = labels.reduce((acc, key) => acc + byPay[key].omzet, 0);
      const totalBoekingen = labels.reduce((acc, key) => acc + (byPay[key]?.bookings?.size ?? 0), 0);

      destroyChart("excChartPayBar");
      const c = document.getElementById("excChartPayBar");
      if (c && labels.length) {
        charts.excChartPayBar = new Chart(c, {
          type: "bar",
          data: {
            labels,
            datasets: [
              {
                label: "% aandeel",
                // Toon aandeel (% omzet) op de y-as/balken.
                // Omzet blijft beschikbaar in de tooltip.
                data: labels.map((x) => {
                  const bookingsCount = byPay[x]?.bookings?.size ?? 0;
                  return totalBoekingen > 0 ? bookingsCount / totalBoekingen : 0;
                }),
                backgroundColor: COL.orangeSoft,
                borderColor: COL.orange,
                borderWidth: 1,
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { display: false },
              tooltip: {
                callbacks: {
                  title(items) {
                    return items[0]?.label || "";
                  },
                  label(ctx) {
                    const label = String(ctx.label || "");
                    const item = byPay[label];
                    const omzet = item ? num(item.omzet) : 0;
                    const bookings = item ? item.bookings.size : 0;
                    const aandeel = totalBoekingen > 0 ? bookings / totalBoekingen : 0;
                    const lines = item ? item.lines : 0;
                    return [
                      `Omzet: ${nfMoney.format(omzet)}`,
                      `Aantal excursies: ${nfInt.format(lines)}`,
                      `Aantal boekingen: ${nfInt.format(bookings)}`,
                      `Aandeel totaal: ${nfPct.format(aandeel)}`,
                    ];
                  },
                },
              },
            },
            scales: {
              x: { ticks: { color: COL.slate } },
              y: {
                ticks: {
                  color: COL.slate,
                  callback: (v) => nfPct.format(Number(v) || 0),
                },
                grid: { color: "rgba(0,0,0,0.06)" },
              },
            },
          },
        });
      }

      const tb = document.getElementById("excPayTableBody");
      const payTbl = document.getElementById("excPayTable");
      const emptyT = document.getElementById("excPayTableEmpty");
      const wirePay = typeof globalThis.TA_wireSortableTable === "function" ? globalThis.TA_wireSortableTable : null;

      const renderPayPendingBody = (rowArr) => {
        if (!tb) return;
        if (!rowArr.length) {
          tb.innerHTML = "";
          return;
        }
        tb.innerHTML = rowArr
          .map(
            (row) => `<tr>
            <td>${escapeHtml(String(row.label))}</td>
            <td>${escapeHtml(String(row.pay))}</td>
            <td class="text-end">${row.pending ? "Ja" : "Nee"}</td>
          </tr>`,
          )
          .join("");
      };

      if (tb) {
        const prob = rows.filter((raw) => {
          const r = /** @type {Record<string, unknown>} */ (raw);
          return isPending(r);
        });
        if (!prob.length) {
          excPayPendingRows = [];
          tb.innerHTML = "";
          if (emptyT) emptyT.classList.remove("d-none");
        } else {
          if (emptyT) emptyT.classList.add("d-none");
          excPayPendingRows = prob.slice(0, 50).map((raw) => {
            const r = /** @type {Record<string, unknown>} */ (raw);
            return {
              label: excursionDisplayLabel(r),
              pay: String(r.betaaloptie || "—"),
              pending: isPending(r) ? 1 : 0,
            };
          });
          renderPayPendingBody(excPayPendingRows);
          if (payTbl && wirePay && excPayPendingRows.length) {
            wirePay(
              payTbl,
              () => excPayPendingRows.map((x) => ({ ...x })),
              (sorted) => {
                excPayPendingRows = sorted;
                renderPayPendingBody(sorted);
              },
            );
          }
        }
      }
    },
  };

  const ExcursionsDestinationsSection = {
    syncSelectorOptions() {
      const sel = document.getElementById("excDestTabSelect");
      if (!sel) return;
      const names = _optionsDest
        .map((d) => String((d && (d.naam || d.name)) || "").trim())
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b, "nl"));
      sel.innerHTML = "";
      names.forEach((name) => {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        sel.appendChild(opt);
      });
      const current = _destTabSelection && names.includes(_destTabSelection) ? _destTabSelection : "";
      const fallback = pickDefaultDestinationName();
      _destTabSelection = current || fallback || "";
      if (_destTabSelection) sel.value = _destTabSelection;
    },

    /**
     * Forceer tab-bestemmingsfilter client-side, ook als backend ruimer antwoordt.
     * @param {Record<string, unknown>[]} rows
     * @param {string} destination
     */
    filterRowsForDestination(rows, destination) {
      const selected = String(destination || "")
        .trim()
        .toLowerCase();
      if (!selected) return [];
      return rows.filter((raw) => {
        const r = /** @type {Record<string, unknown>} */ (raw);
        const rowDest = String(r.destination ?? r.bestemming_naam ?? "")
          .trim()
          .toLowerCase();
        return rowDest === selected;
      });
    },

    getSelectedDestination() {
      const sel = document.getElementById("excDestTabSelect");
      const value = String((sel && sel.value) || _destTabSelection || "").trim();
      if (value) _destTabSelection = value;
      if (_destTabSelection) return _destTabSelection;
      _destTabSelection = pickDefaultDestinationName();
      return _destTabSelection;
    },

    /** @param {Record<string, unknown>[]} rows */
    render(rows) {
      const selectedDestination = this.getSelectedDestination();
      const currentEl = document.getElementById("excDestTabCurrent");
      const body = document.getElementById("excDestTableBody");
      const empty = document.getElementById("excDestTableEmpty");
      if (currentEl) currentEl.textContent = selectedDestination || "—";
      if (!body) return;

      /** @type {Map<string, { lines: number, bookings: Set<string>, paxMap: Map<string, number>, omzet: number, inkoopSom: number, winstSom: number, label: string }>} */
      const agg = new Map();
      for (const raw of rows) {
        const r = /** @type {Record<string, unknown>} */ (raw);
        const key = excursionCompositeKey(r);
        const bid = String(r.booking_id || "").trim();
        if (!agg.has(key)) {
          agg.set(key, {
            lines: 0,
            bookings: new Set(),
            paxMap: new Map(),
            omzet: 0,
            inkoopSom: 0,
            winstSom: 0,
            label: excursionDisplayLabel(r),
          });
        }
        const g = agg.get(key);
        if (!g) continue;
        g.lines += 1;
        g.omzet += num(r.verkoop_prijs);
        g.inkoopSom += resolveInkoopPrijs(r);
        // Winst altijd via calcWinst: rijen zonder geldige (>0) inkoopprijs leveren 0 winst.
        // Zo voorkomen we dat omzet als winst wordt geteld bij ontbrekende of nul-inkoopprijs.
        g.winstSom += calcWinst(r);
        const bKey = bid || `${key}::r${g.lines}`;
        if (!g.bookings.has(bKey)) {
          g.bookings.add(bKey);
          g.paxMap.set(bKey, num(r.booking_pax));
        }
      }

      const data = [...agg.values()]
        .map((g) => {
          let paxTotaal = 0;
          for (const v of g.paxMap.values()) paxTotaal += num(v);
          const lines = Math.max(1, g.lines);
          const avgVerkoop = g.omzet / lines;
          const avgInkoop = g.inkoopSom / lines;
          const winst = g.winstSom;
          return {
            name: g.label,
            bookings: g.bookings.size,
            pax: paxTotaal,
            avgVerkoop,
            avgInkoop,
            omzet: g.omzet,
            winst,
          };
        })
        .sort((a, b) => b.bookings - a.bookings || a.name.localeCompare(b.name, "nl"));

      const destTbl = document.getElementById("excDestTable");
      const wireDest = typeof globalThis.TA_wireSortableTable === "function" ? globalThis.TA_wireSortableTable : null;

      const renderDestTabBody = (rowArr) => {
        body.innerHTML = rowArr
          .map((item) => {
            const winstClass = globalThis.SemanticPerformance
              ? globalThis.SemanticPerformance.textClass(item.winst, "profit")
              : "";
            return `<tr>
          <td>${escapeHtml(item.name)}</td>
          <td class="text-end">${nfInt.format(item.bookings)}</td>
          <td class="text-end">${nfInt.format(item.pax)}</td>
          <td class="text-end">${nfMoney.format(item.avgVerkoop)}</td>
          <td class="text-end">${nfMoney.format(item.avgInkoop)}</td>
          <td class="text-end">${nfMoney.format(item.omzet)}</td>
          <td class="text-end ${winstClass}">${nfMoney.format(item.winst)}</td>
        </tr>`;
          })
          .join("");
      };

      body.innerHTML = "";
      if (!data.length) {
        excDestTabTableRows = [];
        if (empty) empty.classList.remove("d-none");
        return;
      }
      if (empty) empty.classList.add("d-none");

      excDestTabTableRows = data.map((d) => ({ ...d }));
      renderDestTabBody(excDestTabTableRows);
      if (destTbl && wireDest && excDestTabTableRows.length) {
        wireDest(
          destTbl,
          () => excDestTabTableRows.map((r) => ({ ...r })),
          (sorted) => {
            excDestTabTableRows = sorted;
            renderDestTabBody(sorted);
          },
        );
      }
    },
  };

  function aggregateForTable(rows) {
    /** @type {Map<string, Record<string, unknown>>} */
    const m = new Map();
    for (const raw of rows) {
      const r = /** @type {Record<string, unknown>} */ (raw);
      const k = excursionCompositeKey(r);
      if (!m.has(k)) {
        m.set(k, {
          excursie_naam: r.excursie_naam,
          destination: r.destination,
          brands: /** @type {Set<string>} */ (new Set()),
          bookingIds: new Set(),
          paxMap: new Map(),
          omzet: 0,
          winst: 0,
          channels: new Set(),
          onlineAny: false,
          betaalopties: new Set(),
          pendingAny: false,
          days: [],
        });
      }
      const g = /** @type {any} */ (m.get(k));
      const br = String(r.brand || "").trim() || "—";
      g.brands.add(br);
      const bid = String(r.booking_id || "");
      g.bookingIds.add(bid);
      if (!g.paxMap.has(bid)) g.paxMap.set(bid, num(r.booking_pax));
      g.omzet += num(r.verkoop_prijs);
      g.winst += calcWinst(r);
      g.channels.add(String(r.sales_channel || ""));
      if (r.geboekt_in_online_account) g.onlineAny = true;
      g.betaalopties.add(normalizedPayOption(r));
      if (isPending(r)) g.pendingAny = true;
      const dep = String(r.departure_date || "").slice(0, 10);
      const add = String(r.datum_toegevoegd || "").slice(0, 10);
      if (dep && add) {
        const d1 = new Date(dep);
        const d2 = new Date(add);
        if (!Number.isNaN(d1.getTime()) && !Number.isNaN(d2.getTime())) {
          g.days.push(Math.round((d1.getTime() - d2.getTime()) / 86400000));
        }
      }
    }
    const out = [];
    for (const g of m.values()) {
      let pax = 0;
      for (const v of g.paxMap.values()) pax += v;
      const avgD = g.days.length ? g.days.reduce((a, b) => a + b, 0) / g.days.length : null;
      const nm = String(g.excursie_naam ?? "").trim() || "—";
      const dest = String(g.destination ?? "").trim() || "—";
      const brandList = [...(g.brands || new Set())].filter((x) => x && x !== "—");
      const brandDisp = brandList.length ? brandList.sort((a, b) => a.localeCompare(b, "nl")).join(", ") : "—";
      out.push({
        excursie_naam: g.excursie_naam,
        destination: g.destination,
        brand: brandDisp,
        sortPrimary: `${nm}\t${dest}`.toLowerCase(),
        bookings: g.bookingIds.size,
        pax,
        omzet: g.omzet,
        winst: g.winst,
        sales_channel: [...g.channels].filter(Boolean).join(", ") || "—",
        online: g.onlineAny ? 1 : 0,
        betaaloptie: [...g.betaalopties].filter(Boolean).join(", ") || "—",
        pending: g.pendingAny ? 1 : 0,
        days_pre: avgD != null && Number.isFinite(avgD) ? avgD : -1e12,
      });
    }
    return out;
  }

  const ExcursionsTableSection = {
    /** @param {Record<string, unknown>[]} rows */
    render(rows) {
      const tb = document.getElementById("excDetailTableBody");
      const empty = document.getElementById("excTableEmpty");
      const tbl = document.getElementById("excDetailTable");
      const wire = typeof globalThis.TA_wireSortableTable === "function" ? globalThis.TA_wireSortableTable : null;
      if (!tb) return;
      const agg = aggregateForTable(rows);
      if (!agg.length) {
        tb.innerHTML = "";
        excDetailTableRows = [];
        if (empty) empty.classList.remove("d-none");
        return;
      }
      if (empty) empty.classList.add("d-none");

      const renderDetailBody = (rowArr) => {
        tb.innerHTML = rowArr
          .map((raw) => {
            const row = /** @type {Record<string, unknown>} */ (raw);
            const winstClass = globalThis.SemanticPerformance
              ? globalThis.SemanticPerformance.textClass(num(row.winst), "profit")
              : "";
            const dPre = num(row.days_pre);
            const dPreLabel = dPre > -1e11 ? nfDec.format(dPre) : "—";
            return `<tr>
          <td>${escapeHtml(String(row.excursie_naam || "—"))}</td>
          <td>${escapeHtml(String(row.destination || "—"))}</td>
          <td>${escapeHtml(String(row.brand || "—"))}</td>
          <td>${nfInt.format(num(row.bookings))}</td>
          <td>${nfInt.format(num(row.pax))}</td>
          <td>${nfMoney.format(num(row.omzet))}</td>
          <td class="${winstClass}">${nfMoney.format(num(row.winst))}</td>
          <td>${escapeHtml(String(row.sales_channel))}</td>
          <td>${row.online ? "Ja" : "Nee"}</td>
          <td>${escapeHtml(String(row.betaaloptie))}</td>
          <td>${row.pending ? "Ja" : "Nee"}</td>
          <td>${dPreLabel}</td>
        </tr>`;
          })
          .join("");
      };

      excDetailTableRows = agg
        .map((r) => ({ ...r }))
        .sort((a, b) => num(b.omzet) - num(a.omzet) || String(a.sortPrimary).localeCompare(String(b.sortPrimary), "nl"));
      renderDetailBody(excDetailTableRows);
      if (tbl && wire && excDetailTableRows.length) {
        wire(
          tbl,
          () => excDetailTableRows.map((r) => ({ ...r })),
          (sorted) => {
            excDetailTableRows = sorted;
            renderDetailBody(sorted);
          },
        );
      }
    },
  };

  async function fetchYear(year, st, signal) {
    const destCsv = Array.isArray(st.dests) ? st.dests.join(",") : st.dest || "";
    const excursieCsv = Array.isArray(st.excursies) ? st.excursies.join(",") : st.excursie || "";
    const params = new URLSearchParams({
      brand: st.brand,
      destination: destCsv,
      land: st.land || "__all__",
      year: String(year),
      excursie: excursieCsv,
    });
    if (EXCURSIONS_DEBUG) params.set("exc_debug", "1");
    const cacheKey = `${st.brand}|${destCsv}|${st.land || "__all__"}|${year}|${excursieCsv}|${EXCURSIONS_DEBUG ? "d1" : "d0"}`;
    if (EXCURSIONS_DATA_CACHE.has(cacheKey)) return EXCURSIONS_DATA_CACHE.get(cacheKey);
    if (EXCURSIONS_INFLIGHT.has(cacheKey)) return EXCURSIONS_INFLIGHT.get(cacheKey);

    const startedAt = performance.now();
    const p = (async () => {
      const res = await fetch(`${DATA_URL}?${params}`, { ...fetchJson, signal });
      const j = await readJsonResponse(res, "Excursies-data");
      if (j.error) throw new Error(String(j.error));
      const rawRows = Array.isArray(j.rows) ? j.rows : [];
      const meta = j.meta && typeof j.meta === "object" ? j.meta : {};
      const rows = EXCURSIONS_DEBUG
        ? rawRows.map((r) => /** @type {Record<string, unknown>} */ (r))
        : rawRows.map((r) => /** @type {Record<string, unknown>} */ (r)).filter(isActiveBookingRow);
      const out = { rows, meta, rawRpcRowCount: rawRows.length };
      EXCURSIONS_DATA_CACHE.set(cacheKey, out);
      const durationMs = Math.round(performance.now() - startedAt);
      console.info(`excursies_fetch done key=${cacheKey} rows=${rawRows.length} duration_ms=${durationMs}`);
      return out;
    })();
    EXCURSIONS_INFLIGHT.set(cacheKey, p);
    try {
      return await p;
    } finally {
      EXCURSIONS_INFLIGHT.delete(cacheKey);
    }
  }

  function setApplyButtonLoading(loading) {
    const btn = document.getElementById("excApply");
    if (!btn) return;
    if (loading) {
      btn.setAttribute("disabled", "disabled");
      btn.dataset.originalText = btn.textContent || "Toepassen";
      btn.textContent = "Bezig...";
      return;
    }
    btn.removeAttribute("disabled");
    btn.textContent = btn.dataset.originalText || "Toepassen";
  }

  /** Kalenderjaar als dat in `availableYears` voorkomt, anders alle jaren (`"0"`). */
  function defaultExcYearSelectValue(availableYears) {
    const cy = new Date().getFullYear();
    const nums = Array.isArray(availableYears) ? availableYears : [];
    if (nums.includes(cy)) return String(cy);
    return "0";
  }

  async function loadOptions() {
    const res = await fetch(OPTIONS_URL, fetchJson);
    const j = await readJsonResponse(res, "Excursies-opties");
    _optionsYears = Array.isArray(j.years) ? j.years.map((x) => Number(x)).filter((y) => y > 0) : [];
    _optionsBrands = Array.isArray(j.brands) ? j.brands : [];
    _optionsLanden = Array.isArray(j.landen) ? j.landen.map((x) => String(x || "").trim()).filter(Boolean) : [];
    _optionsDest = Array.isArray(j.bestemmingen) ? j.bestemmingen : [];
    _manageExcursions = Array.isArray(j.excursies_beheer) ? j.excursies_beheer : [];
    _excursieOptions = Array.isArray(j.excursie_filters)
      ? j.excursie_filters
          .map((raw) => ({
            key: String(raw && raw.key ? raw.key : ""),
            naam: String(raw && raw.naam ? raw.naam : ""),
            bestemming_naam: String(raw && raw.bestemming_naam ? raw.bestemming_naam : ""),
            label: String(raw && raw.label ? raw.label : raw && raw.naam ? raw.naam : ""),
          }))
          .filter((r) => r.key && r.naam)
      : [];
    if (!_excursieOptions.length && Array.isArray(j.excursie_namen)) {
      _excursieOptions = j.excursie_namen
        .map((name) => {
          const naam = String(name || "").trim();
          return {
            key: naam,
            naam,
            bestemming_naam: "",
            label: naam,
          };
        })
        .filter((x) => x.naam);
    }
    if (Array.isArray(j.betaalopties) && j.betaalopties.length) _betaalopties = j.betaalopties;
  }

  function populateControls() {
    const y = document.getElementById("excYear");
    if (y) {
      const years = _optionsYears.length ? _optionsYears : [new Date().getFullYear()];
      if (IS_RESTRICTED_ROLE) {
        y.innerHTML = `<option value="${FORCED_YEAR}">${FORCED_YEAR}</option>`;
        y.value = String(FORCED_YEAR);
        y.disabled = true;
      } else {
        y.innerHTML =
          `<option value="0">Alle jaren</option>` + years.map((yr) => `<option value="${yr}">${yr}</option>`).join("");
        y.value = defaultExcYearSelectValue(years);
      }
    }
    const brand = document.getElementById("excBrand");
    if (brand) {
      while (brand.options.length > 1) brand.remove(1);
      _optionsBrands.forEach((b) => {
        const o = document.createElement("option");
        o.value = b;
        o.textContent = b;
        brand.appendChild(o);
      });
    }
    const land = document.getElementById("excLand");
    if (land) {
      land.innerHTML = '<option value="__all__">Alle landen</option>';
      _optionsLanden.forEach((value) => {
        const o = document.createElement("option");
        o.value = value;
        o.textContent = value;
        land.appendChild(o);
      });
    }
    const dest = document.getElementById("excDest");
    if (dest) {
      dest.innerHTML = "";
      _optionsDest.forEach((d) => {
        const naam = d.naam || d.name || "";
        if (!naam) return;
        const o = document.createElement("option");
        o.value = naam;
        o.textContent = naam;
        dest.appendChild(o);
      });
      if (window.TAMultiSelectFilter) {
        if (!excDestMulti) {
          excDestMulti = new window.TAMultiSelectFilter({
            selectEl: dest,
            placeholderAll: "Alle bestemmingen",
            searchPlaceholder: "Zoek bestemming...",
            itemLabelSingle: "bestemming",
            itemLabelPlural: "bestemmingen geselecteerd",
          });
        } else {
          excDestMulti.syncOptionsFromSelect();
        }
      }
    }
    const exSelect = document.getElementById("excExcursie");
    if (exSelect) {
      exSelect.innerHTML = "";
      _excursieOptions.forEach((opt) => {
        const o = document.createElement("option");
        o.value = String(opt.key || "");
        o.textContent = String(opt.label || opt.naam || opt.key || "");
        exSelect.appendChild(o);
      });
      if (window.TAMultiSelectFilter) {
        if (!excExcursieMulti) {
          excExcursieMulti = new window.TAMultiSelectFilter({
            selectEl: exSelect,
            placeholderAll: "Alle excursies",
            searchPlaceholder: "Zoek excursie...",
            itemLabelSingle: "excursie",
            itemLabelPlural: "excursies geselecteerd",
          });
        } else {
          excExcursieMulti.syncOptionsFromSelect();
        }
      }
    }
    const pay = document.getElementById("excPay");
    if (pay) {
      pay.innerHTML = '<option value="__all__">Alle</option>';
      _betaalopties.forEach((p) => {
        const o = document.createElement("option");
        o.value = p;
        o.textContent = p;
        pay.appendChild(o);
      });
    }
    readExcursionFiltersFromUrl();
    ExcursionsDestinationsSection.syncSelectorOptions();
  }

  function mergeExcursieOptionsFromRows(rows) {
    /** @type {Map<string, { key: string, naam: string, bestemming_naam?: string, label: string }>} */
    const map = new Map(_excursieOptions.map((x) => [x.key, x]));
    for (const raw of rows) {
      const r = /** @type {Record<string, unknown>} */ (raw);
      const naam = String(r.excursie_naam || "").trim();
      if (!naam) continue;
      const bestemming = String(r.destination || r.bestemming_naam || "").trim();
      const key = bestemming ? `${naam}\u0001${bestemming}` : naam;
      if (!map.has(key)) {
        map.set(key, {
          key,
          naam,
          bestemming_naam: bestemming,
          label: bestemming ? `${naam} · ${bestemming}` : naam,
        });
      }
    }
    _excursieOptions = [...map.values()].sort((a, b) => String(a.label).localeCompare(String(b.label), "nl"));
    if (excExcursieMulti && excExcursieMulti.selectEl) {
      const selected = excExcursieMulti.getValue();
      excExcursieMulti.setOptions(
        _excursieOptions.map((x) => ({
          value: String(x.key || ""),
          label: String(x.label || x.naam || x.key || ""),
        })),
      );
      excExcursieMulti.setValue(selected);
    }
  }

  function renderExcursieComboboxOptions(query = "") {
    const hidden = document.getElementById("excExcursie");
    const optionsRoot = document.getElementById("excExcursieOptions");
    if (!hidden || !optionsRoot) return;
    const current = String(hidden.value || "");
    const q = String(query || "")
      .trim()
      .toLowerCase();
    const fragment = document.createDocumentFragment();

    const makeOption = (value, label) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `excursion-combobox-option${current === value ? " is-active" : ""}`;
      btn.textContent = label;
      btn.dataset.value = value;
      btn.addEventListener("click", () => {
        hidden.value = value;
        updateExcursieComboboxLabel();
        const menu = document.getElementById("excExcursieMenu");
        const toggle = document.getElementById("excExcursieToggle");
        if (menu) menu.classList.add("d-none");
        if (toggle) toggle.setAttribute("aria-expanded", "false");
      });
      fragment.appendChild(btn);
    };

    makeOption("", "Alle excursies");
    _excursieOptions.forEach((opt) => {
      const label = String(opt.label);
      if (!q || label.toLowerCase().includes(q)) makeOption(String(opt.key), label);
    });
    optionsRoot.innerHTML = "";
    optionsRoot.appendChild(fragment);
    updateExcursieComboboxLabel();
  }

  function updateExcursieComboboxLabel() {
    const hidden = document.getElementById("excExcursie");
    const toggle = document.getElementById("excExcursieToggle");
    if (!hidden || !toggle) return;
    const val = String(hidden.value || "");
    if (!val) {
      toggle.textContent = "Alle excursies";
      return;
    }
    const found = _excursieOptions.find((x) => x.key === val);
    toggle.textContent = found ? found.label : val;
  }

  function bindExcursieCombobox() {
    const combobox = document.getElementById("excExcursieCombobox");
    const toggle = document.getElementById("excExcursieToggle");
    const menu = document.getElementById("excExcursieMenu");
    const search = document.getElementById("excExcursieSearch");
    if (!combobox || !toggle || !menu || !search) return;

    if (toggle.dataset.boundExcCombobox === "1") return;
    toggle.dataset.boundExcCombobox = "1";

    toggle.addEventListener("click", () => {
      const opening = menu.classList.contains("d-none");
      menu.classList.toggle("d-none");
      toggle.setAttribute("aria-expanded", opening ? "true" : "false");
      if (opening) {
        search.focus();
        renderExcursieComboboxOptions(String(search.value || ""));
      }
    });

    search.addEventListener("input", () => {
      renderExcursieComboboxOptions(String(search.value || ""));
    });

    document.addEventListener("click", (evt) => {
      const target = evt.target;
      if (!(target instanceof Node)) return;
      if (!combobox.contains(target)) {
        menu.classList.add("d-none");
        toggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  function parseMoneyInput(raw, required = false) {
    const t = String(raw == null ? "" : raw).trim().replace(",", ".");
    if (!t) {
      if (required) throw new Error("Vul alle verplichte velden in.");
      return null;
    }
    const v = Number(t);
    if (!Number.isFinite(v)) throw new Error("Gebruik een geldig bedrag.");
    if (v < 0) throw new Error("Bedragen moeten groter of gelijk aan 0 zijn.");
    return v;
  }

  function parsePercentageInput(raw) {
    const t = String(raw == null ? "" : raw).trim().replace(",", ".");
    if (!t) return null;
    const v = Number(t);
    if (!Number.isFinite(v)) throw new Error("Gebruik een geldig percentage.");
    if (v < 0 || v > 100) throw new Error("Commissiepercentage moet tussen 0 en 100 liggen.");
    return v;
  }

  /**
   * Houd commissie-bedrag en commissie-% altijd in sync.
   * `sourceField` bepaalt welk veld leidend is.
   * @param {string} sourceField
   */
  function deriveUpdatePricing(sourceField = "auto") {
    const verkoop = parseMoneyInput(document.getElementById("excUpdateSellPrice")?.value || "", true);
    const commissieInput = parseMoneyInput(document.getElementById("excUpdateCommission")?.value || "", false);
    const commissiePctInput = parsePercentageInput(document.getElementById("excUpdateCommissionPct")?.value || "");
    let commissie = commissieInput;
    let commissiePct = commissiePctInput;
    if (sourceField === "excUpdateCommissionPct") {
      if (commissiePct != null) {
        commissie = (verkoop * commissiePct) / 100;
      }
    } else if (sourceField === "excUpdateCommission") {
      if (commissie != null) {
        commissiePct = verkoop > 0 ? (commissie / verkoop) * 100 : 0;
      }
    } else if (sourceField === "excUpdateSellPrice") {
      // Bij wijziging van verkoopprijs: behoud % indien aanwezig, anders bedrag.
      if (commissiePct != null) {
        commissie = (verkoop * commissiePct) / 100;
      } else if (commissie != null) {
        commissiePct = verkoop > 0 ? (commissie / verkoop) * 100 : 0;
      }
    } else {
      // Fallback: bedrag leidend als beide gevuld zijn.
      if (commissie != null) {
        commissiePct = verkoop > 0 ? (commissie / verkoop) * 100 : 0;
      } else if (commissiePct != null) {
        commissie = (verkoop * commissiePct) / 100;
      }
    }
    if (commissie == null) {
      throw new Error("Vul commissie of commissiepercentage in.");
    }
    if (commissie > verkoop) {
      throw new Error("Commissie kan niet hoger zijn dan de verkoopprijs.");
    }
    const inkoop = verkoop - commissie;
    const buyEl = document.getElementById("excUpdateBuyPrice");
    const commissieEl = document.getElementById("excUpdateCommission");
    const pctEl = document.getElementById("excUpdateCommissionPct");
    if (buyEl) buyEl.value = inkoop.toFixed(2);
    if (commissieEl) commissieEl.value = commissie.toFixed(2);
    if (pctEl && commissiePct != null) pctEl.value = commissiePct.toFixed(2);
    return { verkoop, commissie, commissiePct, inkoop };
  }

  function setManageFormError(msg) {
    const el = document.getElementById("excManageFormError");
    if (!el) return;
    if (msg) {
      el.textContent = msg;
      el.classList.remove("d-none");
    } else {
      el.textContent = "";
      el.classList.add("d-none");
    }
  }

  function fillManageExcursieOptions() {
    const sel = document.getElementById("excUpdateExisting");
    if (!sel) return;
    sel.innerHTML = '<option value="">Kies excursie</option>';
    _manageExcursions.forEach((raw) => {
      const r = /** @type {Record<string, unknown>} */ (raw);
      const id = String(r.id || "");
      const naam = String(r.naam || "");
      if (!id || !naam) return;
      const apiNaam = r.bestemming_naam != null && String(r.bestemming_naam).trim() !== "" ? String(r.bestemming_naam).trim() : "";
      const destObj = _optionsDest.find((d) => String(d.id || "") === String(r.bestemming_id || ""));
      const destNaam =
        apiNaam ||
        (destObj && destObj.naam ? String(destObj.naam) : "") ||
        "Onbekende bestemming";
      const verkoopRaw = moneyOrNull(r.verkoopprijs);
      const verkoop = verkoopRaw != null ? nfMoney.format(verkoopRaw) : "—";
      const o = document.createElement("option");
      o.value = id;
      o.textContent = `${naam} · ${destNaam} · ${verkoop}`;
      o.dataset.verkoopprijs = verkoopRaw != null ? String(verkoopRaw) : "";
      o.dataset.commissie = moneyOrNull(r.commissie) != null ? String(moneyOrNull(r.commissie)) : "";
      o.dataset.commissiePercentage =
        moneyOrNull(r.commissie_percentage) != null ? String(moneyOrNull(r.commissie_percentage)) : "";
      o.dataset.kostjaar = r.kostjaar != null ? String(r.kostjaar) : "";
      sel.appendChild(o);
    });
  }

  async function submitManageExcursie() {
    clearError();
    clearSuccess();
    setManageFormError("");
    const submitBtn = document.getElementById("excManageSubmitBtn");
    const originalLabel = submitBtn ? submitBtn.textContent : "Opslaan";
    if (submitBtn) {
      submitBtn.setAttribute("disabled", "disabled");
      submitBtn.textContent = "Opslaan...";
    }
    try {
      const excursieId = String(document.getElementById("excUpdateExisting")?.value || "");
      if (!excursieId) throw new Error("Selecteer een bestaande excursie.");
      const pricing = deriveUpdatePricing();
      const yearRaw = String(document.getElementById("excUpdateYear")?.value || "").trim();
      const jaar = yearRaw ? Number(yearRaw) : new Date().getFullYear();
      if (!Number.isFinite(jaar) || jaar < 2000 || jaar > 2100) {
        throw new Error("Kostjaar moet tussen 2000 en 2100 liggen.");
      }
      /** @type {Record<string, unknown>} */
      const payload = {
        mode: "update_existing",
        excursie_id: excursieId,
        verkoopprijs: pricing.verkoop,
        inkoopprijs: pricing.inkoop,
        commissie: pricing.commissie,
        commissie_percentage: pricing.commissiePct,
        jaar: Math.trunc(jaar),
      };

      const res = await fetch(MANAGE_URL, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          ...fetchJson.headers,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      const j = await readJsonResponse(res, "Excursie opslaan");
      if (j.error) throw new Error(String(j.error));

      const modalEl = document.getElementById("excManageModal");
      const modalInstance = modalEl && window.bootstrap ? window.bootstrap.Modal.getInstance(modalEl) : null;
      if (modalInstance) modalInstance.hide();
      showSuccess("Inkoopprijs succesvol bijgewerkt.");
      await loadOptions();
      fillManageExcursieOptions();
      const searchEl = document.getElementById("excExcursieSearch");
      if (searchEl) searchEl.value = "";
      renderExcursieComboboxOptions("");
      await refresh();
    } catch (e) {
      setManageFormError(e instanceof Error ? e.message : String(e));
    } finally {
      if (submitBtn) {
        submitBtn.removeAttribute("disabled");
        submitBtn.textContent = originalLabel || "Opslaan";
      }
    }
  }

  async function refresh() {
    clearError();
    _perfExcPage = 0;
    const st = ExcursionsFilters.getState();
    const y = st.year;
    if (REFRESH_ABORT_CONTROLLER) {
      REFRESH_ABORT_CONTROLLER.abort();
    }
    REFRESH_ABORT_CONTROLLER = new AbortController();
    const { signal } = REFRESH_ABORT_CONTROLLER;
    REFRESH_SEQ += 1;
    const seq = REFRESH_SEQ;
    setApplyButtonLoading(true);
    try {
      if (y <= 0) {
        const allY = await fetchYear(0, st, signal);
        POOL_CUR = allY.rows;
        META_CUR = allY.meta;
        LAST_RAW_RPC_ROW_COUNT = allY.rawRpcRowCount ?? 0;
        POOL_PREV = [];
        POOL_TWO = [];
        META_PREV = {};
        META_TWO = {};
        mergeExcursieOptionsFromRows(POOL_CUR);
      } else {
        const [cur, prev] = await Promise.all([
          fetchYear(y, st, signal),
          fetchYear(y - 1, st, signal),
        ]);
        POOL_CUR = cur.rows;
        META_CUR = cur.meta;
        LAST_RAW_RPC_ROW_COUNT = cur.rawRpcRowCount ?? 0;
        mergeExcursieOptionsFromRows(POOL_CUR);
        POOL_PREV = prev.rows;
        META_PREV = prev.meta;
        POOL_TWO = [];
        META_TWO = {};
      }

      const destOverride = ExcursionsDestinationsSection.getSelectedDestination();
      if (destOverride) {
        POOL_DEST_CUR = ExcursionsDestinationsSection.filterRowsForDestination(
          POOL_CUR,
          destOverride,
        );
      } else {
        POOL_DEST_CUR = [];
      }

      setBanners(META_CUR);
      updateDebugBanner(META_CUR, st);
      const agg = buildAggregates();
      setEmptyDataBanner(META_CUR, agg.rows.length, LAST_RAW_RPC_ROW_COUNT, POOL_CUR.length);
      updateMissingInkoopBanner(agg.rows);
      ExcursionsKPIGrid.render(agg, st);
      ExcursionsPerformanceSection.render(agg.rows);
      ExcursionsRevenueSection.render(agg.rows, META_CUR);
      ExcursionsRevenueSection.renderRevDestChart(agg.rows);
      ExcursionsSalesChannelSection.render(agg.rows);
      ExcursionsTimingSection.render(agg.rows);
      ExcursionsDestinationsSection.render(applyClientRows(POOL_DEST_CUR));
      ExcursionsPaymentsSection.render(agg.rows);
      ExcursionsTableSection.render(agg.rows);
      syncExcursionFiltersToUrl();
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      showError(e instanceof Error ? e.message : String(e));
      POOL_CUR = [];
      LAST_RAW_RPC_ROW_COUNT = 0;
      document.getElementById("excursionsEmptyData")?.classList.add("d-none");
    } finally {
      if (seq === REFRESH_SEQ) {
        setApplyButtonLoading(false);
      }
    }
  }

  function scheduleApplyRefresh(delayMs = 300) {
    if (APPLY_DEBOUNCE_TIMER) {
      clearTimeout(APPLY_DEBOUNCE_TIMER);
      APPLY_DEBOUNCE_TIMER = null;
    }
    APPLY_DEBOUNCE_TIMER = setTimeout(async () => {
      APPLY_DEBOUNCE_TIMER = null;
      const draft = ExcursionsFilters.getDraftState();
      const current = ExcursionsFilters.getState();
      if (stateKey(draft) === stateKey(current)) return;
      ExcursionsFilters.applyDraft();
      syncExcursionFiltersToUrl();
      await refresh();
    }, delayMs);
  }

  async function refreshDestinationsTableOnly() {
    clearError();
    const st = ExcursionsFilters.getState();
    const y = st.year;
    const selectedDestination = ExcursionsDestinationsSection.getSelectedDestination();
    const body = document.getElementById("excDestTableBody");
    const empty = document.getElementById("excDestTableEmpty");
    if (body) body.innerHTML = "";
    if (empty) empty.classList.remove("d-none");
    try {
      if (selectedDestination) {
        const destState = { ...st, dest: selectedDestination };
        const destCur = await fetchYear(y <= 0 ? 0 : y, destState);
        // Nooit terugvallen op vorige/default data na expliciete filteractie.
        POOL_DEST_CUR = ExcursionsDestinationsSection.filterRowsForDestination(
          destCur.rows,
          selectedDestination,
        );
      } else {
        POOL_DEST_CUR = [];
      }
      ExcursionsDestinationsSection.render(applyClientRows(POOL_DEST_CUR));
    } catch (e) {
      POOL_DEST_CUR = [];
      ExcursionsDestinationsSection.render([]);
      showError(e instanceof Error ? e.message : String(e));
    }
  }

  const ExcursionsPage = {
    async init() {
      if (EXCURSIONS_DEBUG) {
        const dbg = document.getElementById("excursionsDebugBanner");
        if (dbg) {
          dbg.classList.remove("d-none");
          dbg.textContent =
            "Debugmodus (?exc_debug=1): laden… Na eerste refresh verschijnt hier server meta.debug + effectieve filters.";
        }
      }
      await loadOptions();
      populateControls();
      fillManageExcursieOptions();
      APPLIED_FILTER_STATE = { ...ExcursionsFilters.getDraftState() };
      document.getElementById("excUpdateExisting")?.addEventListener("change", () => {
        const sel = document.getElementById("excUpdateExisting");
        const selected = sel && sel.selectedOptions && sel.selectedOptions[0] ? sel.selectedOptions[0] : null;
        const verkoopEl = document.getElementById("excUpdateSellPrice");
        const commissieEl = document.getElementById("excUpdateCommission");
        const pctEl = document.getElementById("excUpdateCommissionPct");
        const buyEl = document.getElementById("excUpdateBuyPrice");
        const yearEl = document.getElementById("excUpdateYear");
        if (!selected) return;
        if (verkoopEl) verkoopEl.value = selected.dataset.verkoopprijs || "";
        if (commissieEl) commissieEl.value = selected.dataset.commissie || "";
        if (pctEl) pctEl.value = selected.dataset.commissiePercentage || "";
        if (yearEl) yearEl.value = selected.dataset.kostjaar || String(new Date().getFullYear());
        try {
          deriveUpdatePricing("excUpdateCommission");
          setManageFormError("");
        } catch {
          if (buyEl) buyEl.value = "";
        }
      });
      const pricingInputs = ["excUpdateSellPrice", "excUpdateCommission", "excUpdateCommissionPct"];
      pricingInputs.forEach((id) => {
        document.getElementById(id)?.addEventListener("input", () => {
          try {
            deriveUpdatePricing(id);
            setManageFormError("");
          } catch {
            const buyEl = document.getElementById("excUpdateBuyPrice");
            if (buyEl) buyEl.value = "";
          }
        });
      });
      document.getElementById("excCreateBtn")?.addEventListener("click", () => {
        setManageFormError("");
        clearSuccess();
        const sell = document.getElementById("excUpdateSellPrice");
        const comm = document.getElementById("excUpdateCommission");
        const pct = document.getElementById("excUpdateCommissionPct");
        const buy = document.getElementById("excUpdateBuyPrice");
        const year = document.getElementById("excUpdateYear");
        if (sell) sell.value = "";
        if (comm) comm.value = "";
        if (pct) pct.value = "";
        if (buy) buy.value = "";
        if (year) year.value = String(new Date().getFullYear());
        const modalEl = document.getElementById("excManageModal");
        if (modalEl && window.bootstrap) {
          const modal = window.bootstrap.Modal.getOrCreateInstance(modalEl);
          modal.show();
        }
      });
      document.getElementById("excDestTabApplyBtn")?.addEventListener("click", async (e) => {
        e.preventDefault();
        await refreshDestinationsTableOnly();
      });
      document.getElementById("excManageSubmitBtn")?.addEventListener("click", () => submitManageExcursie());
      const yearEl = document.getElementById("excUpdateYear");
      if (yearEl && !yearEl.value) yearEl.value = String(new Date().getFullYear());
      document.getElementById("excApply")?.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        scheduleApplyRefresh(300);
      });
      document.getElementById("excPerfPrev")?.addEventListener("click", (e) => {
        e.preventDefault();
        const rows = applyClientRows(POOL_CUR);
        if (_perfExcPage > 0) {
          _perfExcPage -= 1;
          ExcursionsPerformanceSection.render(rows);
        }
      });
      document.getElementById("excPerfNext")?.addEventListener("click", (e) => {
        e.preventDefault();
        const rows = applyClientRows(POOL_CUR);
        const pairs = getPerfExcursionStats(rows);
        const maxPage = Math.max(0, Math.ceil(pairs.length / PERF_EXC_PAGE_SIZE) - 1);
        if (_perfExcPage < maxPage) {
          _perfExcPage += 1;
          ExcursionsPerformanceSection.render(rows);
        }
      });
      document.getElementById("excDestUptakePrev")?.addEventListener("click", (e) => {
        e.preventDefault();
        if (!destUptakePaginator) return;
        destUptakePaginator.prevPage();
        ExcursionsRevenueSection.render(applyClientRows(POOL_CUR), META_CUR);
      });
      document.getElementById("excDestUptakeNext")?.addEventListener("click", (e) => {
        e.preventDefault();
        if (!destUptakePaginator) return;
        destUptakePaginator.nextPage();
        ExcursionsRevenueSection.render(applyClientRows(POOL_CUR), META_CUR);
      });
      document.getElementById("excRevDestPrev")?.addEventListener("click", (e) => {
        e.preventDefault();
        if (!revDestPaginator) return;
        revDestPaginator.prevPage();
        ExcursionsRevenueSection.renderRevDestChart(applyClientRows(POOL_CUR));
      });
      document.getElementById("excRevDestNext")?.addEventListener("click", (e) => {
        e.preventDefault();
        if (!revDestPaginator) return;
        revDestPaginator.nextPage();
        ExcursionsRevenueSection.renderRevDestChart(applyClientRows(POOL_CUR));
      });
      document.getElementById("excDestTabSelect")?.addEventListener("change", (evt) => {
        const target = evt.target;
        if (!(target instanceof HTMLSelectElement)) return;
        _destTabSelection = String(target.value || "").trim();
        const currentEl = document.getElementById("excDestTabCurrent");
        if (currentEl) currentEl.textContent = _destTabSelection || "—";
      });
      document.getElementById("excReset")?.addEventListener("click", async () => {
        const y = document.getElementById("excYear");
        const brand = document.getElementById("excBrand");
        const dest = document.getElementById("excDest");
        const land = document.getElementById("excLand");
        const ex = document.getElementById("excExcursie");
        const ch = document.getElementById("excChannel");
        const pay = document.getElementById("excPay");

        if (y && !IS_RESTRICTED_ROLE) y.value = defaultExcYearSelectValue(_optionsYears);
        if (brand) brand.value = "__all__";
        if (dest) dest.value = "";
        excDestMulti?.clear();
        if (land) land.value = "__all__";
        if (ex) ex.value = "";
        excExcursieMulti?.clear();
        if (ch) ch.value = "__all__";
        if (pay) pay.value = "__all__";
        APPLIED_FILTER_STATE = null;
        ExcursionsFilters.applyDraft();
        syncExcursionFiltersToUrl();
        await refresh();
      });
      document.querySelectorAll("#excursionsMainTabs button[data-bs-toggle]").forEach((btn) => {
        btn.addEventListener("shown.bs.tab", () => {
          Object.values(charts).forEach((ch) => {
            try {
              ch.resize();
            } catch {
              /* ignore */
            }
          });
        });
      });
      await refresh();
    },
  };

  const safeInit = async () => {
    try {
      await ExcursionsPage.init();
    } catch (error) {
      ExcursionsToast.show("error", "Kon Excursies-pagina niet initialiseren. Ververs de pagina en probeer opnieuw.");
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      void safeInit();
    });
  } else {
    void safeInit();
  }
})();
