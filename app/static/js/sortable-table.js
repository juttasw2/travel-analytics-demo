/**
 * Herbruikbare client-side sort voor tabellen met thead [data-sort].
 * Sorteercyclus per kolom: oplopend → aflopend → neutraal (terug naar initiële volgorde).
 * Zelfde patroon als klantenprofiel.js (wireSortableTable), met sort-indicator classes.
 */
(function (g) {
  /**
   * @param {HTMLTableElement | null} tableEl
   * @param {() => Record<string, unknown>[]} getRows
   * @param {(rows: Record<string, unknown>[], sortKey?: string, dir?: number) => void} renderBody
   */
  function wireSortableTable(tableEl, getRows, renderBody) {
    if (!tableEl) return;
    const theadRow = tableEl.querySelector("thead tr");
    if (theadRow) theadRow.replaceWith(theadRow.cloneNode(true));

    let sortKey = "";
    /** @type {1 | -1 | 0} */
    let dir = 0;
    /** @type {Record<string, unknown>[]} */
    let baseline = [];

    const captureBaseline = () => {
      baseline = getRows().map((r) => ({ ...r }));
    };
    captureBaseline();

    const clearHeaderState = () => {
      tableEl.querySelectorAll("thead [data-sort]").forEach((h) => {
        h.classList.remove("vg-sort-active", "vg-sort-asc", "vg-sort-desc");
      });
    };

    const setHeaderState = (key) => {
      clearHeaderState();
      if (!key || dir === 0) return;
      tableEl.querySelectorAll("thead [data-sort]").forEach((h) => {
        if (h.getAttribute("data-sort") === key) {
          h.classList.add("vg-sort-active", dir > 0 ? "vg-sort-asc" : "vg-sort-desc");
        }
      });
    };

    tableEl.querySelectorAll("thead [data-sort]").forEach((th) => {
      th.addEventListener("click", () => {
        const k = th.getAttribute("data-sort") || "";
        const sortType = th.getAttribute("data-sort-type") || "auto";
        if (k === sortKey) {
          if (dir === 1) dir = -1;
          else if (dir === -1) {
            sortKey = "";
            dir = 0;
          } else dir = 1;
        } else {
          sortKey = k;
          dir = 1;
        }

        if (!sortKey || dir === 0) {
          const rows = baseline.map((r) => ({ ...r }));
          renderBody(rows, undefined, 0);
          clearHeaderState();
          return;
        }

        const rows = baseline.map((r) => ({ ...r }));
        rows.sort((a, b) => {
          const va = a[sortKey];
          const vb = b[sortKey];
          const numA = Number(va);
          const numB = Number(vb);
          const bothNum =
            sortType === "number" ||
            (sortType === "auto" && typeof va === "number" && typeof vb === "number") ||
            (sortType === "auto" && Number.isFinite(numA) && Number.isFinite(numB) && va !== "" && vb !== "");
          if (bothNum) {
            const na = Number.isFinite(numA) ? numA : 0;
            const nb = Number.isFinite(numB) ? numB : 0;
            return dir * (na - nb);
          }
          if (va == null && vb == null) return 0;
          if (va == null) return dir;
          if (vb == null) return -dir;
          return dir * String(va ?? "").localeCompare(String(vb ?? ""), "nl", { sensitivity: "base" });
        });
        renderBody(rows, sortKey, dir);
        setHeaderState(sortKey);
      });
    });
  }

  g.TA_wireSortableTable = wireSortableTable;
})(typeof globalThis !== "undefined" ? globalThis : this);
