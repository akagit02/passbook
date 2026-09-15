import { describe, expect, it } from "vitest";
import { debtPaidSoFar, debtRemaining, debtProgressPct, paymentsForDebt } from "../../src/debts/index.js";

describe("debts", () => {
  const debt = { id: "d1", originalAmount: 4400, startingBalance: 2600 };
  const payments = [
    { id: "p1", debtId: "d1", amount: 200 },
    { id: "p2", debtId: "d1", amount: 100 },
    { id: "p3", debtId: "other", amount: 999 }
  ];

  it("only counts payments for the given debt", () => {
    expect(paymentsForDebt("d1", payments)).toHaveLength(2);
  });

  it("paid so far includes the starting balance already paid off", () => {
    expect(debtPaidSoFar(debt, payments)).toBe(2900);
  });

  it("remaining is original minus starting balance minus logged payments", () => {
    expect(debtRemaining(debt, payments)).toBe(1500);
  });

  it("remaining never goes negative once fully paid off", () => {
    const overpaid = [{ debtId: "d1", amount: 10000 }];
    expect(debtRemaining(debt, overpaid)).toBe(0);
  });

  it("progress percentage is paid over original, capped at 100", () => {
    expect(debtProgressPct(debt, payments)).toBeCloseTo((2900 / 4400) * 100);
    expect(debtProgressPct(debt, [{ debtId: "d1", amount: 100000 }])).toBe(100);
  });
});
