 (function () {
  const RBAC = window.__RBAC__ || {};
  const IS_RESTRICTED_ROLE = Boolean(RBAC.isRestricted);
  const FORCED_YEAR = Number(RBAC.currentYear) || new Date().getFullYear();
  const state = {
    allAllotments: [],
    filteredAllotments: [],
    visibleCount: 50,
    sortering: { kolom: "", richting: "" },
    grafiekCapaciteit: null,
    grafiekCapaciteitTijd: null,
    capaciteitOffset: 0,
    capaciteitWindow: 7,
    capaciteitDatasetCache: { labels: [], total: [], booked: [], free: [], yMax: 10 },
  };
  /** @type {InstanceType<typeof window.TAMultiSelectFilter> | null} */
  let preAgencyMulti = null;
  /** @type {InstanceType<typeof window.TAMultiSelectFilter> | null} */
  let preWayMulti = null;
  /** @type {InstanceType<typeof window.TAMultiSelectFilter> | null} */
  let preDestMulti = null;

  function euro(v) {
    return new Intl.NumberFormat("nl-BE", { style: "currency", currency: "EUR" }).format(Number(v || 0));
  }
  function nummer(v) {
    return new Intl.NumberFormat("nl-BE").format(Number(v || 0));
  }
  function procent(v) {
    return `${Number(v || 0).toFixed(1)}%`;
  }

  function formatDateSlash(value, fallback = "-") {
    const raw = String(value || "").trim();
    if (!raw) return fallback;
    if (window.TADate && typeof window.TADate.formatDate === "function") {
      const out = window.TADate.formatDate(raw, raw);
      if (out && out !== raw) return out.replace(/-/g, "/");
    }
    const iso = raw.match(/^(\d{4})[-/](\d{2})[-/](\d{2})/);
    if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
    const be = raw.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
    if (be) return `${be[1]}/${be[2]}/${be[3]}`;
    return raw;
  }

  function leesFilters() {
    const agencies = preAgencyMulti ? preAgencyMulti.getValue() : [];
    const ways = preWayMulti ? preWayMulti.getValue() : [];
    const bestemmingen = preDestMulti ? preDestMulti.getValue() : [];
    return {
      jaar: document.getElementById("filterJaar").value,
      arrival_van: document.getElementById("filterArrivalVan").value,
      arrival_tot: document.getElementById("filterArrivalTot").value,
      agencies,
      ways,
      bestemmingen,
    };
  }

  function getDateInputISO(inputId) {
    const input = document.getElementById(inputId);
    if (!input) return null;
    if (input.type === "date") {
      // Date inputs leveren standaard YYYY-MM-DD; gebruik die direct (geen timezone-shift).
      const raw = String(input.value || "").trim();
      return raw || null;
    }
    return toISODateOnly(input.value);
  }

  function parseBelgianDateToISO(value) {
    const raw = String(value || "").trim();
    if (!raw) return null;
    const m = raw.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
    if (!m) return null;
    const d = m[1].padStart(2, "0");
    const mo = m[2].padStart(2, "0");
    const y = m[3];
    return `${y}-${mo}-${d}`;
  }

  function toISODateOnly(value) {
    if (!value) return null;
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      const y = value.getFullYear();
      const m = String(value.getMonth() + 1).padStart(2, "0");
      const d = String(value.getDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    }
    const raw = String(value).trim();
    if (!raw) return null;

    const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;

    return parseBelgianDateToISO(raw);
  }

  function isDateInInclusiveRange(value, from, to) {
    const valueISO = toISODateOnly(value);
    const fromISO = toISODateOnly(from);
    const toISO = toISODateOnly(to);

    if (!valueISO) return false;
    if (fromISO && valueISO < fromISO) return false;
    if (toISO && valueISO > toISO) return false;
    return true;
  }

  function getBestemmingFromWay(way) {
    const raw = String(way || "").trim();
    if (!raw) return "Onbekend";
    const parts = raw.split("-").map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 3 && parts[1]) return parts[1];
    if (parts.length >= 2 && parts[1]) return parts[1];
    return "Onbekend";
  }

  function getArrivalRaw(row) {
    return (
      row?.arrival ??
      row?.aankomst_datum ??
      row?.aankomstdag ??
      row?.aankomstdatum ??
      row?.arrival_date ??
      row?.arrival_day ??
      row?.aankomst ??
      null
    );
  }

  function bezettingKleur(bez) {
    if (bez < 50) return "#dc2626";
    if (bez <= 80) return "#f97316";
    return "#16a34a";
  }

  function berekenRij(r) {
    const total = Math.max(Number(r.total_pax || 0), 0);
    const booked = Math.max(Number(r.booked_pax || 0), 0);
    const free = Math.max(Number(r.still_free || 0), 0);
    const ppOut = Number(r.pp_outbound || 0);
    const ppIn = Number(r.pp_inbound || 0);
    const fillRate = total > 0 ? Number(((booked / total) * 100).toFixed(1)) : 0;
    const openstaandeKost = free * (ppOut + ppIn);
    return {
      ...r,
      total_pax_num: total,
      booked_pax_num: booked,
      still_free_num: free,
      pp_outbound_num: ppOut,
      pp_inbound_num: ppIn,
      fill_rate: fillRate,
      openstaande_kost: openstaandeKost,
      bestemming: getBestemmingFromWay(r.way),
      arrival_ymd: toISODateOnly(getArrivalRaw(r)),
    };
  }

  function statusVanRij(r) {
    const bez = Number(r.fill_rate || 0);
    if (bez >= 100) return { label: "Volzet", klasse: "pre-status-volzet", sort: 5 };
    if (bez > 85) return { label: "Oké", klasse: "pre-status-oke", sort: 4 };
    if (bez > 60) return { label: "Let op", klasse: "pre-status-letop", sort: 3 };
    if (bez > 30) return { label: "Warning", klasse: "pre-status-warning", sort: 2 };
    return { label: "Risico", klasse: "pre-status-risico", sort: 1 };
  }

  function renderKpi() {
    const rows = state.filteredAllotments;
    const totaal = rows.reduce((s, r) => s + Number(r.total_pax_num || 0), 0);
    const verkocht = rows.reduce((s, r) => s + Number(r.booked_pax_num || 0), 0);
    const open = rows.reduce((s, r) => s + Number(r.still_free_num || 0), 0);
    const openstaandeKost = rows.reduce((s, r) => s + Number(r.openstaande_kost || 0), 0);
    const bezetting = totaal > 0 ? (verkocht / totaal) * 100 : 0;

    const items = [
      ["Totaal", nummer(totaal)],
      ["Verkocht", nummer(verkocht)],
      ["Over", nummer(open)],
      ["Gemiddelde bezettingsgraad", procent(bezetting)],
      ["Kosten", euro(openstaandeKost)],
    ];
    document.getElementById("vluchtKpiKaarten").innerHTML = items
      .map(
        ([label, value]) => {
          const isKosten = label === "Kosten";
          const labelHtml = isKosten
            ? `<div class="label info-popover-block">
                 <div class="info-popover-head">
                   <button
                     type="button"
                     class="info-popover-trigger"
                     data-info-popover-trigger="info-pre-kosten-kpi"
                     aria-label="Uitleg over kosten"
                     aria-expanded="false"
                     aria-haspopup="dialog"
                   >
                     i
                   </button>
                   <span>${label}</span>
                 </div>
                 <div id="info-pre-kosten-kpi" class="info-popover-panel" data-info-popover-panel role="dialog" aria-label="Uitleg" hidden>
                   <button type="button" class="info-popover-close" data-info-popover-close aria-label="Sluiten">&times;</button>
                   <p class="info-popover-text">
                     Deze KPI toont de totale openstaande vluchtkost in de huidige selectie, op basis van heen- en terugprijs per allotment. Zo zie je in één oogopslag het totale financiële risico op niet-verkochte capaciteit.
                   </p>
                 </div>
               </div>`
            : `<div class="label">${label}</div>`;

          return `<div class="col-6 col-xl"><div class="pre-kpi-card h-100 p-3 ${isKosten ? "pre-kpi-card--danger" : ""}">${labelHtml}<div class="value">${value}</div></div></div>`;
        }
      )
      .join("");
  }

  function bepaalMooiYMaximum(rawMax) {
    const value = Number(rawMax || 0);
    if (value <= 10) return 10;
    if (value <= 25) return 25;
    if (value <= 50) return 50;
    if (value <= 100) return 100;
    const step = value <= 250 ? 25 : value <= 500 ? 50 : 100;
    return Math.ceil(value / step) * step;
  }

  function bouwCapaciteitDataset(rows) {
    const groepeer = new Map();
    rows.forEach((r) => {
      const key = String(getArrivalRaw(r) || r.arrival_ymd || "").slice(0, 10);
      if (!key) return;
      const current = groepeer.get(key) || { total: 0, booked: 0, free: 0 };
      current.total += Number(r.total_pax_num || 0);
      current.booked += Number(r.booked_pax_num || 0);
      current.free += Number(r.still_free_num || 0);
      groepeer.set(key, current);
    });

    const bestaandeDatums = Array.from(groepeer.keys()).sort();
    const labels = [];
    if (bestaandeDatums.length > 0) {
      const startDate = new Date(`${bestaandeDatums[0]}T00:00:00`);
      const endDate = new Date(`${bestaandeDatums[bestaandeDatums.length - 1]}T00:00:00`);
      for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
        labels.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
      }
    }

    const total = labels.map((label) => Number(groepeer.get(label)?.total || 0));
    const booked = labels.map((label) => Number(groepeer.get(label)?.booked || 0));
    const free = labels.map((label) => Number(groepeer.get(label)?.free || 0));
    const yMax = bepaalMooiYMaximum(Math.max(...total, ...booked, ...free, 0));
    return { labels, total, booked, free, yMax };
  }

  function renderCapaciteitKaart() {
    if (typeof Chart === "undefined") return;
    const total = state.filteredAllotments.reduce((s, r) => s + Number(r.total_pax_num || 0), 0);
    const booked = state.filteredAllotments.reduce((s, r) => s + Number(r.booked_pax_num || 0), 0);
    const free = state.filteredAllotments.reduce((s, r) => s + Number(r.still_free_num || 0), 0);
    const ctxCap = document.getElementById("grafiekCapaciteit");
    if (ctxCap) {
      state.grafiekCapaciteit?.destroy();
      const totaal = Math.max(total, 0);
      const verkochtDeel = Math.max(booked, 0);
      const openstaandDeel = Math.max(free, 0);
      state.grafiekCapaciteit = new Chart(ctxCap, {
        type: "doughnut",
        data: {
          labels: ["Aandeel verkocht", "Aandeel openstaand"],
          datasets: [{ data: [verkochtDeel, openstaandDeel], backgroundColor: ["#f97316", "#cbd5e1"] }],
        },
        options: {
          maintainAspectRatio: true,
          cutout: "58%",
          plugins: {
            legend: { position: "bottom" },
            tooltip: {
              callbacks: {
                label(context) {
                  const value = Number(context.raw || 0);
                  const all = context.dataset?.data || [];
                  const totalValue = all.reduce((sum, v) => sum + Number(v || 0), 0);
                  const pct = totalValue > 0 ? (value / totalValue) * 100 : 0;
                  return `${context.label}: ${nummer(value)} (${pct.toFixed(1)}% van totaal)`;
                },
              },
            },
          },
        },
      });
    }
  }

  function renderCapaciteitTijdGrafiek() {
    if (typeof Chart === "undefined") return;
    const ctxTijd = document.getElementById("grafiekCapaciteitTijd");
    if (ctxTijd) {
      const dataset = state.capaciteitDatasetCache;
      const labels = dataset.labels;
      const maxWindowIndex = Math.max(Math.ceil(labels.length / state.capaciteitWindow) - 1, 0);
      state.capaciteitOffset = Math.max(0, Math.min(state.capaciteitOffset, maxWindowIndex));
      const start = state.capaciteitOffset * state.capaciteitWindow;
      const end = Math.min(labels.length, start + state.capaciteitWindow);
      const windowLabels = labels.slice(start, end);
      const totalData = dataset.total.slice(start, end);
      const bookedData = dataset.booked.slice(start, end);
      const freeData = dataset.free.slice(start, end);
      const periodeNode = document.getElementById("capaciteitPeriodeLabel");
      if (periodeNode) {
        periodeNode.textContent = windowLabels.length
          ? `${formatDateSlash(windowLabels[0], windowLabels[0])} t/m ${formatDateSlash(windowLabels[windowLabels.length - 1], windowLabels[windowLabels.length - 1])}`
          : "-";
      }
      const btnPrev = document.getElementById("btnCapaciteitVorige");
      const btnNext = document.getElementById("btnCapaciteitVolgende");
      if (btnPrev) btnPrev.disabled = state.capaciteitOffset <= 0;
      if (btnNext) btnNext.disabled = state.capaciteitOffset >= maxWindowIndex;

      if (!state.grafiekCapaciteitTijd) {
        state.grafiekCapaciteitTijd = new Chart(ctxTijd, {
          type: "bar",
          data: {
            labels: windowLabels.map((lbl) => formatDateSlash(lbl, lbl)),
            datasets: [
              {
                label: "Totale capaciteit",
                data: totalData,
                backgroundColor: "#94a3b8",
                stack: "totaal",
              },
              {
                label: "Verkochte plaatsen",
                data: bookedData,
                backgroundColor: "#f97316",
                stack: "bezetting",
              },
              {
                label: "Openstaande plaatsen",
                data: freeData,
                backgroundColor: "#cbd5e1",
                stack: "bezetting",
              },
            ],
          },
          options: {
            interaction: {
              mode: "index",
              axis: "x",
              intersect: false,
            },
            hover: {
              mode: "index",
              axis: "x",
              intersect: false,
            },
            plugins: {
              legend: { display: true, position: "bottom" },
              tooltip: {
                mode: "index",
                intersect: false,
                callbacks: {
                  label(context) {
                    const waarde = Number(context.raw || 0);
                    return `${context.dataset.label}: ${nummer(waarde)}`;
                  },
                },
              },
            },
            scales: { y: { beginAtZero: true, max: dataset.yMax } },
          },
        });
      } else {
        state.grafiekCapaciteitTijd.data.labels = windowLabels.map((lbl) => formatDateSlash(lbl, lbl));
        state.grafiekCapaciteitTijd.data.datasets[0].data = totalData;
        state.grafiekCapaciteitTijd.data.datasets[1].data = bookedData;
        state.grafiekCapaciteitTijd.data.datasets[2].data = freeData;
        state.grafiekCapaciteitTijd.data.datasets[0].stack = "totaal";
        state.grafiekCapaciteitTijd.data.datasets[1].stack = "bezetting";
        state.grafiekCapaciteitTijd.data.datasets[2].stack = "bezetting";
        state.grafiekCapaciteitTijd.options.scales.y.max = dataset.yMax;
        state.grafiekCapaciteitTijd.options.interaction = { mode: "index", axis: "x", intersect: false };
        state.grafiekCapaciteitTijd.options.hover = { mode: "index", axis: "x", intersect: false };
        state.grafiekCapaciteitTijd.options.plugins.tooltip = {
          mode: "index",
          intersect: false,
          callbacks: {
            label(context) {
              const waarde = Number(context.raw || 0);
              return `${context.dataset.label}: ${nummer(waarde)}`;
            },
          },
        };
        state.grafiekCapaciteitTijd.update("none");
      }
    }
  }

  function zoekTekstMatch(r, query) {
    if (!query) return true;
    const hay = [r.outbound_flight, r.inbound_flight, r.agency, r.way, r.bestemming, r.arrival, r.departure]
      .map((v) => String(v || "").toLowerCase())
      .join(" ");
    return hay.includes(query);
  }

  function applyClientFilters() {
    const query = "";
    const filters = leesFilters();
    let fromISO = getDateInputISO("filterArrivalVan") || toISODateOnly(filters.arrival_van);
    let toISO = getDateInputISO("filterArrivalTot") || toISODateOnly(filters.arrival_tot);
    if (fromISO && toISO && fromISO > toISO) {
      const tmp = fromISO;
      fromISO = toISO;
      toISO = tmp;
    }
    state.filteredAllotments = state.allAllotments.filter((r) => {
      if (!zoekTekstMatch(r, query)) return false;
      const arrivalRaw = getArrivalRaw(r) ?? r.arrival_ymd;
      const arrivalISO = toISODateOnly(arrivalRaw);
      if (filters.jaar && filters.jaar !== "__all__" && (!arrivalISO || !arrivalISO.startsWith(`${filters.jaar}`))) return false;
      if ((fromISO || toISO) && !isDateInInclusiveRange(arrivalRaw, fromISO, toISO)) return false;
      if (filters.agencies.length && !filters.agencies.includes(String(r.agency || ""))) return false;
      if (filters.ways.length && !filters.ways.includes(String(r.way || ""))) return false;
      if (filters.bestemmingen.length && !filters.bestemmingen.includes(String(r.bestemming || "Onbekend"))) return false;
      return true;
    });
    const allArrivalIsos = state.allAllotments
      .map((r) => toISODateOnly(getArrivalRaw(r) ?? r.arrival_ymd))
      .filter(Boolean)
      .sort();
    const minArrival = allArrivalIsos.length ? allArrivalIsos[0] : "-";
    const maxArrival = allArrivalIsos.length ? allArrivalIsos[allArrivalIsos.length - 1] : "-";
    const meldingEl = document.getElementById("preBoekingenMelding");
    if (meldingEl) {
      if ((fromISO || toISO) && state.filteredAllotments.length === 0) {
        meldingEl.className = "alert alert-warning";
        meldingEl.textContent = `Geen resultaten voor deze aankomstperiode. Beschikbare aankomstdatums lopen van ${minArrival} t/m ${maxArrival}. Controleer of het jaar klopt.`;
        meldingEl.classList.remove("d-none");
      } else {
        meldingEl.classList.add("d-none");
      }
    }
    if (state.sortering.kolom && state.sortering.richting) {
      sorteerRijen(state.sortering.kolom, state.sortering.richting);
    }
    state.capaciteitDatasetCache = bouwCapaciteitDataset(state.filteredAllotments);
  }

  function sorteerWaarde(r, kolom) {
    if (kolom === "bezetting") return Number(r.fill_rate || 0);
    if (kolom === "status") return statusVanRij(r).sort;
    if (["total_pax", "booked_pax", "still_free", "pp_outbound", "pp_inbound", "openstaande_kost"].includes(kolom)) {
      return Number(r[kolom] || 0);
    }
    return r[kolom] || "";
  }

  function sorteerRijen(kolom, richting) {
    const factor = richting === "asc" ? 1 : -1;
    state.filteredAllotments.sort((a, b) => {
      const va = sorteerWaarde(a, kolom);
      const vb = sorteerWaarde(b, kolom);
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * factor;
      return String(va).localeCompare(String(vb), "nl", { sensitivity: "base" }) * factor;
    });
  }

  function updateSortHeaders() {
    document.querySelectorAll(".pre-tabel thead th[data-sort]").forEach((th) => {
      th.classList.remove("sort-actief");
      const kolom = th.getAttribute("data-sort");
      if (kolom === state.sortering.kolom && state.sortering.richting) {
        th.classList.add("sort-actief");
      }
    });
  }

  function renderTabel() {
    const body = document.getElementById("vluchtTabelBody");
    const shown = state.filteredAllotments.slice(0, state.visibleCount);
    body.innerHTML = shown
      .map((r, i) => {
        const bezettingsgraad = Number(r.fill_rate || 0);
        const kleur = bezettingKleur(bezettingsgraad);
        const status = statusVanRij(r);
        return `<tr data-idx="${i}">
          <td title="${r.arrival || ""}">${r.arrival || ""}</td><td title="${r.departure || ""}">${r.departure || ""}</td><td title="${r.agency || ""}">${r.agency || ""}</td><td title="${r.bestemming || "Onbekend"}">${r.bestemming || "Onbekend"}</td>
          <td title="${nummer(r.total_pax_num)}">${nummer(r.total_pax_num)}</td><td title="${nummer(r.booked_pax_num)}">${nummer(r.booked_pax_num)}</td><td title="${nummer(r.still_free_num)}">${nummer(r.still_free_num)}</td>
          <td title="${r.pp_outbound == null ? "-" : euro(r.pp_outbound)}">${r.pp_outbound == null ? "-" : euro(r.pp_outbound)}</td><td title="${r.pp_inbound == null ? "-" : euro(r.pp_inbound)}">${r.pp_inbound == null ? "-" : euro(r.pp_inbound)}</td>
          <td class="bezetting-cell" title="${procent(bezettingsgraad)}"><div class="d-flex justify-content-between"><span>${procent(bezettingsgraad)}</span></div><div class="bezetting-bar"><span style="width:${Math.min(100, bezettingsgraad)}%;background:${kleur};"></span></div></td>
          <td class="pre-status-cell" title="${status.label}"><span class="pre-status-badge ${status.klasse}">${status.label}</span></td>
          <td title="${euro(r.openstaande_kost)}">${euro(r.openstaande_kost)}</td>
        </tr>`;
      })
      .join("");
    body.querySelectorAll("tr").forEach((tr) => tr.addEventListener("click", () => openDetail(Number(tr.dataset.idx))));
    document.getElementById("tabelAantalTekst").textContent = `${Math.min(state.visibleCount, state.filteredAllotments.length)} van ${state.filteredAllotments.length} allotments weergegeven`;
  }

  function openDetail(idx) {
    const r = state.filteredAllotments[idx];
    if (!r) return;
    const status = statusVanRij(r);
    document.getElementById("vluchtDetailInhoud").innerHTML = `
      <div class="pre-detail-grid">
        <div class="pre-detail-card">
          <h4>Algemene info</h4>
          <ul class="pre-detail-list">
            <li>Aankomst: ${r.arrival || "-"}</li>
            <li>Vertrek: ${r.departure || "-"}</li>
            <li>Agentschap: ${r.agency || "-"}</li>
            <li>Route: ${r.way || "-"}</li>
            <li>Status: <span class="pre-status-badge ${status.klasse}">${status.label}</span></li>
          </ul>
        </div>
        <div class="pre-detail-card">
          <h4>Vluchten</h4>
          <ul class="pre-detail-list">
            <li>Heenvlucht: ${r.outbound_flight || "-"}</li>
            <li>Terugvlucht: ${r.inbound_flight || "-"}</li>
          </ul>
        </div>
        <div class="pre-detail-card">
          <h4>Capaciteit</h4>
          <ul class="pre-detail-list">
            <li>Totale capaciteit: ${nummer(r.total_pax_num)}</li>
            <li>Verkochte plaatsen: ${nummer(r.booked_pax_num)}</li>
            <li>Openstaande plaatsen: ${nummer(r.still_free_num)}</li>
            <li>Bezettingsgraad: ${procent(r.fill_rate)}</li>
          </ul>
        </div>
        <div class="pre-detail-card">
          <h4>Prijzen</h4>
          <ul class="pre-detail-list">
            <li>Prijs heen: ${euro(r.pp_outbound_num)}</li>
            <li>Prijs terug: ${euro(r.pp_inbound_num)}</li>
            <li>Openstaande kost: ${euro(r.openstaande_kost)}</li>
          </ul>
        </div>
      </div>
    `;
    const drawer = bootstrap.Offcanvas.getOrCreateInstance(document.getElementById("vluchtDetailDrawer"));
    drawer.show();
  }

  function laadOpties() {
    const set = (id, values, allLabel) => {
      const el = document.getElementById(id);
      if (!el) return;
      const first = "__all__";
      el.innerHTML = `<option value="${first}">${allLabel}</option>` + (values || []).map((v) => `<option value="${v}">${v}</option>`).join("");
    };

    const jaren = Array.from(new Set(state.allAllotments.map((r) => String(r.arrival || "").slice(0, 4)).filter((y) => /^\d{4}$/.test(y)))).sort((a, b) => Number(b) - Number(a));
    const maatschappijen = Array.from(new Set(state.allAllotments.map((r) => String(r.agency || "").trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b, "nl", { sensitivity: "base" }));
    const routes = Array.from(new Set(state.allAllotments.map((r) => String(r.way || "").trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b, "nl", { sensitivity: "base" }));
    const bestemmingen = Array.from(new Set(state.allAllotments.map((r) => String(r.bestemming || "Onbekend")))).sort((a, b) => a.localeCompare(b, "nl", { sensitivity: "base" }));

    set("filterJaar", jaren, "Jaar");
    if (IS_RESTRICTED_ROLE) {
      const jaarEl = document.getElementById("filterJaar");
      if (jaarEl) {
        jaarEl.innerHTML = `<option value="${FORCED_YEAR}">${FORCED_YEAR}</option>`;
        jaarEl.value = String(FORCED_YEAR);
        jaarEl.disabled = true;
      }
    }
    set("filterAgency", maatschappijen, "Maatschappij");
    set("filterWay", routes, "Route");
    set("filterBestemming", bestemmingen, "Bestemming");
    const ensureMulti = (id, current, placeholder) => {
      const selectEl = document.getElementById(id);
      if (!selectEl || typeof window.TAMultiSelectFilter !== "function") return current;
      if (!current) {
        const inst = new window.TAMultiSelectFilter({
          selectEl,
          placeholderAll: placeholder,
          searchPlaceholder: "Zoek...",
          itemLabelSingle: "selectie",
          itemLabelPlural: "selecties",
        });
        return inst;
      }
      current.syncOptionsFromSelect();
      return current;
    };
    preAgencyMulti = ensureMulti("filterAgency", preAgencyMulti, "Alle maatschappijen");
    preWayMulti = ensureMulti("filterWay", preWayMulti, "Alle routes");
    preDestMulti = ensureMulti("filterBestemming", preDestMulti, "Alle bestemmingen");
  }

  async function laadData() {
    const res = await fetch(`${window.__PRE_BOEKINGEN_DATA_URL__}`);
    const data = await res.json();
    state.allAllotments = (data.rows || []).map(berekenRij);
    laadOpties();
    applyClientFilters();
    state.capaciteitOffset = 0;
    renderKpi();
    renderCapaciteitKaart();
    renderCapaciteitTijdGrafiek();
    updateSortHeaders();
    renderTabel();
  }

  function refreshVolledigePagina() {
    applyClientFilters();
    renderKpi();
    renderCapaciteitKaart();
    renderCapaciteitTijdGrafiek();
    updateSortHeaders();
    renderTabel();
  }

  document.addEventListener("DOMContentLoaded", async () => {
    try {
      await laadData();
      document.getElementById("btnFiltersToepassen").addEventListener("click", () => {
        state.capaciteitOffset = 0;
        refreshVolledigePagina();
      });
      document.getElementById("btnFiltersWissen").addEventListener("click", () => {
        document.getElementById("filterJaar").value = IS_RESTRICTED_ROLE ? String(FORCED_YEAR) : "__all__";
        document.getElementById("filterArrivalVan").value = "";
        document.getElementById("filterArrivalTot").value = "";
        preAgencyMulti?.clear();
        preWayMulti?.clear();
        preDestMulti?.clear();
        const zoekbalkEl = document.getElementById("vluchtZoekbalk");
        if (zoekbalkEl) {
          zoekbalkEl.value = "";
        }
        state.visibleCount = 50;
        state.capaciteitOffset = 0;
        state.sortering = { kolom: "", richting: "" };
        const meldingEl = document.getElementById("preBoekingenMelding");
        if (meldingEl) {
          meldingEl.classList.add("d-none");
          meldingEl.textContent = "";
        }
        refreshVolledigePagina();
      });

      document.querySelectorAll(".pre-tabel thead th[data-sort]").forEach((th) => {
        th.addEventListener("click", () => {
          const kolom = th.getAttribute("data-sort");
          if (!kolom) return;
          if (state.sortering.kolom !== kolom) {
            state.sortering = { kolom, richting: "asc" };
          } else if (state.sortering.richting === "asc") {
            state.sortering = { kolom, richting: "desc" };
          } else if (state.sortering.richting === "desc") {
            state.sortering = { kolom: "", richting: "" };
          } else {
            state.sortering = { kolom, richting: "asc" };
          }
          applyClientFilters();
          updateSortHeaders();
          renderTabel();
        });
      });

      const zoekbalkEl = document.getElementById("vluchtZoekbalk");
      if (zoekbalkEl) {
        zoekbalkEl.addEventListener("input", () => {
          state.visibleCount = 50;
          state.capaciteitOffset = 0;
          refreshVolledigePagina();
        });
      }
      document.getElementById("btnMeerWeergeven").addEventListener("click", () => {
        state.visibleCount += 50;
        renderTabel();
      });
      document.getElementById("btnMinderWeergeven").addEventListener("click", () => {
        state.visibleCount = Math.max(50, state.visibleCount - 50);
        renderTabel();
      });
      document.getElementById("btnCapaciteitVorige").addEventListener("click", () => {
        state.capaciteitOffset = Math.max(state.capaciteitOffset - 1, 0);
        renderCapaciteitTijdGrafiek();
      });
      document.getElementById("btnCapaciteitVolgende").addEventListener("click", () => {
        state.capaciteitOffset += 1;
        renderCapaciteitTijdGrafiek();
      });
      const infoBtn = document.getElementById("btnOpenVluchtUploadInfo");
      const infoModalEl = document.getElementById("vluchtUploadInfoModal");
      if (infoBtn && infoModalEl) {
        const infoModal = bootstrap.Modal.getOrCreateInstance(infoModalEl);
        infoBtn.addEventListener("click", () => infoModal.show());
      }
    } catch (error) {
      const el = document.getElementById("preBoekingenMelding");
      if (el) {
        el.className = "alert alert-danger";
        el.textContent = "Kon pre-boekingen niet initialiseren. Ververs de pagina en probeer opnieuw.";
        el.classList.remove("d-none");
      }
    }
  });
})();
