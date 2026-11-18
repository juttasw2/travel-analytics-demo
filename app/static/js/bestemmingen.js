(() => {
  const root = document.getElementById("bppPage");
  if (!root) return;

  const API_OPT = "/bestemmingen/periodes-options";
  const API_DATA = "/bestemmingen/periodes-data";
  const nf = new Intl.NumberFormat("nl-NL");
  const nfIntPlain = new Intl.NumberFormat("nl-NL", { maximumFractionDigits: 0 });
  const nfPctOne = new Intl.NumberFormat("nl-NL", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  const COL_ORANGE = "#ea580c";
  const COL_GRID = "#e8ecf4";
  const COL_MUTED = "#94a3b8";
  const countryColors = window.CountryColors || null;

  const WEEK_VIEWPORT = 17;
  const WEEK_STEP = 5;
  const WEEK_TOTAL = 52;
  /** Zichtbare dagen in de grafiek “Reizigers op reis per dag” (schuifvenster). */
  const BPP_TRIP_LINE_WINDOW = 45;
  /** Matrix: kolommen per scherm. */
  const BPP_MATRIX_WEEK_VIEWPORT = 20;
  /** Matrix: aantal weken verschuiving per klik. */
  const BPP_MATRIX_WEEK_STEP = 10;
  const BPP_MATRIX_WEEK_TOTAL = 52;
  const MONTH_ABBR_NL = ["jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];
  const MONTH_NAME_NL = [
    "januari",
    "februari",
    "maart",
    "april",
    "mei",
    "juni",
    "juli",
    "augustus",
    "september",
    "oktober",
    "november",
    "december",
  ];

  /** Maandag van de opgegeven ISO-week (week 1–52) in het ISO-jaar van de grafiek. */
  function mondayOfIsoWeek(isoYear, weekNum) {
    const jan4 = new Date(isoYear, 0, 4);
    const offset = (jan4.getDay() + 6) % 7;
    const w1 = new Date(jan4);
    w1.setDate(jan4.getDate() - offset);
    const mon = new Date(w1);
    mon.setDate(w1.getDate() + (weekNum - 1) * 7);
    return mon;
  }

  /** Maand (korte afkorting) van de maandag van die ISO-week. */
  function monthAbbrForIsoWeek(isoYear, weekNum) {
    return MONTH_ABBR_NL[mondayOfIsoWeek(isoYear, weekNum).getMonth()];
  }

  let weekViewStart = 0;

  const els = {
    err: document.getElementById("bppError"),
    dest: document.getElementById("bppDestination"),
    year: document.getElementById("bppYear"),
    dateFrom: document.getElementById("bppDateFrom"),
    dateTo: document.getElementById("bppDateTo"),
    brand: document.getElementById("bppBrand"),
    country: document.getElementById("bppCountry"),
    brandLand: document.getElementById("bppBrandLand"),
    apply: document.getElementById("bppApply"),
    reset: document.getElementById("bppReset"),
    loading: document.getElementById("bppLoading"),
    dash: document.getElementById("bppDashboard"),
    kpiRow: document.getElementById("bppKpiRow"),
  };

  function syncBppDateInputsFromYear() {
    const y = parseInt(els.year?.value, 10);
    if (!Number.isFinite(y)) return;
    if (els.dateFrom) {
      els.dateFrom.value = `${y}-01-01`;
      els.dateFrom.readOnly = true;
    }
    if (els.dateTo) {
      els.dateTo.value = `${y}-12-31`;
      els.dateTo.readOnly = true;
    }
  }

  /** Top 3 bestemmingen per dag (verblijfslogica); komt mee uit API. */
  let bppTripTopDestByDay = /** @type {Record<string, Array<{ naam: string, pax: number, pct: number }>>} */ ({});
  let bppMatrixCellDetailsDest = /** @type {Record<string, Record<string, unknown>>} */ ({});
  let bppMatrixCellDetailsAcc = /** @type {Record<string, Record<string, unknown>>} */ ({});
  let bppDestDeltaRows = /** @type {Record<string, unknown>[]} */ ([]);
  let bppJjasRows = /** @type {Record<string, unknown>[]} */ ([]);
  let bppTransportRows = /** @type {Record<string, unknown>[]} */ ([]);
  let bppHolidayRows = /** @type {Record<string, unknown>[]} */ ([]);
  let bppDepartureSortRows = /** @type {Record<string, unknown>[]} */ ([]);

  const charts = {};
  /** @type {InstanceType<typeof window.TAMultiSelectFilter> | null} */
  let bppDestMulti = null;

  function selectedDestinations() {
    if (bppDestMulti) return bppDestMulti.getValue();
    const v = els.dest?.value || "__all__";
    return v && v !== "__all__" ? [v] : [];
  }

  function primaryDestinationValue() {
    const values = selectedDestinations();
    return values.length ? values[0] : "__all__";
  }

  // Vertrekdatum-detail: lokale filters (alleen tabel; geen invloed op andere visuals)
  const depEls = {
    dateFrom: document.getElementById("bppDepartDateFrom"),
    dateTo: document.getElementById("bppDepartDateTo"),
    destination: document.getElementById("bppDepartDestination"),
  };
  let bppDepartureBaseRows = null;
  let bppDepartureBaseRowsDestVal = null;
  let bppDepartureFetchToken = 0;
  let bppDepartureLocalFiltersBound = false;

  // Caching-proof: verwijder legacy "Tijdsdimensie" / "Periode" filtervelden als ze nog in de HTML zitten.
  // (Deze velden bestaan niet meer in de template, maar als een oude pagina-versie open stond helpen we zo alsnog.)
  function bppRemoveLegacyTimeDimAndPeriodFilters() {
    function removeControlById(id) {
      const el = document.getElementById(id);
      if (!el) return;
      const ctrl = el.closest(".vg-control") || el.parentElement;
      if (ctrl) ctrl.remove();
      else el.remove();
    }
    removeControlById("bppTimeDim");
    removeControlById("bppPeriodGranularity");
  }
  bppRemoveLegacyTimeDimAndPeriodFilters();

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

  function tripHeatColor(intensity) {
    const i = Math.max(0, Math.min(1, Number(intensity) || 0));
    if (i <= 0) return "#f1f3f5";
    if (i < 0.34) return "#ffedd5";
    if (i < 0.67) return "#fdba74";
    return "#ea580c";
  }

  const BPP_CAL_WEEKDAYS = ["Ma", "Di", "Wo", "Do", "Vr", "Za", "Zo"];
  const bppLongDateNl = new Intl.DateTimeFormat("nl-NL", { day: "numeric", month: "long", year: "numeric" });
  const bppMonthYearNl = new Intl.DateTimeFormat("nl-NL", { month: "long", year: "numeric" });
  const bppMonthOnlyNl = new Intl.DateTimeFormat("nl-NL", { month: "long" });
  const bppTripAxisDateNl = new Intl.DateTimeFormat("nl-NL", { day: "numeric", month: "short" });

  function capitalizeNl(s) {
    if (!s) return s;
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function monthLabelNlShortFromIndex(idxZero) {
    return capitalizeNl(MONTH_ABBR_NL[Math.max(0, Math.min(11, Number(idxZero) || 0))] || "");
  }

  function monthLabelNlLongFromIndex(idxOneBased) {
    return capitalizeNl(MONTH_NAME_NL[Math.max(1, Math.min(12, Number(idxOneBased) || 1)) - 1] || "");
  }

  /** Volledige maandnaam (nl) voor de maand waarin de maandag van die ISO-week valt. */
  function monthLongNlForIsoWeek(isoYear, weekNum) {
    return capitalizeNl(bppMonthOnlyNl.format(mondayOfIsoWeek(isoYear, weekNum)));
  }

  function bppEscapeAttr(s) {
    return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }

  function bppEscapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /** Intensiteit [0,1]: 0 = geen pax, 1 = maximum in het geselecteerde jaar (voor schaal). */
  function tripCalCellColors(t) {
    const i = Math.max(0, Math.min(1, Number(t) || 0));
    if (i <= 0) {
      return { bg: "#f1f5f9", border: "#e2e8f0", fg: "#64748b" };
    }
    const light = { r: 255, g: 237, b: 213 };
    const mid = { r: 253, g: 186, b: 116 };
    const dark = { r: 234, g: 88, b: 12 };
    let r;
    let g;
    let b;
    if (i < 0.5) {
      const u = i / 0.5;
      r = Math.round(light.r + (mid.r - light.r) * u);
      g = Math.round(light.g + (mid.g - light.g) * u);
      b = Math.round(light.b + (mid.b - light.b) * u);
    } else {
      const u = (i - 0.5) / 0.5;
      r = Math.round(mid.r + (dark.r - mid.r) * u);
      g = Math.round(mid.g + (dark.g - mid.g) * u);
      b = Math.round(mid.b + (dark.b - mid.b) * u);
    }
    const fg = i > 0.55 ? "#ffffff" : "#1e293b";
    const border = i > 0.35 ? `rgba(234, 88, 12, ${0.22 + 0.4 * i})` : "#e2e8f0";
    return { bg: `rgb(${r},${g},${b})`, border, fg };
  }

  function positionBppCalTooltip(tooltipEl, anchorEl) {
    if (!tooltipEl || !anchorEl) return;
    const pad = 8;
    const r = anchorEl.getBoundingClientRect();
    tooltipEl.style.left = "0";
    tooltipEl.style.top = "0";
    const tw = tooltipEl.offsetWidth;
    const th = tooltipEl.offsetHeight;
    let left = r.left + r.width / 2 - tw / 2;
    let top = r.bottom + pad;
    left = Math.max(pad, Math.min(left, window.innerWidth - tw - pad));
    if (top + th > window.innerHeight - pad) top = r.top - th - pad;
    if (top < pad) top = pad;
    tooltipEl.style.left = `${Math.round(left)}px`;
    tooltipEl.style.top = `${Math.round(top)}px`;
  }

  let bppTripCalTooltipTimer = null;
  let bppTripCalTooltipSetup = false;

  /** Eerste maand van het zichtbare paar (0–10); toont maand m en m+1 binnen het filterjaar. */
  let bppTripCalStartMonth = 0;
  let bppTripCalYear = null;
  let bppTripCalSeries = null;
  let bppTripCalMaxV = 1;

  function setupBppTripCalTooltip() {
    if (bppTripCalTooltipSetup) return;
    const root = document.getElementById("bppTripHeatmap");
    const tooltip = document.getElementById("bppTripHeatmapTooltip");
    if (!root || !tooltip) return;
    bppTripCalTooltipSetup = true;

    function hide() {
      bppTripCalTooltipTimer = window.setTimeout(() => {
        tooltip.hidden = true;
        tooltip.classList.remove("bpp-cal-tooltip--visible");
        tooltip.innerHTML = "";
      }, 120);
    }

    function show(btn) {
      window.clearTimeout(bppTripCalTooltipTimer);
      const iso = btn.dataset.iso;
      const pax = Number(btn.dataset.pax) || 0;
      const d = new Date(`${iso}T12:00:00`);
      if (Number.isNaN(d.getTime())) return;
      const line1 = capitalizeNl(bppLongDateNl.format(d));
      tooltip.innerHTML = `<div class="bpp-cal-tooltip__date">${line1}</div><div class="bpp-cal-tooltip__pax"><strong>${nf.format(
        pax,
      )}</strong> reizigers op bestemming</div>`;
      tooltip.hidden = false;
      requestAnimationFrame(() => {
        tooltip.classList.add("bpp-cal-tooltip--visible");
        positionBppCalTooltip(tooltip, btn);
      });
    }

    root.addEventListener(
      "pointerover",
      (e) => {
        const btn = e.target.closest(".bpp-cal-day:not(.bpp-cal-day--empty)");
        if (!btn || !root.contains(btn)) return;
        show(btn);
      },
      true,
    );
    root.addEventListener(
      "pointermove",
      (e) => {
        const btn = e.target.closest(".bpp-cal-day:not(.bpp-cal-day--empty)");
        if (!btn || !root.contains(btn) || tooltip.hidden) return;
        positionBppCalTooltip(tooltip, btn);
      },
      true,
    );
    root.addEventListener(
      "pointerout",
      (e) => {
        const btn = e.target.closest(".bpp-cal-day:not(.bpp-cal-day--empty)");
        if (!btn) return;
        const rel = e.relatedTarget;
        if (rel && btn.contains(rel)) return;
        hide();
      },
      true,
    );
    root.addEventListener("pointerleave", hide);
  }

  function destroyChart(key) {
    if (charts[key]) {
      charts[key].destroy();
      charts[key] = null;
    }
  }

  function buildBarChart(canvasId, labels, cur, prev, { title, yLabel } = {}) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    destroyChart(canvasId);
    const datasets = [
      { label: "Huidig jaar", data: cur, backgroundColor: "rgba(234, 88, 12, 0.75)", borderRadius: 4 },
    ];
    if (prev && prev.some((v) => v > 0)) {
      datasets.push({
        label: "Vorig jaar",
        data: prev,
        backgroundColor: "rgba(148, 163, 184, 0.55)",
        borderRadius: 4,
      });
    }
    charts[canvasId] = new Chart(canvas.getContext("2d"), {
      type: "bar",
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: "bottom" } },
        scales: {
          x: { grid: { display: false } },
          y: { beginAtZero: true, title: { display: !!yLabel, text: yLabel || "" }, grid: { color: COL_GRID } },
        },
      },
    });
  }

  function updateWeekNavUI() {
    const label = document.getElementById("bppWeekRangeLabel");
    const prev = document.getElementById("bppWeekPrev");
    const next = document.getElementById("bppWeekNext");
    const maxStart = WEEK_TOTAL - WEEK_VIEWPORT;
    const from = weekViewStart + 1;
    const to = Math.min(weekViewStart + WEEK_VIEWPORT, WEEK_TOTAL);
    if (label) label.textContent = `Week ${from}–${to} van ${WEEK_TOTAL}`;
    if (prev) prev.disabled = weekViewStart <= 0;
    if (next) next.disabled = weekViewStart >= maxStart;
  }

  function ensureWeekChartEmptyState() {
    const canvas = document.getElementById("bppChartWeek");
    const nav = document.querySelector(".bpp-week-chart-nav");
    if (!canvas || !nav) return null;
    const wrap = canvas.closest(".bpp-chart-wrap") || canvas.parentElement;
    if (!wrap) return null;
    let empty = document.getElementById("bppWeekChartEmpty");
    if (!empty) {
      empty = document.createElement("div");
      empty.id = "bppWeekChartEmpty";
      empty.className = "bpp-chart-empty d-none";
      empty.setAttribute("role", "status");
      wrap.insertAdjacentElement("afterend", empty);
    }
    return { canvas, nav, empty };
  }

  function setWeekChartEmptyState(message) {
    const refs = ensureWeekChartEmptyState();
    if (!refs) return;
    const { canvas, nav, empty } = refs;
    if (message) {
      canvas.classList.add("d-none");
      nav.classList.add("d-none");
      empty.textContent = message;
      empty.classList.remove("d-none");
    } else {
      canvas.classList.remove("d-none");
      nav.classList.remove("d-none");
      empty.textContent = "";
      empty.classList.add("d-none");
    }
  }

  function shiftWeekView(delta) {
    const ch = charts["bppChartWeek"];
    if (!ch) return;
    const maxStart = WEEK_TOTAL - WEEK_VIEWPORT;
    weekViewStart = Math.max(0, Math.min(maxStart, weekViewStart + delta));
    ch.options.scales.x.min = weekViewStart;
    ch.options.scales.x.max = weekViewStart + WEEK_VIEWPORT - 1;
    ch.update("none");
    updateWeekNavUI();
  }

  function buildWeekPaxChart(canvasId, labels, cur, prev, compare, isoYear) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    destroyChart(canvasId);
    const firstIdxCur = (cur || []).findIndex((v) => (Number(v) || 0) > 0);
    if (firstIdxCur < 0) {
      setWeekChartEmptyState("Geen vertrekweek-data met pax > 0 voor deze selectie.");
      updateWeekNavUI();
      return;
    }
    setWeekChartEmptyState(null);
    weekViewStart = Math.max(0, Math.min(firstIdxCur, WEEK_TOTAL - WEEK_VIEWPORT));
    const y = Number.isFinite(isoYear) ? isoYear : new Date().getFullYear();
    /** Chart.js: label als [regel1, regel2] = echte tweeregelige as (\\n in callback werkt niet betrouwbaar). */
    const chartLabels = (labels || []).map((raw, idx) => {
      const m = String(raw).match(/(\d+)/);
      const wNum = m ? parseInt(m[1], 10) : idx + 1;
      return [`W${wNum}`, monthAbbrForIsoWeek(y, wNum)];
    });
    const datasets = [
      { label: "Huidig jaar", data: cur, backgroundColor: "rgba(234, 88, 12, 0.75)", borderRadius: 4 },
    ];
    if (compare && Array.isArray(prev) && prev.length) {
      datasets.push({
        label: "Vorig jaar",
        data: prev,
        backgroundColor: "rgba(148, 163, 184, 0.55)",
        borderRadius: 4,
      });
    }
    charts[canvasId] = new Chart(canvas.getContext("2d"), {
      type: "bar",
      data: { labels: chartLabels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "bottom" },
          tooltip: {
            callbacks: {
              title: (items) => {
                const it = items[0];
                if (!it) return "";
                const w = it.dataIndex + 1;
                const mo = monthAbbrForIsoWeek(y, w);
                return `Week ${w} — ${mo}`;
              },
              label: (ctx) => {
                const v = ctx.parsed.y;
                return `${ctx.dataset.label}: ${nf.format(v ?? 0)}`;
              },
            },
          },
        },
        scales: {
          x: {
            type: "category",
            min: weekViewStart,
            max: weekViewStart + WEEK_VIEWPORT - 1,
            grid: { display: false },
            ticks: {
              autoSkip: false,
              maxRotation: 0,
              font: { size: 9, lineHeight: 1.15 },
            },
          },
          y: { beginAtZero: true, title: { display: true, text: "Pax" }, grid: { color: COL_GRID } },
        },
      },
    });
    updateWeekNavUI();
  }

  function buildLineChart(canvasId, labels, datasets) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    destroyChart(canvasId);
    charts[canvasId] = new Chart(canvas.getContext("2d"), {
      type: "line",
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { position: "bottom" } },
        scales: {
          y: { grid: { color: COL_GRID } },
          x: { grid: { display: false } },
        },
      },
    });
  }

  /** @typedef {{ date: string, pax: number }} BppTripDailyRow */

  /** Lokale kalenderdag op 12:00 (geen UTC-shift op YYYY-MM-DD). */
  function bppParseIsoLocal(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso).trim());
    if (!m) return null;
    const y = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    const d = parseInt(m[3], 10);
    const dt = new Date(y, mo - 1, d, 12, 0, 0);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
    return dt;
  }

  function bppToIsoLocal(dt) {
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  }

  /**
   * Volledige dagelijkse tijdreeks: elke dag in [startIso, endIso], pax uit API-heatmap (0 als geen key).
   * Server telt al vertrek ≤ dag ≤ terugkeer; hier alleen gaten dichten + locale datums.
   */
  function deriveDailyPaxDataset(tripByDay, startIso, endIso) {
    const lo = bppParseIsoLocal(startIso);
    const hi = bppParseIsoLocal(endIso);
    if (!lo || !hi) return [];
    let a = lo;
    let b = hi;
    if (a > b) [a, b] = [b, a];
    const src = tripByDay && typeof tripByDay === "object" ? tripByDay : {};
    /** @type {BppTripDailyRow[]} */
    const out = [];
    const cur = new Date(a.getFullYear(), a.getMonth(), a.getDate(), 12, 0, 0);
    const end = new Date(b.getFullYear(), b.getMonth(), b.getDate(), 12, 0, 0);
    while (cur <= end) {
      const iso = bppToIsoLocal(cur);
      out.push({ date: iso, pax: Number(src[iso]) || 0 });
      cur.setDate(cur.getDate() + 1);
    }
    return out;
  }

  function formatBppTripLineNavRange(firstIso, lastIso) {
    const a = bppParseIsoLocal(firstIso);
    const b = bppParseIsoLocal(lastIso);
    if (!a || !b) return "—";
    const sameYear = a.getFullYear() === b.getFullYear();
    const left = new Intl.DateTimeFormat("nl-NL", {
      day: "numeric",
      month: "short",
      ...(sameYear ? {} : { year: "numeric" }),
    }).format(a);
    const right = new Intl.DateTimeFormat("nl-NL", { day: "numeric", month: "short", year: "numeric" }).format(b);
    return `${capitalizeNl(left)} – ${capitalizeNl(right)}`;
  }

  /** Volledige reeks voor hetzelfde filterjaar / kalender als de pagina. */
  let bppTripLineDerivedDaily = [];
  /** Index in `bppTripLineDerivedDaily` waar het venster start. */
  let bppTripLineVisibleStart = 0;
  /** Slice waarnaar tooltip verwijst (sync met Chart.js data-index). */
  let bppTripLineVisibleSlice = [];

  /** Fallback bij oude HTML-cache zonder navigatieblok. */
  const BPP_TRIP_LINE_NAV_SNIPPET =
    '<div class="bpp-trip-line-nav" id="bppTripLineNav" role="navigation" aria-label="Periode in grafiek reizigers op reis">' +
    '<button type="button" class="bpp-cal-nav-btn bpp-trip-line-nav__btn" id="bppTripLinePrev" aria-label="Vorige periode">' +
    '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg></button>' +
    '<span class="bpp-trip-line-nav__label" id="bppTripLineNavLabel" aria-live="polite"></span>' +
    '<button type="button" class="bpp-cal-nav-btn bpp-trip-line-nav__btn" id="bppTripLineNext" aria-label="Volgende periode">' +
    '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg></button></div>';

  function ensureBppTripLineNavDom() {
    if (document.getElementById("bppTripLinePrev")) return;
    const panel = document.querySelector(".bpp-trip-line-panel");
    if (panel) {
      panel.insertAdjacentHTML("afterbegin", BPP_TRIP_LINE_NAV_SNIPPET);
      return;
    }
    const canvas = document.getElementById("bppChartTripLine");
    const wrap = canvas?.closest(".bpp-chart-wrap");
    if (canvas && wrap) {
      wrap.insertAdjacentHTML("beforebegin", BPP_TRIP_LINE_NAV_SNIPPET);
    }
  }

  function bindBppTripLineNav() {
    if (document.documentElement.dataset.bppTripLineNavGlob) return;
    document.documentElement.dataset.bppTripLineNavGlob = "1";
    document.addEventListener("click", (e) => {
      const isPrev = e.target.closest("#bppTripLinePrev");
      const isNext = e.target.closest("#bppTripLineNext");
      if (!isPrev && !isNext) return;
      const nLen = bppTripLineDerivedDaily.length;
      const maxStart = nLen > BPP_TRIP_LINE_WINDOW ? nLen - BPP_TRIP_LINE_WINDOW : 0;
      if (isPrev) {
        bppTripLineVisibleStart = Math.max(0, bppTripLineVisibleStart - BPP_TRIP_LINE_WINDOW);
        renderBppTripLineChart();
      } else if (isNext) {
        bppTripLineVisibleStart = Math.min(maxStart, bppTripLineVisibleStart + BPP_TRIP_LINE_WINDOW);
        renderBppTripLineChart();
      }
    });
  }

  function renderBppTripLineChart() {
    const canvas = document.getElementById("bppChartTripLine");
    const labelEl = document.getElementById("bppTripLineNavLabel");
    const prev = document.getElementById("bppTripLinePrev");
    const next = document.getElementById("bppTripLineNext");
    if (!canvas) return;

    const n = bppTripLineDerivedDaily.length;
    if (n === 0) {
      destroyChart("bppChartTripLine");
      bppTripLineVisibleSlice = [];
      if (labelEl) labelEl.textContent = "Geen dagen in deze periode. Controleer filter en jaar.";
      if (prev) prev.disabled = true;
      if (next) next.disabled = true;
      return;
    }

    const maxStart = n > BPP_TRIP_LINE_WINDOW ? n - BPP_TRIP_LINE_WINDOW : 0;
    bppTripLineVisibleStart = Math.max(0, Math.min(bppTripLineVisibleStart, maxStart));
    const win = Math.min(BPP_TRIP_LINE_WINDOW, n);
    bppTripLineVisibleSlice = bppTripLineDerivedDaily.slice(bppTripLineVisibleStart, bppTripLineVisibleStart + win);

    const first = bppTripLineVisibleSlice[0];
    const last = bppTripLineVisibleSlice[bppTripLineVisibleSlice.length - 1];
    if (labelEl && first && last) {
      labelEl.textContent = formatBppTripLineNavRange(first.date, last.date);
    }

    if (prev) prev.disabled = n <= BPP_TRIP_LINE_WINDOW || bppTripLineVisibleStart <= 0;
    if (next) next.disabled = n <= BPP_TRIP_LINE_WINDOW || bppTripLineVisibleStart >= maxStart;

    const labels = bppTripLineVisibleSlice.map((r) => r.date);
    const values = bppTripLineVisibleSlice.map((r) => r.pax);

    let ch = charts["bppChartTripLine"];
    const tripLineOptions = {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { position: "bottom" },
        tooltip: {
          callbacks: {
            title: (items) => {
              const it = items[0];
              if (!it) return "";
              const row = bppTripLineVisibleSlice[it.dataIndex];
              if (!row) return "";
              const d = new Date(`${row.date}T12:00:00`);
              return capitalizeNl(bppLongDateNl.format(d));
            },
            label: (ctx) => `${nf.format(ctx.parsed.y)} reizigers op bestemming`,
          },
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          title: { display: true, text: "Reizigers op bestemming" },
          grid: { color: COL_GRID },
        },
        x: {
          grid: { display: false },
          ticks: {
            maxRotation: 0,
            autoSkip: false,
            callback: function (_tickVal, index) {
              const labs = this.chart?.data?.labels || [];
              const len = labs.length;
              if (!len) return "";
              const step = len > 40 ? 7 : len > 24 ? 5 : len > 14 ? 3 : 1;
              if (index % step !== 0 && index !== len - 1) return "";
              const iso = String(labs[index] ?? "");
              const d = bppParseIsoLocal(iso);
              return d ? capitalizeNl(bppTripAxisDateNl.format(d)) : "";
            },
          },
        },
      },
    };

    if (!ch) {
      ch = new Chart(canvas.getContext("2d"), {
        type: "line",
        data: {
          labels,
          datasets: [
            {
              label: "Reizigers op reis",
              data: values,
              borderColor: COL_ORANGE,
              tension: 0.15,
              fill: true,
              backgroundColor: "rgba(234,88,12,0.12)",
              pointRadius: 0,
              pointHoverRadius: 5,
            },
          ],
        },
        options: tripLineOptions,
      });
      charts["bppChartTripLine"] = ch;
    } else {
      ch.data.labels = labels;
      ch.data.datasets[0].data = values;
      ch.update("none");
    }
  }

  /** Herbouw vanaf API-heatmap + actieve datumperiode (zelfde als filters op de pagina). */
  function initBppTripLineFromHeatmap(tripObj, year) {
    destroyChart("bppChartTripLine");
    const yNum = parseInt(String(year), 10);
    const yOk = Number.isFinite(yNum);
    let startIso = yOk ? `${yNum}-01-01` : `${new Date().getFullYear()}-01-01`;
    let endIso = yOk ? `${yNum}-12-31` : `${new Date().getFullYear()}-12-31`;
    const df = els.dateFrom?.value?.trim();
    const dt = els.dateTo?.value?.trim();
    if (df && /^\d{4}-\d{2}-\d{2}$/.test(df)) startIso = df;
    if (dt && /^\d{4}-\d{2}-\d{2}$/.test(dt)) endIso = dt;

    bppTripLineDerivedDaily = deriveDailyPaxDataset(tripObj, startIso, endIso);
    const firstWithData = bppTripLineDerivedDaily.findIndex((r) => Number(r.pax) > 0);
    bppTripLineVisibleStart =
      firstWithData >= 0 ? Math.max(0, firstWithData - Math.floor(BPP_TRIP_LINE_WINDOW / 6)) : 0;
    ensureBppTripLineNavDom();
    bindBppTripLineNav();
    renderBppTripLineChart();
  }

  function buildDoughnut(canvasId, labels, values) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    destroyChart(canvasId);
    charts[canvasId] = new Chart(canvas.getContext("2d"), {
      type: "doughnut",
      data: {
        labels,
        datasets: [
          {
            data: values,
            backgroundColor: ["#ea580c", "#64748b", "#0ea5e9", "#a78bfa", "#cbd5e1"],
          },
        ],
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" } } },
    });
  }

  function buildHorizontalBar(canvasId, items, showYAxisLabels = true) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    destroyChart(canvasId);
    const labels = items.map((x) => String(x.vertrekdatum || ""));
    const data = items.map((x) => x.pax);
    const fmtExactDate = (iso) => {
      const raw = String(iso || "");
      return (window.TADate && window.TADate.formatDate && window.TADate.formatDate(raw, raw)) || raw;
    };
    charts[canvasId] = new Chart(canvas.getContext("2d"), {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            label: "Pax",
            data,
            backgroundColor: "rgba(234, 88, 12, 0.78)",
            borderRadius: 4,
            categoryPercentage: 0.62,
            barPercentage: 0.9,
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
                const raw = items?.[0]?.label || "";
                return `Vertrek: ${fmtExactDate(raw)}`;
              },
              label(ctx) {
                return `Pax: ${nf.format(Number(ctx.parsed.x) || 0)}`;
              },
            },
          },
        },
        scales: {
          x: { beginAtZero: true, grid: { color: COL_GRID } },
          y: {
            grid: { display: false },
            ticks: {
              display: !!showYAxisLabels,
              callback(value) {
                const raw = this.getLabelForValue(Number(value));
                return fmtExactDate(raw);
              },
            },
          },
        },
      },
    });
  }

  function bppDeltaArrow(d) {
    if (d > 0) return "▲ ";
    if (d < 0) return "▼ ";
    return "► ";
  }

  function bppDeltaClass(d) {
    const SP = globalThis.SemanticPerformance;
    if (SP) {
      if (d > 0) return "sp-text--pos";
      if (d < 0) return "sp-text--neg";
      return "sp-text--neutral";
    }
    if (d > 0) return "vg-delta-up";
    if (d < 0) return "vg-delta-down";
    return "vg-delta-neutral";
  }

  function bppFormatSignedInt(d) {
    const n = Math.round(Number(d || 0));
    const sign = n > 0 ? "+" : "";
    return `${sign}${nf.format(n)}`;
  }

  /** Δ % t.o.v. vorig jaar (pax); bij baseline 0 → — */
  function bppFormatDeltaPct(deltaPct, basePax) {
    if (basePax === 0 || deltaPct == null || Number.isNaN(Number(deltaPct))) return "—";
    const p = Number(deltaPct);
    const sign = p > 0 ? "+" : "";
    return `${sign}${nfPctOne.format(p)}%`;
  }

  function renderDestinationDeltaBodyFromRows(list) {
    const body = document.getElementById("bppDestinationDeltaBody");
    if (!body) return;
    body.innerHTML = "";
    list.forEach((row) => {
      const cur = Number(row.current_pax || 0);
      const prev = Number(row.previous_pax || 0);
      const cb = Number(row.current_bookings ?? 0);
      const delta = cur - prev;
      const deltaPct = prev > 0 ? (delta / prev) * 100 : null;
      const pctStr = bppFormatDeltaPct(deltaPct, prev);
      const label = row.bestemming || "—";
      const pctCls = pctStr === "—" ? (globalThis.SemanticPerformance ? "sp-text--neutral" : "vg-delta-neutral") : bppDeltaClass(delta);
      const pctHtml = pctStr === "—" ? "—" : `${bppDeltaArrow(delta)}${pctStr}`;
      body.insertAdjacentHTML(
        "beforeend",
        `<tr>
          <td class="vg-col-text">${label}</td>
          <td class="text-end vg-num">${nf.format(Math.round(cb))}</td>
          <td class="text-end vg-num">${nf.format(Math.round(cur))}</td>
          <td class="text-end vg-num"><span class="${bppDeltaClass(delta)}">${bppDeltaArrow(delta)}${bppFormatSignedInt(delta)}</span></td>
          <td class="text-end vg-num"><span class="${pctCls}">${pctHtml}</span></td>
        </tr>`,
      );
    });
  }

  function renderDestinationDelta(rows, year, compareEnabled) {
    const head = document.getElementById("bppDestinationDeltaHead");
    const body = document.getElementById("bppDestinationDeltaBody");
    const empty = document.getElementById("bppDestinationDeltaEmpty");
    const tbl = document.getElementById("bppDestinationDeltaTable");
    const wire = typeof globalThis.TA_wireSortableTable === "function" ? globalThis.TA_wireSortableTable : null;
    if (!head || !body) return;
    const y1 = Number(year);
    const y1Ok = Number.isFinite(y1);
    const y2 = y1Ok ? y1 - 1 : null;
    head.innerHTML = `<tr>
      <th scope="col" class="vg-col-text" data-sort="bestemming" data-sort-type="text">Bestemming</th>
      <th scope="col" class="text-end text-nowrap" data-sort="current_bookings" data-sort-type="number">Aantal boekingen</th>
      <th scope="col" class="text-end text-nowrap" data-sort="current_pax" data-sort-type="number">Pax ${y1Ok ? y1 : "—"}</th>
      <th scope="col" class="text-end text-nowrap" data-sort="delta" data-sort-type="number">Δ pax</th>
      <th scope="col" class="text-end text-nowrap" data-sort="delta_pct" data-sort-type="number">Δ %</th>
    </tr>`;
    body.innerHTML = "";
    const list = Array.isArray(rows) ? rows : [];
    if (!compareEnabled) {
      bppDestDeltaRows = [];
      if (empty) {
        empty.textContent = "Geen vergelijking met vorig jaar voor deze weergave.";
        empty.classList.remove("d-none");
      }
      return;
    }
    if (!list.length) {
      bppDestDeltaRows = [];
      if (empty) {
        empty.textContent = "Geen gegevens beschikbaar voor deze selectie.";
        empty.classList.remove("d-none");
      }
      return;
    }
    if (empty) empty.classList.add("d-none");
    bppDestDeltaRows = list.map((row) => {
      const cur = Number(row.current_pax || 0);
      const prev = Number(row.previous_pax || 0);
      const cb = Number(row.current_bookings ?? 0);
      const delta = cur - prev;
      const deltaPct = prev > 0 ? (delta / prev) * 100 : null;
      return {
        bestemming: row.bestemming || "—",
        current_bookings: cb,
        current_pax: cur,
        previous_pax: prev,
        delta,
        delta_pct: deltaPct == null || Number.isNaN(Number(deltaPct)) ? -1e15 : Number(deltaPct),
      };
    });
    renderDestinationDeltaBodyFromRows(bppDestDeltaRows);
    if (tbl && wire && bppDestDeltaRows.length) {
      wire(
        tbl,
        () => bppDestDeltaRows.map((r) => ({ ...r })),
        (sorted) => {
          bppDestDeltaRows = sorted;
          renderDestinationDeltaBodyFromRows(sorted);
        },
      );
    }
  }

  function renderKpis(kpis, compare) {
    if (!els.kpiRow) return;
    const hasDestinationFilter = selectedDestinations().length > 0;
    const topDimension = hasDestinationFilter ? kpis.top_accommodatie : kpis.top_bestemming;
    const topDimensionTitle = hasDestinationFilter ? "Top accommodatie" : "Top bestemming";

    const cards = [
      {
        cardClass: "bpp-kpi-card--total-pax",
        bodyClass: "bpp-kpi-card__body--total-pax",
        t: "Totaal pax (vertrekfilters)",
        v: nf.format(kpis.total_pax || 0),
        sub: (() => {
          if (!compare) return "";
          if (kpis.delta_pct == null) return "Vgl. vorig jaar: n.v.t.";
          const pct = `${kpis.delta_pct >= 0 ? "+" : ""}${kpis.delta_pct}%`;
          const pax = `${kpis.delta_pax >= 0 ? "+" : ""}${nf.format(kpis.delta_pax || 0)} pax`;
          return `Vgl. vorig jaar: ${pct} (${pax})`;
        })(),
      },
      {
        t: "Gem. pax / boeking",
        v: String(kpis.avg_pax_per_booking ?? "—").replace(".", ","),
        sub: `${nf.format(kpis.bookings || 0)} boekingen`,
      },
      {
        t: topDimensionTitle,
        v: topDimension?.naam || "—",
        sub: (() => {
          const d = topDimension;
          if (!d || d.naam === "—" || !d.naam) return "";
          const pct = d.aandeel_pct != null ? d.aandeel_pct : "—";
          return `${pct}% van totaal pax (${nf.format(d.pax || 0)} pax)`;
        })(),
      },
      {
        t: "Landmix (pax %)",
        vHtml: `<span class="country-swatch country-swatch--be" aria-hidden="true"></span>BE ${kpis.country_share_pct?.BE ?? 0}%`,
        subHtml: `<span class="country-swatch country-swatch--nl" aria-hidden="true"></span>NL ${kpis.country_share_pct?.NL ?? 0}% · <span class="country-swatch country-swatch--other" aria-hidden="true"></span>Overig ${kpis.country_share_pct?.OTHER ?? 0}%`,
      },
    ];
    els.kpiRow.innerHTML = cards
      .map(
        (c) => `
      <div class="card border-0 shadow-sm h-100 bpp-kpi-card ${c.cardClass || ""}">
        <div class="card-body bpp-kpi-card__body ${c.bodyClass || ""} d-flex flex-column py-3 px-3">
          <div class="small text-muted">${c.t}</div>
          <div class="h5 mb-0 text-dark mt-auto">${c.vHtml != null ? c.vHtml : c.v}</div>
          ${c.subHtml ? `<div class="small text-muted mt-1">${c.subHtml}</div>` : c.sub ? `<div class="small text-muted mt-1">${c.sub}</div>` : ""}
        </div>
      </div>`,
      )
      .join("");
  }

  function renderJJASBodyFromRows(list) {
    const tb = document.getElementById("bppTableJJAS");
    if (!tb) return;
    const tbody = tb.querySelector("tbody");
    if (!tbody) return;
    tbody.innerHTML = (list || [])
      .map((r) => {
        const d = Number(r.delta ?? 0);
        const dPct = r.delta_pct != null ? Number(r.delta_pct) : null;
        const clsDelta = r.delta != null ? bppDeltaClass(d) : (globalThis.SemanticPerformance ? "sp-text--neutral" : "vg-delta-neutral");
        const clsPct =
          dPct == null ? (globalThis.SemanticPerformance ? "sp-text--neutral" : "vg-delta-neutral") : bppDeltaClass(dPct);
        const deltaHtml =
          r.delta != null ? `${bppDeltaArrow(d)}${bppFormatSignedInt(d)}` : "—";
        const pctHtml =
          dPct != null ? `${bppDeltaArrow(dPct)}${dPct > 0 ? "+" : ""}${nfPctOne.format(dPct)}%` : "—";
        return `<tr>
        <td class="vg-col-text">${r.label}</td>
        <td class="text-end vg-num">${nf.format(r.pax_current)}</td>
        <td class="text-end vg-num">${r.pax_previous != null ? nf.format(r.pax_previous) : "—"}</td>
        <td class="text-end vg-num"><span class="${clsDelta}">${deltaHtml}</span></td>
        <td class="text-end vg-num"><span class="${clsPct}">${pctHtml}</span></td>
        <td class="text-end vg-num">${r.season_share_pct}%</td>
      </tr>`;
      })
      .join("");
  }

  function renderJJAS(rows) {
    const tb = document.getElementById("bppTableJJAS");
    const wire = typeof globalThis.TA_wireSortableTable === "function" ? globalThis.TA_wireSortableTable : null;
    if (!tb) return;
    const list = Array.isArray(rows) ? rows : [];
    bppJjasRows = list.map((r) => ({
      label: Number.isFinite(Number(r.month)) ? monthLabelNlLongFromIndex(Number(r.month)) : r.label || "—",
      pax_current: Number(r.pax_current) || 0,
      pax_previous: r.pax_previous != null ? Number(r.pax_previous) : null,
      delta: r.delta != null ? Number(r.delta) : null,
      delta_pct: r.delta_pct != null ? Number(r.delta_pct) : null,
      season_share_pct: Number(r.season_share_pct) || 0,
    }));
    tb.innerHTML = `<thead class="table-light"><tr>
      <th scope="col" class="vg-col-text" data-sort="label" data-sort-type="text">Maand</th>
      <th scope="col" class="text-end text-nowrap" data-sort="pax_current" data-sort-type="number">Pax jaar</th>
      <th scope="col" class="text-end text-nowrap" data-sort="pax_previous" data-sort-type="number">Pax vorig</th>
      <th scope="col" class="text-end text-nowrap" data-sort="delta" data-sort-type="number">Δ</th>
      <th scope="col" class="text-end text-nowrap" data-sort="delta_pct" data-sort-type="number">Δ %</th>
      <th scope="col" class="text-end text-nowrap" data-sort="season_share_pct" data-sort-type="number">Aandeel seizoen</th>
    </tr></thead><tbody></tbody>`;
    renderJJASBodyFromRows(bppJjasRows);
    if (wire && bppJjasRows.length) {
      wire(
        tb,
        () => bppJjasRows.map((r) => ({ ...r })),
        (sorted) => {
          bppJjasRows = sorted;
          renderJJASBodyFromRows(sorted);
        },
      );
    }
  }

  function setCountryShiftEmpty(message) {
    const el = document.getElementById("bppCountryShiftEmpty");
    if (!el) return;
    if (message) {
      el.textContent = message;
      el.classList.remove("d-none");
      destroyChart("bppChartCountryShift");
    } else {
      el.textContent = "";
      el.classList.add("d-none");
    }
  }

  function renderCountryShift(rows, compareEnabled) {
    if (!compareEnabled) {
      setCountryShiftEmpty("Geen vergelijking met vorig jaar voor deze weergave.");
      return;
    }
    if (!rows || !rows.length) {
      setCountryShiftEmpty("Geen data beschikbaar voor deze selectie.");
      return;
    }
    setCountryShiftEmpty(null);
    const labels = rows.map((r, idx) => {
      if (Number.isFinite(Number(r.month))) return monthLabelNlLongFromIndex(Number(r.month));
      return monthLabelNlLongFromIndex(idx + 1);
    });
    const C = window.CountryChartColors;
    const be = C && C.BE ? C.BE : "#c2410c";
    const nl = C && C.NL ? C.NL : "#fdba74";
    const oth = C && C.OTHER ? C.OTHER : "#64748b";
    buildLineChart("bppChartCountryShift", labels, [
      {
        label: "BE (p.p.)",
        data: rows.map((r) => r.BE_pp),
        borderColor: countryColors?.tokens?.BE || be,
        backgroundColor: countryColors?.tokens?.BE || be,
        pointBackgroundColor: countryColors?.tokens?.BE || be,
        borderWidth: 2.5,
        pointRadius: 2,
        tension: 0.2,
        fill: false,
      },
      {
        label: "NL (p.p.)",
        data: rows.map((r) => r.NL_pp),
        borderColor: countryColors?.tokens?.NL || nl,
        backgroundColor: countryColors?.tokens?.NL || nl,
        pointBackgroundColor: countryColors?.tokens?.NL || nl,
        borderWidth: 2.5,
        pointRadius: 2,
        tension: 0.2,
        fill: false,
      },
      {
        label: "Overig (p.p.)",
        data: rows.map((r) => Number(r.OTHER_pp || 0) + Number(r.IT_pp || 0)),
        borderColor: oth,
        backgroundColor: oth,
        pointBackgroundColor: oth,
        borderWidth: 2,
        pointRadius: 2,
        tension: 0.2,
        fill: false,
      },
    ]);
  }

  function renderTransportBodyFromRows(list, compare) {
    const tb = document.getElementById("bppTableTransport");
    if (!tb) return;
    const tbody = tb.querySelector("tbody");
    if (!tbody) return;
    tbody.innerHTML = (list || [])
      .map((r) => {
        const p = r.pct_share != null ? r.pct_share : 0;
        return `<tr>
            <td class="vg-col-text">${bppEscapeHtml(r.type || "—")}</td>
            <td class="text-end vg-num">${nf.format(r.pax)}</td>
            <td class="text-end vg-num">${p}%</td>
            ${
              compare
                ? `<td class="text-end vg-num">${r.prev != null ? nf.format(r.prev) : "—"}</td>
                   <td class="text-end vg-num">${r.delta != null ? nf.format(r.delta) : "—"}</td>`
                : ""
            }
          </tr>`;
      })
      .join("");
  }

  function renderTransport(labels, cur, prev, compare) {
    const normalizeTransportLabel = (raw) => {
      const t = String(raw || "").trim().toLowerCase();
      if (t === "vliegtuig" || t === "flight" || t === "plane") return "vliegtuig";
      if (t === "bus" || t === "coach" || t === "autocar") return "bus";
      if (t === "self" || t === "eigen vervoer" || t === "own transport" || t === "own") return "self";
      console.warn("[bpp] Onverwacht transportlabel uit API, gemapt naar self:", raw);
      return "self";
    };
    const apiLabels = (labels || []).map((l) => normalizeTransportLabel(l));
    const sums = { vliegtuig: 0, bus: 0, self: 0 };
    apiLabels.forEach((label, i) => {
      sums[label] += Number(cur[i]) || 0;
    });
    const orderedKeys = ["vliegtuig", "bus", "self"];
    const pretty = { vliegtuig: "Vliegtuig", bus: "Bus", self: "Self" };
    const normalizedLabels = orderedKeys.map((k) => pretty[k]);
    const normalizedCur = orderedKeys.map((k) => sums[k]);
    const prevSums = { vliegtuig: 0, bus: 0, self: 0 };
    if (Array.isArray(prev)) {
      apiLabels.forEach((label, i) => {
        prevSums[label] += Number(prev[i]) || 0;
      });
    }
    if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
      const uniqApi = Array.from(new Set((labels || []).map((x) => String(x || ""))));
      console.debug("[bpp] transport_split unique labels from API:", uniqApi);
      console.debug("[bpp] transport_split normalized chart data:", {
        labels: normalizedLabels,
        current: normalizedCur,
        previous: orderedKeys.map((k) => prevSums[k]),
      });
    }
    buildDoughnut("bppChartTransport", normalizedLabels, normalizedCur);
    const tb = document.getElementById("bppTableTransport");
    const wire = typeof globalThis.TA_wireSortableTable === "function" ? globalThis.TA_wireSortableTable : null;
    if (!tb) return;
    const normalizedPrev = orderedKeys.map((k) => prevSums[k]);
    const tot = normalizedCur.reduce((a, b) => a + b, 0);
    bppTransportRows = normalizedLabels.map((lab, i) => {
      const pax = Number(normalizedCur[i]) || 0;
      const pct = tot ? Math.round((pax / tot) * 1000) / 10 : 0;
      const prv = prev ? normalizedPrev[i] : null;
      const dlt = prv != null ? pax - prv : null;
      return {
        type: lab || "—",
        pax,
        pct_share: pct,
        prev: prv != null ? Number(prv) : null,
        delta: dlt,
      };
    });
    const headCompare = compare
      ? '<th scope="col" class="text-end text-nowrap" data-sort="prev" data-sort-type="number">Vorig</th><th scope="col" class="text-end text-nowrap" data-sort="delta" data-sort-type="number">Δ</th>'
      : "";
    tb.innerHTML = `<thead class="table-light"><tr>
      <th scope="col" class="vg-col-text" data-sort="type" data-sort-type="text">Vervoertype</th>
      <th scope="col" class="text-end text-nowrap" data-sort="pax" data-sort-type="number">Pax</th>
      <th scope="col" class="text-end text-nowrap" data-sort="pct_share" data-sort-type="number">%</th>
      ${headCompare}
    </tr></thead><tbody></tbody>`;
    renderTransportBodyFromRows(bppTransportRows, compare);
    if (wire && bppTransportRows.length) {
      wire(
        tb,
        () => bppTransportRows.map((r) => ({ ...r })),
        (sorted) => {
          bppTransportRows = sorted;
          renderTransportBodyFromRows(sorted, compare);
        },
      );
    }
  }

  function buildTripCalMonthHtml(y, m, data, maxV, topDestMap) {
    const dim = new Date(y, m + 1, 0).getDate();
    const offset = (new Date(y, m, 1).getDay() + 6) % 7;
    const title = capitalizeNl(bppMonthYearNl.format(new Date(y, m, 1)));
    const weekdays = BPP_CAL_WEEKDAYS.map((w) => `<div>${w}</div>`).join("");
    let gridHtml = "";
    for (let i = 0; i < offset; i += 1) {
      gridHtml += '<div class="bpp-cal-day bpp-cal-day--empty" aria-hidden="true"></div>';
    }
    for (let d = 1; d <= dim; d += 1) {
      const iso = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const v = Number(data[iso]) || 0;
      const t = v / maxV;
      const { bg, border, fg } = tripCalCellColors(t);
      const dayDate = new Date(`${iso}T12:00:00`);
      const ariaDate = capitalizeNl(bppLongDateNl.format(dayDate));
      const ariaLabel = `${nf.format(v)} reizigers op bestemming, ${ariaDate}`;
      gridHtml += `<button type="button" class="bpp-cal-day bpp-cal-day--hit" style="background-color:${bg};border-color:${border};color:${fg}" data-iso="${iso}" data-pax="${String(
        v,
      )}" data-top3="${bppEscapeAttr(JSON.stringify((topDestMap && topDestMap[iso]) || []))}" aria-label="${bppEscapeAttr(ariaLabel)}" tabindex="0">${d}</button>`;
    }
    return `<section class="bpp-cal-month" aria-label="${bppEscapeAttr(title)}"><h3 class="bpp-cal-month__title">${title}</h3><div class="bpp-cal-weekdays" aria-hidden="true">${weekdays}</div><div class="bpp-cal-grid">${gridHtml}</div></section>`;
  }

  /** Fallback als een oude HTML-cache geen navigatieblok heeft; IDs moeten gelijk blijven aan de template. */
  const BPP_TRIP_CAL_NAV_SNIPPET = `<div class="bpp-cal-heatmap__nav" role="navigation" aria-label="Maanden kalender"><button type="button" class="bpp-cal-nav-btn" id="bppTripCalPrev" aria-label="Eén maand eerder"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg></button><span class="bpp-cal-heatmap__nav-label" id="bppTripCalNavLabel" aria-live="polite"></span><button type="button" class="bpp-cal-nav-btn" id="bppTripCalNext" aria-label="Eén maand later"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg></button></div>`;

  function ensureBppTripCalNavDom() {
    const monthsEl = document.getElementById("bppTripHeatmapMonths");
    if (!monthsEl || document.getElementById("bppTripCalPrev")) return;
    monthsEl.insertAdjacentHTML("beforebegin", BPP_TRIP_CAL_NAV_SNIPPET);
  }

  function bindBppTripCalNav() {
    const root = document.getElementById("bppTripHeatmap");
    if (!root || root.dataset.bppTripCalNavDeleg) return;
    root.dataset.bppTripCalNavDeleg = "1";
    root.addEventListener("click", (e) => {
      const prevBtn = e.target.closest("#bppTripCalPrev");
      const nextBtn = e.target.closest("#bppTripCalNext");
      if (prevBtn && !prevBtn.disabled && bppTripCalStartMonth > 0) {
        bppTripCalStartMonth -= 1;
        renderTripHeatmapViewport();
      } else if (nextBtn && !nextBtn.disabled && bppTripCalStartMonth < 10) {
        bppTripCalStartMonth += 1;
        renderTripHeatmapViewport();
      }
    });
  }

  function renderTripHeatmapViewport() {
    const monthsEl = document.getElementById("bppTripHeatmapMonths");
    const labelEl = document.getElementById("bppTripCalNavLabel");
    const prev = document.getElementById("bppTripCalPrev");
    const next = document.getElementById("bppTripCalNext");
    if (!monthsEl || bppTripCalYear == null || !Number.isFinite(bppTripCalYear)) return;
    const y = bppTripCalYear;
    const data = bppTripCalSeries && typeof bppTripCalSeries === "object" ? bppTripCalSeries : {};
    const maxV = bppTripCalMaxV > 0 ? bppTripCalMaxV : 1;
    const sm = bppTripCalStartMonth;
    const m0 = sm;
    const m1 = sm + 1;
    const d0 = new Date(y, m0, 1);
    const d1 = new Date(y, m1, 1);
    const rangeLabel = `${capitalizeNl(bppMonthOnlyNl.format(d0))} – ${capitalizeNl(bppMonthOnlyNl.format(d1))} ${y}`;
    if (labelEl) labelEl.textContent = rangeLabel;
    if (prev) prev.disabled = sm <= 0;
    if (next) next.disabled = sm >= 10;
    const topMap = bppTripTopDestByDay && typeof bppTripTopDestByDay === "object" ? bppTripTopDestByDay : {};
    const left = buildTripCalMonthHtml(y, m0, data, maxV, topMap);
    const right = buildTripCalMonthHtml(y, m1, data, maxV, topMap);
    monthsEl.innerHTML =
      `<div class="bpp-cal-heatmap__pair">${left}${right}</div>` +
      `<div class="bpp-cal-heatmap__legend"><span>Weinig</span><span class="bpp-cal-heatmap__legend-bar" aria-hidden="true"></span><span>Veel</span></div>`;
  }

  function renderTripHeatmap(year, series) {
    const root = document.getElementById("bppTripHeatmap");
    const monthsEl = document.getElementById("bppTripHeatmapMonths");
    const introEl = document.getElementById("bppTripHeatmapIntro");
    if (!root || !monthsEl) return;

    setupBppTripCalTooltip();

    const y = parseInt(String(year), 10);
    if (!Number.isFinite(y)) return;

    const data = series && typeof series === "object" ? series : {};
    const dailyVals = [];
    for (let m = 0; m < 12; m += 1) {
      const dim = new Date(y, m + 1, 0).getDate();
      for (let d = 1; d <= dim; d += 1) {
        const iso = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        dailyVals.push(Number(data[iso]) || 0);
      }
    }
    const maxV = dailyVals.length ? Math.max(...dailyVals, 1) : 1;

    bppTripCalMaxV = maxV;
    bppTripCalYear = y;
    bppTripCalSeries = data;
    let firstMonthWithData = 0;
    for (let m = 0; m < 12; m += 1) {
      const dim = new Date(y, m + 1, 0).getDate();
      let hasData = false;
      for (let d = 1; d <= dim; d += 1) {
        const iso = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        if ((Number(data[iso]) || 0) > 0) {
          hasData = true;
          break;
        }
      }
      if (hasData) {
        firstMonthWithData = m;
        break;
      }
    }
    bppTripCalStartMonth = Math.max(0, Math.min(10, firstMonthWithData));

    if (introEl) {
      introEl.textContent = `Kalender ${y}: telkens twee opeenvolgende maanden; gebruik de pijlknoppen erboven om maand voor maand te bladeren. Elke cel is één kalenderdag. Kleur = drukte t.o.v. de drukste dag in dit jaar (${nf.format(
        maxV,
      )} reizigers op bestemming). Dagen met 0 reizigers blijven zichtbaar (grijze cel).`;
    }

    ensureBppTripCalNavDom();
    bindBppTripCalNav();
    renderTripHeatmapViewport();
  }

  function openBppDepartDetailModal(vertrekIso, breakdown) {
    const modalEl = document.getElementById("bppDepartDetailModal");
    const titleEl = document.getElementById("bppDepartDetailModalTitle");
    const bodyEl = document.getElementById("bppDepartDetailModalBody");
    if (!modalEl || !bodyEl) return;
    const d = vertrekIso ? new Date(`${vertrekIso}T12:00:00`) : null;
    const dateLine =
      d && !Number.isNaN(d.getTime()) ? capitalizeNl(bppLongDateNl.format(d)) : vertrekIso || "—";
    if (titleEl) titleEl.textContent = `Bestemmingen · ${dateLine}`;
    const items = Array.isArray(breakdown) ? breakdown : [];
    if (!items.length) {
      bodyEl.innerHTML =
        '<p class="text-muted small mb-0">Geen bestemmingsdetail voor deze dag. Vernieuw de pagina na een update.</p>';
    } else {
      bodyEl.innerHTML = `<p class="small text-muted mb-2">Pax per bestemming (vertrek op deze dag):</p><ul class="list-unstyled mb-0">${items
        .map(
          (it) => `<li class="d-flex justify-content-between gap-3 py-2 border-bottom align-items-baseline"><span class="text-break">${bppEscapeHtml(
            it.naam || "—",
          )}</span><span class="text-nowrap fw-semibold flex-shrink-0">${nf.format(it.pax ?? 0)} pax</span></li>`,
        )
        .join("")}</ul>`;
    }
    if (window.bootstrap?.Modal) {
      window.bootstrap.Modal.getOrCreateInstance(modalEl).show();
    }
  }

  function showBppInsightModal(title, bodyHtml) {
    const modalEl = document.getElementById("bppInsightModal");
    const titleEl = document.getElementById("bppInsightModalTitle");
    const bodyEl = document.getElementById("bppInsightModalBody");
    if (!modalEl || !bodyEl || !titleEl) return;
    titleEl.textContent = title;
    bodyEl.innerHTML = bodyHtml;
    if (window.bootstrap?.Modal) window.bootstrap.Modal.getOrCreateInstance(modalEl).show();
  }

  function openBppTripDayInsight(iso, pax, top3) {
    const d = iso ? new Date(`${iso}T12:00:00`) : null;
    const dateLine =
      d && !Number.isNaN(d.getTime()) ? capitalizeNl(bppLongDateNl.format(d)) : iso || "—";
    const paxN = Number(pax) || 0;
    const totalHtml = `<p class="mb-2"><span class="text-muted">Totaal reizigers op bestemming (verblijfslogica):</span> <strong>${nf.format(paxN)}</strong></p>`;
    let listHtml = "";
    if (paxN <= 0) {
      listHtml =
        '<p class="text-muted small mb-0">Geen actieve reizen op deze dag binnen de huidige filters.</p>';
    } else if (!Array.isArray(top3) || !top3.length) {
      listHtml =
        '<p class="text-muted small mb-0">Geen bestemmingsverdeling beschikbaar voor deze dag.</p>';
    } else {
      listHtml = `<p class="small text-muted mb-2">Top 3 bestemmingen</p><ul class="list-unstyled mb-0">${top3
        .map(
          (it) => `<li class="d-flex justify-content-between gap-3 py-2 border-bottom align-items-baseline">
          <span class="text-break">${bppEscapeHtml(it.naam || "—")}</span>
          <span class="text-nowrap flex-shrink-0"><span class="fw-semibold">${nf.format(it.pax ?? 0)}</span> pax
          ${it.pct != null ? `<span class="text-muted small ms-1">(${nfPctOne.format(it.pct)}%)</span>` : ""}</span>
        </li>`,
        )
        .join("")}</ul>`;
    }
    showBppInsightModal(`Reizigers op reis · ${dateLine}`, totalHtml + listHtml);
  }

  function openBppMatrixInsight(isAccMatrix, cellKey, paxFallback) {
    const detailMap = isAccMatrix ? bppMatrixCellDetailsAcc : bppMatrixCellDetailsDest;
    let d = detailMap[cellKey];
    const paxFb = Number(paxFallback) || 0;
    if (!d) {
      const parts = String(cellKey).split("\t");
      const row = parts[0] || "—";
      const wk = parseInt(parts[1], 10) || 0;
      d = {
        week: wk,
        pax: paxFb,
        bookings: 0,
        avg_pax_per_booking: 0,
        bestemming: isAccMatrix ? undefined : row,
        accommodatie: isAccMatrix ? row : undefined,
        top_brands: [],
        top_bestemmingen: [],
      };
    }
    const wk = d.week != null ? d.week : "—";
    const rowMain = isAccMatrix ? d.accommodatie || d.row_label || "—" : d.bestemming || d.row_label || "—";
    const title = `Vertrekweek ${wk} × ${isAccMatrix ? "accommodatie" : "bestemming"}`;
    const sub = `<p class="small text-muted mb-3">${bppEscapeHtml(String(rowMain))}</p>`;
    const pax = Number(d.pax) || 0;
    const bk = Number(d.bookings) || 0;
    const avg = d.avg_pax_per_booking != null ? String(d.avg_pax_per_booking).replace(".", ",") : "—";
    const metrics = `<dl class="row small mb-3 bpp-insight-dl">
      <dt class="col-sm-4">Pax</dt><dd class="col-sm-8">${nf.format(pax)}</dd>
      <dt class="col-sm-4">Boekingen</dt><dd class="col-sm-8">${nf.format(bk)}</dd>
      <dt class="col-sm-4">Gem. pax / boeking</dt><dd class="col-sm-8">${avg}</dd>
    </dl>`;
    const brands = Array.isArray(d.top_brands) ? d.top_brands : [];
    const brandsHtml = brands.length
      ? `<p class="small fw-semibold mb-1">Top merken (pax)</p><ul class="list-unstyled small mb-3">${brands
          .map(
            (b) =>
              `<li class="d-flex justify-content-between py-1 border-bottom"><span>${bppEscapeHtml(
                b.naam || "—",
              )}</span><span>${nf.format(b.pax ?? 0)}</span></li>`,
          )
          .join("")}</ul>`
      : "";
    const topDest = Array.isArray(d.top_bestemmingen) ? d.top_bestemmingen : [];
    const topDestHtml =
      isAccMatrix && topDest.length
        ? `<p class="small fw-semibold mb-1">Top bestemmingen (pax)</p><ul class="list-unstyled small mb-0">${topDest
            .map(
              (x) =>
                `<li class="d-flex justify-content-between py-1 border-bottom"><span>${bppEscapeHtml(
                  x.naam || "—",
                )}</span><span>${nf.format(x.pax ?? 0)}</span></li>`,
            )
            .join("")}</ul>`
        : "";
    if (!pax && !bk) {
      showBppInsightModal(
        title,
        sub +
          '<p class="text-muted small mb-0">Geen boekingen voor deze combinatie binnen de huidige filters.</p>',
      );
      return;
    }
    showBppInsightModal(title, sub + metrics + brandsHtml + topDestHtml);
  }

  function bindBppTripHeatmapInsight() {
    const root = document.getElementById("bppTripHeatmap");
    if (!root || root.dataset.bppTripInsightBound) return;
    root.dataset.bppTripInsightBound = "1";
    root.addEventListener("click", (e) => {
      const btn = e.target.closest("button.bpp-cal-day");
      if (!btn || btn.classList.contains("bpp-cal-day--empty")) return;
      const iso = btn.getAttribute("data-iso") || "";
      const pax = Number(btn.getAttribute("data-pax") || "0");
      let top3 = [];
      try {
        const raw = btn.getAttribute("data-top3") || "[]";
        top3 = JSON.parse(raw);
      } catch {
        top3 = [];
      }
      openBppTripDayInsight(iso, pax, top3);
    });
  }

  function bindBppMatrixInsight() {
    const table = document.getElementById("bppMatrixTable");
    if (!table || table.dataset.bppMatrixInsightBound) return;
    table.dataset.bppMatrixInsightBound = "1";
    table.addEventListener("click", (e) => {
      const td = e.target.closest("td[data-bpp-matrix-key]");
      if (!td || !table.contains(td)) return;
      const key = td.getAttribute("data-bpp-matrix-key");
      if (!key) return;
      const mode = table.dataset.bppMatrixMode || "dest";
      const paxFb = Number(td.getAttribute("data-bpp-matrix-pax") || "0");
      openBppMatrixInsight(mode === "acc", key, paxFb);
    });
    table.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const td = e.target.closest("td[data-bpp-matrix-key]");
      if (!td || !table.contains(td)) return;
      e.preventDefault();
      td.click();
    });
  }

  function bindBppDepartTableRowDetails() {
    const tb = document.getElementById("bppTableDepartures");
    if (!tb || tb.dataset.bppDepartDetailBound) return;
    tb.dataset.bppDepartDetailBound = "1";
    tb.addEventListener("click", (e) => {
      const tr = e.target.closest("tbody tr.bpp-depart-row[data-depart-date]");
      if (!tr) return;
      const iso = tr.getAttribute("data-depart-date") || "";
      let breakdown = [];
      try {
        const raw = tr.getAttribute("data-breakdown") || "";
        if (raw) breakdown = JSON.parse(decodeURIComponent(raw));
      } catch {
        breakdown = [];
      }
      openBppDepartDetailModal(iso, breakdown);
    });
    tb.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const tr = e.target.closest("tr.bpp-depart-row[data-depart-date]");
      if (!tr || !tb.contains(tr)) return;
      e.preventDefault();
      tr.click();
    });
  }

  function bppDepartureRowSortModel(r) {
    const vd = r.vertrekdatum ? bppParseIsoLocal(String(r.vertrekdatum)) : null;
    const dp = r.delta_pax_vs_prev != null ? Number(r.delta_pax_vs_prev) : null;
    const dpp = r.delta_pct_vs_prev != null ? Number(r.delta_pct_vs_prev) : null;
    return {
      vertrekdatum: String(r.vertrekdatum || ""),
      vertrek_ts: vd ? vd.getTime() : 0,
      week: Number(r.week) || 0,
      month: Number(r.month) || 0,
      weekday_label: String(r.weekday_label || ""),
      pax: Number(r.pax) || 0,
      bookings: Number(r.bookings) || 0,
      top_accommodatie: String(r.top_accommodatie || ""),
      transport_top: String(r.transport_top || ""),
      share_be_pct: Number(r.share_be_pct) || 0,
      share_nl_pct: Number(r.share_nl_pct) || 0,
      share_it_pct: Number(r.share_it_pct) || 0,
      share_other_pct: Number(r.share_other_pct) || 0,
      delta_pax_vs_prev: dp,
      delta_pct_vs_prev: dpp,
      __raw: r,
    };
  }

  function renderDepartureTableBodyFromRows(list) {
    const tb = document.getElementById("bppTableDepartures");
    if (!tb) return;
    const tbody = tb.querySelector("tbody");
    if (!tbody) return;
    const emptyMsg = "Geen data voor deze selectie.";
    if (!list || !list.length) {
      tbody.innerHTML = `<tr><td colspan="14" class="text-muted small">${emptyMsg}</td></tr>`;
      return;
    }
    tbody.innerHTML = list
      .map((row) => {
        const r = row.__raw;
        const bd = encodeURIComponent(JSON.stringify(r.bestemming_breakdown || []));
        const viso = bppEscapeAttr(String(r.vertrekdatum || ""));
        return `<tr class="bpp-depart-row" role="button" tabindex="0" data-depart-date="${viso}" data-breakdown="${bd}" aria-label="Details bestemmingen voor vertrek ${viso}">
        <td class="text-nowrap">${r.vertrekdatum}</td>
        <td>${r.week}</td><td>${r.month}</td><td>${r.weekday_label}</td>
        <td class="text-end vg-num">${nf.format(r.pax)}</td>
        <td class="text-end vg-num">${nf.format(r.bookings)}</td>
        <td class="vg-col-text">${r.top_accommodatie || "—"}</td>
        <td>${r.transport_top || "—"}</td>
        <td class="text-end vg-num">${r.share_be_pct}%</td>
        <td class="text-end vg-num">${r.share_nl_pct}%</td>
        <td class="text-end vg-num">${r.share_it_pct}%</td>
        <td class="text-end vg-num">${r.share_other_pct}%</td>
        <td class="text-end vg-num">${r.delta_pax_vs_prev != null ? nf.format(r.delta_pax_vs_prev) : "—"}</td>
        <td class="text-end vg-num">${r.delta_pct_vs_prev != null ? `${r.delta_pct_vs_prev}%` : "—"}</td>
      </tr>`;
      })
      .join("");
  }

  function renderDepartureTable(rows) {
    const tb = document.getElementById("bppTableDepartures");
    const wire = typeof globalThis.TA_wireSortableTable === "function" ? globalThis.TA_wireSortableTable : null;
    if (!tb) return;
    bindBppDepartTableRowDetails();

    const base = Array.isArray(rows) ? rows : [];
    const dfIso = depEls.dateFrom?.value?.trim() || "";
    const dtIso = depEls.dateTo?.value?.trim() || "";

    let start = dfIso ? bppParseIsoLocal(dfIso) : null;
    let end = dtIso ? bppParseIsoLocal(dtIso) : null;
    if (start && end && start > end) [start, end] = [end, start]; // robuust bij omgedraaide inputs

    const filtered = base
      .filter((r) => {
        const vd = r.vertrekdatum ? bppParseIsoLocal(String(r.vertrekdatum)) : null;
        if (!vd) return true;
        if (start && vd < start) return false;
        if (end && vd > end) return false;
        return true;
      })
      .sort((a, b) => {
        const da = a.vertrekdatum ? bppParseIsoLocal(String(a.vertrekdatum)) : null;
        const db = b.vertrekdatum ? bppParseIsoLocal(String(b.vertrekdatum)) : null;
        const ta = da ? da.getTime() : 0;
        const tb2 = db ? db.getTime() : 0;
        return ta - tb2; // oudste vertrekdatum bovenaan
      });

    const thead = `<thead class="table-light"><tr>
      <th scope="col" class="text-nowrap" data-sort="vertrek_ts" data-sort-type="number">Vertrek</th>
      <th scope="col" data-sort="week" data-sort-type="number">Week</th>
      <th scope="col" data-sort="month" data-sort-type="number">Maand</th>
      <th scope="col" data-sort="weekday_label" data-sort-type="text">Dag</th>
      <th scope="col" class="text-end text-nowrap" data-sort="pax" data-sort-type="number">Pax</th>
      <th scope="col" class="text-end text-nowrap" data-sort="bookings" data-sort-type="number">Boek.</th>
      <th scope="col" data-sort="top_accommodatie" data-sort-type="text">Top accommodatie</th>
      <th scope="col" data-sort="transport_top" data-sort-type="text">Transport</th>
      <th scope="col" class="text-end text-nowrap" data-sort="share_be_pct" data-sort-type="number">BE%</th>
      <th scope="col" class="text-end text-nowrap" data-sort="share_nl_pct" data-sort-type="number">NL%</th>
      <th scope="col" class="text-end text-nowrap" data-sort="share_it_pct" data-sort-type="number">IT%</th>
      <th scope="col" class="text-end text-nowrap" data-sort="share_other_pct" data-sort-type="number">Overig%</th>
      <th scope="col" class="text-end text-nowrap" data-sort="delta_pax_vs_prev" data-sort-type="number">Δ pax</th>
      <th scope="col" class="text-end text-nowrap" data-sort="delta_pct_vs_prev" data-sort-type="number">Δ %</th>
    </tr></thead>`;

    bppDepartureSortRows = filtered.map(bppDepartureRowSortModel);
    tb.innerHTML = `${thead}<tbody></tbody>`;
    renderDepartureTableBodyFromRows(bppDepartureSortRows);
    if (wire && bppDepartureSortRows.length) {
      wire(
        tb,
        () => bppDepartureSortRows.map((r) => ({ ...r, __raw: r.__raw })),
        (sorted) => {
          bppDepartureSortRows = sorted;
          renderDepartureTableBodyFromRows(sorted);
        },
      );
    }
  }

  function syncDepartureDestinationFilterOptions() {
    if (!depEls.destination || !els.dest) return;
    // Maak lokaal dropdown exact op basis van huidige bestemmingen-filter.
    // Hiermee "werkt" het filter consistent met de selectie die de pagina al gebruikt.
    depEls.destination.innerHTML = "";
    const globalOpts = Array.from(els.dest.options || []);
    globalOpts.forEach((opt) => {
      const o = document.createElement("option");
      o.value = opt.value;
      o.textContent = opt.textContent;
      depEls.destination.appendChild(o);
    });
  }

  function setupDepartureLocalFilters() {
    if (!depEls.dateFrom || !depEls.dateTo || !depEls.destination) return;
    if (bppDepartureLocalFiltersBound) return;
    bppDepartureLocalFiltersBound = true;
    // Events voor hertekenen op basis van datumperiode.
    const rerender = () => {
      if (bppDepartureBaseRows) renderDepartureTable(bppDepartureBaseRows);
    };
    depEls.dateFrom.addEventListener("change", rerender);
    depEls.dateTo.addEventListener("change", rerender);
    depEls.destination.addEventListener("change", async () => {
      await refreshDepartureTableForLocalDestination();
    });
  }

  async function fetchDepartureTableForLocalDestination(destVal) {
    const year = els.year?.value || "";
    const brand = els.brand?.value || "__all__";
    const country = els.country?.value || "__ALL__";
    const destination = destVal || "__all__";
    const compare_prev = "1";
    const show_holidays = "0";
    const params = new URLSearchParams({
      year: String(year),
      brand: String(brand),
      destination: String(destination),
      country: String(country),
      brand_land: els.brandLand?.value || "__ALL__",
      compare_prev,
      show_holidays,
    });
    const res = await fetch(`${API_DATA}?${params}`, {
      headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" },
      credentials: "same-origin",
    });
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error("Ongeldige JSON van server");
    }
    if (!res.ok) throw new Error(data.error || `Fout ${res.status}`);
    return data.departure_table || [];
  }

  async function refreshDepartureTableForLocalDestination() {
    if (!depEls.destination) return;
    const destVal = depEls.destination.value || "__all__";
    const token = ++bppDepartureFetchToken;
    setErr("");
    try {
      const rows = await fetchDepartureTableForLocalDestination(destVal);
      if (token !== bppDepartureFetchToken) return; // verouderde response
      bppDepartureBaseRows = rows;
      bppDepartureBaseRowsDestVal = destVal;
      renderDepartureTable(bppDepartureBaseRows);
    } catch (e) {
      setErr(e?.message || String(e));
    }
  }

  function renderHolidayBodyFromRows(list) {
    const tb = document.getElementById("bppTableHolidays");
    if (!tb) return;
    const tbody = tb.querySelector("tbody");
    if (!tbody) return;
    tbody.innerHTML = (list || [])
      .map(
        (r) => `<tr>
        <td class="vg-col-text">${r.periode}</td><td>${r.start}</td><td>${r.end}</td>
        <td class="text-end vg-num">${nf.format(r.pax_current)}</td>
        <td class="text-end vg-num">${nf.format(r.pax_previous)}</td>
        <td class="text-end vg-num">${r.delta_pct != null ? `${r.delta_pct}%` : "—"}</td>
        <td>${r.top_vertrek || "—"}</td><td>${r.dominant_transport}</td>
      </tr>`,
      )
      .join("");
  }

  function renderHolidayTable(rows) {
    const sec = document.getElementById("bppHolidaySection");
    const tb = document.getElementById("bppTableHolidays");
    const wire = typeof globalThis.TA_wireSortableTable === "function" ? globalThis.TA_wireSortableTable : null;
    if (!sec || !tb) return;
    if (!rows || !rows.length) {
      sec.classList.add("d-none");
      return;
    }
    sec.classList.remove("d-none");
    bppHolidayRows = rows.map((r) => ({
      periode: r.periode || "—",
      start: r.start || "",
      end: r.end || "",
      pax_current: Number(r.pax_current) || 0,
      pax_previous: Number(r.pax_previous) || 0,
      delta_pct: r.delta_pct != null ? Number(r.delta_pct) : null,
      top_vertrek: r.top_vertrek || "",
      dominant_transport: r.dominant_transport || "",
    }));
    tb.innerHTML = `<thead class="table-light"><tr>
      <th scope="col" data-sort="periode" data-sort-type="text">Periode</th>
      <th scope="col" data-sort="start" data-sort-type="text">Van</th>
      <th scope="col" data-sort="end" data-sort-type="text">Tot</th>
      <th scope="col" class="text-end text-nowrap" data-sort="pax_current" data-sort-type="number">Pax</th>
      <th scope="col" class="text-end text-nowrap" data-sort="pax_previous" data-sort-type="number">Vorig</th>
      <th scope="col" class="text-end text-nowrap" data-sort="delta_pct" data-sort-type="number">Δ%</th>
      <th scope="col" data-sort="top_vertrek" data-sort-type="text">Top vertrek</th>
      <th scope="col" data-sort="dominant_transport" data-sort-type="text">Transport</th>
    </tr></thead><tbody></tbody>`;
    renderHolidayBodyFromRows(bppHolidayRows);
    if (wire && bppHolidayRows.length) {
      wire(
        tb,
        () => bppHolidayRows.map((r) => ({ ...r })),
        (sorted) => {
          bppHolidayRows = sorted;
          renderHolidayBodyFromRows(sorted);
        },
      );
    }
  }

  let bppMatrixColStart = 0;
  let bppMatrixPayload = null;

  /**
   * Matrix-API: rijen kunnen sparse kolommen hebben; map naar vaste W1..W52.
   * @param {unknown[]} valsRaw
   * @param {Map<number, number>} colIdxByWeek
   */
  function bppMatrixAlignRowsToWeeks(valsRaw, colIdxByWeek) {
    return valsRaw.map((row) => {
      const r = Array.isArray(row) ? row : [];
      const fullRow = Array.from({ length: BPP_MATRIX_WEEK_TOTAL }, () => 0);
      if (colIdxByWeek.size) {
        colIdxByWeek.forEach((colIdx, wn) => {
          const v = Number(r[colIdx] ?? 0) || 0;
          fullRow[wn - 1] = v;
        });
      } else {
        for (let j = 0; j < Math.min(r.length, BPP_MATRIX_WEEK_TOTAL); j += 1) {
          fullRow[j] = Number(r[j] ?? 0) || 0;
        }
      }
      return fullRow;
    });
  }

  const BPP_MATRIX_NAV_SNIPPET =
    '<div class="bpp-matrix-week-nav" id="bppMatrixWeekNav" role="navigation" aria-label="Navigatie weken in matrix">' +
    '<button type="button" class="bpp-cal-nav-btn bpp-matrix-nav__btn" id="bppMatrixWeekPrev" aria-label="Vorige 10 weken tonen">' +
    '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg></button>' +
    '<span class="bpp-matrix-week-nav-label" id="bppMatrixWeekRangeLabel" aria-live="polite"></span>' +
    '<button type="button" class="bpp-cal-nav-btn bpp-matrix-nav__btn" id="bppMatrixWeekNext" aria-label="Volgende 10 weken tonen">' +
    '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg></button></div>';

  function ensureBppMatrixWeekNavDom() {
    if (document.getElementById("bppMatrixWeekPrev")) return;
    const scroll = document.querySelector("#bppMatrixTable")?.closest(".bpp-matrix-scroll");
    const table = document.getElementById("bppMatrixTable");
    const anchor = scroll || table?.parentElement;
    if (table && anchor) {
      table.insertAdjacentHTML("beforebegin", BPP_MATRIX_NAV_SNIPPET);
    }
  }

  function bindBppMatrixWeekNav() {
    if (document.documentElement.dataset.bppMatrixNavGlob) return;
    document.documentElement.dataset.bppMatrixNavGlob = "1";
    document.addEventListener("click", (e) => {
      if (!e.target.closest("#bppMatrixWeekPrev") && !e.target.closest("#bppMatrixWeekNext")) return;
      if (e.target.closest("#bppMatrixWeekPrev")) {
        bppMatrixColStart = Math.max(0, bppMatrixColStart - BPP_MATRIX_WEEK_STEP);
        paintBppMatrixTable();
      } else if (e.target.closest("#bppMatrixWeekNext")) {
        bppMatrixColStart = Math.min(
          BPP_MATRIX_WEEK_TOTAL - BPP_MATRIX_WEEK_VIEWPORT,
          bppMatrixColStart + BPP_MATRIX_WEEK_STEP,
        );
        paintBppMatrixTable();
      }
    });
  }

  function updateBppMatrixNavUI() {
    const label = document.getElementById("bppMatrixWeekRangeLabel");
    const prev = document.getElementById("bppMatrixWeekPrev");
    const next = document.getElementById("bppMatrixWeekNext");
    const fromW = bppMatrixColStart + 1;
    const toW = Math.min(bppMatrixColStart + BPP_MATRIX_WEEK_VIEWPORT, BPP_MATRIX_WEEK_TOTAL);
    if (label) label.textContent = `Week ${fromW}–${toW} van ${BPP_MATRIX_WEEK_TOTAL}`;
    if (prev) prev.disabled = bppMatrixColStart <= 0;
    if (next) next.disabled = bppMatrixColStart >= BPP_MATRIX_WEEK_TOTAL - BPP_MATRIX_WEEK_VIEWPORT;
  }

  function paintBppMatrixTable() {
    const table = document.getElementById("bppMatrixTable");
    const yl = document.getElementById("bppMatrixYLabel");
    const hint = document.getElementById("bppMatrixHint");
    if (!table || !bppMatrixPayload) return;
    const { matrix, singleDest, isoYear } = bppMatrixPayload;
    const y = Number.isFinite(isoYear) ? isoYear : new Date().getFullYear();
    const m = singleDest ? matrix.mode_single_destination : matrix.mode_all_destinations;
    if (!m) {
      table.innerHTML =
        '<thead><tr><th></th></tr></thead><tbody><tr><td class="text-muted small" colspan="2">Geen matrixdata voor deze selectie.</td></tr></tbody>';
      updateBppMatrixNavUI();
      return;
    }
    if (yl) yl.textContent = singleDest ? "accommodatie" : "bestemming";
    if (hint) {
      hint.textContent = singleDest
        ? "Alle weken 1–52; maand = maand van de maandag van die ISO-week. Pijltjes: eerste en tweede jaarhelft."
        : "Alle weken 1–52 (top 25 rijen); maand = maand van de maandag van die ISO-week. Pijltjes voor week 27–52.";
    }

    const xsRaw = m.x_labels || [];
    const valsRaw = m.values || [];

    // Robuust: API kan enkel weken teruggeven die "met data" zijn, met x_labels die niet 1..52 lopen.
    // We mappen kolomindex -> weeknummer en zetten alles terug in een vaste vector W1..W52.
    const fullWeekNos = Array.from({ length: BPP_MATRIX_WEEK_TOTAL }, (_, i) => i + 1); // 1..52
    const xsFull = fullWeekNos.map((w) => `W${w}`);

    const colIdxByWeek = new Map();
    xsRaw.forEach((lab, colIdx) => {
      const wm = String(lab).match(/W?\s*(\d+)/i);
      const wn = wm ? parseInt(wm[1], 10) : null;
      if (wn == null) return;
      if (wn < 1 || wn > BPP_MATRIX_WEEK_TOTAL) return;
      if (!colIdxByWeek.has(wn)) colIdxByWeek.set(wn, colIdx);
    });

    const valsFull = bppMatrixAlignRowsToWeeks(valsRaw, colIdxByWeek);
    const bookingsRaw = m.bookings_values || [];
    const bookingsFull = bppMatrixAlignRowsToWeeks(bookingsRaw, colIdxByWeek);

    bppMatrixColStart = Math.max(
      0,
      Math.min(bppMatrixColStart, Math.max(0, BPP_MATRIX_WEEK_TOTAL - BPP_MATRIX_WEEK_VIEWPORT)),
    );
    const c0 = bppMatrixColStart;
    const c1 = Math.min(c0 + BPP_MATRIX_WEEK_VIEWPORT, xsFull.length);
    const xs = xsFull.slice(c0, c1);
    const vals = valsFull.map((row) => row.slice(c0, c1));

    const flat = vals.flat();
    const maxV = flat.length ? Math.max(...flat, 1) : 1;

    const headCells = xs
      .map((x, i) => {
        const globalIdx = c0 + i;
        const wm = String(x).match(/W?\s*(\d+)/i);
        const wn = wm ? parseInt(wm[1], 10) : globalIdx + 1;
        const mo = monthLongNlForIsoWeek(y, wn);
        return `<th class="text-center small bpp-matrix-th-week" scope="col"><span class="bpp-matrix-th-w">${x}</span><span class="bpp-matrix-th-m">${mo}</span></th>`;
      })
      .join("");

    let head = `<thead><tr><th scope="col"></th>${headCells}</tr></thead>`;
    let body = "<tbody>";
    const ys = m.y_labels || [];
    const isAccMatrix = !!singleDest;
    table.dataset.bppMatrixMode = isAccMatrix ? "acc" : "dest";
    ys.forEach((rowLabel, ri) => {
      body += `<tr><th class="small text-nowrap" scope="row">${rowLabel}</th>`;
      (vals[ri] || []).forEach((c, ci) => {
        const pax = Number(c) || 0;
        const inten = pax / maxV;
        const txt = pax ? nf.format(pax) : "";
        const wn = c0 + ci + 1;
        const ck = `${rowLabel}\t${wn}`;
        const clickable = pax > 0;
        const fg = inten > 0.55 ? "#fff" : "#334155";
        const bg = tripHeatColor(inten);
        const tdCls = clickable ? "text-center small bpp-matrix-cell--hit" : "text-center small";
        const extra = clickable
          ? ` role="button" tabindex="0" data-bpp-matrix-key="${bppEscapeAttr(
              ck,
            )}" data-bpp-matrix-pax="${String(pax)}"`
          : "";
        body += `<td class="${tdCls}" style="background:${bg};color:${fg}"${extra}>${txt}</td>`;
      });
      body += "</tr>";
    });
    body += "</tbody>";
    table.innerHTML = head + body;
    updateBppMatrixNavUI();
  }

  function renderMatrix(matrix, singleDest, isoYear) {
    bppMatrixPayload = { matrix, singleDest, isoYear };
    bppMatrixCellDetailsDest = matrix?.cell_details_destination || {};
    bppMatrixCellDetailsAcc = matrix?.cell_details_accommodation || {};
    const m = singleDest ? matrix?.mode_single_destination : matrix?.mode_all_destinations;
    const vals = Array.isArray(m?.values) ? m.values : [];
    const firstWeekIdx = (() => {
      for (let c = 0; c < BPP_MATRIX_WEEK_TOTAL; c += 1) {
        for (let r = 0; r < vals.length; r += 1) {
          if ((Number(vals[r]?.[c]) || 0) > 0) return c;
        }
      }
      return 0;
    })();
    bppMatrixColStart = Math.max(0, Math.min(firstWeekIdx, BPP_MATRIX_WEEK_TOTAL - BPP_MATRIX_WEEK_VIEWPORT));
    ensureBppMatrixWeekNavDom();
    bindBppMatrixWeekNav();
    paintBppMatrixTable();
  }

  let destAllOptions = [];

  function rebuildDestSelect() {
    if (!els.dest) return;
    els.dest.innerHTML = "";
    const opt0 = document.createElement("option");
    opt0.value = "__all__";
    opt0.textContent = "Alle bestemmingen";
    els.dest.appendChild(opt0);
    destAllOptions.forEach(({ value, label }) => {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = label;
      els.dest.appendChild(o);
    });
  }

  async function loadOptions() {
    const res = await fetch(API_OPT, {
      credentials: "same-origin",
      headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Opties laden mislukt");
    const brands = data.brands || [];
    const dests = data.bestemmingen || [];
    const years = data.years || [];

    if (els.brand) {
      els.brand.innerHTML = '<option value="__all__">Alle merken</option>';
      brands.forEach((b) => {
        const o = document.createElement("option");
        o.value = b;
        o.textContent = b;
        els.brand.appendChild(o);
      });
    }
    destAllOptions = dests.map((d) => ({ value: String(d.id), label: d.naam || d.name || String(d.id) }));
    rebuildDestSelect();
    if (!bppDestMulti && typeof window.TAMultiSelectFilter === "function") {
      bppDestMulti = new window.TAMultiSelectFilter({
        selectEl: els.dest,
        placeholderAll: "Alle bestemmingen",
        searchPlaceholder: "Zoek bestemming...",
        itemLabelSingle: "bestemming",
        itemLabelPlural: "bestemmingen geselecteerd",
      });
    } else {
      bppDestMulti?.syncOptionsFromSelect();
    }
    bppDestMulti?.setValue([]);

    if (els.year) {
      els.year.innerHTML = "";
      years.forEach((y) => {
        const o = document.createElement("option");
        o.value = String(y);
        o.textContent = String(y);
        els.year.appendChild(o);
      });
      if (data.default_year) els.year.value = String(data.default_year);
    }
    syncBppDateInputsFromYear();

    // Init lokale filters voor vertrekdatum-detail (tabel-only).
    syncDepartureDestinationFilterOptions();
    if (depEls.destination && els.dest) {
      depEls.destination.value = primaryDestinationValue();
    }
    setupDepartureLocalFilters();
  }

  async function loadData() {
    const params = new URLSearchParams({
      year: els.year?.value || "",
      brand: els.brand?.value || "__all__",
      destination: selectedDestinations().join(",") || "__all__",
      country: els.country?.value || "__ALL__",
      brand_land: els.brandLand?.value || "__ALL__",
      compare_prev: "1",
      show_holidays: "0",
    });
    const res = await fetch(`${API_DATA}?${params}`, {
      headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" },
      credentials: "same-origin",
    });
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error("Ongeldige JSON van server");
    }
    if (!res.ok) throw new Error(data.error || `Fout ${res.status}`);
    return data;
  }

  function renderAll(data) {
    const compare = !!data.compare_enabled;
    const k = data.kpis || {};
    renderKpis(k, compare);
    renderDestinationDelta(data.destination_delta, data.year, compare);

    const cw = data.charts?.pax_per_week || {};
    const isoY = Number(data.year) || new Date().getFullYear();
    const hint = document.getElementById("bppWeekIsoYearHint");
    if (hint) hint.textContent = String(isoY);
    buildWeekPaxChart(
      "bppChartWeek",
      cw.labels || [],
      cw.current || [],
      compare ? cw.previous || [] : [],
      compare,
      isoY,
    );

    const cm = data.charts?.pax_per_month || {};
    const monthLabelsNl = (cm.labels || []).map((_lbl, idx) => monthLabelNlShortFromIndex(idx));
    buildBarChart("bppChartMonth", monthLabelsNl, cm.current || [], compare ? cm.previous || [] : {});

    renderJJAS(data.charts?.summer_jjas || []);
    renderCountryShift(data.charts?.country_share_shift_by_month || [], compare);

    const hasActiveFilter =
      (els.brand?.value || "__all__") !== "__all__" ||
      selectedDestinations().length > 0 ||
      (els.country?.value || "__ALL__") !== "__ALL__" ||
      (els.brandLand?.value || "__ALL__") !== "__ALL__";
    buildHorizontalBar("bppChartTop20", data.charts?.top20_departure_days || [], !hasActiveFilter);

    const tr = data.charts?.transport_split || {};
    renderTransport(tr.labels || [], tr.current || [], tr.previous || null, compare);

    const trip = data.charts?.travellers_on_trip_heatmap || {};
    const y = data.year;
    bppTripTopDestByDay = data.charts?.travellers_on_trip_top_destinations || {};
    initBppTripLineFromHeatmap(trip, y);
    renderTripHeatmap(y, trip);

    // Vertrekdatum-detail moet lokaal gefilterd worden (en kan afwijken van global destination-filter).
    const localDestVal = depEls.destination?.value || primaryDestinationValue();
    const globalDestVal = primaryDestinationValue();
    const departureRows = data.departure_table || [];
    if (!depEls.destination || localDestVal === globalDestVal) {
      bppDepartureBaseRows = departureRows;
      bppDepartureBaseRowsDestVal = localDestVal;
      renderDepartureTable(bppDepartureBaseRows);
    } else {
      // Local bestemming select is anders: refresh tabel-only.
      bppDepartureBaseRows = departureRows;
      bppDepartureBaseRowsDestVal = localDestVal;
      void refreshDepartureTableForLocalDestination();
    }
    renderHolidayTable(data.holiday_periods || []);

    const single = selectedDestinations().length === 1;
    renderMatrix(data.matrix || {}, single, isoY);
  }

  els.year?.addEventListener("change", syncBppDateInputsFromYear);

  const bppWeekPrev = document.getElementById("bppWeekPrev");
  const bppWeekNext = document.getElementById("bppWeekNext");
  if (bppWeekPrev && bppWeekNext && !bppWeekPrev.dataset.bound) {
    bppWeekPrev.dataset.bound = "1";
    bppWeekNext.dataset.bound = "1";
    bppWeekPrev.addEventListener("click", () => shiftWeekView(-WEEK_STEP));
    bppWeekNext.addEventListener("click", () => shiftWeekView(WEEK_STEP));
  }

  els.reset?.addEventListener("click", async () => {
    setErr("");
    els.loading?.classList.remove("d-none");
    els.dash?.classList.add("d-none");
    try {
      await loadOptions();
      if (els.country) els.country.value = "__ALL__";
      if (els.brandLand) els.brandLand.value = "__ALL__";
      syncBppDateInputsFromYear();
      const data = await loadData();
      els.loading?.classList.add("d-none");
      els.dash?.classList.remove("d-none");
      renderAll(data);
    } catch (e) {
      els.loading?.classList.add("d-none");
      setErr(e?.message || String(e));
    }
  });

  els.apply?.addEventListener("click", async () => {
    setErr("");
    els.loading?.classList.remove("d-none");
    els.dash?.classList.add("d-none");
    try {
      const data = await loadData();
      els.loading?.classList.add("d-none");
      els.dash?.classList.remove("d-none");
      renderAll(data);
    } catch (e) {
      els.loading?.classList.add("d-none");
      setErr(e?.message || String(e));
    }
  });

  bindBppTripHeatmapInsight();
  bindBppMatrixInsight();

  (async function init() {
    try {
      setErr("");
      await loadOptions();
      updateWeekNavUI();
      els.loading?.classList.remove("d-none");
      els.dash?.classList.add("d-none");
      const data = await loadData();
      els.loading?.classList.add("d-none");
      els.dash?.classList.remove("d-none");
      renderAll(data);
    } catch (e) {
      setErr(e?.message || String(e));
      els.loading?.classList.add("d-none");
    }
  })();
})();
