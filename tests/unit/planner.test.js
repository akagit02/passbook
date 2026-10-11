import { describe, expect, it } from "vitest";
import {
  DEFAULT_POTS, DEFAULT_THRESHOLDS, bucketForTx, bucketAverages, currentPeriodActuals, fixedCommitments,
  normalisePlan, resolvePots, potStatus, savingsSummary, savingsNudge, transferList, computePlanner
} from "../../src/planner/index.js";

const now = new Date(2026, 8, 16); // 16 Sep 2026 — payday on the 1st, so half-way through period "2026-09"

// Jun–Aug are the three complete periods. Each has £600 groceries, £90 fuel,
// £30 parking and £150 eating out by hand; Aug adds a £300 plumber. A £1,200
// mortgage direct debit and a £200 sofa instalment run throughout.
function fixture() {
  const transactions = [];
  ["06", "07", "08"].forEach((m) => {
    transactions.push({ id: "g" + m, amount: 600, date: `2026-${m}-05`, categoryId: "groceries" });
    transactions.push({ id: "f" + m, amount: 90, date: `2026-${m}-06`, categoryId: "car", subcategoryId: "fuel" });
    transactions.push({ id: "p" + m, amount: 30, date: `2026-${m}-07`, categoryId: "car", subcategoryId: "parking" });
    transactions.push({ id: "e" + m, amount: 150, date: `2026-${m}-08`, categoryId: "eating_out" });
    transactions.push({ id: "m" + m, amount: 1200, date: `2026-${m}-01`, categoryId: "housing", recurringId: "mort", recurringOccurrence: `2026-${m}` });
    transactions.push({ id: "s" + m, amount: 200, date: `2026-${m}-02`, categoryId: "shopping", recurringId: "sofa", recurringOccurrence: `2026-${m}` });
    transactions.push({ id: "sv" + m, amount: 400, date: `2026-${m}-03`, categoryId: "savings" });
  });
  transactions.push({ id: "plumber", amount: 300, date: "2026-08-20", categoryId: "housing", subcategoryId: "house_maintenance" });
  // current period so far
  transactions.push({ id: "gcur", amount: 500, date: "2026-09-04", categoryId: "groceries" });
  transactions.push({ id: "ecur", amount: 200, date: "2026-09-10", categoryId: "eating_out" });
  transactions.push({ id: "mcur", amount: 1200, date: "2026-09-01", categoryId: "housing", recurringId: "mort", recurringOccurrence: "2026-09" });

  return {
    income: 4000,
    incomeSources: [{ payDay: 1 }],
    transactions,
    recurringExpenses: [
      { id: "mort", label: "Mortgage", amount: 1200, dayOfMonth: 1, active: true, installment: null, startMonth: null },
      { id: "sofa", label: "Sofa", amount: 200, dayOfMonth: 2, active: true, installment: { totalOwed: 2000 }, startMonth: null },
      { id: "old", label: "Cancelled gym", amount: 40, dayOfMonth: 3, active: false, installment: null, startMonth: null }
    ]
  };
}

describe("planner buckets", () => {
  const rules = { mort: { id: "mort" }, sofa: { id: "sofa", installment: { totalOwed: 2000 } } };

  it("sends recurring payments to bills or EMIs whatever their category", () => {
    expect(bucketForTx({ categoryId: "housing", recurringId: "mort" }, rules)).toBe("bills");
    expect(bucketForTx({ categoryId: "shopping", recurringId: "sofa" }, rules)).toBe("emis");
    expect(bucketForTx({ categoryId: "health", recurringId: "deleted-rule" }, rules)).toBe("bills");
  });

  it("splits car and housing by subcategory", () => {
    expect(bucketForTx({ categoryId: "car", subcategoryId: "fuel" }, rules)).toBe("commute");
    expect(bucketForTx({ categoryId: "car", subcategoryId: "parking" }, rules)).toBe("commute");
    expect(bucketForTx({ categoryId: "car", subcategoryId: "car_maintenance" }, rules)).toBe("car");
    expect(bucketForTx({ categoryId: "car" }, rules)).toBe("car");
    expect(bucketForTx({ categoryId: "transport" }, rules)).toBe("commute");
    expect(bucketForTx({ categoryId: "housing", subcategoryId: "emi" }, rules)).toBe("emis");
    expect(bucketForTx({ categoryId: "housing", subcategoryId: "house_maintenance" }, rules)).toBe("house");
    expect(bucketForTx({ categoryId: "housing", subcategoryId: "home_decoration" }, rules)).toBe("other");
    expect(bucketForTx({ categoryId: "housing" }, rules)).toBe("bills");
  });

  it("covers every category and leaves savings out", () => {
    expect(bucketForTx({ categoryId: "insurance" }, rules)).toBe("bills");
    expect(bucketForTx({ categoryId: "entertainment" }, rules)).toBe("flexible");
    expect(bucketForTx({ categoryId: "health" }, rules)).toBe("other");
    expect(bucketForTx({ categoryId: "something-new" }, rules)).toBe("other");
    expect(bucketForTx({ categoryId: "savings" }, rules)).toBe(null);
  });
});

describe("planner averages", () => {
  it("averages hand-logged spend over complete periods and reads rules at today's amounts", () => {
    const a = bucketAverages(fixture(), 3, now);
    expect(a.periodsUsed).toBe(3);
    expect(a.averages).toEqual({
      bills: 1200, emis: 200, groceries: 600, flexible: 150, commute: 120, house: 100, car: 0, other: 0
    });
  });

  it("ignores periods from before anything was logged", () => {
    const a = bucketAverages(fixture(), 6, now);
    expect(a.periodsUsed).toBe(3);
    expect(a.averages.groceries).toBe(600);
  });

  it("caps an instalment at what is left and drops inactive rules", () => {
    const st = fixture();
    st.recurringExpenses[1].installment.totalOwed = 650; // £600 already paid
    expect(fixedCommitments(st, now)).toEqual({ bills: 1200, emis: 50 });
  });

  it("returns zeros with nothing logged", () => {
    const a = bucketAverages({ incomeSources: [], transactions: [], recurringExpenses: [] }, 3, now);
    expect(a.periodsUsed).toBe(0);
    expect(a.averages.groceries).toBe(0);
  });
});

describe("planner current period", () => {
  it("totals this period's spend per bucket and measures how far through it is", () => {
    const a = currentPeriodActuals(fixture(), now);
    expect(a.key).toBe("2026-09");
    expect(a.spent.groceries).toBe(500);
    expect(a.spent.flexible).toBe(200);
    expect(a.spent.bills).toBe(1200);
    expect(a.totalDays).toBe(30);
    expect(a.daysLeft).toBe(15);
    expect(a.elapsed).toBeCloseTo(16 / 30);
  });
});

describe("planner stored plan", () => {
  it("gives the built-in pots when nothing is stored", () => {
    const plan = normalisePlan(null);
    expect(plan.pots.map((p) => p.id)).toEqual(DEFAULT_POTS.map((p) => p.id));
    expect(plan.thresholds).toEqual(DEFAULT_THRESHOLDS);
    expect(plan.window).toBe(3);
    expect(plan.savings).toEqual({ label: "Savings", account: "" });
  });

  it("keeps renamed labels, amounts and added pots, and drops rubbish", () => {
    const plan = normalisePlan({
      window: 6,
      thresholds: { green: 800, amber: 300 },
      savings: { label: "Rainy day", account: "Marcus" },
      pots: [
        { id: "groceries", label: "Food", amount: "550", account: "cur acc" },
        { id: "commute", estimate: -5 },
        { id: "x1", label: "Cleaning service", type: "expense", amount: 60 },
        { id: "x2", label: "Saving for car", type: "future", amount: 150, account: "ISA" },
        { id: "x3", label: "  ", type: "savings", amount: 10 },
        { id: "x4", label: "Odd type", type: "nonsense" },
        null
      ]
    });
    expect(plan.window).toBe(6);
    expect(plan.thresholds).toEqual({ green: 800, amber: 300 });
    expect(plan.savings).toEqual({ label: "Rainy day", account: "Marcus" });
    const groceries = plan.pots.find((p) => p.id === "groceries");
    expect(groceries).toMatchObject({ label: "Food", amount: 550, account: "cur acc", type: "expense" });
    expect(plan.pots.find((p) => p.id === "commute").estimate).toBe(null);
    expect(plan.pots.slice(DEFAULT_POTS.length).map((p) => [p.id, p.type])).toEqual([["x1", "expense"], ["x2", "future"], ["x4", "expense"]]);
  });

  it("falls back to default thresholds when they are back to front", () => {
    expect(normalisePlan({ thresholds: { green: 100, amber: 400 } }).thresholds).toEqual(DEFAULT_THRESHOLDS);
  });

  it("resolves blanks: estimate from the average, allocation from the estimate", () => {
    const plan = normalisePlan({ pots: [{ id: "groceries", estimate: 650 }, { id: "flexible", amount: 100 }, { id: "x1", label: "Car fund", type: "future" }] });
    const pots = resolvePots(plan, bucketAverages(fixture(), 3, now).averages);
    const by = (id) => pots.find((p) => p.id === id);
    expect(by("groceries")).toMatchObject({ average: 600, estimate: 650, amount: 650, estimateEdited: true, amountEdited: false });
    expect(by("flexible")).toMatchObject({ average: 150, estimate: 150, amount: 100, amountEdited: true });
    expect(by("commute")).toMatchObject({ estimate: 120, amount: 120 });
    expect(by("x1")).toMatchObject({ average: null, estimate: null, amount: 0 });
  });
});

describe("planner colours", () => {
  const pot = { type: "expense", bucket: "groceries", fixed: false, amount: 600 };

  it("is red over the pot, amber ahead of pace, green otherwise", () => {
    expect(potStatus(pot, 601, 0.5)).toBe("red");
    expect(potStatus(pot, 500, 0.5)).toBe("amber"); // 83% used at 50% through
    expect(potStatus(pot, 380, 0.5)).toBe("green"); // 63% — inside the margin
    expect(potStatus(pot, 0, 0.1)).toBe("green");
    expect(potStatus(pot, 600, 1)).toBe("green");
  });

  it("is red for any spend from an empty pot", () => {
    expect(potStatus({ type: "expense", bucket: "car", fixed: false, amount: 0 }, 20, 0.5)).toBe("red");
    expect(potStatus({ type: "expense", bucket: "car", fixed: false, amount: 0 }, 0, 0.5)).toBe("green");
  });

  it("leaves fixed costs and user-added pots neutral", () => {
    expect(potStatus({ type: "expense", bucket: "bills", fixed: true, amount: 100 }, 900, 0.1)).toBe("neutral");
    expect(potStatus({ type: "expense", bucket: null, fixed: false, amount: 60 }, 0, 0.5)).toBe("neutral");
    expect(potStatus({ type: "future", bucket: null, fixed: false, amount: 150 }, 0, 0.5)).toBe("neutral");
  });
});

describe("planner savings", () => {
  const pots = [
    { label: "Bills", type: "expense", fixed: true, amount: 1200, average: 1200, account: "cur acc" },
    { label: "Groceries", type: "expense", fixed: false, amount: 700, average: 600, account: "cur acc" },
    { label: "Fun", type: "expense", fixed: false, amount: 900, average: 150, account: "" },
    { label: "Car fund", type: "future", fixed: false, amount: 150, average: null, account: "ISA" }
  ];

  it("takes expense pots off income and counts savings and future pots as saved", () => {
    const s = savingsSummary(3500, pots, DEFAULT_THRESHOLDS);
    expect(s).toEqual({ expenses: 2800, named: 150, total: 700, unassigned: 550, status: "green" });
  });

  it("colours on the 500 and 200 boundaries", () => {
    expect(savingsSummary(3300, pots, DEFAULT_THRESHOLDS).status).toBe("green"); // exactly 500
    expect(savingsSummary(3299, pots, DEFAULT_THRESHOLDS).status).toBe("amber");
    expect(savingsSummary(3000, pots, DEFAULT_THRESHOLDS).status).toBe("amber"); // exactly 200
    expect(savingsSummary(2999, pots, DEFAULT_THRESHOLDS).status).toBe("red");
    expect(savingsSummary(2000, pots, DEFAULT_THRESHOLDS)).toMatchObject({ total: -800, status: "red" });
  });

  it("is neutral without an income figure", () => {
    expect(savingsSummary(null, pots, DEFAULT_THRESHOLDS)).toMatchObject({ total: null, status: "neutral" });
  });

  it("flags named pots that promise more than is left", () => {
    expect(savingsSummary(2900, pots, DEFAULT_THRESHOLDS).unassigned).toBe(-50);
  });

  it("nudges towards the pot furthest above its average", () => {
    const s = savingsSummary(3100, pots, DEFAULT_THRESHOLDS);
    const n = savingsNudge(s, pots, DEFAULT_THRESHOLDS);
    expect(n.shortfall).toBe(200);
    expect(n.pot).toEqual({ label: "Fun", amount: 900, overAverage: 750 });
    expect(savingsNudge(savingsSummary(3500, pots, DEFAULT_THRESHOLDS), pots, DEFAULT_THRESHOLDS)).toBe(null);
  });

  it("groups payday transfers by account, case-insensitively, including unassigned savings", () => {
    const plan = { savings: { label: "Savings", account: "isa" } };
    const s = savingsSummary(3500, pots, DEFAULT_THRESHOLDS);
    expect(transferList(pots, plan, s)).toEqual([
      { account: "cur acc", total: 1900, pots: [{ label: "Bills", amount: 1200 }, { label: "Groceries", amount: 700 }] },
      { account: "ISA", total: 700, pots: [{ label: "Car fund", amount: 150 }, { label: "Savings", amount: 550 }] }
    ]);
  });
});

describe("planner pots linked to a direct debit", () => {
  // A £60 cleaning direct debit, paid in every period including this one.
  function withCleaning() {
    const st = fixture();
    st.recurringExpenses.push({ id: "clean", label: "Cleaning", amount: 60, dayOfMonth: 5, active: true, installment: null, startMonth: null });
    ["06", "07", "08", "09"].forEach((m) => {
      st.transactions.push({ id: "c" + m, amount: 60, date: `2026-${m}-05`, categoryId: "bills", recurringId: "clean", recurringOccurrence: `2026-${m}` });
    });
    return st;
  }

  it("counts the direct debit in bills while no pot is linked to it", () => {
    const p = computePlanner(withCleaning(), null, now);
    expect(p.pots.find((x) => x.id === "bills")).toMatchObject({ amount: 1260, spent: 1260 });
  });

  it("moves it out of bills into the linked pot, so it is counted once", () => {
    const plain = computePlanner(withCleaning(), null, now);
    const p = computePlanner(withCleaning(), { pots: [{ id: "x1", label: "Cleaning service", type: "expense", amount: 60, recurringId: "clean" }] }, now);
    expect(p.pots.find((x) => x.id === "bills")).toMatchObject({ amount: 1200, spent: 1200 });
    expect(p.pots.find((x) => x.id === "x1")).toMatchObject({ amount: 60, average: 60, spent: 60, left: 0, fixed: true, status: "neutral" });
    expect(p.summary.total).toBe(plain.summary.total);
  });

  it("ignores a link on a savings or future pot", () => {
    const plan = normalisePlan({ pots: [{ id: "x1", label: "Car fund", type: "future", amount: 100, recurringId: "clean" }] });
    expect(plan.pots.find((x) => x.id === "x1")).toMatchObject({ recurringId: null, bucket: null });
  });
});

describe("computePlanner", () => {
  it("joins plan, averages and this period's spend", () => {
    const p = computePlanner(fixture(), { pots: [{ id: "x1", label: "Car fund", type: "future", amount: 300 }] }, now);
    const by = (id) => p.pots.find((x) => x.id === id);
    expect(by("groceries")).toMatchObject({ amount: 600, spent: 500, left: 100, status: "amber" });
    expect(by("flexible")).toMatchObject({ amount: 150, spent: 200, left: -50, status: "red" });
    expect(by("commute")).toMatchObject({ amount: 120, spent: 0, status: "green" });
    expect(by("bills").status).toBe("neutral");
    expect(by("x1")).toMatchObject({ spent: null, status: "neutral" });
    // 4000 - (1200 + 200 + 600 + 150 + 120 + 100) = 1630 saved, 300 of it named
    expect(p.summary).toMatchObject({ expenses: 2370, named: 300, total: 1630, unassigned: 1330, status: "green" });
    expect(p.nudge).toBe(null);
    expect(p.period.daysLeft).toBe(15);
  });
});
