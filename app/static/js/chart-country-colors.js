/**
 * Uniforme kleuren voor landgroepen in grafieken (Chart.js e.d.):
 * BE = donker oranje, NL = licht oranje.
 * Geladen vóór pagina-scripts via base.html.
 */
(function (g) {
  const BE = "#c2410c";
  const NL = "#fdba74";
  const BE_HOVER = "#9a3412";
  const NL_HOVER = "#fb923c";
  const IT = "#0d9488";
  const IT_HOVER = "#0f766e";
  const OTHER = "#64748b";
  const OTHER_HOVER = "#475569";
  const PALETTE_OTHER = ["#0ea5e9", "#a78bfa", "#16a34a", "#7c3aed", "#ec4899"];

  function bucketFromLandLabel(raw) {
    if (raw == null) return "OTHER";
    const s = String(raw).trim();
    if (!s) return "OTHER";
    const t = s.toLowerCase();
    if (t === "be" || t.startsWith("be ") || t.includes("belgi") || t === "belgium" || t === "belgïe") return "BE";
    if (t === "nl" || t.startsWith("nl ") || t.includes("nederland") || t === "holland" || t.includes("netherlands")) return "NL";
    if (t === "it" || t.includes("ital")) return "IT";
    if (t.includes("overig") || t === "other") return "OTHER";
    const u = s.toUpperCase();
    if (u === "BE" || u.startsWith("BE ") || u === "BELGIUM" || u === "BELGIË") return "BE";
    if (u === "NL" || u.startsWith("NL ") || u === "NEDERLAND") return "NL";
    if (u === "IT") return "IT";
    return "OTHER";
  }

  function fillForBucket(bucket) {
    const b = String(bucket || "").toUpperCase();
    if (b === "BE") return BE;
    if (b === "NL") return NL;
    if (b === "IT") return IT;
    return OTHER;
  }

  function hoverForBucket(bucket) {
    const b = String(bucket || "").toUpperCase();
    if (b === "BE") return BE_HOVER;
    if (b === "NL") return NL_HOVER;
    if (b === "IT") return IT_HOVER;
    return OTHER_HOVER;
  }

  function fillForLandLabel(label, index) {
    const bucket = bucketFromLandLabel(label);
    if (bucket === "BE") return BE;
    if (bucket === "NL") return NL;
    if (bucket === "IT") return IT;
    const t = String(label || "").trim().toLowerCase();
    if (t === "overig" || t === "other") return OTHER;
    return PALETTE_OTHER[(Number(index) || 0) % PALETTE_OTHER.length];
  }

  function hoverForLandLabel(label) {
    const bucket = bucketFromLandLabel(label);
    if (bucket === "BE") return BE_HOVER;
    if (bucket === "NL") return NL_HOVER;
    if (bucket === "IT") return IT_HOVER;
    const t = String(label || "").trim().toLowerCase();
    if (t === "overig" || t === "other") return OTHER_HOVER;
    return OTHER_HOVER;
  }

  function doughnutColorsForLabels(labels) {
    const backgroundColor = labels.map((l, i) => fillForLandLabel(l, i));
    const hoverBackgroundColor = labels.map((l) => hoverForLandLabel(l));
    return { backgroundColor, hoverBackgroundColor };
  }

  function fillForOriginBucket(code) {
    return fillForBucket(String(code || "").toUpperCase());
  }

  function hoverForOriginBucket(code) {
    return hoverForBucket(String(code || "").toUpperCase());
  }

  function originDonutColors(items) {
    const backgroundColor = items.map((it) => fillForOriginBucket(it.origin_bucket));
    const hoverBackgroundColor = items.map((it) => hoverForOriginBucket(it.origin_bucket));
    return { backgroundColor, hoverBackgroundColor };
  }

  g.CountryChartColors = {
    BE,
    NL,
    BE_HOVER,
    NL_HOVER,
    IT,
    IT_HOVER,
    OTHER,
    OTHER_HOVER,
    bucketFromLandLabel,
    fillForLandLabel,
    hoverForLandLabel,
    doughnutColorsForLabels,
    fillForOriginBucket,
    hoverForOriginBucket,
    originDonutColors,
  };
})(typeof window !== "undefined" ? window : globalThis);
