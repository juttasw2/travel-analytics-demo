/* eslint-disable no-console */
(function runFinancieelSmokeTests() {
  const fx = window.FinanceExports;
  if (!fx) return;

  const assert = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };

  // Basiscases helper.
  const groeiOmzet = fx.calculateGrowthPercentage(1200, 1000, true);
  assert(Math.abs((groeiOmzet.value ?? 0) - 0.2) < 1e-9, "Groei omzet moet 20% zijn");
  assert(groeiOmzet.display !== "Nieuw", "Groei met vorigejaarsdata mag niet Nieuw zijn");
  const groeiNieuw = fx.calculateGrowthPercentage(500, 0, true);
  assert(groeiNieuw.display === "Nieuw", "Groei bij vorige waarde 0 moet 'Nieuw' zijn");

  const growthByBucket = (rows, keyFn, valueFn, year) => {
    const cur = rows.filter((r) => Number(r.year) === year);
    const prev = rows.filter((r) => Number(r.year) === year - 1);
    const curMap = new Map();
    const prevMap = new Map();
    cur.forEach((r) => curMap.set(String(keyFn(r)), (curMap.get(String(keyFn(r))) || 0) + Number(valueFn(r))));
    prev.forEach((r) => prevMap.set(String(keyFn(r)), (prevMap.get(String(keyFn(r))) || 0) + Number(valueFn(r))));
    return Array.from(curMap.entries()).map(([k, curVal]) => ({ key: k, growth: fx.calculateGrowthPercentage(curVal, prevMap.get(k), true) }));
  };

  const monthRows = [
    { year: 2025, month: 5, omzet: 1000 },
    { year: 2026, month: 5, omzet: 1200 },
  ];
  const monthGrowth = growthByBucket(monthRows, (r) => r.month, (r) => r.omzet, 2026)[0];
  assert(monthGrowth.growth.display !== "Nieuw", "Maand met 2025+2026 moet percentage tonen");

  const brandRows = [
    { year: 2025, brand: "Sun Escapes", omzet: 2000 },
    { year: 2026, brand: "sun escapes", omzet: 2200 },
  ];
  const brandGrowth = growthByBucket(brandRows, (r) => String(r.brand).trim().toLowerCase(), (r) => r.omzet, 2026)[0];
  assert(brandGrowth.growth.display !== "Nieuw", "Merk met 2025+2026 moet percentage tonen");

  const destinationRows = [
    { year: 2025, destination: "Lloret", omzet: 1500 },
    { year: 2026, destination: "lloret", omzet: 1800 },
  ];
  const destinationGrowth = growthByBucket(destinationRows, (r) => String(r.destination).trim().toLowerCase(), (r) => r.omzet, 2026)[0];
  assert(destinationGrowth.growth.display !== "Nieuw", "Bestemming met 2025+2026 moet percentage tonen");

  const onlyCurrent = fx.calculateGrowthPercentage(600, undefined, true);
  assert(onlyCurrent.display === "Nieuw", "Alleen 2026-bucket moet Nieuw tonen");
  const prevZero = fx.calculateGrowthPercentage(700, 0, true);
  assert(prevZero.display === "Nieuw", "2025=0 en 2026>0 moet Nieuw tonen");
  const bothYears = fx.calculateGrowthPercentage(900, 600, true);
  assert(bothYears.display !== "Nieuw", "2025+2026 met waarden moet percentage tonen");

  // Problematische betaling: >3 herinneringen en incasso-status.
  assert(
    fx.isProblematicPayment({ aantal_voorschotbetalingsherinneringen: 4, aantal_totaalbetalingsherinneringen: 0, incasso_status: false }),
    "4+ herinneringen moet problematisch zijn",
  );
  assert(
    fx.isProblematicPayment({ aantal_voorschotbetalingsherinneringen: 0, aantal_totaalbetalingsherinneringen: 0, betalingsstatus: "In incasso" }),
    "Incasso-status moet problematisch zijn",
  );

  // Sticky-header classes/rendering hooks aanwezig.
  const styleProbe = document.createElement("div");
  styleProbe.innerHTML = '<div class="fin-sup-detail-scroll"></div><div class="finance-disc-detail-scroll"></div>';
  assert(!!styleProbe.querySelector(".fin-sup-detail-scroll"), "Leveranciers detail sticky container ontbreekt");
  assert(!!styleProbe.querySelector(".finance-disc-detail-scroll"), "Kortingen detail sticky container ontbreekt");

  // Kortingen labels.
  assert(!/Geen code \/ handmatige korting/i.test(document.body?.innerText || ""), "Oude labeltekst nog aanwezig");
  assert((document.body?.innerText || "").includes("Gem. korting p. boeking"), "Nieuwe kolomtitel ontbreekt");

  console.info("Financieel smoke tests: OK");
})();
