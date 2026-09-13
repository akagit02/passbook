import { describe, expect, it } from "vitest";
import { dateInMonth, nextOccurrence, lastOccurrence, todayStr } from "../../src/lib/index.js";
import {
  cardForPaymentMethod, isCardTransaction, cardDuesInRange, cardSettlement, statementDueDate,
  pendingCardReminders, derivedStatementAmount
} from "../../src/cards/index.js";

const premium = { id: "premium", label: "Premium", statementDay: 5, paymentDay: 25 };
const regular = { id: "x", label: "My Regular card", statementDay: 10, paymentDay: 1 };
const creditCards = [premium, regular];

describe("lib date occurrence helpers", () => {
  it("clamps and finds next/last occurrences", () => {
    expect(todayStr(dateInMonth(2026, 1, 31))).toBe("2026-02-28");
    expect(todayStr(nextOccurrence(31, new Date(2026, 1, 10)))).toBe("2026-02-28");
    expect(todayStr(nextOccurrence(5, new Date(2026, 8, 6)))).toBe("2026-10-05");
    expect(todayStr(lastOccurrence(20, new Date(2026, 8, 10)))).toBe("2026-08-20");
    expect(todayStr(lastOccurrence(10, new Date(2026, 8, 10)))).toBe("2026-09-10");
  });
});

describe("cards", () => {
  it("resolves payment methods to cards by id, then label", () => {
    expect(cardForPaymentMethod("PCC", creditCards)).toBe(premium);
    expect(cardForPaymentMethod("RCC", creditCards)).toBe(regular);
    expect(cardForPaymentMethod("sal acc", creditCards)).toBeNull();
    expect(cardForPaymentMethod("RCC", [premium])).toBeNull();
    expect(isCardTransaction({ paymentMethod: "PCC" }, creditCards)).toBe(true);
    expect(isCardTransaction({ paymentMethod: "cur acc" }, creditCards)).toBe(false);
  });

  it("sums statements by due date within a half-open range", () => {
    const balances = [
      { dueDate: "2026-09-01", amount: 100 },
      { dueDate: "2026-09-14", amount: 50 },
      { dueDate: "2026-09-15", amount: 999 }
    ];
    expect(cardDuesInRange(balances, "2026-09-01", "2026-09-15")).toBe(150);
  });

  it("purchases on the closing day land on that statement", () => {
    expect(cardSettlement(premium, "2026-09-05")).toEqual({ closeDateStr: "2026-09-05", dueDateStr: "2026-09-25" });
    expect(cardSettlement(premium, "2026-09-06")).toEqual({ closeDateStr: "2026-10-05", dueDateStr: "2026-10-25" });
    expect(statementDueDate(premium, "2026-09-05")).toBe("2026-09-25");
  });

  it("lists every unrecorded closed statement", () => {
    const now = new Date(2026, 8, 20);
    expect(pendingCardReminders([premium], [], now).map((r) => r.statementDate)).toEqual(["2026-09-05"]);
    const recorded = [{ cardId: "premium", statementDate: "2026-07-05" }];
    expect(pendingCardReminders([premium], recorded, now).map((r) => r.statementDate)).toEqual(["2026-08-05", "2026-09-05"]);
  });

  it("derives a statement amount from this card's transactions since the last close", () => {
    const txs = [
      { date: "2026-08-05", paymentMethod: "PCC", amount: 10 },
      { date: "2026-08-06", paymentMethod: "PCC", amount: 20 },
      { date: "2026-09-05", paymentMethod: "PCC", amount: 30 },
      { date: "2026-09-06", paymentMethod: "PCC", amount: 40 },
      { date: "2026-08-20", paymentMethod: "sal acc", amount: 50 },
      { date: "2026-08-20", paymentMethod: "RCC", amount: 60 }
    ];
    expect(derivedStatementAmount(premium, "2026-09-05", txs, creditCards)).toBe(50);
  });
});
