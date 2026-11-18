(() => {
  const els = {
    brandSelect: document.getElementById("brandSelect"),
    yearSelect: document.getElementById("yearSelect"),
    destinationSelect: document.getElementById("destinationSelect"),
    brandLandSelect: document.getElementById("brandLandSelect"),

    filtersApplyBtn: document.getElementById("filtersApplyBtn"),
    filtersResetBtn: document.getElementById("filtersResetBtn"),

    kpiBookings: document.getElementById("kpiBookings"),
    kpiTravellers: document.getElementById("kpiTravellers"),
    kpiRevenue: document.getElementById("kpiRevenue"),
    kpiAvgBookingSize: document.getElementById("kpiAvgBookingSize"),
    kpiAvgBookingSizeSub: document.getElementById("kpiAvgBookingSizeSub"),
    kpiBookingsYoy: document.getElementById("kpiBookingsYoy"),
    kpiTravellersYoy: document.getElementById("kpiTravellersYoy"),
    kpiRevenueYoy: document.getElementById("kpiRevenueYoy"),
    kpiAvgBookingSizeYoy: document.getElementById("kpiAvgBookingSizeYoy"),

    bookingTrendEmpty: document.getElementById("bookingTrendEmpty"),
    bookingTrendNavWrap: document.getElementById("bookingTrendNavWrap"),
    bookingTrendScrollLeft: document.getElementById("bookingTrendScrollLeft"),
    bookingTrendScrollRight: document.getElementById("bookingTrendScrollRight"),
    bookingTrendRangeLabel: document.getElementById("bookingTrendRangeLabel"),
    leftChartTitle: document.getElementById("leftChartTitle"),
    leftChartSubtitle: document.getElementById("leftChartSubtitle"),
    leftChartEmpty: document.getElementById("leftChartEmpty"),
    rightDepartureList: document.getElementById("rightDepartureList"),
    departurePrevBtn: document.getElementById("departurePrevBtn"),
    departureNextBtn: document.getElementById("departureNextBtn"),
    departurePageInfo: document.getElementById("departurePageInfo"),
  };

  if (!els.brandSelect || !els.yearSelect || !els.destinationSelect || !els.brandLandSelect) return;

  const maanden = [
    "jan",
    "feb",
    "mrt",
    "apr",
    "mei",
    "jun",
    "jul",
    "aug",
    "sep",
    "okt",
    "nov",
    "dec",
  ];

  const nfInt = new Intl.NumberFormat("nl-NL");
  const nfMoney = new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" });
  const nfAvg = new Intl.NumberFormat("nl-NL", { minimumFractionDigits: 1, maximumFractionDigits: 2 });

  function normalizePath(p) {
    if (p == null || typeof p !== "string") return "";
    const t = p.trim();
    if (!t) return "";
    return t.replace(/\/+$/, "") || "/";
  }
  /** Kies API-basispad: bij mount onder /prefix moet /prefix/overzicht winnen, niet alleen /overzicht. */
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
    typeof window.__OVERZICHT_API_BASE__ === "string" ? window.__OVERZICHT_API_BASE__.trim() : "";
  const apiBase = pickApiBase(pageBase, serverBase);

  const API_BRANDS = `${apiBase}/brands`;
  const API_YEARS = `${apiBase}/years`;
  const API_DATA = `${apiBase}/data`;
  const RBAC = window.__RBAC__ || {};
  const IS_RESTRICTED_ROLE = Boolean(RBAC.isRestricted);
  const FORCED_YEAR = Number(RBAC.currentYear) || new Date().getFullYear();

  let bookingTrendChart = null;
  let leftChart = null;
  let leftChartKey = "";

  const BAR_COLOR = "#ea580c";
  const countryColors = window.CountryColors || null;
  const COUNTRY_FALLBACK_COLORS = [
    "#0284c7",
    "#16a34a",
    "#7c3aed",
    "#0f766e",
    "#ef4444",
    "#14b8a6",
    "#8b5cf6",
    "#f43f5e",
    "#22c55e",
    "#64748b",
  ];
  const MAX_BAR_ITEMS = 10; // performance: limiet op zichtbare bars
  const BAR_ROW_PX = 34; // hoogte per categorie (voor scroll)
  const BAR_MIN_PX = 180; // minimale hoogte voor canvas

  const OVERZICHT_DEV_MODE =
    (typeof process !== "undefined" && process?.env?.NODE_ENV === "development") ||
    String(globalThis?.location?.hostname || "").toLowerCase() === "localhost";

  // Filter-sentinels: we laden data pas bij "Filters toepassen".
  const BRAND_ALL = "__all__";
  const YEAR_ALL = 0; // API interpreteert 0 als "alle jaren"
  const DEST_ALL = ""; // empty string = "alle bestemmingen"
  const BRAND_LAND_ALL = "__ALL__";

  /** Voorkeur: huidig kalenderjaar als dat in de dropdown staat, anders het meest recente jaar met data. */
  function pickDefaultYearFromSelect(selectEl) {
    if (!selectEl) return YEAR_ALL;
    const yNow = new Date().getFullYear();
    const opts = Array.from(selectEl.options || [])
      .map((o) => Number(o.value))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (opts.includes(yNow)) return yNow;
    if (opts.length === 0) return YEAR_ALL;
    return Math.max(...opts);
  }

  let selectedBrand = BRAND_ALL;
  let selectedYear = IS_RESTRICTED_ROLE ? FORCED_YEAR : YEAR_ALL;
  let selectedDestination = DEST_ALL;
  let selectedBrandLand = BRAND_LAND_ALL;

  let isApplying = false;
  const apiCache = new Map();
  const DEPARTURE_PAGE_SIZE = 10;
  let departurePage = 0;
  let currentDepartureRows = [];

  /** Zichtbare maanden in één venster (lijngrafiek). */
  const BOOKING_TREND_WINDOW = 6;
  /** Verschuiving per pijl: exact 1 periode per klik. */
  const BOOKING_TREND_NAV_STEP = 1;
  let bookingTrendFullRows = [];
  let bookingTrendVisibleStart = 0;

  const normalizeBrand = (s) => String(s || "").trim();

  const canonicalBrand = (s) => {
    const t = normalizeBrand(s);
    const lower = t.toLowerCase();
    if (lower === "sun escapes") return "Sun Escapes";
    if (lower === "snow escapes") return "Snow Escapes";
    if (lower === "road rebels") return "Road Rebels";
    return t;
  };

  const destroyIfExists = (chart) => {
    if (chart && chart.destroy) chart.destroy();
  };

  const setSelectState = (select, enabled) => {
    if (!select) return;
    select.disabled = !enabled;
  };

  const setEmptyVisibility = (el, visible) => {
    if (!el) return;
    el.classList.toggle("d-none", !visible);
  };

  const fetchJson = async (url) => {
    const method = "GET";
    const reqHeaders = { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" };
    const resp = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: reqHeaders,
    });
    const rawBody = await resp.text();
    const contentType = resp.headers.get("content-type") || "";
    const looksHtml = /^\s*</.test(rawBody);

    if (looksHtml) {
      const preview = rawBody.slice(0, 300).replace(/\s+/g, " ").trim();
      const onLogin = resp.url.includes("/login") || /login/i.test(rawBody.slice(0, 800));
      if (resp.status === 401 || onLogin) {
        throw new Error(
          `Sessie verlopen of niet ingelogd.\nURL: ${url}\nStatus: ${resp.status}\nContent-Type: ${contentType}\nPreview: ${preview}`
        );
      }
      throw new Error(
        `Server stuurde HTML i.p.v. JSON.\nURL: ${url}\nStatus: ${resp.status}\nContent-Type: ${contentType}\nPreview: ${preview}\n(pageBase=${pageBase}, serverBase=${serverBase}, apiBase=${apiBase})`
      );
    }

    let parsed = null;
    if (rawBody) {
      try {
        parsed = JSON.parse(rawBody);
      } catch (e) {
        const snippet = rawBody.slice(0, 240).replace(/\s+/g, " ").trim();
        parsed = null;
      }
    }

    if (!resp.ok) {
      const details = parsed ? JSON.stringify(parsed) : rawBody;
      throw new Error(`HTTP ${resp.status}: ${details || "Onbekende fout."}`);
    }

    if (!rawBody) return {};
    if (parsed) return parsed;
    throw new Error("Server gaf geen geldige JSON terug.");
  };

  const showTopError = (message) => {
    // We gebruiken een simpele aanpak: als er geen error-element bestaat, doen we niets.
    const existing = document.getElementById("overzichtError");
    if (!existing) return;
    if (!message) {
      existing.classList.add("d-none");
      existing.textContent = "";
      return;
    }
    existing.textContent = message;
    existing.classList.remove("d-none");
  };

  const capMaand = (maand) => {
    const mIdx = Number(maand) - 1;
    const mName = maanden[mIdx] || "";
    return mName ? mName.charAt(0).toUpperCase() + mName.slice(1) : "";
  };

  const bookingTrendXLabel = (row) => {
    if (selectedYear !== YEAR_ALL) return capMaand(row.maand);
    return `${capMaand(row.maand)} ${row.jaar}`;
  };

  const formatBookingTrendRangeLabel = (slice) => {
    if (!slice.length) return "";
    const yA = slice[0].jaar;
    const yB = slice[slice.length - 1].jaar;
    const a = capMaand(slice[0].maand);
    const b = capMaand(slice[slice.length - 1].maand);
    if (!a) return b ? `${b} ${yB}` : "—";
    if (selectedYear !== YEAR_ALL || yA === yB) {
      if (!b || a === b) return `${a} ${yA}`;
      return `${a} – ${b} ${yA}`;
    }
    if (!b) return `${a} ${yA}`;
    return `${a} ${yA} – ${b} ${yB}`;
  };

  function clampBookingTrendStart(start, totalLen, windowSize) {
    const maxStart = Math.max(0, totalLen - windowSize);
    return Math.max(0, Math.min(maxStart, start));
  }

  function syncBookingTrendNav(totalLen, windowSize) {
    const L = els.bookingTrendScrollLeft;
    const R = els.bookingTrendScrollRight;
    const lab = els.bookingTrendRangeLabel;
    if (lab && bookingTrendFullRows.length) {
      const slice = bookingTrendFullRows.slice(
        bookingTrendVisibleStart,
        bookingTrendVisibleStart + windowSize
      );
      lab.textContent = formatBookingTrendRangeLabel(slice);
    } else if (lab) {
      lab.textContent = "";
    }
    const maxStart = Math.max(0, totalLen - windowSize);
    if (L) L.disabled = totalLen <= windowSize || bookingTrendVisibleStart <= 0;
    if (R) R.disabled = totalLen <= windowSize || bookingTrendVisibleStart >= maxStart;
  }

  /** Vaste y-as over het volledige trendbereik (niet alleen het zichtbare venster). */
  function bookingTrendYAxisMax(rows) {
    const list = Array.isArray(rows) ? rows : [];
    let maxVal = 0;
    for (const r of list) {
      const v = Number(r?.totaal_reizigers) || 0;
      if (v > maxVal) maxVal = v;
    }
    if (maxVal <= 0) return 1;
    return Math.ceil(maxVal * 1.06);
  }

  function drawBookingTrendWindow() {
    const canvas = document.getElementById("bookingTrendChart");
    if (!canvas || !bookingTrendFullRows.length) return;

    const w = Math.min(BOOKING_TREND_WINDOW, bookingTrendFullRows.length);
    bookingTrendVisibleStart = clampBookingTrendStart(bookingTrendVisibleStart, bookingTrendFullRows.length, w);
    const slice = bookingTrendFullRows.slice(bookingTrendVisibleStart, bookingTrendVisibleStart + w);
    const labels = slice.map((r) => bookingTrendXLabel(r));
    const values = slice.map((x) => Number(x.totaal_reizigers) || 0);
    const yMaxFixed = bookingTrendYAxisMax(bookingTrendFullRows);

    const chartOptions = {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 340, easing: "easeOutQuart" },
      transitions: { active: { animation: { duration: 340, easing: "easeOutQuart" } } },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => ` ${nfInt.format(ctx.parsed.y)} reizigers` } },
      },
      scales: {
        x: {
          ticks: { autoSkip: false, maxRotation: 42, minRotation: 0 },
          grid: { display: false },
        },
        y: {
          beginAtZero: true,
          min: 0,
          max: yMaxFixed,
          ticks: { precision: 0 },
        },
      },
    };

    if (!bookingTrendChart) {
      bookingTrendChart = new Chart(canvas, {
        type: "line",
        data: {
          labels,
          datasets: [
            {
              label: "Reizigers (vertrekdatum)",
              data: values,
              borderColor: "#ea580c",
              backgroundColor: "rgba(234, 88, 12, 0.12)",
              pointBackgroundColor: "#ea580c",
              tension: 0.35,
              fill: true,
            },
          ],
        },
        options: chartOptions,
      });
    } else {
      bookingTrendChart.data.labels = labels;
      bookingTrendChart.data.datasets[0].data = values;
      if (bookingTrendChart.options.scales && bookingTrendChart.options.scales.y) {
        bookingTrendChart.options.scales.y.min = 0;
        bookingTrendChart.options.scales.y.max = yMaxFixed;
      }
      bookingTrendChart.update("active");
    }
    syncBookingTrendNav(bookingTrendFullRows.length, w);
    requestAnimationFrame(() => bookingTrendChart && bookingTrendChart.resize());
  }

  function bookingTrendNavStep(dir) {
    if (!bookingTrendFullRows.length) return;
    const w = Math.min(BOOKING_TREND_WINDOW, bookingTrendFullRows.length);
    const maxStart = Math.max(0, bookingTrendFullRows.length - w);
    const step = Math.min(BOOKING_TREND_NAV_STEP, w);
    if (dir < 0) {
      bookingTrendVisibleStart = clampBookingTrendStart(
        bookingTrendVisibleStart - step,
        bookingTrendFullRows.length,
        w
      );
    } else {
      bookingTrendVisibleStart = Math.min(maxStart, bookingTrendVisibleStart + step);
    }
    drawBookingTrendWindow();
  }

  const formatDateLabel = (value) => {
    if (!value) return "-";
    return (window.TADate && window.TADate.formatDate && window.TADate.formatDate(value, String(value))) || String(value);
  };

  /** @param {HTMLElement | null} el */
  function setKpiYoy(el, current, prev) {
    if (!el) return;
    el.textContent = "";
    el.className = "kpi-card__yoy";
    if (prev == null || current == null || !Number.isFinite(current) || !Number.isFinite(prev)) {
      el.textContent = "vs vorig jaar: n.v.t.";
      el.classList.add("kpi-card__yoy--muted");
      return;
    }
    if (prev === 0) {
      if (current === 0) {
        el.textContent = "vs vorig jaar: 0%";
        el.classList.add("kpi-card__yoy--neutral");
        return;
      }
      el.textContent = "vs vorig jaar: n.v.t.";
      el.classList.add("kpi-card__yoy--muted");
      return;
    }
    const pct = ((current - prev) / prev) * 100;
    const sign = pct > 0 ? "+" : "";
    const pctStr = `${sign}${pct.toFixed(1).replace(".", ",")}%`;
    el.textContent = `vs vorig jaar: ${pctStr}`;
    if (pct > 0) el.classList.add("kpi-card__yoy--up");
    else if (pct < 0) el.classList.add("kpi-card__yoy--down");
    else el.classList.add("kpi-card__yoy--neutral");
  }

  const updateKpis = (data) => {
    const rawTotalBoekingen = Number(data?.kpis?.total_boekingen);
    const rawTotalReizigers = Number(data?.kpis?.total_reizigers);

    const totalBoekingen = Number.isFinite(rawTotalBoekingen) ? rawTotalBoekingen : null;
    const totalReizigers = Number.isFinite(rawTotalReizigers) ? rawTotalReizigers : null;

    const py = data?.kpis?.prev_year;
    const numOrNull = (v) => {
      if (v == null || v === "") return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const prevB = py != null ? numOrNull(py.total_boekingen) : null;
    const prevR = py != null ? numOrNull(py.total_reizigers) : null;
    const prevO = py != null ? numOrNull(py.total_omzet) : null;

    if (els.kpiBookings) {
      els.kpiBookings.textContent =
        data?.kpis?.total_boekingen != null ? nfInt.format(totalBoekingen) : "-";
    }
    setKpiYoy(els.kpiBookingsYoy, totalBoekingen, prevB);

    if (els.kpiTravellers) {
      els.kpiTravellers.textContent =
        data?.kpis?.total_reizigers != null ? nfInt.format(totalReizigers) : "-";
    }
    setKpiYoy(els.kpiTravellersYoy, totalReizigers, prevR);

    if (els.kpiRevenue) {
      els.kpiRevenue.textContent =
        data?.kpis?.total_omzet != null ? nfMoney.format(data.kpis.total_omzet) : "-";
    }
    setKpiYoy(els.kpiRevenueYoy, numOrNull(data?.kpis?.total_omzet), prevO);

    // KPI gemiddeld: alleen renderen als elementen bestaan (robust tegen cache/template mismatch).
    if (els.kpiAvgBookingSize && els.kpiAvgBookingSizeSub) {
      if (totalBoekingen === null || totalReizigers === null) {
        els.kpiAvgBookingSize.textContent = "-";
        els.kpiAvgBookingSizeSub.textContent = "geen data voor deze selectie";
        if (els.kpiAvgBookingSizeYoy) {
          els.kpiAvgBookingSizeYoy.textContent = "vs vorig jaar: n.v.t.";
          els.kpiAvgBookingSizeYoy.className = "kpi-card__yoy kpi-card__yoy--muted";
        }
        return;
      }

      if (totalBoekingen === 0) {
        // 0/0 => toon 0 ipv '-'
        if (totalReizigers === 0) {
          els.kpiAvgBookingSize.textContent = nfAvg.format(0);
        } else {
          els.kpiAvgBookingSize.textContent = "-";
        }
        els.kpiAvgBookingSizeSub.textContent = "reizigers per boeking";
        setKpiYoy(els.kpiAvgBookingSizeYoy, null, null);
        return;
      }

      const avgBookingSize = totalReizigers / totalBoekingen;
      els.kpiAvgBookingSize.textContent = nfAvg.format(avgBookingSize);
      els.kpiAvgBookingSizeSub.textContent = "reizigers per boeking";

      let prevAvg = null;
      if (prevB != null && prevR != null && prevB > 0) {
        prevAvg = prevR / prevB;
      }
      setKpiYoy(els.kpiAvgBookingSizeYoy, avgBookingSize, prevAvg);
    }
  };

  const renderBookingTrend = (items) => {
    destroyIfExists(bookingTrendChart);
    bookingTrendChart = null;

    const list = Array.isArray(items) ? items : [];
    bookingTrendFullRows = [...list].sort((a, b) => (a.jaar - b.jaar) || (a.maand - b.maand));
    // UX: start standaard bij april als die maand in de reeks zit; anders eerste maand met data.
    const aprilIdx = bookingTrendFullRows.findIndex((r) => Number(r?.maand) === 4);
    const firstDataIdx = bookingTrendFullRows.findIndex((r) => (Number(r?.totaal_reizigers) || 0) > 0);
    bookingTrendVisibleStart = aprilIdx >= 0 ? aprilIdx : firstDataIdx >= 0 ? firstDataIdx : 0;

    const hasData = bookingTrendFullRows.length > 0;
    setEmptyVisibility(els.bookingTrendEmpty, !hasData);
    if (els.bookingTrendNavWrap) els.bookingTrendNavWrap.classList.toggle("d-none", !hasData);

    if (!hasData) {
      if (els.bookingTrendRangeLabel) els.bookingTrendRangeLabel.textContent = "";
      return;
    }

    drawBookingTrendWindow();
  };

  const renderDestinationChart = (items) => {
    const list = Array.isArray(items) ? items : [];
    setEmptyVisibility(els.leftChartEmpty, list.length === 0);
    if (list.length === 0) return;

    // Sorteer aflopend op waarde en beperk tot top N (performance + leesbaarheid).
    const sorted = [...list]
      .map((x) => ({
        naam: x.naam,
        waarde: Number(x.reizigers_totaal) || 0,
      }))
      .sort((a, b) => b.waarde - a.waarde)
      .slice(0, MAX_BAR_ITEMS);

    const key = JSON.stringify(sorted);
    if (key === leftChartKey) return;
    leftChartKey = key;

    destroyIfExists(leftChart);
    leftChart = null;

    const canvas = document.getElementById("leftChart");
    const wrapper = canvas?.parentElement;
    const width = wrapper ? wrapper.clientWidth : 600;
    const desiredHeight = Math.max(BAR_MIN_PX, sorted.length * BAR_ROW_PX + 40);
    if (canvas) {
      canvas.width = Math.max(320, Math.floor(width));
      canvas.height = Math.max(140, Math.floor(desiredHeight));
      canvas.style.height = `${desiredHeight}px`;
    }

    leftChart = new Chart(canvas, {
      type: "bar",
      data: {
        labels: sorted.map((x) => x.naam),
        datasets: [
          {
            label: "Reizigers",
            data: sorted.map((x) => x.waarde),
            backgroundColor: BAR_COLOR,
            borderRadius: { topLeft: 0, bottomLeft: 0, topRight: 10, bottomRight: 10 },
            borderSkipped: false,
            categoryPercentage: 0.65,
            barPercentage: 0.85,
          },
        ],
      },
      options: {
        responsive: false,
        maintainAspectRatio: false,
        indexAxis: "y",
        devicePixelRatio: 1,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => ` ${nfInt.format(ctx.parsed.x)} reizigers`,
            },
          },
        },
        layout: { padding: { right: 12, left: 4 } },
        scales: {
          x: {
            beginAtZero: true,
            ticks: { precision: 0 },
            grid: { drawOnChartArea: false },
          },
          y: {
            grid: { display: false },
            ticks: { font: { size: 12 } },
          },
        },
      },
    });
  };

  const renderDeparturePage = () => {
    const list = Array.isArray(currentDepartureRows) ? currentDepartureRows : [];
    const total = list.length;
    const hasRows = total > 0;
    if (!els.rightDepartureList || !els.departurePageInfo || !els.departurePrevBtn || !els.departureNextBtn) return;

    if (!hasRows) {
      els.rightDepartureList.innerHTML =
        "<div class=\"list-group-item text-muted small\">Geen vertrekdata beschikbaar.</div>";
      els.departurePageInfo.textContent = "Geen gegevens";
      els.departurePrevBtn.disabled = true;
      els.departureNextBtn.disabled = true;
      return;
    }

    const maxPage = Math.max(0, Math.ceil(total / DEPARTURE_PAGE_SIZE) - 1);
    departurePage = Math.min(Math.max(0, departurePage), maxPage);
    const startIdx = departurePage * DEPARTURE_PAGE_SIZE;
    const endIdx = Math.min(startIdx + DEPARTURE_PAGE_SIZE, total);
    const slice = list.slice(startIdx, endIdx);

    const fromRank = startIdx + 1;
    const toRank = endIdx;
    els.departurePageInfo.textContent = `${fromRank}–${toRank} van ${total}`;
    els.departurePrevBtn.disabled = departurePage <= 0;
    els.departureNextBtn.disabled = departurePage >= maxPage;

    els.rightDepartureList.innerHTML = "";
    slice.forEach((row, idx) => {
      const rank = startIdx + idx + 1;
      const travellers = Number(row.reizigers_totaal) || 0;
      const item = document.createElement("div");
      item.className =
        "list-group-item vertrekdata-list__row d-flex justify-content-between align-items-center";
      item.innerHTML = `
        <div class="d-flex align-items-center gap-2 min-w-0">
          <span class="badge rounded-pill text-bg-light flex-shrink-0">#${rank}</span>
          <span class="fw-medium text-truncate">${formatDateLabel(row.vertrekdatum)}</span>
        </div>
        <span class="vertrekdata-list__count text-muted small flex-shrink-0">${nfInt.format(travellers)} reizigers</span>
      `;
      els.rightDepartureList.appendChild(item);
    });
  };

  const renderDepartureDates = (items) => {
    const list = Array.isArray(items) ? items : [];
    currentDepartureRows = [...list]
      .map((x) => ({
        vertrekdatum: x.vertrekdatum,
        reizigers_totaal: Number(x.reizigers_totaal) || 0,
      }))
      .sort(
        (a, b) =>
          b.reizigers_totaal - a.reizigers_totaal ||
          String(a.vertrekdatum).localeCompare(String(b.vertrekdatum))
      )
      .slice(0, 20);
    departurePage = 0;
    renderDeparturePage();
  };

  const renderOriginCountryChart = (items, totalTravelersForSafeguard) => {
    const list = Array.isArray(items) ? items : [];
    const mapped = list.map((x) => ({
      land: String(x.land || "Onbekend"),
      waarde: Number(x.aantal_reizigers) || 0,
    }));
    const nonZero = mapped.filter((x) => x.waarde > 0);

    setEmptyVisibility(els.leftChartEmpty, nonZero.length === 0);
    if (nonZero.length === 0) {
      if (els.leftChartEmpty) {
        els.leftChartEmpty.textContent = "Geen herkomstgegevens beschikbaar voor deze bestemming.";
      }
      return;
    }

    const sortedAll = [...nonZero].sort((a, b) => b.waarde - a.waarde || String(a.land).localeCompare(String(b.land)));
    const topN = 12;
    const top = sortedAll.slice(0, topN);
    const restSum = sortedAll.slice(topN).reduce((acc, x) => acc + x.waarde, 0);
    const segments = restSum > 0 ? [...top, { land: "Overig", waarde: restSum }] : top;

    const key = `left|brand:${selectedBrand}|year:${selectedYear}|dest:${selectedDestination}|brandLand:${selectedBrandLand}|${JSON.stringify(
      segments
    )}`;
    if (key === leftChartKey) return;
    leftChartKey = key;

    destroyIfExists(leftChart);
    leftChart = null;

    const canvas = document.getElementById("leftChart");
    if (canvas) {
      canvas.style.height = "280px";
    }
    const totalSegments = segments.reduce((acc, x) => acc + x.waarde, 0);

    // Safeguard (development only): som van donutsegmenten moet altijd gelijk zijn aan KPI `Totaal reizigers`.
    const expectedTotal = totalTravelersForSafeguard != null ? Number(totalTravelersForSafeguard) : null;
    if (
      OVERZICHT_DEV_MODE &&
      expectedTotal != null &&
      Number.isFinite(expectedTotal) &&
      Math.abs(totalSegments - expectedTotal) > 0
    ) {
      console.warn("[overzicht] Donut 'herkomst per land' som mismatch:", {
        expectedTotal,
        donutTotal: totalSegments,
        diff: totalSegments - expectedTotal,
        filters: { brand: selectedBrand, year: selectedYear, destination: selectedDestination, brandLand: selectedBrandLand },
      });
    }

    let fallbackIdx = 0;
    const labels = segments.map((x) => x.land);
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

    leftChart = new Chart(canvas, {
      type: "doughnut",
      data: {
        labels,
        datasets: [
          {
            label: "Reizigers",
            data: segments.map((x) => x.waarde),
            backgroundColor: colors,
            hoverBackgroundColor: hoverColors,
            borderWidth: 0,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: true, position: "bottom" },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const waarde = Number(ctx.raw) || 0;
                const pct = totalSegments > 0 ? (waarde / totalSegments) * 100 : 0;
                return ` ${ctx.label}: ${nfInt.format(waarde)} reizigers (${pct.toFixed(1)}%)`;
              },
            },
          },
        },
        cutout: "56%",
      },
    });
  };

  const loadOverzichtData = async ({ brand, year, destination, brandLand }) => {
    const cacheBrand = canonicalBrand(brand);
    const cacheYear = Number(year);
    const cacheDestination = destination || DEST_ALL;
    const cacheKey = `${cacheBrand}|${cacheYear}|${cacheDestination}|${brandLand}`;

    let data = apiCache.get(cacheKey);
    if (!data) {
      const url = new URL(API_DATA, window.location.origin);
      url.searchParams.set("brand", cacheBrand);
      url.searchParams.set("year", String(cacheYear));
      if (cacheDestination) url.searchParams.set("destination", cacheDestination);
      url.searchParams.set("brand_land", brandLand || BRAND_LAND_ALL);

      data = await fetchJson(url.toString());
      apiCache.set(cacheKey, data);
    }

    updateKpis(data);
    const travelerTrendData = data?.booking_trend || [];
    const popularDepartureDates = data?.popular_departure_dates_overall || [];
    renderBookingTrend(travelerTrendData);
    renderDepartureDates(popularDepartureDates);

    const destSelected = Boolean(destination);
    if (!destSelected) {
      // Destination dropdown vullen op basis van dezelfde API-call (geen extra request).
      if (els.destinationSelect) {
        const dests = Array.isArray(data?.destination_lijst) ? data.destination_lijst : [];
        els.destinationSelect.innerHTML = "";
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = "Alle bestemmingen";
        els.destinationSelect.appendChild(placeholder);
        dests.forEach((d) => {
          const opt = document.createElement("option");
          opt.value = String(d.id);
          opt.textContent = String(d.naam);
          els.destinationSelect.appendChild(opt);
        });
        setSelectState(els.destinationSelect, true);
      }

      if (els.leftChartTitle) els.leftChartTitle.textContent = "Populaire bestemmingen";
      if (els.leftChartSubtitle) {
        els.leftChartSubtitle.textContent = "Totaal aantal reizigers per bestemming (gesorteerd op volume).";
      }
      if (els.leftChartEmpty) {
        els.leftChartEmpty.textContent = "Geen gegevens.";
      }
      renderDestinationChart(data?.popular_destinations_overall || []);
    } else {
      if (els.leftChartTitle) els.leftChartTitle.textContent = "Herkomst reizigers per land";
      if (els.leftChartSubtitle) {
        els.leftChartSubtitle.innerHTML =
          "Verdeling van reizigers op basis van land van afkomst voor de geselecteerde bestemming. " +
          '<span class="d-inline-flex align-items-center gap-2 ms-1 small" aria-hidden="true">' +
          '<span class="text-nowrap"><span class="country-swatch country-swatch--be"></span>BE</span>' +
          '<span class="text-nowrap"><span class="country-swatch country-swatch--nl"></span>NL</span>' +
          "</span>";
      }
      const countryDistributionData = data?.traveller_origins_destination || [];
      renderOriginCountryChart(countryDistributionData, data?.kpis?.total_reizigers);
    }

  };

  const setFilterButtonsEnabled = (enabled) => {
    if (els.filtersApplyBtn) els.filtersApplyBtn.disabled = !enabled;
    if (els.filtersResetBtn) els.filtersResetBtn.disabled = !enabled;
  };

  const setApplyingUi = (loading) => {
    if (els.filtersApplyBtn) {
      els.filtersApplyBtn.disabled = loading;
      els.filtersApplyBtn.textContent = loading ? "Even geduld…" : "Filters toepassen";
    }
    if (els.filtersResetBtn) els.filtersResetBtn.disabled = loading;
  };

  const refreshYearsDropdown = async (brandValue) => {
    setSelectState(els.yearSelect, false);
    els.yearSelect.innerHTML = "";
    if (!IS_RESTRICTED_ROLE) {
      els.yearSelect.innerHTML = `<option value="0" selected>Alle jaren</option>`;
    }

    const yearsUrl = new URL(API_YEARS, window.location.origin);
    yearsUrl.searchParams.set("brand", brandValue);
    const years = await fetchJson(yearsUrl.toString());
    const yearItems = Array.isArray(years?.years) ? years.years : [];

    // Vul alleen echte jaren aan; "Alle jaren" blijft de default.
    for (const y of yearItems) {
      const opt = document.createElement("option");
      opt.value = String(y);
      opt.textContent = String(y);
      els.yearSelect.appendChild(opt);
    }

    setSelectState(els.yearSelect, !IS_RESTRICTED_ROLE);
    els.yearSelect.value = IS_RESTRICTED_ROLE ? String(FORCED_YEAR) : "0";
  };

  const applyFilters = async () => {
    if (isApplying) return;
    const brandRaw = els.brandSelect?.value ?? BRAND_ALL;
    const yearRaw = Number(els.yearSelect?.value ?? YEAR_ALL);
    const destinationRaw = els.destinationSelect?.value ?? DEST_ALL;

    selectedBrand = canonicalBrand(brandRaw);
    selectedYear = IS_RESTRICTED_ROLE ? FORCED_YEAR : Number.isFinite(yearRaw) ? yearRaw : YEAR_ALL;
    selectedDestination = destinationRaw || DEST_ALL;

    selectedBrandLand = (els.brandLandSelect?.value || BRAND_LAND_ALL).trim() || BRAND_LAND_ALL;
    const cacheKey = `${selectedBrand}|${selectedYear}|${selectedDestination}|${selectedBrandLand}`;
    apiCache.delete(cacheKey);

    setEmptyVisibility(els.bookingTrendEmpty, false);
    setEmptyVisibility(els.leftChartEmpty, false);

    isApplying = true;
    setApplyingUi(true);
    setFilterButtonsEnabled(false);
    try {
      showTopError("");
      await loadOverzichtData({
        brand: selectedBrand,
        year: selectedYear,
        destination: selectedDestination,
        brandLand: selectedBrandLand,
      });
    } catch (e) {
      showTopError(e?.message || String(e));
      setEmptyVisibility(els.bookingTrendEmpty, true);
      setEmptyVisibility(els.leftChartEmpty, true);
      bookingTrendFullRows = [];
      bookingTrendVisibleStart = 0;
      destroyIfExists(bookingTrendChart);
      bookingTrendChart = null;
      if (els.bookingTrendNavWrap) els.bookingTrendNavWrap.classList.add("d-none");
      if (els.bookingTrendRangeLabel) els.bookingTrendRangeLabel.textContent = "";
      currentDepartureRows = [];
      renderDeparturePage();
    } finally {
      isApplying = false;
      setApplyingUi(false);
      setFilterButtonsEnabled(true);
    }
  };

  const resetFilters = async () => {
    els.brandSelect.value = BRAND_ALL;
    els.destinationSelect.value = DEST_ALL;
    els.brandLandSelect.value = BRAND_LAND_ALL;
    selectedBrand = BRAND_ALL;
    selectedDestination = DEST_ALL;
    selectedBrandLand = BRAND_LAND_ALL;
    await refreshYearsDropdown(BRAND_ALL);
      const defY = IS_RESTRICTED_ROLE ? FORCED_YEAR : pickDefaultYearFromSelect(els.yearSelect);
    els.yearSelect.value = defY > 0 ? String(defY) : String(YEAR_ALL);
    selectedYear = defY > 0 ? defY : YEAR_ALL;
    await applyFilters();
  };

  const init = async () => {
    try {
      showTopError("");
      setFilterButtonsEnabled(false);

      // 1) Brands ophalen
      const brandsResp = await fetchJson(API_BRANDS);
      const brands = Array.isArray(brandsResp?.brands) ? brandsResp.brands : [];

      // Dedup + canonicalize (fix voor whitespace/case issues)
      const seen = new Set();
      const canonicalBrands = [];
      for (const b of brands) {
        const cb = canonicalBrand(b);
        const key = cb.toLowerCase();
        if (!seen.has(key) && cb !== BRAND_ALL) {
          seen.add(key);
          canonicalBrands.push(cb);
        }
      }

      els.brandSelect.innerHTML = "";
      const allOpt = document.createElement("option");
      allOpt.value = BRAND_ALL;
      allOpt.textContent = "Alle merken";
      els.brandSelect.appendChild(allOpt);

      canonicalBrands.forEach((b) => {
        const opt = document.createElement("option");
        opt.value = b;
        opt.textContent = b;
        els.brandSelect.appendChild(opt);
      });
      els.brandSelect.value = BRAND_ALL;
      selectedBrand = BRAND_ALL;

      // 2) Years ophalen voor huidig brand (default = alle merken)
      await refreshYearsDropdown(selectedBrand);
      const defaultYear = IS_RESTRICTED_ROLE ? FORCED_YEAR : pickDefaultYearFromSelect(els.yearSelect);
      if (defaultYear > 0) {
        els.yearSelect.value = String(defaultYear);
        selectedYear = defaultYear;
      } else {
        selectedYear = YEAR_ALL;
      }

      // 3) Destination default
      els.destinationSelect.innerHTML = "";
      const destAll = document.createElement("option");
      destAll.value = DEST_ALL;
      destAll.textContent = "Alle bestemmingen";
      els.destinationSelect.appendChild(destAll);
      els.destinationSelect.value = DEST_ALL;
      selectedDestination = DEST_ALL;
      selectedBrandLand = BRAND_LAND_ALL;

      // Initial apply (met defaults)
      setFilterButtonsEnabled(true);
      await applyFilters();

      setFilterButtonsEnabled(true);
    } catch (e) {
      showTopError(e?.message || String(e));
      setEmptyVisibility(els.bookingTrendEmpty, true);
      setEmptyVisibility(els.leftChartEmpty, true);
      bookingTrendFullRows = [];
      bookingTrendVisibleStart = 0;
      destroyIfExists(bookingTrendChart);
      bookingTrendChart = null;
      if (els.bookingTrendNavWrap) els.bookingTrendNavWrap.classList.add("d-none");
      if (els.bookingTrendRangeLabel) els.bookingTrendRangeLabel.textContent = "";
      currentDepartureRows = [];
      renderDeparturePage();
      setFilterButtonsEnabled(false);
    }
  };

  // UI handlers: alleen filters laden, data refresh uitsluitend via "Filters toepassen".
  if (els.filtersApplyBtn) els.filtersApplyBtn.addEventListener("click", applyFilters);
  if (els.filtersResetBtn) els.filtersResetBtn.addEventListener("click", resetFilters);
  if (els.departurePrevBtn) {
    els.departurePrevBtn.addEventListener("click", () => {
      departurePage -= 1;
      renderDeparturePage();
    });
  }
  if (els.departureNextBtn) {
    els.departureNextBtn.addEventListener("click", () => {
      departurePage += 1;
      renderDeparturePage();
    });
  }
  if (els.bookingTrendScrollLeft) {
    els.bookingTrendScrollLeft.addEventListener("click", () => bookingTrendNavStep(-1));
  }
  if (els.bookingTrendScrollRight) {
    els.bookingTrendScrollRight.addEventListener("click", () => bookingTrendNavStep(1));
  }

  els.brandSelect.addEventListener("change", async () => {
    try {
      const brandVal = canonicalBrand(els.brandSelect.value);
      await refreshYearsDropdown(brandVal);
      selectedBrand = brandVal;
      selectedYear = IS_RESTRICTED_ROLE ? FORCED_YEAR : YEAR_ALL;
      setFilterButtonsEnabled(true);
    } catch (e) {
      showTopError(e?.message || String(e));
    }
  });

  els.yearSelect.addEventListener("change", () => {
    selectedYear = IS_RESTRICTED_ROLE ? FORCED_YEAR : Number(els.yearSelect.value) || YEAR_ALL;
    setFilterButtonsEnabled(true);
  });

  els.destinationSelect.addEventListener("change", () => {
    selectedDestination = els.destinationSelect.value || DEST_ALL;
    setFilterButtonsEnabled(true);
  });
  els.brandLandSelect.addEventListener("change", () => {
    selectedBrandLand = (els.brandLandSelect.value || BRAND_LAND_ALL).trim() || BRAND_LAND_ALL;
    setFilterButtonsEnabled(true);
  });

  init().catch(() => {});
})();

