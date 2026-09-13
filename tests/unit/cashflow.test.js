import { describe, expect, it } from "vitest";
import { sumBy, cycleFinancials } from "../../src/cashflow/index.js";

const creditCards = [{ id: "premium", label: "Premium", statementDay: 5, paymentDay: 25 }];
const txs = [
  { categoryId: "groceries", paymentMethod: "sal acc", amount: 100 },
  { categoryId: "eating_out", paymentMethod: "PCC", amount: 50 },
  { categoryId: "savings", paymentMethod: "sal acc", amount: 200 }
];

describe("cashflow", () => {
  it("sums by category", () => {
    expect(sumBy(txs)).toEqual({ groceries: 100, eating_out: 50, savings: 200 });
  });

  it("counts card spend via due statements, not purchases", () => {
    const ctx = { income: 2000, creditCards, cardBalances: [{ dueDate: "2026-09-20", amount: 300 }, { dueDate: "2026-10-20", amount: 999 }] };
    expect(cycleFinancials(txs, "2026-09-15", "2026-10-15", ctx)).toEqual({
      cashSpent: 100, putAside: 200, cardDues: 300, leftover: 1400
    });
  });

  it("leftover is null without an income", () => {
    const ctx = { income: null, creditCards, cardBalances: [] };
    expect(cycleFinancials(txs, "2026-09-15", "2026-10-15", ctx).leftover).toBeNull();
  });
});
