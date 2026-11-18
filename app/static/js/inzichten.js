(() => {
  const THRESHOLDS = {
    marginLowPct: 10,
    marginCriticalPct: 5,
    cancellationHighPct: 20,
    cancellationWarningPct: 12,
    omzetDeclinePct: -12,
    omzetGrowthPct: 15,
    popularDestinationGrowthPct: 20,
    lowPaxMinBookings: 6,
    lossBookingsWarningPct: 12,
    lossBookingsCriticalPct: 20,
    avgBookingSizeDeviationPct: 35,
    dependencyHighPct: 50,
    dependencyCriticalPct: 65,
  };

  const els = {
    error: document.getElementById("insightsError"),
    alertsGrid: document.getElementById("insightsAlertsGrid"),
    alertsEmpty: document.getElementById("insightsAlertsEmpty"),
    detailsModal: document.getElementById("insightsDetailsModal"),
    detailsModalTitle: document.getElementById("insightsDetailsModalTitle"),
    detailsModalBody: document.getElementById("insightsDetailsModalBody"),
    detailsModalFooter: document.getElementById("insightsDetailsModalFooter"),
  };
  if (!els.alertsGrid || !els.alertsEmpty) return;

  const api = window.__INSIGHTS_API__ || {};
  const OPTIONS_URL = api.financeOptions || "/financieel/options";
  const FINANCE_DATA_URL = api.financeData || "/financieel/data";
  const ANN_DATA_URL = api.annulatiesData || "/annulaties/data";
  const LOSSES_OPTIONS_URL = api.lossesOptions || "/inzichten/verliezen/options";
  const LOSSES_DATA_URL = api.lossesData || "/inzichten/verliezen/data";
  const BRAND_ALL = "__all__";
  const YEAR_ALL = 0;

  const nfInt = new Intl.NumberFormat("nl-NL");
  const nfMoney = new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" });
  const nfPct = new Intl.NumberFormat("nl-NL", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const nfDec = new Intl.NumberFormat("nl-NL", { minimumFractionDigits: 1, maximumFractionDigits: 2 });

  const n = (value) => {
    const x = Number(value);
    return Number.isFinite(x) ? x : 0;
  };
  const pct = (num, den) => (den > 0 ? (num / den) * 100 : 0);

  function setError(msg) {
    if (!els.error) return;
    if (!msg) {
      els.error.classList.add("d-none");
      els.error.textContent = "";
      return;
    }
    els.error.classList.remove("d-none");
    els.error.textContent = msg;
  }

  async function fetchJson(url) {
    const res = await fetch(url, { credentials: "same-origin", headers: { Accept: "application/json" } });
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error("Server gaf geen geldige JSON terug.");
    }
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    return data;
  }

  function aggregateFinance(rows) {
    const out = {
      rowsCount: 0,
      omzet: 0,
      winst: 0,
      pax: 0,
      lossBookings: 0,
      lossImpact: 0,
      byDestination: {},
      bySupplier: {},
      lossByDestination: {},
      lossBySupplier: {},
    };
    const list = Array.isArray(rows) ? rows : [];
    for (const row of list) {
      const omzet = n(row.totaal_te_betalen);
      const winst = n(row.winst);
      const pax = n(row.pax);
      const dest = String(row.destination || "Onbekend").trim() || "Onbekend";
      const supplier = String(row.supplier_acco || "Onbekend").trim() || "Onbekend";

      out.rowsCount += 1;
      out.omzet += omzet;
      out.winst += winst;
      out.pax += pax;

      if (!out.byDestination[dest]) {
        out.byDestination[dest] = { omzet: 0, winst: 0, pax: 0, bookings: 0, suppliers: {} };
      }
      out.byDestination[dest].omzet += omzet;
      out.byDestination[dest].winst += winst;
      out.byDestination[dest].pax += pax;
      out.byDestination[dest].bookings += 1;
      out.byDestination[dest].suppliers[supplier] = (out.byDestination[dest].suppliers[supplier] || 0) + 1;

      if (!out.bySupplier[supplier]) out.bySupplier[supplier] = { omzet: 0, bookings: 0 };
      out.bySupplier[supplier].omzet += omzet;
      out.bySupplier[supplier].bookings += 1;

      if (winst < 0) {
        out.lossBookings += 1;
        out.lossImpact += winst;
        out.lossByDestination[dest] = (out.lossByDestination[dest] || 0) + 1;
        out.lossBySupplier[supplier] = (out.lossBySupplier[supplier] || 0) + 1;
      }
    }
    return out;
  }

  function topN(mapObj, limit = 3, selector = (entry) => entry[1]) {
    return Object.entries(mapObj || {})
      .sort((a, b) => selector(b) - selector(a))
      .slice(0, limit);
  }

  function groupByWorstAndSecond(items, valueSelector) {
    const list = Array.isArray(items) ? [...items] : [];
    if (!list.length) return { worst: [], second: [], worstValue: null, secondValue: null };
    list.sort((a, b) => valueSelector(a) - valueSelector(b));
    const worstValue = valueSelector(list[0]);
    const worst = list.filter((x) => Math.abs(valueSelector(x) - worstValue) < 1e-9);
    const secondValueItem = list.find((x) => valueSelector(x) > worstValue);
    const secondValue = secondValueItem ? valueSelector(secondValueItem) : null;
    const second =
      secondValue == null ? [] : list.filter((x) => Math.abs(valueSelector(x) - secondValue) < 1e-9);
    return { worst, second, worstValue, secondValue };
  }

  function supplierListForGroup(group) {
    const counts = {};
    group.forEach((d) => {
      Object.entries(d.suppliers || {}).forEach(([name, count]) => {
        counts[name] = (counts[name] || 0) + n(count);
      });
    });
    return topN(counts, 3, (e) => n(e[1])).map((x) => x[0]);
  }

  function buildMarginAlerts(curAgg) {
    const destinations = Object.entries(curAgg.byDestination)
      .map(([name, v]) => ({
        name,
        margin: pct(v.winst, v.omzet),
        omzet: v.omzet,
        winst: v.winst,
        pax: v.pax,
        bookings: v.bookings,
        suppliers: v.suppliers,
      }))
      .filter((d) => d.omzet > 0);
    if (!destinations.length) return [];

    const groups = groupByWorstAndSecond(destinations, (x) => x.margin);

    const buildGroupDetails = (group) => {
      const totalOmzet = group.reduce((s, x) => s + x.omzet, 0);
      const totalWinst = group.reduce((s, x) => s + x.winst, 0);
      const totalBookings = group.reduce((s, x) => s + x.bookings, 0);
      const totalPax = group.reduce((s, x) => s + x.pax, 0);
      const topSuppliers = supplierListForGroup(group);
      return {
        destinations: group.map((g) => g.name),
        margin: `${nfPct.format(group[0].margin)}%`,
        omzet: nfMoney.format(totalOmzet),
        winst: nfMoney.format(totalWinst),
        bookings: nfInt.format(totalBookings),
        pax: nfInt.format(totalPax),
        suppliers: topSuppliers.length ? topSuppliers.join(", ") : "niet beschikbaar",
      };
    };

    const low = buildGroupDetails(groups.worst);
    const lowDestLabel = groups.worst.length > 1 ? "meerder bestemmingen" : low.destinations[0];
    const lowVerb = groups.worst.length > 1 ? "zitten" : "zit";
    const alerts = [
      {
        severity: "critical",
        title: "Bestemming met lage marge",
        description: `${lowDestLabel} ${lowVerb} op de laagste marge.`,
        metric: "Marge bestemming",
        value: low.margin,
        comparison: `${groups.worst.length} bestemming(en) met laagste marge`,
        cta: "Bekijk details",
        details: [
          { label: "Betrokken bestemming(en)", items: low.destinations },
          { label: "Margepercentage", value: low.margin },
          { label: "Totale omzet", value: low.omzet },
          { label: "Totale winst", value: low.winst },
          { label: "Aantal boekingen", value: low.bookings },
          { label: "Aantal reizigers", value: low.pax },
          { label: "Belangrijkste leverancier(s)", value: low.suppliers },
        ],
        interpretation:
          "Een structureel lage marge verhoogt het risico op verlies bij kleine kostenstijgingen of prijsdruk.",
        action:
          "Controleer prijszetting, leverancierskost en marge-afspraken voor deze bestemming(en).",
      },
    ];

    if (groups.second.length) {
      const second = buildGroupDetails(groups.second);
      const secondDestLabel = groups.second.length > 1 ? "meerder bestemmingen" : second.destinations[0];
      const secondVerb = groups.second.length > 1 ? "hebben" : "heeft";
      alerts.push({
        severity: "warning",
        title: "Bestemming met lage marge",
        description: `${secondDestLabel} ${secondVerb} de op één na laagste marge binnen de dataset.`,
        metric: "Marge bestemming",
        value: second.margin,
        comparison: `${groups.second.length} bestemming(en) in tweede laagste margegroep`,
        cta: "Bekijk details",
        details: [
          { label: "Betrokken bestemming(en)", items: second.destinations },
          { label: "Margepercentage", value: second.margin },
          { label: "Totale omzet", value: second.omzet },
          { label: "Totale winst", value: second.winst },
          { label: "Aantal boekingen", value: second.bookings },
          { label: "Aantal reizigers", value: second.pax },
          { label: "Belangrijkste leverancier(s)", value: second.suppliers },
        ],
        interpretation:
          "Deze groep zit net boven het kritisch niveau en kan snel doorschuiven naar een verliesrisico.",
        action:
          "Stuur tijdig bij op koststructuur en commerciële voorwaarden om marge-erosie te voorkomen.",
      });
    }

    return alerts;
  }

  function buildCancellationAlerts(annCur) {
    const rows = (annCur?.by_destination || [])
      .map((r) => ({
        destination: String(r.destination || "Onbekend"),
        share: n(r.cancelled_share_pct),
        bookings: n(r.cancelled_bookings),
        travellers: n(r.cancelled_travellers),
        revenue: n(r.cancelled_revenue),
        totalBookings: n(r.total_bookings),
      }))
      .filter((r) => r.totalBookings > 0);
    if (!rows.length) return [];

    const byWorst = groupByWorstAndSecond(
      rows.map((r) => ({ ...r, risk: -r.share })),
      (x) => x.risk,
    );
    const mapGroup = (group) => group.map((x) => ({ ...x, risk: undefined }));
    const worst = mapGroup(byWorst.worst);
    const second = mapGroup(byWorst.second);
    const build = (group, severity) => {
      const first = group[0];
      const names = group.map((g) => g.destination);
      const sumBookings = group.reduce((s, x) => s + x.bookings, 0);
      const sumTravellers = group.reduce((s, x) => s + x.travellers, 0);
      const sumRevenue = group.reduce((s, x) => s + x.revenue, 0);
      const sumTotal = group.reduce((s, x) => s + x.totalBookings, 0);
      const destLabel = names.length > 1 ? "meerder bestemmingen" : names[0];
      const verb = names.length > 1 ? "hebben" : "heeft";
      return {
        severity,
        title: "Bestemming met hoge annulatiegraad",
        description:
          severity === "critical"
            ? `${destLabel} ${verb} de hoogste annulatiegraad in de dataset.`
            : `${destLabel} ${verb} de op één na hoogste annulatiegraad.`,
        metric: "Annulatiegraad bestemming",
        value: `${nfPct.format(first.share)}%`,
        comparison: `${group.length} bestemming(en) in deze risicogroep`,
        cta: "Bekijk details",
        details: [
          { label: "Betrokken bestemming(en)", items: names },
          { label: "Annulatiepercentage", value: `${nfPct.format(first.share)}%` },
          { label: "Geannuleerde boekingen", value: nfInt.format(sumBookings) },
          { label: "Geannuleerde reizigers", value: nfInt.format(sumTravellers) },
          { label: "Misgelopen omzet", value: nfMoney.format(sumRevenue) },
          {
            label: "Vergelijking met totaal",
            value: `${nfInt.format(sumBookings)} annulaties op ${nfInt.format(sumTotal)} boekingen totaal`,
          },
        ],
        interpretation:
          "Deze bestemmingen hebben uitzonderlijk veel uitval, wat planning en omzetstabiliteit verstoort.",
        action: "Analyseer oorzaken van annulatie en stuur voorwaarden of timing bij.",
        extraAction:
          severity === "critical"
            ? {
                label: "Bekijk op annulaties pagina",
                url: `/annulaties?bestemming=${encodeURIComponent(names[0])}`,
              }
            : null,
      };
    };
    const alerts = [];
    if (worst.length) alerts.push(build(worst, "critical"));
    if (second.length) alerts.push(build(second, "warning"));
    return alerts;
  }

  function buildLossAlerts(curAgg) {
    if (curAgg.rowsCount <= 0) return [];
    const rows = Object.entries(curAgg.byDestination)
      .map(([dest, v]) => {
        const losses = n(curAgg.lossByDestination[dest]);
        return { dest, losses, total: n(v.bookings), lossPct: pct(losses, n(v.bookings)) };
      })
      .filter((r) => r.total > 0 && r.losses > 0);
    if (!rows.length) return [];

    const totalLossBookings = rows.reduce((s, x) => s + x.losses, 0);
    const totalBookings = curAgg.rowsCount;
    const totalLossPct = pct(totalLossBookings, totalBookings);
    const topLossDest = topN(curAgg.lossByDestination, 3, (e) => n(e[1])).map((x) => x[0]);
    const topLossSuppliers = topN(curAgg.lossBySupplier, 3, (e) => n(e[1])).map((x) => x[0]);
    const severity = "critical";

    return [
      {
        severity,
        title: "Verlieslatende boekingen",
        description:
          "Er zijn verlieslatende boekingen (winst < 0) met directe negatieve impact op de totale rendabiliteit.",
        metric: "Aandeel verliesboekingen",
        value: `${nfPct.format(totalLossPct)}%`,
        comparison: `${nfInt.format(totalLossBookings)} van ${nfInt.format(totalBookings)} boekingen`,
        cta: "Bekijk details",
        actionType: "navigate",
        url: "/inzichten?tab=verliezen",
        details: [
          { label: "Aantal verlieslatende boekingen", value: nfInt.format(totalLossBookings) },
          { label: "Aandeel t.o.v. totaal", value: `${nfPct.format(totalLossPct)}%` },
          { label: "Totale negatieve impact", value: nfMoney.format(curAgg.lossImpact) },
          { label: "Top bestemmingen", items: topLossDest.length ? topLossDest : ["niet beschikbaar"] },
          { label: "Top leveranciers", items: topLossSuppliers.length ? topLossSuppliers : ["niet beschikbaar"] },
        ],
        interpretation:
          "Verliesboekingen met negatieve winst (winst < 0) drukken direct op rendabiliteit en cashflow.",
        action: "Open Verliezen-tab en onderzoek prijszetting, kostencomponenten en leveranciersafspraken.",
      },
    ];
  }

  function buildLowOccupancyAlerts(curAgg) {
    const rows = Object.entries(curAgg.byDestination)
      .map(([dest, v]) => ({
        dest,
        pax: n(v.pax),
        bookings: n(v.bookings),
        omzet: n(v.omzet),
        winst: n(v.winst),
      }))
      // Lage bezetting moet gebaseerd zijn op alle bestemmingen met data,
      // niet enkel op bestemmingen met een minimum aantal boekingen.
      .filter((r) => r.bookings > 0);
    if (!rows.length) return [];
    const grouped = groupByWorstAndSecond(rows, (x) => x.pax);
    if (!grouped.worst.length) return [];
    const group = grouped.worst;
    const first = group[0];
    const names = group.map((g) => g.dest);
    const lowestDestLabel = names.length > 1 ? "meerder bestemmingen" : names[0];
    const bookings = group.reduce((s, x) => s + x.bookings, 0);
    const pax = group.reduce((s, x) => s + x.pax, 0);
    const omzet = group.reduce((s, x) => s + x.omzet, 0);
    const winst = group.reduce((s, x) => s + x.winst, 0);
    const top5 = [...rows].sort((a, b) => a.pax - b.pax || a.bookings - b.bookings).slice(0, 5);
    const top5TableRows = top5.map((r) => ({
      bestemming: r.dest,
      pax: nfInt.format(r.pax),
      boekingen: nfInt.format(r.bookings),
      omzet: nfMoney.format(r.omzet),
      winst: nfMoney.format(r.winst),
    }));
    return [
      {
        severity: "info",
        title: "Lage bezetting",
        description: `${lowestDestLabel} heeft het laagste totaal aantal pax.`,
        metric: "Totaal aantal pax",
        value: nfInt.format(first.pax),
        comparison: `${nfInt.format(bookings)} boekingen`,
        cta: "Bekijk details",
        details: [
          { label: "Betrokken bestemming(en)", items: names },
          { label: "Totaal aantal pax", value: nfInt.format(pax) },
          { label: "Aantal boekingen", value: nfInt.format(bookings) },
          { label: "Omzet", value: nfMoney.format(omzet) },
          { label: "Winst", value: nfMoney.format(winst) },
          {
            label: "Top 5 laagste bezetting",
            table: {
              columns: ["Bestemming", "Pax", "Boekingen", "Omzet", "Winst"],
              rows: top5TableRows,
            },
          },
        ],
        interpretation:
          "Lage pax-volumes wijzen op zwakke bezetting en beperken schaalvoordelen.",
        action: "Evalueer targeting, vertrekperiodes en aanbodmix voor deze bestemmingen.",
      },
    ];
  }

  function buildAlerts(curAgg, annCur) {
    const alerts = [];
    if (curAgg.rowsCount <= 0) return alerts;
    buildMarginAlerts(curAgg).forEach((x) => alerts.push(x));
    buildCancellationAlerts(annCur).forEach((x) => alerts.push(x));
    buildLossAlerts(curAgg).forEach((x) => alerts.push(x));
    buildLowOccupancyAlerts(curAgg).forEach((x) => alerts.push(x));
    return alerts;
  }

  function severityLabel(severity) {
    if (severity === "critical") return "Kritiek";
    if (severity === "warning") return "Waarschuwing";
    if (severity === "positive") return "Positief";
    return "Info";
  }

  let renderedAlerts = [];
  let detailsModal = null;
  let modalBackdropEl = null;

  function ensureModal() {
    if (!els.detailsModal || !window.bootstrap || !window.bootstrap.Modal) return null;
    if (!detailsModal) detailsModal = new window.bootstrap.Modal(els.detailsModal, { backdrop: true });
    return detailsModal;
  }

  function openModalFallback() {
    if (!els.detailsModal) return;
    els.detailsModal.style.display = "block";
    els.detailsModal.classList.add("show");
    els.detailsModal.removeAttribute("aria-hidden");
    els.detailsModal.setAttribute("aria-modal", "true");
    document.body.classList.add("modal-open");
    if (!modalBackdropEl) {
      modalBackdropEl = document.createElement("div");
      modalBackdropEl.className = "modal-backdrop fade show";
      document.body.appendChild(modalBackdropEl);
    }
  }

  function closeModalFallback() {
    if (!els.detailsModal) return;
    els.detailsModal.style.display = "none";
    els.detailsModal.classList.remove("show");
    els.detailsModal.setAttribute("aria-hidden", "true");
    els.detailsModal.removeAttribute("aria-modal");
    document.body.classList.remove("modal-open");
    if (modalBackdropEl && modalBackdropEl.parentNode) {
      modalBackdropEl.parentNode.removeChild(modalBackdropEl);
      modalBackdropEl = null;
    }
  }

  function activateTabFromQuery() {
    const params = new URLSearchParams(window.location.search);
    const tab = (params.get("tab") || "").trim().toLowerCase();
    const map = {
      alerts: "insTabAlerts",
      goal: "insTabGoal",
      goalsetting: "insTabGoal",
      marktanalyse: "insTabMarket",
      winstopbouw: "insTabProfitBuild",
      verliezen: "insTabLosses",
      evoluties: "insTabEvolutions",
    };
    const btnId = map[tab];
    if (!btnId) return;
    const btn = document.getElementById(btnId);
    if (!btn) return;
    if (window.bootstrap && window.bootstrap.Tab) {
      window.bootstrap.Tab.getOrCreateInstance(btn).show();
    } else {
      btn.click();
    }
  }

  function buildModalRows(alert) {
    let rows = Array.isArray(alert.details)
      ? alert.details.filter((d) => d && (d.value || d.items || d.table))
      : [];
    if (!rows.length) {
      rows = [
        { label: "Metric", value: alert.metric || "-" },
        { label: "Waarde", value: alert.value || "-" },
      ];
      if (alert.comparison) rows.push({ label: "Vergelijking", value: alert.comparison });
    }
    return rows
      .map((r) => {
        if (r.table && Array.isArray(r.table.columns) && Array.isArray(r.table.rows)) {
          const cols = r.table.columns;
          const head = cols.map((c) => `<th>${c}</th>`).join("");
          const body = r.table.rows
            .map(
              (row) => `
                <tr>
                  <td>${row.bestemming || ""}</td>
                  <td>${row.pax || ""}</td>
                  <td>${row.boekingen || ""}</td>
                  <td>${row.omzet || ""}</td>
                  <td>${row.winst || ""}</td>
                </tr>
              `
            )
            .join("");
          return `
            <div class="insights-modal-details-row">
              <dt>${r.label}</dt>
              <dd>
                <div class="table-responsive">
                  <table class="table table-sm table-bordered align-middle mb-0">
                    <thead><tr>${head}</tr></thead>
                    <tbody>${body}</tbody>
                  </table>
                </div>
              </dd>
            </div>
          `;
        }
        if (Array.isArray(r.items) && r.items.length) {
          const items = r.items.map((x) => `<li>${x}</li>`).join("");
          return `<div class="insights-modal-details-row"><dt>${r.label}</dt><dd><ul class="insights-modal-list">${items}</ul></dd></div>`;
        }
        return `<div class="insights-modal-details-row"><dt>${r.label}</dt><dd>${r.value || "niet beschikbaar"}</dd></div>`;
      })
      .join("");
  }

  function openDetailsModal(alert) {
    const modal = ensureModal();
    if (!els.detailsModalTitle || !els.detailsModalBody || !els.detailsModalFooter) return;
    els.detailsModalTitle.textContent = alert.title || "Alert details";
    const rows = buildModalRows(alert);
    els.detailsModalBody.innerHTML = `
      <dl class="insights-modal-details-grid">${rows}</dl>
      <p class="insights-modal-note ${alert.interpretation ? "" : "d-none"}"><strong>Interpretatie:</strong> ${alert.interpretation || ""}</p>
      <p class="insights-modal-note ${alert.action ? "" : "d-none"}"><strong>Mogelijke actie:</strong> ${alert.action || ""}</p>
    `;
    let footer = '<button type="button" class="btn btn-overzicht-secondary" data-bs-dismiss="modal">Sluiten</button>';
    if (alert.extraAction && alert.extraAction.url) {
      footer = `
        <a href="${alert.extraAction.url}" class="btn btn-overzicht-apply">${alert.extraAction.label || "Open"}</a>
        <button type="button" class="btn btn-overzicht-secondary" data-bs-dismiss="modal">Sluiten</button>
      `;
    }
    els.detailsModalFooter.innerHTML = footer;
    if (modal) modal.show();
    else openModalFallback();
  }

  function wireModalCloseFallback() {
    if (!els.detailsModal) return;
    const closeElements = els.detailsModal.querySelectorAll("[data-bs-dismiss='modal']");
    closeElements.forEach((el) => {
      el.addEventListener("click", () => {
        if (!window.bootstrap || !window.bootstrap.Modal) closeModalFallback();
      });
    });
    els.detailsModal.addEventListener("click", (e) => {
      if (e.target === els.detailsModal && (!window.bootstrap || !window.bootstrap.Modal)) {
        closeModalFallback();
      }
    });
  }

  function wireCardActions() {
    const detailBtns = els.alertsGrid.querySelectorAll("[data-ins-open-details]");
    detailBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.getAttribute("data-ins-open-details"));
        const alert = renderedAlerts[idx];
        if (!alert) return;
        openDetailsModal(alert);
      });
    });
  }

  function renderAlerts(alerts) {
    els.alertsGrid.innerHTML = "";
    const list = Array.isArray(alerts) ? alerts : [];
    els.alertsEmpty.classList.toggle("d-none", list.length > 0);
    if (!list.length) return;

    renderedAlerts = list;
    const critical = [];
    const warning = [];
    const info = [];
    list.forEach((alert, idx) => {
      const sev = alert.severity || "info";
      const entry = { alert, idx, sev };
      if (sev === "critical") critical.push(entry);
      else if (sev === "warning") warning.push(entry);
      else info.push(entry);
    });

    // Layout-wens: "Lage bezetting" in rechterkolom naast verliesalerts.
    // Behoudt INFO-styling (blauw), maar positioneert in waarschuwing-kolomflow.
    const infoInRightLane = [];
    const infoStandalone = [];
    info.forEach((entry) => {
      if ((entry.alert?.title || "").trim().toLowerCase() === "lage bezetting") {
        infoInRightLane.push(entry);
      } else {
        infoStandalone.push(entry);
      }
    });
    warning.push(...infoInRightLane);

    const laneWrap = document.createElement("div");
    laneWrap.className = "insights-alert-lanes";
    const leftCol = document.createElement("div");
    leftCol.className = "insights-alert-lane";
    const rightCol = document.createElement("div");
    rightCol.className = "insights-alert-lane";
    laneWrap.appendChild(leftCol);
    laneWrap.appendChild(rightCol);
    els.alertsGrid.appendChild(laneWrap);

    const renderCard = ({ alert, idx, sev }, targetEl) => {
      const severity = sev || alert.severity || "info";
      const ctaHtml =
        alert.actionType === "navigate" && alert.url
          ? `<a class="insights-alert-card__cta insights-alert-card__cta-btn" href="${alert.url}">${alert.cta || "Bekijk details"}</a>`
          : `<button class="btn btn-link p-0 insights-alert-card__cta insights-alert-card__cta-btn" type="button" data-ins-open-details="${idx}">${alert.cta || "Bekijk details"}</button>`;
      const card = document.createElement("article");
      card.className = `insights-alert-card insights-alert--${severity}`;
      card.innerHTML = `
        <div class="insights-alert-card__body">
          <div class="d-flex justify-content-between align-items-center gap-2">
            <h3 class="insights-alert-card__title">${alert.title}</h3>
            <span class="insights-severity-badge">${severityLabel(sev)}</span>
          </div>
          <p class="insights-alert-card__desc">${alert.description || ""}</p>
          <dl class="insights-alert-meta">
            <div class="insights-alert-meta__item">
              <dt>Metric</dt>
              <dd>${alert.metric || "-"}</dd>
            </div>
            <div class="insights-alert-meta__item">
              <dt>Waarde</dt>
              <dd>${alert.value || "-"}</dd>
            </div>
          </dl>
          <p class="insights-alert-card__comparison ${alert.comparison ? "" : "d-none"}">${alert.comparison || ""}</p>
          ${ctaHtml}
        </div>
      `;
      targetEl.appendChild(card);
    };

    const rowCount = Math.max(critical.length, warning.length);
    for (let i = 0; i < rowCount; i += 1) {
      if (critical[i]) renderCard(critical[i], leftCol);
      if (warning[i]) renderCard(warning[i], rightCol);
    }

    if (infoStandalone.length) {
      const infoRow = document.createElement("div");
      infoRow.className = "insights-alert-info-row";
      els.alertsGrid.appendChild(infoRow);
      infoStandalone.forEach((entry) => renderCard(entry, infoRow));
    }

    wireCardActions();
  }

  async function loadYears() {
    const data = await fetchJson(OPTIONS_URL);
    const years = Array.isArray(data.years) ? data.years.map((x) => Number(x)).filter((x) => x > 0) : [];
    years.sort((a, b) => b - a);
    return years;
  }

  async function fetchFinanceRows({ year }) {
    const url = new URL(FINANCE_DATA_URL, window.location.origin);
    url.searchParams.set("year", String(year));
    url.searchParams.set("brand", BRAND_ALL);
    const payload = await fetchJson(url.toString());
    return Array.isArray(payload.rows) ? payload.rows : [];
  }

  async function fetchAnnulaties({ year }) {
    const url = new URL(ANN_DATA_URL, window.location.origin);
    url.searchParams.set("year", String(year));
    url.searchParams.set("brand", BRAND_ALL);
    return fetchJson(url.toString());
  }

  async function loadAndRenderAlerts() {
    setError("");
    try {
      const years = await loadYears();
      const currentYear = years[0] || YEAR_ALL;

      const financeRowsCur = await fetchFinanceRows({ year: currentYear });
      const annCur = await fetchAnnulaties({ year: currentYear });

      const curAgg = aggregateFinance(financeRowsCur);
      const alerts = buildAlerts(curAgg, annCur);
      renderAlerts(alerts);
      activateTabFromQuery();
    } catch (e) {
      renderAlerts([]);
      setError(e?.message || String(e));
    }
  }

  const lossesEls = {
    section: document.getElementById("insLossesSection"),
    empty: document.getElementById("insLossesEmpty"),
    brand: document.getElementById("insLossBrand"),
    destination: document.getElementById("insLossDestination"),
    transport: document.getElementById("insLossTransport"),
    year: document.getElementById("insLossYear"),
    apply: document.getElementById("insLossApply"),
    reset: document.getElementById("insLossReset"),
    kpiBookings: document.getElementById("insLossKpiBookings"),
    kpiPax: document.getElementById("insLossKpiPax"),
    kpiAvgLossPerPax: document.getElementById("insLossKpiAvgLossPerPax"),
    kpiMedianLossPerPax: document.getElementById("insLossKpiMedianLossPerPax"),
    kpiShare: document.getElementById("insLossKpiShare"),
    kpiWorstPerPax: document.getElementById("insLossKpiWorstPerPax"),
    kpiWorstOrder: document.getElementById("insLossKpiWorstOrder"),
    kpiTotalLossSub: document.getElementById("insLossKpiTotalLossSub"),
    table: document.getElementById("insLossTable"),
    tableBody: document.getElementById("insLossTableBody"),
    topTable: document.getElementById("insLossTopTable"),
    topTableBody: document.getElementById("insLossTopTableBody"),
    chartDestination: document.getElementById("insLossChartDestination"),
    chartPeriod: document.getElementById("insLossChartPeriod"),
    chartPeriodHint: document.getElementById("insLossChartPeriodHint"),
    chartTransport: document.getElementById("insLossChartTransport"),
    chartCostBreakdown: document.getElementById("insLossChartCostBreakdown"),
  };
  const lossesCharts = {};
  let lossesRowsState = [];
  let lossesTopRowsState = [];

  function fmtDate(v) {
    if (!v) return "—";
    const d = new Date(v);
    if (!Number.isFinite(d.getTime())) return "—";
    return d.toLocaleDateString("nl-NL");
  }

  function setSelectOptions(selectEl, rows, getValue, getLabel, placeholderLabel) {
    if (!selectEl) return;
    selectEl.innerHTML = "";
    const first = document.createElement("option");
    first.value = "";
    first.textContent = placeholderLabel;
    selectEl.appendChild(first);
    (rows || []).forEach((row) => {
      const opt = document.createElement("option");
      opt.value = getValue(row);
      opt.textContent = getLabel(row);
      selectEl.appendChild(opt);
    });
  }

  const divideSafe = (num, den) => (n(den) > 0 ? n(num) / n(den) : 0);

  function normalizeLossRow(raw) {
    const row = { ...(raw || {}) };
    const pax = Math.max(n(row.aantal_reizigers), 0);
    const opbrengst = n(row.opbrengst);
    const totaleKosten = n(row.totale_kosten);
    const winst = n(row.winst);
    row.aantal_reizigers = pax;
    row.opbrengst = opbrengst;
    row.totale_kosten = totaleKosten;
    row.winst = winst;
    row.verlies_per_persoon =
      row.verlies_per_persoon != null ? n(row.verlies_per_persoon) : pax > 0 ? divideSafe(winst, pax) : 0;
    row.omzet_per_persoon =
      row.omzet_per_persoon != null ? n(row.omzet_per_persoon) : pax > 0 ? divideSafe(opbrengst, pax) : 0;
    row.kosten_per_persoon =
      row.kosten_per_persoon != null ? n(row.kosten_per_persoon) : pax > 0 ? divideSafe(totaleKosten, pax) : 0;
    row.accommodatiekost_per_persoon =
      row.accommodatiekost_per_persoon != null
        ? n(row.accommodatiekost_per_persoon)
        : pax > 0
          ? divideSafe(row.kost_accommodatie, pax)
          : 0;
    row.transportkost_per_persoon =
      row.transportkost_per_persoon != null
        ? n(row.transportkost_per_persoon)
        : pax > 0
          ? divideSafe(row.kost_transport, pax)
          : 0;
    row.transferkost_per_persoon =
      row.transferkost_per_persoon != null
        ? n(row.transferkost_per_persoon)
        : pax > 0
          ? divideSafe(row.kost_transfer, pax)
          : 0;
    row.extra_kosten_per_persoon =
      row.extra_kosten_per_persoon != null
        ? n(row.extra_kosten_per_persoon)
        : pax > 0
          ? divideSafe(row.kost_extra_kosten, pax)
          : 0;
    return row;
  }

  function buildLossesQueryFromState() {
    const q = new URLSearchParams();
    const add = (key, value) => {
      if (value == null || String(value).trim() === "") return;
      q.set(key, String(value));
    };
    add("brand", lossesEls.brand?.value || "__all__");
    add("bestemming_id", lossesEls.destination?.value || "");
    add("transport_id", lossesEls.transport?.value || "");
    add("year", lossesEls.year?.value || "0");
    return q;
  }

  function destroyLossesChart(key) {
    const inst = lossesCharts[key];
    if (inst && typeof inst.destroy === "function") inst.destroy();
    lossesCharts[key] = null;
  }

  function renderLossesCharts(data) {
    if (!window.Chart) return;
    const rows = Array.isArray(data.rows) ? data.rows.map(normalizeLossRow) : [];
    const byDestination = Array.isArray(data.by_destination) ? data.by_destination : [];
    const byPeriod = Array.isArray(data.by_period) ? data.by_period : [];
    const byTransport = Array.isArray(data.by_transport) ? data.by_transport : [];
    const cb = data.cost_breakdown || {};

    destroyLossesChart("destination");
    if (lossesEls.chartDestination) {
      const destinationRows = byDestination
        .map((r) => ({
          bestemming_naam: r.bestemming_naam || "—",
          avg_loss_per_person:
            r.avg_loss_per_person != null ? n(r.avg_loss_per_person) : divideSafe(n(r.total_loss), n(r.total_pax)),
          loss_bookings: n(r.loss_bookings),
          total_pax: n(r.total_pax),
          total_loss: n(r.total_loss),
        }))
        .sort((a, b) => a.avg_loss_per_person - b.avg_loss_per_person)
        .slice(0, 10);
      lossesCharts.destination = new window.Chart(lossesEls.chartDestination, {
        type: "bar",
        data: {
          labels: destinationRows.map((r) => r.bestemming_naam),
          datasets: [{ label: "Gem. verlies p.p.", data: destinationRows.map((r) => r.avg_loss_per_person), backgroundColor: "#ea580c" }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label(ctx) {
                  const row = destinationRows[ctx.dataIndex];
                  return [
                    `Gem. verlies p.p.: ${nfMoney.format(row.avg_loss_per_person)}`,
                    `Boekingen: ${nfInt.format(row.loss_bookings)}`,
                    `Reizigers: ${nfInt.format(row.total_pax)}`,
                    `Totaal verlies: ${nfMoney.format(row.total_loss)}`,
                  ];
                },
              },
            },
          },
        },
      });
    }

    destroyLossesChart("period");
    if (lossesEls.chartPeriod && byPeriod.length >= 3) {
      if (lossesEls.chartPeriodHint) lossesEls.chartPeriodHint.classList.add("d-none");
      const periodRows = byPeriod.map((r) => ({
        year: n(r.year),
        month: n(r.month),
        avg_loss_per_person:
          r.avg_loss_per_person != null ? n(r.avg_loss_per_person) : divideSafe(n(r.total_loss), n(r.total_pax)),
      }));
      lossesCharts.period = new window.Chart(lossesEls.chartPeriod, {
        type: "line",
        data: {
          labels: periodRows.map((r) => `${r.year}-${String(r.month).padStart(2, "0")}`),
          datasets: [
            {
              label: "Gem. verlies p.p.",
              data: periodRows.map((r) => r.avg_loss_per_person),
              borderColor: "#2563eb",
              backgroundColor: "rgba(37, 99, 235, 0.2)",
              tension: 0.25,
              fill: true,
            },
          ],
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } },
      });
    } else if (lossesEls.chartPeriodHint) {
      lossesEls.chartPeriodHint.classList.remove("d-none");
    }

    destroyLossesChart("transport");
    if (lossesEls.chartTransport) {
      const transportRows = (byTransport.length
        ? byTransport.map((r) => ({
            transport_naam: r.transport_naam || "—",
            avg_loss_per_person:
              r.avg_loss_per_person != null ? n(r.avg_loss_per_person) : divideSafe(n(r.total_loss), n(r.total_pax)),
            loss_bookings: n(r.loss_bookings),
            total_pax: n(r.total_pax),
            total_loss: n(r.total_loss),
          }))
        : (() => {
            const map = new Map();
            rows.forEach((r) => {
              const key = String(r.transport_naam || "—");
              if (!map.has(key)) map.set(key, { transport_naam: key, loss_bookings: 0, total_pax: 0, total_loss: 0 });
              const cur = map.get(key);
              cur.loss_bookings += 1;
              cur.total_pax += n(r.aantal_reizigers);
              cur.total_loss += n(r.winst);
            });
            return [...map.values()].map((r) => ({ ...r, avg_loss_per_person: divideSafe(r.total_loss, r.total_pax) }));
          })())
        .sort((a, b) => a.avg_loss_per_person - b.avg_loss_per_person);
      lossesCharts.transport = new window.Chart(lossesEls.chartTransport, {
        type: "bar",
        data: {
          labels: transportRows.map((r) => r.transport_naam),
          datasets: [{ label: "Gem. verlies p.p.", data: transportRows.map((r) => r.avg_loss_per_person), backgroundColor: "#f59e0b" }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label(ctx) {
                  const row = transportRows[ctx.dataIndex];
                  return [
                    `Gem. verlies p.p.: ${nfMoney.format(row.avg_loss_per_person)}`,
                    `Boekingen: ${nfInt.format(row.loss_bookings)}`,
                    `Reizigers: ${nfInt.format(row.total_pax)}`,
                    `Totaal verlies: ${nfMoney.format(row.total_loss)}`,
                  ];
                },
              },
            },
          },
        },
      });
    }

    destroyLossesChart("costBreakdown");
    if (lossesEls.chartCostBreakdown) {
      const avgOmzetPp =
        cb.avg_omzet_per_persoon != null
          ? n(cb.avg_omzet_per_persoon)
          : rows.length
            ? rows.reduce((s, r) => s + n(r.omzet_per_persoon), 0) / rows.length
            : 0;
      const avgKostenPp =
        cb.avg_kosten_per_persoon != null
          ? n(cb.avg_kosten_per_persoon)
          : rows.length
            ? rows.reduce((s, r) => s + n(r.kosten_per_persoon), 0) / rows.length
            : 0;
      const avgVerliesPp =
        cb.avg_verlies_per_persoon != null
          ? n(cb.avg_verlies_per_persoon)
          : rows.length
            ? rows.reduce((s, r) => s + n(r.verlies_per_persoon), 0) / rows.length
            : 0;
      const avgAccPp =
        cb.avg_accommodatiekost_per_persoon != null
          ? n(cb.avg_accommodatiekost_per_persoon)
          : rows.length
            ? rows.reduce((s, r) => s + n(r.accommodatiekost_per_persoon), 0) / rows.length
            : 0;
      const avgTransportPp =
        cb.avg_transportkost_per_persoon != null
          ? n(cb.avg_transportkost_per_persoon)
          : rows.length
            ? rows.reduce((s, r) => s + n(r.transportkost_per_persoon), 0) / rows.length
            : 0;
      const avgTransferPp =
        cb.avg_transferkost_per_persoon != null
          ? n(cb.avg_transferkost_per_persoon)
          : rows.length
            ? rows.reduce((s, r) => s + n(r.transferkost_per_persoon), 0) / rows.length
            : 0;
      const avgExtraPp =
        cb.avg_extra_kosten_per_persoon != null
          ? n(cb.avg_extra_kosten_per_persoon)
          : rows.length
            ? rows.reduce((s, r) => s + n(r.extra_kosten_per_persoon), 0) / rows.length
            : 0;
      lossesCharts.costBreakdown = new window.Chart(lossesEls.chartCostBreakdown, {
        type: "bar",
        data: {
          labels: ["Omzet p.p.", "Kosten p.p.", "Accommodatie p.p.", "Transport p.p.", "Transfer p.p.", "Extra kosten p.p.", "Verlies p.p."],
          datasets: [
            {
              data: [
                avgOmzetPp,
                avgKostenPp,
                avgAccPp,
                avgTransportPp,
                avgTransferPp,
                avgExtraPp,
                avgVerliesPp,
              ],
              backgroundColor: ["#16a34a", "#dc2626", "#ea580c", "#2563eb", "#14b8a6", "#94a3b8", "#b91c1c"],
            },
          ],
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } },
      });
    }
  }

  function renderLossesTableRows(rows) {
    if (!lossesEls.tableBody) return;
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) {
      lossesEls.tableBody.innerHTML =
        '<tr><td colspan="16" class="text-center text-muted py-4">Geen verlieslatende boekingen gevonden voor deze filters.</td></tr>';
      return;
    }
    lossesEls.tableBody.innerHTML = list
      .map((r) => {
        const verliesPp = n(r.verlies_per_persoon);
        const totaalVerlies = n(r.winst);
        return `<tr>
          <td>${r.order_nummer || "—"}</td>
          <td>${r.brand || "—"}</td>
          <td>${r.bestemming_naam || "—"}</td>
          <td>${r.transport_naam || "—"}</td>
          <td>${fmtDate(r.vertrekdatum)}</td>
          <td class="text-end">${nfInt.format(n(r.aantal_reizigers))}</td>
          <td class="text-end">${nfMoney.format(n(r.omzet_per_persoon))}</td>
          <td class="text-end">${nfMoney.format(n(r.kosten_per_persoon))}</td>
          <td class="text-end ${verliesPp < 0 ? "ins-loss-neg" : ""}">${nfMoney.format(verliesPp)}</td>
          <td class="text-end ${totaalVerlies < 0 ? "ins-loss-neg" : ""}">${nfMoney.format(totaalVerlies)}</td>
          <td class="text-end">${nfPct.format(n(r.winstmarge) * 100)}%</td>
          <td class="text-end">${nfMoney.format(n(r.accommodatiekost_per_persoon))}</td>
          <td class="text-end">${nfMoney.format(n(r.transportkost_per_persoon))}</td>
          <td class="text-end">${nfMoney.format(n(r.transferkost_per_persoon))}</td>
          <td class="text-end">${nfMoney.format(n(r.extra_kosten_per_persoon))}</td>
          <td>${r.grootste_kostendrijver || "—"}</td>
        </tr>`;
      })
      .join("");
  }

  function renderTopLossesTableRows(rows) {
    if (!lossesEls.topTableBody) return;
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) {
      lossesEls.topTableBody.innerHTML =
        '<tr><td colspan="10" class="text-center text-muted py-4">Geen verlieslatende boekingen gevonden voor deze filters.</td></tr>';
      return;
    }
    lossesEls.topTableBody.innerHTML = list
      .map(
        (r) => `<tr>
          <td>${r.order_nummer || "—"}</td>
          <td>${r.bestemming_naam || "—"}</td>
          <td>${r.transport_naam || "—"}</td>
          <td>${fmtDate(r.vertrekdatum)}</td>
          <td class="text-end">${nfInt.format(n(r.aantal_reizigers))}</td>
          <td class="text-end">${nfMoney.format(n(r.omzet_per_persoon))}</td>
          <td class="text-end">${nfMoney.format(n(r.kosten_per_persoon))}</td>
          <td class="text-end ins-loss-neg">${nfMoney.format(n(r.verlies_per_persoon))}</td>
          <td class="text-end ins-loss-neg">${nfMoney.format(n(r.winst))}</td>
          <td>${r.grootste_kostendrijver || "—"}</td>
        </tr>`,
      )
      .join("");
  }

  function renderLossesTable(rows) {
    lossesRowsState = (rows || []).map(normalizeLossRow).sort((a, b) => n(a.verlies_per_persoon) - n(b.verlies_per_persoon));
    lossesTopRowsState = lossesRowsState.slice(0, 15);
    renderLossesTableRows(lossesRowsState);
    renderTopLossesTableRows(lossesTopRowsState);
    if (window.TA_wireSortableTable && lossesEls.table) {
      window.TA_wireSortableTable(
        lossesEls.table,
        () => lossesRowsState,
        (sortedRows) => {
          lossesRowsState = (sortedRows || []).map((r) => ({ ...r }));
          renderLossesTableRows(lossesRowsState);
        },
      );
    }
    if (window.TA_wireSortableTable && lossesEls.topTable) {
      window.TA_wireSortableTable(
        lossesEls.topTable,
        () => lossesTopRowsState,
        (sortedRows) => {
          lossesTopRowsState = (sortedRows || []).map((r) => ({ ...r }));
          renderTopLossesTableRows(lossesTopRowsState);
        },
      );
    }
  }

  function renderLossesKpis(summary) {
    const s = summary || {};
    if (lossesEls.kpiBookings) lossesEls.kpiBookings.textContent = nfInt.format(n(s.total_loss_bookings));
    if (lossesEls.kpiPax) lossesEls.kpiPax.textContent = nfInt.format(n(s.total_pax_loss_bookings));
    if (lossesEls.kpiAvgLossPerPax) lossesEls.kpiAvgLossPerPax.textContent = nfMoney.format(n(s.avg_loss_per_person));
    if (lossesEls.kpiMedianLossPerPax) lossesEls.kpiMedianLossPerPax.textContent = nfMoney.format(n(s.median_loss_per_person));
    if (lossesEls.kpiShare) lossesEls.kpiShare.textContent = `${nfPct.format(n(s.share_loss_bookings) * 100)}%`;
    if (lossesEls.kpiWorstPerPax) lossesEls.kpiWorstPerPax.textContent = nfMoney.format(n(s.worst_loss_per_person));
    if (lossesEls.kpiWorstOrder) lossesEls.kpiWorstOrder.textContent = s.worst_loss_order_nummer || "—";
    if (lossesEls.kpiTotalLossSub) lossesEls.kpiTotalLossSub.textContent = `Totaal verlies: ${nfMoney.format(n(s.total_loss_amount))}`;
  }

  async function loadAndRenderLosses() {
    if (!lossesEls.section) return;
    setError("");
    try {
      const query = buildLossesQueryFromState();
      const url = new URL(LOSSES_DATA_URL, window.location.origin);
      url.search = query.toString();
      const data = await fetchJson(url.toString());
      renderLossesKpis(data.summary || {});
      renderLossesCharts(data);
      renderLossesTable(Array.isArray(data.rows) ? data.rows : []);
      if (lossesEls.empty) lossesEls.empty.classList.toggle("d-none", n(data?.summary?.total_loss_bookings) > 0);
    } catch (e) {
      renderLossesKpis({});
      renderLossesCharts({});
      renderLossesTable([]);
      if (lossesEls.empty) lossesEls.empty.classList.remove("d-none");
      setError(e?.message || String(e));
    }
  }

  async function initLossesOptions() {
    if (!lossesEls.section) return;
    const payload = await fetchJson(LOSSES_OPTIONS_URL);
    const brands = Array.isArray(payload.brands) ? payload.brands : [];
    const bestemmingen = Array.isArray(payload.bestemmingen) ? payload.bestemmingen : [];
    const transporten = Array.isArray(payload.transporten) ? payload.transporten : [];
    const years = Array.isArray(payload.years) ? payload.years.map((x) => n(x)).filter((x) => x > 0) : [];

    if (lossesEls.brand) {
      lossesEls.brand.innerHTML = '<option value="__all__">Alle brands</option>' +
        brands.map((b) => `<option value="${String(b)}">${String(b)}</option>`).join("");
      lossesEls.brand.value = "__all__";
    }
    setSelectOptions(lossesEls.destination, bestemmingen, (x) => x.id, (x) => x.naam, "Alle bestemmingen");
    setSelectOptions(lossesEls.transport, transporten, (x) => x.id, (x) => x.naam, "Alle transporten");

    if (lossesEls.year) {
      lossesEls.year.innerHTML = '<option value="0">Alle jaren</option>' +
        years.sort((a, b) => b - a).map((y) => `<option value="${y}">${y}</option>`).join("");
      lossesEls.year.value = years[0] ? String(years[0]) : "0";
    }

    lossesEls.apply?.addEventListener("click", () => {
      loadAndRenderLosses().catch(() => {});
    });
    lossesEls.reset?.addEventListener("click", () => {
      if (lossesEls.brand) lossesEls.brand.value = "__all__";
      if (lossesEls.destination) lossesEls.destination.value = "";
      if (lossesEls.transport) lossesEls.transport.value = "";
      if (lossesEls.year && years[0]) lossesEls.year.value = String(years[0]);
      loadAndRenderLosses().catch(() => {});
    });
  }

  async function initLossesDashboard() {
    if (!lossesEls.section) return;
    try {
      await initLossesOptions();
      await loadAndRenderLosses();
    } catch (e) {
      setError(e?.message || String(e));
    }
  }

  wireModalCloseFallback();
  loadAndRenderAlerts().catch(() => {});
  initLossesDashboard().catch(() => {});
})();
