(() => {
  const RBAC = window.__RBAC__ || {};
  const IS_RESTRICTED_ROLE = Boolean(RBAC.isRestricted);
  const FORCED_PREVIOUS_YEAR = (Number(RBAC.currentYear) || new Date().getFullYear()) - 1;
  const root = document.getElementById("boekingentrendsPage");
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
    typeof window.__DAGTRENDS_API_BASE__ === "string" ? window.__DAGTRENDS_API_BASE__.trim() : "";
  const apiBase = pickApiBase(pageBase, serverBase);
  const apiFromServer =
    typeof window.__DAGTRENDS_API__ === "object" && window.__DAGTRENDS_API__ !== null
      ? window.__DAGTRENDS_API__
      : null;
  const API_OPTIONS = (apiFromServer && apiFromServer.options) || `${apiBase}/options`;
  const API_DATA = (apiFromServer && apiFromServer.data) || `${apiBase}/boekingentrends-data`;
  const API_HEATMAP = (apiFromServer && apiFromServer.heatmap) || `${apiBase}/heatmap-month`;
  const numberFmt = new Intl.NumberFormat("nl-NL");

  const COL_CURRENT = "#ea580c";
  const COL_COMPARE = "#475569";
  const COL_GRID = "#e8ecf4";

  const els = {
    error: document.getElementById("btError"),
    tempo: {
      dateFrom: document.getElementById("btTempoDateFrom"),
      dateTo: document.getElementById("btTempoDateTo"),
      destination: document.getElementById("btTempoDestination"),
      country: document.getElementById("btTempoCountry"),
      brand: document.getElementById("btTempoBrand"),
      reset: document.getElementById("btTempoReset"),
      apply: document.getElementById("btTempoApply"),
      granularityDay: document.getElementById("btGranularityDay"),
      granularityWeek: document.getElementById("btGranularityWeek"),
      granularityMonth: document.getElementById("btGranularityMonth"),
      kpiBookings: document.getElementById("btKpiBookings"),
      kpiPaxPeriod: document.getElementById("btKpiPaxPeriod"),
      kpiDiff: document.getElementById("btKpiDiff"),
      trendChart: document.getElementById("btTrendChart"),
      cumulativeChart: document.getElementById("btCumulativeChart"),
      trendEmpty: document.getElementById("btTempoTrendEmpty"),
      cumulativeEmpty: document.getElementById("btTempoCumulativeEmpty"),
      chartNav: document.getElementById("btTempoChartNav"),
      chartPrev: document.getElementById("btTempoChartPrev"),
      chartNext: document.getElementById("btTempoChartNext"),
      chartNavLabel: document.getElementById("btTempoChartNavLabel"),
    },
    heatmap: {
      month: document.getElementById("btHmMonth"),
      yearLeft: document.getElementById("btHmYearLeft"),
      yearRight: document.getElementById("btHmYearRight"),
      kpiSelect: document.getElementById("btMonthHeatmapKpi"),
      destination: document.getElementById("btHmDestination"),
      brand: document.getElementById("btHmBrand"),
      country: document.getElementById("btHmCountry"),
      reset: document.getElementById("btHmReset"),
      apply: document.getElementById("btHmApply"),
      heatmapWrapLeft: document.getElementById("btDayHeatmapWrapLeft"),
      heatmapWrapRight: document.getElementById("btDayHeatmapWrapRight"),
      heatmapGridLeft: document.getElementById("btDayHeatmapGridLeft"),
      heatmapGridRight: document.getElementById("btDayHeatmapGridRight"),
      heatmapTooltipLeft: document.getElementById("btDayHeatmapTooltipLeft"),
      heatmapTooltipRight: document.getElementById("btDayHeatmapTooltipRight"),
      heatmapEmptyLeft: document.getElementById("btDayHeatmapEmptyLeft"),
      heatmapEmptyRight: document.getElementById("btDayHeatmapEmptyRight"),
    },
    lead: {
      dateFrom: document.getElementById("btLeadDateFrom"),
      dateTo: document.getElementById("btLeadDateTo"),
      destination: document.getElementById("btLeadDestination"),
      country: document.getElementById("btLeadCountry"),
      brand: document.getElementById("btLeadBrand"),
      reset: document.getElementById("btLeadReset"),
      apply: document.getElementById("btLeadApply"),
      leadBe: document.getElementById("btLeadBe"),
      leadNl: document.getElementById("btLeadNl"),
      distTable: document.getElementById("btLeadDistributionTable"),
      distBody: document.getElementById("btLeadDistributionBody"),
      distEmpty: document.getElementById("btLeadDistributionEmpty"),
    },
  };

  const state = {
    tempoGranularity: "day",
    heatmapFetchId: 0,
    trendsFetchId: 0,
    leadFetchId: 0,
    heatmapDefaultsCaptured: false,
    /** Laatste date_from / date_to van een geslaagde tempo-fetch (API = paxMap). */
    tempoFetchDateFrom: "",
    tempoFetchDateTo: "",
    /** Eén bron van waarheid voor grafieken + nav-label: `YYYY-MM-DD` (lokale kalender). */
    tempoWindowStart: "",
    tempoWindowEnd: "",
  };
  let payloads = { tempo: null, heatmap: null, lead: null };
  let heatmapYearOptionsLoaded = false;

  /** Standaardwaarden per filtersectie (knop Filters herstellen). */
  const defaults = {
    tempo: null,
    heatmap: null,
    lead: null,
  };

  /** Bron voor sorteerbare lead-tabel (client-side). */
  let leadDistRows = [];

  const fetchJson = async (url, { signal } = {}) => {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" },
      credentials: "same-origin",
      signal,
    });
    const text = await res.text();
    if (text && /^\s*</.test(text)) {
      const preview = text.slice(0, 200).replace(/\s+/g, " ").trim();
      const onLogin = res.url.includes("/login") || /login/i.test(text.slice(0, 800));
      if (res.status === 401 || onLogin) {
        throw new Error(`Niet ingelogd of sessie verlopen. Vernieuw de pagina en meld je opnieuw aan. (${url})`);
      }
      throw new Error(
        `Server stuurde HTML i.p.v. JSON (verkeerde URL of proxy?). ` +
          `Probeer: apiBase=${apiBase}, url=${url}, status=${res.status}. Preview: ${preview}`,
      );
    }
    let payload = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch (e) {
        throw new Error(
          e?.message?.includes("<!") || e?.message?.includes("Unexpected token")
            ? `Antwoord is geen JSON (vaak login- of foutpagina). URL: ${url}`
            : `Ongeldige JSON-response van de server. URL: ${url}`,
        );
      }
    }
    if (!res.ok) {
      const parts = [payload?.message, payload?.error, payload?.hint, payload?.code ? `code ${payload.code}` : null].filter(
        (p) => p != null && String(p).trim() !== "",
      );
      const msg = parts.length ? parts.map(String).join(" — ") : `Fout bij laden (HTTP ${res.status}).`;
      throw new Error(msg);
    }
    return payload;
  };

  const formatErrorMessage = (e) => {
    if (e == null) return "Onbekende fout.";
    if (typeof e === "number" && e === 0) {
      return "Serverfout zonder duidelijke melding. Controleer of de SQL-RPC dagtrends_boekingentrends_aggregate in Supabase staat en de terminal/logs.";
    }
    if (e instanceof Error && e.message === "0") {
      return "Gegevens konden niet worden geladen (mogelijk ontbreekt of faalt de RPC in Supabase). Zie serverlogs voor details.";
    }
    if (e instanceof Error && e.message) return e.message;
    const s = String(e);
    if (s === "0") {
      return "Gegevens konden niet worden geladen (mogelijk ontbreekt of faalt de RPC in Supabase). Zie serverlogs voor details.";
    }
    return s;
  };

  const setError = (message) => {
    if (!els.error) return;
    if (!message) {
      els.error.classList.add("d-none");
      els.error.textContent = "";
      return;
    }
    els.error.textContent = message;
    els.error.classList.remove("d-none");
  };

  const fillSelect = (selectEl, options) => {
    if (!selectEl) return;
    selectEl.innerHTML = "";
    options.forEach((item) => {
      const opt = document.createElement("option");
      opt.value = item.value;
      opt.textContent = item.label;
      selectEl.appendChild(opt);
    });
  };

  const buildDestOptions = (bestemmingen) =>
    [{ value: "__all__", label: "Alle bestemmingen" }].concat((bestemmingen || []).map((d) => ({ value: d.id, label: d.naam })));

  const buildBrandOptions = (brands) => {
    const raw = Array.isArray(brands) ? brands : [];
    const opts = [{ value: "__all__", label: "Alle merken" }];
    raw.forEach((b) => {
      const s = String(b || "").trim();
      if (s) opts.push({ value: s, label: s });
    });
    return opts;
  };

  const tempoFilters = () => ({
    date_from: els.tempo.dateFrom?.value || "",
    date_to: els.tempo.dateTo?.value || "",
    destination: els.tempo.destination?.value || "__all__",
    country: els.tempo.country?.value || "__all__",
    brand: els.tempo.brand?.value || "__all__",
    granularity: state.tempoGranularity,
  });

  const leadFilters = () => ({
    date_from: els.lead.dateFrom?.value || "",
    date_to: els.lead.dateTo?.value || "",
    destination: els.lead.destination?.value || "__all__",
    country: els.lead.country?.value || "__all__",
    brand: els.lead.brand?.value || "__all__",
    granularity: "day",
  });

  /** Zelfde venster (datum/bestemming/land/brand): één API-response kan tempo- én lead-panel vullen. */
  const canShareBoekingentrendsFetch = () => {
    const t = tempoFilters();
    const l = leadFilters();
    return (
      t.date_from === l.date_from &&
      t.date_to === l.date_to &&
      t.destination === l.destination &&
      t.country === l.country &&
      t.brand === l.brand
    );
  };

  const toggleEmpty = (el, show) => {
    if (!el) return;
    el.classList.toggle("d-none", !show);
  };

  const createSingleLineChart = (canvas, labels, values, { yTitle, datasetLabel, fill = false, fixedYMax = null } = {}) => {
    if (!canvas) return false;
    if (canvas.__chart) canvas.__chart.destroy();
    const labs = Array.isArray(labels) ? labels : [];
    const raw = Array.isArray(values) ? values : [];
    const vals = labs.map((_, i) => Number(raw[i]) || 0);
    const showEmpty = labs.length === 0;
    const maxV = vals.length ? Math.max(...vals, 0) : 0;
    canvas.__chart = new Chart(canvas.getContext("2d"), {
      type: "line",
      data: {
        labels: labs,
        datasets: [
          {
            label: datasetLabel || "Pax",
            data: vals,
            borderColor: COL_CURRENT,
            backgroundColor: fill ? "rgba(234, 88, 12, 0.15)" : "rgba(234, 88, 12, 0.08)",
            borderWidth: 2.5,
            pointRadius: 0,
            tension: 0.25,
            fill: Boolean(fill),
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { intersect: false, mode: "index" },
        plugins: {
          legend: {
            position: "bottom",
            labels: { usePointStyle: true, boxWidth: 8, padding: 16 },
          },
        },
        scales: {
          x: {
            grid: { color: COL_GRID, drawBorder: false },
            ticks: { maxRotation: 45, autoSkip: true, maxTicksLimit: 32 },
          },
          y: {
            beginAtZero: true,
            max: Number.isFinite(Number(fixedYMax)) ? Number(fixedYMax) : undefined,
            suggestedMax: Number.isFinite(Number(fixedYMax)) ? undefined : maxV === 0 ? 5 : undefined,
            title: { display: Boolean(yTitle), text: yTitle || "" },
            grid: { color: COL_GRID, drawBorder: false },
            ticks: { precision: 0 },
          },
        },
      },
    });
    return Boolean(!showEmpty);
  };

  /** Twee lijnen (zelfde x-as) met index-tooltips voor jaar-vergelijking. */
  const createComparisonLineChart = (
    canvas,
    labels,
    valuesCurrent,
    valuesPrevious,
    { yTitle, labelCurrent, labelPrevious, fillCurrent = false, fillPrevious = false, fixedYMax = null } = {},
  ) => {
    if (!canvas) return false;
    if (canvas.__chart) canvas.__chart.destroy();
    const labs = Array.isArray(labels) ? labels : [];
    const c1 = Array.isArray(valuesCurrent) ? valuesCurrent : [];
    const c2 = Array.isArray(valuesPrevious) ? valuesPrevious : [];
    const v1 = labs.map((_, i) => Number(c1[i]) || 0);
    const v2 = labs.map((_, i) => Number(c2[i]) || 0);
    const showEmpty = labs.length === 0;
    const maxV = labs.length ? Math.max(...v1, ...v2, 0) : 0;
    canvas.__chart = new Chart(canvas.getContext("2d"), {
      type: "line",
      data: {
        labels: labs,
        datasets: [
          {
            label: labelCurrent || "—",
            data: v1,
            borderColor: COL_CURRENT,
            backgroundColor: fillCurrent ? "rgba(234, 88, 12, 0.15)" : "rgba(234, 88, 12, 0.08)",
            borderWidth: 2.5,
            pointRadius: 0,
            tension: 0.25,
            fill: Boolean(fillCurrent),
          },
          {
            label: labelPrevious || "—",
            data: v2,
            borderColor: COL_COMPARE,
            backgroundColor: fillPrevious ? "rgba(71, 85, 105, 0.12)" : "rgba(71, 85, 105, 0.06)",
            borderWidth: 2.5,
            pointRadius: 0,
            tension: 0.25,
            fill: Boolean(fillPrevious),
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { intersect: false, mode: "index" },
        plugins: {
          legend: {
            position: "bottom",
            labels: { usePointStyle: true, boxWidth: 8, padding: 16 },
          },
          tooltip: {
            mode: "index",
            intersect: false,
          },
        },
        scales: {
          x: {
            grid: { color: COL_GRID, drawBorder: false },
            ticks: { maxRotation: 45, autoSkip: true, maxTicksLimit: 32 },
          },
          y: {
            beginAtZero: true,
            max: Number.isFinite(Number(fixedYMax)) ? Number(fixedYMax) : undefined,
            suggestedMax: Number.isFinite(Number(fixedYMax)) ? undefined : maxV === 0 ? 5 : undefined,
            title: { display: Boolean(yTitle), text: yTitle || "" },
            grid: { color: COL_GRID, drawBorder: false },
            ticks: { precision: 0 },
          },
        },
      },
    });
    return Boolean(!showEmpty);
  };

  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

  const MONTHS_NL_SHORT = ["jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];

  const heatColor = (intensity) => {
    const i = Math.max(0, Math.min(1, Number(intensity || 0)));
    if (i <= 0) return "#f1f3f5";
    if (i < 0.34) return "#ffedd5";
    if (i < 0.67) return "#fdba74";
    return "#ea580c";
  };

  const HEATMAP_EMPTY_BG = "#f1f3f5";

  const MONTHS_NL_FULL = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];

  const parseIsoMonthKey = (s) => {
    const m = /^(\d{4})-(\d{2})$/.exec(String(s || "").trim());
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    if (mo < 1 || mo > 12) return null;
    return { y, m: mo };
  };

  const parseIsoWeekLabel = (s) => {
    const m = /^(\d{4})-W(\d{2})$/.exec(String(s || "").trim());
    if (!m) return null;
    return { y: Number(m[1]), w: Number(m[2]) };
  };

  const isoWeekMonday = (isoYear, isoWeek) => {
    const jan4 = new Date(isoYear, 0, 4);
    const jan4Dow = (jan4.getDay() + 6) % 7;
    const mondayWeek1 = new Date(jan4);
    mondayWeek1.setDate(jan4.getDate() - jan4Dow);
    const monday = new Date(mondayWeek1);
    monday.setDate(mondayWeek1.getDate() + (isoWeek - 1) * 7);
    return monday;
  };

  const isoWeekOverlapsRange = (isoYear, isoWeek, rangeStart, rangeEnd) => {
    if (!rangeStart || !rangeEnd) return false;
    const mon = isoWeekMonday(isoYear, isoWeek);
    const sun = new Date(mon);
    sun.setDate(mon.getDate() + 6);
    return !(dateKey(sun) < dateKey(rangeStart) || dateKey(mon) > dateKey(rangeEnd));
  };

  /** Donderdag van de ISO-week: maand voor x-as label (consistent met midden van de week). */
  const isoWeekThursday = (isoYear, isoWeek) => {
    const mon = isoWeekMonday(isoYear, isoWeek);
    const th = new Date(mon);
    th.setDate(mon.getDate() + 3);
    return th;
  };

  const formatWeekAxisLabel = (rawLabel) => {
    const p = parseIsoWeekLabel(rawLabel);
    if (!p) return String(rawLabel || "");
    const th = isoWeekThursday(p.y, p.w);
    const moAbbr = MONTHS_NL_SHORT[th.getMonth()];
    return `W${String(p.w).padStart(2, "0")} · ${moAbbr}`;
  };

  const formatMonthAxisLabels = (rawLabels) => {
    const years = new Set();
    rawLabels.forEach((lab) => {
      const p = parseIsoMonthKey(lab);
      if (p) years.add(p.y);
    });
    const multiYear = years.size > 1;
    return rawLabels.map((lab) => {
      const p = parseIsoMonthKey(lab);
      if (!p) return String(lab || "");
      const abbr = MONTHS_NL_SHORT[p.m - 1];
      if (multiYear) return `${abbr} '${String(p.y).slice(2)}`;
      return abbr;
    });
  };

  const parseISODateLocal = (s) => {
    if (!s || typeof s !== "string") return null;
    const part = s.slice(0, 10).split("-").map(Number);
    if (part.length !== 3 || part.some((x) => Number.isNaN(x))) return null;
    return new Date(part[0], part[1] - 1, part[2]);
  };

  const addDaysLocal = (base, n) => {
    const x = new Date(base.getFullYear(), base.getMonth(), base.getDate());
    x.setDate(x.getDate() + n);
    return x;
  };

  const dateKey = (d) => d.getFullYear() * 400 + d.getMonth() * 32 + d.getDate();

  const copyDate = (d) => (d ? new Date(d.getFullYear(), d.getMonth(), d.getDate()) : null);

  const formatIsoLocal = (d) => {
    if (!d) return "";
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  const addMonthsLocal = (base, n) => {
    const x = copyDate(base);
    if (!x) return null;
    x.setMonth(x.getMonth() + n);
    return x;
  };

  /** Eerste dag van het kalenderkwartaal waarin `d` valt. */
  const startOfQuarterContaining = (d) => {
    if (!d) return null;
    const q = Math.floor(d.getMonth() / 3);
    return new Date(d.getFullYear(), q * 3, 1);
  };

  /** windowEnd = windowStart + 3 maanden − 1 dag (exacte kwartaallengte). */
  const quarterEndFromWindowStart = (windowStart) => {
    if (!windowStart) return null;
    const qNext = addMonthsLocal(windowStart, 3);
    if (!qNext) return null;
    return addDaysLocal(qNext, -1);
  };

  const rangesOverlapInclusive = (a0, a1, b0, b1) => {
    if (!a0 || !a1 || !b0 || !b1) return false;
    return !(dateKey(a1) < dateKey(b0) || dateKey(a0) > dateKey(b1));
  };

  /** Na fetch: kwartaal vanaf start van het kwartaal dat date_from snijdt. */
  const resetTempoWindowToFetchQuarter = () => {
    const fd = parseISODateLocal(state.tempoFetchDateFrom);
    const ws = startOfQuarterContaining(fd);
    const we = quarterEndFromWindowStart(ws);
    state.tempoWindowStart = formatIsoLocal(ws);
    state.tempoWindowEnd = formatIsoLocal(we);
  };

  const canShiftTempoWindowByMonths = (deltaMonths) => {
    const ws = parseISODateLocal(state.tempoWindowStart);
    const fetchFromD = parseISODateLocal(state.tempoFetchDateFrom);
    const fetchToD = parseISODateLocal(state.tempoFetchDateTo);
    if (!ws || !fetchFromD || !fetchToD) return false;
    const nextWs = addMonthsLocal(ws, deltaMonths);
    if (!nextWs) return false;
    const nextWe = quarterEndFromWindowStart(nextWs);
    if (!nextWe) return false;
    return rangesOverlapInclusive(nextWs, nextWe, fetchFromD, fetchToD);
  };

  const buildPaxByDayKey = (fromStr, vals) => {
    const m = new Map();
    const from = parseISODateLocal(fromStr);
    if (!from || !Array.isArray(vals)) return m;
    for (let i = 0; i < vals.length; i += 1) {
      const d = addDaysLocal(from, i);
      m.set(dateKey(d), Number(vals[i]) || 0);
    }
    return m;
  };

  const fmtDmLabel = (d) =>
    `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}`;

  const denseSeriesInRange = (rangeStart, rangeEnd, paxMap) => {
    const labels = [];
    const values = [];
    for (let d = copyDate(rangeStart); dateKey(d) <= dateKey(rangeEnd); d = addDaysLocal(d, 1)) {
      labels.push(fmtDmLabel(d));
      values.push(paxMap.get(dateKey(d)) ?? 0);
    }
    return { labels, values };
  };

  /** Som van `paxMap` op [rangeStart, endExclusive) — voor cumulatief door laten lopen vóór het zichtbare venster. */
  const sumPaxMapInHalfOpenRange = (paxMap, rangeStart, endExclusive) => {
    let s = 0;
    if (!rangeStart || !endExclusive || dateKey(rangeStart) >= dateKey(endExclusive)) return s;
    for (let d = copyDate(rangeStart); dateKey(d) < dateKey(endExclusive); d = addDaysLocal(d, 1)) {
      s += paxMap.get(dateKey(d)) ?? 0;
    }
    return s;
  };

  const formatWindowNavLabel = (startD, endD) => {
    if (!startD || !endD) return "";
    const fmt = (d) => `${d.getDate()} ${MONTHS_NL_FULL[d.getMonth()]} ${d.getFullYear()}`;
    return `${fmt(startD)} – ${fmt(endD)}`;
  };

  const kpiValueFromDay = (d, kpi) => {
    if (kpi === "travellers") return Number(d.travellers ?? d.reizigers ?? 0);
    if (kpi === "pax_booking") return Number(d.pax_on_booking_day ?? d.pax_per_booking ?? 0);
    return Number(d.bookings ?? 0);
  };

  const kpiMetaHeatmap = (kpi) => {
    const fmt = (v) => numberFmt.format(Math.round(Number(v || 0)));
    if (kpi === "travellers") return { label: "Reizigers op reis", format: fmt };
    if (kpi === "pax_booking") return { label: "Pax", format: fmt };
    return { label: "Boekingen", format: fmt };
  };

  const renderHeatmapPanel = ({
    suffix,
    year,
    monthNum,
    days,
    selectedKpi,
    maxVal,
    dayCellRefs,
    syncLinkedHover,
    peerYear,
    peerDays,
  }) => {
    const H = els.heatmap;
    const wrapEl = H[`heatmapWrap${suffix}`];
    const gridEl = H[`heatmapGrid${suffix}`];
    const tooltipEl = H[`heatmapTooltip${suffix}`];
    const emptyEl = H[`heatmapEmpty${suffix}`];
    if (!gridEl) return;

    const monthIndex = monthNum - 1;
    const daysInMonth = days.length;
    if (daysInMonth === 0) {
      gridEl.innerHTML = "";
      emptyEl?.classList.remove("d-none");
      return;
    }
    emptyEl?.classList.add("d-none");

    const meta = kpiMetaHeatmap(selectedKpi);
    const values = days.map((dayRow) => kpiValueFromDay(dayRow, selectedKpi));

    const sumBookings = days.reduce((a, d) => a + Number(d.bookings || 0), 0);
    const sumTrav = days.reduce((a, d) => a + Number(d.travellers ?? d.reizigers ?? 0), 0);
    const sumPaxDay = days.reduce((a, d) => a + Number(d.pax_on_booking_day ?? d.pax_per_booking ?? 0), 0);
    const avgTrav = daysInMonth ? sumTrav / daysInMonth : 0;
    const avgPaxBook = sumBookings > 0 ? sumPaxDay / sumBookings : 0;

    let peakDay = 1;
    let peakVal = -1;
    days.forEach((d) => {
      const v = kpiValueFromDay(d, selectedKpi);
      if (v > peakVal) {
        peakVal = v;
        peakDay = d.day;
      }
    });
    if (peakVal < 0) peakVal = 0;

    const setText = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };

    setText(`btMonthHeatmapYear${suffix}`, String(year));
    setText(`btMonthHeatmapMonthLabel${suffix}`, MONTHS_NL_FULL[monthIndex] || "—");
    setText(`btMonthHeatmapStatBookings${suffix}`, numberFmt.format(sumBookings));
    setText(`btMonthHeatmapStatTravellers${suffix}`, numberFmt.format(Math.round(avgTrav)));
    setText(`btMonthHeatmapStatPaxBooking${suffix}`, sumBookings > 0 ? String(Math.round(avgPaxBook * 10) / 10).replace(".", ",") : "—");
    setText(`btMonthHeatmapPeakValue${suffix}`, meta.format(peakVal));
    setText(`btMonthHeatmapPeakLabel${suffix}`, `${peakDay} ${MONTHS_NL_SHORT[monthIndex]}`);

    gridEl.innerHTML = "";

    const canTooltip = Boolean(tooltipEl && wrapEl);
    const sharedMax = Math.max(0, Number(maxVal || 0));

    const showTooltip = (cellEl, dayNumber, value) => {
      if (!canTooltip) return;
      const kpiWord = (meta.label || "").toLowerCase();
      const dateTitle = `${dayNumber} ${MONTHS_NL_SHORT[monthIndex]}`;
      const rowLocal = `<div class="bt-day-heatmap-tooltip__row"><span class="bt-day-heatmap-tooltip__yr">${year}</span>: <strong>${meta.format(
        value,
      )}</strong> <span class="bt-day-heatmap-tooltip__dim">${kpiWord}</span></div>`;
      let rowPeer = "";
      if (peerYear != null && Array.isArray(peerDays)) {
        const peerRow = peerDays.find((d) => Number(d.day) === dayNumber);
        if (peerRow) {
          const pv = kpiValueFromDay(peerRow, selectedKpi);
          rowPeer = `<div class="bt-day-heatmap-tooltip__row"><span class="bt-day-heatmap-tooltip__yr">${peerYear}</span>: <strong>${meta.format(
            pv,
          )}</strong> <span class="bt-day-heatmap-tooltip__dim">${kpiWord}</span></div>`;
        } else {
          rowPeer = `<div class="bt-day-heatmap-tooltip__row"><span class="bt-day-heatmap-tooltip__yr">${peerYear}</span>: <span class="bt-day-heatmap-tooltip__dim">Geen data</span></div>`;
        }
      }
      tooltipEl.innerHTML = `
        <div class="bt-day-heatmap-tooltip__date">${dateTitle}</div>
        ${rowLocal}
        ${rowPeer}
      `;
      tooltipEl.classList.add("bt-day-heatmap-tooltip--visible");
      tooltipEl.setAttribute("aria-hidden", "false");

      const rWrap = wrapEl.getBoundingClientRect();
      const rCell = cellEl.getBoundingClientRect();
      const rTip = tooltipEl.getBoundingClientRect();

      const x = rCell.left - rWrap.left + rCell.width / 2 - rTip.width / 2;
      let y = rCell.top - rWrap.top - rTip.height - 8;
      if (y < 0) y = rCell.bottom - rWrap.top + 8;

      const clampedX = clamp(x, 6, Math.max(6, rWrap.width - rTip.width - 6));
      const clampedY = clamp(y, 6, Math.max(6, rWrap.height - rTip.height - 6));

      tooltipEl.style.left = `${clampedX}px`;
      tooltipEl.style.top = `${clampedY}px`;
    };

    const hideTooltip = () => {
      if (!canTooltip) return;
      tooltipEl.classList.remove("bt-day-heatmap-tooltip--visible");
      tooltipEl.setAttribute("aria-hidden", "true");
    };

    const firstDay = new Date(year, monthIndex, 1);
    const offsetMon0 = (firstDay.getDay() + 6) % 7;
    const totalCells = Math.ceil((offsetMon0 + daysInMonth) / 7) * 7;

    for (let cellIdx = 0; cellIdx < totalCells; cellIdx += 1) {
      const dayIdx = cellIdx - offsetMon0;
      if (dayIdx < 0 || dayIdx >= daysInMonth) {
        const cell = document.createElement("div");
        cell.className = "bt-day-heatmap-cell bt-day-heatmap-cell--empty";
        cell.setAttribute("aria-hidden", "true");
        cell.textContent = "";
        gridEl.appendChild(cell);
        continue;
      }

      const dayNumber = dayIdx + 1;
      const raw = values[dayIdx];
      const value = Math.max(0, Number.isFinite(Number(raw)) ? Number(raw) : 0);
      const hasValue = value > 0;
      const norm = sharedMax > 0 && hasValue ? Math.min(1, value / sharedMax) : 0;
      const bg = hasValue ? heatColor(norm) : HEATMAP_EMPTY_BG;

      const cellBtn = document.createElement("button");
      cellBtn.type = "button";
      cellBtn.className = "bt-day-heatmap-cell";
      cellBtn.textContent = String(dayNumber);
      cellBtn.style.backgroundColor = bg;
      cellBtn.style.borderColor = hasValue ? "rgba(234, 88, 12, 0.4)" : "#e2e8f0";
      cellBtn.setAttribute("aria-label", `${dayNumber} ${meta.label}: ${meta.format(value)}`);

      if (dayCellRefs) dayCellRefs.set(dayNumber, cellBtn);

      cellBtn.addEventListener("mouseenter", () => {
        showTooltip(cellBtn, dayNumber, value);
        syncLinkedHover?.(dayNumber, true);
      });
      cellBtn.addEventListener("mouseleave", () => {
        hideTooltip();
        syncLinkedHover?.(dayNumber, false);
      });
      cellBtn.addEventListener("focus", () => showTooltip(cellBtn, dayNumber, value));
      cellBtn.addEventListener("blur", () => {
        hideTooltip();
        syncLinkedHover?.(dayNumber, false);
      });

      gridEl.appendChild(cellBtn);
    }
  };

  const renderHeatmapComparison = (data) => {
    const H = els.heatmap;
    if (!H.heatmapGridLeft || !H.heatmapGridRight || !data) return;

    const monthNum = Number(data.month);
    const leftDays = Array.isArray(data.left_days) ? data.left_days : [];
    const rightDays = Array.isArray(data.right_days) ? data.right_days : [];

    if (!monthNum) {
      H.heatmapGridLeft.innerHTML = "";
      H.heatmapGridRight.innerHTML = "";
      H.heatmapEmptyLeft?.classList.remove("d-none");
      H.heatmapEmptyRight?.classList.remove("d-none");
      return;
    }

    const selectedKpi = H.kpiSelect?.value || "bookings";
    const leftValues = leftDays.map((d) => Math.max(0, Number(kpiValueFromDay(d, selectedKpi))));
    const rightValues = rightDays.map((d) => Math.max(0, Number(kpiValueFromDay(d, selectedKpi))));
    const allValues = [...leftValues, ...rightValues];
    const maxVal = allValues.length > 0 ? Math.max(0, ...allValues) : 0;

    const leftCells = new Map();
    const rightCells = new Map();

    renderHeatmapPanel({
      suffix: "Left",
      year: data.left_year,
      monthNum,
      days: leftDays,
      selectedKpi,
      maxVal,
      dayCellRefs: leftCells,
      peerYear: data.right_year,
      peerDays: rightDays,
      syncLinkedHover: (dayNum, isEnter) => {
        const peer = rightCells.get(dayNum);
        peer?.classList.toggle("is-linked-hover", isEnter);
      },
    });
    renderHeatmapPanel({
      suffix: "Right",
      year: data.right_year,
      monthNum,
      days: rightDays,
      selectedKpi,
      maxVal,
      dayCellRefs: rightCells,
      peerYear: data.left_year,
      peerDays: leftDays,
      syncLinkedHover: (dayNum, isEnter) => {
        const peer = leftCells.get(dayNum);
        peer?.classList.toggle("is-linked-hover", isEnter);
      },
    });
  };

  const renderTempo = (payload) => {
    const t = els.tempo;
    const kpi = payload?.kpis || {};
    const pt = payload?.pax_tempo || {};
    const pc = payload?.pax_cumulative || {};

    if (t.kpiBookings) t.kpiBookings.textContent = numberFmt.format(Number(kpi.bookings_in_period ?? 0));
    if (t.kpiPaxPeriod) t.kpiPaxPeriod.textContent = numberFmt.format(Number(kpi.pax_in_period ?? 0));
    if (t.kpiDiff) {
      const p = kpi.pct_vs_last_year_pax;
      t.kpiDiff.textContent = p == null ? "—" : `${Number(p).toFixed(1)}%`;
    }

    let lbl = Array.isArray(pt.labels) ? [...pt.labels] : [];
    let lblCum = Array.isArray(pt.labels) ? [...pt.labels] : [];
    let vals = Array.isArray(pt.values) ? [...pt.values] : [];
    let cvals = Array.isArray(pc.values) ? [...pc.values] : [];
    let valsPrevAligned = null;
    let cvalsPrevAligned = null;

    const dataFromStr = state.tempoFetchDateFrom || "";
    const dataToStr = state.tempoFetchDateTo || "";
    const gran = state.tempoGranularity || payload?.granularity || "day";
    const apiValsFull = Array.isArray(pt.values) ? pt.values : [];
    const apiPrevFull = Array.isArray(pt.values_previous) ? pt.values_previous : [];
    const canYoY =
      apiPrevFull.length > 0 && apiValsFull.length > 0 && apiPrevFull.length === apiValsFull.length;
    const globalTrendMax = Math.max(...apiValsFull, ...(canYoY ? apiPrevFull : []), 0);
    const buildRunning = (arr) => {
      let run = 0;
      return arr.map((v) => {
        run += Number(v) || 0;
        return run;
      });
    };
    const globalCumCurrent = buildRunning(apiValsFull);
    const globalCumPrevious = canYoY ? buildRunning(apiPrevFull) : [];
    const globalCumMax = Math.max(...globalCumCurrent, ...(canYoY ? globalCumPrevious : []), 0);

    const getFilteredBookingsForDepartureYear = (series, departureYear) => {
      if (!Array.isArray(series)) return [];
      const out = [];
      for (const row of series) {
        if (!row || typeof row !== "object") continue;
        const booking = parseISODateLocal(String(row.booking_date || ""));
        const departure = parseISODateLocal(String(row.departure_date || ""));
        if (!booking || !departure || departure.getFullYear() !== departureYear) continue;
        out.push({ booking, pax: Number(row.pax) || 0 });
      }
      out.sort((a, b) => dateKey(a.booking) - dateKey(b.booking));
      return out;
    };
    const buildCumulativeSeries = (series) => {
      const labelsOut = [];
      const valuesOut = [];
      let running = 0;
      for (const row of series) {
        running += Number(row.pax) || 0;
        labelsOut.push(fmtDmLabel(row.booking));
        valuesOut.push(running);
      }
      return { labels: labelsOut, values: valuesOut };
    };

    if (gran === "day" && dataFromStr && dataToStr) {
      const ws = parseISODateLocal(state.tempoWindowStart);
      const we = parseISODateLocal(state.tempoWindowEnd);
      if (!ws || !we || dateKey(ws) > dateKey(we)) {
        resetTempoWindowToFetchQuarter();
      }
      const wStart = parseISODateLocal(state.tempoWindowStart);
      const wEnd = parseISODateLocal(state.tempoWindowEnd);

      if (wStart && wEnd && dateKey(wStart) <= dateKey(wEnd)) {
        const paxMap = buildPaxByDayKey(dataFromStr, pt.values || []);
        const dense = denseSeriesInRange(wStart, wEnd, paxMap);
        lbl = dense.labels;
        lblCum = dense.labels;
        vals = dense.values;
        const periodStart = parseISODateLocal(dataFromStr);
        const offsetCur =
          periodStart && dateKey(periodStart) < dateKey(wStart)
            ? sumPaxMapInHalfOpenRange(paxMap, periodStart, wStart)
            : 0;
        let run = offsetCur;
        cvals = vals.map((vPart) => {
          run += Number(vPart) || 0;
          return run;
        });
        const departureYear = parseISODateLocal(dataFromStr)?.getFullYear();
        const rawBookingSeries = payload?.booking_series_current;
        if (Number.isFinite(departureYear) && Array.isArray(rawBookingSeries) && rawBookingSeries.length > 0) {
          const filteredBookings = getFilteredBookingsForDepartureYear(rawBookingSeries, departureYear);
          const built = buildCumulativeSeries(filteredBookings);
          if (built.values.length > 0) {
            cvals = built.values;
            lblCum = built.labels;
          }
        }
        if (canYoY) {
          const paxMapPrev = buildPaxByDayKey(dataFromStr, apiPrevFull);
          const densePrev = denseSeriesInRange(wStart, wEnd, paxMapPrev);
          if (densePrev.labels.length === lbl.length) {
            valsPrevAligned = densePrev.values;
            const offsetPrev =
              periodStart && dateKey(periodStart) < dateKey(wStart)
                ? sumPaxMapInHalfOpenRange(paxMapPrev, periodStart, wStart)
                : 0;
            let runP = offsetPrev;
            cvalsPrevAligned = valsPrevAligned.map((vPart) => {
              runP += Number(vPart) || 0;
              return runP;
            });
          }
        }
      }

      if (t.chartNav) {
        t.chartNav.classList.remove("d-none");
        t.chartNav.classList.add("d-flex");
        if (wStart && wEnd) {
          if (t.chartNavLabel) t.chartNavLabel.textContent = formatWindowNavLabel(wStart, wEnd);
          if (t.chartPrev) {
            t.chartPrev.classList.remove("d-none");
            t.chartPrev.disabled = !canShiftTempoWindowByMonths(-3);
          }
          if (t.chartNext) {
            t.chartNext.classList.remove("d-none");
            t.chartNext.disabled = !canShiftTempoWindowByMonths(3);
          }
        }
      }
    } else if (gran === "week" && dataFromStr && dataToStr) {
      const ws = parseISODateLocal(state.tempoWindowStart);
      const we = parseISODateLocal(state.tempoWindowEnd);
      if (!ws || !we || dateKey(ws) > dateKey(we)) {
        resetTempoWindowToFetchQuarter();
      }
      const wStart = parseISODateLocal(state.tempoWindowStart);
      const wEnd = parseISODateLocal(state.tempoWindowEnd);

      const lblRaw = Array.isArray(pt.labels) ? [...pt.labels] : [];
      vals = Array.isArray(pt.values) ? [...pt.values] : [];
      const idx = [];
      for (let i = 0; i < lblRaw.length; i += 1) {
        const pw = parseIsoWeekLabel(lblRaw[i]);
        if (pw && wStart && wEnd && isoWeekOverlapsRange(pw.y, pw.w, wStart, wEnd)) idx.push(i);
      }
      lbl = idx.map((i) => formatWeekAxisLabel(lblRaw[i]));
      lblCum = lbl;
      vals = idx.map((i) => Number(vals[i]) || 0);
      let runW = 0;
      cvals = vals.map((vPart) => {
        runW += Number(vPart) || 0;
        return runW;
      });

      if (canYoY && idx.length > 0) {
        valsPrevAligned = idx.map((i) => Number(apiPrevFull[i]) || 0);
        runW = 0;
        cvalsPrevAligned = valsPrevAligned.map((vPart) => {
          runW += Number(vPart) || 0;
          return runW;
        });
      }

      if (t.chartNav) {
        t.chartNav.classList.remove("d-none");
        t.chartNav.classList.add("d-flex");
        if (wStart && wEnd) {
          if (t.chartNavLabel) t.chartNavLabel.textContent = formatWindowNavLabel(wStart, wEnd);
          if (t.chartPrev) {
            t.chartPrev.classList.remove("d-none");
            t.chartPrev.disabled = !canShiftTempoWindowByMonths(-3);
          }
          if (t.chartNext) {
            t.chartNext.classList.remove("d-none");
            t.chartNext.disabled = !canShiftTempoWindowByMonths(3);
          }
        }
      }
    } else if (gran === "month") {
      state.tempoWindowStart = "";
      state.tempoWindowEnd = "";
      if (t.chartNav) {
        t.chartNav.classList.add("d-none");
        t.chartNav.classList.remove("d-flex");
      }
      const rawL = Array.isArray(pt.labels) ? [...pt.labels] : [];
      lbl = formatMonthAxisLabels(rawL);
      lblCum = lbl;
    } else {
      state.tempoWindowStart = "";
      state.tempoWindowEnd = "";
      if (t.chartNav) {
        t.chartNav.classList.add("d-none");
        t.chartNav.classList.remove("d-flex");
      }
    }

    if (
      canYoY &&
      valsPrevAligned == null &&
      lbl.length > 0 &&
      lbl.length === apiPrevFull.length
    ) {
      valsPrevAligned = apiPrevFull.map((x) => Number(x) || 0);
      const apiCprev = Array.isArray(pc.values_previous) ? pc.values_previous : [];
      if (apiCprev.length === lbl.length) {
        cvalsPrevAligned = apiCprev.map((x) => Number(x) || 0);
      } else {
        let runP = 0;
        cvalsPrevAligned = valsPrevAligned.map((x) => {
          runP += x;
          return runP;
        });
      }
    }

    const yCur =
      parseISODateLocal(state.tempoFetchDateFrom || dataFromStr)?.getFullYear() ??
      new Date().getFullYear();
    const yPrev = yCur - 1;

    const useDualChart =
      Array.isArray(valsPrevAligned) && valsPrevAligned.length === lbl.length && lbl.length > 0;
    const useDualCum =
      Array.isArray(cvalsPrevAligned) && cvalsPrevAligned.length === lblCum.length && lblCum.length > 0;

    const hasTrend = useDualChart
      ? createComparisonLineChart(t.trendChart, lbl, vals, valsPrevAligned, {
          labelCurrent: String(yCur),
          labelPrevious: String(yPrev),
          yTitle: "Pax",
          fixedYMax: globalTrendMax,
        })
      : createSingleLineChart(t.trendChart, lbl, vals, {
          datasetLabel: "Pax (boekingsdatum)",
          yTitle: "Pax",
          fixedYMax: globalTrendMax,
        });
    toggleEmpty(t.trendEmpty, !hasTrend);

    const hasCum = useDualCum
      ? createComparisonLineChart(t.cumulativeChart, lblCum, cvals, cvalsPrevAligned, {
          labelCurrent: String(yCur),
          labelPrevious: String(yPrev),
          yTitle: "Cumulatief pax",
          fillCurrent: true,
          fillPrevious: false,
          fixedYMax: globalCumMax,
        })
      : createSingleLineChart(t.cumulativeChart, lblCum, cvals, {
          datasetLabel: "Cumulatief pax",
          yTitle: "Cumulatief pax",
          fill: true,
          fixedYMax: globalCumMax,
        });
    toggleEmpty(t.cumulativeEmpty, !hasCum);
  };

  const renderLeadTableBody = (rows) => {
    const L = els.lead;
    if (!L.distBody) return;
    const maxC = rows.length ? Math.max(1, ...rows.map((r) => Number(r.count) || 0)) : 1;
    L.distBody.innerHTML = "";
    rows.forEach((r) => {
      const c = Number(r.count) || 0;
      const p = Number(r.pct) || 0;
      const w = Math.round((c / maxC) * 100);
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${r.label}</td>
        <td class="text-end vg-num">${numberFmt.format(c)}</td>
        <td class="text-end vg-num">${p.toFixed(1)}%</td>
        <td>
          <div class="bt-lead-dist-bar" role="presentation" aria-hidden="true">
            <div class="bt-lead-dist-bar__fill" style="width: ${w}%"></div>
          </div>
        </td>
      `;
      L.distBody.appendChild(tr);
    });
  };

  const renderLead = (payload) => {
    const L = els.lead;
    const lead = payload?.lead_time || {};
    const fmtAvg = (v) => (v == null ? "—" : `${Number(v).toFixed(1)} dagen`);
    if (L.leadBe) L.leadBe.textContent = fmtAvg(lead.avg_be);
    if (L.leadNl) L.leadNl.textContent = fmtAvg(lead.avg_nl);

    const dist = lead.distribution || {};
    const labels = dist.labels || [];
    const counts = dist.counts || [];
    const percents = dist.percents || [];
    const total = dist.total_bookings_with_dates ?? 0;

    if (!L.distBody || !L.distTable || !L.distEmpty) return;

    const hasData = total > 0 && labels.length > 0;

    if (!hasData) {
      L.distTable.classList.add("d-none");
      L.distEmpty.classList.remove("d-none");
      leadDistRows = [];
      return;
    }

    L.distEmpty.classList.add("d-none");
    L.distTable.classList.remove("d-none");

    leadDistRows = labels.map((lab, i) => ({
      label: String(lab ?? ""),
      count: Number(counts[i] || 0),
      pct: Number(percents[i] || 0),
    }));
    renderLeadTableBody(leadDistRows);

    const wire = typeof globalThis.TA_wireSortableTable === "function" ? globalThis.TA_wireSortableTable : null;
    if (wire) {
      wire(
        L.distTable,
        () => leadDistRows.slice(),
        (rows) => {
          leadDistRows = rows;
          renderLeadTableBody(rows);
        },
      );
    }
  };

  const captureDefaultsTempoLead = () => {
    defaults.tempo = {
      dateFrom: els.tempo.dateFrom?.value || "",
      dateTo: els.tempo.dateTo?.value || "",
      destination: els.tempo.destination?.value || "__all__",
      country: els.tempo.country?.value || "__all__",
      brand: els.tempo.brand?.value || "__all__",
      granularity: state.tempoGranularity,
    };
    defaults.lead = {
      dateFrom: els.lead.dateFrom?.value || "",
      dateTo: els.lead.dateTo?.value || "",
      destination: els.lead.destination?.value || "__all__",
      country: els.lead.country?.value || "__all__",
      brand: els.lead.brand?.value || "__all__",
    };
  };

  const captureHeatmapDefaultsFromDom = () => {
    const H = els.heatmap;
    const y = new Date().getFullYear();
    defaults.heatmap = {
      month: H.month?.value || "1",
      yearLeft: H.yearLeft?.value || String(y),
      yearRight: IS_RESTRICTED_ROLE ? String(FORCED_PREVIOUS_YEAR) : H.yearRight?.value || String(y - 1),
      destination: H.destination?.value || "__all__",
      country: H.country?.value || "__all__",
      brand: H.brand?.value || "__all__",
      kpi: H.kpiSelect?.value || "bookings",
    };
  };

  const applyTempoDefaults = () => {
    const d = defaults.tempo;
    if (!d) return;
    if (els.tempo.dateFrom) els.tempo.dateFrom.value = d.dateFrom;
    if (els.tempo.dateTo) els.tempo.dateTo.value = d.dateTo;
    if (els.tempo.destination) els.tempo.destination.value = d.destination;
    if (els.tempo.country) els.tempo.country.value = d.country;
    if (els.tempo.brand) els.tempo.brand.value = d.brand;
    setGranularity(d.granularity || "day");
  };

  const applyLeadDefaults = () => {
    const d = defaults.lead;
    if (!d) return;
    if (els.lead.dateFrom) els.lead.dateFrom.value = d.dateFrom;
    if (els.lead.dateTo) els.lead.dateTo.value = d.dateTo;
    if (els.lead.destination) els.lead.destination.value = d.destination;
    if (els.lead.country) els.lead.country.value = d.country;
    if (els.lead.brand) els.lead.brand.value = d.brand;
  };

  const applyHeatmapDefaults = () => {
    const H = els.heatmap;
    const d = defaults.heatmap;
    const now = new Date();
    if (!d) {
      if (H.month) H.month.value = String(now.getMonth() + 1);
      if (H.yearLeft) H.yearLeft.value = String(now.getFullYear());
      if (H.yearRight) H.yearRight.value = IS_RESTRICTED_ROLE ? String(FORCED_PREVIOUS_YEAR) : String(now.getFullYear() - 1);
      if (H.destination) H.destination.value = "__all__";
      if (H.country) H.country.value = "__all__";
      if (H.brand) H.brand.value = "__all__";
      if (H.kpiSelect) H.kpiSelect.value = "bookings";
      return;
    }
    if (H.month) H.month.value = d.month;
    if (H.yearLeft && d.yearLeft) H.yearLeft.value = d.yearLeft;
    if (H.yearRight) H.yearRight.value = IS_RESTRICTED_ROLE ? String(FORCED_PREVIOUS_YEAR) : d.yearRight;
    if (H.destination) H.destination.value = d.destination;
    if (H.country) H.country.value = d.country;
    if (H.brand) H.brand.value = d.brand;
    if (H.kpiSelect) H.kpiSelect.value = d.kpi || "bookings";
  };

  const mergeYearOptionsIntoSelect = (selectEl, years) => {
    if (!selectEl || !years?.length) return;
    const have = new Set([...selectEl.options].map((o) => o.value));
    years.forEach((y) => {
      const s = String(y);
      if (!s || have.has(s)) return;
      const opt = document.createElement("option");
      opt.value = s;
      opt.textContent = s;
      selectEl.appendChild(opt);
      have.add(s);
    });
  };

  const loadHeatmap = async () => {
    const H = els.heatmap;
    const now = new Date();
    state._heatmapAbort?.abort();
    const myId = ++state.heatmapFetchId;
    const ac = new AbortController();
    state._heatmapAbort = ac;

    const month = H.month?.value || String(now.getMonth() + 1);
    const leftYear = H.yearLeft?.value || String(now.getFullYear());
    const rightYear = IS_RESTRICTED_ROLE ? String(FORCED_PREVIOUS_YEAR) : H.yearRight?.value || String(now.getFullYear() - 1);
    const destination = H.destination?.value || "__all__";
    const country = H.country?.value || "__all__";
    const brand = H.brand?.value || "__all__";

    const params = new URLSearchParams({
      month,
      left_year: leftYear,
      right_year: rightYear,
      destination,
      country,
      brand,
    });
    try {
      const data = await fetchJson(`${API_HEATMAP}?${params.toString()}`, { signal: ac.signal });
      if (myId !== state.heatmapFetchId) return;

      payloads.heatmap = data;

      if (Array.isArray(data.available_years) && data.available_years.length && !heatmapYearOptionsLoaded) {
        const opts = data.available_years.map((y) => ({ value: String(y), label: String(y) }));
        fillSelect(H.yearLeft, opts);
        fillSelect(H.yearRight, opts);
        heatmapYearOptionsLoaded = true;
      }

      const yearsMerge = [
        ...(Array.isArray(data.available_years) ? data.available_years : []),
        data.left_year,
        data.right_year,
      ].filter((y) => y != null && String(y).length > 0);
      mergeYearOptionsIntoSelect(H.yearLeft, yearsMerge);
      mergeYearOptionsIntoSelect(H.yearRight, yearsMerge);

      if (H.yearLeft) H.yearLeft.value = String(data.left_year);
      if (H.yearRight) H.yearRight.value = IS_RESTRICTED_ROLE ? String(FORCED_PREVIOUS_YEAR) : String(data.right_year);
      if (H.month) H.month.value = String(data.month);

      renderHeatmapComparison(data);
      if (!state.heatmapDefaultsCaptured) {
        captureHeatmapDefaultsFromDom();
        state.heatmapDefaultsCaptured = true;
      }
    } catch (e) {
      if (e?.name === "AbortError") return;
      throw e;
    }
  };

  const loadTrends = async ({ lockApplyBtn = true } = {}) => {
    if (lockApplyBtn) els.tempo.apply?.setAttribute("disabled", "disabled");
    state._trendsAbort?.abort();
    const myId = ++state.trendsFetchId;
    const ac = new AbortController();
    state._trendsAbort = ac;
    const params = new URLSearchParams(tempoFilters());
    try {
      const payload = await fetchJson(`${API_DATA}?${params.toString()}`, { signal: ac.signal });
      if (myId !== state.trendsFetchId) return;
      const pf = tempoFilters();
      state.tempoFetchDateFrom = pf.date_from || "";
      state.tempoFetchDateTo = pf.date_to || "";
      resetTempoWindowToFetchQuarter();
      payloads.tempo = payload;
      renderTempo(payload);
      if (canShareBoekingentrendsFetch()) {
        payloads.lead = payload;
        renderLead(payload);
      }
    } catch (e) {
      if (e?.name === "AbortError") return;
      throw e;
    } finally {
      if (myId === state.trendsFetchId && lockApplyBtn) els.tempo.apply?.removeAttribute("disabled");
    }
  };

  const loadLead = async () => {
    state._leadAbort?.abort();
    const myId = ++state.leadFetchId;
    const ac = new AbortController();
    state._leadAbort = ac;
    const params = new URLSearchParams(leadFilters());
    try {
      const payload = await fetchJson(`${API_DATA}?${params.toString()}`, { signal: ac.signal });
      if (myId !== state.leadFetchId) return;
      payloads.lead = payload;
      renderLead(payload);
    } catch (e) {
      if (e?.name === "AbortError") return;
      throw e;
    }
  };

  const setGranularity = (value) => {
    state.tempoGranularity = value;
    els.tempo.granularityDay?.classList.toggle("active", value === "day");
    els.tempo.granularityWeek?.classList.toggle("active", value === "week");
    els.tempo.granularityMonth?.classList.toggle("active", value === "month");
  };

  const applyDefaultDates = (fromIso, toIso) => {
    [els.tempo.dateFrom, els.lead.dateFrom].forEach((el) => {
      if (el && fromIso) el.value = fromIso;
    });
    [els.tempo.dateTo, els.lead.dateTo].forEach((el) => {
      if (el && toIso) el.value = toIso;
    });
  };

  const init = async () => {
    const options = await fetchJson(API_OPTIONS);
    const destOpts = buildDestOptions(options?.bestemmingen);
    const brandOpts = buildBrandOptions(options?.brands);
    fillSelect(els.tempo.destination, destOpts);
    fillSelect(els.heatmap.destination, destOpts);
    fillSelect(els.lead.destination, destOpts);
    fillSelect(els.tempo.brand, brandOpts);
    fillSelect(els.heatmap.brand, brandOpts);
    fillSelect(els.lead.brand, brandOpts);

    const fromIso = options?.default_date_from || "";
    const toIso = options?.default_date_to || "";
    applyDefaultDates(fromIso, toIso);

    /* Boekingstempo + voorloop: zelfde standaardperiode zodat één fetch beide panelen vult (canShare). */
    const rangeY = new Date().getFullYear();
    const rangeFrom = `${rangeY}-01-01`;
    const rangeTo = `${rangeY}-12-31`;
    if (els.tempo.dateFrom) els.tempo.dateFrom.value = rangeFrom;
    if (els.tempo.dateTo) els.tempo.dateTo.value = rangeTo;
    if (els.lead.dateFrom) els.lead.dateFrom.value = rangeFrom;
    if (els.lead.dateTo) els.lead.dateTo.value = rangeTo;

    setGranularity("day");
    if (IS_RESTRICTED_ROLE && els.heatmap.yearRight) {
      els.heatmap.yearRight.value = String(FORCED_PREVIOUS_YEAR);
      els.heatmap.yearRight.disabled = true;
    }

    if (els.heatmap.month) {
      fillSelect(
        els.heatmap.month,
        MONTHS_NL_FULL.map((label, i) => ({ value: String(i + 1), label })),
      );
      const now = new Date();
      els.heatmap.month.value = String(now.getMonth() + 1);
    }

    await Promise.all([loadHeatmap(), loadTrends({ lockApplyBtn: false })]);
    if (!canShareBoekingentrendsFetch()) {
      await loadLead();
    }
    captureDefaultsTempoLead();
  };

  const bindApply = (btn, loader) => {
    const run = () => {
      void (async () => {
        try {
          setError("");
          await loader();
        } catch (e) {
          setError(formatErrorMessage(e));
        }
      })();
    };
    btn?.addEventListener("click", (e) => {
      e.preventDefault();
      run();
    });
    btn?.closest("form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      run();
    });
  };

  bindApply(els.tempo.apply, loadTrends);
  bindApply(els.heatmap.apply, loadHeatmap);

  els.tempo.reset?.addEventListener("click", (e) => {
    e.preventDefault();
    void (async () => {
      try {
        setError("");
        applyTempoDefaults();
        await loadTrends();
      } catch (err) {
        setError(formatErrorMessage(err));
      }
    })();
  });

  els.lead.reset?.addEventListener("click", (e) => {
    e.preventDefault();
    void (async () => {
      try {
        setError("");
        applyLeadDefaults();
        await loadLead();
      } catch (err) {
        setError(formatErrorMessage(err));
      }
    })();
  });

  els.heatmap.reset?.addEventListener("click", (e) => {
    e.preventDefault();
    void (async () => {
      try {
        setError("");
        applyHeatmapDefaults();
        await loadHeatmap();
      } catch (err) {
        setError(formatErrorMessage(err));
      }
    })();
  });

  els.tempo.chartPrev?.addEventListener("click", (e) => {
    e.preventDefault();
    if (state.tempoGranularity !== "day" && state.tempoGranularity !== "week") return;
    if (!payloads.tempo || !canShiftTempoWindowByMonths(-3)) return;
    const ws = parseISODateLocal(state.tempoWindowStart);
    if (!ws) return;
    const nextWs = addMonthsLocal(ws, -3);
    if (!nextWs) return;
    const nextWe = quarterEndFromWindowStart(nextWs);
    if (!nextWe) return;
    state.tempoWindowStart = formatIsoLocal(nextWs);
    state.tempoWindowEnd = formatIsoLocal(nextWe);
    renderTempo(payloads.tempo);
  });
  els.tempo.chartNext?.addEventListener("click", (e) => {
    e.preventDefault();
    if (state.tempoGranularity !== "day" && state.tempoGranularity !== "week") return;
    if (!payloads.tempo || !canShiftTempoWindowByMonths(3)) return;
    const ws = parseISODateLocal(state.tempoWindowStart);
    if (!ws) return;
    const nextWs = addMonthsLocal(ws, 3);
    if (!nextWs) return;
    const nextWe = quarterEndFromWindowStart(nextWs);
    if (!nextWe) return;
    state.tempoWindowStart = formatIsoLocal(nextWs);
    state.tempoWindowEnd = formatIsoLocal(nextWe);
    renderTempo(payloads.tempo);
  });

  els.tempo.granularityDay?.addEventListener("click", async () => {
    try {
      setError("");
      setGranularity("day");
      await loadTrends();
    } catch (e) {
      setError(formatErrorMessage(e));
    }
  });

  els.tempo.granularityWeek?.addEventListener("click", async () => {
    try {
      setError("");
      setGranularity("week");
      await loadTrends();
    } catch (e) {
      setError(formatErrorMessage(e));
    }
  });

  els.tempo.granularityMonth?.addEventListener("click", async () => {
    try {
      setError("");
      setGranularity("month");
      await loadTrends();
    } catch (e) {
      setError(formatErrorMessage(e));
    }
  });

  els.heatmap.kpiSelect?.addEventListener("change", () => {
    if (payloads.heatmap) renderHeatmapComparison(payloads.heatmap);
  });

  bindApply(els.lead.apply, loadLead);

  init().catch((e) => setError(formatErrorMessage(e)));
})();
