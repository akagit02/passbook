// Categories and payment method domain.
// Definitions, lookups, and classifiers for expense categories and payment methods.

// `discretionary` marks the categories the "where you could cut" analysis is
// allowed to suggest trimming. Everything without it is treated as a cost
// you can't simply decide to stop paying — it also forms the "essential
// spend" figure the emergency-fund target is sized against.
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
  { id: "car", label: "Car" },
  { id: "savings", label: "Savings" }
];

export const CAT_INDEX = {};
CATEGORIES.forEach(function (c, i) { CAT_INDEX[c.id] = i; });

// Optional second-level detail under a category. Not every category has
// subcategories, and a transaction never requires one — `subcategoriesFor`
// returns an empty list for anything not in this map, which is what lets the
// add-expense form show "no subcategory" instead of an error for those.
export const SUBCATEGORIES = {
  housing: [
    { id: "emi", label: "EMI" },
    { id: "house_maintenance", label: "House maintenance" },
    { id: "home_decoration", label: "Home decoration" }
  ],
  car: [
    { id: "car_maintenance", label: "Car maintenance" },
    { id: "fuel", label: "Fuel" },
    { id: "parking", label: "Parking" }
  ],
  health: [
    { id: "supplement", label: "Supplement" },
    { id: "medicines", label: "Medicines" },
    { id: "equipment", label: "Equipment" }
  ]
};

export function subcategoriesFor(categoryId) { return SUBCATEGORIES[categoryId] || []; }

export function subcategoryLabel(categoryId, subcategoryId) {
  if (!subcategoryId) return "";
  var found = subcategoriesFor(categoryId).filter(function (s) { return s.id === subcategoryId; })[0];
  return found ? found.label : "";
}

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

export function spendingTxs(txs) { return txs.filter(function (t) { return !isSavingsTx(t); }); }
