/**
 * Gedeeld renderpad voor pax-delta tabellen (o.a. tijdsvergelijkingen).
 * Logica is 1:1 overgenomen uit tijdsvergelijkingen.js (writeDestinationHead + renderPaxDeltaRows).
 *
 * Vergelijkingen laadt dit niet apart: zie vgEnsureVgPaxDeltaTable() in tijdsvergelijkingen.js.
 */
(function (global) {
  const nfInt = new Intl.NumberFormat("nl-NL");
  const nfPctEvolution = new Intl.NumberFormat("nl-NL", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  const nfShare = new Intl.NumberFormat("nl-NL", { maximumFractionDigits: 1, minimumFractionDigits: 1 });

  const setEmpty = (el, visible) => el && el.classList.toggle("d-none", !visible);

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

  function deltaCurrMinusPrev(currentVal, previousVal) {
    return Number(currentVal || 0) - Number(previousVal || 0);
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

  function writeDestinationHead(headEl, y1, y2) {
    if (!headEl) return;
    headEl.innerHTML = `<tr>
      <th scope="col" class="vg-col-text">Bestemming</th>
      <th scope="col" class="text-end text-nowrap">Pax ${y1}</th>
      <th scope="col" class="text-end text-nowrap" title="Aandeel van deze bestemming in het totaal pax van ${y1} (alle rijen samen: 100%)">Aandeel (huidig jaar)</th>
      <th scope="col" class="text-end text-nowrap">Pax ${y2}</th>
      <th scope="col" class="text-end text-nowrap">Δ pax</th>
      <th scope="col" class="text-end text-nowrap">Δ %</th>
    </tr>`;
  }

  function renderPaxDeltaRows(rows, bodyIdOrEl, emptyEl, labelField, options = {}) {
    const { maxRows = 12, showCurrentShare = false } = options;
    const body =
      typeof bodyIdOrEl === "string" ? document.getElementById(bodyIdOrEl) : bodyIdOrEl;
    if (!body) return;
    body.innerHTML = "";
    const list = Array.isArray(rows) ? rows : [];
    setEmpty(emptyEl, list.length === 0);
    const totalCur = showCurrentShare ? list.reduce((s, r) => s + Number(r.current_pax || 0), 0) : 0;
    const rowLimit = showCurrentShare ? list.length : Math.min(maxRows, list.length);
    list.slice(0, rowLimit).forEach((row) => {
      const cur = Number(row.current_pax || 0);
      const prev = Number(row.previous_pax || 0);
      const delta = deltaCurrMinusPrev(cur, prev);
      const deltaPct =
        row.delta_pct == null || row.delta_pct === undefined ? (prev === 0 ? null : ((cur - prev) / prev) * 100) : Number(row.delta_pct);
      const pctStr = formatDeltaPct(deltaPct, prev);
      const label = row[labelField] || row.bestemming || row.doelgroep || "—";
      const pctCls = pctStr === "—" ? "vg-delta-neutral" : deltaClass(delta);
      const pctHtml = pctStr === "—" ? "—" : `${deltaArrow(delta)}${pctStr}`;
      const shareCell = showCurrentShare
        ? `<td class="text-end vg-num">${
            totalCur > 0 ? formatSharePct((cur / totalCur) * 100) : "—"
          }</td>`
        : "";
      body.insertAdjacentHTML(
        "beforeend",
        `<tr>
          <td class="vg-col-text">${label}</td>
          <td class="text-end vg-num">${nfInt.format(Math.round(cur))}</td>
          ${shareCell}
          <td class="text-end vg-num">${nfInt.format(Math.round(prev))}</td>
          <td class="text-end vg-num"><span class="${deltaClass(delta)}">${deltaArrow(delta)}${formatSignedInt(delta)}</span></td>
          <td class="text-end vg-num"><span class="${pctCls}">${pctHtml}</span></td>
        </tr>`,
      );
    });
  }

  global.VgPaxDeltaTable = {
    writeDestinationHead,
    renderPaxDeltaRows,
  };
})(typeof window !== "undefined" ? window : globalThis);
