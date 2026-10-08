// Money flow domain.
// "Where did the money go" for a date range, as the slices of one pie. The
// filters decide how deep the pie looks: income split into spending, savings
// and what's left; spending by category; one category by subcategory; and
// finally by the card or account that paid.

import { shiftMonth } from "../lib/index.js";
import { CATEGORIES, CAT_INDEX, PAYMENT_METHODS, SAVINGS_VEHICLES, isSavingsTx, subcategoriesFor, subcategoryLabel, vehicleFor } from "../categories/index.js";
import { currentPeriodKey, periodStartStr, periodEndStr, txInRange } from "../periods/index.js";

// Filter value for "has no subcategory" / "no payment method recorded" —
// distinct from "" which means "don't filter".
export const NONE = "__none";

// A pie stops being readable past about six slices, so the smallest ones are
// drawn as a single "everything else" slice. The list beside it still shows
// every row.
export const MAX_SLICES = 6;

function round2(n) { return Math.round(n * 100) / 100; }
function sum(txs) { return round2(txs.reduce(function (s, t) { return s + t.amount; }, 0)); }
function dayMs(dateStr) { return new Date(dateStr + "T00:00:00").getTime(); }
function daysBetween(startStr, endStr) { return Math.round((dayMs(endStr) - dayMs(startStr)) / 86400000); }

// preset: "current" (the pay period in progress), "last" (the one before),
// or "3" / "6" / "12" for that many complete pay periods. End is exclusive.
export function presetRange(preset, startDay, now) {
  var cur = currentPeriodKey(startDay, now);
  if (preset === "current") return { start: periodStartStr(cur, startDay), end: periodEndStr(cur, startDay) };
  var n = preset === "last" ? 1 : parseInt(preset, 10) || 3;
  return { start: periodStartStr(shiftMonth(cur, -n), startDay), end: periodStartStr(cur, startDay) };
}

// Income is one figure per pay period, so a range earns it once per period
// it covers, and pro rata by days for a period it only partly covers.
export function incomeForRange(income, startStr, endExclusiveStr, startDay) {
  if (income == null || !(endExclusiveStr > startStr)) return income == null ? null : 0;
  var total = 0;
  var first = shiftMonth(startStr.slice(0, 7), -1);
  for (var mk = first, i = 0; i < 600; mk = shiftMonth(mk, 1), i++) {
    var pStart = periodStartStr(mk, startDay);
    if (pStart >= endExclusiveStr) break;
    var pEnd = periodEndStr(mk, startDay);
    var from = pStart > startStr ? pStart : startStr;
    var to = pEnd < endExclusiveStr ? pEnd : endExclusiveStr;
    if (to > from) total += income * (daysBetween(from, to) / daysBetween(pStart, pEnd));
  }
  return round2(total);
}

// Every payment method worth offering as a filter: the built-in shorthands
// first, then anything else that has been typed on a transaction. Also fixes
// each method's colour, so filtering never repaints the ones still showing.
export function paymentMethodsIn(transactions) {
  var extra = {};
  (transactions || []).forEach(function (t) {
    if (t.paymentMethod && PAYMENT_METHODS.indexOf(t.paymentMethod) === -1) extra[t.paymentMethod] = true;
  });
  return PAYMENT_METHODS.concat(Object.keys(extra).sort());
}

function group(txs, keyOf) {
  var by = {};
  var order = [];
  txs.forEach(function (t) {
    var k = keyOf(t);
    if (!by[k]) { by[k] = { key: k, amount: 0, count: 0 }; order.push(k); }
    by[k].amount += t.amount;
    by[k].count++;
  });
  return order.map(function (k) { by[k].amount = round2(by[k].amount); return by[k]; })
    .filter(function (g) { return g.amount > 0; })
    .sort(function (a, b) { return b.amount - a.amount || (a.key < b.key ? -1 : 1); });
}

// color: 1–12 is one of the app's --cat-N colours, 0 is the neutral grey.
function colorSlot(index) { return index < 0 ? 0 : (index % 12) + 1; }

function byCategory(txs) {
  return group(txs, function (t) { return CAT_INDEX[t.categoryId] == null ? "other" : t.categoryId; }).map(function (g) {
    g.label = CATEGORIES[CAT_INDEX[g.key]].label;
    g.color = colorSlot(CAT_INDEX[g.key]);
    g.drill = { categoryId: g.key };
    return g;
  });
}

function bySubcategory(txs, categoryId) {
  var known = subcategoriesFor(categoryId).map(function (s) { return s.id; });
  return group(txs, function (t) { return t.subcategoryId || NONE; }).map(function (g) {
    g.label = g.key === NONE ? "No subcategory" : subcategoryLabel(categoryId, g.key) || g.key;
    g.color = g.key === NONE ? 0 : colorSlot(known.indexOf(g.key) === -1 ? known.length : known.indexOf(g.key));
    g.drill = { subcategoryId: g.key };
    return g;
  });
}

function byPayment(txs, methods) {
  return group(txs, function (t) { return t.paymentMethod || NONE; }).map(function (g) {
    g.label = g.key === NONE ? "Not recorded" : g.key;
    g.color = g.key === NONE ? 0 : colorSlot(methods.indexOf(g.key));
    return g;
  });
}

function byVehicle(txs, contributions) {
  var vehicleOf = {};
  (contributions || []).forEach(function (c) { if (c.transactionId) vehicleOf[c.transactionId] = c.vehicle; });
  var ids = SAVINGS_VEHICLES.map(function (v) { return v.id; });
  return group(txs, function (t) { return vehicleFor(vehicleOf[t.id]).id; }).map(function (g) {
    g.label = vehicleFor(g.key).label;
    g.color = colorSlot(ids.indexOf(g.key));
    return g;
  });
}

// st: the app state. f: { start, end (exclusive), view, categoryId,
// subcategoryId, paymentMethod } where view is "overview" | "category" |
// "payment" | "savings" and the three filters are "" for "all".
//
// Returns the slices (largest first) plus the range's headline figures.
// `dimension` says what the slices are: "overview", "category",
// "subcategory", "payment" or "vehicle".
export function computeFlow(st, f, startDay) {
  var txs = txInRange(st.transactions || [], f.start, f.end);
  if (f.paymentMethod) {
    txs = txs.filter(function (t) { return f.paymentMethod === NONE ? !t.paymentMethod : t.paymentMethod === f.paymentMethod; });
  }
  var spendTxs = txs.filter(function (t) { return !isSavingsTx(t); });
  var savingsTxs = txs.filter(isSavingsTx);
  var spent = sum(spendTxs);
  var saved = sum(savingsTxs);
  // Income isn't paid "by" a card or account, so once a payment method is
  // picked there is no income figure to compare against.
  var income = f.paymentMethod ? null : incomeForRange(st.income, f.start, f.end, startDay);
  var unspent = income == null ? null : round2(income - spent - saved);

  var out = {
    spent: spent, saved: saved, income: income, unspent: unspent,
    spendCount: spendTxs.length, savingsCount: savingsTxs.length
  };

  if (f.view === "overview") {
    out.dimension = "overview";
    out.slices = [
      { key: "spending", label: "Spending", amount: spent, count: spendTxs.length, color: 3, drill: { view: "category" } },
      { key: "savings", label: "Savings", amount: saved, count: savingsTxs.length, color: 2, drill: { view: "savings" } }
    ];
    if (unspent > 0) out.slices.push({ key: "unspent", label: "Not spent or saved", amount: unspent, count: 0, color: 0 });
    out.slices = out.slices.filter(function (s) { return s.amount > 0; });
  } else if (f.view === "savings") {
    out.dimension = "vehicle";
    out.slices = byVehicle(savingsTxs, st.savingsContributions);
  } else {
    var base = spendTxs;
    if (f.categoryId) base = base.filter(function (t) { return t.categoryId === f.categoryId; });
    if (f.categoryId && f.subcategoryId) {
      base = base.filter(function (t) { return f.subcategoryId === NONE ? !t.subcategoryId : t.subcategoryId === f.subcategoryId; });
    }
    var hasSubs = f.categoryId && (subcategoriesFor(f.categoryId).length || base.some(function (t) { return t.subcategoryId; }));
    if (f.view === "payment" || (f.categoryId && (f.subcategoryId || !hasSubs))) {
      out.dimension = "payment";
      out.slices = byPayment(base, paymentMethodsIn(st.transactions));
    } else if (f.categoryId) {
      out.dimension = "subcategory";
      out.slices = bySubcategory(base, f.categoryId);
    } else {
      out.dimension = "category";
      out.slices = byCategory(base);
    }
  }

  out.total = round2(out.slices.reduce(function (s, x) { return s + x.amount; }, 0));
  return out;
}

// The slices actually drawn: the biggest ones as they are, the tail as one
// grey slice. `folded` on a list row means "drawn inside the grey slice".
export function pieSlices(slices, max) {
  max = max || MAX_SLICES;
  if (slices.length <= max) return slices.slice();
  var head = slices.slice(0, max - 1);
  var tail = slices.slice(max - 1);
  return head.concat([{
    key: "__rest", label: tail.length + " smaller ones", color: 0, rest: true,
    amount: round2(tail.reduce(function (s, x) { return s + x.amount; }, 0)),
    count: tail.reduce(function (s, x) { return s + x.count; }, 0)
  }]);
}

function point(cx, cy, r, turn) {
  var a = turn * 2 * Math.PI - Math.PI / 2; // 0 = twelve o'clock, clockwise
  return (cx + r * Math.cos(a)).toFixed(2) + " " + (cy + r * Math.sin(a)).toFixed(2);
}

// SVG geometry for each slice: the wedge's path, and where a label sits
// (two thirds of the way out along the wedge's middle).
export function pieGeometry(amounts, cx, cy, r) {
  var total = amounts.reduce(function (s, n) { return s + n; }, 0);
  var at = 0;
  return amounts.map(function (amount) {
    var share = total > 0 ? amount / total : 0;
    var from = at;
    var to = at + share;
    at = to;
    var mid = point(cx, cy, r * 0.66, (from + to) / 2).split(" ");
    var d;
    if (share >= 0.9999) {
      // An arc can't start and end on the same point, so a lone slice is
      // drawn as two half circles.
      d = "M" + point(cx, cy, r, 0) + " A" + r + " " + r + " 0 1 1 " + point(cx, cy, r, 0.5) +
        " A" + r + " " + r + " 0 1 1 " + point(cx, cy, r, 0) + " Z";
    } else {
      d = "M" + cx + " " + cy + " L" + point(cx, cy, r, from) +
        " A" + r + " " + r + " 0 " + (share > 0.5 ? 1 : 0) + " 1 " + point(cx, cy, r, to) + " Z";
    }
    return { d: d, share: share, labelX: Number(mid[0]), labelY: Number(mid[1]) };
  });
}
