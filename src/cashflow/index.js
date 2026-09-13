// Cashflow domain.
// What a period's money actually did: spent, put aside, card dues, leftover.

import { isSavingsTx } from "../categories/index.js";
import { isCardTransaction, cardDuesInRange } from "../cards/index.js";

export function sumBy(txs) {
  var out = {};
  txs.forEach(function (t) { out[t.categoryId] = (out[t.categoryId] || 0) + t.amount; });
  return out;
}

// A card transaction is committed spend the moment it's logged, but its cash
// only leaves the bank when the statement it lands on is due — so leftover
// subtracts card statements by *due date*, never card purchases directly.
// Savings transfers are cash leaving now, tracked as their own figure so a
// big ISA transfer doesn't look like a shopping spree.
//
// ctx: { income, cardBalances, creditCards } — typically the app state.
export function cycleFinancials(txs, startStr, endExclusiveStr, ctx) {
  var cashSpent = 0;
  var putAside = 0;
  txs.forEach(function (t) {
    if (isSavingsTx(t)) { putAside += t.amount; return; }
    if (!isCardTransaction(t, ctx.creditCards)) cashSpent += t.amount;
  });
  var cardDues = cardDuesInRange(ctx.cardBalances, startStr, endExclusiveStr);
  var leftover = ctx.income == null ? null : ctx.income - cashSpent - putAside - cardDues;
  return { cashSpent: cashSpent, putAside: putAside, cardDues: cardDues, leftover: leftover };
}
