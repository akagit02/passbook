import { describe, expect, it } from "vitest";
import { dateInMonth, nextOccurrence, lastOccurrence, todayStr } from "../../src/lib/index.js";
import {
  cardForPaymentMethod, isCardTransaction, cardDuesInRange, cardSettlement, statementDueDate,
  pendingCardReminders, derivedStatementAmount, paidSoFar, remainingDue, extraPaid, statementCashOut,
  applyCardPayment, cardPaymentFields, creditFromPreviousStatement, suggestedStatementAmount, latestPaymentPerCard
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

describe("card payments", () => {
  // Statement £300 on 10 Aug; £50 bought on 11 Aug; £120 more on 20 Aug;
  // £350 paid on 5 Sep (statement + the 11 Aug purchase).
  const pcc = { id: "pcc", label: "PCC", statementDay: 10, paymentDay: 5 };
  const aug = { id: "a", cardId: "pcc", statementDate: "2026-08-10", dueDate: "2026-09-05", amount: 300, paid: false, paidDate: null, paidAmount: null };

  it("treats rows from before paidAmount as paid in full or not at all", () => {
    expect(paidSoFar({ amount: 300, paid: true, paidAmount: null })).toBe(300);
    expect(paidSoFar({ amount: 300, paid: false, paidAmount: null })).toBe(0);
    expect(statementCashOut({ amount: 300, paid: true })).toBe(300);
  });

  it("records an overpayment as paid with the extra on top", () => {
    const fields = applyCardPayment(aug, 350, "2026-09-05");
    expect(fields).toEqual({ paidAmount: 350, paid: true, paidDate: "2026-09-05" });
    const paid = { ...aug, ...fields };
    expect(remainingDue(paid)).toBe(0);
    expect(extraPaid(paid)).toBe(50);
    expect(statementCashOut(paid)).toBe(350);
  });

  it("builds up part payments until the statement is covered", () => {
    const afterFirst = { ...aug, ...applyCardPayment(aug, 40, "2026-08-15") };
    expect(afterFirst.paid).toBe(false);
    expect(remainingDue(afterFirst)).toBe(260);
    expect(statementCashOut(afterFirst)).toBe(300);
    const afterSecond = { ...afterFirst, ...applyCardPayment(afterFirst, 260, "2026-09-05") };
    expect(afterSecond).toMatchObject({ paid: true, paidAmount: 300, paidDate: "2026-09-05" });
  });

  it("editing the total to 0 marks it unpaid again", () => {
    expect(cardPaymentFields(aug, 0, "2026-09-05")).toEqual({ paidAmount: 0, paid: false, paidDate: null });
  });

  it("takes the extra off the next statement's suggestion, counting every pound once", () => {
    const paidAug = { ...aug, ...applyCardPayment(aug, 350, "2026-09-05") };
    const txs = [
      { date: "2026-08-11", paymentMethod: "PCC", amount: 50 },
      { date: "2026-08-20", paymentMethod: "PCC", amount: 120 }
    ];
    const cards = [{ ...pcc, id: "premium" }];
    const bal = { ...paidAug, cardId: "premium" };
    expect(creditFromPreviousStatement(cards[0], "2026-09-10", [bal])).toBe(50);
    expect(suggestedStatementAmount(cards[0], "2026-09-10", txs, cards, [bal])).toBe(120);

    const sep = { cardId: "premium", statementDate: "2026-09-10", dueDate: "2026-10-05", amount: 120 };
    // £350 in Sep + £120 in Oct = £470 = 300 + 50 + 120 spent.
    expect(cardDuesInRange([bal, sep], "2026-09-01", "2026-11-01")).toBe(470);
  });

  it("never suggests a negative statement", () => {
    const bal = { ...aug, cardId: "premium", ...applyCardPayment(aug, 500, "2026-09-05") };
    expect(suggestedStatementAmount({ ...pcc, id: "premium" }, "2026-09-10", [], creditCards, [bal])).toBe(0);
  });

  it("finds the latest statement with a payment per card", () => {
    const older = { id: "o", cardId: "pcc", statementDate: "2026-07-10", amount: 100, paid: true };
    const newer = { ...aug, id: "n", paidAmount: 40 };
    const unpaid = { id: "u", cardId: "pcc", statementDate: "2026-09-10", amount: 90, paid: false };
    const out = latestPaymentPerCard([pcc, regular], [older, newer, unpaid]);
    expect(out).toHaveLength(1);
    expect(out[0].balance.id).toBe("n");
  });
});
