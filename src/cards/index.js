// Credit cards domain.
// Which transactions went on a card, when card statements close and fall
// due, which statements still need a balance recorded, and how much has been
// paid towards each (partly, in full, or more than the statement).

import { todayStr, nextOccurrence, lastOccurrence } from "../lib/index.js";
import { CARD_ALIASES } from "../categories/index.js";

// Maps the "PCC"/"RCC" payment-method shorthands to the matching credit card
// (matched by id first, falling back to the label so a renamed/re-seeded card
// still resolves).
export function cardForPaymentMethod(pm, creditCards) {
  var alias = CARD_ALIASES[pm];
  if (!alias) return null;
  var byId = creditCards.filter(function (c) { return c.id === alias.id; })[0];
  if (byId) return byId;
  return creditCards.filter(function (c) { return alias.label.test(c.label); })[0] || null;
}

export function isCardTransaction(t, creditCards) { return !!cardForPaymentMethod(t.paymentMethod, creditCards); }

function round2(n) { return Math.round(n * 100) / 100; }

// How much has gone towards a statement so far. Rows saved before
// paidAmount existed have it null — for those, "paid" meant paid in full.
export function paidSoFar(b) {
  if (b.paidAmount != null) return b.paidAmount;
  return b.paid ? b.amount : 0;
}

export function remainingDue(b) { return Math.max(0, round2(b.amount - paidSoFar(b))); }

// Paid on top of the statement — typically to cover purchases made after it
// closed. The bank takes it off the next statement.
export function extraPaid(b) { return Math.max(0, round2(paidSoFar(b) - b.amount)); }

// Cash that leaves the bank for this statement: the statement amount, or
// more if it was overpaid. Counting the extra here (and letting the next,
// smaller statement count only itself) means every pound is counted once.
export function statementCashOut(b) { return Math.max(b.amount, paidSoFar(b)); }

// New paid fields for a statement once `totalPaid` in all has gone towards
// it, the latest payment on `dateStr`. A total of 0 marks it unpaid again.
export function cardPaymentFields(b, totalPaid, dateStr) {
  var total = round2(Math.max(0, totalPaid));
  return {
    paidAmount: total,
    paid: total >= b.amount,
    paidDate: total > 0 ? dateStr : null
  };
}

// Adds one payment of `amount` on `dateStr` to whatever was already paid.
export function applyCardPayment(b, amount, dateStr) {
  return cardPaymentFields(b, paidSoFar(b) + amount, dateStr);
}

// Card statements whose *due date* falls inside [startStr, endExclusiveStr).
// Every card pound is counted in exactly one due-date period — see
// cycleFinancials in src/cashflow.
export function cardDuesInRange(cardBalances, startStr, endExclusiveStr) {
  return cardBalances
    .filter(function (b) { return b.dueDate >= startStr && b.dueDate < endExclusiveStr; })
    .reduce(function (s, b) { return s + statementCashOut(b); }, 0);
}

// Extra paid on this card's statement before `closeDateStr` — already taken
// off the statement closing on `closeDateStr` by the bank.
export function creditFromPreviousStatement(card, closeDateStr, cardBalances) {
  var prev = cardBalances
    .filter(function (b) { return b.cardId === card.id && b.statementDate < closeDateStr; })
    .sort(function (a, b) { return a.statementDate < b.statementDate ? -1 : 1; })
    .slice(-1)[0];
  return prev ? extraPaid(prev) : 0;
}

// The most recent statement per card that has had any payment made towards
// it — what "edit a payment" works on.
export function latestPaymentPerCard(creditCards, cardBalances) {
  var out = [];
  creditCards.forEach(function (c) {
    var latest = cardBalances
      .filter(function (b) { return b.cardId === c.id && paidSoFar(b) > 0; })
      .sort(function (a, b) { return a.statementDate < b.statementDate ? -1 : 1; })
      .slice(-1)[0];
    if (latest) out.push({ card: c, balance: latest });
  });
  return out;
}

// Which statement a card purchase made on `dateStr` will be billed on, and
// when that statement is due. A purchase ON the statement's closing day is
// included in that day's statement; anything after rolls to the next one.
export function cardSettlement(card, dateStr) {
  var purchase = new Date(dateStr + "T00:00:00");
  var closeDate = nextOccurrence(card.statementDay, purchase);
  var dueDate = nextOccurrence(card.paymentDay, closeDate);
  return { closeDateStr: todayStr(closeDate), dueDateStr: todayStr(dueDate) };
}

export function statementDueDate(card, statementDate) {
  return todayStr(nextOccurrence(card.paymentDay, new Date(statementDate + "T00:00:00")));
}

// Every statement day for each card that has already closed and has no
// recorded balance yet. Walks forward from the statement after the last one
// recorded (or, for a card with no history, just its latest closed statement,
// so a freshly-added card isn't flooded with old reminders).
export function pendingCardReminders(creditCards, cardBalances, now) {
  now = now || new Date();
  var out = [];
  creditCards.forEach(function (c) {
    var latestCloseForCard = lastOccurrence(c.statementDay, now);
    var recorded = cardBalances.filter(function (b) { return b.cardId === c.id; });
    var cursor;
    if (recorded.length) {
      var mostRecentStr = recorded.map(function (b) { return b.statementDate; }).sort().slice(-1)[0];
      cursor = nextOccurrence(c.statementDay, new Date(mostRecentStr + "T00:00:00"));
    } else {
      cursor = latestCloseForCard;
    }
    var guard = 0;
    while (cursor <= latestCloseForCard && guard < 24) {
      var stmtDateStr = todayStr(cursor);
      var exists = recorded.some(function (b) { return b.statementDate === stmtDateStr; });
      if (!exists) out.push({ card: c, statementDate: stmtDateStr });
      cursor = nextOccurrence(c.statementDay, new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1));
      guard++;
    }
  });
  return out;
}

// Sum of this card's transactions since the previous statement closed, up to
// and including this one — what the real statement *should* show if every
// purchase on the card was logged.
export function derivedStatementAmount(card, closeDateStr, transactions, creditCards) {
  var dayBefore = new Date(new Date(closeDateStr + "T00:00:00").getTime() - 86400000);
  var prevCloseStr = todayStr(lastOccurrence(card.statementDay, dayBefore));
  return transactions
    .filter(function (t) {
      if (t.date <= prevCloseStr || t.date > closeDateStr) return false;
      var tc = cardForPaymentMethod(t.paymentMethod, creditCards);
      return !!tc && tc.id === card.id;
    })
    .reduce(function (s, t) { return s + t.amount; }, 0);
}

// What the statement closing on `closeDateStr` should be: purchases logged in
// the cycle, less anything overpaid on the previous statement.
export function suggestedStatementAmount(card, closeDateStr, transactions, creditCards, cardBalances) {
  var derived = derivedStatementAmount(card, closeDateStr, transactions, creditCards);
  return Math.max(0, round2(derived - creditFromPreviousStatement(card, closeDateStr, cardBalances)));
}
