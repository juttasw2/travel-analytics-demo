(() => {
  const els = {
    error: document.getElementById("annError"),
    yearSelect: document.getElementById("annYearSelect"),
    brandSelect: document.getElementById("annBrandSelect"),
    destinationSelect: document.getElementById("annDestinationSelect"),
    applyBtn: document.getElementById("annFiltersApplyBtn"),
    resetBtn: document.getElementById("annFiltersResetBtn"),
    kpiBookings: document.getElementById("annKpiBookings"),
    kpiTravellers: document.getElementById("annKpiTravellers"),
    kpiRevenue: document.getElementById("annKpiRevenue"),
    kpiShare: document.getElementById("annKpiShare"),
    emptyState: document.getElementById("annEmptyState"),
    brandDonutsRow: document.getElementById("annBrandDonutsRow"),
    destChartCard: document.getElementById("annDestChartCard"),
    cancelledTableBody: document.getElementById("annCancelledTableBody"),
    cancelledTableCard: document.getElementById("annCancelledTableCard"),
  };

  if (!els.yearSelect || !els.brandSelect || !els.destinationSelect) return;

  const annApi = typeof window !== "undefined" ? window.__ANN_API__ || {} : {};
  const API_OPT = annApi.options || "/annulaties/options";
  const API_YEARS = annApi.years || "/annulaties/years";
  const API_DATA = annApi.data || "/annulaties/data";

  const YEAR_ALL = 0;
  const BRAND_ALL = "__all__";
  const DEST_ALL = "";

  const nfInt = new Intl.NumberFormat("nl-NL");
  const nfMoney = new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" });
  const nfPct = new Intl.NumberFormat("nl-NL", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  const donutCharts = {};
  let destChart = null;
  const destPaginator = typeof window.TAPaginatedChartData === "function" ? new window.TAPaginatedChartData(10) : null;
  const DEST_PAGE_SIZE = 10;

  const donutIdByBrand = {
    "Sun Escapes": "annDonutSunescapes",
    "Snow Escapes": "annDonutSnowescapes",
    "Road Rebels": "annDonutRoadrebels",
  };

  let selected = {
    year: YEAR_ALL,
    brand: BRAND_ALL,
    destinations: [],
  };
  /** @type {InstanceType<typeof window.TAMultiSelectFilter> | null} */
  let annDestMulti = null;

  function setError(msg) {
    if (!els.error) return;
    if (!msg) {
      els.error.classList.add("d-none");
      els.error.textContent = "";
      return;
    }
    els.error.textContent = msg;
    els.error.classList.remove("d-none");
  }

  async function fetchJson(url) {
    const res = await fetch(url, { credentials: "same-origin", headers: { Accept: "application/json" } });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    return data;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function setButtonsEnabled(enabled) {
    if (els.applyBtn) els.applyBtn.disabled = !enabled;
    if (els.resetBtn) els.resetBtn.disabled = !enabled;
  }

  function setApplying(loading) {
    if (els.applyBtn) {
      els.applyBtn.disabled = loading;
      els.applyBtn.textContent = loading ? "Even geduld…" : "Filters toepassen";
    }
    if (els.resetBtn) els.resetBtn.disabled = loading;
  }

  async function loadOptions() {
    const data = await fetchJson(API_OPT);
    const brands = Array.isArray(data.brands) ? data.brands : [];
    const destinations = Array.isArray(data.bestemmingen) ? data.bestemmingen : [];

    els.brandSelect.innerHTML = '<option value="__all__">Alle merken</option>';
    brands.forEach((b) => {
      const opt = document.createElement("option");
      opt.value = String(b);
      opt.textContent = String(b);
      els.brandSelect.appendChild(opt);
    });
    els.brandSelect.value = BRAND_ALL;

    els.destinationSelect.innerHTML = '<option value="">Alle bestemmingen</option>';
    destinations.forEach((d) => {
      const opt = document.createElement("option");
      opt.value = String(d.id || "");
      opt.textContent = String(d.naam || "");
      els.destinationSelect.appendChild(opt);
    });
    if (!annDestMulti && typeof window.TAMultiSelectFilter === "function") {
      annDestMulti = new window.TAMultiSelectFilter({
        selectEl: els.destinationSelect,
        placeholderAll: "Alle bestemmingen",
        searchPlaceholder: "Zoek bestemming...",
        itemLabelSingle: "bestemming",
        itemLabelPlural: "bestemmingen geselecteerd",
      });
    } else {
      annDestMulti?.syncOptionsFromSelect();
    }
    annDestMulti?.setValue([]);

    await refreshYears(BRAND_ALL);
  }

  async function refreshYears(brand) {
    const url = new URL(API_YEARS, window.location.origin);
    url.searchParams.set("brand", brand || BRAND_ALL);
    const data = await fetchJson(url.toString());
    const years = Array.isArray(data.years) ? data.years : [];
    els.yearSelect.innerHTML = '<option value="0">Alle jaren</option>';
    years.forEach((y) => {
      const opt = document.createElement("option");
      opt.value = String(y);
      opt.textContent = String(y);
      els.yearSelect.appendChild(opt);
    });
    const cy = new Date().getFullYear();
    const yearNums = years.map((x) => Number(x)).filter((n) => Number.isFinite(n));
    const defaultYear = yearNums.includes(cy) ? cy : YEAR_ALL;
    els.yearSelect.value = String(defaultYear);
    selected.year = defaultYear;
  }

  function renderKpis(kpis) {
    const bookings = Number(kpis.cancelled_bookings || 0);
    const travellers = Number(kpis.cancelled_travellers || 0);
    const revenue = Number(kpis.cancelled_revenue || 0);
    const share = Number(kpis.cancelled_share_pct || 0);
    if (els.kpiBookings) els.kpiBookings.textContent = nfInt.format(bookings);
    if (els.kpiTravellers) els.kpiTravellers.textContent = nfInt.format(travellers);
    if (els.kpiRevenue) els.kpiRevenue.textContent = nfMoney.format(revenue);
    if (els.kpiShare) els.kpiShare.textContent = `${nfPct.format(share)}%`;
  }

  function destroyCharts() {
    Object.keys(donutCharts).forEach((key) => {
      if (donutCharts[key]) donutCharts[key].destroy();
      delete donutCharts[key];
    });
    if (destChart) {
      destChart.destroy();
      destChart = null;
    }
  }

  function truncateLabel(value, max = 34) {
    const s = String(value || "");
    if (s.length <= max) return s;
    return `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
  }

  function syncDestNav() {
    const nav = document.getElementById("annDestChartNav");
    const prev = document.getElementById("annDestChartPrev");
    const next = document.getElementById("annDestChartNext");
    const info = document.getElementById("annDestChartPageInfo");
    if (!destPaginator) {
      if (nav) nav.classList.add("d-none");
      return;
    }
    const total = destPaginator.items.length;
    if (!nav || !prev || !next || !info) return;
    if (total <= DEST_PAGE_SIZE) {
      nav.classList.add("d-none");
      return;
    }
    nav.classList.remove("d-none");
    const meta = destPaginator.getInfo();
    info.textContent = `${meta.start}-${meta.end} van ${meta.total}`;
    prev.disabled = !destPaginator.canPrev();
    next.disabled = !destPaginator.canNext();
  }

  function renderBrandDonuts(rows) {
    rows.forEach((row) => {
      const canvasId = donutIdByBrand[row.brand];
      const canvas = canvasId ? document.getElementById(canvasId) : null;
      if (!canvas) return;
      if (donutCharts[row.brand]) donutCharts[row.brand].destroy();

      const cancelledBookings = Number(row.cancelled_bookings || 0);
      const totalBookings = Number(row.total_bookings || 0);
      const nonCancelled = Math.max(0, totalBookings - cancelledBookings);
      const pct = Number(row.cancelled_share_pct || 0);
      const pax = Number(row.cancelled_travellers || 0);
      const revenue = Number(row.cancelled_revenue || 0);
      const wrap = canvas.parentElement;
      let emptyNote = wrap ? wrap.querySelector("[data-ann-empty-note]") : null;

      if (totalBookings <= 0) {
        canvas.classList.add("d-none");
        if (!emptyNote && wrap) {
          emptyNote = document.createElement("p");
          emptyNote.setAttribute("data-ann-empty-note", "1");
          emptyNote.className = "small text-muted text-center mb-0 pt-5";
          emptyNote.textContent = "Geen data voor dit merk.";
          wrap.appendChild(emptyNote);
        }
        return;
      }
      canvas.classList.remove("d-none");
      if (emptyNote) emptyNote.remove();

      donutCharts[row.brand] = new Chart(canvas.getContext("2d"), {
        type: "doughnut",
        data: {
          labels: ["Annulaties", "Overige boekingen"],
          datasets: [
            {
              data: [cancelledBookings, nonCancelled],
              backgroundColor: ["#ea580c", "#e2e8f0"],
              borderWidth: 0,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: "58%",
          plugins: {
            legend: { position: "bottom" },
            tooltip: {
              callbacks: {
                label: (ctx) => {
                  const label = ctx.label || "";
                  if (label === "Annulaties") {
                    return `${nfPct.format(pct)}% · ${nfInt.format(pax)} pax · ${nfInt.format(cancelledBookings)} boekingen · ${nfMoney.format(revenue)}`;
                  }
                  return `${nfInt.format(nonCancelled)} boekingen`;
                },
              },
            },
          },
        },
      });
    });
  }

  function renderDestinationChart(rows, keepOffset = false) {
    const canvas = document.getElementById("annDestBarChart");
    if (!canvas) return;
    if (destChart) {
      destChart.destroy();
      destChart = null;
    }

    const sorted = [...rows].sort((a, b) => Number(b.cancelled_share_pct || 0) - Number(a.cancelled_share_pct || 0));
    const normalized = sorted.map((r) => ({
      label: String(r.destination || "Onbekend"),
      value: Number(r.cancelled_share_pct || 0),
      pct: Number(r.cancelled_share_pct || 0),
      pax: Number(r.cancelled_travellers || 0),
      bookings: Number(r.cancelled_bookings || 0),
      revenue: Number(r.cancelled_revenue || 0),
    }));
    const activeRows = (() => {
      if (!destPaginator) return normalized.slice(0, DEST_PAGE_SIZE);
      const oldOffset = destPaginator.offset;
      destPaginator.setItems(normalized);
      if (keepOffset) destPaginator.setOffset(oldOffset);
      return destPaginator.getWindow();
    })();
    const labels = activeRows.map((r) => truncateLabel(r.label));
    const values = activeRows.map((r) => r.value);
    syncDestNav();

    destChart = new Chart(canvas.getContext("2d"), {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            label: "Aandeel annulaties",
            data: values,
            backgroundColor: "#ea580c",
            borderRadius: { topLeft: 0, bottomLeft: 0, topRight: 8, bottomRight: 8 },
            borderSkipped: false,
            barThickness: 18,
            maxBarThickness: 22,
            categoryPercentage: 0.78,
            barPercentage: 0.9,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: "y",
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const d = activeRows[ctx.dataIndex];
                return `${nfPct.format(d.pct)}% · ${nfInt.format(d.pax)} pax · ${nfInt.format(d.bookings)} boekingen · ${nfMoney.format(d.revenue)}`;
              },
            },
          },
        },
        scales: {
          x: {
            beginAtZero: true,
            max: 100,
            ticks: { callback: (v) => `${nfPct.format(Number(v))}%` },
            grid: { drawOnChartArea: false },
          },
          y: {
            grid: { display: false },
            ticks: {
              align: "center",
              crossAlign: "near",
            },
          },
        },
      },
    });
  }

  function toggleEmptyState(hasCancelled) {
    if (els.emptyState) els.emptyState.classList.toggle("d-none", hasCancelled);
    if (els.brandDonutsRow) els.brandDonutsRow.classList.toggle("d-none", !hasCancelled);
    if (els.destChartCard) els.destChartCard.classList.toggle("d-none", !hasCancelled);
    if (els.cancelledTableCard) els.cancelledTableCard.classList.toggle("d-none", !hasCancelled);
  }

  function renderCancelledRows(rows) {
    const tbody = els.cancelledTableBody;
    if (!tbody) return;
    if (!Array.isArray(rows) || !rows.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="text-muted text-center py-3">Geen annulaties gevonden voor de gekozen filters.</td></tr>';
      return;
    }
    tbody.innerHTML = rows
      .map((r) => {
        const departure = String(r.departure_date || "").slice(0, 10) || "—";
        return `<tr>
          <td>${escapeHtml(String(r.booking_number || r.booking_id || "—"))}</td>
          <td>${escapeHtml(String(r.brand || "—"))}</td>
          <td>${escapeHtml(String(r.destination || "—"))}</td>
          <td>${escapeHtml(departure)}</td>
          <td>${escapeHtml(String(r.status || "—"))}</td>
          <td class="text-end">${nfInt.format(Number(r.travellers || 0))}</td>
          <td class="text-end">${nfMoney.format(Number(r.cancelled_revenue || 0))}</td>
        </tr>`;
      })
      .join("");
  }

  async function loadData() {
    const url = new URL(API_DATA, window.location.origin);
    url.searchParams.set("year", String(selected.year));
    url.searchParams.set("brand", selected.brand);
    if (Array.isArray(selected.destinations) && selected.destinations.length) {
      url.searchParams.set("destination", selected.destinations.join(","));
    }

    const payload = await fetchJson(url.toString());
    renderKpis(payload.kpis || {});

    const byBrand = Array.isArray(payload.by_brand) ? payload.by_brand : [];
    const byDestination = Array.isArray(payload.by_destination) ? payload.by_destination : [];
    const cancelledRows = Array.isArray(payload.cancelled_rows) ? payload.cancelled_rows : [];
    const hasCancelled = Number((payload.kpis || {}).cancelled_bookings || 0) > 0;

    toggleEmptyState(hasCancelled);
    renderCancelledRows(cancelledRows);
    destroyCharts();
    if (hasCancelled) {
      renderBrandDonuts(byBrand);
      renderDestinationChart(byDestination);
    }
  }

  async function applyFilters() {
    setApplying(true);
    setError("");
    try {
      await loadData();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setApplying(false);
    }
  }

  async function resetFilters() {
    els.brandSelect.value = BRAND_ALL;
    annDestMulti?.clear();
    await refreshYears(BRAND_ALL);
    selected.brand = BRAND_ALL;
    selected.destinations = [];
    await applyFilters();
  }

  els.brandSelect.addEventListener("change", async () => {
    selected.brand = els.brandSelect.value || BRAND_ALL;
    try {
      await refreshYears(selected.brand);
      setButtonsEnabled(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  });
  els.yearSelect.addEventListener("change", () => {
    selected.year = Number(els.yearSelect.value || YEAR_ALL);
    setButtonsEnabled(true);
  });
  els.destinationSelect.addEventListener("change", () => {
    selected.destinations = annDestMulti?.getValue() || [];
    setButtonsEnabled(true);
  });
  if (els.applyBtn) els.applyBtn.addEventListener("click", applyFilters);
  if (els.resetBtn) els.resetBtn.addEventListener("click", resetFilters);
  document.getElementById("annDestChartPrev")?.addEventListener("click", () => {
    if (!destPaginator) return;
    destPaginator.prevPage();
    renderDestinationChart(destPaginator.items, true);
  });
  document.getElementById("annDestChartNext")?.addEventListener("click", () => {
    if (!destPaginator) return;
    destPaginator.nextPage();
    renderDestinationChart(destPaginator.items, true);
  });

  (async () => {
    try {
      await loadOptions();
      setButtonsEnabled(true);
      await applyFilters();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setButtonsEnabled(false);
    }
  })();
})();
