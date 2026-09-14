import { describe, expect, it } from "vitest";
import { todayStr } from "../../src/lib/index.js";
import { recurringOccurrenceDate, installmentRemaining, generateRecurringTransactions } from "../../src/recurring/index.js";

const now = new Date(2026, 8, 20);

describe("recurring", () => {
  it("clamps the occurrence day to the month", () => {
    expect(todayStr(recurringOccurrenceDate({ dayOfMonth: 31 }, "2026-09"))).toBe("2026-09-30");
  });

  it("installment remaining", () => {
    const rule = { id: "r1", installment: { totalOwed: 100 } };
    const txs = [{ recurringId: "r1", amount: 30 }, { recurringId: "r1", amount: 25 }, { recurringId: "other", amount: 99 }];
    expect(installmentRemaining(rule, txs)).toBe(45);
    expect(installmentRemaining({ id: "r2" }, txs)).toBeNull();
    expect(installmentRemaining(rule, [{ recurringId: "r1", amount: 150 }])).toBe(0);
  });

  it("backfills missed occurrences from the floor, without mutating input", () => {
    const rules = [
      { id: "r1", active: true, dayOfMonth: 1, amount: 10, categoryId: "bills", label: "Phone" },
      { id: "r2", active: true, dayOfMonth: 25, amount: 20, categoryId: "bills", label: "Gym" },
      { id: "r3", active: true, dayOfMonth: 16, amount: 60, categoryId: "other", label: "Sofa", installment: { totalOwed: 100 } },
      { id: "r4", active: false, dayOfMonth: 1, amount: 5, categoryId: "bills", label: "Off" },
      { id: "r5", active: true, dayOfMonth: 1, amount: 7, categoryId: "bills", label: "Late", startMonth: "2026-10" }
    ];
    const existing = [];
    const created = generateRecurringTransactions(rules, existing, now);
    expect(existing).toHaveLength(0);
    expect(created.map((t) => [t.recurringId, t.recurringOccurrence, t.date, t.amount])).toEqual([
      ["r1", "2026-09", "2026-09-01", 10], // Aug 1 is before the 15 Aug floor
      ["r2", "2026-08", "2026-08-25", 20], // Sep 25 hasn't happened yet
      ["r3", "2026-08", "2026-08-16", 60],
      ["r3", "2026-09", "2026-09-16", 40] // capped to what's left owing
    ]);
    expect(created[0]).toMatchObject({ categoryId: "bills", note: "Phone" });
  });

  it("skips occurrences already logged", () => {
    const rules = [{ id: "r1", active: true, dayOfMonth: 1, amount: 10, categoryId: "bills", label: "Phone" }];
    const existing = [{ recurringId: "r1", recurringOccurrence: "2026-09", amount: 10 }];
    expect(generateRecurringTransactions(rules, existing, now)).toEqual([]);
  });
});
