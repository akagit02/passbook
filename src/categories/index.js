// Categories and payment method domain.
// Definitions, lookups, and classifiers for expense categories and payment methods.

export const CATEGORIES = [
  { id: "housing", label: "Housing" },
  { id: "groceries", label: "Groceries" },
  { id: "transport", label: "Transport" },
  { id: "eating_out", label: "Eating out", discretionary: true },
  { id: "bills", label: "Bills & utilities" },
  { id: "shopping", label: "Shopping", discretionary: true },
  { id: "health", label: "Health" },
  { id: "entertainment", label: "Entertainment", discretionary: true },
  { id: "other", label: "Other" },
  { id: "insurance", label: "Insurance" },
  { id: "savings", label: "Savings" }
];

export const CAT_INDEX = {};
CATEGORIES.forEach(function (c, i) { CAT_INDEX[c.id] = i; });

export const SAVINGS_CAT = "savings";

export const SAVINGS_VEHICLES = [
  { id: "savings_account", label: "Savings account", tier: "cash" },
  { id: "current_account", label: "Current account", tier: "cash" },
  { id: "cash", label: "Cash at home", tier: "cash" },
  { id: "cash_isa", label: "Cash ISA", tier: "low", isa: true },
  { id: "premium_bonds", label: "Premium bonds", tier: "low" },
  { id: "stocks_isa", label: "Stocks & shares ISA", tier: "growth", isa: true },
  { id: "stocks_general", label: "Stocks (outside an ISA)", tier: "growth" },
  { id: "pension", label: "Pension", tier: "growth" },
  { id: "other", label: "Something else", tier: "other" }
];

export const VEHICLE_BY_ID = {};
SAVINGS_VEHICLES.forEach(function (v) { VEHICLE_BY_ID[v.id] = v; });

export const TIER_LABELS = { cash: "Easy access cash", low: "Lower risk", growth: "Growth / market risk", other: "Other" };

export const ISA_ANNUAL_ALLOWANCE = 20000;
export const TAX_YEAR_START_MONTH = 3;
export const TAX_YEAR_START_DAY = 6;

export const PAYMENT_METHODS = ["PCC", "RCC", "sal acc", "wife sal acc", "cur acc"];

export const CARD_ALIASES = { PCC: { id: "premium", label: /premium/i }, RCC: { id: "regular", label: /regular/i } };

export function vehicleFor(id) { return VEHICLE_BY_ID[id] || VEHICLE_BY_ID.other; }

export function isSavingsTx(t) { return t.categoryId === SAVINGS_CAT; }

export function isCardTransaction(t, creditCards) {
  var alias = CARD_ALIASES[t.paymentMethod];
  if (!alias) return false;
  var byId = creditCards.filter(function (c) { return c.id === alias.id; })[0];
  if (byId) return true;
  return creditCards.filter(function (c) { return alias.label.test(c.label); }).length > 0;
}

export function spendingTxs(txs) { return txs.filter(function (t) { return !isSavingsTx(t); }); }
