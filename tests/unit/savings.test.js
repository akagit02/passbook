import { describe, expect, it } from "vitest";
import {
  median, taxYearRange, monthlyTotals, medianEssentialMonthly, medianMonthlySavings, medianMonthlyLeftover,
  monthsBetween, goalProgress, cutCandidates, holdingsByVehicle, tierSplit, taxYearIsaSplit, reachableBuffer
} from "../../src/savings/index.js";

const now = new Date(2026, 8, 20);

describe("savings", () => {
  it("median", () => {
    expect(median([])).toBe(0);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it("tax year turns over on 6 April", () => {
    expect(taxYearRange(new Date(2026, 3, 5))).toMatchObject({ start: "2025-04-06", end: "2026-04-06", label: "2025/26" });
    expect(taxYearRange(new Date(2026, 3, 6)).label).toBe("2026/27");
  });

  it("monthly totals cover complete months only, oldest first", () => {
    const txs = [
      { date: "2026-07-10", categoryId: "groceries", amount: 100 },
      { date: "2026-08-10", categoryId: "groceries", amount: 200 },
      { date: "2026-08-11", categoryId: "eating_out", amount: 50 },
      { date: "2026-08-12", categoryId: "savings", amount: 400 },
      { date: "2026-09-10", categoryId: "groceries", amount: 999 }
    ];
    expect(monthlyTotals(txs, 2, () => true, now)).toEqual([100, 650]);
    expect(medianEssentialMonthly(txs, now)).toBe(0); // 6 months: [0,0,0,0,100,200]
    expect(medianMonthlySavings(txs, now)).toBe(0);
  });

  it("median leftover over past pay cycles", () => {
    const st = {
      income: 1000, incomeSources: [{ payDay: 1 }], cardBalances: [], creditCards: [],
      transactions: [{ date: "2026-08-10", categoryId: "groceries", paymentMethod: "sal acc", amount: 300 }]
    };
    expect(medianMonthlyLeftover(2, st, now)).toBe(850);
    expect(medianMonthlyLeftover(2, { ...st, income: null }, now)).toBeNull();
  });

  it("goal pacing", () => {
    expect(monthsBetween("2026-01-01", "2026-07-01")).toBe(6);
    const g = { id: "g1", targetAmount: 1000, targetDate: "2027-09-20", startDate: "2026-09-01" };
    const p = goalProgress(g, [{ goalId: "g1", amount: 200 }, { goalId: "g2", amount: 50 }], [], now);
    expect(p).toMatchObject({ saved: 200, remaining: 800, pct: 20, monthsLeft: 12, complete: false, overdue: false, tooNew: true });
    expect(p.requiredMonthly).toBeCloseTo(66.67, 2);
  });

  it("cut candidates use the median month and flag overshoot", () => {
    const txs = ["03", "04", "05", "06", "07"].map((m) => ({ date: `2026-${m}-10`, categoryId: "eating_out", amount: 100 }));
    txs.push({ date: "2026-08-10", categoryId: "eating_out", amount: 200 });
    const rows = cutCandidates(txs, now);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ base: 100, last: 200, trim: 25, overshoot: 100, perMonth: 1 });
    expect(rows[0].cat.id).toBe("eating_out");
    expect(rows[0].avgAmount).toBeCloseTo(133.33, 2);
  });

  it("holdings, tier split, ISA split and reachable buffer", () => {
    const contribs = [
      { vehicle: "cash_isa", amount: 300, date: "2026-09-01" },
      { vehicle: "stocks_isa", amount: 500, date: "2026-09-01" },
      { vehicle: "cash_isa", amount: 100, date: "2026-09-01" },
      { vehicle: "savings_account", amount: 250, date: "2026-09-01" }
    ];
    const rows = holdingsByVehicle(contribs);
    expect(rows.map((r) => [r.vehicle.id, r.amount])).toEqual([["stocks_isa", 500], ["cash_isa", 400], ["savings_account", 250]]);
    expect(tierSplit(rows, 1150)).toEqual([{ tier: "cash", pct: 22 }, { tier: "low", pct: 35 }, { tier: "growth", pct: 43 }]);
    expect(taxYearIsaSplit(contribs, taxYearRange(now))).toEqual({ isaUsed: 900, outsideIsa: 250 });
    expect(reachableBuffer(contribs)).toBe(650);
  });
});
