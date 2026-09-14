// Savings domain.
// ISA allowance tracking, goal pacing, holdings split, and the "where you
// could cut" / emergency-buffer figures behind the allocation advice.

import { todayStr, shiftMonth } from "../lib/index.js";
import { CATEGORIES, CAT_INDEX, TAX_YEAR_START_MONTH, TAX_YEAR_START_DAY, isSavingsTx, vehicleFor } from "../categories/index.js";
import { cycleStartDay, currentPeriodKey, periodStartStr, periodEndStr, txInRange } from "../periods/index.js";
import { cycleFinancials } from "../cashflow/index.js";

// How much of a category a suggestion assumes you'd actually give up. A
// quarter is deliberately modest — the point is a number you might really
// hit, not the fantasy one you get by assuming eating out drops to zero.
export const TRIM_FRACTION = 0.25;
export const SUBSCRIPTION_REVIEW_MAX = 20;

export const TIER_ORDER = ["cash", "low", "growth", "other"];

export function median(nums) {
  if (!nums.length) return 0;
  var s = nums.slice().sort(function (a, b) { return a - b; });
  var mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function sumAmounts(rows) { return rows.reduce(function (s, r) { return s + r.amount; }, 0); }

// The UK tax year runs 6 April to 5 April, and the ISA allowance resets with
// it — an unused allowance doesn't roll over.
export function taxYearRange(d) {
  d = d || new Date();
  var boundary = new Date(d.getFullYear(), TAX_YEAR_START_MONTH, TAX_YEAR_START_DAY);
  var startYear = d >= boundary ? d.getFullYear() : d.getFullYear() - 1;
  var end = new Date(startYear + 1, TAX_YEAR_START_MONTH, TAX_YEAR_START_DAY);
  return {
    start: todayStr(new Date(startYear, TAX_YEAR_START_MONTH, TAX_YEAR_START_DAY)),
    end: todayStr(end),
    endDate: end,
    label: startYear + "/" + String((startYear + 1) % 100).padStart(2, "0")
  };
}

export function contributionsInRange(contributions, startStr, endExclusiveStr) {
  return contributions.filter(function (c) {
    return c.date >= startStr && c.date < endExclusiveStr;
  });
}

export function savedTowards(contributions, goalId) {
  return sumAmounts(contributions.filter(function (c) { return c.goalId === goalId; }));
}

// Totals for the last `months` *complete* calendar months, oldest first. The
// current month is left out — it's only part-way through, and including it
// would make spending look like it's falling every time you check early.
export function monthlyTotals(transactions, months, predicate, now) {
  now = now || new Date();
  var out = [];
  for (var i = months; i >= 1; i--) {
    var from = new Date(now.getFullYear(), now.getMonth() - i, 1);
    var to = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
    var startStr = todayStr(from), endStr = todayStr(to);
    var total = 0;
    transactions.forEach(function (t) {
      if (t.date >= startStr && t.date < endStr && predicate(t)) total += t.amount;
    });
    out.push(total);
  }
  return out;
}

export function categoryMonthlyTotals(transactions, catId, months, now) {
  return monthlyTotals(transactions, months, function (t) { return t.categoryId === catId; }, now);
}

// What it costs to simply keep going: everything that isn't discretionary
// and isn't a savings transfer. An emergency fund is sized against this.
export function isEssentialTx(t) {
  var cat = CATEGORIES[CAT_INDEX[t.categoryId]];
  return !!cat && !cat.discretionary && !isSavingsTx(t);
}

export function medianEssentialMonthly(transactions, now) {
  return median(monthlyTotals(transactions, 6, isEssentialTx, now));
}

export function medianMonthlySavings(transactions, now) {
  return median(monthlyTotals(transactions, 6, isSavingsTx, now));
}

// Leftover for each of the last `n` complete pay cycles, so goal pacing is
// checked against what tends to be spare rather than income on paper.
// st: { income, incomeSources, transactions, cardBalances, creditCards }
export function medianMonthlyLeftover(n, st, now) {
  if (st.income == null) return null;
  var startDay = cycleStartDay(st.incomeSources);
  var vals = [];
  var mk = currentPeriodKey(startDay, now);
  for (var i = 1; i <= n; i++) {
    var m = shiftMonth(mk, -i);
    var start = periodStartStr(m, startDay), end = periodEndStr(m, startDay);
    var fin = cycleFinancials(txInRange(st.transactions, start, end), start, end, st);
    if (fin.leftover != null) vals.push(fin.leftover);
  }
  return vals.length ? median(vals) : null;
}

export function monthsBetween(fromStr, toStr) {
  var a = new Date(fromStr + "T00:00:00"), b = new Date(toStr + "T00:00:00");
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()) + (b.getDate() - a.getDate()) / 30.4;
}

export function goalProgress(g, contributions, transactions, now) {
  var today = todayStr(now);
  var saved = savedTowards(contributions, g.id);
  var remaining = Math.max(0, g.targetAmount - saved);
  var monthsLeft = monthsBetween(today, g.targetDate);
  var requiredMonthly = remaining <= 0 ? 0 : monthsLeft <= 0 ? remaining : remaining / monthsLeft;
  var contribs = contributions.filter(function (c) { return c.goalId === g.id; });
  var actualMonthly = median(monthlyTotals(transactions, 6, function (t) {
    return contribs.some(function (c) { return c.transactionId === t.id; });
  }, now));
  // A goal set last week has no pace yet — judging it against a six-month
  // median would call every new goal "behind" on the day it's created.
  var monthsElapsed = monthsBetween(g.startDate, today);
  return {
    saved: saved,
    remaining: remaining,
    pct: g.targetAmount > 0 ? Math.min(100, (saved / g.targetAmount) * 100) : 0,
    monthsLeft: monthsLeft,
    requiredMonthly: requiredMonthly,
    actualMonthly: actualMonthly,
    complete: remaining <= 0,
    overdue: monthsLeft <= 0 && remaining > 0,
    tooNew: monthsElapsed < 2
  };
}

// Contributions summed per vehicle, largest first: [{ vehicle, amount }].
export function holdingsByVehicle(contributions) {
  var byVehicle = {};
  contributions.forEach(function (c) {
    byVehicle[c.vehicle] = (byVehicle[c.vehicle] || 0) + c.amount;
  });
  return Object.keys(byVehicle).map(function (id) {
    return { vehicle: vehicleFor(id), amount: byVehicle[id] };
  }).sort(function (a, b) { return b.amount - a.amount; });
}

// Share of `total` held in each risk tier present, in TIER_ORDER, as whole
// percentages: [{ tier, pct }].
export function tierSplit(holdings, total) {
  var byTier = {};
  holdings.forEach(function (r) { byTier[r.vehicle.tier] = (byTier[r.vehicle.tier] || 0) + r.amount; });
  return TIER_ORDER.filter(function (t) { return byTier[t]; }).map(function (t) {
    return { tier: t, pct: Math.round((byTier[t] / total) * 100) };
  });
}

// ISA-wrapped contributions in tax year `ty`, and the cash/growth money put
// outside an ISA that could have used the allowance instead.
export function taxYearIsaSplit(contributions, ty) {
  var inYear = contributionsInRange(contributions, ty.start, ty.end);
  return {
    isaUsed: sumAmounts(inYear.filter(function (c) { return vehicleFor(c.vehicle).isa; })),
    outsideIsa: sumAmounts(inYear.filter(function (c) {
      var v = vehicleFor(c.vehicle);
      return !v.isa && (v.tier === "growth" || v.tier === "cash");
    }))
  };
}

// The emergency buffer has to be money you can reach this week — cash and
// capital-preservation holdings only. A stocks ISA is not an emergency fund.
export function reachableBuffer(contributions) {
  return sumAmounts(contributions.filter(function (c) {
    var tier = vehicleFor(c.vehicle).tier;
    return tier === "cash" || tier === "low";
  }));
}

export function cutCandidates(transactions, now) {
  now = now || new Date();
  var freqFrom = todayStr(new Date(now.getFullYear(), now.getMonth() - 3, 1));
  var freqTo = todayStr(new Date(now.getFullYear(), now.getMonth(), 1));

  return CATEGORIES.filter(function (c) { return c.discretionary; }).map(function (cat) {
    var totals = categoryMonthlyTotals(transactions, cat.id, 6, now);
    // Median rather than mean: one Christmas or one holiday shouldn't become
    // the baseline you're told to cut from.
    var base = median(totals);
    var last = totals[totals.length - 1];
    var recent = transactions.filter(function (t) {
      return t.categoryId === cat.id && t.date >= freqFrom && t.date < freqTo;
    });
    return {
      cat: cat,
      base: base,
      last: last,
      perMonth: recent.length / 3,
      avgAmount: recent.length ? recent.reduce(function (s, t) { return s + t.amount; }, 0) / recent.length : 0,
      trim: base * TRIM_FRACTION,
      overshoot: base > 0 && last > base * 1.15 && last - base >= 20 ? last - base : 0
    };
  // Anything whose realistic trim is under a fiver a month isn't worth the
  // reader's attention — it just crowds out the suggestions that matter.
  }).filter(function (r) { return r.trim >= 5; }).sort(function (a, b) { return b.base - a.base; });
}
