// Debts domain — debts tracked outside the ledger (see schema.sql for why
// these never touch `transactions`). A debt financed by a direct debit that
// *is* already in the ledger is a different case entirely, handled by
// recurring_expenses' installment fields — see src/recurring/index.js.

export function paymentsForDebt(debtId, payments) {
  return payments.filter(function (p) { return p.debtId === debtId; });
}

export function debtPaidSoFar(debt, payments) {
  var logged = paymentsForDebt(debt.id, payments).reduce(function (s, p) { return s + p.amount; }, 0);
  return Math.round((debt.startingBalance + logged) * 100) / 100;
}

export function debtRemaining(debt, payments) {
  var remaining = debt.originalAmount - debtPaidSoFar(debt, payments);
  return Math.max(0, Math.round(remaining * 100) / 100);
}

export function debtProgressPct(debt, payments) {
  if (debt.originalAmount <= 0) return 0;
  return Math.min(100, (debtPaidSoFar(debt, payments) / debt.originalAmount) * 100);
}
