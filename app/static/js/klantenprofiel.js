(() => {
  const root = document.getElementById("kpPage");
  if (!root) return;

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
    typeof window.__KLANTENPROFIEL_API_BASE__ === "string" ? window.__KLANTENPROFIEL_API_BASE__.trim() : "";
  const merged = pickApiBase(pageBase, serverBase);
  const mountBase = merged.replace(/\/klantenprofiel$/i, "");
  const kpApi = typeof window !== "undefined" ? window.__KP_API__ : null;
  const API_OPT =
    kpApi && typeof kpApi.options === "string" && kpApi.options ? kpApi.options : `${mountBase}/klantenprofiel/options`;
  const API_DATA =
    kpApi && typeof kpApi.data === "string" && kpApi.data ? kpApi.data : `${mountBase}/klantenprofiel/data`;
  const API_REPEAT_DATA =
    kpApi && typeof kpApi.repeatData === "string" && kpApi.repeatData
      ? kpApi.repeatData
      : `${mountBase}/klantenprofiel/repeat-data`;
  const API_TRAVELER_ORIGIN =
    kpApi && typeof kpApi.travelerOriginDonut === "string" && kpApi.travelerOriginDonut
      ? kpApi.travelerOriginDonut
      : `${mountBase}/klantenprofiel/traveler-origin-donut`;

  const fetchJson = { credentials: "same-origin" };

  async function readJsonResponse(res, label) {
    const text = await res.text();
    const trimmed = (text || "").trimStart();
    if (!trimmed) throw new Error(`${label}: lege response (HTTP ${res.status}).`);
    if (trimmed.startsWith("<")) {
      throw new Error(`${label}: de server antwoordde met HTML (${res.status}), niet met JSON.`);
    }
    let data = {};
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`${label}: ongeldige JSON (HTTP ${res.status}).`);
    }
    if (!res.ok) {
      const d = data && typeof data === "object" ? data : null;
      const piece = d && (d.error ?? d.message ?? d.hint ?? d.details);
      const msg =
        piece != null && String(piece).trim() !== ""
          ? String(piece).trim()
          : `${label}: HTTP ${res.status}`;
      throw new Error(msg);
    }
    return data;
  }

  function formatClientError(e) {
    if (e instanceof Error && e.message && e.message !== "0") return e.message;
    const s = e instanceof Error ? e.message : String(e);
    if (!s || s === "0") return "Onbekende fout (zie browserconsole F12).";
    return s;
  }

  const nf = new Intl.NumberFormat("nl-NL");
  const THEME = {
    orange: "#F97316",
    orangeLight: "#FDBA74",
    orangeDark: "#C2410C",
    grid: "#E2E8F0",
    text: "#64748B",
    neutralSoft: "#CBD5E1",
    strongText: "#0F172A",
  };

  function hexToRgba(hex, alpha) {
    const h = String(hex).replace("#", "");
    if (h.length !== 6) return `rgba(0,0,0,${alpha})`;
    const n = parseInt(h, 16);
    // eslint-disable-next-line no-bitwise
    const r = (n >> 16) & 255;
    // eslint-disable-next-line no-bitwise
    const g = (n >> 8) & 255;
    // eslint-disable-next-line no-bitwise
    const b = n & 255;
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function tRgba(hex, alpha) {
    return hexToRgba(hex, alpha);
  }

  const COL_GRID = THEME.grid;
  const MAAND_KORT = ["", "jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];

  const BPP_ORIGIN_LABELS = { BE: "BE", NL: "NL", IT: "IT", OTHER: "Overig" };
  const countryColors = window.CountryColors || null;
  const KP_DONUT_COLORS = ["#0d9488", "#64748b", "#a78bfa", "#cbd5e1"];

  function originColor(code, fallback) {
    const key = String(code || "").toUpperCase();
    if (countryColors?.colorForCountry) return countryColors.colorForCountry(key, fallback);
    if (key === "BE") return "#c2410c";
    if (key === "NL") return "#f59e0b";
    return fallback;
  }

  function originHoverColor(code, fallback) {
    const key = String(code || "").toUpperCase();
    if (countryColors?.hoverColorForCountry) return countryColors.hoverColorForCountry(key, fallback);
    if (key === "BE") return "#9a3412";
    if (key === "NL") return "#d97706";
    return fallback;
  }

  function buildPaxOverTimeSeriesMonth(payload) {
    const year = Number((payload.meta || {}).year) || new Date().getFullYear();
    const labels = Array.from({ length: 12 }, (_, i) => {
      const m = i + 1;
      return `${MAAND_KORT[m]} '${String(year).slice(-2)}`;
    });
    const map = new Map();
    const fromTotal = payload.month_pax_total;
    if (Array.isArray(fromTotal) && fromTotal.length) {
      fromTotal.forEach((x) => map.set(Number(x.month), Number(x.pax_total || 0)));
    } else if (Array.isArray(payload.month_be_nl)) {
      payload.month_be_nl.forEach((x) => {
        const mo = Number(x.month);
        map.set(mo, (map.get(mo) || 0) + Number(x.pax_be || 0) + Number(x.pax_nl || 0));
      });
    }
    const values = Array.from({ length: 12 }, (_, i) => Number(map.get(i + 1) ?? 0));
    return { labels, values };
  }

  /** Zelfde idee als Pax-grafiek: altijd 12 maanden zodat n > windowSize en pijlen zinvol zijn. */
  function padAgeByMonth12(rows) {
    const byM = new Map((rows || []).map((r) => [Number(r.month), r]));
    const out = [];
    for (let m = 1; m <= 12; m += 1) {
      if (byM.has(m)) out.push(byM.get(m));
      else out.push({ month: m, avg_age: null, n_age: null });
    }
    return out;
  }

  function padGroupByMonth12(rows) {
    const byM = new Map((rows || []).map((r) => [Number(r.month), r]));
    const out = [];
    for (let m = 1; m <= 12; m += 1) {
      if (byM.has(m)) out.push(byM.get(m));
      else out.push({ month: m, avg_party: null });
    }
    return out;
  }

  function trimMonthRowsToDataWindow(rows, isValidValue) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return [];
    const valid =
      typeof isValidValue === "function"
        ? isValidValue
        : (v) => v != null && Number.isFinite(Number(v));
    let first = -1;
    let last = -1;
    for (let i = 0; i < list.length; i += 1) {
      if (valid(list[i])) {
        first = i;
        break;
      }
    }
    if (first < 0) return [];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (valid(list[i])) {
        last = i;
        break;
      }
    }
    if (last < first) return [];
    return list.slice(first, last + 1);
  }

  function buildPaxOverTimeSeriesWeek(payload) {
    const rows = [...(payload.week_pax_total || [])].sort((a, b) => {
      const da = String(a.week_start || "");
      const db = String(b.week_start || "");
      return da.localeCompare(db);
    });
    const labels = rows.map((r) => {
      const d = String(r.week_start || "").slice(0, 10);
      if (!d) return "—";
      return (window.TADate && window.TADate.formatDate && window.TADate.formatDate(d, d)) || d;
    });
    const values = rows.map((r) => Number(r.pax_total || 0));
    return { labels, values };
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  const charts = {};
  function destroyChart(id) {
    if (charts[id]) {
      charts[id].destroy();
      charts[id] = null;
    }
  }

  const els = {
    err: document.getElementById("kpError"),
    year: document.getElementById("kpYear"),
    brand: document.getElementById("kpBrand"),
    dest: document.getElementById("kpDest"),
    period: document.getElementById("kpPeriod"),
    origin: document.getElementById("kpOrigin"),
    travelerProvince: document.getElementById("kpTravelerProvince"),
    travelerAge: document.getElementById("kpTravelerAge"),
    brandLand: document.getElementById("kpBrandLand"),
    apply: document.getElementById("kpApply"),
    reset: document.getElementById("kpReset"),
    loading: document.getElementById("kpLoading"),
    dash: document.getElementById("kpDash"),
    kpiRow: document.getElementById("kpKpiRow"),
    filterContextLine: document.getElementById("kpFilterContextLine"),
    paxOverTimeCanvas: document.getElementById("kpChartPaxOverTime"),
    ageLargestSegmentEl: document.getElementById("kpAgeLargestSegment"),
    genderFallbackNote: document.getElementById("kpGenderFallbackNote"),
    schoolConc: document.getElementById("kpSchoolConc"),
    loyaltyRepeatTbody: document.getElementById("kpLoyaltyRepeatTbody"),
    loyaltyDetailModal: document.getElementById("kpLoyaltyDetailModal"),
    loyaltyDetailTbody: document.getElementById("kpLoyaltyDetailTbody"),
    loyaltyDetailIntro: document.getElementById("kpLoyaltyDetailIntro"),
    loyaltyRepeatPctEl: document.getElementById("kpLoyaltyRepeatPct"),
    loyaltyDeltaTextEl: document.getElementById("kpLoyaltyDeltaText"),
    loyaltyPaxSplit: document.getElementById("kpLoyaltyPaxSplit"),
    loyaltyDonutEmpty: document.getElementById("kpLoyaltyDonutEmpty"),
    provPaxBtn: document.getElementById("kpProvPaxBtn"),
    provBookBtn: document.getElementById("kpProvBookBtn"),
    provMeta: document.getElementById("kpProvMeta"),
    paxGranMonth: document.getElementById("kpPaxGranMonth"),
    paxGranWeek: document.getElementById("kpPaxGranWeek"),
    repeatPrev: document.getElementById("kpRepeatPrev"),
    repeatNext: document.getElementById("kpRepeatNext"),
    repeatPageLabel: document.getElementById("kpRepeatPageLabel"),
    schoolProvinceFilter: document.getElementById("kpSchoolProvinceFilter"),
    repeatLoadBtn: document.getElementById("kpRepeatLoadBtn"),
    repeatLoading: document.getElementById("kpRepeatLoading"),
    repeatErrorWrap: document.getElementById("kpRepeatErrorWrap"),
    repeatErrorText: document.getElementById("kpRepeatErrorText"),
    repeatRetryBtn: document.getElementById("kpRepeatRetryBtn"),
  };

  function setErr(msg) {
    if (!els.err) return;
    if (!msg) {
      els.err.classList.add("d-none");
      els.err.textContent = "";
      return;
    }
    els.err.textContent = msg;
    els.err.classList.remove("d-none");
  }

  function setRepeatLoadingUi(isLoading) {
    if (els.repeatLoading) {
      els.repeatLoading.classList.toggle("d-none", !isLoading);
    }
    if (els.repeatLoadBtn) {
      els.repeatLoadBtn.disabled = isLoading;
    }
    if (els.repeatRetryBtn) {
      els.repeatRetryBtn.disabled = isLoading;
    }
  }

  function setRepeatErrorUi(msg) {
    if (!els.repeatErrorWrap || !els.repeatErrorText) return;
    if (!msg) {
      els.repeatErrorWrap.classList.add("d-none");
      els.repeatErrorText.textContent = "";
      return;
    }
    els.repeatErrorText.textContent = msg;
    els.repeatErrorWrap.classList.remove("d-none");
  }

  function clearRepeatTables() {
    repeatRowsAll = [];
    repeatPage = 0;
    if (els.loyaltyRepeatTbody) {
      els.loyaltyRepeatTbody.innerHTML = '<tr><td colspan="5" class="text-muted small">Klik op "Repeat gedrag laden".</td></tr>';
    }
    if (els.repeatPageLabel) els.repeatPageLabel.textContent = "Niet geladen";
    if (els.repeatPrev) els.repeatPrev.disabled = true;
    if (els.repeatNext) els.repeatNext.disabled = true;
  }

  function resetRepeatState() {
    repeatGlobalPayload = null;
    repeatData = null;
    repeatLoaded = false;
    repeatLoading = false;
    repeatError = "";
    setRepeatLoadingUi(false);
    setRepeatErrorUi("");
    clearRepeatTables();
  }

  let provMode = "pax";
  let destNameToId = {};
  let kpDonutBrand = "Sun Escapes";
  let paxGran = "month";
  let repeatPage = 0;
  const REPEAT_PAGE_SIZE = 10;
  let repeatRowsAll = [];
  let repeatSortKey = "trips_scope";
  let repeatSortDir = -1;
  let schoolProvinceFilter = "__ALL__";
  let repeatGlobalPayload = null;
  let repeatLoading = false;
  let repeatLoaded = false;
  let repeatError = "";
  let repeatData = null;
  let repeatCacheKey = "";
  let baseFilterKey = "";
  let travelerProvincesByLand = {};
  let travelerProvincesAll = [];
  let travelerProvinceHasUnknown = false;
  /** @type {InstanceType<typeof window.TAMultiSelectFilter> | null} */
  let kpDestMulti = null;
  /** @type {InstanceType<typeof window.TAMultiSelectFilter> | null} */
  let kpProvinceMulti = null;
  /** @type {InstanceType<typeof window.TAMultiSelectFilter> | null} */
  let kpAgeMulti = null;

  function updateTravelerProvinceOptions() {
    if (!els.travelerProvince) return;
    const selectedLand = (els.origin?.value || "__ALL__").toUpperCase();
    let options = travelerProvincesAll;
    if (selectedLand !== "__ALL__") {
      options = travelerProvincesByLand[selectedLand] || [];
    }
    const prev = kpProvinceMulti ? kpProvinceMulti.getValue() : [els.travelerProvince.value || "__ALL__"];
    els.travelerProvince.innerHTML = "";
    if (travelerProvinceHasUnknown) {
      const unk = document.createElement("option");
      unk.value = "__UNKNOWN__";
      unk.textContent = "Onbekend";
      els.travelerProvince.appendChild(unk);
    }
    options.forEach((prov) => {
      const o = document.createElement("option");
      o.value = String(prov);
      o.textContent = String(prov);
      els.travelerProvince.appendChild(o);
    });
    if (window.TAMultiSelectFilter) {
      if (!kpProvinceMulti) {
        kpProvinceMulti = new window.TAMultiSelectFilter({
          selectEl: els.travelerProvince,
          placeholderAll: "Alle provincies",
          searchPlaceholder: "Zoek provincie...",
          itemLabelSingle: "provincie",
          itemLabelPlural: "provincies geselecteerd",
        });
      } else {
        kpProvinceMulti.syncOptionsFromSelect();
      }
      const allowed = new Set(
        [...els.travelerProvince.options]
          .map((o) => String(o.value || "").trim())
          .filter(Boolean),
      );
      kpProvinceMulti.setValue(prev.filter((v) => allowed.has(v)));
    }
  }

  /** Trendgrafieken: venster op volledige reeks (DOM-scroll werkte niet betrouwbaar zonder echte overflow). */
  const KP_WIN_MONTH = 6;
  const KP_WIN_WEEK = 10;
  /** Pijltjes: maandcharts schuiven exact 1 periode; pax-trend blijft gedeelde stap gebruiken. */
  const KP_NAV_STEP_PAX =
    typeof globalThis.TA_TREND_NAV_STEP === "number" && globalThis.TA_TREND_NAV_STEP > 0
      ? globalThis.TA_TREND_NAV_STEP
      : 2;
  const KP_NAV_STEP_MONTH = 1;
  const kpTrend = {
    pax: { labels: [], values: [], gran: "month", windowStart: 0, windowSize: KP_WIN_MONTH },
    ageMonth: { rows: [], windowStart: 0, windowSize: KP_WIN_MONTH },
    groupMonth: { rows: [], windowStart: 0, windowSize: KP_WIN_MONTH },
  };

  function updateTrendNavUi(trendId) {
    const wrap = document.querySelector(`#kpPage [data-kp-trend="${trendId}"]`);
    if (!wrap) return;
    const prev = wrap.querySelector(".kp-chart-nav--prev");
    const next = wrap.querySelector(".kp-chart-nav--next");
    let n = 0;
    let w = 0;
    let start = 0;
    if (trendId === "pax") {
      n = kpTrend.pax.labels.length;
      w = kpTrend.pax.windowSize;
      start = kpTrend.pax.windowStart;
    } else if (trendId === "ageMonth") {
      n = kpTrend.ageMonth.rows.length;
      w = kpTrend.ageMonth.windowSize;
      start = kpTrend.ageMonth.windowStart;
    } else if (trendId === "groupMonth") {
      n = kpTrend.groupMonth.rows.length;
      w = kpTrend.groupMonth.windowSize;
      start = kpTrend.groupMonth.windowStart;
    }
    const maxStart = Math.max(0, n - w);
    const bothOff = n === 0 || n <= w;
    if (prev) prev.disabled = bothOff || start <= 0;
    if (next) next.disabled = bothOff || start >= maxStart;
  }

  function applyPaxWindow() {
    const ch = charts.paxOverTime;
    if (!ch) return;
    const st = kpTrend.pax;
    const sl = st.labels.slice(st.windowStart, st.windowStart + st.windowSize);
    const sv = st.values.slice(st.windowStart, st.windowStart + st.windowSize);
    ch.data.labels = sl;
    ch.data.datasets[0].data = sv;
    ch.update("none");
    updateTrendNavUi("pax");
  }

  function applyAgeMonthWindow() {
    const ch = charts.ageMonth;
    if (!ch) return;
    const st = kpTrend.ageMonth;
    const sliceRows = st.rows.slice(st.windowStart, st.windowStart + st.windowSize);
    ch.data.labels = sliceRows.map((x) => MAAND_KORT[Number(x.month)] || String(x.month));
    ch.data.datasets[0].data = sliceRows.map((x) => (x.avg_age != null ? Number(x.avg_age) : null));
    ch.update("none");
    updateTrendNavUi("ageMonth");
  }

  function applyGroupMonthWindow() {
    const ch = charts.groupMonth;
    if (!ch) return;
    const st = kpTrend.groupMonth;
    const sliceRows = st.rows.slice(st.windowStart, st.windowStart + st.windowSize);
    ch.data.labels = sliceRows.map((x) => MAAND_KORT[Number(x.month)] || String(x.month));
    ch.data.datasets[0].data = sliceRows.map((x) => (x.avg_party != null ? Number(x.avg_party) : null));
    ch.update("none");
    updateTrendNavUi("groupMonth");
  }

  function shiftKpTrendWindow(trendId, dir) {
    const step = (st, n, deltaBase) => {
      const w = st.windowSize;
      if (n === 0 || w <= 0) return;
      const maxStart = Math.max(0, n - w);
      const delta = Math.min(deltaBase, w);
      st.windowStart = Math.max(0, Math.min(maxStart, st.windowStart + dir * delta));
    };
    if (trendId === "pax") {
      step(kpTrend.pax, kpTrend.pax.labels.length, KP_NAV_STEP_PAX);
      applyPaxWindow();
    } else if (trendId === "ageMonth") {
      step(kpTrend.ageMonth, kpTrend.ageMonth.rows.length, KP_NAV_STEP_MONTH);
      applyAgeMonthWindow();
    } else if (trendId === "groupMonth") {
      step(kpTrend.groupMonth, kpTrend.groupMonth.rows.length, KP_NAV_STEP_MONTH);
      applyGroupMonthWindow();
    }
  }

  /**
   * Eén handler (capture) voor repeat-paginering + trend-pijlen. Charts gebruiken venster-slice, geen scrollLeft.
   */
  function initKpNavigation() {
    if (document.documentElement.dataset.kpNavInit) return;
    document.documentElement.dataset.kpNavInit = "1";
    document.addEventListener(
      "click",
      (e) => {
        const raw = e.target;
        const el = raw instanceof Element ? raw : raw.parentElement;
        if (!el || !(el instanceof Element)) return;

        const page = document.getElementById("kpPage");
        if (!page) return;

        const rp = el.closest("#kpRepeatPrev, #kpRepeatNext");
        if (rp && page.contains(rp)) {
          e.preventDefault();
          if (rp.id === "kpRepeatPrev") {
            if (rp.disabled || repeatPage <= 0) return;
            repeatPage -= 1;
            renderRepeatLeadersPage();
            return;
          }
          if (rp.id === "kpRepeatNext") {
            if (rp.disabled) return;
            const maxPage = Math.max(0, Math.ceil(repeatRowsAll.length / REPEAT_PAGE_SIZE) - 1);
            if (repeatPage >= maxPage) return;
            repeatPage += 1;
            renderRepeatLeadersPage();
          }
          return;
        }

        const btn = el.closest(".kp-chart-nav--prev, .kp-chart-nav--next");
        if (!btn || !page.contains(btn)) return;
        if (btn.closest(".kp-pagination-nav")) return;
        if (btn.id === "kpRepeatPrev" || btn.id === "kpRepeatNext") return;

        const wrap = btn.closest("[data-kp-trend]");
        if (!wrap || !page.contains(wrap)) return;
        e.preventDefault();
        const trendId = wrap.getAttribute("data-kp-trend");
        if (!trendId) return;
        const dir = btn.classList.contains("kp-chart-nav--prev") ? -1 : 1;
        shiftKpTrendWindow(trendId, dir);
      },
      true,
    );
  }

  function buildDataQueryParams() {
    const params = new URLSearchParams();
    params.set("year", els.year?.value || "");
    params.set("brand", els.brand?.value || "__all__");
    const bestemmingIds = kpDestMulti ? kpDestMulti.getValue() : els.dest?.value ? [els.dest.value] : [];
    if (bestemmingIds.length) params.set("bestemming_ids", bestemmingIds.join(","));
    params.set("period", els.period?.value || "all");
    params.set("origin", els.origin?.value || "__ALL__");
    params.set("reiziger_land", els.origin?.value || "__ALL__");
    const provinceValues = kpProvinceMulti ? kpProvinceMulti.getValue() : els.travelerProvince?.value ? [els.travelerProvince.value] : [];
    const ageValues = kpAgeMulti ? kpAgeMulti.getValue() : els.travelerAge?.value ? [els.travelerAge.value] : [];
    params.set("reiziger_provincies", provinceValues.join(","));
    params.set("leeftijdsgroepen", ageValues.join(","));
    params.set("brand_land", els.brandLand?.value || "__ALL__");
    return params;
  }

  function renderFilterContext(payload) {
    if (!els.filterContextLine) return;
    const m = payload.meta || {};
    const y = Number(m.year) === 0 ? "Alle jaren" : m.year ?? "—";
    const yp = m.year_prev;
    const brand = (els.brand?.value || "__all__").replace("__all__", "Alle merken");
    const destCount = kpDestMulti ? kpDestMulti.getValue().length : els.dest?.value ? 1 : 0;
    const dest = destCount ? `${destCount} bestemmingen` : "Alle bestemmingen";
    const period = els.period?.selectedOptions?.[0]?.textContent?.trim() || "—";
    const o = els.origin?.value || "__ALL__";
    const originLbl = o === "__ALL__" ? "Alle landen reiziger" : `Land reiziger ${o}`;
    const provCount = kpProvinceMulti ? kpProvinceMulti.getValue().length : 0;
    const provLbl = provCount ? `${provCount} provincies reiziger` : "Alle provincies reiziger";
    const ageCount = kpAgeMulti ? kpAgeMulti.getValue().length : 0;
    const ageLbl = ageCount ? `${ageCount} leeftijdsgroepen` : "Alle leeftijden";
    const bl = els.brandLand?.value || "__ALL__";
    const blLbl = bl === "__ALL__" ? "Alle boekingsmarkten" : `Boeking ${bl}`;
    const cmpText = yp != null ? `Referentiejaar in data: ${yp}.` : "";
    els.filterContextLine.textContent =
      `Actieve filters: vertrekjaar ${y} · merk ${brand} · ${dest} · ${period} · ${originLbl} · ${provLbl} · ${ageLbl} · ${blLbl}. ${cmpText}`.trim();
  }

  async function loadOptions() {
    const r = await fetch(API_OPT, { ...fetchJson, headers: { Accept: "application/json" } });
    const j = await readJsonResponse(r, "Klantenprofiel-opties");
    const brands = j.brands || [];
    const dest = j.bestemmingen || [];
    const years = j.years || [];
    const reizigerLanden = (j.reiziger_landen || {});
    const reizigerProvincies = (j.reiziger_provincies || {});
    const leeftijdsgroepen = Array.isArray(j.leeftijdsgroepen) ? j.leeftijdsgroepen : ["15-", "16", "17", "18", "19", "20", "21+"];

    if (els.brand) {
      els.brand.innerHTML = '<option value="__all__">Alle merken</option>';
      brands.forEach((b) => {
        const o = document.createElement("option");
        o.value = b;
        o.textContent = b;
        els.brand.appendChild(o);
      });
    }
    if (els.dest) {
      els.dest.innerHTML = "";
      destNameToId = {};
      dest.forEach((d) => {
        const o = document.createElement("option");
        o.value = d.id;
        o.textContent = d.naam;
        els.dest.appendChild(o);
        destNameToId[String(d.naam).trim()] = String(d.id);
      });
      if (window.TAMultiSelectFilter) {
        if (!kpDestMulti) {
          kpDestMulti = new window.TAMultiSelectFilter({
            selectEl: els.dest,
            placeholderAll: "Alle bestemmingen",
            searchPlaceholder: "Zoek bestemming...",
            itemLabelSingle: "bestemming",
            itemLabelPlural: "bestemmingen geselecteerd",
          });
        } else {
          kpDestMulti.syncOptionsFromSelect();
        }
      }
    }
    if (els.year) {
      els.year.innerHTML = "";
      const list = years.length ? years : [new Date().getFullYear()];
      const allYearsOption = document.createElement("option");
      allYearsOption.value = "0";
      allYearsOption.textContent = "Alle jaren";
      els.year.appendChild(allYearsOption);
      list.forEach((y) => {
        const o = document.createElement("option");
        o.value = String(y);
        o.textContent = String(y);
        els.year.appendChild(o);
      });
      els.year.value = String(Math.max(...list));
    }

    if (els.origin) {
      const countries = Array.isArray(reizigerLanden.values) ? reizigerLanden.values : [];
      els.origin.innerHTML = '<option value="__ALL__">Alle landen</option>';
      if (reizigerLanden.has_unknown) {
        const o = document.createElement("option");
        o.value = "__UNKNOWN__";
        o.textContent = "Onbekend";
        els.origin.appendChild(o);
      }
      countries.forEach((c) => {
        const o = document.createElement("option");
        o.value = String(c).toUpperCase();
        o.textContent = String(c).toUpperCase();
        els.origin.appendChild(o);
      });
      els.origin.value = "__ALL__";
    }

    travelerProvincesByLand = {};
    const rawByLand = reizigerProvincies.by_land || {};
    Object.keys(rawByLand || {}).forEach((k) => {
      travelerProvincesByLand[String(k).toUpperCase()] = Array.isArray(rawByLand[k]) ? rawByLand[k] : [];
    });
    travelerProvincesAll = Array.isArray(reizigerProvincies.values) ? reizigerProvincies.values : [];
    travelerProvinceHasUnknown = !!reizigerProvincies.has_unknown;
    updateTravelerProvinceOptions();

    if (els.travelerAge) {
      els.travelerAge.innerHTML = "";
      leeftijdsgroepen.forEach((g) => {
        const o = document.createElement("option");
        o.value = String(g);
        o.textContent = String(g);
        els.travelerAge.appendChild(o);
      });
      if (window.TAMultiSelectFilter) {
        if (!kpAgeMulti) {
          kpAgeMulti = new window.TAMultiSelectFilter({
            selectEl: els.travelerAge,
            placeholderAll: "Alle leeftijden",
            searchPlaceholder: "Zoek leeftijd...",
            itemLabelSingle: "leeftijd",
            itemLabelPlural: "leeftijden geselecteerd",
          });
        } else {
          kpAgeMulti.syncOptionsFromSelect();
        }
      }
    }
  }

  function pctDiff(cur, prev) {
    const c = Number(cur);
    const p = Number(prev);
    if (!Number.isFinite(c) || !Number.isFinite(p) || p === 0) return null;
    return ((c - p) / p) * 100;
  }

  /**
   * Pax-groei delta (Δ%) per bucket: ((cur - prev) / prev) * 100.
   * Geeft een gestructureerd resultaat terug zodat de UI consistent kan
   * formatteren ("+12,3%" / "-4,5%" / "Nieuw" / "—") en stylen.
   *
   * @param {number} cur   pax in huidige selectie
   * @param {number} prev  pax in zelfde selectie vorig vertrekjaar
   * @param {boolean} compareEnabled  vergelijking met vorig jaar actief?
   * @returns {{ value: number | null, html: string, raw: number | string | null }}
   */
  function calculateDeltaPercentage(cur, prev, compareEnabled) {
    const SP = globalThis.SemanticPerformance;
    const c = Number(cur) || 0;
    const p = Number(prev) || 0;
    if (!compareEnabled) return { value: null, html: "—", raw: null };
    if (p > 0) {
      const v = ((c - p) / p) * 100;
      const cls = SP ? SP.textClass(v, "delta") : v > 0 ? "sp-text--pos" : v < 0 ? "sp-text--neg" : "sp-text--neutral";
      const txt = `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
      return { value: v, html: cls ? `<span class="${cls}">${txt}</span>` : txt, raw: v };
    }
    if (c > 0) {
      // Geen prev-pax maar wel huidige pax → bucket is nieuw t.o.v. vorig jaar.
      return {
        value: null,
        html: '<span class="sp-text--pos">Nieuw</span>',
        raw: "Nieuw",
      };
    }
    return { value: null, html: "—", raw: null };
  }

  /**
   * Aandeelverschuiving (Δpp) = (cur_share% − prev_share%) in procentpunten.
   * Toont hoe de samenstelling binnen de selectie verschuift t.o.v. vorig
   * vertrekjaar — onafhankelijk van of het totaal groeit of krimpt.
   * Formaat: "+1,2pp" / "-4,1pp" / "—".
   *
   * @param {number} curN     huidige bucket-pax/boekingen
   * @param {number} curTot   totaal in huidige tabel-universe
   * @param {number} prevN    vorig-jaar bucket-pax/boekingen
   * @param {number} prevTot  vorig-jaar totaal in dezelfde universe
   * @param {boolean} compareEnabled  vergelijking met vorig jaar actief?
   * @returns {{ value: number | null, html: string, raw: number | string | null }}
   */
  function calculateShareShiftPp(curN, curTot, prevN, prevTot, compareEnabled) {
    const SP = globalThis.SemanticPerformance;
    if (!compareEnabled) return { value: null, html: "—", raw: null };
    const cT = Number(curTot) || 0;
    const pT = Number(prevTot) || 0;
    if (cT <= 0 && pT <= 0) return { value: null, html: "—", raw: null };
    const curShare = cT > 0 ? (Number(curN) || 0) / cT * 100 : 0;
    const prevShare = pT > 0 ? (Number(prevN) || 0) / pT * 100 : 0;
    const v = curShare - prevShare;
    if (!Number.isFinite(v) || Math.abs(v) < 0.05) {
      return { value: 0, html: "0,0pp", raw: 0 };
    }
    const cls = SP ? SP.textClass(v, "delta") : v > 0 ? "sp-text--pos" : "sp-text--neg";
    const txt = `${v >= 0 ? "+" : ""}${v.toFixed(1)}pp`;
    return { value: v, html: cls ? `<span class="${cls}">${txt}</span>` : txt, raw: v };
  }

  function triggerApplyReload() {
    els.apply?.dispatchEvent(new Event("click", { bubbles: true }));
  }

  function setBrandByLabelAndReload(brandLabel) {
    if (!els.brand || brandLabel == null) return;
    const v = String(brandLabel);
    if (!v) return;
    els.brand.value = v;
    triggerApplyReload();
  }

  function bindChartClickSetBrand(chart) {
    if (!chart || !els.brand || !els.apply) return;
    const canvas = chart.canvas;
    if (!canvas) return;
    if (canvas.dataset.kpBrandClickBound) return;
    canvas.dataset.kpBrandClickBound = "1";
    canvas.style.cursor = "pointer";
    canvas.addEventListener("click", (evt) => {
      const points = chart.getElementsAtEventForMode(evt, "nearest", { intersect: true }, true);
      if (!points || !points.length) return;
      const idx = points[0].index;
      const label = chart.data.labels?.[idx];
      if (!label) return;
      setBrandByLabelAndReload(label);
    });
  }

  function largestAgeLabel(payload) {
    const ah = [...(payload.age_hist || [])].sort((a, b) => (Number(b.n || 0) || 0) - (Number(a.n || 0) || 0));
    return ah[0]?.bucket || "—";
  }

  /**
   * Gem. groepsgrootte = totaal pax / totaal unieke boekingen binnen de actieve filters.
   * Komt overeen met de definitie op de Overzicht-pagina (total_reizigers / total_boekingen).
   *
   * @param {number | null | undefined} totalPax
   * @param {number | null | undefined} totalBookings
   * @returns {number | null}
   */
  function calculateAverageGroupSize(totalPax, totalBookings) {
    const pax = Number(totalPax);
    const bookings = Number(totalBookings);
    if (!Number.isFinite(pax) || !Number.isFinite(bookings) || bookings <= 0) return null;
    return pax / bookings;
  }

  function renderKpis(payload) {
    const kc = payload.kpis_cur || {};
    const kp = payload.kpis_prev || null;
    const exCur = payload.kpi_extras_cur || {};
    const compare = !!payload.meta?.compare;

    const totalPaxCur = Number(kc.total_pax || 0);
    const totalBookingsCur = Number(kc.bookings || 0);
    const avgPartyCur =
      kc.avg_party != null ? Number(kc.avg_party) : calculateAverageGroupSize(totalPaxCur, totalBookingsCur);
    const totalPaxPrev = kp ? Number(kp.total_pax || 0) : null;
    const totalBookingsPrev = kp ? Number(kp.bookings || 0) : null;
    const avgPartyPrev = kp
      ? kp.avg_party != null
        ? Number(kp.avg_party)
        : calculateAverageGroupSize(totalPaxPrev, totalBookingsPrev)
      : null;

    const vPax = nf.format(totalPaxCur);
    const vBookings = nf.format(totalBookingsCur);
    const vAvgParty = avgPartyCur != null && Number.isFinite(avgPartyCur)
      ? nf.format(Math.round(avgPartyCur * 100) / 100)
      : "—";
    const vTopOrigin = exCur.top_origin != null && String(exCur.top_origin).trim() !== "" ? String(exCur.top_origin) : "—";
    const vAgeSeg = largestAgeLabel(payload);

    const deltaPax = compare && kp ? pctDiff(totalPaxCur, totalPaxPrev) : null;
    const deltaBookings = compare && kp ? pctDiff(totalBookingsCur, totalBookingsPrev) : null;
    const deltaParty =
      compare && kp && avgPartyCur != null && avgPartyPrev != null ? pctDiff(avgPartyCur, avgPartyPrev) : null;

    function deltaText(deltaPct) {
      if (deltaPct == null || !Number.isFinite(deltaPct)) return "";
      const s = `${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(1)}%`;
      return `Δ ${s} t.o.v. vorig jaar`;
    }

    // Repeat ratio KPI is bewust verwijderd: dit cijfer hoort thuis in de
    // sectie "Repeat-gedrag" (Loyaliteit) en blijft daar zichtbaar.
    const cards = [
      { title: "Totaal pax", hint: "Alle reizigers in deze filterselectie.", value: vPax, sub: deltaText(deltaPax) },
      { title: "Totaal boekingen", hint: "Unieke boekingen (trips) in scope.", value: vBookings, sub: deltaText(deltaBookings) },
      { title: "Gem. groepsgrootte", hint: "Pax / unieke boekingen (zelfde definitie als Overzicht).", value: vAvgParty, sub: deltaText(deltaParty) },
      { title: "Grootste leeftijdsgroep", hint: "Bucket met meeste pax (bekende leeftijd).", value: vAgeSeg, sub: "" },
      { title: "Grootste herkomst", hint: "Meest voorkomende afkomst-bucket (reiziger).", value: vTopOrigin, sub: "" },
    ];

    if (!els.kpiRow) return;
    // 5 KPI-cards verdelen we via flex-equal kolommen op xl en standaard
    // 1/2/3-kolomgrid op kleinere viewports zodat alles netjes uitlijnt.
    els.kpiRow.innerHTML = cards
      .map(
        (c) => `<div class="col-12 col-sm-6 col-md-4 col-xl">
          <div class="card h-100 kp-kpi-card">
            <div class="card-body">
              <div class="kp-kpi-title">${escapeHtml(c.title)}</div>
              <div class="kp-kpi-hint">${escapeHtml(c.hint)}</div>
              <div class="kp-kpi-value mt-1" style="color:${THEME.strongText};">${escapeHtml(c.value)}</div>
              ${c.sub ? `<div class="small text-muted mt-1">${escapeHtml(c.sub)}</div>` : ""}
            </div>
          </div>
        </div>`,
      )
      .join("");
  }

  function renderInsights(payload) {
    const list = payload.insights || [];
    if (!els.insights) return;
    if (!list.length) {
      els.insights.innerHTML =
        '<span class="kp-insight-chip">Geen automatische signalen voor deze selectie (of te weinig volume).</span>';
      return;
    }
    els.insights.innerHTML = list.map((t) => `<span class="kp-insight-chip">${escapeHtml(t)}</span>`).join("");
  }

  function renderSchools(payload) {
    const schoolPayload = getSchoolRowsForProvince(payload, schoolProvinceFilter);
    const conc = schoolPayload.concentration || {};
    if (els.schoolConc) {
      els.schoolConc.innerHTML = "";
      if (conc.top5_share_pct != null) {
        const li = document.createElement("li");
        li.textContent = `Top 5 scholen = ${conc.top5_share_pct}% van pax`;
        els.schoolConc.appendChild(li);
      }
      if (conc.top10_share_pct != null) {
        const li = document.createElement("li");
        li.textContent = `Top 10 scholen = ${conc.top10_share_pct}% van pax`;
        els.schoolConc.appendChild(li);
      }
    }
    renderSchoolProvinceFilter(payload);
    renderSchoolTable(payload, schoolPayload.rows);
  }

  function getSchoolRowsForProvince(payload, provinceFilter) {
    if (provinceFilter && provinceFilter !== "__ALL__") {
      const byProv = payload.school_top_canonical_by_province || {};
      const rows = Array.isArray(byProv[provinceFilter]) ? byProv[provinceFilter] : [];
      const concentrationByProv = payload.school_concentration_by_province || {};
      return {
        rows,
        concentration: concentrationByProv[provinceFilter] || { top5_share_pct: null, top10_share_pct: null },
      };
    }
    return {
      rows: payload.school_top_canonical || [],
      concentration: payload.school_concentration || { top5_share_pct: null, top10_share_pct: null },
    };
  }

  function renderSchoolProvinceFilter(payload) {
    const el = els.schoolProvinceFilter;
    if (!el) return;
    const options = Array.isArray(payload.school_province_options) ? payload.school_province_options : [];
    const current = schoolProvinceFilter;
    el.innerHTML = '<option value="__ALL__">Alle provincies</option>';
    options.forEach((prov) => {
      const opt = document.createElement("option");
      opt.value = String(prov);
      opt.textContent = String(prov);
      el.appendChild(opt);
    });
    if (current !== "__ALL__" && options.includes(current)) {
      el.value = current;
    } else {
      schoolProvinceFilter = "__ALL__";
      el.value = "__ALL__";
    }
  }

  function renderSchoolTable(payload, schoolsInput) {
    const tableEl = document.getElementById("kpTableSchoolTop");
    const tb = document.querySelector("#kpTableSchoolTop tbody");
    if (!tableEl || !tb) return;
    const theadRow = tableEl.querySelector("thead tr");
    if (theadRow) {
      theadRow.innerHTML = `
        <th data-sort="school">School</th>
        <th class="text-end" data-sort="pax">Pax</th>
        <th class="text-end" data-sort="pct">%</th>
      `;
    }
    const totalPax =
      schoolProvinceFilter === "__ALL__"
        ? Number((payload.kpis_cur || {}).total_pax) || 0
        : Number((payload.school_total_pax_by_province || {})[schoolProvinceFilter]) || 0;
    const schools = Array.isArray(schoolsInput) ? schoolsInput : [];
    const rows0 = schools.map((x) => {
      const px = Number(x.pax || 0);
      const bookings = Number(x.bookings || 0);
      return {
        school: String(x.canonical_school || "—"),
        pax: px,
        bookings,
        pct: totalPax > 0 ? (px / totalPax) * 100 : 0,
      };
    });
    const renderBody = (rows) => {
      if (!rows.length) {
        tb.innerHTML = `<tr><td colspan="3" class="text-muted small">Geen schooldata voor deze selectie.</td></tr>`;
        return;
      }
      tb.innerHTML = rows
        .map(
          (r) => `<tr><td>${escapeHtml(r.school)}</td><td class="text-end">${nf.format(r.pax)}</td><td class="text-end">${r.pct.toFixed(1)}%</td></tr>`,
        )
        .join("");
    };
    renderBody(rows0);
    wireSortableTable(
      tableEl,
      () => {
        const p = window.__lastKpPayload;
        const data = getSchoolRowsForProvince(p || {}, schoolProvinceFilter);
        const tot =
          schoolProvinceFilter === "__ALL__"
            ? Number((p?.kpis_cur || {}).total_pax) || 0
            : Number((p?.school_total_pax_by_province || {})[schoolProvinceFilter]) || 0;
        return (data.rows || []).map((x) => {
          const px = Number(x.pax || 0);
          const bookings = Number(x.bookings || 0);
          return {
            school: String(x.canonical_school || "—"),
            pax: px,
            bookings,
            pct: tot > 0 ? (px / tot) * 100 : 0,
          };
        });
      },
      (rows) => renderBody(rows),
    );
  }

  /** Sorteerbare tabellen: client-side sort; thead wordt gekloond om dubbele listeners te vermijden bij herladen. */
  function wireSortableTable(tableEl, getRows, renderBody) {
    if (!tableEl) return;
    const theadRow = tableEl.querySelector("thead tr");
    if (theadRow) theadRow.replaceWith(theadRow.cloneNode(true));
    let sortKey = "";
    let dir = 1;
    tableEl.querySelectorAll("thead [data-sort]").forEach((th) => {
      th.addEventListener("click", () => {
        const k = th.getAttribute("data-sort") || "";
        if (k === sortKey) dir *= -1;
        else {
          sortKey = k;
          dir = 1;
        }
        const rows = getRows();
        rows.sort((a, b) => {
          const va = a[k];
          const vb = b[k];
          if (typeof va === "number" && typeof vb === "number") return dir * (va - vb);
          return dir * String(va ?? "").localeCompare(String(vb ?? ""), "nl");
        });
        renderBody(rows, sortKey, dir);
      });
    });
  }

  /**
   * Bouw de leeftijd-buckets rijen op uit het payload, inclusief Δ% per bucket
   * berekend als pax-groei t.o.v. dezelfde bucket vorig vertrekjaar.
   */
  function buildAgeBucketsRows(payload) {
    const compareEnabled = !!payload?.meta?.compare;
    const prevMap = new Map(
      (payload?.age_hist_prev || []).map((r) => [String(r.bucket || ""), Number(r.n || 0)]),
    );
    const rows = (payload?.age_hist || []).map((r) => ({
      bucket: r.bucket,
      n: Number(r.n || 0),
      prev_n: prevMap.get(String(r.bucket || "")) || 0,
      pct: 0,
      delta: null,
    }));
    const tot = rows.reduce((s, x) => s + x.n, 0);
    // Vorig-jaar totaal binnen DEZELFDE universe (alle buckets met bekende
    // leeftijd). We sommeren over álle prev_n keys die we kennen, niet alleen
    // de buckets die in cur voorkomen — anders zou een verdwenen bucket de
    // vorig-jaar share opblazen.
    const prevTot = (payload?.age_hist_prev || []).reduce(
      (s, r) => s + (Number(r.n) || 0),
      0,
    );
    rows.forEach((x) => {
      x.pct = tot > 0 ? (x.n / tot) * 100 : 0;
      // Δ% = aandeelverschuiving in procentpunten t.o.v. vorig vertrekjaar.
      x.delta = calculateShareShiftPp(x.n, tot, x.prev_n, prevTot, compareEnabled);
      x.delta_pct = x.delta.value;
    });
    return rows;
  }

  function renderAgeBucketsTable(payload) {
    const tb = document.querySelector("#kpTableAgeBuckets tbody");
    if (!tb) return;
    const rows0 = buildAgeBucketsRows(payload);
    const renderBody = (rows) => {
      tb.innerHTML = rows
        .map(
          (x) =>
            `<tr><td>${escapeHtml(x.bucket)}</td><td class="text-end">${nf.format(x.n)}</td><td class="text-end">${x.pct.toFixed(1)}%</td><td class="text-end">${
              x.delta?.html ?? "—"
            }</td></tr>`,
        )
        .join("");
    };
    renderBody(rows0);
    wireSortableTable(
      document.getElementById("kpTableAgeBuckets"),
      () => buildAgeBucketsRows(window.__lastKpPayload || {}),
      (rows) => renderBody(rows),
    );
  }

  function renderOriginOtherDetail(payload, forceOpen = false) {
    const panel = document.getElementById("kpOriginOtherDetail");
    const list = document.getElementById("kpOriginOtherDetailList");
    if (!panel || !list) return;
    const rows = Array.isArray(payload?.origin_other_breakdown) ? payload.origin_other_breakdown : [];
    if (!rows.length) {
      panel.classList.add("d-none");
      list.innerHTML = "";
      return;
    }
    list.innerHTML = rows
      .map(
        (r) =>
          `<li class="kp-inline-detail__item"><span>${escapeHtml(r.country || "Onbekend")}</span><span>${nf.format(Number(r.pax || 0))} pax (${Number(r.pct_within_other || 0).toFixed(1)}%)</span></li>`,
      )
      .join("");
    if (forceOpen) panel.classList.remove("d-none");
  }

  /**
   * Bouw rijen voor de tabel "Top herkomst": pax per herkomstland-bucket, met
   * Δ% per bucket gemeten als pax-groei vs. vorig vertrekjaar (zelfde key).
   */
  function buildOriginRows(payload) {
    const compareEnabled = !!payload?.meta?.compare;
    const order = ["BE", "NL", "IT", "OTHER"];
    const map = new Map();
    (payload?.origin_pax || []).forEach((r) =>
      map.set(String(r.origin || "").toUpperCase(), Number(r.pax || 0)),
    );
    const prevMap = new Map();
    (payload?.origin_pax_prev || []).forEach((r) =>
      prevMap.set(String(r.origin || "").toUpperCase(), Number(r.pax || 0)),
    );
    const tot = order.reduce((s, o) => s + (map.get(o) || 0), 0);
    const prevTot = order.reduce((s, o) => s + (prevMap.get(o) || 0), 0);
    return order
      .filter((o) => (map.get(o) || 0) > 0 || (compareEnabled && (prevMap.get(o) || 0) > 0))
      .map((o) => {
        const pax = map.get(o) || 0;
        const prevPax = prevMap.get(o) || 0;
        const delta = calculateShareShiftPp(pax, tot, prevPax, prevTot, compareEnabled);
        return {
          key: o,
          label: BPP_ORIGIN_LABELS[o] || o,
          pax,
          prev_pax: prevPax,
          pct: tot > 0 ? (pax / tot) * 100 : 0,
          delta,
          delta_pct: delta.value,
        };
      });
  }

  function renderOriginTable(payload) {
    const tb = document.querySelector("#kpTableOrigin tbody");
    if (!tb) return;
    const rows0 = buildOriginRows(payload);
    const renderBody = (rows) => {
      tb.innerHTML = rows
        .map(
          (x) =>
            `<tr data-origin="${escapeHtml(String(x.key || ""))}" class="${x.key === "OTHER" ? "kp-origin-row--clickable" : ""}"><td>${escapeHtml(x.label)}</td><td class="text-end">${nf.format(x.pax)}</td><td class="text-end">${x.pct.toFixed(1)}%</td><td class="text-end">${
              x.delta?.html ?? "—"
            }</td></tr>`,
        )
        .join("");
      tb.querySelectorAll("tr[data-origin='OTHER']").forEach((rowEl) => {
        rowEl.addEventListener("click", () => {
          const panel = document.getElementById("kpOriginOtherDetail");
          if (!panel) return;
          if (panel.classList.contains("d-none")) {
            renderOriginOtherDetail(payload, true);
          } else {
            panel.classList.add("d-none");
          }
        });
      });
    };
    renderBody(rows0);
    renderOriginOtherDetail(payload, false);
    wireSortableTable(
      document.getElementById("kpTableOrigin"),
      () => buildOriginRows(window.__lastKpPayload || {}),
      (rows) => renderBody(rows),
    );
  }

  /**
   * Bouw rijen voor de provincie/regio-tabel: per provincie pax of boekingen
   * binnen actieve filters, met Δ% berekend op dezelfde provincie-key in vorig
   * vertrekjaar (pax-groei i.p.v. % verschuiving).
   */
  function buildProvinceRows(payload) {
    const compareEnabled = !!payload?.meta?.compare;
    const key = provMode === "pax" ? "pax" : "bookings";
    const rowsRawCur =
      provMode === "pax"
        ? payload?.province_pax_norm || payload?.province_pax
        : payload?.province_bookings_norm || payload?.province_bookings;
    const rowsRawPrev =
      provMode === "pax"
        ? payload?.province_pax_prev_norm || payload?.province_pax_prev || []
        : payload?.province_bookings_prev_norm || payload?.province_bookings_prev || [];
    const curMap = new Map((rowsRawCur || []).map((r) => [String(r.provincie || "—"), Number(r[key] || 0)]));
    const prevMap = new Map((rowsRawPrev || []).map((r) => [String(r.provincie || "—"), Number(r[key] || 0)]));
    const labels = Array.from(new Set([...curMap.keys(), ...(compareEnabled ? [...prevMap.keys()] : [])]));
    labels.sort((a, b) => (curMap.get(b) || 0) - (curMap.get(a) || 0));
    const tot = labels.reduce((s, lab) => s + (curMap.get(lab) || 0), 0);
    // Vorig-jaar totaal: som over álle prev-keys (inclusief provincies die
    // dit jaar 0 zijn) zodat de share shift correct telt.
    const prevTot = (rowsRawPrev || []).reduce((s, r) => s + (Number(r[key]) || 0), 0);
    return labels.map((lab) => {
      const curVal = curMap.get(lab) || 0;
      const prevVal = prevMap.get(lab) || 0;
      const delta = calculateShareShiftPp(curVal, tot, prevVal, prevTot, compareEnabled);
      return {
        provincie: lab,
        val: curVal,
        prev_val: prevVal,
        pct: tot > 0 ? (curVal / tot) * 100 : 0,
        delta,
        delta_pct: delta.value,
      };
    });
  }

  function renderProvinceTable(payload) {
    const tb = document.querySelector("#kpTableProvince tbody");
    if (!tb) return;
    const renderBody = (rows) => {
      tb.innerHTML = rows
        .map(
          (x) =>
            `<tr><td>${escapeHtml(x.provincie)}</td><td class="text-end">${nf.format(x.val)}</td><td class="text-end">${x.pct.toFixed(1)}%</td><td class="text-end">${
              x.delta?.html ?? "—"
            }</td></tr>`,
        )
        .join("");
    };
    renderBody(buildProvinceRows(payload));
    if (els.provMeta) {
      els.provMeta.textContent =
        provMode === "pax"
          ? "Pax = reizigers tellen per provincie. Percentage t.o.v. totaal pax in deze selectie."
          : "Boekingen = unieke boekingen met minst één reiziger uit die provincie.";
    }
    wireSortableTable(
      document.getElementById("kpTableProvince"),
      () => buildProvinceRows(window.__lastKpPayload || {}),
      (rows) => renderBody(rows),
    );
  }

  /**
   * Bouw rijen voor "Vergelijking per merk".
   * - Δ pax = pax_cur − pax_prev (absolute verschil binnen actieve filters)
   * - Δ% = aandeelverschuiving in pp (cur_share − prev_share) — past bij de
   *        kolom "% v. totaal pax" en visualiseert mix-shift, niet absolute
   *        groei. Gebruik Δ pax voor absolute verandering.
   * - Gem. leeftijd = avg leeftijd op vertrekdatum per merk (uit age_by_brand)
   * - Gem. groepsgrootte = pax / boekingen per merk (zelfde definitie als KPI)
   */
  function buildBrandRows(payload) {
    const compareEnabled = !!payload?.meta?.compare;
    const growth = payload?.brand_pax_growth || [];
    const gMap = new Map(growth.map((g) => [String(g.brand), g]));
    const ageMap = new Map((payload?.age_by_brand || []).map((a) => [String(a.brand), a]));
    const kc = payload?.kpis_cur || {};
    const kp = payload?.kpis_prev || null;
    const totalScope = Number(kc.total_pax) || 0;
    const totalScopePrev = kp ? Number(kp.total_pax) || 0 : 0;
    return [...(payload?.brand_pax_cur || [])]
      .sort((a, b) => (b.pax || 0) - (a.pax || 0))
      .map((b) => {
        const g = gMap.get(String(b.brand)) || {};
        const ag = ageMap.get(String(b.brand)) || {};
        const pax = Number(b.pax || 0);
        const prevPax = g.pax_prev != null ? Number(g.pax_prev) : 0;
        const bookings = Number(b.bookings || 0);
        const brandSharePct = totalScope > 0 ? (pax / totalScope) * 100 : null;
        const delta = calculateShareShiftPp(pax, totalScope, prevPax, totalScopePrev, compareEnabled);
        return {
          brand: b.brand || "—",
          pax,
          avg_group_size: calculateAverageGroupSize(pax, bookings),
          delta_pax: g.delta_pax != null ? Number(g.delta_pax) : compareEnabled ? pax - prevPax : null,
          delta,
          delta_pct: delta.value,
          avg_age: ag.avg_age != null ? Number(ag.avg_age) : null,
          brand_share_pct: brandSharePct,
        };
      });
  }

  function renderBrandsTable(payload) {
    const tb = document.querySelector("#kpTableBrands tbody");
    if (!tb) return;
    const renderBody = (rows) => {
      const SP = globalThis.SemanticPerformance;
      tb.innerHTML = rows
        .map((x) => {
          const dpxInner =
            x.delta_pax != null && Number.isFinite(x.delta_pax)
              ? `${x.delta_pax >= 0 ? "+" : ""}${nf.format(x.delta_pax)}`
              : "—";
          const dpxHtml =
            x.delta_pax != null && SP
              ? `<span class="${SP.textClass(x.delta_pax, "delta")}">${dpxInner}</span>`
              : dpxInner;
          const dpctHtml = x.delta?.html ?? "—";
          const age = x.avg_age != null ? nf.format(Math.round(x.avg_age * 10) / 10) : "—";
          const avgGroupSize =
            x.avg_group_size != null ? nf.format(Math.round(x.avg_group_size * 100) / 100) : "—";
          const share = x.brand_share_pct != null ? `${x.brand_share_pct.toFixed(1)}%` : "—";
          return `<tr><td>${escapeHtml(x.brand)}</td><td class="text-end">${nf.format(x.pax)}</td><td class="text-end">${dpxHtml}</td><td class="text-end">${dpctHtml}</td><td class="text-end">${age}</td><td class="text-end">${avgGroupSize}</td><td class="text-end">${share}</td></tr>`;
        })
        .join("");
    };
    renderBody(buildBrandRows(payload));
    wireSortableTable(
      document.getElementById("kpTableBrands"),
      () => buildBrandRows(window.__lastKpPayload || {}),
      (rows) => renderBody(rows),
    );
  }

  function renderGroupBucketsTable(payload) {
    const tb = document.querySelector("#kpTableGroupBuckets tbody");
    if (!tb) return;
    const bucketOrder = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10+"];
    const gh = payload.group_hist || [];
    const map = new Map(gh.map((g) => [g.bucket, Number(g.n_bookings || 0)]));
    const tot = bucketOrder.reduce((s, b) => s + (map.get(b) || 0), 0);
    const rows0 = bucketOrder.map((b) => ({
      bucket: b,
      n: map.get(b) || 0,
      pct: tot > 0 ? ((map.get(b) || 0) / tot) * 100 : 0,
    }));
    const renderBody = (rows) => {
      tb.innerHTML = rows
        .map(
          (x) =>
            `<tr><td>${escapeHtml(x.bucket)}</td><td class="text-end">${nf.format(x.n)}</td><td class="text-end">${x.pct.toFixed(1)}%</td></tr>`,
        )
        .join("");
    };
    renderBody(rows0);
    wireSortableTable(
      document.getElementById("kpTableGroupBuckets"),
      () => {
        const p = window.__lastKpPayload;
        const bucketOrder = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10+"];
        const gh = p?.group_hist || [];
        const map = new Map(gh.map((g) => [g.bucket, Number(g.n_bookings || 0)]));
        const tot = bucketOrder.reduce((s, b) => s + (map.get(b) || 0), 0);
        return bucketOrder.map((b) => ({
          bucket: b,
          n: map.get(b) || 0,
          pct: tot > 0 ? ((map.get(b) || 0) / tot) * 100 : 0,
        }));
      },
      (rows) => renderBody(rows),
    );
  }

  function renderRepeatBrandTable(payload) {
    const tb = document.querySelector("#kpTableRepeatBrand tbody");
    if (!tb) return;
    const totalScope = Number((payload.kpis_cur || {}).total_pax) || 0;
    const rows0 = [...(payload.loyalty_by_brand || [])].map((r) => {
      const pt = Number(r.pax_total) || 0;
      const pr = Number(r.pax_repeat) || 0;
      const rrSql = r.repeat_share_of_scope_pct != null ? Number(r.repeat_share_of_scope_pct) : null;
      const repeatPct =
        rrSql != null && Number.isFinite(rrSql) ? rrSql : totalScope > 0 ? (pr / totalScope) * 100 : 0;
      return {
        brand: r.brand || "—",
        repeat_pct: repeatPct,
        pax_repeat: pr,
      };
    });
    rows0.sort((a, b) => b.repeat_pct - a.repeat_pct);
    const renderBody = (rows) => {
      tb.innerHTML = rows
        .map(
          (x) =>
            `<tr><td>${escapeHtml(x.brand)}</td><td class="text-end">${x.repeat_pct.toFixed(1)}%</td><td class="text-end">${nf.format(x.pax_repeat)}</td></tr>`,
        )
        .join("");
    };
    renderBody(rows0);
    wireSortableTable(
      document.getElementById("kpTableRepeatBrand"),
      () => {
        const p = repeatGlobalPayload || payload;
        const ts = Number((p?.kpis_cur || {}).total_pax) || 0;
        return [...(p?.loyalty_by_brand || [])].map((r) => {
          const pt = Number(r.pax_total) || 0;
          const pr = Number(r.pax_repeat) || 0;
          const rrSql = r.repeat_share_of_scope_pct != null ? Number(r.repeat_share_of_scope_pct) : null;
          const repeatPct =
            rrSql != null && Number.isFinite(rrSql) ? rrSql : ts > 0 ? (pr / ts) * 100 : 0;
          return {
            brand: r.brand || "—",
            repeat_pct: repeatPct,
            pax_repeat: pr,
          };
        });
      },
      (rows) => renderBody(rows),
    );
  }

  function openKpLoyaltyDetailModal(row) {
    const modalEl = els.loyaltyDetailModal;
    const intro = els.loyaltyDetailIntro;
    const tb = els.loyaltyDetailTbody;
    if (!modalEl || !tb) return;
    const hist = Array.isArray(row.history_all) ? row.history_all : [];
    if (intro) {
      const nm = row.name_hint || row.cust_short || "—";
      intro.textContent = `Volledige bestemmingshistoriek voor ${nm} (alle jaren in database; klantmatch = naam + geboortedatum).`;
    }
    tb.innerHTML = "";
    if (!hist.length) {
      tb.innerHTML = `<tr><td colspan="5" class="text-muted small">Geen historiek beschikbaar.</td></tr>`;
    } else {
      hist.forEach((h) => {
        const tr = document.createElement("tr");
        const vdRaw = h.vertrekdatum != null ? String(h.vertrekdatum).slice(0, 10) : "";
        const vd =
          (window.TADate && window.TADate.formatDate && window.TADate.formatDate(vdRaw, vdRaw || "—")) || vdRaw || "—";
        tr.innerHTML = `<td>${h.jaar != null ? nf.format(Number(h.jaar)) : "—"}</td><td>${escapeHtml(h.dest_naam || "—")}</td><td>${escapeHtml(h.accommodatie || "—")}</td><td>${escapeHtml(h.brand || "—")}</td><td>${escapeHtml(vd)}</td>`;
        tb.appendChild(tr);
      });
    }
    const Modal = typeof window !== "undefined" ? window.bootstrap?.Modal : null;
    if (Modal) Modal.getOrCreateInstance(modalEl).show();
  }

  function renderRepeatLeadersTable(payload) {
    repeatRowsAll = [...(payload.loyalty_sample || [])];
    repeatPage = 0;
    initRepeatSortHeaders();
    applyRepeatSort();
    renderRepeatLeadersPage();
  }

  function getRepeatSortValue(row, key) {
    if (key === "name_hint") return String(row.name_hint || row.cust_short || "").toLowerCase();
    if (key === "last_vd") return String(row.last_vd || "");
    return Number(row[key] || 0);
  }

  function applyRepeatSort() {
    repeatRowsAll.sort((a, b) => {
      const va = getRepeatSortValue(a, repeatSortKey);
      const vb = getRepeatSortValue(b, repeatSortKey);
      if (typeof va === "number" && typeof vb === "number") return repeatSortDir * (va - vb);
      return repeatSortDir * String(va).localeCompare(String(vb), "nl");
    });
  }

  function initRepeatSortHeaders() {
    const tableEl = document.getElementById("kpLoyaltyRepeatTable");
    if (!tableEl) return;
    const theadRow = tableEl.querySelector("thead tr");
    if (theadRow) theadRow.replaceWith(theadRow.cloneNode(true));
    tableEl.querySelectorAll("thead [data-sort]").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.getAttribute("data-sort") || "trips_scope";
        if (key === repeatSortKey) repeatSortDir *= -1;
        else {
          repeatSortKey = key;
          repeatSortDir = key === "name_hint" || key === "last_vd" ? 1 : -1;
        }
        applyRepeatSort();
        repeatPage = 0;
        renderRepeatLeadersPage();
      });
    });
  }

  function renderRepeatLeadersPage() {
    const tb = els.loyaltyRepeatTbody;
    if (!tb) return;
    const total = repeatRowsAll.length;
    const start = repeatPage * REPEAT_PAGE_SIZE;
    const slice = repeatRowsAll.slice(start, start + REPEAT_PAGE_SIZE);
    tb.innerHTML = "";
    if (!slice.length) {
      tb.innerHTML = '<tr><td colspan="5" class="text-muted small">Geen repeat-data beschikbaar.</td></tr>';
    }

    slice.forEach((row) => {
      const cust = String(row.cust_short || "");
      const name = (row.name_hint && String(row.name_hint).trim()) || cust || "—";
      const trips = Number(row.trips_scope) || 0;
      const lastVdRaw = row.last_vd != null ? String(row.last_vd).slice(0, 10) : "";
      const lastVd =
        (window.TADate &&
          window.TADate.formatDate &&
          window.TADate.formatDate(lastVdRaw, lastVdRaw || "—")) ||
        lastVdRaw ||
        "—";
      const destC = Number(row.dest_count_scope) || 0;
      const paxScopeNum = Number(row.pax_scope);
      const paxS = Number.isFinite(paxScopeNum) ? paxScopeNum : null;

      const tr = document.createElement("tr");
      tr.className = "kp-loyalty-row";
      tr.dataset.cust = cust;
      tr.innerHTML = `<td><button type="button" class="btn btn-link kp-repeat-name-link p-0 align-baseline">${escapeHtml(name)}</button></td><td class="text-end">${nf.format(trips)}</td><td>${escapeHtml(lastVd)}</td><td class="text-end">${nf.format(destC)}</td><td class="text-end">${paxS != null ? nf.format(paxS) : "—"}</td>`;
      tr.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const full = repeatRowsAll.find((r) => String(r.cust_short) === cust);
        if (full) openKpLoyaltyDetailModal(full);
      });
      tb.appendChild(tr);
    });

    const maxPage = Math.max(0, Math.ceil(total / REPEAT_PAGE_SIZE) - 1);
    if (els.repeatPageLabel) {
      els.repeatPageLabel.textContent =
        total === 0 ? "Geen repeat-klanten" : `Rij ${start + 1}–${Math.min(start + REPEAT_PAGE_SIZE, total)} van ${total}`;
    }
    if (els.repeatPrev) {
      els.repeatPrev.disabled = repeatPage <= 0;
    }
    if (els.repeatNext) {
      els.repeatNext.disabled = repeatPage >= maxPage || total === 0;
    }
  }

  function renderLoyalty(payload) {
    if (!payload || typeof payload !== "object") {
      if (els.loyaltyRepeatPctEl) {
        els.loyaltyRepeatPctEl.textContent = "";
        els.loyaltyRepeatPctEl.classList.add("d-none");
      }
      if (els.loyaltyDeltaTextEl) els.loyaltyDeltaTextEl.textContent = "Repeat gedrag nog niet geladen.";
      if (els.loyaltyPaxSplit) els.loyaltyPaxSplit.textContent = "Klik op 'Repeat gedrag laden'.";
      destroyChart("loyalty");
      const emptyDonut = els.loyaltyDonutEmpty;
      const canvas = document.getElementById("kpChartLoyaltyDonut");
      if (emptyDonut) {
        emptyDonut.classList.remove("d-none");
        emptyDonut.textContent = "Repeat gedrag nog niet geladen.";
      }
      if (canvas) canvas.classList.add("d-none");
      clearRepeatTables();
      return;
    }
    const l = payload.loyalty || {};
    const rp = Number(l.pax_repeat || 0);
    const nw = Number(l.pax_new || 0);
    const exCur = payload.kpi_extras_cur || {};
    const exPrev = payload.kpi_extras_prev || {};
    const rrCur = exCur.repeat_ratio != null ? Number(exCur.repeat_ratio) : null;
    const rrPrev = exPrev.repeat_ratio != null ? Number(exPrev.repeat_ratio) : null;

    if (els.loyaltyRepeatPctEl) {
      if (rrCur != null && Number.isFinite(rrCur)) {
        els.loyaltyRepeatPctEl.textContent = `Repeat: ${nf.format(rrCur)}% van alle pax in volledige dataset`;
        els.loyaltyRepeatPctEl.classList.remove("d-none");
      } else {
        els.loyaltyRepeatPctEl.textContent = "";
        els.loyaltyRepeatPctEl.classList.add("d-none");
      }
    }
    if (els.loyaltyDeltaTextEl) {
      if (rrCur != null && rrPrev != null && Number.isFinite(rrCur) && Number.isFinite(rrPrev)) {
        const deltaPp = rrCur - rrPrev;
        els.loyaltyDeltaTextEl.textContent = `Δ t.o.v. vorig jaar: ${deltaPp >= 0 ? "+" : ""}${deltaPp.toFixed(1)} procentpunt`;
      } else {
        els.loyaltyDeltaTextEl.textContent = "Vergelijking repeat: niet beschikbaar.";
      }
    }

    if (els.loyaltyPaxSplit) {
      const sum = rp + nw;
      if (sum > 0) {
        els.loyaltyPaxSplit.innerHTML = `<strong>${nf.format(rp)}</strong> repeat-pax · <strong>${nf.format(nw)}</strong> nieuw-pax <span class="text-muted">(${nf.format(sum)} totaal)</span>`;
      } else {
        els.loyaltyPaxSplit.textContent = "Geen pax in volledige dataset.";
      }
    }

    destroyChart("loyalty");
    const canvas = document.getElementById("kpChartLoyaltyDonut");
    const emptyDonut = els.loyaltyDonutEmpty;
    const hasSplit = rp > 0 || nw > 0;
    const sumN = rp + nw || 1;
    const loyaltyDoughnutOptions = {
      type: "doughnut",
      data: {
        labels: ["Repeat", "Nieuw"],
        datasets: [
          {
            data: [rp, nw],
            backgroundColor: [tRgba(THEME.orange, 0.92), tRgba(THEME.neutralSoft, 0.95)],
            borderWidth: 0,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: "58%",
        plugins: {
          legend: { display: true, position: "bottom", labels: { boxWidth: 12, color: THEME.text } },
          tooltip: {
            callbacks: {
              label: (c) => {
                const v = c.parsed;
                const pct = ((v / sumN) * 100).toFixed(1);
                return `${c.label}: ${nf.format(v)} pax (${pct}%)`;
              },
            },
          },
        },
      },
    };
    if (canvas && emptyDonut) {
      if (!hasSplit) {
        emptyDonut.classList.remove("d-none");
        emptyDonut.textContent = "Geen pax voor repeat-split.";
        canvas.classList.add("d-none");
      } else {
        emptyDonut.classList.add("d-none");
        canvas.classList.remove("d-none");
        charts.loyalty = new Chart(canvas.getContext("2d"), loyaltyDoughnutOptions);
      }
    } else if (canvas && hasSplit) {
      charts.loyalty = new Chart(canvas.getContext("2d"), loyaltyDoughnutOptions);
    }

    renderRepeatBrandTable(payload);
    renderRepeatLeadersTable(payload);
  }

  function renderAgeByMonth(payload) {
    destroyChart("ageMonth");
    const canvas = document.getElementById("kpChartAgeByMonth");
    const emptyEl = document.getElementById("kpChartAgeByMonthEmpty");
    if (!canvas) return;
    if (els.genderFallbackNote) els.genderFallbackNote.classList.remove("d-none");
    const amRaw = [...(payload.age_by_month || [])].sort((a, b) => Number(a.month) - Number(b.month));
    if (!amRaw.length) {
      kpTrend.ageMonth.rows = [];
      if (emptyEl) emptyEl.classList.remove("d-none");
      canvas.classList.add("d-none");
      updateTrendNavUi("ageMonth");
      return;
    }
    const amPadded = padAgeByMonth12(amRaw);
    const am = trimMonthRowsToDataWindow(amPadded, (row) => {
      const v = row?.avg_age;
      return v != null && Number.isFinite(Number(v)) && Number(v) > 0;
    });
    if (!am.length) {
      kpTrend.ageMonth.rows = [];
      if (emptyEl) emptyEl.classList.remove("d-none");
      canvas.classList.add("d-none");
      updateTrendNavUi("ageMonth");
      return;
    }
    if (emptyEl) emptyEl.classList.add("d-none");
    canvas.classList.remove("d-none");
    kpTrend.ageMonth.rows = am;
    kpTrend.ageMonth.windowStart = 0;
    kpTrend.ageMonth.windowSize = KP_WIN_MONTH;
    const st = kpTrend.ageMonth;
    const sliceRows = st.rows.slice(st.windowStart, st.windowStart + st.windowSize);
    charts.ageMonth = new Chart(canvas.getContext("2d"), {
      type: "line",
      data: {
        labels: sliceRows.map((x) => MAAND_KORT[Number(x.month)] || String(x.month)),
        datasets: [
          {
            label: "Gem. leeftijd",
            data: sliceRows.map((x) => (x.avg_age != null ? Number(x.avg_age) : null)),
            borderColor: tRgba(THEME.orange, 1),
            backgroundColor: tRgba(THEME.orange, 0.12),
            tension: 0.25,
            fill: true,
            spanGaps: true,
            pointRadius: 2,
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
              label: (c) => {
                const i = c.dataIndex;
                const idx = kpTrend.ageMonth.windowStart + i;
                const row = kpTrend.ageMonth.rows[idx] || {};
                const n = row.n_age != null ? ` · n=${nf.format(row.n_age)}` : "";
                return `Gem.: ${c.parsed.y != null ? nf.format(Math.round(Number(c.parsed.y) * 10) / 10) : "—"} jr${n}`;
              },
            },
          },
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: THEME.text } },
          y: { grid: { color: COL_GRID }, ticks: { color: THEME.text } },
        },
      },
    });
    updateTrendNavUi("ageMonth");
  }

  function renderGroupMonthChart(payload) {
    destroyChart("groupMonth");
    const gmCanvas = document.getElementById("kpChartGroupMonth");
    const emptyEl = document.getElementById("kpChartGroupMonthEmpty");
    if (!gmCanvas) return;
    const gmRaw = [...(payload.group_by_month || [])].sort((a, b) => a.month - b.month);
    if (!gmRaw.length) {
      kpTrend.groupMonth.rows = [];
      if (emptyEl) emptyEl.classList.remove("d-none");
      gmCanvas.classList.add("d-none");
      updateTrendNavUi("groupMonth");
      return;
    }
    const gmPadded = padGroupByMonth12(gmRaw);
    const gm = trimMonthRowsToDataWindow(gmPadded, (row) => {
      const v = row?.avg_party;
      return v != null && Number.isFinite(Number(v)) && Number(v) > 0;
    });
    if (!gm.length) {
      kpTrend.groupMonth.rows = [];
      if (emptyEl) emptyEl.classList.remove("d-none");
      gmCanvas.classList.add("d-none");
      updateTrendNavUi("groupMonth");
      return;
    }
    if (emptyEl) emptyEl.classList.add("d-none");
    gmCanvas.classList.remove("d-none");
    kpTrend.groupMonth.rows = gm;
    kpTrend.groupMonth.windowStart = 0;
    kpTrend.groupMonth.windowSize = KP_WIN_MONTH;
    const st = kpTrend.groupMonth;
    const sliceRows = st.rows.slice(st.windowStart, st.windowStart + st.windowSize);
    charts.groupMonth = new Chart(gmCanvas.getContext("2d"), {
      type: "line",
      data: {
        labels: sliceRows.map((x) => MAAND_KORT[Number(x.month)] || String(x.month)),
        datasets: [
          {
            label: "Gem. groep",
            data: sliceRows.map((x) => (x.avg_party != null ? Number(x.avg_party) : null)),
            borderColor: tRgba(THEME.orange, 1),
            backgroundColor: tRgba(THEME.orange, 0.15),
            tension: 0.25,
            borderWidth: 2,
            fill: true,
            spanGaps: true,
            pointRadius: 2,
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
              label: (c) =>
                c.parsed.y != null
                  ? `Gem. groepsgrootte: ${nf.format(Math.round(Number(c.parsed.y) * 100) / 100)}`
                  : "Geen boekingen deze maand",
            },
          },
        },
        scales: { x: { grid: { display: false }, ticks: { color: THEME.text } }, y: { grid: { color: COL_GRID }, ticks: { color: THEME.text } } },
      },
    });
    updateTrendNavUi("groupMonth");
  }

  function renderPaxOverTime(payload) {
    destroyChart("paxOverTime");
    const ptCanvas = els.paxOverTimeCanvas || document.getElementById("kpChartPaxOverTime");
    if (!ptCanvas) return;
    const gran = paxGran === "week" ? "week" : "month";
    const built =
      gran === "week" && Array.isArray(payload.week_pax_total) && payload.week_pax_total.length
        ? buildPaxOverTimeSeriesWeek(payload)
        : buildPaxOverTimeSeriesMonth(payload);
    const { labels, values } = built;
    kpTrend.pax.labels = labels;
    kpTrend.pax.values = values;
    kpTrend.pax.gran = gran;
    kpTrend.pax.windowStart = 0;
    kpTrend.pax.windowSize = gran === "week" ? KP_WIN_WEEK : KP_WIN_MONTH;
    if (!labels.length) {
      updateTrendNavUi("pax");
      return;
    }
    const st = kpTrend.pax;
    const sl = st.labels.slice(st.windowStart, st.windowStart + st.windowSize);
    const sv = st.values.slice(st.windowStart, st.windowStart + st.windowSize);
    charts.paxOverTime = new Chart(ptCanvas.getContext("2d"), {
      type: "line",
      data: {
        labels: sl,
        datasets: [
          {
            label: "Pax",
            data: sv,
            borderColor: tRgba(THEME.orange, 1),
            backgroundColor: tRgba(THEME.orange, 0.15),
            borderWidth: 2,
            tension: gran === "week" ? 0.1 : 0.25,
            fill: true,
            pointRadius: gran === "week" ? 1 : 3,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (items) => (items[0] ? String(items[0].label) : ""),
              label: (ctx) => `Pax: ${nf.format(ctx.parsed.y)}`,
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: THEME.text, autoSkip: true, maxRotation: gran === "week" ? 60 : 45 },
          },
          y: {
            beginAtZero: true,
            grid: { color: COL_GRID },
            ticks: { color: THEME.text, callback: (v) => nf.format(v) },
          },
        },
      },
    });
    updateTrendNavUi("pax");
  }

  function setPaxGranUi() {
    const m = els.paxGranMonth;
    const w = els.paxGranWeek;
    if (m) m.classList.toggle("is-active", paxGran === "month");
    if (w) w.classList.toggle("is-active", paxGran === "week");
  }

  function updateBppDonutSegmentButtons() {
    document.querySelectorAll("[data-kp-donut-brand]").forEach((btn) => {
      const v = btn.getAttribute("data-kp-donut-brand");
      const on = v === kpDonutBrand;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
  }

  function bindKpDonutSegments() {
    const bar = document.querySelector(".kp-donut-brand-bar");
    if (!bar || bar.dataset.bound) return;
    bar.dataset.bound = "1";
    bar.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-kp-donut-brand]");
      if (!btn || !bar.contains(btn)) return;
      const v = btn.getAttribute("data-kp-donut-brand");
      if (!v || v === kpDonutBrand) return;
      kpDonutBrand = v;
      updateBppDonutSegmentButtons();
      void fetchTravelerOriginDonuts();
    });
  }

  function kpOriginDisplayLabel(code) {
    const c = String(code || "").toUpperCase();
    return BPP_ORIGIN_LABELS[c] || c || "—";
  }

  async function fetchTravelerOriginDonuts() {
    const errEl = document.getElementById("kpTravelerOriginErr");
    const setLocalErr = (msg) => {
      if (!errEl) return;
      if (msg) {
        errEl.textContent = msg;
        errEl.classList.remove("d-none");
      } else {
        errEl.textContent = "";
        errEl.classList.add("d-none");
      }
    };
    setLocalErr("");
    const params = buildDataQueryParams();
    params.set("donut_brand", kpDonutBrand);
    try {
      const res = await fetch(`${API_TRAVELER_ORIGIN}?${params}`, {
        headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" },
        credentials: "same-origin",
      });
      const data = await readJsonResponse(res, "Afkomst-donut");
      renderTravelerOriginDonuts(data);
    } catch (e) {
      setLocalErr(formatClientError(e));
      renderTravelerOriginDonuts(null);
    }
  }

  function renderTravelerOriginDonuts(payload) {
    const titles = [document.getElementById("kpTravelerOriginTitle0"), document.getElementById("kpTravelerOriginTitle1")];
    const empties = [document.getElementById("kpTravelerOriginEmpty0"), document.getElementById("kpTravelerOriginEmpty1")];
    const canvasIds = ["kpChartTravelerOrigin0", "kpChartTravelerOrigin1"];
    if (!payload || !Array.isArray(payload.slices)) {
      for (let i = 0; i < 2; i += 1) {
        destroyChart(canvasIds[i]);
        if (titles[i]) titles[i].textContent = "—";
        if (empties[i]) {
          empties[i].textContent = "Geen gegevens.";
          empties[i].classList.remove("d-none");
        }
      }
      return;
    }
    const slices = payload.slices;
    for (let i = 0; i < 2; i += 1) {
      const sl = slices[i];
      const tEl = titles[i];
      const eEl = empties[i];
      const cid = canvasIds[i];
      destroyChart(cid);
      if (tEl) tEl.textContent = sl?.title || "—";
      const total = Number(sl?.total_travelers ?? 0);
      const items = Array.isArray(sl?.items) ? sl.items : [];
      if (total <= 0 || !items.length) {
        if (eEl) {
          eEl.textContent = "Geen pax in deze selectie.";
          eEl.classList.remove("d-none");
        }
        continue;
      }
      if (eEl) eEl.classList.add("d-none");
      const labels = items.map((it) => kpOriginDisplayLabel(it.origin_bucket));
      const values = items.map((it) => Number(it.pax || 0));
      const detailByIdx = items.map((it) => (Array.isArray(it.other_details) ? it.other_details : []));
      let fallbackIdx = 0;
      const colors = items.map((it) => {
        const fallback = KP_DONUT_COLORS[fallbackIdx % KP_DONUT_COLORS.length];
        const chosen = originColor(it.origin_bucket, fallback);
        if (chosen === fallback) fallbackIdx += 1;
        return chosen;
      });
      const hoverColors = items.map((it, j) => originHoverColor(it.origin_bucket, colors[j]));
      const canvas = document.getElementById(cid);
      if (!canvas) continue;
      charts[cid] = new Chart(canvas.getContext("2d"), {
        type: "doughnut",
        data: {
          labels,
          datasets: [{ data: values, backgroundColor: colors, hoverBackgroundColor: hoverColors, borderWidth: 0 }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: "55%",
          plugins: {
            legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 10 }, color: THEME.text } },
            tooltip: {
              callbacks: {
                label: (ctx) => {
                  const v = ctx.parsed;
                  const pct = total > 0 ? ((v / total) * 100).toFixed(1) : "0";
                  return `${ctx.label}: ${nf.format(v)} (${pct}%) · totaal ${nf.format(total)} pax`;
                },
                afterBody: (itemsCtx) => {
                  const first = itemsCtx?.[0];
                  if (!first) return [];
                  const idx = Number(first.dataIndex || 0);
                  const details = detailByIdx[idx] || [];
                  if (!details.length) return [];
                  return ["", "Uitsplitsing Overige:", ...details.map((d) => `${d.country}: ${nf.format(Number(d.pax || 0))} pax (${Number(d.pct_within_other || 0).toFixed(1)}%)`)];
                },
              },
            },
          },
        },
      });
    }
  }

  async function loadData() {
    setErr("");
    if (els.loading) els.loading.classList.remove("d-none");
    if (els.dash) els.dash.classList.add("d-none");

    const params = buildDataQueryParams();
    const nextFilterKey = params.toString();
    if (nextFilterKey !== baseFilterKey) {
      resetRepeatState();
      baseFilterKey = nextFilterKey;
      renderLoyalty(null);
    }
    const r = await fetch(`${API_DATA}?${params}`, { ...fetchJson, headers: { Accept: "application/json" } });
    const payload = await readJsonResponse(r, "Klantenprofiel-data");
    if (payload.error) throw new Error(payload.error);
    window.__lastKpPayload = payload;

    if (els.loading) els.loading.classList.add("d-none");
    if (els.dash) els.dash.classList.remove("d-none");

    renderFilterContext(payload);
    renderKpis(payload);

    renderAgeBucketsTable(payload);
    renderOriginTable(payload);
    renderProvinceTable(payload);
    renderBrandsTable(payload);
    renderGroupBucketsTable(payload);

    renderPaxOverTime(payload);
    setPaxGranUi();

    renderAgeByMonth(payload);

    renderGroupMonthChart(payload);

    renderSchools(payload);

    const ah = payload.age_hist || [];
    const maxN = Math.max(0, ...ah.map((x) => Number(x.n || 0)));
    const largest = ah.find((x) => Number(x.n || 0) === maxN);
    if (els.ageLargestSegmentEl) {
      els.ageLargestSegmentEl.textContent =
        largest?.bucket != null ? `Sterkste bucket: ${largest.bucket} (${nf.format(largest.n)} pax).` : "";
    }

    updateBppDonutSegmentButtons();
    bindKpDonutSegments();
    void fetchTravelerOriginDonuts();
  }

  async function loadRepeatData(forceReload = false) {
    const params = buildDataQueryParams();
    const cacheKey = params.toString();
    if (!forceReload && repeatLoaded && repeatData && repeatCacheKey === cacheKey) {
      return repeatData;
    }
    repeatLoading = true;
    repeatError = "";
    setRepeatLoadingUi(true);
    setRepeatErrorUi("");
    try {
      const r = await fetch(`${API_REPEAT_DATA}?${params}`, { ...fetchJson, headers: { Accept: "application/json" } });
      const rawText = await r.text();
      console.info("[klantenprofiel/repeat-data] status", r.status);
      console.info("[klantenprofiel/repeat-data] body", rawText);
      const trimmed = (rawText || "").trimStart();
      if (!trimmed) throw new Error(`Repeat gedrag: lege response (HTTP ${r.status}).`);
      if (trimmed.startsWith("<")) throw new Error(`Repeat gedrag: server antwoordde met HTML (${r.status}).`);
      let payload = {};
      try {
        payload = JSON.parse(rawText);
      } catch {
        throw new Error(`Repeat gedrag: ongeldige JSON (HTTP ${r.status}).`);
      }
      if (!r.ok) {
        const piece = payload && typeof payload === "object" ? payload.error ?? payload.message ?? payload.details : null;
        throw new Error(piece ? String(piece) : `Repeat gedrag: HTTP ${r.status}`);
      }
      if (payload.error) throw new Error(payload.error);
      repeatData = payload;
      repeatGlobalPayload = payload;
      repeatLoaded = true;
      repeatCacheKey = cacheKey;
      return repeatData;
    } catch (e) {
      repeatError = formatClientError(e) || "Repeat gedrag kon niet geladen worden";
      setRepeatErrorUi("Repeat gedrag kon niet geladen worden");
      throw e;
    } finally {
      repeatLoading = false;
      setRepeatLoadingUi(false);
    }
  }

  els.provPaxBtn?.addEventListener("click", () => {
    provMode = "pax";
    els.provPaxBtn.classList.add("active");
    els.provBookBtn?.classList.remove("active");
    if (window.__lastKpPayload) renderProvinceTable(window.__lastKpPayload);
  });
  els.provBookBtn?.addEventListener("click", () => {
    provMode = "bookings";
    els.provBookBtn.classList.add("active");
    els.provPaxBtn?.classList.remove("active");
    if (window.__lastKpPayload) renderProvinceTable(window.__lastKpPayload);
  });

  els.paxGranMonth?.addEventListener("click", () => {
    paxGran = "month";
    setPaxGranUi();
    if (window.__lastKpPayload) renderPaxOverTime(window.__lastKpPayload);
  });
  els.paxGranWeek?.addEventListener("click", () => {
    paxGran = "week";
    setPaxGranUi();
    if (window.__lastKpPayload) renderPaxOverTime(window.__lastKpPayload);
  });

  els.schoolProvinceFilter?.addEventListener("change", () => {
    schoolProvinceFilter = els.schoolProvinceFilter?.value || "__ALL__";
    if (window.__lastKpPayload) renderSchools(window.__lastKpPayload);
  });

  els.origin?.addEventListener("change", () => {
    updateTravelerProvinceOptions();
  });

  async function handleRepeatLoad(forceReload = false) {
    try {
      const payload = await loadRepeatData(forceReload);
      renderLoyalty(payload);
    } catch (_e) {
      renderLoyalty(null);
    }
  }

  els.repeatLoadBtn?.addEventListener("click", async () => {
    await handleRepeatLoad(false);
  });

  els.repeatRetryBtn?.addEventListener("click", async () => {
    await handleRepeatLoad(true);
  });

  els.apply?.addEventListener("click", async () => {
    try {
      await loadData();
    } catch (e) {
      setErr(formatClientError(e));
      if (els.loading) els.loading.classList.add("d-none");
    }
  });

  els.reset?.addEventListener("click", async () => {
    if (els.year?.options?.length) els.year.selectedIndex = 0;
    if (els.brand) els.brand.value = "__all__";
    if (els.dest) els.dest.value = "";
    kpDestMulti?.clear();
    if (els.period) els.period.value = "all";
    if (els.origin) els.origin.value = "__ALL__";
    updateTravelerProvinceOptions();
    kpProvinceMulti?.clear();
    kpAgeMulti?.clear();
    if (els.brandLand) els.brandLand.value = "__ALL__";
    schoolProvinceFilter = "__ALL__";
    try {
      await loadData();
    } catch (e) {
      setErr(formatClientError(e));
      if (els.loading) els.loading.classList.add("d-none");
    }
  });

  initKpNavigation();

  (async () => {
    try {
      await loadOptions();
      resetRepeatState();
      renderLoyalty(null);
      await loadData();
    } catch (e) {
      setErr(formatClientError(e));
      if (els.loading) els.loading.classList.add("d-none");
    }
  })();
})();
