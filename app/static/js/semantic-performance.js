/**
 * Centrale semantische tekstkleur voor winst/verlies, marge en vergelijkende evoluties
 * (tabellen + KPI’s). Gebruik géén groen/rood voor neutrale volumes (openstaand, tellingen, …).
 *
 * API: window.SemanticPerformance
 */
(function (global) {
  "use strict";

  /**
   * @param {unknown} value
   * @returns {number | null}
   */
  function parseNumber(value) {
    if (value == null || value === "") return null;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    const v = Number(String(value).replace(/\s/g, "").replace(",", ".").trim());
    return Number.isFinite(v) ? v : null;
  }

  /**
   * @typedef {'profit'|'margin'|'delta'|'deltaInvert'|'neutral'} SemanticRole
   * - profit: winst/verlies — positief = goed (groen), negatief = slecht (rood)
   * - margin: zelfde als profit (marge %, marge in €)
   * - delta: verandering waar hoger = beter (omzet, pax-stijging, omzetverschil)
   * - deltaInvert: verandering waar lager = beter (bv. stijging kosten = slecht)
   * - neutral: geen semantische kleur
   */

  const EPS = 1e-9;

  /**
   * CSS-klassen voor tekst (combineer met bestaande utility classes).
   * @param {unknown} value
   * @param {SemanticRole} role
   * @returns {string} leeg, of 'sp-text--pos' | 'sp-text--neg' | 'sp-text--neutral'
   */
  function textClass(value, role) {
    if (role === "neutral" || role == null) return "";
    const n = parseNumber(value);
    if (n == null) return "";
    if (Math.abs(n) < EPS) return "sp-text--neutral";
    if (role === "profit" || role === "margin") {
      return n > 0 ? "sp-text--pos" : "sp-text--neg";
    }
    if (role === "delta") {
      return n > 0 ? "sp-text--pos" : "sp-text--neg";
    }
    if (role === "deltaInvert") {
      return n < 0 ? "sp-text--pos" : "sp-text--neg";
    }
    return "";
  }

  /**
   * @param {string} innerHtmlOrText
   * @param {unknown} value
   * @param {SemanticRole} role
   */
  function span(innerHtmlOrText, value, role) {
    const c = textClass(value, role);
    if (!c) return innerHtmlOrText;
    return `<span class="${c}">${innerHtmlOrText}</span>`;
  }

  /**
   * Vergelijkingsregel voor KPI-subteksten (vs vorig jaar).
   * @param {string} label
   * @param {number} curV
   * @param {number | null | undefined} prevV
   * @param {boolean} isPct
   * @param {SemanticRole} role
   * @param {{ nfMoney: Intl.NumberFormat, nfDec: Intl.NumberFormat, nfPct?: Intl.NumberFormat }} fmt
   */
  function compareLine(label, curV, prevV, isPct, role, fmt) {
    if (prevV == null || !Number.isFinite(prevV)) return "";
    const diff = curV - prevV;
    if (Math.abs(diff) < EPS) {
      return `<span class="sp-text--neutral">${label}: gelijk</span>`;
    }
    const cls = textClass(diff, role === "neutral" ? "neutral" : "delta");
    const wrap = (inner) => (cls ? `<span class="${cls}">${inner}</span>` : `<span>${inner}</span>`);
    if (isPct) {
      const rel = prevV !== 0 ? (diff / Math.abs(prevV)) * 100 : 0;
      return wrap(`${label}: ${rel >= 0 ? "+" : ""}${fmt.nfDec.format(rel)}%`);
    }
    return wrap(`${label}: ${diff >= 0 ? "+" : ""}${fmt.nfMoney.format(diff)}`);
  }

  global.SemanticPerformance = {
    parseNumber,
    textClass,
    span,
    compareLine,
  };
})(typeof window !== "undefined" ? window : globalThis);
