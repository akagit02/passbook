import { describe, expect, it } from "vitest";
import {
  DEFAULT_POTS, DEFAULT_SAVINGS_POTS, DEFAULT_MARGINS, bucketForTx, bucketAverages, currentPeriodActuals,
  fixedCommitments, normalisePlan, normaliseWindow, windowKeys, validMargin, resolvePots, potStatus,
  savingsStatus, savingsSummary, savingsNudge, transferList, computePlanner
} from "../../src/planner/index.js";

const now = new Date(2026, 8, 16); // 16 Sep 2026 — payday on the 1st, so half-way through period "2026-09"

const ALL_POT_IDS = DEFAULT_POTS.map((p) => p.id).concat(DEFAULT_SAVINGS_POTS.map((p) => p.id));

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
  transactions.push({ id: "svcur", amount: 350, date: "2026-09-05", categoryId: "savings" });

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
    expect(bucketForTx({ categoryId: "shopping", subcategoryId: "gift" }, rules)).toBe("flexible");
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

  it("can average over just the last pay period, the one in progress, or a custom range", () => {
    // Aug is the only period with the £300 plumber.
    expect(bucketAverages(fixture(), "last", now)).toMatchObject({ periodsUsed: 1, keys: ["2026-08"] });
    expect(bucketAverages(fixture(), "last", now).averages.house).toBe(300);

    // Sep so far: £500 groceries, £200 eating out; direct debits still read from the rules.
    const cur = bucketAverages(fixture(), "current", now);
    expect(cur.keys).toEqual(["2026-09"]);
    expect(cur.averages).toMatchObject({ groceries: 500, flexible: 200, bills: 1200, emis: 200, commute: 0 });

    const custom = bucketAverages(fixture(), { from: "2026-07", to: "2026-08" }, now);
    expect(custom.keys).toEqual(["2026-07", "2026-08"]);
    expect(custom.averages.house).toBe(150);
  });

  it("tidies stored windows", () => {
    expect(normaliseWindow(6)).toBe(6);
    expect(normaliseWindow("6")).toBe(6);
    expect(normaliseWindow("last")).toBe("last");
    expect(normaliseWindow("current")).toBe("current");
    expect(normaliseWindow(4)).toBe(3);
    expect(normaliseWindow(null)).toBe(3);
    expect(normaliseWindow({ from: "2026-08", to: "2026-06" })).toEqual({ from: "2026-06", to: "2026-08" });
    expect(normaliseWindow({ from: "rubbish", to: "2026-06" })).toBe(3);
  });

  it("stops a custom range at the period in progress", () => {
    expect(windowKeys({ from: "2026-08", to: "2026-12" }, 1, now)).toEqual(["2026-08", "2026-09"]);
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

  it("reads actual saving from the ledger rows contributions write", () => {
    expect(currentPeriodActuals(fixture(), now).saved).toBe(350);
    // Last period's £400 belongs to last period, not this one.
    expect(currentPeriodActuals(fixture(), new Date(2026, 7, 16)).saved).toBe(400);
  });
});

describe("planner stored plan", () => {
  it("gives the built-in pots, including the cash-left mini gullak, when nothing is stored", () => {
    const plan = normalisePlan(null);
    expect(plan.pots.map((p) => p.id)).toEqual(ALL_POT_IDS);
    expect(plan.pots.find((p) => p.id === "cash_left")).toMatchObject({ type: "savings", bucket: null, planned: null });
    expect(plan.margins).toEqual(DEFAULT_MARGINS);
    expect(plan.window).toBe(3);
    expect(plan.savings).toEqual({ label: "Savings", account: "", planned: null });
  });

  it("keeps renamed labels, planned figures and added pots, and drops rubbish", () => {
    const plan = normalisePlan({
      window: 6,
      margins: { expense: 5, savings: 35 },
      savings: { label: "Rainy day", account: "Marcus", planned: 900 },
      pots: [
        { id: "groceries", label: "Food", planned: "550", account: "cur acc" },
        { id: "commute", estimate: -5 },
        { id: "cash_left", label: "Spending money", planned: 120 },
        { id: "x1", label: "Cleaning service", type: "expense", planned: 60 },
        { id: "x2", label: "Saving for car", type: "future", planned: 150, account: "ISA" },
        { id: "x3", label: "  ", type: "savings", planned: 10 },
        { id: "x4", label: "Odd type", type: "nonsense" },
        null
      ]
    });
    expect(plan.window).toBe(6);
    expect(plan.margins).toEqual({ expense: 5, savings: 35 });
    expect(plan.savings).toEqual({ label: "Rainy day", account: "Marcus", planned: 900 });
    expect(plan.pots.find((p) => p.id === "groceries")).toMatchObject({ label: "Food", planned: 550, account: "cur acc", type: "expense" });
    expect(plan.pots.find((p) => p.id === "cash_left")).toMatchObject({ label: "Spending money", planned: 120 });
    expect(plan.pots.find((p) => p.id === "commute").estimate).toBe(null);
    expect(plan.pots.slice(ALL_POT_IDS.length).map((p) => [p.id, p.type])).toEqual([["x1", "expense"], ["x2", "future"], ["x4", "expense"]]);
  });

  it("still reads allocations saved under the old 'amount' key", () => {
    const plan = normalisePlan({ pots: [{ id: "groceries", amount: 480 }] });
    expect(plan.pots.find((p) => p.id === "groceries").planned).toBe(480);
  });

  it("falls back to default margins when they are not a percentage", () => {
    expect(normalisePlan({ margins: { expense: 150, savings: -2 } }).margins).toEqual(DEFAULT_MARGINS);
    expect(validMargin(0)).toBe(true);
    expect(validMargin(100)).toBe(true);
    expect(validMargin(101)).toBe(false);
    expect(validMargin("")).toBe(false);
    expect(validMargin(null)).toBe(false);
  });

  it("resolves blanks: estimate from the average, planned from the estimate", () => {
    const plan = normalisePlan({ pots: [{ id: "groceries", estimate: 650 }, { id: "flexible", planned: 100 }, { id: "x1", label: "Car fund", type: "future" }] });
    const pots = resolvePots(plan, bucketAverages(fixture(), 3, now).averages);
    const by = (id) => pots.find((p) => p.id === id);
    expect(by("groceries")).toMatchObject({ average: 600, estimate: 650, planned: 650, estimateEdited: true, plannedEdited: false });
    expect(by("flexible")).toMatchObject({ average: 150, estimate: 150, planned: 100, plannedEdited: true });
    expect(by("commute")).toMatchObject({ estimate: 120, planned: 120 });
    expect(by("x1")).toMatchObject({ average: null, estimate: null, planned: 0 });
  });
});

describe("planner colours", () => {
  const pot = { type: "expense", bucket: "groceries", fixed: false, planned: 600 };

  it("is red over plan, amber within the margin of it, green below that", () => {
    expect(potStatus(pot, 601, 10)).toBe("red");
    expect(potStatus(pot, 600, 10)).toBe("amber"); // exactly on plan
    expect(potStatus(pot, 540, 10)).toBe("amber"); // exactly 10% short
    expect(potStatus(pot, 539, 10)).toBe("green");
    expect(potStatus(pot, 0, 10)).toBe("green");
  });

  it("takes the margin from the plan, so a wider one turns amber sooner", () => {
    expect(potStatus(pot, 400, 10)).toBe("green");
    expect(potStatus(pot, 400, 40)).toBe("amber"); // 600 * 0.6 = 360
  });

  it("colours fixed costs too — a direct debit can still overshoot its plan", () => {
    expect(potStatus({ type: "expense", bucket: "bills", fixed: true, planned: 1200 }, 1300, 10)).toBe("red");
    expect(potStatus({ type: "expense", bucket: "bills", fixed: true, planned: 1200 }, 900, 10)).toBe("green");
  });

  it("is red for any spend from a pot planned at nothing", () => {
    expect(potStatus({ type: "expense", bucket: "car", fixed: false, planned: 0 }, 20, 10)).toBe("red");
    expect(potStatus({ type: "expense", bucket: "car", fixed: false, planned: 0 }, 0, 10)).toBe("green");
  });

  it("leaves pots with no ledger behind them neutral", () => {
    expect(potStatus({ type: "expense", bucket: null, fixed: false, planned: 60 }, 0, 10)).toBe("neutral");
    expect(potStatus({ type: "future", bucket: null, fixed: false, planned: 150 }, 0, 10)).toBe("neutral");
  });

  it("colours saving the other way round — beating the plan is green", () => {
    expect(savingsStatus(700, 700, 20)).toBe("green");
    expect(savingsStatus(900, 700, 20)).toBe("green");
    expect(savingsStatus(699, 700, 20)).toBe("amber");
    expect(savingsStatus(560, 700, 20)).toBe("amber"); // exactly 20% short
    expect(savingsStatus(559, 700, 20)).toBe("red");
    expect(savingsStatus(0, null, 20)).toBe("neutral");
  });
});

describe("planner savings", () => {
  const pots = [
    { label: "Bills", type: "expense", fixed: true, planned: 1200, average: 1200, account: "cur acc" },
    { label: "Groceries", type: "expense", fixed: false, planned: 700, average: 600, account: "cur acc" },
    { label: "Fun", type: "expense", fixed: false, planned: 900, average: 150, account: "" },
    { label: "Car fund", type: "future", fixed: false, planned: 150, average: null, account: "ISA" }
  ];
  const plan = (savings) => ({ savings: Object.assign({ label: "Savings", account: "isa", planned: null }, savings), margins: DEFAULT_MARGINS });

  it("plans the saving as income less planned expenses, and tracks it against what was really saved", () => {
    const s = savingsSummary(3500, pots, plan(), 700);
    expect(s).toEqual({
      plannedExpenses: 2800, available: 700, planned: 700, plannedEdited: false,
      actual: 700, diff: 0, assigned: 150, unassigned: 550, status: "green"
    });
  });

  it("colours on how far short of plan the saving fell", () => {
    expect(savingsSummary(3500, pots, plan(), 800).status).toBe("green");
    expect(savingsSummary(3500, pots, plan(), 699).status).toBe("amber");
    expect(savingsSummary(3500, pots, plan(), 560).status).toBe("amber");
    expect(savingsSummary(3500, pots, plan(), 559).status).toBe("red");
    expect(savingsSummary(3500, pots, plan(), 0)).toMatchObject({ diff: -700, status: "red" });
  });

  it("uses a planned saving the user typed in place of what income leaves over", () => {
    const s = savingsSummary(3500, pots, plan({ planned: 1000 }), 700);
    expect(s).toMatchObject({ available: 700, planned: 1000, plannedEdited: true, diff: -300, unassigned: 850, status: "red" });
  });

  it("is neutral without an income figure", () => {
    expect(savingsSummary(null, pots, plan(), 400)).toMatchObject({ available: null, planned: null, diff: null, unassigned: null, status: "neutral" });
  });

  it("flags mini gullaks that promise more than the savings gullak holds", () => {
    expect(savingsSummary(2900, pots, plan(), 100).unassigned).toBe(-50);
  });

  it("nudges towards the pot furthest above its average", () => {
    const n = savingsNudge(savingsSummary(3500, pots, plan(), 500), pots);
    expect(n.shortfall).toBe(200);
    expect(n.pot).toEqual({ label: "Fun", planned: 900, overAverage: 750 });
    expect(savingsNudge(savingsSummary(3500, pots, plan(), 700), pots)).toBe(null);
  });

  it("groups payday transfers by account, case-insensitively, including the loose savings", () => {
    const p = plan();
    expect(transferList(pots, p, savingsSummary(3500, pots, p, 700))).toEqual([
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
    expect(p.pots.find((x) => x.id === "bills")).toMatchObject({ planned: 1260, actual: 1260 });
  });

  it("moves it out of bills into the linked pot, so it is counted once", () => {
    const plain = computePlanner(withCleaning(), null, now);
    const p = computePlanner(withCleaning(), { pots: [{ id: "x1", label: "Cleaning service", type: "expense", planned: 60, recurringId: "clean" }] }, now);
    expect(p.pots.find((x) => x.id === "bills")).toMatchObject({ planned: 1200, actual: 1200 });
    expect(p.pots.find((x) => x.id === "x1")).toMatchObject({ planned: 60, average: 60, actual: 60, left: 0, fixed: true, status: "amber" });
    expect(p.summary.planned).toBe(plain.summary.planned);
  });

  it("ignores a link on a savings or future pot", () => {
    const plan = normalisePlan({ pots: [{ id: "x1", label: "Car fund", type: "future", planned: 100, recurringId: "clean" }] });
    expect(plan.pots.find((x) => x.id === "x1")).toMatchObject({ recurringId: null, bucket: null });
  });
});

describe("computePlanner", () => {
  it("joins plan, averages and this period's spend and saving", () => {
    const p = computePlanner(fixture(), { pots: [{ id: "x1", label: "Car fund", type: "future", planned: 300 }] }, now);
    const by = (id) => p.pots.find((x) => x.id === id);
    expect(by("groceries")).toMatchObject({ planned: 600, actual: 500, left: 100, status: "green" });
    expect(by("flexible")).toMatchObject({ planned: 150, actual: 200, left: -50, status: "red" });
    expect(by("commute")).toMatchObject({ planned: 120, actual: 0, status: "green" });
    expect(by("bills")).toMatchObject({ planned: 1200, actual: 1200, status: "amber" });
    expect(p.period.daysLeft).toBe(15);
  });

  it("keeps the expense gullaks apart from the mini savings ones", () => {
    const p = computePlanner(fixture(), { pots: [{ id: "x1", label: "Car fund", type: "future", planned: 300 }] }, now);
    expect(p.pots.map((x) => x.id)).toEqual(DEFAULT_POTS.map((x) => x.id));
    expect(p.miniPots.map((x) => x.id)).toEqual(["cash_left", "x1"]);
  });

  it("plans the saving from what income leaves and compares it with what went in", () => {
    const p = computePlanner(fixture(), { pots: [{ id: "x1", label: "Car fund", type: "future", planned: 300 }] }, now);
    // 4000 − (1200 + 200 + 600 + 150 + 120 + 100) = 1630 planned; only £350 actually saved.
    expect(p.summary).toMatchObject({
      plannedExpenses: 2370, planned: 1630, actual: 350, diff: -1280, assigned: 300, unassigned: 1330, status: "red"
    });
    expect(p.nudge).toMatchObject({ shortfall: 1280, pot: { label: "Groceries", planned: 600 } });
  });
});
