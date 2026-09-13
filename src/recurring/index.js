// Recurring payments / direct debits domain.

import { todayStr, shiftMonth, genId } from "../lib/index.js";

// Recurring transactions are never backfilled earlier than this date, no
// matter how old a rule's own start month is — keeps auto-generation from
// resurrecting history from before this feature's rollout.
export const RECURRING_BACKFILL_FLOOR = new Date(2026, 7, 15); // 15 Aug 2026
export const RECURRING_BACKFILL_FLOOR_MONTH = "2026-08";

export function recurringOccurrenceDate(rule, monthKey) {
  var parts = monthKey.split("-").map(Number);
  var y = parts[0], m = parts[1] - 1;
  var lastDay = new Date(y, m + 1, 0).getDate();
  var day = Math.min(rule.dayOfMonth, lastDay);
  return new Date(y, m, day);
}

export function installmentPaidSoFar(rule, transactions) {
  return transactions.reduce(function (s, t) {
    return t.recurringId === rule.id ? s + t.amount : s;
  }, 0);
}

export function installmentRemaining(rule, transactions) {
  if (!rule.installment) return null;
  var paid = installmentPaidSoFar(rule, transactions);
  var remaining = Math.round((rule.installment.totalOwed - paid) * 100) / 100;
  return Math.max(0, remaining);
}

// Works out every due-but-not-yet-logged recurring transaction — walking
// forward one month at a time from RECURRING_BACKFILL_FLOOR (or the rule's
// own startMonth if later) up through the current month — so a rule missed
// for several months gets every missed occurrence, not just the latest.
// Does not modify `transactions`; returns the new ones for the caller to add.
export function generateRecurringTransactions(rules, transactions, now) {
  now = now || new Date();
  var today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  var currentMk = todayStr(now).slice(0, 7);
  // Installment remaining amounts must see occurrences generated earlier in
  // this same pass, so work against a copy that grows as we go.
  var all = transactions.slice();
  var created = [];

  rules.forEach(function (rule) {
    if (!rule.active) return;
    var mk = (rule.startMonth && rule.startMonth > RECURRING_BACKFILL_FLOOR_MONTH) ? rule.startMonth : RECURRING_BACKFILL_FLOOR_MONTH;

    while (mk <= currentMk) {
      var already = all.some(function (t) { return t.recurringId === rule.id && t.recurringOccurrence === mk; });
      if (already) { mk = shiftMonth(mk, 1); continue; }

      var occDate = recurringOccurrenceDate(rule, mk);
      if (occDate > today0) break; // this and every later occurrence hasn't happened yet
      if (occDate < RECURRING_BACKFILL_FLOOR) { mk = shiftMonth(mk, 1); continue; }

      var amount = rule.amount;
      if (rule.installment) {
        var remaining = installmentRemaining(rule, all);
        if (remaining <= 0) break; // fully paid off — stop generating
        amount = Math.round(Math.min(amount, remaining) * 100) / 100;
      }

      var t = {
        id: genId(),
        amount: amount,
        date: todayStr(occDate),
        categoryId: rule.categoryId,
        note: rule.label,
        recurringId: rule.id,
        recurringOccurrence: mk
      };
      all.push(t);
      created.push(t);

      mk = shiftMonth(mk, 1);
    }
  });

  return created;
}
