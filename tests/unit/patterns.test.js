import { describe, expect, it } from "vitest";
import { groupTxByCategory, computeCategoryPattern, computePatternsData } from "../../src/patterns/index.js";

const now = new Date(2026, 8, 20);

describe("patterns", () => {
  it("groups by category", () => {
    const a = { categoryId: "a" }, b = { categoryId: "b" }, a2 = { categoryId: "a" };
    expect(groupTxByCategory([a, b, a2])).toEqual({ a: [a, a2], b: [b] });
  });

  it("computes frequency, spacing and weekday bias", () => {
    // 1, 8 and 15 Sep 2026 are all Tuesdays.
    const txs = [{ date: "2026-09-01", amount: 10 }, { date: "2026-09-08", amount: 20 }, { date: "2026-09-15", amount: 30 }];
    expect(computeCategoryPattern("x", txs)).toEqual({
      catId: "x", count: 3, avgAmount: 20, avgGapDays: 7, weekday: { day: 2, count: 3 }
    });
    expect(computeCategoryPattern("x", txs.slice(0, 2)).weekday).toBeNull();
  });

  it("builds rows with trends against the prior window, excluding savings", () => {
    const transactions = [
      { categoryId: "groceries", date: "2026-07-01", amount: 1 },
      { categoryId: "groceries", date: "2026-08-01", amount: 1 },
      { categoryId: "groceries", date: "2026-09-01", amount: 1 },
      { categoryId: "groceries", date: "2026-04-01", amount: 1 },
      { categoryId: "eating_out", date: "2026-09-10", amount: 1 },
      { categoryId: "eating_out", date: "2026-05-01", amount: 1 },
      { categoryId: "transport", date: "2026-09-05", amount: 1 },
      { categoryId: "savings", date: "2026-09-01", amount: 500 }
    ];
    const rows = computePatternsData(transactions, "3", now);
    expect(rows.map((r) => r.catId)).toEqual(["groceries", "eating_out", "transport"]);
    expect(rows[0].trend).toEqual({ kind: "up", pct: 200 });
    expect(rows[1].trend).toEqual({ kind: "flat" });
    expect(rows[2].trend).toEqual({ kind: "none" });

    const all = computePatternsData(transactions, "all", now);
    expect(all[0]).toMatchObject({ catId: "groceries", count: 4, trend: null });
  });
});
