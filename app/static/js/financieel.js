/**
 * TravelAnalytics — Financiën
 *
 * UI-logica: FinancePage, FinanceFilters, FinanceKPIGrid, RevenueSection,
 * PaymentsSection, InsuranceSection, OtherRevenuesSection, SuppliersSection (als losse objecten).
 *
 * BUSINESS RULE (verplicht backend + frontend):
 * Alle berekeningen sluiten boekingen met booking_status === 'cancelled' uit.
 * Gebruik overal: booking_status != 'cancelled'
 *
 * Winst-uitsluiting:
 * exclude from profit when total kost_accommodatie = 0.
 *
 * Winstformule (exact):
 * Optioneel: voorgerekende winst via b.winst (server) wint.
 * Anders: zelfde logica als DB — excursies/verzekeringen via NL- of EN-veldnamen.
 * winst = totaal_te_betalen
 *   - excursions_to_pay | excursie_prijs
 *   - price_annulation_insurance | prijs_annulatieverzekering
 *   - price_travel_insurance | prijs_reisverzekering
 *   - price_travelandannulation_insurance | prijs_annulatie_en_reisverzekering
 *   - discount_amount | discountAmount
 *   - kost_accommodatie
 *   - effective_cost_transport (bus/self overrides)
 *   - effective_cost_transfer (plane override)
 *   - package_prijs
 * Let op: tourist tax, clean fee en extra charges tellen niet mee in winst.
 * Geen aftrek van transfer_prijs, bagage_prijs, vlucht_heen/terug in deze formule.
 */
(() => {
  const RBAC = window.__RBAC__ || {};
  const IS_RESTRICTED_ROLE = Boolean(RBAC.isRestricted);
  const FORCED_YEAR = Number(RBAC.currentYear) || new Date().getFullYear();
  const COL = {
    orange: "#ea580c",
    orangeSoft: "rgba(234, 88, 12, 0.15)",
    green: "#16a34a",
    greenSoft: "rgba(22, 163, 74, 0.15)",
    red: "#dc2626",
    blue: "#2563eb",
    blueSoft: "rgba(37, 99, 235, 0.15)",
    gray: "#9ca3af",
    gray2: "#cbd5e1",
    slate: "#64748b",
  };

  /** Verzekeringen-tab: vaste familie geel → amber → oranje; grijs = geen. */
  const COL_INS = {
    combi: "#EAB308",
    travel: "#F59E0B",
    annul: "#EA580C",
    none: "#CBD5E1",
    donutZonder: "#94A3B8",
  };

  const nfMoney = new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" });
  /** Leveranciers-tab: altijd 2 decimalen, nl-NL (bijv. € 11.883,00). */
  const nfMoneyEuro2 = new Intl.NumberFormat("nl-NL", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const nfPct = new Intl.NumberFormat("nl-NL", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });
  /** Winstmarge kolom: 2 decimalen (bijv. 23,04%). */
  const nfPctMargin2 = new Intl.NumberFormat("nl-NL", { style: "percent", minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const nfInt = new Intl.NumberFormat("nl-NL", { maximumFractionDigits: 0 });
  const nfDec = new Intl.NumberFormat("nl-NL", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  /** Merken op de x-as van “Verzekeringstype per merk” (vaste volgorde; ontbrekende waarden = 0). */
  const INS_BRAND_CHART_LABELS = ["Sun Escapes", "Snow Escapes", "Road Rebels"];

  const INSURANCE_PROFIT_RATE = 0.32;
  const FINANCE_DEV_MODE =
    (typeof process !== "undefined" && process?.env?.NODE_ENV === "development") ||
    String(globalThis?.location?.hostname || "").toLowerCase() === "localhost";

  /**
   * @param {{ travel: number, annul: number, combi: number, none: number }} stack
   */
  function insuranceStackTotal(stack) {
    return stack.travel + stack.annul + stack.combi + stack.none;
  }

  /**
   * @param {{ travel: number, annul: number, combi: number, none: number }} stack
   */
  function insuranceStackToPct100(stack) {
    const t = insuranceStackTotal(stack);
    if (t <= 0) return { travel: 0, annul: 0, combi: 0, none: 0, total: 0 };
    return {
      travel: (stack.travel / t) * 100,
      annul: (stack.annul / t) * 100,
      combi: (stack.combi / t) * 100,
      none: (stack.none / t) * 100,
      total: t,
    };
  }

  /** @param {unknown} x */
  function n(x) {
    const v = Number(x);
    return Number.isFinite(v) ? v : 0;
  }

  /**
   * Parseert bedragen/aantallen uit JSON (ook strings); ongeldig → 0.
   * @param {unknown} x
   */
  function numField(x) {
    if (x == null || x === "") return 0;
    if (typeof x === "number") return Number.isFinite(x) ? x : 0;
    let s = String(x).trim();
    if (!s) return 0;
    s = s.replace(/\s+/g, "").replace(/[^\d,.\-]/g, "");
    if (!s || s === "-" || s === "." || s === ",") return 0;
    if (s.includes(",") && s.includes(".")) {
      if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
        s = s.replace(/\./g, "").replace(",", ".");
      } else {
        s = s.replace(/,/g, "");
      }
    } else if (s.includes(",")) {
      const parts = s.split(",");
      if (parts.length === 2 && parts[1].length <= 2) s = `${parts[0]}.${parts[1]}`;
      else s = s.replace(/,/g, "");
    } else if (s.includes(".")) {
      const parts = s.split(".");
      if (!(parts.length === 2 && parts[1].length <= 2)) s = s.replace(/\./g, "");
    }
    const v = Number(s);
    return Number.isFinite(v) ? v : 0;
  }

  /**
   * Zelfde prioriteit als financieel_rpc (combi → reis → annulatie → geen).
   * @param {Record<string, unknown>} t
   */
  function insuranceTypeFromTravellerPrices(t) {
    const combi = numField(t.prijs_annulatie_en_reisverzekering);
    if (combi > 0) return "combi";
    const travel = numField(t.prijs_reisverzekering);
    if (travel > 0) return "travel";
    const annul = numField(t.prijs_annulatieverzekering);
    if (annul > 0) return "annul";
    return "none";
  }

  /**
   * @param {Record<string, unknown>} t
   */
  function travellerInsuranceType(t) {
    const raw = t.insurance_type;
    if (raw != null && String(raw).trim() !== "") return String(raw);
    return insuranceTypeFromTravellerPrices(t);
  }

  /**
   * @param {typeof PAYMENT_TRAVELLERS} travellers
   * @param {typeof ACTIVE_POOL} bookRows
   */
  function filterTravellersForBookings(travellers, bookRows) {
    const ids = new Set(bookRows.map((b) => String(b.booking_id ?? "").trim()).filter(Boolean));
    return travellers.filter((tr) => ids.has(String(tr.booking_id ?? "").trim()));
  }

  /**
   * Zelfde excursiebedrag als in computeProfit (financieel_rpc / boeking_financien).
   * @param {Record<string, unknown>} b
   */
  function excursionRevenueFromBooking(b) {
    if (b.excursions_totaal_excel != null && b.excursions_totaal_excel !== "") return numField(b.excursions_totaal_excel);
    if (b.excursions_to_pay != null && b.excursions_to_pay !== "") return numField(b.excursions_to_pay);
    return numField(b.excursie_prijs);
  }

  /**
   * Winst-definitie voor excursies: commissiebedrag per lijn.
   * Prioriteit: berekende_commissie (server) -> commissie (bedrag) -> commissie_percentage.
   * @param {Record<string, unknown>} r
   */
  function excursionResolveCommissieForLine(r) {
    const verkoop = numField(r.verkoop_prijs);
    if (r.berekende_commissie != null && String(r.berekende_commissie).trim() !== "") {
      return Math.max(0, numField(r.berekende_commissie));
    }
    if (r.commissie != null && String(r.commissie).trim() !== "") {
      return Math.max(0, numField(r.commissie));
    }
    const pct = numField(r.commissie_percentage);
    if (pct > 0) return Math.max(0, (verkoop * pct) / 100);
    return 0;
  }

  /**
   * @param {Record<string, unknown>} r
   */
  function excursionLineProfitFromRow(r) {
    return excursionResolveCommissieForLine(r);
  }

  /**
   * @param {Array<Record<string, unknown>>} lines
   * @param {typeof ACTIVE_POOL} bookRows
   */
  function filterExcursionLinesForBookings(lines, bookRows) {
    const ids = new Set(bookRows.map((b) => String(b.booking_id ?? "").trim()).filter(Boolean));
    return lines.filter((row) => ids.has(String(row.booking_id ?? "").trim()));
  }

  /**
   * @param {unknown} raw
   * @returns {boolean}
   */
  function isJouwVerblijfAccommodationName(raw) {
    return String(raw ?? "")
      .trim()
      .toLowerCase()
      .startsWith("jouw verblijf in");
  }

  /** @param {Record<string, unknown>} b */
  function isJouwVerblijfBooking(b) {
    if (isTruthyFlag(b.is_jouw_verblijf_accommodatie)) return true;
    return isJouwVerblijfAccommodationName(b.accommodatie_naam);
  }

  /** @param {Record<string, unknown>} b */
  function bookingAccommodationCost(b) {
    const raw = b.kost_accomodatie != null ? b.kost_accomodatie : b.kost_accommodatie;
    return numField(raw);
  }

  /**
   * Winst op "jouw verblijf in" volgt formule omzet - handmatige kost,
   * maar respecteert tijdelijke uitsluiting zolang kost=0 voor accepted/booked/closed.
   * @param {typeof ACTIVE_POOL} bookRows
   */
  function jouwVerblijfProfitFromBookings(bookRows) {
    let omzet = 0;
    let kost = 0;
    let winst = 0;
    let excluded = 0;
    for (const b of bookRows) {
      if (!isJouwVerblijfBooking(/** @type {Record<string, unknown>} */ (b))) continue;
      const bOmzet = numField(b.totaal_te_betalen);
      const bKost = bookingAccommodationCost(/** @type {Record<string, unknown>} */ (b));
      omzet += bOmzet;
      kost += bKost;
      if (isExcludedFromProfitCalculation(/** @type {Record<string, unknown>} */ (b))) {
        excluded += 1;
        continue;
      }
      winst += bOmzet - bKost;
    }
    return { omzet, kost, winst, excluded };
  }

  /**
   * Winst uit extra's: excursies + verzekeringen (32%).
   * Let op: "jouw verblijf in" / Explore-reizen horen functioneel bij boekingswinst (m.winst), niet bij extra's.
   * @param {typeof ACTIVE_POOL} bookRows
   */
  function computeExtrasProfitForPool(bookRows) {
    const lines = filterExcursionLinesForBookings(EXCURSION_LINES_RAW, bookRows);
    let winstExcursions = 0;
    if (lines.length > 0) {
      for (const r of lines) winstExcursions += excursionLineProfitFromRow(r);
    }
    const trav = filterTravellersForBookings(PAYMENT_TRAVELLERS, bookRows);
    const insRev = insuranceMetricsFromTravellers(trav).insRev;
    const winstInsurance = insRev * INSURANCE_PROFIT_RATE;
    const winstExtras = winstExcursions + winstInsurance;
    return { winstExcursions, winstInsurance, winstExtras };
  }

  /**
   * Koppelt winst uit boekingen (m.winst) aan extra's en totale winst voor KPI-raster.
   * @param {ReturnType<typeof metricsFromRows>} m
   * @param {typeof ACTIVE_POOL} bookRows
   */
  function attachExtrasProfitMetrics(m, bookRows) {
    const ext = computeExtrasProfitForPool(bookRows);
    // Kritiek: boekingswinst bevat ook "jouw verblijf in"/Explore-winst zodra kost is opgeslagen.
    m.winstBookings = m.winst;
    m.winstExcursions = ext.winstExcursions;
    m.winstInsuranceExtras = ext.winstInsurance;
    m.winstExtras = ext.winstExtras;
    m.winstTotal = m.winstBookings + m.winstExtras;
  }

  /**
   * % reizigers met afwijkende betaling zoals tabel "Betalingen met opmerking"
   * (zelfde filter als paymentTravellerInOpmerkingTabel).
   * @param {ReturnType<typeof metricsFromRows>} m
   * @param {typeof ACTIVE_POOL} bookRows
   */
  function attachOpmerkingProbMetrics(m, bookRows) {
    const trav = filterTravellersForBookings(PAYMENT_TRAVELLERS, bookRows);
    const n = trav.length;
    let bad = 0;
    for (const t of trav) {
      if (paymentTravellerInOpmerkingTabel(t)) bad += 1;
    }
    m.pctProbOpmerking = n > 0 ? bad / n : 0;
  }

  /**
   * Verzekerings-KPI’s en omzet: per reiziger (payment_travellers), niet per boeking.
   *
   * `insCounts` telt onafhankelijk per kolom (`prijs_*verzekering > 0`); een reiziger met
   * zowel een reisverzekering als annulatieverzekering wordt in beide cards meegeteld.
   * `insCountsExclusive` houdt de mutually-exclusive prioriteit (combi → travel → annul → none)
   * aan voor 100% gestapelde grafieken en de donut-uitsplitsing.
   * `insRev` telt elk verzekeringsbedrag dat > 0 is afzonderlijk; dat sluit aan bij het
   * financiële overzicht waar omzet per type wordt getoond.
   * `withIns` / `uptake` blijven gebaseerd op unieke reizigers met enige polis (>0), zodat de
   * verzekeringsgraad nooit boven 100% kan uitkomen.
   * @param {typeof PAYMENT_TRAVELLERS} travellers
   */
  function insuranceMetricsFromTravellers(travellers) {
    const insCounts = { travel: 0, annul: 0, combi: 0, none: 0 };
    const insCountsExclusive = { travel: 0, annul: 0, combi: 0, none: 0 };
    const insRevByType = { travel: 0, annul: 0, combi: 0 };
    let insRev = 0;
    let withIns = 0;
    for (const t of travellers) {
      const combiPrijs = numField(t.prijs_annulatie_en_reisverzekering);
      const travelPrijs = numField(t.prijs_reisverzekering);
      const annulPrijs = numField(t.prijs_annulatieverzekering);
      const hasCombi = combiPrijs > 0;
      const hasTravel = travelPrijs > 0;
      const hasAnnul = annulPrijs > 0;
      if (hasCombi) {
        insCounts.combi += 1;
        insRevByType.combi += combiPrijs;
        insRev += combiPrijs;
      }
      if (hasTravel) {
        insCounts.travel += 1;
        insRevByType.travel += travelPrijs;
        insRev += travelPrijs;
      }
      if (hasAnnul) {
        insCounts.annul += 1;
        insRevByType.annul += annulPrijs;
        insRev += annulPrijs;
      }
      if (hasCombi || hasTravel || hasAnnul) {
        withIns += 1;
      } else {
        insCounts.none += 1;
      }
      const exclusiveType = travellerInsuranceType(t);
      if (exclusiveType === "combi") insCountsExclusive.combi += 1;
      else if (exclusiveType === "travel") insCountsExclusive.travel += 1;
      else if (exclusiveType === "annul") insCountsExclusive.annul += 1;
      else insCountsExclusive.none += 1;
    }
    const nTr = travellers.length;
    return {
      insCounts,
      insCountsExclusive,
      insRev,
      insRevByType,
      insPax: withIns,
      uptake: nTr ? withIns / nTr : 0,
      pctNoIns: nTr ? insCounts.none / nTr : 0,
      insAvgPerBook: nTr ? insRev / nTr : 0,
    };
  }

  const EXCLUDE_ZERO_ACCOMMODATION_COST_FROM_PROFIT = true;

  /**
   * @param {unknown} rawStatus
   * @returns {string}
   */
  function normalizeBookingStatus(rawStatus) {
    return String(rawStatus ?? "")
      .trim()
      .toLowerCase();
  }

  /**
   * Financiële rapportering gebruikt wanneer de reis doorgaat:
   * vertrekdatum is de centrale performance date.
   * @param {Record<string, unknown>} booking
   * @returns {string}
   */
  function getFinancialPerformanceDate(booking) {
    const raw = booking.departure_date ?? booking.vertrekdatum ?? "";
    return String(raw).trim().slice(0, 10);
  }

  /**
   * @param {string} normalizedStatus
   * @returns {boolean}
   */
  function isCancelledDroppedOrProcessingStatus(normalizedStatus) {
    if (!normalizedStatus) return false;
    return /^(cancelled|canceled|cancel|geannuleerd|gecanceld|annulatie|annulering|annule|annulé|dropped|drop|processing)([^a-z0-9].*)?$/.test(
      normalizedStatus,
    );
  }

  /**
   * Omzet-basis zoals Overzicht: annuleerde en dropped uitsluiten, processing telt mee.
   * @param {string} normalizedStatus
   * @returns {boolean}
   */
  function isCancelledOrDroppedStatus(normalizedStatus) {
    if (!normalizedStatus) return false;
    return /^(cancelled|canceled|cancel|geannuleerd|gecanceld|annulatie|annulering|annule|annulé|dropped|drop)([^a-z0-9].*)?$/.test(
      normalizedStatus,
    );
  }

  /**
   * @param {unknown} value
   * @returns {boolean}
   */
  function isTruthyFlag(value) {
    if (value === true || value === 1) return true;
    const s = String(value ?? "")
      .trim()
      .toLowerCase();
    return s === "true" || s === "1" || s === "t" || s === "yes" || s === "ja";
  }

  /**
   * Business choice: only explicit zero triggers this rule.
   * Null/undefined/empty should NOT be treated as zero.
   * @param {unknown} rawValue
   * @returns {boolean}
   */
  function isExplicitZeroAccommodationCost(rawValue) {
    if (rawValue == null) return false;
    if (typeof rawValue === "string" && rawValue.trim() === "") return false;
    return numField(rawValue) === 0;
  }

  /**
   * @param {Record<string, unknown>} b
   * @returns {boolean}
   */
  function isExcludedFromProfitCalculation(b) {
    if (!EXCLUDE_ZERO_ACCOMMODATION_COST_FROM_PROFIT) return false;
    const status = normalizeBookingStatus(b.booking_status);
    if (isCancelledDroppedOrProcessingStatus(status)) return true;
    if (isTruthyFlag(b.excluded_from_profit)) return true;
    const rawKostAcc = b.kost_accomodatie != null ? b.kost_accomodatie : b.kost_accommodatie;
    return isExplicitZeroAccommodationCost(rawKostAcc);
  }

  /**
   * @param {Record<string, unknown>} b
   */
  function brandKey(b) {
    const s = String(b.brand ?? "").trim();
    return s || "(onbekend)";
  }

  /**
   * @param {Record<string, unknown>} b
   */
  function destKey(b) {
    const s = String(b.destination ?? "").trim();
    return s || "(onbekend)";
  }

  /**
   * @param {unknown} raw
   * @returns {string}
   */
  function normalizeBucketTextKey(raw) {
    return String(raw ?? "")
      .trim()
      .toLocaleLowerCase("nl-NL");
  }

  /**
   * @param {Record<string, unknown>} b
   */
  function reminderCount(b) {
    return Math.max(0, Math.round(n(b.payment_reminders)));
  }

  /**
   * @param {Record<string, unknown>} row
   * @param {string[]} keys
   * @returns {number}
   */
  function reminderCountFromKeys(row, keys) {
    let max = 0;
    for (const key of keys) {
      const val = Math.max(0, Math.round(numField(row[key])));
      if (val > max) max = val;
    }
    return max;
  }

  /**
   * @param {Record<string, unknown>} row
   * @returns {boolean}
   */
  function hasIncassoIndicator(row) {
    const boolLike = ["incasso_status", "incasso_flag"];
    for (const key of boolLike) {
      const value = row[key];
      if (value === true || value === 1) return true;
      const s = String(value ?? "")
        .trim()
        .toLowerCase();
      if (["ja", "yes", "true", "1", "incasso", "in incasso", "collection"].includes(s)) return true;
      if (s.includes("incasso")) return true;
    }
    const statusLike = [row.payment_status, row.betaling_status, row.betalingsstatus, row.status];
    for (const raw of statusLike) {
      const s = String(raw ?? "")
        .trim()
        .toLowerCase();
      if (!s) continue;
      if (s.includes("incasso")) return true;
      if (s.includes("deurwaard")) return true;
      if (s.includes("collection")) return true;
    }
    return false;
  }

  /**
   * @param {Record<string, unknown>} b
   */
  function isProblematicPayment(b) {
    const voorschotReminders = reminderCountFromKeys(b, [
      "aantal_voorschotbetalingsherinneringen",
      "voorschot_herinneringen",
      "voorschot_payment_reminders",
    ]);
    const totaalReminders = reminderCountFromKeys(b, [
      "aantal_totaalbetalingsherinneringen",
      "totaal_herinneringen",
      "totaal_payment_reminders",
    ]);
    const genericReminders = reminderCountFromKeys(b, ["payment_reminders", "reminder_count", "aantal_herinneringen"]);
    const maxReminders = Math.max(voorschotReminders, totaalReminders, genericReminders);
    const hasMoreThanThreeReminders = maxReminders > 3;
    const hasIncasso = hasIncassoIndicator(b);
    const legacyFlag = reminderCount(b) >= 3 && hasIncasso;
    return hasMoreThanThreeReminders || hasIncasso || legacyFlag;
  }

  /**
   * @param {Record<string, unknown>} b
   * @returns {number | null}
   */
  function pricePerPaxForBooking(b) {
    const px = numField(b.pax);
    if (px <= 0) return null;
    return numField(b.totaal_te_betalen) / px;
  }

  /**
   * @param {typeof ACTIVE_POOL} rows
   * @param {number} yearEff
   * @param {"omzet" | "winst"} field
   */
  function quarterBuckets(rows, yearEff, field) {
    const q = [0, 0, 0, 0];
    for (const b of rows) {
      const { y, m } = parseDep(getFinancialPerformanceDate(/** @type {Record<string, unknown>} */ (b)));
      if (yearEff && yearEff > 0 && y !== yearEff) continue;
      if (m < 1 || m > 12) continue;
      const qi = m <= 3 ? 0 : m <= 6 ? 1 : m <= 9 ? 2 : 3;
      if (field === "omzet") q[qi] += numField(b.totaal_te_betalen);
      else if (field === "winst") q[qi] += computeProfit(b);
    }
    return q;
  }

  /**
   * @param {Record<string, unknown>} b
   * @returns {number}
   */
  function computeProfit(b) {
    if (isExcludedFromProfitCalculation(b)) {
      return 0;
    }
    if (b.winst != null && b.winst !== "") {
      return n(b.winst);
    }

    const excursionsToPay =
      b.excursions_totaal_excel != null && b.excursions_totaal_excel !== ""
        ? numField(b.excursions_totaal_excel)
        : b.excursions_to_pay != null && b.excursions_to_pay !== ""
          ? numField(b.excursions_to_pay)
          : numField(b.excursie_prijs);
    const annulationInsurance =
      b.price_annulation_insurance != null && b.price_annulation_insurance !== ""
        ? numField(b.price_annulation_insurance)
        : numField(b.prijs_annulatieverzekering);
    const travelInsurance =
      b.price_travel_insurance != null && b.price_travel_insurance !== ""
        ? numField(b.price_travel_insurance)
        : numField(b.prijs_reisverzekering);
    const travelAndAnnulationInsurance =
      b.price_travelandannulation_insurance != null && b.price_travelandannulation_insurance !== ""
        ? numField(b.price_travelandannulation_insurance)
        : numField(b.prijs_annulatie_en_reisverzekering);
    const discountAmount =
      b.discount_amount != null && b.discount_amount !== ""
        ? numField(b.discount_amount)
        : numField(b.discountAmount);

    const kostAcc =
      b.kost_accomodatie != null && b.kost_accomodatie !== ""
        ? numField(b.kost_accomodatie)
        : numField(b.kost_accommodatie);
    const effectiveCostTransport = computeEffectiveCostTransport(b);
    const effectiveCostTransfer = computeEffectiveCostTransfer(b);

    return (
      numField(b.totaal_te_betalen) -
      excursionsToPay -
      annulationInsurance -
      travelInsurance -
      travelAndAnnulationInsurance -
      discountAmount -
      kostAcc -
      effectiveCostTransport -
      effectiveCostTransfer -
      numField(b.package_prijs)
    );
  }

  /**
   * Transport override voor winst:
   * - bus + 0 -> 130 (behalve exact brand "Road Rebels")
   * - self + 0 -> 1
   * - anders: bestaande cost_transport
   * @param {Record<string, unknown>} b
   * @returns {number}
   */
  function computeEffectiveCostTransport(b) {
    const transportName = String(b.transport ?? "").trim().toLowerCase();
    const brand = String(b.brand ?? "")
      .trim()
      .toLowerCase();
    const costTransport = numField(b.kost_transport);
    // Bus-rule met case-insensitive uitzondering voor "Road Rebels".
    if (transportName === "bus" && costTransport === 0 && brand !== "road rebels") return 130;
    if (transportName === "self" && costTransport === 0) return 1;
    return costTransport;
  }

  /**
   * Transfer override voor winst:
   * - plane + 0 -> 40
   * - anders: bestaande cost_transfer
   * @param {Record<string, unknown>} b
   * @returns {number}
   */
  function computeEffectiveCostTransfer(b) {
    const transportName = String(b.transport ?? "").trim().toLowerCase();
    const costTransfer = numField(b.kost_transfer);
    // Plane-rule: alleen fallback wanneer waarde ontbreekt/0 is.
    if (transportName === "plane" && costTransfer === 0) return 40;
    return costTransfer;
  }

  /**
   * @param {Record<string, unknown>} b
   */
  /** Zelfde logica als sql/rpc/financieel_rpc.sql: geen cancelled / geannuleerd / dropped / annulatie. */
  function isActiveBooking(b) {
    const s = String(b.booking_status || "")
      .toLowerCase()
      .trim();
    if (!s) return true;
    if (isCancelledOrDroppedStatus(s)) return false;
    return true;
  }

  /**
   * Betalingen met opmerking: geen rijen met puur administratieve betalingsstatussen.
   * @param {unknown} statusRaw
   */
  function betalingStatusHideFromOpmerkingTabel(statusRaw) {
    const s = String(statusRaw ?? "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
    if (!s) return false;
    if (s.includes("geen kosten")) return true;
    if (s.includes("geannuleerd") && !s.includes("niet")) return true;
    if (isCancelledDroppedOrProcessingStatus(s)) return true;
    return false;
  }

  /**
   * Rij voor tabel Betalingen met opmerking: niet OKE, maar ook geen GEANNULEERD/GEEN KOSTEN en geen geannuleerde boeking.
   * @param {Record<string, unknown>} t
   */
  function paymentTravellerInOpmerkingTabel(t) {
    if (betalingIsOke(t.betaling_status)) return false;
    if (betalingStatusHideFromOpmerkingTabel(t.betaling_status)) return false;
    return isActiveBooking({ booking_status: t.booking_status });
  }

  const charts = {};
  /** @param {string} id */
  function destroyChart(id) {
    if (charts[id]) {
      charts[id].destroy();
      charts[id] = null;
    }
  }

  /** @type {Map<string, unknown>} */
  const memoAgg = new Map();

  /** @type {unknown[]} */
  let ACTIVE_POOL = [];

  /** Reizigers voor Betalingen-tab (komt mee uit /financieel/data → payment_travellers). */
  /** @type {Array<Record<string, unknown>>} */
  let PAYMENT_TRAVELLERS = [];

  /** Excursieregels van /excursies/data (parallel met Financiën); gefilterd op boekingen uit de actieve selectie. */
  /** @type {Array<Record<string, unknown>>} */
  let EXCURSION_LINES_RAW = [];

  /** API-opties (jaren / brands / bestemmingen) */
  let _optionsYears = [];
  let _optionsBrands = [];
  /** @type {Array<{ id?: string, naam?: string }>} */
  let _optionsDest = [];
  let _optionsCountries = ["BE", "NL", "DE", "FR", "OTHER"];
  /** @type {InstanceType<typeof window.TAMultiSelectFilter> | null} */
  let finDestMulti = null;

  /**
   * Financiën: DE/FR niet tonen in landfilter.
   * @param {unknown[]} countries
   */
  function sanitizeFinanceCountryOptions(countries) {
    const blocked = new Set(["DE", "FR"]);
    return [...new Set((Array.isArray(countries) ? countries : []).map((x) => String(x || "").trim().toUpperCase()).filter(Boolean))].filter(
      (c) => !blocked.has(c),
    );
  }

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
  const serverBase = typeof window.__FINANCE_API_BASE__ === "string" ? window.__FINANCE_API_BASE__.trim() : "";
  const mergedBase = pickApiBase(pageBase, serverBase);
  const mountBase = mergedBase.replace(/\/financieel$/i, "");
  const OPTIONS_URL =
    typeof window.__FINANCE_OPTIONS_URL__ === "string" && window.__FINANCE_OPTIONS_URL__.trim()
      ? window.__FINANCE_OPTIONS_URL__.trim()
      : `${mountBase}/financieel/options`;
  const DATA_URL =
    typeof window.__FINANCE_DATA_URL__ === "string" && window.__FINANCE_DATA_URL__.trim()
      ? window.__FINANCE_DATA_URL__.trim()
      : `${mountBase}/financieel/data`;
  const EXCURSIONS_DATA_URL =
    typeof window.__EXCURSIONS_DATA_URL__ === "string" && window.__EXCURSIONS_DATA_URL__.trim()
      ? window.__EXCURSIONS_DATA_URL__.trim()
      : `${mountBase}/excursies/data`;
  const JOUW_VERBLIJF_COST_URL =
    typeof window.__FINANCE_JOUW_VERBLIJF_COST_URL__ === "string" && window.__FINANCE_JOUW_VERBLIJF_COST_URL__.trim()
      ? window.__FINANCE_JOUW_VERBLIJF_COST_URL__.trim()
      : `${mountBase}/financieel/jouw-verblijf-kost`;
  const fetchJson = {
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "X-Requested-With": "XMLHttpRequest",
    },
  };

  function getCsrfToken() {
    const el = document.querySelector("meta[name='csrf-token']");
    return String(el?.getAttribute("content") ?? "").trim();
  }

  /**
   * Voorkomt `Unexpected token '<'` als de server HTML terugstuurt (login, 404, proxy, debugfout).
   * Zelfde patroon als klantenprofiel.js.
   */
  async function readJsonResponse(res, label) {
    const text = await res.text();
    const trimmed = (text || "").trimStart();
    if (!trimmed) {
      throw new Error(`${label}: lege response (HTTP ${res.status}).`);
    }
    if (trimmed.startsWith("<")) {
      throw new Error(
        `${label}: de server antwoordde met HTML (${res.status}), niet met JSON. Controleer of je bent ingelogd, ` +
          `of de URL klopt (inclusief subpad achter een reverse proxy), en of /financieel/options en /financieel/data bereikbaar zijn.`,
      );
    }
    let data = {};
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`${label}: ongeldige JSON (HTTP ${res.status}).`);
    }
    if (!res.ok) {
      const d = data && typeof data === "object" ? data : null;
      const piece = d && (d.error ?? d.message ?? d.details);
      const detail =
        d && d.detail != null && String(d.detail).trim() !== ""
          ? ` — ${String(d.detail).trim()}`
          : "";
      const msg =
        piece != null && String(piece).trim() !== ""
          ? String(piece).trim()
          : `${label}: HTTP ${res.status}`;
      throw new Error(`${msg}${detail}`);
    }
    return data;
  }

  /**
   * @param {Record<string, unknown>} r
   */
  function normalizeBookingRow(r) {
    const dep = getFinancialPerformanceDate(/** @type {Record<string, unknown>} */ (r));
    const ka = r.kost_accomodatie != null ? r.kost_accomodatie : r.kost_accommodatie;
    const discountAmount = r.discount_amount != null ? r.discount_amount : r.discountAmount;
    const ig = r.incasso_flag;
    const incassoFlag =
      ig === true ||
      ig === 1 ||
      String(ig).toLowerCase() === "true" ||
      String(ig).toLowerCase() === "yes" ||
      String(ig).toLowerCase() === "ja";
    return {
      ...r,
      departure_date: dep,
      kost_accomodatie: ka,
      discount_amount: discountAmount,
      excluded_from_profit: isTruthyFlag(r.excluded_from_profit),
      incasso_flag: incassoFlag,
    };
  }

  /**
   * Normaliseer reizigerrij uit RPC (payment_travellers).
   * @param {Record<string, unknown>} t
   */
  function normalizePaymentTravellerRow(t) {
    const prijsAnnul = numField(t.prijs_annulatieverzekering);
    const prijsReis = numField(t.prijs_reisverzekering);
    const prijsCombi = numField(t.prijs_annulatie_en_reisverzekering);
    const discountAmount = numField(t.discount_amount);
    const discountCodeUsed = String(t.discount_code_used ?? "").trim();
    const insurance_type = travellerInsuranceType({
      ...t,
      prijs_annulatieverzekering: prijsAnnul,
      prijs_reisverzekering: prijsReis,
      prijs_annulatie_en_reisverzekering: prijsCombi,
    });
    return {
      ...t,
      prijs_annulatieverzekering: prijsAnnul,
      prijs_reisverzekering: prijsReis,
      prijs_annulatie_en_reisverzekering: prijsCombi,
      discount_amount: discountAmount,
      discount_code_used: discountCodeUsed,
      insurance_type,
      aantal_voorschotbetalingsherinneringen: Math.max(0, Math.round(n(t.aantal_voorschotbetalingsherinneringen))),
      aantal_totaalbetalingsherinneringen: Math.max(0, Math.round(n(t.aantal_totaalbetalingsherinneringen))),
    };
  }

  /** 0..3 blijft; 4+ wordt 4 (bucket “4+”). */
  function reminderLevelTo4(raw) {
    const v = Math.max(0, Math.round(Number(raw) || 0));
    return v >= 4 ? 4 : v;
  }

  /** @param {Record<string, unknown>} t */
  function travellerDisplayName(t) {
    const fn = String(t.voornaam ?? "").trim();
    const ln = String(t.achternaam ?? "").trim();
    const s = `${fn} ${ln}`.trim();
    return s || "—";
  }

  /** @param {Record<string, unknown>} t */
  function paymentTypeLabel(t) {
    const v = n(t.aantal_voorschotbetalingsherinneringen);
    const tot = n(t.aantal_totaalbetalingsherinneringen);
    const parts = [];
    if (v > 0) parts.push("Voorschot");
    if (tot > 0) parts.push("Totaalbedrag");
    if (!parts.length) return "—";
    return parts.join(" + ");
  }

  /** @param {unknown} statusRaw */
  function betalingIsOke(statusRaw) {
    return String(statusRaw ?? "")
      .trim()
      .toUpperCase() === "OKE";
  }

  /**
   * Voorschot: 0→0-7d, 1→7-12d, 2→12-17d, 3+→>17d (Excel gebruikt doorgaans max 3).
   * @param {unknown} raw
   */
  function voorschotTermBucketIndex(raw) {
    const v = Math.max(0, Math.round(Number(raw) || 0));
    if (v >= 3) return 3;
    return Math.min(3, v);
  }

  /**
   * Totaalbedrag: 0 → op tijd; 1→≥55d; 2→50-54; 3→47-49; 4+ → laattijdig.
   * @param {unknown} raw
   */
  function totaalTermBucketIndex(raw) {
    const v = Math.max(0, Math.round(Number(raw) || 0));
    if (v === 0) return 0;
    if (v === 1) return 1;
    if (v === 2) return 2;
    if (v === 3) return 3;
    return 4;
  }

  const VOORSCHOT_TERM_LABELS = ["0–7 d", "7–12 d", "12–17 d", "17+ d"];

  const TOTAAL_TERM_LABELS = ["Op tijd", "≥55 d v.v.", "50–54 d", "47–49 d", "<47 d"];

  /** Balken: aantal op de staaf; percentage in tooltip. */
  const financeBarValuePlugin = {
    id: "financeBarValuePlugin",
    /** @param {import("chart.js").Chart} chart */
    afterDatasetsDraw(chart) {
      if (chart.config.type !== "bar") return;
      const cid = chart.canvas?.id;
      if (cid !== "finChartPayVoorschotTerm" && cid !== "finChartPayTotaalTerm") return;
      const { ctx } = chart;
      chart.data.datasets.forEach((dataset, di) => {
        const meta = chart.getDatasetMeta(di);
        meta.data.forEach((bar, i) => {
          const v = dataset.data[i];
          if (v == null || !Number.isFinite(Number(v)) || Number(v) <= 0) return;
          const x = bar.x;
          const y = bar.y;
          ctx.save();
          ctx.fillStyle = "#0f172a";
          ctx.font = "600 11px system-ui,Segoe UI,sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "bottom";
          ctx.fillText(nfInt.format(Number(v)), x, y - 4);
          ctx.restore();
        });
      });
    },
  };

  function yearOptions() {
    const fromPool = [...new Set(ACTIVE_POOL.map((b) => parseDep(getFinancialPerformanceDate(/** @type {any} */ (b))).y))]
      .filter((y) => y > 0)
      .sort((a, b) => b - a);
    const merged = [...new Set([..._optionsYears, ...fromPool])].sort((a, b) => b - a);
    return merged.length ? merged : [new Date().getFullYear()];
  }

  /**
   * Standaard jaarselectie: huidig kalenderjaar als het in de lijst staat, anders het nieuwste beschikbare jaar.
   * @param {number[]} yearsSortedDesc
   * @returns {string}
   */
  function defaultFinYearSelectValue(yearsSortedDesc) {
    const list = yearsSortedDesc.length ? yearsSortedDesc : [new Date().getFullYear()];
    const cy = new Date().getFullYear();
    if (list.includes(cy)) return String(cy);
    return String(list[0]);
  }

  function showFinanceError(msg) {
    const err = document.getElementById("financeError");
    if (!err) return;
    err.textContent = msg;
    err.classList.remove("d-none");
  }

  function clearFinanceError() {
    const err = document.getElementById("financeError");
    if (!err) return;
    err.classList.add("d-none");
    err.textContent = "";
  }

  async function loadOptions() {
    const res = await fetch(OPTIONS_URL, fetchJson);
    const j = await readJsonResponse(res, "Financiën-opties");
    _optionsYears = Array.isArray(j.years) ? j.years.map((x) => Number(x)).filter((y) => y > 0) : [];
    _optionsBrands = Array.isArray(j.brands) ? j.brands : [];
    _optionsDest = Array.isArray(j.bestemmingen) ? j.bestemmingen : [];
    if (Array.isArray(j.countries) && j.countries.length) _optionsCountries = sanitizeFinanceCountryOptions(j.countries);
    else _optionsCountries = sanitizeFinanceCountryOptions(_optionsCountries);
    if (j.error) showFinanceError(String(j.error));
  }

  async function loadData() {
    clearFinanceError();
    const st = getFilterState();
    const params = new URLSearchParams({
      brand: st.brand,
      destination: (st.dests || []).join(","),
      land: st.country === "__all__" ? "" : st.country,
      // Groei-tabellen vergelijken huidig jaar met vorig jaar vanuit dezelfde ruwe pool.
      // Daarom vragen we data op zonder server-side jaar/periode-beperking.
      year: "0",
      period: "all",
    });
    const excParams = new URLSearchParams({
      brand: st.brand,
      destination: (st.dests || []).join(","),
      year: String(st.year),
    });
    EXCURSION_LINES_RAW = [];
    const [finSettled, excSettled] = await Promise.allSettled([
      fetch(`${DATA_URL}?${params}`, fetchJson).then((res) => readJsonResponse(res, "Financiën-data")),
      fetch(`${EXCURSIONS_DATA_URL}?${excParams}`, fetchJson).then((res) => readJsonResponse(res, "Excursies-data (Financiën)")),
    ]);
    let j = {};
    if (finSettled.status === "fulfilled") j = finSettled.value;
    else {
      showFinanceError(finSettled.reason instanceof Error ? finSettled.reason.message : String(finSettled.reason));
      ACTIVE_POOL = [];
      PAYMENT_TRAVELLERS = [];
      return;
    }
    if (j.error) {
      showFinanceError(String(j.error));
      ACTIVE_POOL = [];
      PAYMENT_TRAVELLERS = [];
      return;
    }
    if (excSettled.status === "fulfilled" && excSettled.value && !excSettled.value.error) {
      const ej = excSettled.value;
      EXCURSION_LINES_RAW = Array.isArray(ej.rows) ? ej.rows.map((x) => /** @type {Record<string, unknown>} */ (x)) : [];
    }
    const rows = Array.isArray(j.rows) ? j.rows : [];
    ACTIVE_POOL = dedupeBookingRowsById(
      rows.map((r) => normalizeBookingRow(/** @type {Record<string, unknown>} */ (r))).filter(isActiveBooking),
    );
    const ptr = j.payment_travellers ?? j.paymentTravellers;
    PAYMENT_TRAVELLERS = Array.isArray(ptr)
      ? ptr.map((t) => normalizePaymentTravellerRow(/** @type {Record<string, unknown>} */ (t)))
      : [];
  }

  /**
   * Sla handmatige kost op boekingsniveau op en laat backend deze verdelen per reiziger.
   * @param {string} bookingId
   * @param {number} totaleKost
   */
  async function saveJouwVerblijfKost(bookingId, totaleKost) {
    const csrf = getCsrfToken();
    if (!csrf) throw new Error("CSRF-token ontbreekt. Vernieuw de pagina.");
    const res = await fetch(JOUW_VERBLIJF_COST_URL, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
        "X-CSRF-Token": csrf,
      },
      body: JSON.stringify({
        booking_id: bookingId,
        totale_kost: totaleKost,
      }),
    });
    const payload = await readJsonResponse(res, "Opslaan kost (jouw verblijf in)");
    if (payload?.error) throw new Error(String(payload.error));
    memoAgg.clear();
    await loadData();
    refreshAll();
  }

  function populateFilterControls() {
    const y = document.getElementById("finYear");
    if (y) {
      const years = _optionsYears.length ? _optionsYears : [new Date().getFullYear()];
      if (IS_RESTRICTED_ROLE) {
        y.innerHTML = `<option value="${FORCED_YEAR}">${FORCED_YEAR}</option>`;
        y.value = String(FORCED_YEAR);
        y.disabled = true;
      } else {
        y.innerHTML =
          `<option value="0">Alle jaren</option>` + years.map((yr) => `<option value="${yr}">${yr}</option>`).join("");
        y.value = defaultFinYearSelectValue(years);
      }
    }
    const cmp = document.getElementById("finCompare");
    if (cmp) cmp.value = "prev_year";
    const brand = document.getElementById("finBrand");
    if (brand) {
      while (brand.options.length > 1) brand.remove(1);
      _optionsBrands.forEach((b) => {
        const o = document.createElement("option");
        o.value = b;
        o.textContent = b;
        brand.appendChild(o);
      });
    }
    const dest = document.getElementById("finDest");
    if (dest) {
      dest.innerHTML = "";
      _optionsDest.forEach((d) => {
        const naam = d.naam || d.name || "";
        if (!naam) return;
        const o = document.createElement("option");
        o.value = naam;
        o.textContent = naam;
        dest.appendChild(o);
      });
      if (window.TAMultiSelectFilter) {
        if (!finDestMulti) {
          finDestMulti = new window.TAMultiSelectFilter({
            selectEl: dest,
            placeholderAll: "Alle bestemmingen",
            searchPlaceholder: "Zoek bestemming...",
            itemLabelSingle: "bestemming",
            itemLabelPlural: "bestemmingen geselecteerd",
          });
        } else {
          finDestMulti.syncOptionsFromSelect();
        }
      }
    }
    const country = document.getElementById("finCountry");
    if (country) {
      country.innerHTML = '<option value="__all__">Alle landen</option>';
      _optionsCountries.forEach((c) => {
        const o = document.createElement("option");
        o.value = c;
        o.textContent = c;
        country.appendChild(o);
      });
    }
  }

  /** @param {typeof ACTIVE_POOL} rows */
  function excludeCancelled(rows) {
    return rows.filter(isActiveBooking);
  }

  /**
   * Defensieve deduplicatie op booking_id:
   * als een booking door een upstream issue dubbel in de payload staat,
   * telt die maar 1x mee in omzet/winst/KPI's.
   * @param {Array<Record<string, unknown>>} rows
   * @returns {Array<Record<string, unknown>>}
   */
  function dedupeBookingRowsById(rows) {
    const out = [];
    const seen = new Set();
    let skipped = 0;
    for (const row of rows) {
      const bid = String(row.booking_id ?? "").trim();
      if (!bid) {
        out.push(row);
        continue;
      }
      if (seen.has(bid)) {
        skipped += 1;
        continue;
      }
      seen.add(bid);
      out.push(row);
    }
    return out;
  }

  /**
   * @param {string} iso
   */
  function parseDep(iso) {
    const s = String(iso || "").trim();
    const head = s.includes("T") ? s.slice(0, 10) : s.slice(0, 10);
    const p = head.split("-");
    if (p.length < 2) return { y: 0, m: 0, d: 0 };
    const y = Number(p[0]) || 0;
    const m = Number(p[1]) || 0;
    const dPart = (p[2] || "0").replace(/T.*/, "");
    const d = Number(dPart) || 0;
    return { y, m, d };
  }

  /**
   * @param {typeof ACTIVE_POOL[0]} b
   * @param {{ year: number, period: string }} filt
   */
  function matchesPeriod(b, filt) {
    const { y, m } = parseDep(getFinancialPerformanceDate(/** @type {Record<string, unknown>} */ (b)));
    if (filt.year && filt.year > 0 && y !== filt.year) return false;
    if (filt.period === "all" || !filt.period) return true;
    if (filt.period === "q1") return m >= 1 && m <= 3;
    if (filt.period === "q2") return m >= 4 && m <= 6;
    if (filt.period === "q3") return m >= 7 && m <= 9;
    if (filt.period === "q4") return m >= 10 && m <= 12;
    if (filt.period === "summer") return m >= 6 && m <= 8;
    return true;
  }

  /**
   * @param {typeof ACTIVE_POOL} rows
   * @param {ReturnType<typeof getFilterState>} st
   */
  function applyFilters(rows, st) {
    return rows.filter((b) => {
      if (st.brand && st.brand !== "__all__") {
        const want = String(st.brand).trim();
        if (brandKey(b) !== want) return false;
      }
      if (Array.isArray(st.dests) && st.dests.length) {
        const wanted = new Set(st.dests.map((x) => String(x).trim()));
        if (!wanted.has(String(b.destination || "").trim())) return false;
      }
      if (st.country && st.country !== "__all__" && b.country !== st.country) return false;
      return matchesPeriod(b, { year: st.year, period: st.period });
    });
  }

  /**
   * Omzetdataset: zelfde basis als Overzicht (binnen filters, excl. annulatie/dropped).
   * @param {typeof ACTIVE_POOL} rows
   * @param {ReturnType<typeof getFilterState>} st
   */
  function getOmzetBoekingen(rows, st) {
    return applyFilters(rows, st);
  }

  /**
   * Winstdataset: strengere selectie.
   * @param {typeof ACTIVE_POOL} bookings
   */
  function getWinstBoekingen(bookings) {
    return bookings.filter((b) => {
      if (isExcludedFromProfitCalculation(/** @type {Record<string, unknown>} */ (b))) return false;
      const rawWinst = b.winst;
      if (rawWinst != null && String(rawWinst).trim() !== "") return Number.isFinite(Number(rawWinst));
      return Number.isFinite(computeProfit(/** @type {Record<string, unknown>} */ (b)));
    });
  }

  /**
   * @param {typeof ACTIVE_POOL} rows
   */
  function metricsFromRows(rows, profitRows = rows) {
    let omzet = 0;
    let winst = 0;
    let totalToPay = 0;
    let paid = 0;
    let open = 0;
    let pax = 0;
    let reminders = 0;
    let countPaid = 0;
    let countOpen = 0;
    let probCount = 0;
    let probOpenCount = 0;
    let probOpenSum = 0;
    let profitEligibleBookings = 0;
    let profitEligiblePax = 0;
    for (const b of rows) {
      const tt = numField(b.totaal_te_betalen);
      omzet += tt;
      totalToPay += tt;
      paid += numField(b.paid_amount);
      open += numField(b.openstaand);
      pax += numField(b.pax);
      reminders += numField(b.payment_reminders);
      if (numField(b.openstaand) < 0.01) countPaid += 1;
      else countOpen += 1;
    }

    for (const b of profitRows) {
      const w = computeProfit(/** @type {Record<string, unknown>} */ (b));
      if (!Number.isFinite(w)) continue;
      winst += w;
      if (!isExcludedFromProfitCalculation(/** @type {Record<string, unknown>} */ (b))) {
        profitEligibleBookings += 1;
        profitEligiblePax += numField(b.pax);
      }
    }

    const selectedBookings = new Set(rows.map((b) => String(b.booking_id ?? "")).filter(Boolean));
    const openBookingIds = new Set(
      rows
        .filter((b) => numField(b.openstaand) >= 0.01)
        .map((b) => String(b.booking_id ?? ""))
        .filter(Boolean),
    );
    const paymentRows = filterTravellersForBookings(PAYMENT_TRAVELLERS, rows);
    const problematicBookingIds = new Set();
    const problematicOpenBookingIds = new Set();
    for (const row of paymentRows) {
      const bid = String(row.booking_id ?? "").trim();
      if (!bid || !selectedBookings.has(bid)) continue;
      if (!isProblematicPayment(row)) continue;
      problematicBookingIds.add(bid);
      if (openBookingIds.has(bid)) problematicOpenBookingIds.add(bid);
      const openAmount = numField(row.nog_te_betalen != null ? row.nog_te_betalen : row.openstaand);
      if (openAmount >= 0.01) probOpenSum += openAmount;
    }
    probCount = problematicBookingIds.size;
    probOpenCount = problematicOpenBookingIds.size;

    const pctPaid = totalToPay > 0 ? paid / totalToPay : 0;
    const avgPaxPrice = computeAveragePricePerPerson(rows);
    const avgProfitBook = profitEligibleBookings > 0 ? winst / profitEligibleBookings : 0;
    const avgProfitPax = profitEligiblePax > 0 ? winst / profitEligiblePax : 0;
    const probPctSel = rows.length ? probCount / rows.length : 0;
    const probPctOpen = openBookingIds.size > 0 ? probOpenCount / openBookingIds.size : 0;

    return {
      omzet,
      winst,
      totalToPay,
      paid,
      open,
      pctPaid,
      pax,
      reminders,
      probCount,
      probPctSel,
      probPctOpen,
      probOpenSum,
      countPaid,
      countOpen,
      profitEligibleBookings,
      profitEligiblePax,
      avgPaxPrice,
      avgProfitBook,
      avgProfitPax,
      insRev: 0,
      insRevByType: { travel: 0, annul: 0, combi: 0 },
      insAvgPerBook: 0,
      insPax: 0,
      insCounts: { travel: 0, annul: 0, combi: 0, none: 0 },
      insCountsExclusive: { travel: 0, annul: 0, combi: 0, none: 0 },
      uptake: 0,
      pctNoIns: 0,
      pending: rows.reduce((s, b) => s + numField(b.pending_payments), 0),
    };
  }

  /**
   * @param {typeof ACTIVE_POOL} rows
   * @param {(b: typeof ACTIVE_POOL[0]) => string} keyFn
   */
  function groupSum(rows, keyFn, valueFn) {
    /** @type {Record<string, number>} */
    const o = {};
    for (const b of rows) {
      const k = keyFn(b);
      o[k] = (o[k] || 0) + valueFn(b);
    }
    return o;
  }

  /**
   * @param {typeof ACTIVE_POOL} rows
   * @param {(b: typeof ACTIVE_POOL[0]) => string} keyFn
   */
  function groupCount(rows, keyFn) {
    /** @type {Record<string, number>} */
    const o = {};
    for (const b of rows) {
      const k = keyFn(b);
      o[k] = (o[k] || 0) + 1;
    }
    return o;
  }

  /**
   * @param {typeof ACTIVE_POOL} rows
   */
  function monthlySeries(rows, year, field) {
    const byM = Array.from({ length: 12 }, (_, i) => ({ m: i + 1, v: 0 }));
    for (const b of rows) {
      const { y, m } = parseDep(getFinancialPerformanceDate(/** @type {Record<string, unknown>} */ (b)));
      if (year && y !== year) continue;
      if (m >= 1 && m <= 12) {
        if (field === "omzet") byM[m - 1].v += numField(b.totaal_te_betalen);
        else if (field === "winst") byM[m - 1].v += computeProfit(b);
      }
    }
    return byM.map((x) => x.v);
  }

  function defaultFilterState() {
    const years = yearOptions();
    const cy = new Date().getFullYear();
    const year = IS_RESTRICTED_ROLE ? FORCED_YEAR : years.includes(cy) ? cy : years[0] || cy;
    return {
      year,
      brand: "__all__",
      dest: "",
      country: "__all__",
      period: "all",
      compare: "prev_year",
      _years: years,
    };
  }

  function getFilterState() {
    const yEl = document.getElementById("finYear");
    const brandEl = document.getElementById("finBrand");
    const destEl = document.getElementById("finDest");
    const countryEl = document.getElementById("finCountry");
    const periodEl = document.getElementById("finPeriod");
    const compareEl = document.getElementById("finCompare");
    const selectedDests = finDestMulti ? finDestMulti.getValue() : destEl ? [String(destEl.value)].filter(Boolean) : [];
    return {
      year: IS_RESTRICTED_ROLE ? FORCED_YEAR : yEl ? Number(yEl.value) || 0 : 0,
      brand: brandEl ? String(brandEl.value) : "__all__",
      dest: selectedDests[0] || "",
      dests: selectedDests,
      country: countryEl ? String(countryEl.value) : "__all__",
      period: periodEl ? String(periodEl.value) : "all",
      compare: compareEl ? String(compareEl.value) : "none",
      _years: yearOptions(),
    };
  }

  /**
   * @param {ReturnType<typeof getFilterState>} st
   */
  function shiftYearState(st, delta) {
    return { ...st, year: st.year + delta };
  }

  /**
   * @param {ReturnType<typeof getFilterState>} st
   */
  function buildAggregates(st) {
    const key = JSON.stringify({ st });
    if (memoAgg.has(key)) return /** @type {ReturnType<typeof buildAggregatesInner>} */ (memoAgg.get(key));

    const result = buildAggregatesInner(st);
    memoAgg.set(key, result);
    return result;
  }

  /**
   * @param {ReturnType<typeof getFilterState>} st
   */
  function buildAggregatesInner(st) {
    const cur = getOmzetBoekingen(ACTIVE_POOL, st);
    const hasYear = Boolean(st.year && st.year > 0);
    const prev = hasYear ? getOmzetBoekingen(ACTIVE_POOL, shiftYearState(st, -1)) : [];
    const two = hasYear ? getOmzetBoekingen(ACTIVE_POOL, shiftYearState(st, -2)) : [];
    const curProfit = getWinstBoekingen(cur);
    const prevProfit = getWinstBoekingen(prev);
    const twoProfit = getWinstBoekingen(two);

    const mCur = metricsFromRows(cur, curProfit);
    const mPrev = metricsFromRows(prev, prevProfit);
    const mTwo = metricsFromRows(two, twoProfit);
    Object.assign(mCur, insuranceMetricsFromTravellers(filterTravellersForBookings(PAYMENT_TRAVELLERS, cur)));
    Object.assign(mPrev, insuranceMetricsFromTravellers(filterTravellersForBookings(PAYMENT_TRAVELLERS, prev)));
    Object.assign(mTwo, insuranceMetricsFromTravellers(filterTravellersForBookings(PAYMENT_TRAVELLERS, two)));
    attachExtrasProfitMetrics(mCur, curProfit);
    attachExtrasProfitMetrics(mPrev, prevProfit);
    attachExtrasProfitMetrics(mTwo, twoProfit);
    attachOpmerkingProbMetrics(mCur, cur);
    attachOpmerkingProbMetrics(mPrev, prev);
    attachOpmerkingProbMetrics(mTwo, two);

    const y = st.year || parseDep(getFinancialPerformanceDate(cur[0] || {})).y;
    const yEff = st.year && st.year > 0 ? st.year : 0;
    const monthlyOmzet = monthlySeries(cur, yEff, "omzet");
    const monthlyWinst = monthlySeries(curProfit, yEff, "winst");
    const monthlyOmzetPrevYear = hasYear ? monthlySeries(prev, st.year - 1, "omzet") : Array(12).fill(0);
    const monthlyOmzetTwoYears = hasYear ? monthlySeries(two, st.year - 2, "omzet") : Array(12).fill(0);

    const byBrandOmzet = groupSum(
      cur,
      (b) => brandKey(b),
      (b) => numField(b.totaal_te_betalen)
    );
    const byBrandWinst = groupSum(
      curProfit,
      (b) => brandKey(b),
      (b) => computeProfit(b)
    );
    const byDestOmzet = groupSum(
      cur,
      (b) => destKey(b),
      (b) => numField(b.totaal_te_betalen)
    );
    const byDestWinst = groupSum(
      curProfit,
      (b) => destKey(b),
      (b) => computeProfit(b)
    );

    const byQuarterOmzet = quarterBuckets(cur, yEff, "omzet");
    const byQuarterWinst = quarterBuckets(curProfit, yEff, "winst");
    const prevYEff = hasYear ? st.year - 1 : 0;
    const byQuarterOmzetPrev = hasYear ? quarterBuckets(prev, prevYEff, "omzet") : [0, 0, 0, 0];
    const byQuarterWinstPrev = hasYear ? quarterBuckets(prevProfit, prevYEff, "winst") : [0, 0, 0, 0];

    const avgPaxGlobal = mCur.avgPaxPrice;

    const payBuckets = { direct: 0, d7: 0, d30: 0, later: 0, open: 0 };
    for (const b of cur) {
      const openAmt = n(b.openstaand);
      if (openAmt < 0.01) {
        const days = n(b.days_to_first_payment);
        if (days <= 0) payBuckets.direct += 1;
        else if (days <= 7) payBuckets.d7 += 1;
        else if (days <= 30) payBuckets.d30 += 1;
        else payBuckets.later += 1;
      } else payBuckets.open += 1;
    }

    const travForIns = filterTravellersForBookings(PAYMENT_TRAVELLERS, cur);
    const insStackBrand = {};
    for (const tr of travForIns) {
      const br = brandKey(tr);
      if (!insStackBrand[br]) insStackBrand[br] = { travel: 0, annul: 0, combi: 0, none: 0 };
      const typ = travellerInsuranceType(tr);
      if (typ === "travel") insStackBrand[br].travel += 1;
      else if (typ === "annul") insStackBrand[br].annul += 1;
      else if (typ === "combi") insStackBrand[br].combi += 1;
      else insStackBrand[br].none += 1;
    }
    for (const lb of INS_BRAND_CHART_LABELS) {
      if (!insStackBrand[lb]) insStackBrand[lb] = { travel: 0, annul: 0, combi: 0, none: 0 };
    }

    const insStackDest = {};
    for (const tr of travForIns) {
      const d = destKey(tr);
      if (!insStackDest[d]) insStackDest[d] = { travel: 0, annul: 0, combi: 0, none: 0 };
      const typ = travellerInsuranceType(tr);
      if (typ === "travel") insStackDest[d].travel += 1;
      else if (typ === "annul") insStackDest[d].annul += 1;
      else if (typ === "combi") insStackDest[d].combi += 1;
      else insStackDest[d].none += 1;
    }

    const cumPayTimeline = (() => {
      const sorted = [...cur].sort((a, b) =>
        getFinancialPerformanceDate(/** @type {Record<string, unknown>} */ (a)).localeCompare(
          getFinancialPerformanceDate(/** @type {Record<string, unknown>} */ (b))
        )
      );
      let cumPaid = 0;
      const total = sorted.reduce((s, b) => s + n(b.totaal_te_betalen), 0) || 1;
      return sorted.map((b) => {
        cumPaid += n(b.paid_amount);
        return cumPaid / total;
      });
    })();

    return {
      cur,
      curProfit,
      prev,
      prevProfit,
      two,
      twoProfit,
      mCur,
      mPrev,
      mTwo,
      monthlyOmzet,
      monthlyWinst,
      monthlyOmzetPrevYear,
      monthlyOmzetTwoYears,
      byBrandOmzet,
      byBrandWinst,
      byDestOmzet,
      byDestWinst,
      byQuarterOmzet,
      byQuarterWinst,
      byQuarterOmzetPrev,
      byQuarterWinstPrev,
      avgPaxGlobal,
      hasYear,
      payBuckets,
      insStackBrand,
      insStackDest,
      cumPayTimeline,
      year: y,
    };
  }

  /**
   * @param {ReturnType<typeof metricsFromRows>} m
   * @param {string} id
   */
  function metricByKpiId(m, id) {
    if (id === "finKpiOmzet") return m.omzet;
    if (id === "finKpiWinstBookings") return m.winstBookings;
    if (id === "finKpiWinstExtras") return m.winstExtras;
    if (id === "finKpiWinstTotal") return m.winstTotal;
    if (id === "finKpiPaid") return m.paid;
    if (id === "finKpiOpen") return m.open;
    if (id === "finKpiPctPaid") return m.pctPaid;
    if (id === "finKpiPctProbOpmerking") return m.pctProbOpmerking;
    if (id === "finKpiAvgPax") return m.avgPaxPrice;
    if (id === "finKpiProbCount") return m.probCount;
    if (id === "finKpiProbPct") return m.probPctSel;
    if (id === "finKpiProbPctOpen") return m.probPctOpen;
    if (id === "finKpiProbOpen") return m.probOpenSum;
    if (id === "finKpiAvgProfitPax") return m.avgProfitPax;
    return 0;
  }

  /** Vergelijking vs vorig jaar: alleen omzet/winst/gem. winst krijgen groen/rood op het verschil. */
  const FIN_CMP_ROLE = {
    finKpiOmzetCmp: "delta",
    finKpiWinstBookingsCmp: "delta",
    finKpiWinstExtrasCmp: "delta",
    finKpiWinstTotalCmp: "delta",
    finKpiPaidCmp: "neutral",
    finKpiOpenCmp: "neutral",
    finKpiPctPaidCmp: "neutral",
    finKpiPctProbOpmerkingCmp: "delta",
    finKpiAvgPaxCmp: "neutral",
    finKpiAvgProfitPaxCmp: "delta",
  };

  function financeCmpLine(label, curV, prevV, isPct, cmpId) {
    const SP = globalThis.SemanticPerformance;
    const role = FIN_CMP_ROLE[cmpId] || "neutral";
    if (!SP) {
      if (prevV == null || !Number.isFinite(prevV)) return "";
      const diff = curV - prevV;
      if (Math.abs(diff) < 1e-9) return `${label}: gelijk`;
      if (isPct) {
        const rel = prevV !== 0 ? (diff / Math.abs(prevV)) * 100 : 0;
        return `${label}: ${rel >= 0 ? "+" : ""}${nfDec.format(rel)}%`;
      }
      return `${label}: ${diff >= 0 ? "+" : ""}${nfMoney.format(diff)}`;
    }
    return SP.compareLine(label, curV, prevV, isPct, role, { nfMoney, nfDec });
  }

  /** Zet semantische tekstkleur op hoofdwaarde (winst-achtige KPI’s). */
  function applyFinanceKpiMainSemantic(id, raw) {
    const el = document.getElementById(id);
    if (!el) return;
    const profitIds = ["finKpiWinstBookings", "finKpiWinstExtras", "finKpiWinstTotal", "finKpiAvgProfitPax"];
    if (!profitIds.includes(id)) return;
    el.classList.remove("sp-text--pos", "sp-text--neg", "sp-text--neutral");
    const n = Number(raw);
    const SP = globalThis.SemanticPerformance;
    if (SP) {
      const c = SP.textClass(Number.isFinite(n) ? n : raw, "profit");
      if (c) el.classList.add(c);
      return;
    }
    if (Number.isFinite(n) && n < 0) el.classList.add("sp-text--neg");
    else if (Number.isFinite(n) && n > 0) el.classList.add("sp-text--pos");
  }

  /** Uitleg per KPI-kaart (data-finance-kpi). Alleen statische HTML-string; geen user input. */
  const FINANCE_KPI_HELP = {
    omzet: {
      title: "Omzet",
      html: `<p class="mb-2">Deze KPI toont de totale waarde van alle meegenomen boekingen binnen de gekozen filters.</p>
        <p class="mb-2"><strong>Meegenomen</strong><br />- boekingen die binnen de actieve filters vallen<br />- boekingen met een bedrag dat de reiziger moet betalen<br />- alle reizigers binnen die boekingen</p>
        <p class="mb-2"><strong>Niet meegenomen</strong><br />- boekingen buiten de gekozen filters<br />- bedragen die niet aan een reiziger of boeking gekoppeld zijn<br />- boekingen zonder betaalbaar bedrag</p>
        <p class="mb-2"><strong>Formule</strong><br />Omzet = som van alle bedragen die reizigers moeten betalen (reissom + extra’s zoals transfer, bagage en andere aangerekende posten)</p>
        <p class="mb-0"><strong>Vs vorig jaar</strong><br />Dit vergelijkt de omzet met dezelfde selectie in het vorige jaar.</p>`,
    },
    paid: {
      title: "Reeds betaald",
      html: `<p class="mb-2">Deze KPI toont hoeveel er al effectief ontvangen is voor de meegenomen boekingen.</p>
        <p class="mb-2"><strong>Meegenomen</strong><br />- ontvangen betalingen van reizigers binnen de actieve filters<br />- gedeeltelijke betalingen<br />- volledige betalingen</p>
        <p class="mb-2"><strong>Niet meegenomen</strong><br />- nog openstaande bedragen<br />- boekingen buiten de gekozen filters<br />- waarborgen of bedragen die niet als betaling voor de reis tellen</p>
        <p class="mb-2"><strong>Formule</strong><br />Reeds betaald = som van alle reeds betaalde bedragen</p>
        <p class="mb-0"><strong>Vs vorig jaar</strong><br />Dit vergelijkt het reeds betaalde bedrag met dezelfde selectie in het vorige jaar.</p>`,
    },
    open: {
      title: "Openstaand",
      html: `<p class="mb-2">Deze KPI toont hoeveel er nog betaald moet worden voor de meegenomen boekingen.</p>
        <p class="mb-2"><strong>Meegenomen</strong><br />- openstaande bedragen van reizigers binnen de actieve filters<br />- zowel voorschotten als saldi die nog niet betaald zijn</p>
        <p class="mb-2"><strong>Niet meegenomen</strong><br />- bedragen die al betaald zijn<br />- boekingen buiten de gekozen filters<br />- waarborgen of aparte kosten die niet meetellen als reissaldo</p>
        <p class="mb-2"><strong>Formule</strong><br />Openstaand = som van alle nog te betalen bedragen per reiziger (praktisch gelijk aan omzet - reeds betaald)</p>
        <p class="mb-0"><strong>Vs vorig jaar</strong><br />Dit vergelijkt het openstaande bedrag met dezelfde selectie in het vorige jaar.</p>`,
    },
    pct_paid: {
      title: "% betaald",
      html: `<p class="mb-2">Deze KPI toont welk deel van de totale omzet al betaald is.</p>
        <p class="mb-2"><strong>Meegenomen</strong><br />- alle meegenomen omzet<br />- alle reeds betaalde bedragen binnen dezelfde selectie</p>
        <p class="mb-2"><strong>Niet meegenomen</strong><br />- boekingen buiten de gekozen filters<br />- bedragen die niet meetellen in omzet of betaling</p>
        <p class="mb-2"><strong>Formule</strong><br />% betaald = reeds betaald / omzet × 100<br />Als de omzet 0 is, wordt het percentage als 0% getoond.</p>
        <p class="mb-0"><strong>Vs vorig jaar</strong><br />Dit vergelijkt het betaalpercentage met dezelfde selectie in het vorige jaar.</p>`,
    },
    pct_prob: {
      title: "% problematische betalingen",
      html: `<p class="mb-2">Deze KPI toont welk aandeel van de reizigers een problematische betalingsstatus heeft.</p>
        <p class="mb-2"><strong>Meegenomen</strong><br />- reizigers binnen de actieve filters<br />- reizigers met een betalingsstatus die niet <strong>OKE</strong> is en die in de opmerkingentabel komt</p>
        <p class="mb-2"><strong>Niet meegenomen</strong><br />- boekingen buiten de gekozen filters<br />- reizigers met status <strong>OKE</strong><br />- statussen die expliciet worden uitgesloten in de huidige logica: <strong>Geen kosten</strong>, <strong>Geannuleerd</strong>, <strong>Cancelled/Canceled/Cancel</strong>, <strong>Dropped/Drop</strong>, <strong>Processing</strong>, en annulatie-varianten</p>
        <p class="mb-2"><strong>Formule</strong><br />% problematische betalingen = aantal problematische betalingen / totaal aantal betalingen × 100</p>
        <p class="mb-0"><strong>Vs vorig jaar</strong><br />Dit vergelijkt het percentage problematische betalingen met dezelfde selectie in het vorige jaar.</p>`,
    },
    avg_pax: {
      title: "Gemiddelde prijs per persoon",
      html: `<p class="mb-2">Deze KPI toont hoeveel een reiziger gemiddeld moet betalen binnen de gekozen filters.</p>
        <p class="mb-2"><strong>Meegenomen</strong><br />- alle reizigers binnen de actieve filters<br />- het te betalen bedrag per reiziger</p>
        <p class="mb-2"><strong>Niet meegenomen</strong><br />- boekingen buiten de gekozen filters<br />- reizigers zonder betaalbaar bedrag</p>
        <p class="mb-2"><strong>Formule</strong><br />Gemiddelde prijs per persoon = totale omzet / aantal reizigers</p>
        <p class="mb-0"><strong>Vs vorig jaar</strong><br />Dit vergelijkt de gemiddelde prijs per persoon met dezelfde selectie in het vorige jaar.</p>`,
    },
    winst_bookings: {
      title: "Winst uit boekingen",
      html: `<p class="mb-2">Deze KPI toont de winst op de basisboekingen, zonder aparte extra opbrengsten.</p>
        <p class="mb-2"><strong>Meegenomen</strong><br />- omzet uit boekingen binnen de actieve filters<br />- kosten per boeking: accommodatiekost, transportkost, transferkost en extra kosten<br />- toegepaste kortingen<br />- alle reizigers binnen de meegenomen boekingen</p>
        <p class="mb-2"><strong>Niet meegenomen</strong><br />- opbrengsten uit extra’s als die apart worden berekend<br />- boekingen buiten de gekozen filters<br />- kosten of opbrengsten die niet aan een boeking gekoppeld zijn</p>
        <p class="mb-2"><strong>Formule</strong><br />Winst uit boekingen = totaal te betalen - excursies - prijs van de 3 verzekeringen - accommodatiekost - transportkost - transferkost - package prijs - kortingsbedrag</p>
        <p class="mb-0"><strong>Vs vorig jaar</strong><br />Dit vergelijkt de winst uit boekingen met dezelfde selectie in het vorige jaar.</p>`,
    },
    winst_extras: {
      title: "Winst uit extra's",
      html: `<p class="mb-2">Deze KPI toont de winst uit bijkomende producten of diensten bovenop de basisboeking.</p>
        <p class="mb-2"><strong>Meegenomen</strong><br />- extra opbrengsten binnen de actieve filters<br />- in de huidige logica concreet: <strong>excursies</strong> en <strong>verzekeringen</strong><br />- bij excursies: verkoopprijs min inkoop/commissie<br />- bij verzekeringen: verzekeringsopbrengst met vaste marge-aanpak</p>
        <p class="mb-2"><strong>Niet meegenomen</strong><br />- basisomzet van de boeking<br />- boekingen buiten de gekozen filters<br />- extra’s zonder gekoppelde opbrengst</p>
        <p class="mb-2"><strong>Formule</strong><br />Winst uit extra’s = winst uit excursies + winst uit verzekeringen</p>
        <p class="mb-0"><strong>Vs vorig jaar</strong><br />Dit vergelijkt de winst uit extra’s met dezelfde selectie in het vorige jaar.</p>`,
    },
    winst_total: {
      title: "Totale winst",
      html: `<p class="mb-2">Deze KPI toont de totale winst binnen de gekozen filters.</p>
        <p class="mb-2"><strong>Meegenomen</strong><br />- winst uit boekingen<br />- winst uit extra’s<br />- alle boekingen binnen de actieve filters</p>
        <p class="mb-2"><strong>Niet meegenomen</strong><br />- boekingen buiten de gekozen filters<br />- opbrengsten of kosten die niet in de financiële berekening zitten</p>
        <p class="mb-2"><strong>Formule</strong><br />Totale winst = (omzet - accommodatiekost - transportkost - transferkost - extra kosten - kortingen) + (winst excursies + winst verzekeringen)</p>
        <p class="mb-0"><strong>Vs vorig jaar</strong><br />Dit vergelijkt de totale winst met dezelfde selectie in het vorige jaar.</p>`,
    },
    avg_profit_pax: {
      title: "Gemiddelde winst per persoon",
      html: `<p class="mb-2">Deze KPI toont hoeveel winst er gemiddeld per reiziger overblijft.</p>
        <p class="mb-2"><strong>Meegenomen</strong><br />- totale winst binnen de actieve filters<br />- alle reizigers binnen de meegenomen boekingen</p>
        <p class="mb-2"><strong>Niet meegenomen</strong><br />- boekingen buiten de gekozen filters<br />- reizigers buiten de gekozen filters</p>
        <p class="mb-2"><strong>Formule</strong><br />Gemiddelde winst per persoon = totale winst / aantal reizigers</p>
        <p class="mb-0"><strong>Vs vorig jaar</strong><br />Dit vergelijkt de gemiddelde winst per persoon met dezelfde selectie in het vorige jaar.</p>`,
    },
  };

  const FINANCE_DISCOUNT_KPI_HELP = {
    discount_total: {
      title: "Totale korting",
      html: `<p class="mb-2"><strong>Betekenis</strong><br />Som van alle kortingsbedragen op reizigersniveau binnen de actieve filters.</p>
        <p class="mb-2"><strong>Formule</strong><br /><code>Σ discount_amount</code> voor reizigers met korting.</p>
        <p class="mb-2"><strong>Data die meetelt</strong><br />Reizigers in boekingen die binnen Financiën meetellen (excl. dropped/cancelled).</p>
        <p class="mb-2"><strong>Uitsluitingen</strong><br />Boekingen met status dropped of cancelled en reizigers die buiten de actieve filters vallen.</p>
        <p class="mb-0"><strong>Databron</strong><br />Excel-kolommen <code>Discount amount</code>/<code>Discount code used</code> opgeslagen in <code>reiziger_financien</code>.</p>`,
    },
    bookings_with_discount: { title: "Boekingen met korting", html: "<p class='mb-0'>Aantal unieke boekingen met minstens 1 reiziger met korting (bedrag &gt; 0 of code ingevuld).</p>" },
    travellers_with_discount: { title: "Reizigers met korting", html: "<p class='mb-0'>Aantal unieke reizigers met korting op reizigersniveau.</p>" },
    avg_discount_per_traveller: { title: "Gem. korting per reiziger", html: "<p class='mb-0'><code>Totale korting / reizigers met korting</code>.</p>" },
    avg_discount_per_booking: { title: "Gem. korting per boeking", html: "<p class='mb-0'><code>Totale korting / boekingen met korting</code>.</p>" },
    pct_travellers_with_discount: { title: "% reizigers met korting", html: "<p class='mb-0'><code>Reizigers met korting / alle reizigers binnen filters</code>.</p>" },
    pct_bookings_with_discount: { title: "% boekingen met korting", html: "<p class='mb-0'><code>Boekingen met korting / alle boekingen binnen filters</code>.</p>" },
    margin_impact: { title: "Impact op winstmarge", html: "<p class='mb-0'>Verschil in procentpunten tussen huidige marge en hypothetische marge zonder korting. Voor marge wordt de centrale tijdelijke winstfilter gebruikt.</p>" },
  };

  function initFinanceKpiHelp() {
    const modalEl = document.getElementById("finKpiHelpModal");
    const titleEl = document.getElementById("finKpiHelpTitle");
    const bodyEl = document.getElementById("finKpiHelpBody");
    const B = globalThis.bootstrap;
    if (!modalEl || !titleEl || !bodyEl || !B || typeof B.Modal !== "function") return;
    const modal = B.Modal.getOrCreateInstance(modalEl, { backdrop: true, keyboard: true });
    const openFor = (key) => {
      const block = FINANCE_KPI_HELP[key];
      if (!block) return;
      titleEl.textContent = block.title;
      bodyEl.innerHTML = block.html;
      modal.show();
    };
    document.querySelectorAll("#finKPIGrid [data-finance-kpi]").forEach((el) => {
      const onOpen = () => {
        const key = el.getAttribute("data-finance-kpi");
        if (key) openFor(key);
      };
      el.addEventListener("click", onOpen);
      el.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          onOpen();
        }
      });
    });
  }

  function initFinanceDiscountKpiHelp() {
    const modalEl = document.getElementById("finKpiHelpModal");
    const titleEl = document.getElementById("finKpiHelpTitle");
    const bodyEl = document.getElementById("finKpiHelpBody");
    const B = globalThis.bootstrap;
    if (!modalEl || !titleEl || !bodyEl || !B || typeof B.Modal !== "function") return;
    const modal = B.Modal.getOrCreateInstance(modalEl, { backdrop: true, keyboard: true });
    const openFor = (key) => {
      const block = FINANCE_DISCOUNT_KPI_HELP[key];
      if (!block) return;
      titleEl.textContent = block.title;
      bodyEl.innerHTML = block.html;
      modal.show();
    };
    document.querySelectorAll("[data-finance-discount-kpi]").forEach((el) => {
      const onOpen = () => {
        const key = el.getAttribute("data-finance-discount-kpi");
        if (key) openFor(key);
      };
      el.addEventListener("click", onOpen);
      el.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          onOpen();
        }
      });
    });
  }

  const FinanceKPIGrid = {
    /**
     * @param {ReturnType<typeof buildAggregates>} agg
     * @param {ReturnType<typeof getFilterState>} st
     */
    render(agg, st) {
      const { mCur, mPrev, mTwo } = agg;
      const denom = agg.cur.length || 1;
      const dash = "—";

      if (agg.cur.length === 0) {
        const clearCmp = [
          "finKpiOmzetCmp",
          "finKpiWinstBookingsCmp",
          "finKpiWinstExtrasCmp",
          "finKpiWinstTotalCmp",
          "finKpiPaidCmp",
          "finKpiOpenCmp",
          "finKpiPctPaidCmp",
          "finKpiPctProbOpmerkingCmp",
          "finKpiAvgPaxCmp",
          "finKpiAvgProfitPaxCmp",
        ];
        [
          "finKpiOmzet",
          "finKpiWinstBookings",
          "finKpiWinstExtras",
          "finKpiWinstTotal",
          "finKpiPaid",
          "finKpiOpen",
          "finKpiPctPaid",
          "finKpiPctProbOpmerking",
          "finKpiAvgPax",
          "finKpiAvgProfitPax",
        ].forEach((id) => {
          const el = document.getElementById(id);
          if (el) el.textContent = dash;
        });
        clearCmp.forEach((id) => {
          const el = document.getElementById(id);
          if (el) el.innerHTML = "";
        });
        ["finKpiWinstBookings", "finKpiWinstExtras", "finKpiWinstTotal", "finKpiAvgProfitPax"].forEach((id) => {
          const el = document.getElementById(id);
          if (el) el.classList.remove("sp-text--pos", "sp-text--neg", "sp-text--neutral");
        });
        ["finKpiProbCount", "finKpiProbPct", "finKpiProbPctOpen", "finKpiProbOpen", "finKpiProbCmp"].forEach((id) => {
          const el = document.getElementById(id);
          if (el) el.textContent = id === "finKpiProbCmp" ? "" : dash;
        });
        return;
      }

      const map = [
        ["finKpiOmzet", mCur.omzet, "finKpiOmzetCmp"],
        ["finKpiPaid", mCur.paid, "finKpiPaidCmp"],
        ["finKpiOpen", mCur.open, "finKpiOpenCmp"],
        ["finKpiPctPaid", mCur.pctPaid, "finKpiPctPaidCmp", true],
        ["finKpiPctProbOpmerking", mCur.pctProbOpmerking, "finKpiPctProbOpmerkingCmp", true],
        ["finKpiAvgPax", mCur.avgPaxPrice, "finKpiAvgPaxCmp"],
        ["finKpiWinstBookings", mCur.winstBookings, "finKpiWinstBookingsCmp"],
        ["finKpiWinstExtras", mCur.winstExtras, "finKpiWinstExtrasCmp"],
        ["finKpiWinstTotal", mCur.winstTotal, "finKpiWinstTotalCmp"],
        ["finKpiAvgProfitPax", mCur.avgProfitPax, "finKpiAvgProfitPaxCmp"],
      ];
      const intIds = new Set(["finKpiProbCount"]);
      for (const row of map) {
        const id = /** @type {string} */ (row[0]);
        const val = /** @type {number} */ (row[1]);
        const cmpId = /** @type {string} */ (row[2]);
        const isPct = row[3] === true;
        const el = document.getElementById(id);
        const cEl = document.getElementById(cmpId);
        if (!el) continue;
        if (isPct) el.textContent = nfPct.format(val);
        else if (intIds.has(id)) el.textContent = nfInt.format(val);
        else el.textContent = nfMoney.format(val);
        if (cEl) {
          if (st.compare === "none") {
            cEl.innerHTML = "";
          } else if (st.compare === "prev_year") {
            const prevVal = metricByKpiId(mPrev, id);
            cEl.innerHTML = financeCmpLine("vs vorig jaar", val, prevVal, isPct, cmpId);
          } else {
            const prevVal = metricByKpiId(mPrev, id);
            const twoVal = metricByKpiId(mTwo, id);
            const line1 = financeCmpLine("vs vorig jaar", val, prevVal, isPct, cmpId);
            let line2 = "";
            if (twoVal != null && Number.isFinite(twoVal)) {
              if (isPct) line2 = `<br/><span class="text-muted small">vs 2 jaar geleden: ${nfPct.format(twoVal)}</span>`;
              else if (intIds.has(id)) line2 = `<br/><span class="text-muted small">vs 2 jaar geleden: ${nfInt.format(twoVal)}</span>`;
              else line2 = `<br/><span class="text-muted small">vs 2 jaar geleden: ${nfMoney.format(twoVal)}</span>`;
            }
            cEl.innerHTML = line1 + line2;
          }
        }
        applyFinanceKpiMainSemantic(id, val);
      }

      const probIds = [
        ["finKpiProbCount", mCur.probCount, false],
        ["finKpiProbPct", mCur.probPctSel, true],
        ["finKpiProbPctOpen", mCur.probPctOpen, true],
        ["finKpiProbOpen", mCur.probOpenSum, false],
      ];
      for (const [pid, pval, isPct] of probIds) {
        const el = document.getElementById(pid);
        if (!el) continue;
        if (isPct) el.textContent = nfPct.format(pval);
        else if (pid === "finKpiProbCount") el.textContent = nfInt.format(pval);
        else el.textContent = nfMoney.format(pval);
      }
      const pCmp = document.getElementById("finKpiProbCmp");
      if (pCmp) {
        if (st.compare === "none") {
          pCmp.innerHTML = "";
        } else if (st.compare === "prev_year") {
          pCmp.innerHTML = financeCmpLine("vs vorig jaar (aantal)", mCur.probCount, mPrev.probCount, false, "finKpiProbCmp");
        } else {
          const line1 = financeCmpLine("vs vorig jaar (aantal)", mCur.probCount, mPrev.probCount, false, "finKpiProbCmp");
          const twoVal = mTwo.probCount;
          const line2 =
            twoVal != null && Number.isFinite(twoVal)
              ? `<br/><span class="text-muted small">vs 2 jaar geleden: ${nfInt.format(twoVal)}</span>`
              : "";
          pCmp.innerHTML = line1 + line2;
        }
      }

    },
  };

  /** Subtiele assen; geen vaste cijfers op de chart — alleen tooltips bij hover. */
  const chartGrid = {
    x: {
      grid: { color: "rgba(148, 163, 184, 0.14)", drawBorder: false },
      ticks: { color: "#64748b", font: { size: 11 }, maxTicksLimit: 12 },
    },
    y: {
      grid: { color: "rgba(148, 163, 184, 0.14)", drawBorder: false },
      ticks: { color: "#64748b", font: { size: 11 }, maxTicksLimit: 8 },
    },
  };

  /** Compacte x-as voor betalings-termijndiagrammen (geen overlap). */
  const payChartAxisX = {
    ...chartGrid.x,
    ticks: {
      ...chartGrid.x.ticks,
      maxRotation: 0,
      minRotation: 0,
      autoSkip: true,
      font: { size: 10 },
    },
  };

  const ChartMixins = {
    defaults: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 420, easing: "easeOutCubic" },
      interaction: { mode: "index", intersect: false },
      hover: { mode: "index", intersect: false },
      elements: {
        bar: { borderRadius: 6, borderSkipped: false },
        line: { borderWidth: 2, tension: 0.25 },
        point: {
          radius: 0,
          hoverRadius: 5,
          hoverBorderWidth: 2,
          hoverBackgroundColor: "#ffffff",
          hoverBorderColor: COL.orange,
        },
      },
      plugins: {
        legend: {
          position: "bottom",
          align: "start",
          labels: {
            color: "#64748b",
            font: { size: 11, family: "inherit" },
            boxWidth: 10,
            boxHeight: 10,
            padding: 14,
            usePointStyle: true,
          },
        },
        tooltip: {
          enabled: true,
          backgroundColor: "rgba(15, 23, 42, 0.94)",
          titleColor: "#f1f5f9",
          bodyColor: "#e2e8f0",
          borderColor: "rgba(148, 163, 184, 0.35)",
          borderWidth: 1,
          padding: 12,
          cornerRadius: 8,
          displayColors: true,
          titleFont: { size: 12, weight: "600" },
          bodyFont: { size: 12 },
          caretSize: 6,
          callbacks: {
            title(items) {
              if (!items.length) return "";
              const label = items[0].label;
              return label != null && String(label) !== "" ? String(label) : "";
            },
            label(ctx) {
              const p = ctx.parsed;
              const raw =
                p && typeof p === "object"
                  ? p.y != null && Number.isFinite(p.y)
                    ? p.y
                    : p.x != null && Number.isFinite(p.x)
                      ? p.x
                      : p
                  : p;
              const v = typeof raw === "number" ? raw : Number(raw);
              const series = ctx.dataset.label ? `${ctx.dataset.label}: ` : "";
              return `${series}${Number.isFinite(v) ? nfMoney.format(v) : raw}`;
            },
          },
        },
      },
      scales: chartGrid,
    },
  };

  /** @param {number | null | undefined} p */
  function fmtPctOrDash(p) {
    if (p == null || !Number.isFinite(p)) return "—";
    return nfPct.format(p);
  }

  /** @param {number | null | undefined} v */
  function signedToneClass(v) {
    if (v == null || !Number.isFinite(v) || Math.abs(v) < 1e-9) return "";
    return v > 0 ? "finance-inline-stat--green" : "finance-inline-stat--red";
  }

  /** Semantische klasse voor winstwaarden met fallback-kleur. */
  function spProfitClass(v) {
    const SP = globalThis.SemanticPerformance;
    if (SP) return SP.textClass(v, "profit") || signedToneClass(Number(v));
    return signedToneClass(Number(v));
  }

  /** Semantische klasse voor delta/groeiwaarden met fallback-kleur. */
  function spDeltaClass(v) {
    const SP = globalThis.SemanticPerformance;
    if (SP) return SP.textClass(v, "delta") || signedToneClass(Number(v));
    return signedToneClass(Number(v));
  }

  /**
   * @typedef {{ value: number | null, display: string, sortValue: number, tone: "pos" | "neg" | "neutral" }} GrowthResult
   */

  /**
   * @param {number} current
   * @param {number | null | undefined} previous
   * @param {boolean} enabled
   * @returns {GrowthResult}
   */
  function calculateGrowthPercentage(current, previous, enabled = true) {
    const nInf = -1e12;
    if (!enabled) return { value: null, display: "—", sortValue: nInf, tone: "neutral" };
    if (!Number.isFinite(previous) || Math.abs(Number(previous)) < 1e-9) {
      if (Math.abs(current) < 1e-9) return { value: null, display: "—", sortValue: nInf, tone: "neutral" };
      return { value: null, display: "Nieuw", sortValue: 1e12, tone: "pos" };
    }
    const value = (current - Number(previous)) / Math.abs(Number(previous));
    if (Math.abs(value) < 1e-9) return { value: 0, display: nfPct.format(0), sortValue: 0, tone: "neutral" };
    return {
      value,
      display: nfPct.format(value),
      sortValue: value,
      tone: value > 0 ? "pos" : "neg",
    };
  }

  function initRevenueBucket() {
    return { omzet: 0, winst: 0, boekingen: 0, pax: 0, profitEligibleBookings: 0, profitEligiblePax: 0 };
  }

  /**
   * @param {typeof ACTIVE_POOL} rows
   * @returns {number}
   */
  function computeAveragePricePerBooking(rows) {
    if (!rows.length) return 0;
    const total = rows.reduce((s, b) => s + numField(b.totaal_te_betalen), 0);
    return total / rows.length;
  }

  /**
   * Gemiddelde prijs per persoon = totale omzet / totaal aantal reizigers.
   * `pax` per boeking moet hetzelfde zijn als het aantal `reizigers`-rijen (komt uit RPC als count),
   * niet `boekingen.aantal_reizigers`, anders wijkt de noemer af van de som over reizigers.
   *
   * @param {typeof ACTIVE_POOL} rows
   * @returns {number}
   */
  function computeAveragePricePerPerson(rows) {
    const total = rows.reduce((s, b) => s + numField(b.totaal_te_betalen), 0);
    const totalPax = rows.reduce((s, b) => s + numField(b.pax), 0);
    return totalPax > 0 ? total / totalPax : 0;
  }

  /**
   * @param {typeof ACTIVE_POOL} rows
   * @param {(b: typeof ACTIVE_POOL[0]) => string} keyFn
   */
  function summarizeRevenueBy(rows, keyFn, profitRows = rows) {
    /** @type {Record<string, { omzet: number, winst: number, boekingen: number, pax: number }>} */
    const out = {};
    for (const b of rows) {
      const k = keyFn(b);
      if (!out[k]) out[k] = initRevenueBucket();
      out[k].omzet += numField(b.totaal_te_betalen);
      out[k].boekingen += 1;
      out[k].pax += numField(b.pax);
    }
    for (const b of profitRows) {
      const k = keyFn(b);
      if (!out[k]) out[k] = initRevenueBucket();
      out[k].winst += computeProfit(b);
      out[k].profitEligibleBookings += 1;
      out[k].profitEligiblePax += numField(b.pax);
    }
    return out;
  }

  /**
   * @param {string} label
   * @param {{ omzet: number, winst: number, boekingen: number, pax: number } | undefined} cur
   * @param {{ omzet: number, winst: number, boekingen: number, pax: number } | undefined} prev
   */
  function toRevenueRow(label, cur, prev, includeGrowth = true) {
    const omzet = n(cur?.omzet);
    const winst = n(cur?.winst);
    const boekingen = n(cur?.boekingen);
    const pax = n(cur?.pax);
    const profitEligiblePax = n(cur?.profitEligiblePax);
    const groeiOmzet = calculateGrowthPercentage(omzet, prev?.omzet, includeGrowth);
    const groeiWinst = calculateGrowthPercentage(winst, prev?.winst, includeGrowth);
    const winstmarge = omzet > 0.01 ? winst / omzet : null;
    const gemWinstPerPersoon = profitEligiblePax > 0 ? winst / profitEligiblePax : null;
    const nInf = -1e12;
    return {
      label,
      omzet,
      winst,
      groeiOmzetPct: groeiOmzet,
      groeiWinstPct: groeiWinst,
      winstmarge,
      gemWinstPerPersoon,
      boekingen,
      pax,
      sgOm: groeiOmzet.sortValue,
      sgWin: groeiWinst.sortValue,
      wm: winstmarge == null ? nInf : winstmarge,
      gwp: gemWinstPerPersoon == null ? nInf : gemWinstPerPersoon,
    };
  }

  /**
   * @param {typeof ACTIVE_POOL} rows
   * @returns {number}
   */
  function countProfitExcludedBookings(rows) {
    let count = 0;
    for (const b of rows) {
      if (b.excluded_from_profit === true || isExcludedFromProfitCalculation(b)) count += 1;
    }
    return count;
  }

  const financeRevenueTableRows = {
    month: /** @type {Array<Record<string, unknown>>} */ ([]),
    brand: /** @type {Array<Record<string, unknown>>} */ ([]),
    dest: /** @type {Array<Record<string, unknown>>} */ ([]),
    quarter: /** @type {Array<Record<string, unknown>>} */ ([]),
    year: /** @type {Array<Record<string, unknown>>} */ ([]),
  };

  const REV_BODY_TO_TABLE = {
    finTblMonthBody: "finTblMonth",
    finTblBrandBody: "finTblBrand",
    finTblDestBody: "finTblDest",
    finTblQuarterBody: "finTblQuarter",
    finTblYearBody: "finTblYear",
  };

  const REV_BODY_TO_KEY = {
    finTblMonthBody: "month",
    finTblBrandBody: "brand",
    finTblDestBody: "dest",
    finTblQuarterBody: "quarter",
    finTblYearBody: "year",
  };

  /**
   * @param {string} bodyId
   * @param {Array<Record<string, unknown>>} rows
   */
  function renderRevenueTbody(bodyId, rows) {
    const tbody = document.getElementById(bodyId);
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="9" class="text-muted text-center py-3">Geen gegevens voor deze selectie.</td></tr>`;
      return;
    }
    const growthClass = (g) => {
      if (!g || g.tone === "neutral") return "finance-inline-stat--neutral";
      return g.tone === "pos" ? "finance-inline-stat--green" : "finance-inline-stat--red";
    };
    const growthText = (g) => (g && typeof g.display === "string" ? g.display : "—");
    tbody.innerHTML = rows
      .map(
        (r) => `<tr>
        <td>${escapeHtml(String(r.label))}</td>
        <td class="text-end">${nfMoney.format(n(r.omzet))}</td>
        <td class="text-end ${spProfitClass(r.winst)}">${nfMoney.format(n(r.winst))}</td>
        <td class="text-end ${growthClass(r.groeiOmzetPct)}">${growthText(r.groeiOmzetPct)}</td>
        <td class="text-end ${growthClass(r.groeiWinstPct)}">${growthText(r.groeiWinstPct)}</td>
        <td class="text-end ${spProfitClass(r.winstmarge)}">${fmtPctOrDash(r.winstmarge)}</td>
        <td class="text-end ${spProfitClass(r.gemWinstPerPersoon)}">${r.gemWinstPerPersoon != null && Number.isFinite(Number(r.gemWinstPerPersoon)) ? nfMoney.format(Number(r.gemWinstPerPersoon)) : "—"}</td>
        <td class="text-end">${nfInt.format(n(r.boekingen))}</td>
        <td class="text-end">${nfInt.format(n(r.pax))}</td>
      </tr>`,
      )
      .join("");
  }

  /**
   * @param {string} bodyId
   * @param {Array<Record<string, unknown>>} rows
   * @param {boolean} hasData
   */
  function renderRevenueTable(bodyId, rows, hasData) {
    const key = REV_BODY_TO_KEY[bodyId];
    const tableId = REV_BODY_TO_TABLE[bodyId];
    const tbody = document.getElementById(bodyId);
    if (!tbody || !key) return;
    if (!hasData || !rows.length) {
      tbody.innerHTML = `<tr><td colspan="9" class="text-muted text-center py-3">Geen gegevens voor deze selectie.</td></tr>`;
      financeRevenueTableRows[key] = [];
      return;
    }
    financeRevenueTableRows[key] = rows.map((x) => ({ ...x }));
    renderRevenueTbody(bodyId, financeRevenueTableRows[key]);
    const tbl = document.getElementById(tableId);
    const wire = typeof globalThis.TA_wireSortableTable === "function" ? globalThis.TA_wireSortableTable : null;
    if (tbl && wire) {
      wire(
        tbl,
        () => financeRevenueTableRows[key].slice(),
        (sorted) => {
          financeRevenueTableRows[key] = sorted;
          renderRevenueTbody(bodyId, sorted);
        },
      );
    }
  }

  const RevenueSection = {
    /**
     * @param {ReturnType<typeof buildAggregates>} agg
     * @param {ReturnType<typeof getFilterState> | undefined} stArg
     */
    render(agg, stArg) {
      const st = stArg || getFilterState();
      const includeYoY = Boolean(agg.hasYear && st.compare !== "none");
      const labels = ["jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];
      const has = agg.cur.length > 0;
      const showEmpty = (id, show) => {
        const e = document.getElementById(id);
        if (e) e.classList.toggle("d-none", !show);
      };
      showEmpty("finEmptyRevenueProfitMonth", !has);

      destroyChart("finChartRevenueProfitMonth");
      if (has) {
        const ctx = document.getElementById("finChartRevenueProfitMonth");
        if (ctx) {
          charts.finChartRevenueProfitMonth = new Chart(ctx.getContext("2d"), {
            type: "line",
            data: {
              labels,
              datasets: [
                {
                  label: "Winst",
                  data: agg.monthlyWinst,
                  borderColor: COL.green,
                  backgroundColor: "rgba(22, 163, 74, 0.24)",
                  tension: 0.25,
                  fill: true,
                  pointBorderColor: "#ffffff",
                },
                {
                  label: "Omzet",
                  data: agg.monthlyOmzet,
                  borderColor: COL.orange,
                  backgroundColor: "rgba(234, 88, 12, 0.22)",
                  tension: 0.25,
                  fill: "-1",
                  pointBorderColor: "#ffffff",
                },
              ],
            },
            options: {
              ...ChartMixins.defaults,
              plugins: {
                ...ChartMixins.defaults.plugins,
                tooltip: {
                  ...ChartMixins.defaults.plugins.tooltip,
                  callbacks: {
                    ...ChartMixins.defaults.plugins.tooltip.callbacks,
                    title(items) {
                      const l = items[0]?.label;
                      return l ? `Maand: ${l}` : "";
                    },
                    label() {
                      return "";
                    },
                    afterBody(items) {
                      const idx = items?.[0]?.dataIndex;
                      if (idx == null || idx < 0) return [];
                      const omzet = n(agg.monthlyOmzet[idx]);
                      const winst = n(agg.monthlyWinst[idx]);
                      return [`Omzet: ${nfMoney.format(omzet)}`, `Winst: ${nfMoney.format(winst)}`];
                    },
                  },
                },
              },
            },
          });
        }
      }

      const monthCur = summarizeRevenueBy(agg.cur, (b) => String(parseDep(getFinancialPerformanceDate(b)).m || 0), agg.curProfit);
      const monthPrev = includeYoY
        ? summarizeRevenueBy(agg.prev, (b) => String(parseDep(getFinancialPerformanceDate(b)).m || 0), agg.prevProfit)
        : {};
      const monthRows = labels
        .map((label, idx) => toRevenueRow(label, monthCur[String(idx + 1)], monthPrev[String(idx + 1)], includeYoY))
        .filter((r) => r.boekingen > 0 || Math.abs(r.omzet) > 0.01 || Math.abs(r.winst) > 0.01);

      const quarterKey = (b) => {
        const m = parseDep(getFinancialPerformanceDate(b)).m;
        if (m >= 1 && m <= 3) return "Q1";
        if (m >= 4 && m <= 6) return "Q2";
        if (m >= 7 && m <= 9) return "Q3";
        if (m >= 10 && m <= 12) return "Q4";
        return "(onbekend)";
      };
      const quarterCur = summarizeRevenueBy(agg.cur, quarterKey, agg.curProfit);
      const quarterPrev = includeYoY ? summarizeRevenueBy(agg.prev, quarterKey, agg.prevProfit) : {};
      const quarterRows = ["Q1", "Q2", "Q3", "Q4"].map((label) => toRevenueRow(label, quarterCur[label], quarterPrev[label], includeYoY));
      const yearCur = summarizeRevenueBy(agg.cur, (b) => String(parseDep(getFinancialPerformanceDate(b)).y || 0), agg.curProfit);
      const yearPrev = includeYoY
        ? summarizeRevenueBy(agg.prev, (b) => String(parseDep(getFinancialPerformanceDate(b)).y || 0), agg.prevProfit)
        : {};
      const yearLabels = Object.keys(yearCur)
        .filter((y) => Number(y) > 0)
        .sort((a, b) => Number(a) - Number(b));
      const yearRows = yearLabels.map((yearLabel) => {
        const prevLabel = String(Number(yearLabel) - 1);
        return toRevenueRow(yearLabel, yearCur[yearLabel], yearPrev[prevLabel], includeYoY);
      });

      const brandCur = summarizeRevenueBy(agg.cur, brandKey, agg.curProfit);
      const brandCurNorm = summarizeRevenueBy(agg.cur, (b) => normalizeBucketTextKey(brandKey(b)), agg.curProfit);
      const brandPrevNorm = includeYoY
        ? summarizeRevenueBy(agg.prev, (b) => normalizeBucketTextKey(brandKey(b)), agg.prevProfit)
        : {};
      const brandLabelByNorm = new Map();
      Object.keys(brandCur).forEach((label) => {
        const norm = normalizeBucketTextKey(label);
        if (!brandLabelByNorm.has(norm)) brandLabelByNorm.set(norm, label);
      });
      const brandRows = Object.keys(brandCurNorm)
        .sort((a, b) => n(brandCurNorm[b]?.omzet) - n(brandCurNorm[a]?.omzet))
        .map((norm) => toRevenueRow(brandLabelByNorm.get(norm) || norm, brandCurNorm[norm], brandPrevNorm[norm], includeYoY));

      const destCurNorm = summarizeRevenueBy(agg.cur, (b) => normalizeBucketTextKey(destKey(b)), agg.curProfit);
      const destPrevNorm = includeYoY
        ? summarizeRevenueBy(agg.prev, (b) => normalizeBucketTextKey(destKey(b)), agg.prevProfit)
        : {};
      const destLabelByNorm = new Map();
      const destCurRaw = summarizeRevenueBy(agg.cur, destKey, agg.curProfit);
      Object.keys(destCurRaw).forEach((label) => {
        const norm = normalizeBucketTextKey(label);
        if (!destLabelByNorm.has(norm)) destLabelByNorm.set(norm, label);
      });
      const destRows = Object.keys(destCurNorm)
        .sort((a, b) => n(destCurNorm[b]?.omzet) - n(destCurNorm[a]?.omzet))
        .slice(0, 30)
        .map((norm) => toRevenueRow(destLabelByNorm.get(norm) || norm, destCurNorm[norm], destPrevNorm[norm], includeYoY));

      if (FINANCE_DEV_MODE) {
        const debug = (table, curRows, prevRows, currentKeys, previousKeys) => {
          console.debug("[Finance growth]", {
            table,
            currentYear: st.year,
            previousYear: st.year > 0 ? st.year - 1 : null,
            currentRows: curRows.length,
            previousRows: prevRows.length,
            currentKeys,
            previousKeys,
          });
        };
        debug("month", agg.cur, agg.prev, Object.keys(monthCur), Object.keys(monthPrev));
        debug("quarter", agg.cur, agg.prev, Object.keys(quarterCur), Object.keys(quarterPrev));
        debug("brand", agg.cur, agg.prev, Object.keys(brandCurNorm), Object.keys(brandPrevNorm));
        debug("destination", agg.cur, agg.prev, Object.keys(destCurNorm), Object.keys(destPrevNorm));
        debug("year", agg.cur, agg.prev, Object.keys(yearCur), Object.keys(yearPrev));
      }

      renderRevenueTable("finTblMonthBody", monthRows, has);
      renderRevenueTable("finTblBrandBody", brandRows, has);
      renderRevenueTable("finTblDestBody", destRows, has);
      renderRevenueTable("finTblQuarterBody", quarterRows, has);
      renderRevenueTable("finTblYearBody", yearRows, has);

      requestAnimationFrame(() => {
        ["finChartRevenueProfitMonth"].forEach((id) => charts[id]?.resize?.());
      });
    },
  };

  /** Sorteerbare rijen: betalingen met opmerking. */
  let financePayOutstandingRows = /** @type {Record<string, unknown>[]} */ ([]);

  const PaymentsSection = {
    /** @param {ReturnType<typeof buildAggregates>} agg */
    render(_agg) {
      const setTxt = (id, t) => {
        const el = document.getElementById(id);
        if (el) el.textContent = t;
      };

      const tr = PAYMENT_TRAVELLERS;
      const nTot = tr.length || 0;

      /** @param {number} level 0..4 — alleen Voorschot / Totaalbedrag (aantal · % v.h. totaal aantal reizigers). */
      const fillKpiLevel = (level, suffix) => {
        let nv = 0;
        let nt = 0;
        for (const t of tr) {
          const rv = reminderLevelTo4(t.aantal_voorschotbetalingsherinneringen);
          const rt = reminderLevelTo4(t.aantal_totaalbetalingsherinneringen);
          if (rv === level) nv += 1;
          if (rt === level) nt += 1;
        }
        const pctV = nTot > 0 ? nv / nTot : 0;
        const pctT = nTot > 0 ? nt / nTot : 0;
        setTxt(`finPayKpiRem${suffix}Voorschot`, `${nfInt.format(nv)} · ${nfPct.format(pctV)}`);
        setTxt(`finPayKpiRem${suffix}Totaal`, `${nfInt.format(nt)} · ${nfPct.format(pctT)}`);
      };

      fillKpiLevel(0, "0");
      fillKpiLevel(1, "1");
      fillKpiLevel(2, "2");
      fillKpiLevel(3, "3");

      const hasT = nTot > 0;
      const showEmpty = (id, show) => {
        const e = document.getElementById(id);
        if (e) e.classList.toggle("d-none", !show);
      };
      showEmpty("finEmptyPayVoorschot", !hasT);
      showEmpty("finEmptyPayTotaal", !hasT);

      if (typeof Chart !== "undefined" && typeof window !== "undefined" && !window.__financeBarPluginRegistered) {
        Chart.register(financeBarValuePlugin);
        window.__financeBarPluginRegistered = true;
      }

      /** @type {number[]} */
      const voorschotBarData = [0, 0, 0, 0];
      /** @type {number[]} */
      const totaalBarData = [0, 0, 0, 0, 0];
      for (const t of tr) {
        voorschotBarData[voorschotTermBucketIndex(t.aantal_voorschotbetalingsherinneringen)] += 1;
        totaalBarData[totaalTermBucketIndex(t.aantal_totaalbetalingsherinneringen)] += 1;
      }
      const sumV = voorschotBarData.reduce((a, b) => a + b, 0) || 1;
      const sumT = totaalBarData.reduce((a, b) => a + b, 0) || 1;

      destroyChart("finChartPayVoorschotTerm");
      const ctxV = document.getElementById("finChartPayVoorschotTerm");
      if (ctxV && hasT) {
        charts.finChartPayVoorschotTerm = new Chart(ctxV.getContext("2d"), {
          type: "bar",
          data: {
            labels: VOORSCHOT_TERM_LABELS,
            datasets: [
              {
                label: "Aantal reizigers",
                data: voorschotBarData,
                backgroundColor: COL.orangeSoft,
                borderColor: COL.orange,
                borderWidth: 1,
                borderSkipped: false,
                borderRadius: { topLeft: 6, topRight: 6, bottomLeft: 0, bottomRight: 0 },
                _denomTotal: sumV,
              },
            ],
          },
          options: {
            ...ChartMixins.defaults,
            scales: {
              ...ChartMixins.defaults.scales,
              x: payChartAxisX,
              y: {
                ...ChartMixins.defaults.scales.y,
                beginAtZero: true,
                ticks: {
                  ...ChartMixins.defaults.scales.y.ticks,
                  precision: 0,
                },
              },
            },
            plugins: {
              ...ChartMixins.defaults.plugins,
              tooltip: {
                ...ChartMixins.defaults.plugins.tooltip,
                callbacks: {
                  ...ChartMixins.defaults.plugins.tooltip.callbacks,
                  title(items) {
                    const l = items[0]?.label;
                    return l ? String(l) : "";
                  },
                  label(ctx) {
                    const v = ctx.parsed.y;
                    const total = /** @type {any} */ (ctx.dataset)._denomTotal || 1;
                    const pct = total ? v / total : 0;
                    return `${nfInt.format(v)} reizigers (${nfPct.format(pct)} van totaal)`;
                  },
                },
              },
            },
          },
        });
      }

      destroyChart("finChartPayTotaalTerm");
      const ctxT = document.getElementById("finChartPayTotaalTerm");
      if (ctxT && hasT) {
        charts.finChartPayTotaalTerm = new Chart(ctxT.getContext("2d"), {
          type: "bar",
          data: {
            labels: TOTAAL_TERM_LABELS,
            datasets: [
              {
                label: "Aantal reizigers",
                data: totaalBarData,
                backgroundColor: COL.blueSoft,
                borderColor: COL.blue,
                borderWidth: 1,
                borderSkipped: false,
                borderRadius: { topLeft: 6, topRight: 6, bottomLeft: 0, bottomRight: 0 },
                _denomTotal: sumT,
              },
            ],
          },
          options: {
            ...ChartMixins.defaults,
            scales: {
              ...ChartMixins.defaults.scales,
              x: payChartAxisX,
              y: {
                ...ChartMixins.defaults.scales.y,
                beginAtZero: true,
                ticks: {
                  ...ChartMixins.defaults.scales.y.ticks,
                  precision: 0,
                },
              },
            },
            plugins: {
              ...ChartMixins.defaults.plugins,
              tooltip: {
                ...ChartMixins.defaults.plugins.tooltip,
                callbacks: {
                  ...ChartMixins.defaults.plugins.tooltip.callbacks,
                  title(items) {
                    const l = items[0]?.label;
                    return l ? String(l) : "";
                  },
                  label(ctx) {
                    const v = ctx.parsed.y;
                    const total = /** @type {any} */ (ctx.dataset)._denomTotal || 1;
                    const pct = total ? v / total : 0;
                    return `${nfInt.format(v)} reizigers (${nfPct.format(pct)} van totaal)`;
                  },
                },
              },
            },
          },
        });
      }

      const tbody = document.getElementById("finTableOutstandingBody");
      const tblOut = document.getElementById("finTableOutstanding");
      const wireOut = typeof globalThis.TA_wireSortableTable === "function" ? globalThis.TA_wireSortableTable : null;
      const renderOutstandingRows = (rows) => {
        if (!tbody) return;
        if (!rows.length) {
          tbody.innerHTML = `<tr><td colspan="8" class="text-muted text-center py-3">Geen afwijkende betalingen voor deze selectie.</td></tr>`;
          return;
        }
        tbody.innerHTML = rows
          .map(
            (r) => `<tr>
                <td>${escapeHtml(String(r.booking))}</td>
                <td>${escapeHtml(String(r.traveller))}</td>
                <td>${escapeHtml(String(r.ptype))}</td>
                <td>${escapeHtml(String(r.status))}</td>
                <td class="text-end">${nfMoney.format(n(r.bedrag))}</td>
                <td class="text-end">${nfMoney.format(n(r.open))}</td>
                <td>${escapeHtml(String(r.vertrek))}</td>
                <td>${escapeHtml(String(r.factuur))}</td>
              </tr>`,
          )
          .join("");
      };
      if (tbody && tblOut) {
        const bad = tr.filter((t) => paymentTravellerInOpmerkingTabel(t));
        bad.sort((a, b) => String(b.departure_date ?? "").localeCompare(String(a.departure_date ?? "")));
        if (!bad.length) {
          financePayOutstandingRows = [];
          renderOutstandingRows([]);
        } else {
          financePayOutstandingRows = bad.map((t) => {
            const boekingRef = String(t.order_nummer ?? t.booking_id ?? "—");
            return {
              booking: boekingRef,
              traveller: travellerDisplayName(t),
              ptype: paymentTypeLabel(t),
              status: String(t.betaling_status ?? "—"),
              bedrag: numField(t.totaal_te_betalen),
              open: numField(t.nog_te_betalen),
              vertrek:
                (window.TADate &&
                  window.TADate.formatDate &&
                  window.TADate.formatDate(String(t.departure_date ?? "").slice(0, 10), "—")) ||
                "—",
              factuur:
                (window.TADate &&
                  window.TADate.formatDate &&
                  window.TADate.formatDate(String(t.invoice_date ?? "").slice(0, 10), "—")) ||
                "—",
            };
          });
          renderOutstandingRows(financePayOutstandingRows);
          if (wireOut) {
            wireOut(tblOut, () => financePayOutstandingRows.slice(), (sorted) => {
              financePayOutstandingRows = sorted;
              renderOutstandingRows(sorted);
            });
          }
        }
      }
    },
  };

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** Volgorde datasets: combi → reis → annulatie → geen (zelfde als legenda). */
  const INS_CHART_ORDER = /** @type {const} */ (["combi", "travel", "annul", "none"]);
  const INS_CHART_LABELS = /** @type {const} */ (["Combi", "Reis", "Annulatie", "Geen"]);

  /**
   * Zorg dat alle bestemmingen leesbaar blijven in de horizontale stacked chart.
   * Hoogte schaalt mee met aantal labels.
   * @param {number} count
   */
  function setInsuranceDestChartHeight(count) {
    const wrap = document.querySelector("#finInsuranceSection .finance-chart-wrap--ins-dest");
    if (!wrap) return;
    const rows = Math.max(1, Number(count) || 1);
    const heightPx = Math.max(560, Math.min(1400, 140 + rows * 30));
    wrap.style.height = `${heightPx}px`;
    wrap.style.minHeight = `${heightPx}px`;
  }

  /** Sorteerbare rijen: verzekeringen financieel overzicht. */
  let financeInsFinRows = /** @type {Record<string, unknown>[]} */ ([]);
  let financeOthExcTopRows = /** @type {Record<string, unknown>[]} */ ([]);
  let financeOthInsTypeRows = /** @type {Record<string, unknown>[]} */ ([]);
  let financeOthTaxCleanRowsClean = /** @type {Record<string, unknown>[]} */ ([]);
  let financeOthTaxCleanRowsTax = /** @type {Record<string, unknown>[]} */ ([]);
  let financeOthJvRows = /** @type {Record<string, unknown>[]} */ ([]);
  let financeDiscountCodeRows = /** @type {Record<string, unknown>[]} */ ([]);
  let financeDiscountBookingRows = /** @type {Record<string, unknown>[]} */ ([]);

  /**
   * @param {string} stackId
   * @param {(key: "combi" | "travel" | "annul" | "none") => number[]} pctRowFn
   */
  function insuranceStackedPctDatasets(stackId, pctRowFn) {
    return INS_CHART_ORDER.map((key, i) => ({
      label: INS_CHART_LABELS[i],
      data: pctRowFn(/** @type {"combi" | "travel" | "annul" | "none"} */ (key)),
      stack: stackId,
      backgroundColor: COL_INS[key],
      borderRadius: 0,
      borderSkipped: false,
    }));
  }

  const InsuranceSection = {
    /** @param {ReturnType<typeof buildAggregates>} agg */
    render(agg) {
      const m = agg.mCur;
      const setTxt = (id, t) => {
        const el = document.getElementById(id);
        if (el) el.textContent = t;
      };
      const setHtml = (id, h) => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = h;
      };
      // Per-kolom-tellingen mogen overlappen (één reiziger met reis- én annulpolis telt
      // tweemaal). De noemer voor de KPI-percentages is dus 'unieke reizigers' = som van de
      // mutex-buckets, niet de overlappende tellingen uit `insCounts`.
      const exclusive = m.insCountsExclusive || m.insCounts;
      const totalTravellers =
        exclusive.travel + exclusive.annul + exclusive.combi + exclusive.none;
      const pctOfSel = (count) => (totalTravellers ? count / totalTravellers : 0);

      setTxt("finInsTravel", nfInt.format(m.insCounts.travel));
      setTxt("finInsTravelPct", `${nfPct.format(pctOfSel(m.insCounts.travel))} van totaal reizigers`);
      setTxt("finInsAnnul", nfInt.format(m.insCounts.annul));
      setTxt("finInsAnnulPct", `${nfPct.format(pctOfSel(m.insCounts.annul))} van totaal reizigers`);
      setTxt("finInsCombi", nfInt.format(m.insCounts.combi));
      setTxt("finInsCombiPct", `${nfPct.format(pctOfSel(m.insCounts.combi))} van totaal reizigers`);
      setTxt("finInsUptake", nfPct.format(m.uptake));
      setTxt("finInsNone", nfPct.format(m.pctNoIns));

      // Toon waarschuwing bij verdacht lage uptake (data-gap in bron-Excel),
      // zodat de gebruiker weet dat de cijfers niet door een berekeningsfout komen
      // maar door ontbrekende verzekeringsdata in de upload.
      const dataGapEl = document.getElementById("finInsDataGapNotice");
      if (dataGapEl) {
        const dataGapText = document.getElementById("finInsDataGapNoticeText");
        const lowUptake = totalTravellers >= 50 && m.uptake < 0.02;
        if (lowUptake) {
          if (dataGapText) {
            dataGapText.textContent =
              ` Slechts ${nfPct.format(m.uptake)} van ${nfInt.format(totalTravellers)} reizigers heeft een verzekeringsbedrag (>0).`;
          }
          dataGapEl.classList.remove("d-none");
        } else {
          dataGapEl.classList.add("d-none");
        }
      }

      // Tellingen kunnen overlappen (reiziger met reis- én annulpolis), dus tonen we per
      // type 'aandeel van totaal reizigers'; de som mag boven uptake liggen.
      const brUp = `<div class="finance-ins-uptake-br__line"><span class="text-muted">per type (overlap mogelijk)</span></div>
        <div class="finance-ins-uptake-br__line"><strong class="finance-ins-uptake-br__pct">${nfPct.format(
          pctOfSel(m.insCounts.combi),
        )}</strong> combi · <strong class="finance-ins-uptake-br__pct">${nfPct.format(
          pctOfSel(m.insCounts.annul),
        )}</strong> annulatie · <strong class="finance-ins-uptake-br__pct">${nfPct.format(
          pctOfSel(m.insCounts.travel),
        )}</strong> reis</div>`;
      setHtml("finInsUptakeBreakdown", totalTravellers > 0 ? brUp : "");

      const has = agg.cur.length > 0;

      const renderInsFinBody = (rows) => {
        const body = document.getElementById("finInsFinTableBody");
        if (!body) return;
        if (!rows.length) {
          body.innerHTML = `<tr><td colspan="5" class="text-muted text-center py-3">Geen gegevens voor deze selectie.</td></tr>`;
          return;
        }
        body.innerHTML = rows
          .map((row) => {
            const wv = n(row.omzet) * INSURANCE_PROFIT_RATE;
            const sh = n(row.share);
            return `<tr>
            <td>${escapeHtml(String(row.type))}</td>
            <td class="text-end">${nfMoney.format(n(row.omzet))}</td>
            <td class="text-end ${spProfitClass(wv)}">${nfMoney.format(wv)}</td>
            <td class="text-end">${nfInt.format(n(row.pax))}</td>
            <td class="text-end">${nfPct.format(sh)}</td>
          </tr>`;
          })
          .join("");
        const totalOmzet = rows.reduce((sum, row) => sum + n(row.omzet), 0);
        const totalWinst = rows.reduce((sum, row) => sum + n(row.winst), 0);
        const totalPax = rows.reduce((sum, row) => sum + n(row.pax), 0);
        const totalShare = rows.reduce((sum, row) => sum + n(row.share), 0);
        body.insertAdjacentHTML(
          "beforeend",
          `<tr class="finance-table-total-row">
            <td>Totaal</td>
            <td class="text-end">${nfMoney.format(totalOmzet)}</td>
            <td class="text-end ${spProfitClass(totalWinst)}">${nfMoney.format(totalWinst)}</td>
            <td class="text-end">${nfInt.format(totalPax)}</td>
            <td class="text-end">${nfPct.format(totalShare)}</td>
          </tr>`,
        );
      };

      if (!has) {
        financeInsFinRows = [];
        renderInsFinBody([]);
      } else {
        const trav = filterTravellersForBookings(PAYMENT_TRAVELLERS, agg.cur);
        const travProfit = filterTravellersForBookings(PAYMENT_TRAVELLERS, agg.curProfit || []);
        // Per-kolom: een reiziger met zowel reis- als annulpolis draagt aan beide types bij.
        // Daardoor is `share = pax / trav.length` géén percentage van een mutex-bucket maar
        // van de totaal-reizigers; sommatie kan boven 100% uitkomen wanneer er overlap is.
        // Dat is consistent met de KPI-cards en met wat de bron-Excel zelf rapporteert.
        const sumWhenPos = (rows, field) =>
          rows.reduce((s, t) => {
            const v = numField(t[field]);
            return s + (v > 0 ? v : 0);
          }, 0);
        const countWhenPos = (rows, field) =>
          rows.reduce((s, t) => s + (numField(t[field]) > 0 ? 1 : 0), 0);
        const finByType = [
          {
            type: "Combi",
            omzet: sumWhenPos(trav, "prijs_annulatie_en_reisverzekering"),
            winst: sumWhenPos(travProfit, "prijs_annulatie_en_reisverzekering"),
            pax: countWhenPos(trav, "prijs_annulatie_en_reisverzekering"),
          },
          {
            type: "Reisverzekering",
            omzet: sumWhenPos(trav, "prijs_reisverzekering"),
            winst: sumWhenPos(travProfit, "prijs_reisverzekering"),
            pax: countWhenPos(trav, "prijs_reisverzekering"),
          },
          {
            type: "Annuleringsverzekering",
            omzet: sumWhenPos(trav, "prijs_annulatieverzekering"),
            winst: sumWhenPos(travProfit, "prijs_annulatieverzekering"),
            pax: countWhenPos(trav, "prijs_annulatieverzekering"),
          },
        ];
        financeInsFinRows = finByType.map((r) => ({
          type: r.type,
          omzet: r.omzet,
          winst: r.winst * INSURANCE_PROFIT_RATE,
          pax: r.pax,
          share: trav.length > 0 ? r.pax / trav.length : 0,
        }));
        renderInsFinBody(financeInsFinRows);
        const tblInsFin = document.getElementById("finInsFinTable");
        const wireIns = typeof globalThis.TA_wireSortableTable === "function" ? globalThis.TA_wireSortableTable : null;
        if (tblInsFin && wireIns && financeInsFinRows.length) {
          wireIns(tblInsFin, () => financeInsFinRows.slice(), (sorted) => {
            financeInsFinRows = sorted;
            renderInsFinBody(sorted);
          });
        }
      }
      const showEmpty = (id, show) => {
        const e = document.getElementById(id);
        if (e) e.classList.toggle("d-none", !show);
      };
      showEmpty("finEmptyInsBrand", !has);
      showEmpty("finEmptyInsDest", !has);
      showEmpty("finEmptyInsDonut", !has);

      const brandKeys = INS_BRAND_CHART_LABELS;
      const pctAxis = {
        min: 0,
        max: 100,
        ticks: {
          ...chartGrid.y.ticks,
          callback: (/** @type {string | number} */ v) => nfPct.format(Number(v) / 100),
        },
      };
      const pctAxisX = {
        min: 0,
        max: 100,
        ticks: {
          ...chartGrid.x.ticks,
          callback: (/** @type {string | number} */ v) => nfPct.format(Number(v) / 100),
        },
      };

      destroyChart("finChartInsBrand");
      if (has) {
        const ctx = document.getElementById("finChartInsBrand");
        if (ctx) {
          charts.finChartInsBrand = new Chart(ctx.getContext("2d"), {
            type: "bar",
            data: {
              labels: brandKeys,
              datasets: insuranceStackedPctDatasets("ins", (key) =>
                brandKeys.map((bk) => insuranceStackToPct100(agg.insStackBrand[bk])[key]),
              ),
            },
            options: {
              ...ChartMixins.defaults,
              interaction: { mode: "nearest", intersect: true },
              hover: { mode: "nearest", intersect: true },
              scales: {
                x: { ...chartGrid.x, stacked: true },
                y: { ...chartGrid.y, stacked: true, ...pctAxis },
              },
              plugins: {
                ...ChartMixins.defaults.plugins,
                tooltip: {
                  ...ChartMixins.defaults.plugins.tooltip,
                  mode: "nearest",
                  intersect: true,
                  callbacks: {
                    ...ChartMixins.defaults.plugins.tooltip.callbacks,
                    title(items) {
                      const l = items[0]?.label;
                      return l != null && String(l) !== "" ? String(l) : "";
                    },
                    label(ctx) {
                      const idx = ctx.dataIndex;
                      const dsIdx = ctx.datasetIndex;
                      const bk = brandKeys[idx];
                      const stack = agg.insStackBrand[bk];
                      const key = INS_CHART_ORDER[dsIdx];
                      const abs = stack[key];
                      const tot = insuranceStackTotal(stack);
                      const share = tot > 0 ? abs / tot : 0;
                      return [
                        INS_CHART_LABELS[dsIdx],
                        `${nfInt.format(abs)} reizigers`,
                        nfPct.format(share),
                      ];
                    },
                  },
                },
              },
            },
          });
        }
      }

      const destSorted = Object.entries(agg.insStackDest)
        .map(([k, v]) => ({ k, t: insuranceStackTotal(v) }))
        .sort((a, b) => b.t - a.t);
      const dests = destSorted.map((x) => x.k);
      setInsuranceDestChartHeight(dests.length);
      destroyChart("finChartInsDest");
      if (has && dests.length) {
        const ctx = document.getElementById("finChartInsDest");
        if (ctx) {
          charts.finChartInsDest = new Chart(ctx.getContext("2d"), {
            type: "bar",
            data: {
              labels: dests,
              datasets: insuranceStackedPctDatasets("insd", (key) =>
                dests.map((d) => insuranceStackToPct100(agg.insStackDest[d])[key]),
              ),
            },
            options: {
              ...ChartMixins.defaults,
              indexAxis: "y",
              interaction: { mode: "nearest", intersect: true },
              hover: { mode: "nearest", intersect: true },
              scales: {
                x: { ...chartGrid.x, stacked: true, ...pctAxisX },
                y: {
                  ...chartGrid.y,
                  stacked: true,
                  ticks: {
                    ...(chartGrid.y?.ticks || {}),
                    autoSkip: false,
                  },
                },
              },
              plugins: {
                ...ChartMixins.defaults.plugins,
                tooltip: {
                  ...ChartMixins.defaults.plugins.tooltip,
                  mode: "nearest",
                  intersect: true,
                  callbacks: {
                    ...ChartMixins.defaults.plugins.tooltip.callbacks,
                    title(items) {
                      const l = items[0]?.label;
                      return l != null && String(l) !== "" ? String(l) : "";
                    },
                    label(ctx) {
                      const idx = ctx.dataIndex;
                      const dsIdx = ctx.datasetIndex;
                      const dk = dests[idx];
                      const stack = agg.insStackDest[dk];
                      const key = INS_CHART_ORDER[dsIdx];
                      const abs = stack[key];
                      const tot = insuranceStackTotal(stack);
                      const share = tot > 0 ? abs / tot : 0;
                      return [
                        INS_CHART_LABELS[dsIdx],
                        `${nfInt.format(abs)} reizigers`,
                        nfPct.format(share),
                      ];
                    },
                  },
                },
              },
            },
          });
        }
      }

      destroyChart("finChartInsDonut");
      if (has) {
        const ctx = document.getElementById("finChartInsDonut");
        if (ctx) {
          // Donut wil dat de 4 segmenten samen 100% van de reizigers zijn → mutex-telling.
          const donutCounts = m.insCountsExclusive || m.insCounts;
          const donutData = [donutCounts.combi, donutCounts.travel, donutCounts.annul, donutCounts.none];
          const donutBg = [COL_INS.combi, COL_INS.travel, COL_INS.annul, COL_INS.none];
          charts.finChartInsDonut = new Chart(ctx.getContext("2d"), {
            type: "doughnut",
            data: {
              labels: ["Combi", "Reis", "Annulatie", "Geen"],
              datasets: [{ data: donutData, backgroundColor: donutBg, borderWidth: 0 }],
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              animation: ChartMixins.defaults.animation,
              plugins: {
                legend: {
                  position: "bottom",
                  labels: ChartMixins.defaults.plugins.legend.labels,
                },
                tooltip: {
                  ...ChartMixins.defaults.plugins.tooltip,
                  callbacks: {
                    ...ChartMixins.defaults.plugins.tooltip.callbacks,
                    label(ctx) {
                      const v = n(ctx.raw);
                      const total = ctx.dataset.data.reduce((a, b) => n(a) + n(b), 0) || 1;
                      const pct = v / total;
                      return `${ctx.label}: ${nfInt.format(v)} (${nfPct.format(pct)} van reizigers in selectie)`;
                    },
                  },
                },
              },
            },
          });
        }
      }
    },
  };

  const OTH_EXC_PAGE_SIZE = 8;

  const OtherRevenuesSection = {
    _excPage: 0,
    _excSortKey: "omzet",
    _excSortDir: -1,
    _othSortInited: false,
    /** @type {ReturnType<typeof buildAggregates> | null} */
    _lastAgg: null,
    _inited: false,
    resetPaging() {
      this._excPage = 0;
    },
    init() {
      if (this._inited) return;
      this._inited = true;
      document.getElementById("finOthExcPagePrev")?.addEventListener("click", () => {
        if (this._excPage > 0) {
          this._excPage -= 1;
          if (this._lastAgg) this.render(this._lastAgg);
        }
      });
      document.getElementById("finOthExcPageNext")?.addEventListener("click", () => {
        this._excPage += 1;
        if (this._lastAgg) this.render(this._lastAgg);
      });
      if (!this._othSortInited) {
        this._othSortInited = true;
        document.querySelectorAll("#finOthExcTopTable thead [data-sort]").forEach((th) => {
          th.addEventListener("click", () => {
            const key = String(th.getAttribute("data-sort") || "").trim();
            if (!key) return;
            if (this._excSortKey === key) this._excSortDir *= -1;
            else {
              this._excSortKey = key;
              this._excSortDir = key === "label" ? 1 : -1;
            }
            this._excPage = 0;
            if (this._lastAgg) this.render(this._lastAgg);
          });
        });
      }
      document.getElementById("finOthJvBody")?.addEventListener("click", (ev) => {
        const btn = ev.target.closest("button[data-jv-save='1']");
        if (!btn) return;
        const bookingId = String(btn.getAttribute("data-booking-id") || "").trim();
        if (!bookingId) return;
        const input = document.querySelector(`input[data-jv-cost-input='${bookingId}']`);
        if (!input) return;
        const raw = String(input.value ?? "").trim();
        if (!raw) {
          showFinanceError("Vul een geldige kost in.");
          return;
        }
        const parsed = numField(raw);
        if (!Number.isFinite(parsed) || parsed < 0) {
          showFinanceError("Kost moet een geldig bedrag >= 0 zijn.");
          return;
        }
        clearFinanceError();
        btn.disabled = true;
        const oldText = btn.textContent;
        btn.textContent = "Opslaan...";
        void saveJouwVerblijfKost(bookingId, parsed)
          .catch((e) => showFinanceError(e instanceof Error ? e.message : String(e)))
          .finally(() => {
            btn.disabled = false;
            btn.textContent = oldText || "Opslaan";
          });
      });
    },
    /**
     * @param {ReturnType<typeof buildAggregates>} agg
     */
    render(agg) {
      this._lastAgg = agg;
      this.init();
      const bookRows = agg.cur;
      const profitBookRows = agg.curProfit || [];
      const dash = "—";
      const lines = filterExcursionLinesForBookings(EXCURSION_LINES_RAW, bookRows);
      const linesProfit = filterExcursionLinesForBookings(EXCURSION_LINES_RAW, profitBookRows);
      const hasSelection = bookRows.length > 0;

      const setText = (id, t) => {
        const el = document.getElementById(id);
        if (el) el.textContent = t;
      };
      const setHtml = (id, h) => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = h;
      };

      const badge = document.getElementById("finOthExcSourceBadge");
      const note = document.getElementById("finOthExcFallbackNote");
      const pageInfo = document.getElementById("finOthExcPageInfo");
      const prevBtn = document.getElementById("finOthExcPagePrev");
      const nextBtn = document.getElementById("finOthExcPageNext");

      if (!hasSelection) {
        [
          "finOthExcOmzet",
          "finOthExcWinst",
          "finOthExcMarge",
          "finOthExcLines",
          "finOthExcPctPax",
          "finOthExcAvgPaxSpend",
          "finOthInsOmzet",
          "finOthInsWinst",
          "finOthInsMarge",
          "finOthInsSold",
          "finOthInsBookings",
          "finOthInsAvg",
          "finOthTaxCleanTotalClean",
          "finOthTaxCleanBookings",
          "finOthTaxCleanAvgClean",
          "finOthTaxCleanShareClean",
          "finOthTaxCleanTotalTax",
          "finOthTaxCleanTravellers",
          "finOthTaxCleanAvgTax",
          "finOthTaxCleanShareTax",
          "finOthTaxCleanCombinedTotal",
          "finOthTaxCleanCombinedShare",
          "finOthJvOmzet",
          "finOthJvKost",
          "finOthJvWinst",
          "finOthJvMarge",
          "finOthJvCount",
          "finOthJvExcluded",
        ].forEach((id) => setText(id, dash));
        setText("finOthExcPctPaxSub", "");
        setText("finOthInsSoldSub", "");
        setText("finOthInsBookingsSub", "");
        if (badge) badge.textContent = "Geen selectie";
        if (note) {
          note.textContent = "";
          note.classList.add("d-none");
        }
        if (pageInfo) pageInfo.textContent = "";
        if (prevBtn) prevBtn.disabled = true;
        if (nextBtn) nextBtn.disabled = true;
        financeOthExcTopRows = [];
        financeOthInsTypeRows = [];
        financeOthTaxCleanRowsClean = [];
        financeOthTaxCleanRowsTax = [];
        financeOthJvRows = [];
        setHtml("finOthExcTopBody", `<tr><td colspan="4" class="text-muted text-center py-3">Geen gegevens voor deze filters.</td></tr>`);
        setHtml("finOthInsTypeBody", `<tr><td colspan="5" class="text-muted text-center py-3">Geen gegevens voor deze filters.</td></tr>`);
        setHtml("finOthTaxCleanBodyCleanByDest", `<tr><td colspan="5" class="text-muted text-center py-3">Geen gegevens voor deze filters.</td></tr>`);
        setHtml("finOthTaxCleanBodyTaxByDest", `<tr><td colspan="5" class="text-muted text-center py-3">Geen gegevens voor deze filters.</td></tr>`);
        setHtml("finOthJvBody", `<tr><td colspan="7" class="text-muted text-center py-3">Geen gegevens voor deze filters.</td></tr>`);
        const wEl = document.getElementById("finOthExcWinst");
        if (wEl) wEl.classList.remove("sp-text--pos", "sp-text--neg", "sp-text--neutral");
        const wi = document.getElementById("finOthInsWinst");
        if (wi) wi.classList.remove("sp-text--pos", "sp-text--neg", "sp-text--neutral");
        const emptyState = document.getElementById("finOthTaxCleanEmptyState");
        if (emptyState) emptyState.classList.add("d-none");
        return;
      }

      const useLines = lines.length > 0;
      if (badge) {
        badge.textContent = "";
        badge.classList.add("d-none");
      }

      let omzetExc = 0;
      let winstExc = 0;
      let winstKnown = true;

      if (useLines) {
        for (const r of lines) {
          omzetExc += numField(r.verkoop_prijs);
        }
        for (const r of linesProfit) {
          winstExc += excursionLineProfitFromRow(r);
        }
      } else {
        for (const b of bookRows) {
          omzetExc += excursionRevenueFromBooking(b);
        }
        winstKnown = false;
        winstExc = 0;
      }

      /** @type {Record<string, { omzet: number, winst: number, labelDisp: string }>} */
      const byAgg = {};
      if (useLines) {
        for (const r of lines) {
          const nm = String(r.excursie_naam ?? "").trim() || "(onbekend)";
          const dest = String(r.destination ?? r.bestemming_naam ?? "").trim();
          const key = `${nm}\u0001${dest}`;
          const labelDisp = dest ? `${nm} – ${dest}` : nm;
          if (!byAgg[key]) byAgg[key] = { omzet: 0, winst: 0, labelDisp };
          byAgg[key].omzet += numField(r.verkoop_prijs);
        }
        for (const r of linesProfit) {
          const nm = String(r.excursie_naam ?? "").trim() || "(onbekend)";
          const dest = String(r.destination ?? r.bestemming_naam ?? "").trim();
          const key = `${nm}\u0001${dest}`;
          const labelDisp = dest ? `${nm} – ${dest}` : nm;
          if (!byAgg[key]) byAgg[key] = { omzet: 0, winst: 0, labelDisp };
          byAgg[key].winst += excursionLineProfitFromRow(r);
        }
      }

      // Gemiddeld commissiepercentage (gewogen): totale commissie-opbrengst / totale excursie-omzet.
      // Dit voorkomt vertekening door kleine excursies even zwaar te laten tellen als grote.
      const avgCommissionPctExc = useLines && omzetExc > 0.01 ? winstExc / omzetExc : null;

      const nLines = useLines ? lines.length : 0;
      const bookingIdsWithExc = new Set(
        useLines
          ? lines.map((r) => String(r.booking_id ?? "").trim()).filter(Boolean)
          : bookRows.filter((b) => excursionRevenueFromBooking(b) > 0.01).map((b) => String(b.booking_id ?? "").trim()).filter(Boolean),
      );
      const totalPaxSel = bookRows.reduce((s, b) => s + n(b.pax), 0);
      let paxWithExc = 0;
      for (const b of bookRows) {
        const bid = String(b.booking_id ?? "").trim();
        if (bid && bookingIdsWithExc.has(bid)) paxWithExc += n(b.pax);
      }

      setText("finOthExcOmzet", nfMoney.format(omzetExc));
      const wExc = document.getElementById("finOthExcWinst");
      if (wExc) {
        wExc.classList.remove("sp-text--pos", "sp-text--neg", "sp-text--neutral");
        if (winstKnown) {
          wExc.textContent = nfMoney.format(winstExc);
          const c = spProfitClass(winstExc);
          if (c) wExc.classList.add(c);
        } else {
          wExc.textContent = dash;
        }
      }
      setText(
        "finOthExcMarge",
        avgCommissionPctExc != null && Number.isFinite(avgCommissionPctExc) ? nfPctMargin2.format(avgCommissionPctExc) : dash,
      );
      setText("finOthExcLines", useLines ? nfInt.format(nLines) : dash);
      setText("finOthExcPctPax", totalPaxSel > 0 ? nfPct.format(paxWithExc / totalPaxSel) : dash);
      setText(
        "finOthExcPctPaxSub",
        totalPaxSel > 0 ? `${nfInt.format(paxWithExc)} van ${nfInt.format(totalPaxSel)} reizigers` : "",
      );
      setText("finOthExcAvgPaxSpend", totalPaxSel > 0 ? nfMoney.format(omzetExc / totalPaxSel) : dash);

      if (note) {
        if (!useLines && omzetExc > 0.01) {
          note.textContent =
            "Geen excursie-detail uit Excursies geladen: omzet volgt boekingsdata (excursie_prijs / Excel-totaal). Winst en verdeling per excursie vereisen gegevens uit Excursies.";
          note.classList.remove("d-none");
        } else if (!useLines && omzetExc <= 0.01) {
          note.textContent =
            "Geen excursiegegevens beschikbaar of geen excursie-omzet in deze selectie. Controleer of /excursies/data bereikbaar is.";
          note.classList.remove("d-none");
        } else {
          note.textContent = "";
          note.classList.add("d-none");
        }
      }

      const renderOthExcTopBody = (rows) => {
        setHtml(
          "finOthExcTopBody",
          rows.length
            ? rows
                .map(
                  (t) => `<tr>
              <td>${escapeHtml(String(t.label))}</td>
              <td class="text-end">${nfMoney.format(n(t.omzet))}</td>
              <td class="text-end ${spProfitClass(t.winst)}">${nfMoney.format(n(t.winst))}</td>
              <td class="text-end">${t.marge != null && Number.isFinite(Number(t.marge)) ? nfPctMargin2.format(Number(t.marge)) : dash}</td>
            </tr>`,
                )
                .join("")
            : `<tr><td colspan="4" class="text-muted text-center py-3">Geen excursies in deze selectie.</td></tr>`,
        );
      };

      if (useLines) {
        const allTop = Object.values(byAgg)
          .map((v) => ({
            label: v.labelDisp,
            omzet: v.omzet,
            winst: v.winst,
            marge: v.omzet > 0.01 ? v.winst / v.omzet : null,
            margeSort: v.omzet > 0.01 ? v.winst / v.omzet : Number.NEGATIVE_INFINITY,
          }));
        const sortKey = this._excSortKey || "omzet";
        const sortDir = this._excSortDir || -1;
        allTop.sort((a, b) => {
          if (sortKey === "label") return String(a.label || "").localeCompare(String(b.label || ""), "nl", { sensitivity: "base" }) * sortDir;
          if (sortKey === "marge") return (n(a.margeSort) - n(b.margeSort)) * sortDir;
          return (n(a[sortKey]) - n(b[sortKey])) * sortDir;
        });
        const nTot = allTop.length;
        const totalPages = Math.max(1, Math.ceil(nTot / OTH_EXC_PAGE_SIZE) || 1);
        this._excPage = Math.max(0, Math.min(this._excPage, totalPages - 1));
        const start = this._excPage * OTH_EXC_PAGE_SIZE;
        const pageSlice = allTop.slice(start, start + OTH_EXC_PAGE_SIZE);
        if (pageInfo) {
          pageInfo.textContent =
            nTot > 0
              ? `${start + 1}–${Math.min(start + OTH_EXC_PAGE_SIZE, nTot)} van ${nTot} · pagina ${this._excPage + 1} / ${totalPages}`
              : "";
        }
        if (prevBtn) prevBtn.disabled = this._excPage <= 0;
        if (nextBtn) nextBtn.disabled = this._excPage >= totalPages - 1;
        financeOthExcTopRows = pageSlice.map((t) => ({
          label: t.label,
          omzet: t.omzet,
          winst: t.winst,
          marge: t.margeSort,
        }));
        renderOthExcTopBody(financeOthExcTopRows);
      } else {
        if (pageInfo) pageInfo.textContent = "";
        if (prevBtn) prevBtn.disabled = true;
        if (nextBtn) nextBtn.disabled = true;
        financeOthExcTopRows = [];
        setHtml(
          "finOthExcTopBody",
          `<tr><td colspan="4" class="text-muted text-center py-3">Detail per excursie vereist gegevens uit Excursies. Omzet op boekingsniveau: ${nfMoney.format(omzetExc)}.</td></tr>`,
        );
      }

      const trav = filterTravellersForBookings(PAYMENT_TRAVELLERS, bookRows);
      const travProfit = filterTravellersForBookings(PAYMENT_TRAVELLERS, profitBookRows);
      const insM = insuranceMetricsFromTravellers(trav);
      const insOmzet = insM.insRev;
      const insWinst = insuranceMetricsFromTravellers(travProfit).insRev * INSURANCE_PROFIT_RATE;
      const insMarge = insOmzet > 0.01 ? insWinst / insOmzet : null;
      const insSold = insM.insCounts.travel + insM.insCounts.annul + insM.insCounts.combi;
      const bookingSet = new Set(bookRows.map((b) => String(b.booking_id ?? "").trim()).filter(Boolean));
      let insBookings = 0;
      for (const bid of bookingSet) {
        const has = trav.some((t) => String(t.booking_id ?? "").trim() === bid && travellerInsuranceType(t) !== "none");
        if (has) insBookings += 1;
      }
      const insAvg = insSold > 0 ? insOmzet / insSold : null;
      const nTrav = trav.length;
      const nBookTot = bookRows.length;

      setText("finOthInsOmzet", nfMoney.format(insOmzet));
      const wIns = document.getElementById("finOthInsWinst");
      if (wIns) {
        wIns.classList.remove("sp-text--pos", "sp-text--neg", "sp-text--neutral");
        wIns.textContent = nfMoney.format(insWinst);
        const c = spProfitClass(insWinst);
        if (c) wIns.classList.add(c);
      }
      setText("finOthInsMarge", insMarge != null && Number.isFinite(insMarge) ? nfPctMargin2.format(insMarge) : dash);
      setText("finOthInsSold", nfInt.format(insSold));
      setText("finOthInsBookings", nfInt.format(insBookings));
      setText("finOthInsAvg", insAvg != null && Number.isFinite(insAvg) ? nfMoney.format(insAvg) : dash);
      setText("finOthInsSoldSub", nTrav > 0 ? `${nfPct.format(insSold / nTrav)} van totaal reizigers` : "");
      setText("finOthInsBookingsSub", nBookTot > 0 ? `${nfPct.format(insBookings / nBookTot)} van totaal boekingen` : "");

      // Per kolom (overlap toegestaan): elke verzekeringsprijs > 0 telt als verkochte polis,
      // ook wanneer dezelfde reiziger ook een ander type polis heeft. Dat sluit aan bij de
      // KPI-cards op de Verzekeringen-tab en bij de bron-Excel-tellingen.
      const tb = {
        travel: { rev: 0, n: 0 },
        annul: { rev: 0, n: 0 },
        combi: { rev: 0, n: 0 },
      };
      for (const t of trav) {
        const travelPrijs = numField(t.prijs_reisverzekering);
        const annulPrijs = numField(t.prijs_annulatieverzekering);
        const combiPrijs = numField(t.prijs_annulatie_en_reisverzekering);
        if (travelPrijs > 0) {
          tb.travel.rev += travelPrijs;
          tb.travel.n += 1;
        }
        if (annulPrijs > 0) {
          tb.annul.rev += annulPrijs;
          tb.annul.n += 1;
        }
        if (combiPrijs > 0) {
          tb.combi.rev += combiPrijs;
          tb.combi.n += 1;
        }
      }
      const typeRows = [
        { label: "Reisverzekering", rev: tb.travel.rev, n: tb.travel.n },
        { label: "Annuleringsverzekering", rev: tb.annul.rev, n: tb.annul.n },
        { label: "Combi", rev: tb.combi.rev, n: tb.combi.n },
      ];
      const renderOthInsTypeBody = (rows) => {
        setHtml(
          "finOthInsTypeBody",
          rows
            .map((row) => {
              const w = n(row.rev) * INSURANCE_PROFIT_RATE;
              const sh = n(row.share);
              return `<tr>
            <td>${escapeHtml(String(row.label))}</td>
            <td class="text-end">${nfMoney.format(n(row.rev))}</td>
            <td class="text-end ${spProfitClass(w)}">${nfMoney.format(w)}</td>
            <td class="text-end">${nfInt.format(n(row.n))}</td>
            <td class="text-end">${nfPct.format(sh)}</td>
          </tr>`;
            })
            .join(""),
        );
      };
      financeOthInsTypeRows = typeRows.map((row) => ({
        label: row.label,
        rev: row.rev,
        winst: row.rev * INSURANCE_PROFIT_RATE,
        n: row.n,
        share: nTrav > 0 ? row.n / nTrav : 0,
      }));
      renderOthInsTypeBody(financeOthInsTypeRows);
      const insTypTbl = document.getElementById("finOthInsTypeTable");
      const wireInsTyp = typeof globalThis.TA_wireSortableTable === "function" ? globalThis.TA_wireSortableTable : null;
      if (insTypTbl && wireInsTyp && financeOthInsTypeRows.length) {
        wireInsTyp(insTypTbl, () => financeOthInsTypeRows.slice(), (sorted) => {
          financeOthInsTypeRows = sorted;
          renderOthInsTypeBody(sorted);
        });
      }

      const totalWinstForShare = n(agg?.mCur?.winstTotal);
      const asShare = (amount) => (totalWinstForShare > 0.01 ? amount / totalWinstForShare : 0);
      const taxTrav = filterTravellersForBookings(PAYMENT_TRAVELLERS, bookRows);

      let cleanTotal = 0;
      let cleanBookings = 0;
      /** @type {Record<string, { destination: string, bookings: number, total: number }>} */
      const cleanByDest = {};
      for (const b of bookRows) {
        const clean = numField(b.schoonmaakkosten_te_betalen);
        if (clean <= 0.01) continue;
        cleanTotal += clean;
        cleanBookings += 1;
        const destination = String(destKey(b) || "(onbekend)");
        if (!cleanByDest[destination]) cleanByDest[destination] = { destination, bookings: 0, total: 0 };
        cleanByDest[destination].bookings += 1;
        cleanByDest[destination].total += clean;
      }

      let taxTotal = 0;
      let taxTravellers = 0;
      /** @type {Record<string, { destination: string, travellers: number, total: number }>} */
      const taxByDest = {};
      for (const t of taxTrav) {
        const tax = numField(t.toeristenbelasting_te_betalen);
        if (tax <= 0.01) continue;
        taxTotal += tax;
        taxTravellers += 1;
        const destination = String(t.destination ?? "(onbekend)").trim() || "(onbekend)";
        if (!taxByDest[destination]) taxByDest[destination] = { destination, travellers: 0, total: 0 };
        taxByDest[destination].travellers += 1;
        taxByDest[destination].total += tax;
      }

      const cleanAvg = cleanBookings > 0 ? cleanTotal / cleanBookings : null;
      const taxAvg = taxTravellers > 0 ? taxTotal / taxTravellers : null;
      const combinedTotal = cleanTotal + taxTotal;

      setText("finOthTaxCleanTotalClean", nfMoney.format(cleanTotal));
      setText("finOthTaxCleanBookings", nfInt.format(cleanBookings));
      setText("finOthTaxCleanAvgClean", cleanAvg != null && Number.isFinite(cleanAvg) ? nfMoney.format(cleanAvg) : dash);
      setText("finOthTaxCleanShareClean", nfPct.format(asShare(cleanTotal)));
      setText("finOthTaxCleanTotalTax", nfMoney.format(taxTotal));
      setText("finOthTaxCleanTravellers", nfInt.format(taxTravellers));
      setText("finOthTaxCleanAvgTax", taxAvg != null && Number.isFinite(taxAvg) ? nfMoney.format(taxAvg) : dash);
      setText("finOthTaxCleanShareTax", nfPct.format(asShare(taxTotal)));
      setText("finOthTaxCleanCombinedTotal", nfMoney.format(combinedTotal));
      setText("finOthTaxCleanCombinedShare", nfPct.format(asShare(combinedTotal)));

      const emptyState = document.getElementById("finOthTaxCleanEmptyState");
      if (emptyState) {
        if (cleanBookings === 0 && taxTravellers === 0) emptyState.classList.remove("d-none");
        else emptyState.classList.add("d-none");
      }

      const renderTaxCleanBody = (id, rows, emptyText, countField) => {
        setHtml(
          id,
          rows.length
            ? rows
                .map((r) => {
                  const avg = n(r.avg);
                  const share = n(r.share);
                  const count = n(r[countField]);
                  return `<tr>
            <td>${escapeHtml(String(r.destination))}</td>
            <td class="text-end">${nfInt.format(count)}</td>
            <td class="text-end">${nfMoney.format(n(r.total))}</td>
            <td class="text-end">${nfMoney.format(avg)}</td>
            <td class="text-end">${nfPct.format(share)}</td>
          </tr>`;
                })
                .join("")
            : `<tr><td colspan="5" class="text-muted text-center py-3">${escapeHtml(emptyText)}</td></tr>`,
        );
      };

      financeOthTaxCleanRowsClean = Object.values(cleanByDest)
        .map((row) => ({
          destination: row.destination,
          bookings: row.bookings,
          total: row.total,
          avg: row.bookings > 0 ? row.total / row.bookings : 0,
          share: asShare(row.total),
        }))
        .sort((a, b) => b.total - a.total);

      financeOthTaxCleanRowsTax = Object.values(taxByDest)
        .map((row) => ({
          destination: row.destination,
          travellers: row.travellers,
          total: row.total,
          avg: row.travellers > 0 ? row.total / row.travellers : 0,
          share: asShare(row.total),
        }))
        .sort((a, b) => b.total - a.total);

      renderTaxCleanBody(
        "finOthTaxCleanBodyCleanByDest",
        financeOthTaxCleanRowsClean,
        "Geen schoonmaakkosten in deze selectie.",
        "bookings",
      );
      renderTaxCleanBody(
        "finOthTaxCleanBodyTaxByDest",
        financeOthTaxCleanRowsTax,
        "Geen toeristenbelasting in deze selectie.",
        "travellers",
      );

      const wireTaxClean = typeof globalThis.TA_wireSortableTable === "function" ? globalThis.TA_wireSortableTable : null;
      const cleanTbl = document.getElementById("finOthTaxCleanTableCleanByDest");
      if (cleanTbl && wireTaxClean && financeOthTaxCleanRowsClean.length) {
        wireTaxClean(cleanTbl, () => financeOthTaxCleanRowsClean.slice(), (sorted) => {
          financeOthTaxCleanRowsClean = sorted;
          renderTaxCleanBody("finOthTaxCleanBodyCleanByDest", sorted, "Geen schoonmaakkosten in deze selectie.", "bookings");
        });
      }
      const taxTbl = document.getElementById("finOthTaxCleanTableTaxByDest");
      if (taxTbl && wireTaxClean && financeOthTaxCleanRowsTax.length) {
        wireTaxClean(taxTbl, () => financeOthTaxCleanRowsTax.slice(), (sorted) => {
          financeOthTaxCleanRowsTax = sorted;
          renderTaxCleanBody("finOthTaxCleanBodyTaxByDest", sorted, "Geen toeristenbelasting in deze selectie.", "travellers");
        });
      }

      const jvRows = bookRows
        .filter((b) => isJouwVerblijfBooking(/** @type {Record<string, unknown>} */ (b)))
        .map((b) => {
          const omzet = numField(b.totaal_te_betalen);
          const kost = bookingAccommodationCost(/** @type {Record<string, unknown>} */ (b));
          const excluded = isExcludedFromProfitCalculation(/** @type {Record<string, unknown>} */ (b));
          const winst = excluded ? 0 : omzet - kost;
          const bookingId = String(b.booking_id ?? "").trim();
          const order = String(b.order_nummer ?? "").trim() || bookingId || "—";
          const accommodatie = String(b.accommodatie_naam ?? "").trim() || "—";
          const pax = Math.max(0, Math.round(numField(b.pax)));
          return {
            bookingId,
            order,
            accommodatie,
            pax,
            omzet,
            kost,
            winst,
            excluded,
            // Kritiek: uitgesloten rijen blijven zichtbaar, maar tellen niet mee in winst.
            winstSort: excluded ? Number.NEGATIVE_INFINITY : winst,
            statusSort: excluded ? "Uitgesloten (kost = 0)" : "Inbegrepen",
          };
        })
        .sort((a, b) => a.order.localeCompare(b.order, "nl", { sensitivity: "base" }));

      const totalJvOmzet = jvRows.reduce((s, r) => s + r.omzet, 0);
      const totalJvKost = jvRows.reduce((s, r) => s + r.kost, 0);
      const totalJvWinst = jvRows.reduce((s, r) => s + r.winst, 0);
      const totalJvExcluded = jvRows.reduce((s, r) => s + (r.excluded ? 1 : 0), 0);
      const totalJvMarge = totalJvOmzet > 0.01 ? totalJvWinst / totalJvOmzet : null;

      setText("finOthJvOmzet", nfMoney.format(totalJvOmzet));
      setText("finOthJvKost", nfMoney.format(totalJvKost));
      setText("finOthJvWinst", nfMoney.format(totalJvWinst));
      setText("finOthJvMarge", totalJvMarge != null && Number.isFinite(totalJvMarge) ? nfPctMargin2.format(totalJvMarge) : dash);
      setText("finOthJvCount", nfInt.format(jvRows.length));
      setText("finOthJvExcluded", nfInt.format(totalJvExcluded));
      const renderJvBody = (rows) => {
        setHtml(
          "finOthJvBody",
          rows.length
            ? rows
                .map((r) => {
                  const status = r.excluded
                    ? `<span class="finance-status-pill finance-status-pill--excluded">Uitgesloten (kost = 0)</span>`
                    : `<span class="finance-status-pill finance-status-pill--included">Inbegrepen</span>`;
                  const winstText = r.excluded ? dash : nfMoney.format(n(r.winst));
                  const safeBookingId = escapeHtml(String(r.bookingId));
                  return `<tr>
            <td>${escapeHtml(String(r.order))}</td>
            <td>${escapeHtml(String(r.accommodatie))}</td>
            <td class="text-end">${nfInt.format(n(r.pax))}</td>
            <td class="text-end">${nfMoney.format(n(r.omzet))}</td>
            <td class="text-end fin-jv-cost-cell">
              <div class="fin-jv-cost-group">
                <input
                  type="text"
                  class="form-control form-control-sm text-end fin-jv-cost-input"
                  data-jv-cost-input="${safeBookingId}"
                  value="${String(n(r.kost).toFixed(2)).replace(".", ",")}"
                />
                <button type="button" class="btn btn-sm fin-jv-save-btn" data-jv-save="1" data-booking-id="${safeBookingId}">
                  Opslaan
                </button>
              </div>
            </td>
            <td class="text-end ${spProfitClass(n(r.winst))}">${winstText}</td>
            <td>${status}</td>
          </tr>`;
                })
                .join("")
            : `<tr><td colspan="7" class="text-muted text-center py-3">Geen boekingen met accommodatie "jouw verblijf in" in deze selectie.</td></tr>`,
        );
      };
      financeOthJvRows = jvRows.map((r) => ({ ...r }));
      renderJvBody(financeOthJvRows);
      const jvTbl = document.getElementById("finOthJvTable");
      const wireJv = typeof globalThis.TA_wireSortableTable === "function" ? globalThis.TA_wireSortableTable : null;
      if (jvTbl && wireJv && financeOthJvRows.length) {
        wireJv(jvTbl, () => financeOthJvRows.slice(), (sorted) => {
          financeOthJvRows = sorted;
          renderJvBody(sorted);
        });
      }
    },
  };

  const FIN_SUP_PAGE_SIZE = 15;

  function finSupRowKey(dest, lev) {
    return `${String(dest)}\u0001${String(lev)}`;
  }

  /**
   * Vertrekdatum als YYYY-MM-DD voor Leveranciers Van/Tot-filter (zelfde basis als getFinancialPerformanceDate).
   * @param {Record<string, unknown>} b
   */
  function finSupDepartureYmd(b) {
    const s = getFinancialPerformanceDate(/** @type {Record<string, unknown>} */ (b));
    if (!s || s.length < 10) return null;
    return s.slice(0, 10);
  }

  /** Zelfde boekingenpool als dashboard, met optioneel venster op vertrekdatum (periode waarin de reis doorgaat). */
  function finSupPoolDateOnly() {
    const from = (document.getElementById("finSupDateFrom")?.value || "").trim();
    const to = (document.getElementById("finSupDateTo")?.value || "").trim();
    return ACTIVE_POOL.filter((b) => {
      if (from || to) {
        const ymd = finSupDepartureYmd(b);
        if (!ymd) return false;
        if (from && ymd < from) return false;
        if (to && ymd > to) return false;
      }
      return true;
    });
  }

  function finSupBookingsForView() {
    const fd = (document.getElementById("finSupFilterDest")?.value || "").trim();
    const fl = (document.getElementById("finSupFilterLev")?.value || "").trim().toLowerCase();
    return finSupPoolDateOnly().filter((b) => {
      const dest = String(b.destination ?? "").trim() || "(onbekend)";
      if (fd && dest !== fd) return false;
      const lev = String(b.acco_leverancier ?? "").trim() || "(geen leverancier)";
      if (fl && !lev.toLowerCase().includes(fl)) return false;
      return true;
    });
  }

  /**
   * @param {Record<string, unknown>} b
   * @returns {string}
   */
  function finSupBookingEndYmd(b) {
    const candidates = [b.return_date, b.terugkomstdatum, b.einddatum, b.end_date, b.travel_end_date];
    for (const raw of candidates) {
      const s = String(raw ?? "").trim();
      if (!s) continue;
      const ymd = s.slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return ymd;
    }
    return "";
  }

  /**
   * Aggregatie uit ACTIVE_POOL + zelfde winst/omzet als rest van Financiën.
   * @returns {{ summary: Array<Record<string, unknown>>, detailsByKey: Map<string, Array<Record<string, unknown>>> }}
   */
  function finSupAggregateFromPool() {
    const rows = finSupBookingsForView();
    const profitBookingIds = new Set(
      getWinstBoekingen(rows)
        .map((b) => String(b.booking_id ?? "").trim())
        .filter(Boolean),
    );
    /** @type {Map<string, { bestemming_naam: string, leverancier: string, aantal_boekingen: number, aantal_reizigers: number, totale_omzet: number, totale_winst: number }>} */
    const sumMap = new Map();
    /** @type {Map<string, Map<string, { accommodatie_naam: string, accommodatie_type: string, aantal_boekingen: number, aantal_reizigers: number, omzet: number, winst: number, periode_van: string, periode_tot: string, boekingen: Set<string>, boekingsperiodes: Map<string, { boeking: string, vertrek: string, einde: string }> }>>} */
    const detMap = new Map();

    for (const b of rows) {
      const dest = String(b.destination ?? "").trim() || "(onbekend)";
      const lev = String(b.acco_leverancier ?? "").trim() || "(geen leverancier)";
      const rk = finSupRowKey(dest, lev);
      const depYmd = finSupDepartureYmd(/** @type {Record<string, unknown>} */ (b));
      if (!sumMap.has(rk)) {
        sumMap.set(rk, {
          bestemming_naam: dest,
          leverancier: lev,
          aantal_boekingen: 0,
          aantal_reizigers: 0,
          totale_omzet: 0,
          totale_winst: 0,
          periode_van: depYmd || "",
          periode_tot: depYmd || "",
        });
      }
      const sumRow = sumMap.get(rk);
      if (!sumRow) continue;
      sumRow.aantal_boekingen += 1;
      sumRow.aantal_reizigers += n(b.pax);
      sumRow.totale_omzet += numField(b.totaal_te_betalen);
      const bid = String(b.booking_id ?? "").trim();
      if (bid && profitBookingIds.has(bid)) {
        sumRow.totale_winst += computeProfit(/** @type {Record<string, unknown>} */ (b));
      }
      if (depYmd) {
        if (!sumRow.periode_van || depYmd < sumRow.periode_van) sumRow.periode_van = depYmd;
        if (!sumRow.periode_tot || depYmd > sumRow.periode_tot) sumRow.periode_tot = depYmd;
      }

      const aid = b.accommodatie_id;
      const ak =
        aid != null && aid !== ""
          ? `id:${String(aid)}`
          : `naam:${String(b.accommodatie_naam ?? "")}\u0001${String(b.accommodatie_type ?? "")}`;
      if (!detMap.has(rk)) detMap.set(rk, new Map());
      const sub = detMap.get(rk);
      if (!sub) continue;
      if (!sub.has(ak)) {
        sub.set(ak, {
          accommodatie_naam: String(b.accommodatie_naam ?? "—"),
          accommodatie_type: String(b.accommodatie_type ?? "—"),
          aantal_boekingen: 0,
          aantal_reizigers: 0,
          omzet: 0,
          winst: 0,
          periode_van: depYmd || "",
          periode_tot: depYmd || "",
          boekingen: new Set(),
          boekingsperiodes: new Map(),
        });
      }
      const detRow = sub.get(ak);
      if (!detRow) continue;
      detRow.aantal_boekingen += 1;
      detRow.aantal_reizigers += n(b.pax);
      detRow.omzet += numField(b.totaal_te_betalen);
      if (bid && profitBookingIds.has(bid)) {
        detRow.winst += computeProfit(/** @type {Record<string, unknown>} */ (b));
      }
      if (depYmd) {
        if (!detRow.periode_van || depYmd < detRow.periode_van) detRow.periode_van = depYmd;
        if (!detRow.periode_tot || depYmd > detRow.periode_tot) detRow.periode_tot = depYmd;
      }
      const bookingRef = String(b.order_nummer ?? b.booking_id ?? "").trim();
      if (bookingRef) detRow.boekingen.add(bookingRef);
      const bookingId = String(b.booking_id ?? bookingRef).trim();
      if (bookingId) {
        detRow.boekingsperiodes.set(bookingId, {
          boeking: bookingRef || bookingId,
          vertrek: depYmd || "",
          einde: finSupBookingEndYmd(/** @type {Record<string, unknown>} */ (b)),
        });
      }
    }

    const summary = [...sumMap.values()].map((r) => ({
      ...r,
      winst_marge: r.totale_omzet > 0 ? r.totale_winst / r.totale_omzet : null,
    }));

    /** @type {Map<string, Array<Record<string, unknown>>>} */
    const detailsByKey = new Map();
    for (const [rk, sub] of detMap) {
      const arr = [...sub.values()].map((d) => ({
        ...d,
        gem_prijs_per_pax: d.aantal_reizigers > 0 ? d.omzet / d.aantal_reizigers : null,
        boekingen_lijst: [...d.boekingen].sort((a, b) => a.localeCompare(b, "nl", { sensitivity: "base" })),
        boekingsperiodes_lijst: [...d.boekingsperiodes.values()].sort((a, b) => String(a.vertrek || "").localeCompare(String(b.vertrek || ""))),
      }));
      arr.sort((a, b) =>
        String(a.accommodatie_naam ?? "").localeCompare(String(b.accommodatie_naam ?? ""), "nl", { sensitivity: "base" }),
      );
      detailsByKey.set(rk, arr);
    }

    return { summary, detailsByKey };
  }

  const DiscountsSection = {
    _expandedCodeKey: "",
    _boundTableClick: false,
    _rerenderCodeTable: null,
    _detailSortStateByCode: new Map(),
    /** @param {ReturnType<typeof buildAggregates>} agg */
    render(agg) {
      const sum = (rows, pick) => rows.reduce((acc, row) => acc + numField(pick(row)), 0);
      const setText = (id, t) => {
        const el = document.getElementById(id);
        if (el) el.textContent = t;
      };
      const setHtml = (id, h) => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = h;
      };
      if (!this._boundTableClick) {
        this._boundTableClick = true;
        document.getElementById("finDiscCodesBody")?.addEventListener("click", (ev) => {
          const sortTrigger = ev.target.closest("[data-fin-disc-detail-sort]");
          if (sortTrigger) {
            ev.stopPropagation();
            const codeKey = String(sortTrigger.getAttribute("data-fin-disc-detail-code") || "");
            const sortKey = String(sortTrigger.getAttribute("data-fin-disc-detail-sort") || "");
            if (codeKey && sortKey) {
              const prev = this._detailSortStateByCode.get(codeKey) || { key: "discount", dir: "desc" };
              const nextDir = prev.key === sortKey && prev.dir === "desc" ? "asc" : "desc";
              this._detailSortStateByCode.set(codeKey, { key: sortKey, dir: nextDir });
              if (typeof this._rerenderCodeTable === "function") this._rerenderCodeTable();
            }
            return;
          }
          const row = ev.target.closest("[data-fin-disc-code-key]");
          if (!row) return;
          const key = String(row.getAttribute("data-fin-disc-code-key") || "");
          this._expandedCodeKey = this._expandedCodeKey === key ? "" : key;
          if (typeof this._rerenderCodeTable === "function") this._rerenderCodeTable();
        });
      }

      const bookingRows = agg.cur || [];
      const profitRows = agg.curProfit || [];
      const bookingIds = new Set(bookingRows.map((b) => String(b.booking_id ?? "")));
      const travellers = filterTravellersForBookings(PAYMENT_TRAVELLERS, bookingRows);
      const profitBookingIds = new Set(profitRows.map((b) => String(b.booking_id ?? "")));
      const bookingById = new Map(bookingRows.map((b) => [String(b.booking_id ?? ""), b]));

      const hasDiscountCode = (rawCode) => {
        const code = String(rawCode ?? "").trim().toLowerCase();
        return !!code && code !== "no";
      };
      const hasDiscount = (t) => numField(t.discount_amount) > 0 || hasDiscountCode(t.discount_code_used);
      const discountTravellers = travellers.filter(hasDiscount);
      const travellerCount = travellers.length;
      const travellerDiscountCount = discountTravellers.length;
      const bookingDiscountIds = new Set(discountTravellers.map((t) => String(t.booking_id ?? "")));
      const bookingDiscountCount = bookingDiscountIds.size;
      const totalDiscount = sum(discountTravellers, (t) => numField(t.discount_amount));
      const avgDiscountTraveller = travellerDiscountCount > 0 ? totalDiscount / travellerDiscountCount : 0;
      const avgDiscountBooking = bookingDiscountCount > 0 ? totalDiscount / bookingDiscountCount : 0;
      const pctTraveller = travellerCount > 0 ? travellerDiscountCount / travellerCount : 0;
      const pctBooking = bookingRows.length > 0 ? bookingDiscountCount / bookingRows.length : 0;
      const currentOmzet = sum(bookingRows, (r) => numField(r.totaal_te_betalen));
      const currentWinst = sum(profitRows, (r) => computeProfit(r));
      const omzetNoDiscount = currentOmzet + totalDiscount;
      const winstNoDiscount = currentWinst + totalDiscount;
      const currentMargin = currentOmzet > 0 ? currentWinst / currentOmzet : 0;
      const marginNoDiscount = omzetNoDiscount > 0 ? winstNoDiscount / omzetNoDiscount : 0;
      const marginImpact = marginNoDiscount - currentMargin;

      setText("finDiscKpiTotal", nfMoney.format(totalDiscount));
      setText("finDiscKpiBookings", nfInt.format(bookingDiscountCount));
      setText("finDiscKpiTravellers", nfInt.format(travellerDiscountCount));
      setText("finDiscKpiAvgTraveller", nfMoney.format(avgDiscountTraveller));
      setText("finDiscKpiAvgBooking", nfMoney.format(avgDiscountBooking));
      setText("finDiscKpiPctTravellers", nfPct.format(pctTraveller));
      setText("finDiscKpiPctBookings", nfPct.format(pctBooking));
      setText("finDiscKpiMarginImpact", `${nfPct.format(marginImpact)} pp`);

      const codeBuckets = new Map();
      const normalizeCodeKey = (code, amount) => {
        const c = String(code ?? "").trim();
        if (!c) return amount > 0 ? "__manual_discount__" : "";
        return c.toLowerCase();
      };
      const bookingMainCustomer = new Map();
      travellers.forEach((t) => {
        const bid = String(t.booking_id ?? "");
        if (!bid || bookingMainCustomer.has(bid)) return;
        bookingMainCustomer.set(bid, travellerDisplayName(t));
      });
      discountTravellers.forEach((t) => {
        const bid = String(t.booking_id ?? "");
        if (!bookingIds.has(bid)) return;
        const amount = numField(t.discount_amount);
        const rawCode = String(t.discount_code_used ?? "").trim();
        const key = normalizeCodeKey(hasDiscountCode(rawCode) ? rawCode : "", amount);
        if (!key) return;
        if (!codeBuckets.has(key)) {
          codeBuckets.set(key, {
            key,
            label: key === "__manual_discount__" ? "Geen code" : rawCode,
            labels: new Map(),
            travellers: new Set(),
            bookings: new Set(),
            totalDiscount: 0,
          });
        }
        const bucket = codeBuckets.get(key);
        bucket.travellers.add(String(t.reiziger_id ?? `${bid}-${travellerDisplayName(t)}`));
        bucket.bookings.add(bid);
        bucket.totalDiscount += amount;
        if (rawCode) bucket.labels.set(rawCode, (bucket.labels.get(rawCode) || 0) + 1);
      });

      financeDiscountCodeRows = Array.from(codeBuckets.values())
        .map((bucket) => {
          if (bucket.key !== "__manual_discount__" && bucket.labels.size > 0) {
            bucket.label = Array.from(bucket.labels.entries()).sort((a, b) => b[1] - a[1])[0][0];
          }
          const omzet = sum(Array.from(bucket.bookings), (bid) => numField(bookingById.get(bid)?.totaal_te_betalen));
          const winst = sum(Array.from(bucket.bookings), (bid) =>
            profitBookingIds.has(bid) ? computeProfit(bookingById.get(bid) || {}) : 0
          );
          const currentM = omzet > 0 ? winst / omzet : 0;
          const omzetNoDisc = omzet + bucket.totalDiscount;
          const winstNoDisc = winst + bucket.totalDiscount;
          const noDiscM = omzetNoDisc > 0 ? winstNoDisc / omzetNoDisc : 0;
          return {
            codeKey: bucket.key,
            code: bucket.label,
            travellers: bucket.travellers.size,
            bookings: bucket.bookings.size,
            discount: bucket.totalDiscount,
            avgTraveller: bucket.travellers.size ? bucket.totalDiscount / bucket.travellers.size : 0,
            avgBooking: bucket.bookings.size ? bucket.totalDiscount / bucket.bookings.size : 0,
            revenue: omzet,
            profit: winst,
            profitNoDiscount: winstNoDisc,
            marginCurrent: currentM,
            marginNoDiscount: noDiscM,
            marginImpact: noDiscM - currentM,
          };
        })
        .sort((a, b) => numField(b.discount) - numField(a.discount));

      const discountBookingRows = Array.from(bookingDiscountIds)
        .map((bid) => {
          const row = bookingById.get(bid) || {};
          const travellersForBooking = travellers.filter((t) => String(t.booking_id ?? "") === bid);
          const discountTravForBooking = discountTravellers.filter((t) => String(t.booking_id ?? "") === bid);
          const totalDiscountBooking = sum(discountTravForBooking, (t) => numField(t.discount_amount));
          const rawCodes = new Set();
          const codeKeys = new Set();
          discountTravForBooking.forEach((t) => {
            const c = String(t.discount_code_used ?? "").trim();
            const key = normalizeCodeKey(hasDiscountCode(c) ? c : "", numField(t.discount_amount));
            if (key) codeKeys.add(key);
            if (hasDiscountCode(c)) rawCodes.add(c);
          });
          const codes = rawCodes.size ? Array.from(rawCodes).join(", ") : "Geen code";
          const omzet = numField(row.totaal_te_betalen);
          const winst = profitBookingIds.has(bid) ? computeProfit(row) : 0;
          const currentM = omzet > 0 ? winst / omzet : 0;
          const omzetNoDisc = omzet + totalDiscountBooking;
          const winstNoDisc = winst + totalDiscountBooking;
          const noDiscM = omzetNoDisc > 0 ? winstNoDisc / omzetNoDisc : 0;
          return {
            order: String(row.order_nummer ?? "—"),
            destination: String(row.destination ?? "Onbekend"),
            customer: bookingMainCustomer.get(bid) || "—",
            travellersTotal: travellersForBooking.length,
            travellersDiscount: discountTravForBooking.length,
            codes,
            codeKeys,
            discount: totalDiscountBooking,
            revenue: omzet,
            profit: winst,
            marginCurrent: currentM,
            marginNoDiscount: noDiscM,
            marginImpact: noDiscM - currentM,
          };
        })
        .sort((a, b) => numField(b.discount) - numField(a.discount));
      const rankRows = financeDiscountCodeRows.slice().sort((a, b) => numField(b.discount) - numField(a.discount));
      const topFive = rankRows.slice(0, 5);
      const others = rankRows.slice(5);
      const topWithOther = [...topFive];
      if (others.length) {
        topWithOther.push({
          codeKey: "__overige__",
          code: "Overige",
          discount: sum(others, (r) => r.discount),
          travellers: sum(others, (r) => r.travellers),
          bookings: sum(others, (r) => r.bookings),
          marginImpact: others.length ? sum(others, (r) => r.marginImpact) / others.length : 0,
        });
      }

      destroyChart("finDiscChartDonut");
      destroyChart("finDiscChartMarginImpact");
      destroyChart("finDiscChartTrend");
      const donutCanvas = document.getElementById("finDiscChartDonut");
      if (donutCanvas && topWithOther.length) {
        const total = sum(topWithOther, (r) => r.discount) || 1;
        charts.finDiscChartDonut = new Chart(donutCanvas.getContext("2d"), {
          type: "doughnut",
          data: {
            labels: topWithOther.map((r) => r.code),
            datasets: [{
              data: topWithOther.map((r) => numField(r.discount)),
              backgroundColor: ["#f59e0b", "#f97316", "#fb7185", "#ef4444", "#facc15", "#fde68a"],
              borderWidth: 1,
            }],
          },
          options: {
            maintainAspectRatio: false,
            plugins: {
              legend: { position: "bottom" },
              tooltip: {
                callbacks: {
                  label: (ctx) => {
                    const r = topWithOther[ctx.dataIndex];
                    const share = numField(r.discount) / total;
                    const bookingsShare = bookingDiscountCount > 0 ? numField(r.bookings) / bookingDiscountCount : 0;
                    const marginCur = numField(r.revenue) > 0 ? numField(r.profit) / numField(r.revenue) : 0;
                    const revNoDisc = numField(r.revenue) + numField(r.discount);
                    const marginNoDisc = revNoDisc > 0 ? (numField(r.profit) + numField(r.discount)) / revNoDisc : 0;
                    return [
                      `${r.code}`,
                      `Korting: ${nfMoney.format(numField(r.discount))}`,
                      `Aandeel korting: ${nfPct.format(share)}`,
                      `Boekingen: ${nfInt.format(numField(r.bookings))}`,
                      `Aandeel boekingen: ${nfPct.format(bookingsShare)}`,
                      `Reizigers: ${nfInt.format(numField(r.travellers))}`,
                      `Huidige marge: ${nfPct.format(marginCur)}`,
                      `Marge zonder korting: ${nfPct.format(marginNoDisc)}`,
                      `Marge-impact: ${nfPct.format(marginNoDisc - marginCur)} pp`,
                    ];
                  },
                },
              },
            },
          },
        });
      }

      const impactCanvas = document.getElementById("finDiscChartMarginImpact");
      if (impactCanvas && rankRows.length) {
        const rows = rankRows.slice(0, 8);
        charts.finDiscChartMarginImpact = new Chart(impactCanvas.getContext("2d"), {
          type: "bar",
          data: {
            labels: rows.map((r) => r.code),
            datasets: [{
              label: "Marge-impact (pp)",
              data: rows.map((r) => numField(r.marginImpact) * 100),
              backgroundColor: rows.map((r) => {
                const pp = Math.abs(numField(r.marginImpact) * 100);
                if (pp < 1) return "#facc15";
                if (pp < 2.5) return "#f59e0b";
                return "#ef4444";
              }),
            }],
          },
          options: {
            maintainAspectRatio: false,
            plugins: {
              tooltip: {
                callbacks: {
                  label: (ctx) => {
                    const r = rows[ctx.dataIndex];
                    if (!r) return "";
                    return [
                      `${r.code}`,
                      `Marge-impact: ${nfPct.format(numField(r.marginImpact))} pp`,
                      `Totale korting: ${nfMoney.format(numField(r.discount))}`,
                      `Boekingen: ${nfInt.format(numField(r.bookings))}`,
                      `Reizigers: ${nfInt.format(numField(r.travellers))}`,
                      `Gem. korting/boeking: ${nfMoney.format(numField(r.avgBooking))}`,
                      `Gem. korting/reiziger: ${nfMoney.format(numField(r.avgTraveller))}`,
                    ];
                  },
                },
              },
            },
          },
        });
      }

      const renderCodeDetails = (codeKey) => {
        const rows = discountBookingRows
          .filter((r) => r.codeKeys && r.codeKeys.has(codeKey))
          .map((r) => {
            const booking = bookingRows.find((b) => String(b.order_nummer ?? "") === String(r.order ?? "")) || {};
            const depRaw = String(booking.departure_date ?? "").slice(0, 10);
            const dep =
              (window.TADate && window.TADate.formatDate && window.TADate.formatDate(depRaw, depRaw)) || depRaw;
            const period = dep || "—";
            const brand = String(booking.brand ?? "—");
            return { ...r, period, brand };
          });
        const sortState = this._detailSortStateByCode.get(codeKey) || { key: "discount", dir: "desc" };
        const sortKey = String(sortState.key || "discount");
        const sortDir = sortState.dir === "asc" ? 1 : -1;
        rows.sort((a, b) => {
          const numericKeys = new Set([
            "travellersTotal",
            "travellersDiscount",
            "discount",
            "revenue",
            "profit",
            "marginCurrent",
            "marginNoDiscount",
            "marginImpact",
          ]);
          if (numericKeys.has(sortKey)) {
            return sortDir * (numField(a[sortKey]) - numField(b[sortKey]));
          }
          return sortDir * String(a[sortKey] ?? "").localeCompare(String(b[sortKey] ?? ""), "nl", { sensitivity: "base" });
        });
        if (!rows.length) return '<div class="text-muted small">Geen boekingen voor deze code.</div>';
        const th = (label, key, right = false) => {
          const active = sortKey === key;
          const marker = active ? (sortDir > 0 ? " ↑" : " ↓") : "";
          return `<th${right ? ' class="text-end"' : ""}><button type="button" class="btn btn-link btn-sm p-0 text-decoration-none text-reset fw-semibold" data-fin-disc-detail-code="${escapeHtml(codeKey)}" data-fin-disc-detail-sort="${escapeHtml(key)}">${escapeHtml(label)}${marker}</button></th>`;
        };
        const desktop = `<div class="table-responsive rounded border bg-white finance-disc-detail-scroll"><table class="table table-sm mb-0"><thead class="table-light"><tr>${th("Boekingsnummer", "order")}${th("Periode", "period")}${th("Bestemming", "destination")}${th("Brand", "brand")}${th("Reizigers", "travellersTotal", true)}${th("Met korting", "travellersDiscount", true)}${th("Totale korting", "discount", true)}${th("Omzet", "revenue", true)}${th("Winst", "profit", true)}${th("Marge", "marginCurrent", true)}${th("Marge zonder korting", "marginNoDiscount", true)}${th("Marge-impact", "marginImpact", true)}</tr></thead><tbody>${rows.map((r) => {
          return `<tr><td>${escapeHtml(String(r.order))}</td><td>${escapeHtml(String(r.period))}</td><td>${escapeHtml(String(r.destination))}</td><td>${escapeHtml(String(r.brand))}</td><td class="text-end">${nfInt.format(numField(r.travellersTotal))}</td><td class="text-end">${nfInt.format(numField(r.travellersDiscount))}</td><td class="text-end">${nfMoney.format(numField(r.discount))}</td><td class="text-end">${nfMoney.format(numField(r.revenue))}</td><td class="text-end">${nfMoney.format(numField(r.profit))}</td><td class="text-end">${nfPct.format(numField(r.marginCurrent))}</td><td class="text-end">${nfPct.format(numField(r.marginNoDiscount))}</td><td class="text-end">${nfPct.format(numField(r.marginImpact))} pp</td></tr>`;
        }).join("")}</tbody></table></div>`;
        const mobileCards = `<div class="d-md-none">${rows.map((r) => `<div class="border rounded-3 p-2 mb-2 bg-white"><div class="fw-semibold">${escapeHtml(String(r.order))}</div><div class="small text-muted">${escapeHtml(String(r.destination))}</div><div class="small">Korting: ${nfMoney.format(numField(r.discount))} · Marge-impact: ${nfPct.format(numField(r.marginImpact))} pp</div></div>`).join("")}</div>`;
        return `<div class="p-2 bg-light border rounded-3">${mobileCards}<div class="d-none d-md-block">${desktop}</div></div>`;
      };

      const renderCodes = (rows) => {
        if (!rows.length) {
          setHtml("finDiscCodesBody", '<tr><td colspan="11" class="text-center text-muted py-3">Geen kortingscodes gevonden voor de huidige filters.</td></tr>');
          return;
        }
        const html = rows
          .map((r) => {
            const open = this._expandedCodeKey === r.codeKey;
            const baseRow = `<tr class="finance-disc-code-row${open ? " table-active" : ""}" data-fin-disc-code-key="${escapeHtml(String(r.codeKey))}" data-sort-code="${escapeHtml(String(r.code))}" data-sort-travellers="${numField(r.travellers)}" data-sort-bookings="${numField(r.bookings)}" data-sort-discount="${numField(r.discount)}" data-sort-avg-traveller="${numField(r.avgTraveller)}" data-sort-avg-booking="${numField(r.avgBooking)}" data-sort-profit="${numField(r.profit)}" data-sort-profit-no-discount="${numField(r.profitNoDiscount)}" data-sort-margin-current="${numField(r.marginCurrent)}" data-sort-margin-impact="${numField(r.marginImpact)}"><td>${escapeHtml(String(r.code))}</td><td class="text-end">${nfInt.format(numField(r.travellers))}</td><td class="text-end">${nfInt.format(numField(r.bookings))}</td><td class="text-end">${nfMoney.format(numField(r.discount))}</td><td class="text-end">${nfMoney.format(numField(r.avgTraveller))}</td><td class="text-end">${nfMoney.format(numField(r.avgBooking))}</td><td class="text-end">${nfMoney.format(numField(r.profit))}</td><td class="text-end">${nfMoney.format(numField(r.profitNoDiscount))}</td><td class="text-end">${nfPct.format(numField(r.marginCurrent))}</td><td class="text-end">${nfPct.format(numField(r.marginImpact))} pp</td></tr>`;
            const detailRow = open ? `<tr class="finance-disc-detail-row"><td colspan="11">${renderCodeDetails(r.codeKey)}</td></tr>` : "";
            return `${baseRow}${detailRow}`;
          })
          .join("");
        setHtml("finDiscCodesBody", html);
      };
      this._rerenderCodeTable = () => renderCodes(financeDiscountCodeRows);
      renderCodes(financeDiscountCodeRows);

      const wireCodes = globalThis.TA_wireSortableTable;
      const tblCodes = document.getElementById("finDiscCodesTable");
      if (wireCodes && tblCodes) {
        wireCodes(tblCodes, () => financeDiscountCodeRows.slice(), (sorted) => {
          financeDiscountCodeRows = sorted;
          renderCodes(sorted);
        });
      }
    },
  };

  const SuppliersSection = {
    _sortKey: "bestemming_naam",
    _sortDir: 1,
    _page: 1,
    /** @type {Map<string, { naam: string, type: string, boekingsperiodes: Array<{ boeking: string, vertrek: string, einde: string }> }>} */
    _detailLookup: new Map(),
    _detailModal: null,
    /** @type {Set<string>} */
    _expanded: new Set(),
    _inited: false,
    init() {
      if (this._inited || !document.getElementById("finSupTableBody")) return;
      this._inited = true;
      const resetPage = () => {
        this._page = 1;
        this.render();
      };
      const bindDate = (id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener("change", resetPage);
        el.addEventListener("input", resetPage);
      };
      bindDate("finSupDateFrom");
      bindDate("finSupDateTo");
      document.getElementById("finSupFilterDest")?.addEventListener("change", resetPage);
      document.getElementById("finSupFilterLev")?.addEventListener("input", resetPage);
      document.getElementById("finSupTable")?.addEventListener("click", (ev) => {
        const detailBtn = ev.target.closest("[data-fin-sup-detail]");
        if (detailBtn) {
          ev.stopPropagation();
          const token = String(detailBtn.getAttribute("data-fin-sup-detail") || "").trim();
          const data = token ? this._detailLookup.get(token) : null;
          if (data) this.openDetailModal(data);
          return;
        }
        const sortBtn = ev.target.closest("[data-fin-sup-sort]");
        if (sortBtn) {
          const k = sortBtn.getAttribute("data-fin-sup-sort");
          if (k) {
            if (this._sortKey === k) this._sortDir *= -1;
            else {
              this._sortKey = k;
              this._sortDir = 1;
            }
            this.render();
          }
          return;
        }
        const toggle = ev.target.closest("tr[data-fin-sup-toggle]");
        if (toggle) {
          const key = toggle.getAttribute("data-key");
          if (!key) return;
          if (this._expanded.has(key)) this._expanded.delete(key);
          else this._expanded.add(key);
          this.render();
        }
      });
      document.getElementById("finSupTable")?.addEventListener("keydown", (ev) => {
        if (ev.key !== "Enter" && ev.key !== " ") return;
        const toggle = ev.target.closest("tr[data-fin-sup-toggle]");
        if (!toggle) return;
        ev.preventDefault();
        const key = toggle.getAttribute("data-key");
        if (!key) return;
        if (this._expanded.has(key)) this._expanded.delete(key);
        else this._expanded.add(key);
        this.render();
      });
      document.getElementById("finSupBtnPrev")?.addEventListener("click", () => {
        if (this._page > 1) {
          this._page -= 1;
          this.render();
        }
      });
      document.getElementById("finSupBtnNext")?.addEventListener("click", () => {
        this._page += 1;
        this.render();
      });
    },
    ensureDetailModal() {
      const el = document.getElementById("finSupDetailModal");
      if (!el) return null;
      if (!this._detailModal && typeof bootstrap !== "undefined" && bootstrap?.Modal) {
        this._detailModal = new bootstrap.Modal(el);
      }
      return this._detailModal;
    },
    /**
     * @param {{ naam: string, type: string, boekingsperiodes: Array<{ boeking: string, vertrek: string, einde: string }> }} detail
     */
    openDetailModal(detail) {
      const title = document.getElementById("finSupDetailModalTitle");
      const body = document.getElementById("finSupDetailModalBody");
      if (!body) return;
      if (title) title.textContent = `Accommodatie: ${detail.naam || "—"}`;
      const boekingsperiodes = Array.isArray(detail.boekingsperiodes) ? detail.boekingsperiodes : [];
      const boekingsperiodesHtml = boekingsperiodes.length
        ? `<ul class="mb-0 ps-3">${boekingsperiodes
            .map((p) => {
              const vertrek = String(p.vertrek || "").trim();
              const einde = String(p.einde || "").trim();
              const periode = vertrek ? `${escapeHtml(vertrek)}${einde ? ` t/m ${escapeHtml(einde)}` : ""}` : "Vertrekdatum onbekend";
              return `<li><strong>${escapeHtml(String(p.boeking || "—"))}</strong>: ${periode}</li>`;
            })
            .join("")}</ul>`
        : `<span class="text-muted">Geen boekingsperiodes beschikbaar.</span>`;
      body.innerHTML = `
        <div class="mb-2"><strong>Type:</strong> ${escapeHtml(detail.type || "—")}</div>
        <div><strong>Boekingsperiodes:</strong>${boekingsperiodesHtml}</div>
      `;
      const modal = this.ensureDetailModal();
      if (modal) modal.show();
    },
    render() {
      this.init();
      const tbody = document.getElementById("finSupTableBody");
      if (!tbody) return;

      const { summary, detailsByKey } = finSupAggregateFromPool();
      let list = [...summary];

      const sk = this._sortKey;
      const sd = this._sortDir;
      list.sort((a, b) => {
        if (sk === "aantal_boekingen" || sk === "aantal_reizigers" || sk === "totale_omzet" || sk === "totale_winst") {
          return (n(a[sk]) - n(b[sk])) * sd;
        }
        if (sk === "winst_marge") {
          const va = a.winst_marge != null ? n(a.winst_marge) : -1;
          const vb = b.winst_marge != null ? n(b.winst_marge) : -1;
          return (va - vb) * sd;
        }
        return String(a[sk] ?? "").localeCompare(String(b[sk] ?? ""), "nl", { sensitivity: "base" }) * sd;
      });

      const total = list.length;
      const pages = Math.max(1, Math.ceil(total / FIN_SUP_PAGE_SIZE) || 1);
      if (this._page > pages) this._page = pages;
      const start = (this._page - 1) * FIN_SUP_PAGE_SIZE;
      const slice = list.slice(start, start + FIN_SUP_PAGE_SIZE);

      const destSel = document.getElementById("finSupFilterDest");
      if (destSel) {
        const prev = destSel.value;
        const uniq = [...new Set(finSupPoolDateOnly().map((b) => String(b.destination ?? "").trim() || "(onbekend)"))].sort((a, b) =>
          a.localeCompare(b, "nl", { sensitivity: "base" }),
        );
        destSel.innerHTML =
          `<option value="">Alle</option>` +
          uniq.map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join("");
        if (uniq.includes(prev)) destSel.value = prev;
      }

      const info = document.getElementById("finSupPagerInfo");
      if (info) {
        if (!total) info.textContent = "Geen rijen voor deze filters.";
        else
          info.textContent = `Rij ${start + 1}–${Math.min(start + FIN_SUP_PAGE_SIZE, total)} van ${total} (pagina ${this._page} / ${pages})`;
      }
      const prevLi = document.getElementById("finSupPagePrev");
      const nextLi = document.getElementById("finSupPageNext");
      if (prevLi) prevLi.classList.toggle("disabled", this._page <= 1);
      if (nextLi) nextLi.classList.toggle("disabled", this._page >= pages);

      if (!total) {
        tbody.innerHTML = `<tr><td colspan="8" class="text-muted text-center py-4">Geen leveranciersdata voor deze selectie.</td></tr>`;
        return;
      }

      const rowsHtml = [];
      this._detailLookup.clear();
      for (const r of slice) {
        const dest = String(r.bestemming_naam ?? "");
        const lev = String(r.leverancier ?? "");
        const key = finSupRowKey(dest, lev);
        const bk = n(r.aantal_boekingen);
        const rz = n(r.aantal_reizigers);
        const tom = n(r.totale_omzet);
        const tw = n(r.totale_winst);
        const wm = r.winst_marge;
        const wmStr = tom > 0 && wm != null ? nfPctMargin2.format(n(wm)) : "—";
        const open = this._expanded.has(key);
        const detRows = detailsByKey.get(key) || [];
        rowsHtml.push(`<tr class="fin-sup-main-row" data-fin-sup-toggle="1" data-key="${escapeHtml(key)}" role="button" tabindex="0">
          <td class="text-muted small">${open ? "▼" : "▶"}</td>
          <td>${escapeHtml(dest)}</td>
          <td>${escapeHtml(lev)}</td>
          <td class="text-end fin-sup-num">${nfInt.format(bk)}</td>
          <td class="text-end fin-sup-num">${nfInt.format(rz)}</td>
          <td class="text-end fin-sup-num">${nfMoneyEuro2.format(tom)}</td>
          <td class="text-end fin-sup-num">${nfMoneyEuro2.format(tw)}</td>
          <td class="text-end fin-sup-num">${wmStr}</td>
        </tr>`);
        rowsHtml.push(
          `<tr class="fin-sup-detail-row ${open ? "" : "d-none"}" data-parent-key="${escapeHtml(key)}"><td colspan="8" class="bg-white border-top-0 pt-0 pb-3">
            <div class="table-responsive rounded border bg-light px-2 py-2 fin-sup-detail-scroll">
              <table class="table table-sm mb-0 finance-table finance-table--analysis fin-sup-detail-table">
                <thead><tr>
                  <th class="fin-sup-detail-th-name">Naam</th>
                  <th>Type</th>
                  <th class="text-end">Gem. prijs p.p.</th>
                  <th class="text-end">Aantal pax</th>
                  <th class="text-end">Aantal boekingen</th>
                  <th class="text-end">Omzet</th>
                  <th class="text-end">Winst</th>
                </tr></thead>
                <tbody>
                  ${
                    detRows.length
                      ? detRows
                          .map((d, idx) => {
                            const nm = String(d.accommodatie_naam ?? "—");
                            const gpp = d.gem_prijs_per_pax != null ? nfMoneyEuro2.format(n(d.gem_prijs_per_pax)) : "—";
                            const token = `${key}__${start}__${idx}`;
                            this._detailLookup.set(token, {
                              naam: nm,
                              type: String(d.accommodatie_type ?? "—"),
                              boekingsperiodes: Array.isArray(d.boekingsperiodes_lijst)
                                ? d.boekingsperiodes_lijst.map((x) => ({
                                    boeking: String(x.boeking ?? "—"),
                                    vertrek: String(x.vertrek ?? ""),
                                    einde: String(x.einde ?? ""),
                                  }))
                                : [],
                            });
                            return `<tr>
                              <td class="fin-sup-acco-name">
                                <button type="button" class="btn btn-link btn-sm p-0 fin-sup-acco-open" data-fin-sup-detail="${escapeHtml(token)}" title="Toon detail">
                                  ${escapeHtml(nm)}
                                </button>
                              </td>
                              <td>${escapeHtml(String(d.accommodatie_type ?? "—"))}</td>
                              <td class="text-end fin-sup-num">${gpp}</td>
                              <td class="text-end fin-sup-num">${nfInt.format(n(d.aantal_reizigers))}</td>
                              <td class="text-end fin-sup-num">${nfInt.format(n(d.aantal_boekingen))}</td>
                              <td class="text-end fin-sup-num">${nfMoneyEuro2.format(n(d.omzet))}</td>
                              <td class="text-end fin-sup-num">${nfMoneyEuro2.format(n(d.winst))}</td>
                            </tr>`;
                          })
                          .join("")
                      : `<tr><td colspan="7" class="text-muted small">Geen onderliggende accommodaties.</td></tr>`
                  }
                </tbody>
              </table>
            </div>
          </td></tr>`
        );
      }
      tbody.innerHTML = rowsHtml.join("");
    },
  };

  const FinanceFilters = {
    /** @param {() => void | Promise<void>} onApply */
    init(onApply) {
      document.getElementById("finApply")?.addEventListener("click", () => {
        void Promise.resolve(onApply()).catch((e) => showFinanceError(e instanceof Error ? e.message : String(e)));
      });
      document.getElementById("finReset")?.addEventListener("click", () => {
        const years = _optionsYears.length ? _optionsYears : [new Date().getFullYear()];
        const y = document.getElementById("finYear");
        if (y) y.value = defaultFinYearSelectValue(years);
        const b = document.getElementById("finBrand");
        if (b) b.value = "__all__";
        const d = document.getElementById("finDest");
        if (d) d.value = "";
        finDestMulti?.clear();
        const c = document.getElementById("finCountry");
        if (c) c.value = "__all__";
        const p = document.getElementById("finPeriod");
        if (p) p.value = "all";
        const cmp = document.getElementById("finCompare");
        if (cmp) cmp.value = "prev_year";
        memoAgg.clear();
        void Promise.resolve(onApply()).catch((e) => showFinanceError(e instanceof Error ? e.message : String(e)));
      });
    },
  };

  function refreshAll() {
    OtherRevenuesSection.resetPaging();
    const st = getFilterState();
    const agg = buildAggregates(st);
    const excludedCount = countProfitExcludedBookings(agg.cur);
    const excludedEl = document.getElementById("finProfitRuleExcludedCount");
    if (excludedEl) excludedEl.textContent = String(excludedCount);
    FinanceKPIGrid.render(agg, st);
    RevenueSection.render(agg, st);
    PaymentsSection.render(agg);
    InsuranceSection.render(agg);
    OtherRevenuesSection.render(agg);
    DiscountsSection.render(agg);
    SuppliersSection.render();
  }

  const FinancePage = {
    async init() {
      if (!document.getElementById("financePage")) return;
      initFinanceKpiHelp();
      initFinanceDiscountKpiHelp();
      try {
        await loadOptions();
        populateFilterControls();
      } catch (e) {
        showFinanceError(e instanceof Error ? e.message : String(e));
      }

      FinanceFilters.init(async () => {
        memoAgg.clear();
        await loadData();
        refreshAll();
      });

      try {
        await loadData();
        refreshAll();
      } catch (e) {
        showFinanceError(e instanceof Error ? e.message : String(e));
      }

      document.querySelectorAll("#financeMainTabs button[data-bs-toggle='pill']").forEach((btn) => {
        btn.addEventListener("shown.bs.tab", () => {
          Object.values(charts).forEach((ch) => {
            try {
              ch?.resize?.();
            } catch {
              /* ignore */
            }
          });
        });
      });
    },
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      void FinancePage.init();
    });
  } else {
    void FinancePage.init();
  }

  window.FinanceExports = {
    computeProfit,
    isExcludedFromProfitCalculation,
    getFinancialPerformanceDate,
    computeAveragePricePerBooking,
    computeAveragePricePerPerson,
    excludeCancelled,
    isActiveBooking,
    buildAggregates,
    getFilterState,
    getActivePool: () => ACTIVE_POOL,
    getPaymentTravellers: () => PAYMENT_TRAVELLERS,
    computeExtrasProfitForPool,
    calculateGrowthPercentage,
    isProblematicPayment,
    toRevenueRow,
    setActivePoolForTests: (rows) => {
      ACTIVE_POOL = dedupeBookingRowsById(
        (Array.isArray(rows) ? rows : [])
          .map((r) => normalizeBookingRow(/** @type {Record<string, unknown>} */ (r)))
          .filter(isActiveBooking),
      );
      PAYMENT_TRAVELLERS = [];
      EXCURSION_LINES_RAW = [];
      memoAgg.clear();
    },
    loadData,
  };
})();
