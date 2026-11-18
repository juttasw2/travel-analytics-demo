(() => {
  function cssVar(name, fallback) {
    try {
      const value = getComputedStyle(document.documentElement).getPropertyValue(name);
      const trimmed = String(value || "").trim();
      return trimmed || fallback;
    } catch {
      return fallback;
    }
  }

  const TOKENS = {
    BE: cssVar("--ds-country-be", "#c2410c"),
    BE_HOVER: cssVar("--ds-country-be-hover", "#9a3412"),
    BE_SOFT: cssVar("--ds-country-be-soft", "rgba(194, 65, 12, 0.18)"),
    NL: cssVar("--ds-country-nl", "#f59e0b"),
    NL_HOVER: cssVar("--ds-country-nl-hover", "#d97706"),
    NL_SOFT: cssVar("--ds-country-nl-soft", "rgba(245, 158, 11, 0.2)"),
  };

  const LABEL_TO_CODE = new Map([
    ["BE", "BE"],
    ["BELGIE", "BE"],
    ["BELGIË", "BE"],
    ["BELGIUM", "BE"],
    ["NL", "NL"],
    ["NEDERLAND", "NL"],
    ["NETHERLANDS", "NL"],
  ]);

  function normalizeCountryCode(rawLabel) {
    const clean = String(rawLabel || "")
      .trim()
      .toUpperCase();
    if (!clean) return "";
    return LABEL_TO_CODE.get(clean) || clean;
  }

  function colorForCountry(rawLabel, fallbackColor) {
    const code = normalizeCountryCode(rawLabel);
    if (code === "BE") return TOKENS.BE;
    if (code === "NL") return TOKENS.NL;
    return fallbackColor;
  }

  function hoverColorForCountry(rawLabel, fallbackColor) {
    const code = normalizeCountryCode(rawLabel);
    if (code === "BE") return TOKENS.BE_HOVER;
    if (code === "NL") return TOKENS.NL_HOVER;
    return fallbackColor;
  }

  window.CountryColors = {
    tokens: TOKENS,
    normalizeCountryCode,
    colorForCountry,
    hoverColorForCountry,
  };
})();
