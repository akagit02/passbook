import { describe, expect, it } from "vitest";
import {
  DEFAULT_THRESHOLDS, normaliseThresholds, statusFor, validThresholdPair,
  periodKeyForDate, windowPeriodKeys, selectablePeriodKeys, computeHealth, verdict
} from "../../src/health/index.js";

const now = new Date(2026, 8, 20); // 20 Sep 2026 — current pay period "2026-09" with payday on the 1st

function row(h, key) { return h.rows.find((r) => r.key === key); }

// Mar–Aug: £1,000 groceries every month (the essentials median). Jun–Aug:
// £300 put aside each. Aug also has a £2,000 shopping spree, so Aug's
// leftover is 3000 - 1000 - 300 - 2000 = -300 while Jun and Jul are positive.
function fixture() {
  const transactions = [];
  ["03", "04", "05", "06", "07", "08"].forEach((m) => {
    transactions.push({ id: "g" + m, amount: 1000, date: `2026-${m}-05`, categoryId: "groceries" });
  });
  ["06", "07", "08"].forEach((m) => {
    transactions.push({ id: "s" + m, amount: 300, date: `2026-${m}-10`, categoryId: "savings" });
  });
  transactions.push({ id: "spree", amount: 2000, date: "2026-08-20", categoryId: "shopping" });

  return {
    income: 3000,
    incomeSources: [{ payDay: 1 }],
    transactions,
    creditCards: [{ id: "c1", label: "Test card" }],
    cardBalances: [{ id: "b1", cardId: "c1", dueDate: "2026-07-04", amount: 100, paid: true, paidDate: "2026-07-01" }],
    recurringExpenses: [
      { id: "r1", label: "Sofa", amount: 500, dayOfMonth: 1, active: true, installment: { totalOwed: 2000 }, startMonth: null }
    ],
    savingsContributions: [{ id: "c", amount: 2500, date: "2026-06-10", vehicle: "savings_account" }],
    debts: [{ id: "d1", label: "Visa loan", originalAmount: 4400, startingBalance: 2600, active: true }],
    debtPayments: [{ id: "p1", debtId: "d1", amount: 200, date: "2026-08-28" }]
  };
}

describe("health thresholds", () => {
  it("colours higher-is-better and lower-is-better measures the right way round", () => {
    expect(statusFor("savingsRate", 20, DEFAULT_THRESHOLDS)).toBe("green");
    expect(statusFor("savingsRate", 12, DEFAULT_THRESHOLDS)).toBe("amber");
    expect(statusFor("savingsRate", 9, DEFAULT_THRESHOLDS)).toBe("red");
    expect(statusFor("debtLoad", 15, DEFAULT_THRESHOLDS)).toBe("green");
    expect(statusFor("debtLoad", 30, DEFAULT_THRESHOLDS)).toBe("amber");
    expect(statusFor("debtLoad", 40, DEFAULT_THRESHOLDS)).toBe("red");
  });

  it("rejects back-to-front or non-numeric pairs", () => {
    expect(validThresholdPair("savingsRate", 20, 10)).toBe(true);
    expect(validThresholdPair("savingsRate", 10, 20)).toBe(false);
    expect(validThresholdPair("debtLoad", 35, 15)).toBe(false);
    expect(validThresholdPair("debtLoad", NaN, 15)).toBe(false);
    expect(validThresholdPair("debtLoad", -1, 15)).toBe(false);
  });

  it("falls back per metric when stored values are missing or invalid", () => {
    const t = normaliseThresholds({ savingsRate: { green: 15, amber: 5 }, debtLoad: { green: 50, amber: 10 }, bufferMonths: { green: null, amber: 1 } });
    expect(t.savingsRate).toEqual({ green: 15, amber: 5 });
    expect(t.debtLoad).toEqual(DEFAULT_THRESHOLDS.debtLoad);
    expect(t.bufferMonths).toEqual(DEFAULT_THRESHOLDS.bufferMonths);
    expect(normaliseThresholds(null)).toEqual(DEFAULT_THRESHOLDS);
  });
});

describe("health windows", () => {
  it("maps a date to its pay period", () => {
    expect(periodKeyForDate("2026-09-14", 15)).toBe("2026-08");
    expect(periodKeyForDate("2026-09-15", 15)).toBe("2026-09");
  });

  it("uses the last n complete periods, or an inclusive custom range in either order", () => {
    expect(windowPeriodKeys({ count: 3 }, 1, now)).toEqual(["2026-06", "2026-07", "2026-08"]);
    expect(windowPeriodKeys({ from: "2026-09", to: "2026-07" }, 1, now)).toEqual(["2026-07", "2026-08", "2026-09"]);
  });

  it("offers periods from the first logged transaction up to now", () => {
    expect(selectablePeriodKeys(fixture(), now)).toEqual(["2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"]);
  });
});

describe("computeHealth", () => {
  const h = computeHealth(fixture(), { count: 3 }, null, now);

  it("savings rate averages the window and says how much more reaches green", () => {
    expect(row(h, "savingsRate")).toMatchObject({ status: "amber", pct: 10, avgSaved: 300, toGreen: 300 });
  });

  it("emergency buffer is easy-access savings over median essentials", () => {
    expect(row(h, "bufferMonths")).toMatchObject({ status: "amber", months: 2.5, essential: 1000, toGreen: 500 });
  });

  it("living within means counts over-budget periods", () => {
    const r = row(h, "withinMeans");
    expect(r).toMatchObject({ status: "amber", under: 2, total: 3, avgOver: 300, toGreen: 300 });
    expect(r.overs).toEqual([{ key: "2026-08", amount: 300 }]);
  });

  it("debt load only counts ledger repayments, but totals every balance left", () => {
    const r = row(h, "debtLoad");
    expect(r).toMatchObject({ status: "amber", pct: 17, monthly: 500, totalLeft: 3600, count: 2, outsideLedgerCount: 1 });
    expect(r.toGreen).toEqual({ label: "Sofa", remaining: 2000, pctAfter: 0, reachesGreen: true });
    // Sofa: 4 more £500 payments; Visa: £1,600 at £200 = 8 months — the later wins.
    expect(r.payoff).toBe("2027-05");
  });

  it("card discipline is green when every statement due was paid on time", () => {
    expect(row(h, "cardDiscipline")).toMatchObject({ status: "green", dueCount: 1, lateCount: 0 });
  });

  it("fixed commitments are active direct debits over income", () => {
    expect(row(h, "fixedCommitments")).toMatchObject({ status: "green", pct: 17, total: 500 });
  });

  it("verdict is okay when there are ambers but no reds", () => {
    expect(h.verdict).toEqual({ level: "okay", green: 2, amber: 4, red: 0 });
  });

  it("an overdue card balance makes the verdict need attention whatever the window", () => {
    const st = fixture();
    st.cardBalances.push({ id: "b2", cardId: "c1", dueDate: "2026-03-01", amount: 205.5, paid: false });
    const r = row(computeHealth(st, { count: 3 }, null, now), "cardDiscipline");
    expect(r).toMatchObject({ status: "red", overdueTotal: 205.5 });
    expect(r.overdue[0].cardLabel).toBe("Test card");
  });

  it("goes neutral rather than guessing when there's no income or no data", () => {
    const st = fixture();
    st.income = null;
    const noIncome = computeHealth(st, { count: 3 }, null, now);
    expect(row(noIncome, "savingsRate").status).toBe("neutral");
    expect(row(noIncome, "debtLoad").status).toBe("neutral");

    const empty = computeHealth({ income: 3000, incomeSources: [], transactions: [] }, { count: 6 }, null, now);
    expect(empty.usableCount).toBe(0);
    expect(empty.verdict.level).toBe("neutral");
  });

  it("ignores periods from before anything was logged", () => {
    const wide = computeHealth(fixture(), { count: 12 }, null, now);
    expect(wide.keys).toHaveLength(12);
    expect(wide.usableCount).toBe(6); // Mar–Aug
  });

  it("uses edited thresholds", () => {
    const lenient = computeHealth(fixture(), { count: 3 }, { savingsRate: { green: 10, amber: 5 } }, now);
    expect(row(lenient, "savingsRate").status).toBe("green");
  });
});

describe("verdict", () => {
  it("ignores neutral rows", () => {
    expect(verdict([{ status: "green" }, { status: "neutral" }])).toEqual({ level: "healthy", green: 1, amber: 0, red: 0 });
  });
});
