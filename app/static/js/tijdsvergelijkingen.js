(() => {
  const els = {
    dateType: document.getElementById("vgDateType"),
    period: document.getElementById("vgPeriod"),
    currentYear: document.getElementById("vgCurrentYear"),
    compareYear: document.getElementById("vgCompareYear"),
    yearLabelPrimary: document.getElementById("vgYearLabelPrimary"),
    yearLabelRef: document.getElementById("vgYearLabelRef"),
    trendKpi: document.getElementById("vgTrendKpi"),
    trendScrollLeft: document.getElementById("vgTrendScrollLeft"),
    trendScrollRight: document.getElementById("vgTrendScrollRight"),
    trendRangeLabel: document.getElementById("vgTrendRangeLabel"),
    brand: document.getElementById("vgBrand"),
    destinations: document.getElementById("vgBestemmingen"),
    dateFrom: document.getElementById("vgDateFrom"),
    dateTo: document.getElementById("vgDateTo"),
    applyBtn: document.getElementById("vgApplyBtn"),
    resetBtn: document.getElementById("vgResetBtn"),
    errorBox: document.getElementById("vgError"),
    context: document.getElementById("vgComparisonContextText"),
    trendSubtitle: document.getElementById("vgTrendSubtitle"),
    periodCardTitle: document.getElementById("vgPeriodCardTitle"),
    periodCardSubtitle: document.getElementById("vgPeriodCardSubtitle"),
    tempoSubtitle: document.getElementById("vgTempoSubtitle"),
    countryCardY1: document.getElementById("vgCountryCardY1"),
    countryCardY2: document.getElementById("vgCountryCardY2"),
    trendChartCanvas: document.getElementById("vgTrendChart"),
    countryChartCanvas: document.getElementById("vgCountryChart"),
    bookingTempoChartCanvas: document.getElementById("vgBookingTempoChart"),
    trendEmpty: document.getElementById("vgTrendEmpty"),
    destinationEmpty: document.getElementById("vgDestinationEmpty"),
    countryEmpty: document.getElementById("vgCountryEmpty"),
    periodEmpty: document.getElementById("vgPeriodEmpty"),
    tempoEmpty: document.getElementById("vgTempoEmpty"),
    doelgroepEmpty: document.getElementById("vgDoelgroepEmpty"),
    yearEmpty: document.getElementById("vgYearSummaryEmpty"),
    destinationHead: document.getElementById("vgDestinationDeltaHead"),
    countryHead: document.getElementById("vgCountryMixHead"),
    periodHead: document.getElementById("vgPeriodCompareHead"),
    doelgroepHead: document.getElementById("vgDoelgroepHead"),
    yearHead: document.getElementById("vgYearSummaryHead"),
    overigModal: document.getElementById("vgOverigModal"),
    overigModalContext: document.getElementById("vgOverigModalContext"),
    overigModalY1: document.getElementById("vgOverigModalY1"),
    overigModalY2: document.getElementById("vgOverigModalY2"),
    overigBodyCurrent: document.getElementById("vgOverigModalBodyCurrent"),
    overigBodyCompare: document.getElementById("vgOverigModalBodyCompare"),
    leadLblY1: document.querySelector(".vg-lead-lbl-y1"),
    leadLblY2: document.querySelector(".vg-lead-lbl-y2"),
  };
  if (!els.dateType || !els.period || !els.currentYear || !els.compareYear || !els.brand || !els.destinations) {
    return;
  }

  /** @type {Record<string, unknown> | null} */
  let lastPayload = null;
  /** @type {Record<string, unknown>[]} */
  let trendFullList = [];
  let trendWindowStart = 0;

  const VG_TREND_WINDOW = 6;
  const VG_TREND_NAV_STEP = 1;

  const wireSortableTable = globalThis.TA_wireSortableTable;

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
    typeof window.__TIJDSVERGELIJKINGEN_API_BASE__ === "string" ? window.__TIJDSVERGELIJKINGEN_API_BASE__.trim() : "";
  const apiBase = pickApiBase(pageBase, serverBase);
  const API_OPTIONS = `${apiBase}/options`;
  const API_YEARS = `${apiBase}/years`;
  const API_DATA = `${apiBase}/data`;
  const RBAC = window.__RBAC__ || {};
  const IS_RESTRICTED_ROLE = Boolean(RBAC.isRestricted);
  const FORCED_YEAR = Number(RBAC.currentYear) || new Date().getFullYear();

  const brandAll = "__all__";
  const nfInt = new Intl.NumberFormat("nl-NL");
  const nfMoney = new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" });
  const nfPctEvolution = new Intl.NumberFormat("nl-NL", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  const nfShare = new Intl.NumberFormat("nl-NL", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  const nfPp = new Intl.NumberFormat("nl-NL", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  let trendChart = null;
  let countryChart = null;
  let tempoChart = null;
  /** @type {InstanceType<typeof window.TAMultiSelectFilter> | null} */
  let vgDestMulti = null;
  const countryColors = window.CountryColors || null;
  const COUNTRY_FALLBACK_COLORS = ["#64748b", "#0ea5e9", "#7c3aed", "#94a3b8"];

  const getY1 = () => (els.currentYear.value || "").trim();
  const getY2 = () => (els.compareYear.value || "").trim();
  const getTrendKpi = () => (els.trendKpi && els.trendKpi.value ? els.trendKpi.value : "pax");

  const setEmpty = (el, visible) => el && el.classList.toggle("d-none", !visible);
  const destroy = (chart) => chart && chart.destroy && chart.destroy();
  const selectedMulti = (select) => {
    if (select === els.destinations && vgDestMulti) {
      return vgDestMulti.getValue();
    }
    return Array.from(select.selectedOptions || [])
      .map((o) => o.value)
      .filter((v) => v && v !== "__all__");
  };

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  const showError = (msg) => {
    if (!els.errorBox) return;
    if (!msg) {
      els.errorBox.classList.add("d-none");
      els.errorBox.textContent = "";
      return;
    }
    els.errorBox.textContent = msg;
    els.errorBox.classList.remove("d-none");
  };

  const fetchJson = async (url) => {
    const method = "GET";
    const reqHeaders = { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" };
    const r = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: reqHeaders,
    });
    const txt = await r.text();
    const contentType = r.headers.get("content-type") || "";
    const looksHtml = /^\s*</.test(txt);

    if (looksHtml) {
      const preview = txt.slice(0, 300).replace(/\s+/g, " ").trim();
      const onLogin = r.url.includes("/login") || /login/i.test(txt.slice(0, 800));
      if (r.status === 401 || onLogin) {
        throw new Error(
          `Sessie verlopen of niet ingelogd.\nURL: ${url}\nStatus: ${r.status}\nContent-Type: ${contentType}\nPreview: ${preview}`
        );
      }
      throw new Error(
        `Server stuurde HTML i.p.v. JSON.\nURL: ${url}\nStatus: ${r.status}\nContent-Type: ${contentType}\nPreview: ${preview}`
      );
    }

    let json = {};
    if (txt) {
      try {
        json = JSON.parse(txt);
      } catch {
        throw new Error("Antwoord is geen geldige JSON. Controleer of de API bereikbaar is.");
      }
    }
    if (!r.ok) {
      const detail = json?.error || JSON.stringify(json);
      throw new Error(`HTTP ${r.status}: ${detail || txt || "Onbekende fout."}`);
    }
    return json;
  };

  const setOptions = (select, rows, key = "id", label = "naam") => {
    select.innerHTML = "";
    rows.forEach((row) => {
      const opt = document.createElement("option");
      opt.value = row[key];
      opt.textContent = row[label];
      select.appendChild(opt);
    });
  };

  function periodNlLabel() {
    const v = els.period.value;
    if (v === "week") return "week-indeling";
    if (v === "kwartaal") return "kwartaal-indeling";
    return "maand-indeling";
  }

  function deltaArrow(d) {
    if (d > 0) return "▲ ";
    if (d < 0) return "▼ ";
    return "► ";
  }

  function deltaClass(d) {
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

  function formatSignedInt(d) {
    const n = Math.round(Number(d || 0));
    const sign = n > 0 ? "+" : "";
    return `${sign}${nfInt.format(n)}`;
  }

  function formatDeltaPct(deltaPct, basePax) {
    if (basePax === 0 || deltaPct == null || Number.isNaN(Number(deltaPct))) return "—";
    const p = Number(deltaPct);
    const sign = p > 0 ? "+" : "";
    return `${sign}${nfPctEvolution.format(p)}%`;
  }

  function formatSharePct(share) {
    return `${nfShare.format(Number(share || 0))}%`;
  }

  function formatPpDelta(d) {
    const n = Number(d || 0);
    const sign = n > 0 ? "+" : "";
    return `${sign}${nfPp.format(n)} pp`;
  }

  const MONTHS_NL_SHORT = ["jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];

  function parseMetaDate(value) {
    if (value == null || value === "") return null;
    const s = String(value);
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const t = new Date(value);
    return Number.isNaN(t.getTime()) ? null : t;
  }

  function isFullCalendarYearSpan(start, end, y1) {
    return (
      start.getFullYear() === y1 &&
      end.getFullYear() === y1 &&
      start.getMonth() === 0 &&
      start.getDate() === 1 &&
      end.getMonth() === 11 &&
      end.getDate() === 31
    );
  }

  function isClassicSummerSpan(start, end, y1) {
    return (
      start.getFullYear() === y1 &&
      end.getFullYear() === y1 &&
      start.getMonth() === 5 &&
      start.getDate() === 1 &&
      end.getMonth() === 8 &&
      end.getDate() === 30
    );
  }

  function formatNlMonthRange(start, end) {
    const sm = start.getMonth();
    const em = end.getMonth();
    const sy = start.getFullYear();
    const ey = end.getFullYear();
    if (sy === ey) {
      if (sm === em) return `${MONTHS_NL_SHORT[sm]} ${sy}`;
      return `${MONTHS_NL_SHORT[sm]} – ${MONTHS_NL_SHORT[em]} ${sy}`;
    }
    return `${MONTHS_NL_SHORT[sm]} ${sy} – ${MONTHS_NL_SHORT[em]} ${ey}`;
  }

  function periodFilterDimNl(key) {
    switch (key) {
      case "week":
        return "week";
      case "kwartaal":
        return "kwartaal";
      default:
        return "maand";
    }
  }

  /** Maandag van ISO-week (UTC) */
  function isoWeekMondayUtc(isoYear, weekNum) {
    const w = Number(weekNum);
    const y = Number(isoYear);
    if (!Number.isFinite(w) || !Number.isFinite(y)) return null;
    const jan4 = Date.UTC(y, 0, 4);
    const jan4d = new Date(jan4);
    const dow = jan4d.getUTCDay() || 7;
    const monday = jan4 - (dow - 1) * 86400000;
    return new Date(monday + (w - 1) * 7 * 86400000);
  }

  /** Maandafkorting op basis van het midden van de week (donderdag). */
  function monthShortFromIsoBucket(bucketNum) {
    const n = Number(bucketNum);
    if (!Number.isFinite(n)) return "";
    const isoYear = Math.floor(n / 100);
    const week = n % 100;
    const mon = isoWeekMondayUtc(isoYear, week);
    if (!mon) return "";
    const mid = new Date(mon.getTime() + 3 * 86400000);
    return MONTHS_NL_SHORT[mid.getUTCMonth()] || "";
  }

  function formatTrendXLabel(row, periodNorm) {
    const raw = row.bucket_label != null ? String(row.bucket_label) : "";
    if (periodNorm === "week") {
      const mo = monthShortFromIsoBucket(row.bucket_num);
      if (mo && raw) return `${raw} · ${mo}`;
      return raw || String(row.bucket_num ?? "");
    }
    return raw || String(row.bucket_num ?? "");
  }

  /**
   * @param {Record<string, unknown>} row
   * @param {string} metric
   * @param {"current" | "compare"} which
   */
  function pickTrendValue(row, metric, which) {
    const cur = which === "current";
    if (metric === "pax") return Number(cur ? row.current_pax : row.compare_pax);
    if (metric === "omzet") return Number(cur ? row.current_omzet : row.compare_omzet);
    if (metric === "boekingen") return Number(cur ? row.current_boekingen : row.compare_boekingen);
    if (metric === "gem_prijs") {
      const pax = Number(cur ? row.current_pax : row.compare_pax);
      const omz = Number(cur ? row.current_omzet : row.compare_omzet);
      if (!pax) return 0;
      return omz / pax;
    }
    return 0;
  }

  function trendYAxisMax(list, metric) {
    let maxVal = 0;
    for (const row of list) {
      const a = pickTrendValue(row, metric, "current");
      const b = pickTrendValue(row, metric, "compare");
      if (Number.isFinite(a) && a > maxVal) maxVal = a;
      if (Number.isFinite(b) && b > maxVal) maxVal = b;
    }
    if (maxVal <= 0) return 1;
    return maxVal * 1.06;
  }

  function clampTrendStart(start, totalLen, windowSize) {
    const maxStart = Math.max(0, totalLen - windowSize);
    return Math.max(0, Math.min(maxStart, start));
  }

  function syncTrendNav(totalLen, windowSize) {
    const L = els.trendScrollLeft;
    const R = els.trendScrollRight;
    const lab = els.trendRangeLabel;
    if (lab && trendFullList.length) {
      const slice = trendFullList.slice(trendWindowStart, trendWindowStart + windowSize);
      const meta = lastPayload?.meta || {};
      const p = meta.period || els.period?.value || "maand";
      const labels = slice.map((r) => formatTrendXLabel(r, p));
      if (labels.length === 0) lab.textContent = "";
      else if (labels.length === 1) lab.textContent = labels[0];
      else lab.textContent = `${labels[0]} – ${labels[labels.length - 1]}`;
    } else if (lab) {
      lab.textContent = "";
    }
    const maxStart = Math.max(0, totalLen - windowSize);
    if (L) L.disabled = totalLen <= windowSize || trendWindowStart <= 0;
    if (R) R.disabled = totalLen <= windowSize || trendWindowStart >= maxStart;
  }

  function drawTrendChartWindow() {
    destroy(trendChart);
    trendChart = null;
    const canvas = els.trendChartCanvas;
    if (!canvas || trendFullList.length === 0) return;
    const meta = lastPayload?.meta || {};
    const periodNorm = meta.period || els.period?.value || "maand";
    const metric = getTrendKpi();
    const y1 = getY1();
    const y2 = getY2();
    const w = Math.min(VG_TREND_WINDOW, trendFullList.length);
    trendWindowStart = clampTrendStart(trendWindowStart, trendFullList.length, w);
    const slice = trendFullList.slice(trendWindowStart, trendWindowStart + w);
    const labels = slice.map((r) => formatTrendXLabel(r, periodNorm));
    const currentVals = slice.map((r) => pickTrendValue(r, metric, "current"));
    const compareVals = slice.map((r) => pickTrendValue(r, metric, "compare"));
    const yMaxFixed = trendYAxisMax(trendFullList, metric);
    const isMoney = metric === "omzet" || metric === "gem_prijs";

    const metricLabel =
      metric === "pax"
        ? "Pax"
        : metric === "omzet"
          ? "Omzet"
          : metric === "boekingen"
            ? "Boekingen"
            : "Gem. prijs";

    trendChart = new Chart(canvas, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: `${y1} · ${metricLabel}`,
            data: currentVals,
            borderColor: "#ea580c",
            backgroundColor: "#ea580c",
            tension: 0.25,
          },
          {
            label: `${y2} · ${metricLabel}`,
            data: compareVals,
            borderColor: "#475569",
            backgroundColor: "#475569",
            tension: 0.25,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 280, easing: "easeOutQuart" },
        scales: {
          x: {
            ticks: { autoSkip: true, maxRotation: periodNorm === "week" ? 38 : 32, minRotation: 0 },
          },
          y: {
            beginAtZero: true,
            min: 0,
            max: yMaxFixed,
            ticks: {
              callback: (v) => (isMoney ? nfMoney.format(Number(v)) : nfInt.format(Number(v))),
            },
          },
        },
        plugins: {
          legend: {
            position: "bottom",
            labels: { boxWidth: 12, padding: 8, font: { size: 11 } },
          },
          tooltip: {
            callbacks: {
              label(ctx) {
                const raw = Number(ctx.parsed.y);
                const t = isMoney ? nfMoney.format(raw) : nfInt.format(Math.round(raw));
                return ` ${ctx.dataset.label}: ${t}`;
              },
            },
          },
        },
      },
    });
    syncTrendNav(trendFullList.length, w);
    requestAnimationFrame(() => trendChart && trendChart.resize());
  }

  function trendNavStep(dir) {
    if (!trendFullList.length) return;
    const w = Math.min(VG_TREND_WINDOW, trendFullList.length);
    const maxStart = Math.max(0, trendFullList.length - w);
    const step = Math.min(VG_TREND_NAV_STEP, w);
    if (dir < 0) {
      trendWindowStart = clampTrendStart(trendWindowStart - step, trendFullList.length, w);
    } else {
      trendWindowStart = Math.min(maxStart, trendWindowStart + step);
    }
    drawTrendChartWindow();
  }

  function updatePeriodSection(payload) {
    const meta = payload?.meta || {};
    const y1 = Number(meta.current_year || getY1());
    const y2 = Number(meta.compare_year || getY2());
    const start = parseMetaDate(meta.current_start);
    const end = parseMetaDate(meta.current_end);
    const periodKey = meta.period || els.period?.value || "maand";
    const dateType = meta.date_type === "vertrekdatum" ? "vertrekdatum" : "boekingsdatum";

    let title = "Per maand";
    if (start && end && Number.isFinite(y1) && !Number.isNaN(y1)) {
      if (isFullCalendarYearSpan(start, end, y1)) {
        title = `Per maand — volledig jaar ${y1}`;
      } else if (isClassicSummerSpan(start, end, y1)) {
        title = "Zomer (juni–september) per maand";
      } else {
        title = `Per maand: ${formatNlMonthRange(start, end)}`;
      }
    }

    const rangeTxt = start && end ? formatNlMonthRange(start, end) : "de gekozen range";
    const subt =
      Number.isFinite(y1) && Number.isFinite(y2) && !Number.isNaN(y1) && !Number.isNaN(y2)
        ? `Maandtotalen op ${dateType} binnen ${rangeTxt}. Pax, omzet en winst voor ${y1}; Δ pax, Δ omzet en Δ winst t.o.v. ${y2} (zelfde maand). Tijdsfilter: ${periodFilterDimNl(periodKey)}.`
        : "—";

    if (els.periodCardTitle) els.periodCardTitle.textContent = title;
    if (els.periodCardSubtitle) els.periodCardSubtitle.textContent = subt;
  }

  function updateYearChrome() {
    const y1 = getY1() || "—";
    const y2 = getY2() || "—";
    if (els.yearLabelPrimary) els.yearLabelPrimary.textContent = y1 === "—" ? "Primair jaar" : `${y1} · primair`;
    if (els.yearLabelRef) els.yearLabelRef.textContent = y2 === "—" ? "Referentiejaar" : `${y2} · referentie`;
    if (els.countryCardY1) els.countryCardY1.textContent = y1;
    if (els.countryCardY2) els.countryCardY2.textContent = y2;
    if (els.leadLblY1) els.leadLblY1.textContent = y1 === "—" ? "Gem. voorloop (dagen)" : `Gem. voorloop ${y1} (dagen)`;
    if (els.leadLblY2) els.leadLblY2.textContent = y2 === "—" ? "Gem. voorloop referentie (dagen)" : `Gem. voorloop ${y2} (dagen)`;
    if (els.trendSubtitle) {
      els.trendSubtitle.textContent =
        y1 !== "—" && y2 !== "—"
          ? `Zelfde ${periodNlLabel()}: ${y1} tegenover ${y2}. Kies hieronder welke KPI de lijnen tonen.`
          : "Vergelijking tussen beide jaartallen binnen dezelfde periode-indeling.";
    }
    if (els.tempoSubtitle) {
      els.tempoSubtitle.textContent =
        y1 !== "—" && y2 !== "—"
          ? `Cumulatief opgebouwde pax per ISO-week: ${y1} vs ${y2}.`
          : "Cumulatieve curve per ISO-week voor beide jaren.";
    }
  }

  const syncComparisonContext = () => {
    updateYearChrome();
    if (!els.context) return;
    const dateTypeLabel = els.dateType.value === "vertrekdatum" ? "vertrekdatum" : "boekingsdatum";
    const y1 = getY1();
    const y2 = getY2();
    if (!y1 || !y2) {
      els.context.textContent = "Selecteer twee jaartallen en klik op Toepassen.";
      return;
    }
    els.context.textContent = `Je vergelijkt ${y1} met ${y2} op basis van ${dateTypeLabel} en ${periodNlLabel()}.`;
  };

  const ensureDifferentYears = () => {
    if (!els.currentYear.value || !els.compareYear.value) return;
    if (els.currentYear.value !== els.compareYear.value) return;
    const opts = Array.from(els.compareYear.options)
      .map((o) => o.value)
      .filter((v) => v && v !== els.currentYear.value);
    if (opts.length) els.compareYear.value = opts[0];
  };

  const setMetricCard = (key, current, compare, formatter, compareYearStr) => {
    const elCurrent = document.getElementById(`vgKpi${key}Current`);
    const elCompare = document.getElementById(`vgKpi${key}Compare`);
    const elDelta = document.getElementById(`vgKpi${key}Delta`);
    if (!elCurrent || !elCompare || !elDelta) return;
    const c = Number(current ?? 0);
    const p = Number(compare ?? 0);
    const d = c - p;
    const pct = p === 0 ? null : (d / p) * 100;
    elCurrent.textContent = formatter(c);
    const refLabel = compareYearStr || "Ref.";
    elCompare.textContent = `${refLabel}: ${formatter(p)}`;
    const pctPart = pct == null ? "" : ` (${d > 0 ? "+" : ""}${nfPctEvolution.format(pct)}%)`;
    const isMoneyMetric = key === "Omzet" || key === "GemPrijs";
    const deltaFormatted = isMoneyMetric ? `${d >= 0 ? "+" : "-"}${nfMoney.format(Math.abs(d))}` : `${formatSignedInt(d)}`;
    elDelta.textContent = `${deltaFormatted}${pctPart}`;
    elDelta.classList.remove("vg-delta-up", "vg-delta-down", "vg-delta-neutral", "sp-text--pos", "sp-text--neg", "sp-text--neutral");
    elDelta.classList.add(deltaClass(d));
  };

  const renderKpis = (payload) => {
    const k = payload?.kpis || {};
    const y2 = getY2() || "—";
    setMetricCard("Pax", k?.pax?.current, k?.pax?.compare, (v) => nfInt.format(Math.round(v)), y2);
    setMetricCard("Omzet", k?.omzet?.current, k?.omzet?.compare, (v) => nfMoney.format(v), y2);
    setMetricCard("GemPrijs", k?.gem_prijs?.current, k?.gem_prijs?.compare, (v) => nfMoney.format(v), y2);
    setMetricCard("Boekingen", k?.boekingen?.current, k?.boekingen?.compare, (v) => nfInt.format(Math.round(v)), y2);
  };

  function renderTrend(payload) {
    trendFullList = Array.isArray(payload?.trend) ? payload.trend : [];
    trendWindowStart = 0;
    setEmpty(els.trendEmpty, trendFullList.length === 0);
    if (!els.trendChartCanvas || trendFullList.length === 0) {
      destroy(trendChart);
      trendChart = null;
      syncTrendNav(0, VG_TREND_WINDOW);
      return;
    }
    drawTrendChartWindow();
  }

  function writeDestinationHead(y1, y2) {
    if (!els.destinationHead) return;
    els.destinationHead.innerHTML = `<tr>
      <th scope="col" class="vg-col-text" data-sort="bestemming">Bestemming</th>
      <th scope="col" class="text-end text-nowrap" data-sort="current_pax" data-sort-type="number">Pax ${y1}</th>
      <th scope="col" class="text-end text-nowrap" data-sort="previous_pax" data-sort-type="number">Pax ${y2}</th>
      <th scope="col" class="text-end text-nowrap" data-sort="delta" data-sort-type="number">Δ pax</th>
      <th scope="col" class="text-end text-nowrap" data-sort="delta_pct" data-sort-type="number">Δ %</th>
    </tr>`;
  }

  function writeDoelgroepHead(y1, y2) {
    if (!els.doelgroepHead) return;
    els.doelgroepHead.innerHTML = `<tr>
      <th scope="col" class="vg-col-text" data-sort="doelgroep">Doelgroep</th>
      <th scope="col" class="text-end text-nowrap" data-sort="current_pax" data-sort-type="number">Pax ${y1}</th>
      <th scope="col" class="text-end text-nowrap" data-sort="previous_pax" data-sort-type="number">Pax ${y2}</th>
      <th scope="col" class="text-end text-nowrap" data-sort="delta" data-sort-type="number">Δ pax</th>
      <th scope="col" class="text-end text-nowrap" data-sort="delta_pct" data-sort-type="number">Δ %</th>
    </tr>`;
  }

  function writeCountryHead(y1, y2) {
    if (!els.countryHead) return;
    els.countryHead.innerHTML = `<tr>
      <th scope="col" class="vg-col-land text-start" data-sort="land">Landgroep</th>
      <th scope="col" class="text-end text-nowrap vg-country-col-pax" data-sort="current_reizigers" data-sort-type="number">Pax ${y1}</th>
      <th scope="col" class="text-end text-nowrap vg-country-col-pax" data-sort="previous_reizigers" data-sort-type="number">Pax ${y2}</th>
      <th scope="col" class="text-end text-nowrap vg-country-col-share" data-sort="share_cur" data-sort-type="number">Aandeel ${y1}</th>
      <th scope="col" class="text-end text-nowrap vg-country-col-delta" data-sort="dPax" data-sort-type="number">Δ pax</th>
      <th scope="col" class="text-end text-nowrap vg-country-col-delta" data-sort="dShare" data-sort-type="number" title="Verschil in aandeel (procentpunten)">Δ aandeel</th>
    </tr>`;
  }

  function writePeriodHead(y1, y2) {
    if (!els.periodHead) return;
    els.periodHead.innerHTML = `<tr>
      <th scope="col" class="vg-col-text" data-sort="period_key" data-sort-type="number">Maand</th>
      <th scope="col" class="text-end text-nowrap" data-sort="pax_current" data-sort-type="number">Pax ${y1}</th>
      <th scope="col" class="text-end text-nowrap" data-sort="omzet_current" data-sort-type="number">Omzet ${y1}</th>
      <th scope="col" class="text-end text-nowrap" data-sort="winst_current" data-sort-type="number">Winst ${y1}</th>
      <th scope="col" class="text-end text-nowrap" data-sort="delta_pax" data-sort-type="number">Δ pax</th>
      <th scope="col" class="text-end text-nowrap" data-sort="delta_omzet" data-sort-type="number">Δ omzet</th>
      <th scope="col" class="text-end text-nowrap" data-sort="delta_winst" data-sort-type="number">Δ winst</th>
    </tr>`;
  }

  function writeYearSummaryHead() {
    if (!els.yearHead) return;
    els.yearHead.innerHTML = `<tr>
      <th scope="col" data-sort="yr" data-sort-type="number">Jaar</th>
      <th scope="col" class="text-end" data-sort="pax" data-sort-type="number">Pax</th>
      <th scope="col" class="text-end" data-sort="omzet" data-sort-type="number">Omzet</th>
      <th scope="col" class="text-end" data-sort="winst" data-sort-type="number">Winst</th>
      <th scope="col" class="text-end" data-sort="boekingen" data-sort-type="number">Boekingen</th>
      <th scope="col" class="text-end" data-sort="delta_pax_yoy" data-sort-type="number">Δ pax t.o.v. v.j.</th>
      <th scope="col" class="text-end" data-sort="delta_omzet_yoy" data-sort-type="number">Δ omzet t.o.v. v.j.</th>
      <th scope="col" class="text-end" data-sort="delta_winst_yoy" data-sort-type="number">Δ winst t.o.v. v.j.</th>
    </tr>`;
  }

  function normalizeDestinationRows(rows) {
    const list = Array.isArray(rows) ? rows : [];
    return list.map((row) => {
      const cur = Number(row.current_pax || 0);
      const prev = Number(row.previous_pax || 0);
      const delta = cur - prev;
      const deltaPct =
        row.delta_pct == null || row.delta_pct === undefined ? (prev === 0 ? null : ((cur - prev) / prev) * 100) : Number(row.delta_pct);
      return {
        ...row,
        current_pax: cur,
        previous_pax: prev,
        delta,
        delta_pct: deltaPct,
      };
    });
  }

  function renderDestinationTable(rows) {
    const body = document.getElementById("vgDestinationDeltaBody");
    if (!body) return;
    body.innerHTML = "";
    rows.forEach((row) => {
      const cur = Number(row.current_pax || 0);
      const prev = Number(row.previous_pax || 0);
      const delta = Number(row.delta);
      const deltaPct = row.delta_pct;
      const pctStr = formatDeltaPct(deltaPct, prev);
      const label = row.bestemming || "—";
      const pctCls = pctStr === "—" ? "vg-delta-neutral" : deltaClass(delta);
      const pctHtml = pctStr === "—" ? "—" : `${deltaArrow(delta)}${pctStr}`;
      body.insertAdjacentHTML(
        "beforeend",
        `<tr>
          <td class="vg-col-text">${escapeHtml(String(label))}</td>
          <td class="text-end vg-num">${nfInt.format(Math.round(cur))}</td>
          <td class="text-end vg-num">${nfInt.format(Math.round(prev))}</td>
          <td class="text-end vg-num"><span class="${deltaClass(delta)}">${deltaArrow(delta)}${formatSignedInt(delta)}</span></td>
          <td class="text-end vg-num"><span class="${pctCls}">${pctHtml}</span></td>
        </tr>`
      );
    });
  }

  function renderDoelgroepTable(rows) {
    const body = document.getElementById("vgDoelgroepBody");
    if (!body) return;
    body.innerHTML = "";
    rows.forEach((row) => {
      const cur = Number(row.current_pax || 0);
      const prev = Number(row.previous_pax || 0);
      const delta = Number(row.delta);
      const deltaPct = row.delta_pct;
      const pctStr = formatDeltaPct(deltaPct, prev);
      const label = row.doelgroep || "—";
      const pctCls = pctStr === "—" ? "vg-delta-neutral" : deltaClass(delta);
      const pctHtml = pctStr === "—" ? "—" : `${deltaArrow(delta)}${pctStr}`;
      body.insertAdjacentHTML(
        "beforeend",
        `<tr>
          <td class="vg-col-text">${escapeHtml(String(label))}</td>
          <td class="text-end vg-num">${nfInt.format(Math.round(cur))}</td>
          <td class="text-end vg-num">${nfInt.format(Math.round(prev))}</td>
          <td class="text-end vg-num"><span class="${deltaClass(delta)}">${deltaArrow(delta)}${formatSignedInt(delta)}</span></td>
          <td class="text-end vg-num"><span class="${pctCls}">${pctHtml}</span></td>
        </tr>`
      );
    });
  }

  function renderYearSummaryTable(rows) {
    const body = document.getElementById("vgYearSummaryBody");
    if (!body) return;
    body.innerHTML = "";
    rows.forEach((r) => {
      const fmtDelta = (v) => {
        if (v == null || Number.isNaN(Number(v))) return "—";
        const n = Number(v);
        return `<span class="${deltaClass(n)}">${deltaArrow(n)}${nfMoney.format(Math.abs(n))}</span>`;
      };
      const fmtDeltaPax = (v) => {
        if (v == null || Number.isNaN(Number(v))) return "—";
        const n = Number(v);
        return `<span class="${deltaClass(n)}">${deltaArrow(n)}${formatSignedInt(n)}</span>`;
      };
      body.insertAdjacentHTML(
        "beforeend",
        `<tr>
          <td>${r.yr}</td>
          <td class="text-end vg-num">${nfInt.format(Math.round(Number(r.pax || 0)))}</td>
          <td class="text-end vg-num">${nfMoney.format(Number(r.omzet || 0))}</td>
          <td class="text-end vg-num">${nfMoney.format(Number(r.winst || 0))}</td>
          <td class="text-end vg-num">${nfInt.format(Math.round(Number(r.boekingen || 0)))}</td>
          <td class="text-end vg-num">${fmtDeltaPax(r.delta_pax_yoy)}</td>
          <td class="text-end vg-num">${fmtDelta(r.delta_omzet_yoy)}</td>
          <td class="text-end vg-num">${fmtDelta(r.delta_winst_yoy)}</td>
        </tr>`
      );
    });
  }

  function wireDestinationSort() {
    const table = document.getElementById("vgTableDestination");
    if (!table) return;
    if (!wireSortableTable) return;
    wireSortableTable(
      table,
      () => normalizeDestinationRows(lastPayload?.destination_delta),
      (rows) => renderDestinationTable(rows)
    );
  }

  function wireDoelgroepSort() {
    const table = document.getElementById("vgTableDoelgroep");
    if (!table) return;
    if (!wireSortableTable) return;
    wireSortableTable(
      table,
      () => normalizeDestinationRows(lastPayload?.doelgroep_delta),
      (rows) => renderDoelgroepTable(rows)
    );
  }

  function wirePeriodSort() {
    const table = document.getElementById("vgTablePeriod");
    if (!table) return;
    if (!wireSortableTable) return;
    wireSortableTable(
      table,
      () => {
        const rows = Array.isArray(lastPayload?.period_compare) ? lastPayload.period_compare : [];
        return rows.map((row) => {
          const paxC = Number(row.pax_current || 0);
          const paxP = Number(row.pax_previous || 0);
          return {
            ...row,
            period_key: Number(row.period_key),
            pax_current: paxC,
            pax_previous: paxP,
            omzet_current: Number(row.omzet_current || 0),
            winst_current: Number(row.winst_current || 0),
            delta_pax: paxC - paxP,
            delta_omzet: Number(row.delta_omzet || 0),
            delta_winst: Number(row.delta_winst || 0),
          };
        });
      },
      (rows) => renderPeriodCompareBody(rows)
    );
  }

  function wireYearSort() {
    const table = document.getElementById("vgTableYearSummary");
    if (!table) return;
    if (!wireSortableTable) return;
    wireSortableTable(
      table,
      () => {
        const rows = Array.isArray(lastPayload?.year_summary) ? lastPayload.year_summary : [];
        return rows.map((r) => ({
          yr: Number(r.yr),
          pax: Number(r.pax || 0),
          omzet: Number(r.omzet || 0),
          winst: Number(r.winst || 0),
          boekingen: Number(r.boekingen || 0),
          delta_pax_yoy: r.delta_pax_yoy == null ? null : Number(r.delta_pax_yoy),
          delta_omzet_yoy: r.delta_omzet_yoy == null ? null : Number(r.delta_omzet_yoy),
          delta_winst_yoy: r.delta_winst_yoy == null ? null : Number(r.delta_winst_yoy),
        }));
      },
      (rows) => renderYearSummaryTable(rows)
    );
  }

  function renderPeriodCompareBody(rows) {
    const body = document.getElementById("vgPeriodCompareBody");
    if (!body) return;
    body.innerHTML = "";
    const m = ["", "Jan", "Feb", "Mrt", "Apr", "Mei", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dec"];
    rows.forEach((row) => {
      const dPax = Number(row.delta_pax != null ? row.delta_pax : Number(row.pax_current || 0) - Number(row.pax_previous || 0));
      const dOmz = Number(row.delta_omzet || 0);
      const dWin = Number(row.delta_winst || 0);
      body.insertAdjacentHTML(
        "beforeend",
        `<tr>
          <td class="vg-col-text">${m[Number(row.maand || 0)]}</td>
          <td class="text-end vg-num">${nfInt.format(Math.round(Number(row.pax_current || 0)))}</td>
          <td class="text-end vg-num">${nfMoney.format(Number(row.omzet_current || 0))}</td>
          <td class="text-end vg-num">${nfMoney.format(Number(row.winst_current || 0))}</td>
          <td class="text-end vg-num"><span class="${deltaClass(dPax)}">${deltaArrow(dPax)}${formatSignedInt(dPax)}</span></td>
          <td class="text-end vg-num"><span class="${deltaClass(dOmz)}">${deltaArrow(dOmz)}${nfMoney.format(Math.abs(dOmz))}</span></td>
          <td class="text-end vg-num"><span class="${deltaClass(dWin)}">${deltaArrow(dWin)}${nfMoney.format(Math.abs(dWin))}</span></td>
        </tr>`
      );
    });
    setEmpty(els.periodEmpty, rows.length === 0);
  }

  function wireCountrySortAndRows(payload) {
    const table = document.getElementById("vgTableCountry");
    const body = document.getElementById("vgCountryMixBody");
    if (!table || !body || !wireSortableTable) return;
    destroy(countryChart);
    countryChart = null;
    const rowsRaw = Array.isArray(payload?.country_mix) ? payload.country_mix : [];
    setEmpty(els.countryEmpty, rowsRaw.length === 0);
    const y1 = getY1();
    const y2 = getY2();
    writeCountryHead(y1, y2);

    const currentVals = rowsRaw.map((x) => Number(x.current_reizigers || 0));
    const previousVals = rowsRaw.map((x) => Number(x.previous_reizigers || 0));
    const curTotal = currentVals.reduce((a, b) => a + b, 0);
    const prevTotalAll = previousVals.reduce((a, b) => a + b, 0);

    const rows = rowsRaw.map((row, i) => {
      const cur = currentVals[i];
      const prev = previousVals[i];
      const shareCur = curTotal > 0 ? (cur / curTotal) * 100 : 0;
      const sharePrev = prevTotalAll > 0 ? (prev / prevTotalAll) * 100 : 0;
      return {
        land: row.land,
        current_reizigers: cur,
        previous_reizigers: prev,
        share_cur: shareCur,
        dPax: cur - prev,
        dShare: shareCur - sharePrev,
      };
    });

    function renderCountryBody(sortedRows) {
      body.innerHTML = "";
      sortedRows.forEach((row) => {
        const isOverig = String(row.land) === "Overig";
        const cellLand = isOverig
          ? `<button type="button" class="vg-overig-btn" data-vg-overig="1">${escapeHtml(String(row.land))}</button>`
          : escapeHtml(String(row.land));
        body.insertAdjacentHTML(
          "beforeend",
          `<tr>
            <td class="vg-col-land text-start">${cellLand}</td>
            <td class="text-end vg-num">${nfInt.format(Math.round(row.current_reizigers))}</td>
            <td class="text-end vg-num">${nfInt.format(Math.round(row.previous_reizigers))}</td>
            <td class="text-end vg-num">${formatSharePct(row.share_cur)}</td>
            <td class="text-end vg-num"><span class="${deltaClass(row.dPax)}">${deltaArrow(row.dPax)}${formatSignedInt(row.dPax)}</span></td>
            <td class="text-end vg-num"><span class="${deltaClass(row.dShare)}">${formatPpDelta(row.dShare)}</span></td>
          </tr>`
        );
      });
      body.querySelectorAll(".vg-overig-btn").forEach((btn) => {
        btn.addEventListener("click", () => openOverigModal(payload));
      });
    }

    renderCountryBody(rows);

    if (!els.countryChartCanvas || rowsRaw.length === 0) return;
    const labels = rowsRaw.map((x) => x.land);
    let fallbackIdx = 0;
    const colors = labels.map((label) => {
      const fallback = COUNTRY_FALLBACK_COLORS[fallbackIdx % COUNTRY_FALLBACK_COLORS.length];
      const chosen = countryColors?.colorForCountry ? countryColors.colorForCountry(label, fallback) : fallback;
      if (chosen === fallback) fallbackIdx += 1;
      return chosen;
    });
    const hoverColors = labels.map((label, i) => {
      const fallback = colors[i];
      return countryColors?.hoverColorForCountry ? countryColors.hoverColorForCountry(label, fallback) : fallback;
    });
    countryChart = new Chart(els.countryChartCanvas, {
      type: "doughnut",
      data: {
        labels,
        datasets: [
          {
            data: currentVals,
            backgroundColor: colors,
            hoverBackgroundColor: hoverColors,
            borderWidth: 2,
            borderColor: "#ffffff",
            hoverOffset: 4,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: "58%",
        layout: {
          padding: { top: 2, bottom: 8, left: 2, right: 2 },
        },
        plugins: {
          title: {
            display: true,
            text: `Verdeling ${y1}`,
            color: "#64748b",
            font: { size: 11, weight: "600" },
            padding: { bottom: 4, top: 0 },
          },
          legend: {
            position: "bottom",
            align: "center",
            labels: {
              boxWidth: 10,
              padding: 8,
              font: { size: 11 },
              generateLabels: (chart) => {
                const ds = chart.data.datasets[0];
                const lbls = chart.data.labels || [];
                const total = (ds.data || []).reduce((a, b) => a + Number(b || 0), 0);
                return lbls.map((label, i) => {
                  const raw = Number(ds.data[i] || 0);
                  const pct = total > 0 ? (raw / total) * 100 : 0;
                  const fill = Array.isArray(ds.backgroundColor) ? ds.backgroundColor[i] : ds.backgroundColor;
                  return {
                    text: `${label} · ${nfShare.format(pct)}%`,
                    fillStyle: fill,
                    strokeStyle: fill,
                    fontColor: "#475569",
                    hidden: false,
                    index: i,
                  };
                });
              },
            },
          },
          tooltip: {
            callbacks: {
              label(ctx) {
                const raw = Number(ctx.raw || 0);
                const total = ctx.dataset.data.reduce((a, b) => a + Number(b || 0), 0);
                const pct = total > 0 ? (raw / total) * 100 : 0;
                return ` ${ctx.label}: ${nfInt.format(Math.round(raw))} pax (${nfShare.format(pct)}%)`;
              },
            },
          },
        },
      },
    });

    if (wireSortableTable) {
      wireSortableTable(table, () => rows, (sorted) => renderCountryBody(sorted));
    }
  }

  function openOverigModal(payload) {
    const br = payload?.land_other_breakdown || {};
    const cur = Array.isArray(br.current) ? br.current : [];
    const cmp = Array.isArray(br.compare) ? br.compare : [];
    const y1 = getY1();
    const y2 = getY2();
    if (els.overigModalY1) els.overigModalY1.textContent = `Primair jaar (${y1})`;
    if (els.overigModalY2) els.overigModalY2.textContent = `Referentiejaar (${y2})`;
    if (els.overigModalContext) {
      els.overigModalContext.textContent = `Reizigers met land buiten BE/NL — zelfde filters als de pagina.`;
    }
    const sumCur = cur.reduce((s, x) => s + Number(x.reizigers || 0), 0);
    const sumCmp = cmp.reduce((s, x) => s + Number(x.reizigers || 0), 0);

    const fillBody = (tbody, list, total) => {
      if (!tbody) return;
      tbody.innerHTML = "";
      if (!list.length) {
        tbody.innerHTML = `<tr><td colspan="3" class="text-muted small">Geen gegevens voor Overig.</td></tr>`;
        return;
      }
      list.forEach((x) => {
        const n = Number(x.reizigers || 0);
        const pct = total > 0 ? (n / total) * 100 : 0;
        tbody.insertAdjacentHTML(
          "beforeend",
          `<tr>
            <td>${escapeHtml(String(x.land || "—"))}</td>
            <td class="text-end">${nfInt.format(Math.round(n))}</td>
            <td class="text-end">${nfShare.format(pct)}%</td>
          </tr>`
        );
      });
    };
    fillBody(els.overigBodyCurrent, cur, sumCur);
    fillBody(els.overigBodyCompare, cmp, sumCmp);

    const Modal = globalThis.bootstrap?.Modal;
    if (els.overigModal && Modal) {
      Modal.getOrCreateInstance(els.overigModal).show();
    }
  }

  const renderPeriodCompare = (payload) => {
    const rows = Array.isArray(payload?.period_compare) ? payload.period_compare : [];
    const mapped = rows.map((row) => {
      const paxC = Number(row.pax_current || 0);
      const paxP = Number(row.pax_previous || 0);
      return {
        ...row,
        period_key: Number(row.period_key),
        pax_current: paxC,
        pax_previous: paxP,
        omzet_current: Number(row.omzet_current || 0),
        winst_current: Number(row.winst_current || 0),
        delta_pax: paxC - paxP,
        delta_omzet: Number(row.delta_omzet || 0),
        delta_winst: Number(row.delta_winst || 0),
      };
    });
    writePeriodHead(getY1(), getY2());
    renderPeriodCompareBody(mapped);
    wirePeriodSort();
  };

  const renderYearSummary = (payload) => {
    const rows = Array.isArray(payload?.year_summary) ? payload.year_summary : [];
    setEmpty(els.yearEmpty, rows.length === 0);
    writeYearSummaryHead();
    renderYearSummaryTable(
      rows.map((r) => ({
        yr: Number(r.yr),
        pax: Number(r.pax || 0),
        omzet: Number(r.omzet || 0),
        winst: Number(r.winst || 0),
        boekingen: Number(r.boekingen || 0),
        delta_pax_yoy: r.delta_pax_yoy == null ? null : Number(r.delta_pax_yoy),
        delta_omzet_yoy: r.delta_omzet_yoy == null ? null : Number(r.delta_omzet_yoy),
        delta_winst_yoy: r.delta_winst_yoy == null ? null : Number(r.delta_winst_yoy),
      }))
    );
    wireYearSort();
  };

  const renderTempo = (payload) => {
    destroy(tempoChart);
    tempoChart = null;
    const rows = Array.isArray(payload?.booking_tempo) ? payload.booking_tempo : [];
    setEmpty(els.tempoEmpty, rows.length === 0);
    if (!els.bookingTempoChartCanvas || rows.length === 0) return;
    const y1 = getY1();
    const y2 = getY2();
    const labels = rows.map((x) => `W${x.iso_week}`);
    const currentVals = rows.map((x) => Number(x.current_cum_pax || 0));
    const compareVals = rows.map((x) => Number(x.previous_cum_pax || 0));
    tempoChart = new Chart(els.bookingTempoChartCanvas, {
      type: "line",
      data: {
        labels,
        datasets: [
          { label: `${y1}`, data: currentVals, borderColor: "#ea580c", tension: 0.25 },
          { label: `${y2}`, data: compareVals, borderColor: "#475569", tension: 0.25 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: { y: { beginAtZero: true } },
        plugins: {
          legend: {
            position: "bottom",
            labels: { boxWidth: 12, padding: 8, font: { size: 11 } },
          },
        },
      },
    });
    const lead = payload?.leadtime_summary || {};
    const cur = Number(lead.current_avg_days || 0);
    const prev = Number(lead.previous_avg_days || 0);
    const delta = cur - prev;
    const leadCurrent = document.getElementById("vgLeadCurrent");
    const leadPrev = document.getElementById("vgLeadPrevious");
    const leadDelta = document.getElementById("vgLeadDelta");
    if (leadCurrent) leadCurrent.textContent = `${nfPp.format(cur)} dagen`;
    if (leadPrev) leadPrev.textContent = `${nfPp.format(prev)} dagen`;
    if (leadDelta) {
      leadDelta.textContent = `${formatSignedInt(delta)} dagen`;
      leadDelta.classList.remove("vg-delta-up", "vg-delta-down", "vg-delta-neutral", "sp-text--pos", "sp-text--neg", "sp-text--neutral");
      leadDelta.classList.add(deltaClass(delta));
    }
  };

  const renderAll = (payload) => {
    lastPayload = payload;
    const y1 = getY1();
    const y2 = getY2();
    renderKpis(payload);
    renderTrend(payload);
    const destRows = normalizeDestinationRows(payload?.destination_delta);
    setEmpty(els.destinationEmpty, destRows.length === 0);
    writeDestinationHead(y1, y2);
    renderDestinationTable(destRows);
    wireDestinationSort();

    const dgRows = normalizeDestinationRows(payload?.doelgroep_delta);
    setEmpty(els.doelgroepEmpty, dgRows.length === 0);
    writeDoelgroepHead(y1, y2);
    renderDoelgroepTable(dgRows);
    wireDoelgroepSort();

    wireCountrySortAndRows(payload);
    renderPeriodCompare(payload);
    updatePeriodSection(payload);
    renderYearSummary(payload);
    renderTempo(payload);
    syncComparisonContext();
  };

  const loadOptions = async () => {
    const data = await fetchJson(API_OPTIONS);
    const brands = Array.isArray(data?.brands) ? data.brands : [];
    const bestemmingen = Array.isArray(data?.bestemmingen) ? data.bestemmingen : [];
    els.brand.innerHTML = `<option value="${brandAll}" selected>Alle merken</option>`;
    brands.forEach((b) => els.brand.insertAdjacentHTML("beforeend", `<option value="${b}">${b}</option>`));
    els.destinations.innerHTML = `<option value="__all__" selected>Alle bestemmingen</option>`;
    bestemmingen.forEach((d) =>
      els.destinations.insertAdjacentHTML("beforeend", `<option value="${d.id}">${d.naam}</option>`)
    );
    if (!vgDestMulti && typeof window.TAMultiSelectFilter === "function") {
      vgDestMulti = new window.TAMultiSelectFilter({
        selectEl: els.destinations,
        placeholderAll: "Alle bestemmingen",
        searchPlaceholder: "Zoek bestemming...",
        itemLabelSingle: "bestemming",
        itemLabelPlural: "bestemmingen geselecteerd",
      });
    } else {
      vgDestMulti?.syncOptionsFromSelect();
    }
    vgDestMulti?.setValue([]);
  };

  const loadYears = async () => {
    const params = new URLSearchParams();
    params.set("date_type", els.dateType.value);
    params.set("brand", els.brand.value || brandAll);
    const dest = selectedMulti(els.destinations);
    if (dest.length) params.set("bestemming_ids", dest.join(","));
    const yearsUrl = `${API_YEARS}?${params.toString()}`;
    const data = await fetchJson(yearsUrl);
    const years = Array.isArray(data?.years) ? data.years.map((y) => Number(y)).filter(Number.isFinite).sort((a, b) => b - a) : [];
    const yearOptions = years.map((y) => ({ id: String(y), naam: String(y) }));
    setOptions(els.currentYear, yearOptions);
    setOptions(els.compareYear, yearOptions);
    if (years.length > 0) {
      els.currentYear.value = String(years[0]);
      els.compareYear.value = String(years[1] ?? years[0]);
      ensureDifferentYears();
    }
    if (IS_RESTRICTED_ROLE) {
      els.currentYear.value = String(FORCED_YEAR);
      els.compareYear.value = String(FORCED_YEAR - 1);
      els.currentYear.disabled = true;
      els.compareYear.disabled = true;
    }
    syncComparisonContext();
  };

  const apply = async () => {
    showError("");
    ensureDifferentYears();
    if (!els.currentYear.value || !els.compareYear.value) {
      showError("Selecteer twee jaartallen.");
      return;
    }
    const params = new URLSearchParams();
    params.set("date_type", els.dateType.value);
    params.set("period", els.period.value);
    params.set("current_year", IS_RESTRICTED_ROLE ? String(FORCED_YEAR) : els.currentYear.value);
    params.set("compare_year", IS_RESTRICTED_ROLE ? String(FORCED_YEAR - 1) : els.compareYear.value);
    params.set("brand", els.brand.value || brandAll);
    const dest = selectedMulti(els.destinations);
    if (dest.length) params.set("bestemming_ids", dest.join(","));
    if (els.dateFrom.value) params.set("date_from", els.dateFrom.value);
    if (els.dateTo.value) params.set("date_to", els.dateTo.value);
    const payload = await fetchJson(`${API_DATA}?${params.toString()}`);
    renderAll(payload);
  };

  const reset = async () => {
    els.dateType.value = "boekingsdatum";
    els.period.value = "maand";
    if (els.trendKpi) els.trendKpi.value = "pax";
    els.brand.value = brandAll;
    els.dateFrom.value = "";
    els.dateTo.value = "";
    vgDestMulti?.clear();
    await loadYears();
    await apply();
  };

  [els.dateType, els.period, els.currentYear, els.compareYear].forEach((el) =>
    el &&
    el.addEventListener("change", () => {
      if (el === els.currentYear || el === els.compareYear) ensureDifferentYears();
      syncComparisonContext();
    })
  );
  [els.dateType, els.brand, els.destinations].forEach((el) =>
    el && el.addEventListener("change", () => loadYears().catch((e) => showError(e.message)))
  );
  els.applyBtn && els.applyBtn.addEventListener("click", () => apply().catch((e) => showError(e.message)));
  els.resetBtn && els.resetBtn.addEventListener("click", () => reset().catch((e) => showError(e.message)));

  els.trendScrollLeft && els.trendScrollLeft.addEventListener("click", () => trendNavStep(-1));
  els.trendScrollRight && els.trendScrollRight.addEventListener("click", () => trendNavStep(1));
  els.trendKpi &&
    els.trendKpi.addEventListener("change", () => {
      trendWindowStart = 0;
      drawTrendChartWindow();
    });

  (async () => {
    try {
      await loadOptions();
      await loadYears();
      await apply();
    } catch (e) {
      showError(e?.message || "Onbekende fout.");
    }
  })();
})();
