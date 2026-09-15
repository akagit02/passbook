// Financial health domain.
// Six vital signs judged against user-editable thresholds, plus a rule-based
// verdict. Deliberately no 0-100 score: the inputs (one flat monthly income
// figure, medians over a handful of months) are too coarse for a
// precise-looking number to mean anything.

import { todayStr, shiftMonth } from "../lib/index.js";
import { cycleStartDay, currentPeriodKey, periodStartStr, periodEndStr, txInRange } from "../periods/index.js";
import { cycleFinancials } from "../cashflow/index.js";
import { reachableBuffer, medianEssentialMonthly } from "../savings/index.js";
import { installmentRemaining } from "../recurring/index.js";
import { debtRemaining, paymentsForDebt } from "../debts/index.js";

// Card discipline isn't here: it's binary (anything overdue is red), so there
// is no boundary for the user to move.
export const METRIC_KEYS = ["savingsRate", "bufferMonths", "withinMeans", "debtLoad", "fixedCommitments"];

// UK rules of thumb. Anything worse than amber is red.
export const DEFAULT_THRESHOLDS = {
  savingsRate: { green: 20, amber: 10 },
  bufferMonths: { green: 3, amber: 1 },
  withinMeans: { green: 100, amber: 66 },
  debtLoad: { green: 15, amber: 35 },
  fixedCommitments: { green: 50, amber: 70 }
};

export const HIGHER_IS_BETTER = {
  savingsRate: true,
  bufferMonths: true,
  withinMeans: true,
  debtLoad: false,
  fixedCommitments: false
};

function sum(nums) { return nums.reduce(function (s, n) { return s + n; }, 0); }
function avg(nums) { return nums.length ? sum(nums) / nums.length : 0; }
function round2(n) { return Math.round(n * 100) / 100; }
function toNum(v) { return v === null || v === undefined || v === "" ? NaN : Number(v); }

export function validThresholdPair(key, green, amber) {
  if (typeof green !== "number" || typeof amber !== "number") return false;
  if (!isFinite(green) || !isFinite(amber) || green < 0 || amber < 0) return false;
  return HIGHER_IS_BETTER[key] ? green >= amber : green <= amber;
}

// Stored thresholds come from a jsonb column the user edits, so anything
// missing, non-numeric or back-to-front falls back to that metric's default
// rather than producing nonsense colours.
export function normaliseThresholds(raw) {
  var out = {};
  METRIC_KEYS.forEach(function (key) {
    var r = raw && raw[key];
    var g = r ? toNum(r.green) : NaN;
    var a = r ? toNum(r.amber) : NaN;
    out[key] = validThresholdPair(key, g, a)
      ? { green: g, amber: a }
      : { green: DEFAULT_THRESHOLDS[key].green, amber: DEFAULT_THRESHOLDS[key].amber };
  });
  return out;
}

export function statusFor(key, value, thresholds) {
  var t = thresholds[key];
  if (HIGHER_IS_BETTER[key]) return value >= t.green ? "green" : value >= t.amber ? "amber" : "red";
  return value <= t.green ? "green" : value <= t.amber ? "amber" : "red";
}

export function periodKeyForDate(dateStr, startDay) {
  var mk = dateStr.slice(0, 7);
  return Number(dateStr.slice(8, 10)) >= startDay ? mk : shiftMonth(mk, -1);
}

// Pay-period keys in a window, oldest first. `win` is { count: n } for the
// last n *complete* periods (the current one is only part-way through, and
// would make every measure look worse early in the month), or { from, to }
// for an inclusive custom range, which may include the current period.
export function windowPeriodKeys(win, startDay, now) {
  var keys = [];
  if (win && win.from && win.to) {
    var from = win.from <= win.to ? win.from : win.to;
    var to = win.from <= win.to ? win.to : win.from;
    for (var mk = from; mk <= to && keys.length < 120; mk = shiftMonth(mk, 1)) keys.push(mk);
    return keys;
  }
  var n = (win && win.count) || 6;
  var cur = currentPeriodKey(startDay, now);
  for (var i = n; i >= 1; i--) keys.push(shiftMonth(cur, -i));
  return keys;
}

function earliestDate(transactions) {
  return (transactions || []).reduce(function (min, t) { return !min || t.date < min ? t.date : min; }, null);
}

// Every period from the first one with any logged transaction up to the
// current one — what the custom range pickers offer.
export function selectablePeriodKeys(st, now) {
  var startDay = cycleStartDay(st.incomeSources);
  var cur = currentPeriodKey(startDay, now);
  var first = earliestDate(st.transactions);
  var from = first ? periodKeyForDate(first, startDay) : cur;
  if (from > cur) from = cur;
  var keys = [];
  for (var mk = from; mk <= cur && keys.length < 120; mk = shiftMonth(mk, 1)) keys.push(mk);
  return keys;
}

function periodFigures(keys, st, startDay) {
  return keys.map(function (mk) {
    var start = periodStartStr(mk, startDay);
    var end = periodEndStr(mk, startDay);
    var fin = cycleFinancials(txInRange(st.transactions, start, end), start, end, st);
    return { key: mk, putAside: fin.putAside, leftover: fin.leftover };
  });
}

function neutral(row, reason) {
  row.status = "neutral";
  row.reason = reason;
  return row;
}

function savingsRateRow(periods, prev, income, t) {
  var row = { key: "savingsRate", target: t.savingsRate };
  if (income == null || income <= 0) return neutral(row, "no-income");
  if (!periods.length) return neutral(row, "no-data");
  var avgSaved = avg(periods.map(function (p) { return p.putAside; }));
  row.avgSaved = round2(avgSaved);
  row.pct = Math.round((avgSaved / income) * 100);
  row.status = statusFor("savingsRate", row.pct, t);
  if (prev) row.prevPct = Math.round((avg(prev.map(function (p) { return p.putAside; })) / income) * 100);
  if (row.status !== "green") row.toGreen = Math.max(1, Math.ceil((t.savingsRate.green / 100) * income - avgSaved));
  return row;
}

function bufferRow(st, t, now) {
  var row = { key: "bufferMonths", target: t.bufferMonths };
  row.essential = round2(medianEssentialMonthly(st.transactions, now));
  row.buffer = round2(reachableBuffer(st.savingsContributions || []));
  if (!(row.essential > 0)) return neutral(row, "no-data");
  row.months = Math.round((row.buffer / row.essential) * 10) / 10;
  row.status = statusFor("bufferMonths", row.months, t);
  if (row.status !== "green") row.toGreen = Math.max(1, Math.ceil(t.bufferMonths.green * row.essential - row.buffer));
  return row;
}

function withinMeansRow(periods, prev, income, t) {
  var row = { key: "withinMeans", target: t.withinMeans };
  if (income == null || income <= 0) return neutral(row, "no-income");
  if (!periods.length) return neutral(row, "no-data");
  row.overs = periods.filter(function (p) { return p.leftover < 0; }).map(function (p) {
    return { key: p.key, amount: round2(-p.leftover) };
  });
  row.total = periods.length;
  row.under = periods.length - row.overs.length;
  row.pct = Math.round((row.under / row.total) * 100);
  row.status = statusFor("withinMeans", row.pct, t);
  if (prev && prev.length) {
    var prevUnder = prev.filter(function (p) { return p.leftover >= 0; }).length;
    row.prevPct = Math.round((prevUnder / prev.length) * 100);
  }
  if (row.overs.length) row.avgOver = Math.ceil(avg(row.overs.map(function (o) { return o.amount; })));
  if (row.status !== "green" && row.overs.length) row.toGreen = row.avgOver;
  return row;
}

// Repayments made through the ledger (installment direct debits) are what
// the percentage measures. Debts tracked on the Debt tab are deducted by an
// employer before the income figure, so counting them again would
// double-subtract them — they only add to "left" and the payoff date.
function debtLoadRow(st, income, t, now) {
  var curMonth = todayStr(now).slice(0, 7);
  var items = [];

  (st.recurringExpenses || []).forEach(function (r) {
    if (!r.active || !r.installment) return;
    var remaining = installmentRemaining(r, st.transactions);
    if (!(remaining > 0)) return;
    var started = !r.startMonth || r.startMonth <= curMonth;
    var n = r.amount > 0 ? Math.ceil(remaining / r.amount) : null;
    items.push({
      label: r.label,
      remaining: remaining,
      monthly: started ? Math.min(r.amount, remaining) : 0,
      inLedger: true,
      payoff: n == null ? null : started ? shiftMonth(curMonth, n) : shiftMonth(r.startMonth, n - 1)
    });
  });

  (st.debts || []).forEach(function (d) {
    if (d.active === false) return;
    var remaining = debtRemaining(d, st.debtPayments || []);
    if (!(remaining > 0)) return;
    var recent = paymentsForDebt(d.id, st.debtPayments || []).slice()
      .sort(function (a, b) { return a.date < b.date ? 1 : -1; }).slice(0, 3);
    var pace = avg(recent.map(function (p) { return p.amount; }));
    items.push({
      label: d.label,
      remaining: remaining,
      monthly: 0,
      inLedger: false,
      payoff: pace > 0 ? shiftMonth(curMonth, Math.ceil(remaining / pace)) : null
    });
  });

  var monthly = round2(sum(items.map(function (i) { return i.monthly; })));
  var payoffs = items.map(function (i) { return i.payoff; }).filter(Boolean).sort();
  var row = {
    key: "debtLoad",
    target: t.debtLoad,
    count: items.length,
    monthly: monthly,
    totalLeft: round2(sum(items.map(function (i) { return i.remaining; }))),
    outsideLedgerCount: items.filter(function (i) { return !i.inLedger; }).length,
    payoff: payoffs.length ? payoffs[payoffs.length - 1] : null,
    payoffUnknown: items.some(function (i) { return i.payoff == null; })
  };
  if (income == null || income <= 0) return neutral(row, "no-income");
  row.pct = Math.round((monthly / income) * 100);
  row.status = statusFor("debtLoad", row.pct, t);

  if (row.status !== "green") {
    var paying = items.filter(function (i) { return i.monthly > 0; });
    var pctWithout = function (i) { return Math.round(((monthly - i.monthly) / income) * 100); };
    // The smallest balance whose clearing alone gets back to green, else the
    // single biggest repayment — the most useful thing to point at either way.
    var fixes = paying.filter(function (i) { return pctWithout(i) <= t.debtLoad.green; })
      .sort(function (a, b) { return a.remaining - b.remaining; });
    var pick = fixes[0] || paying.slice().sort(function (a, b) { return b.monthly - a.monthly; })[0];
    if (pick) {
      row.toGreen = { label: pick.label, remaining: round2(pick.remaining), pctAfter: pctWithout(pick), reachesGreen: !!fixes[0] };
    }
  }
  return row;
}

function cardDisciplineRow(st, range, now) {
  var today = todayStr(now);
  var cards = st.creditCards || [];
  var balances = st.cardBalances || [];
  var cardLabel = function (id) {
    var c = cards.filter(function (x) { return x.id === id; })[0];
    return c ? c.label : "a card";
  };
  // Anything overdue right now counts whatever window is picked — it's the
  // one thing on this page that's costing money today.
  var overdue = balances.filter(function (b) { return !b.paid && b.dueDate < today; }).map(function (b) {
    return { cardLabel: cardLabel(b.cardId), amount: b.amount, dueDate: b.dueDate };
  });
  var due = balances.filter(function (b) { return b.dueDate >= range.start && b.dueDate < range.end && b.dueDate < today; });
  var late = due.filter(function (b) { return b.paid && b.paidDate && b.paidDate > b.dueDate; });
  var row = {
    key: "cardDiscipline",
    overdue: overdue,
    overdueTotal: round2(sum(overdue.map(function (o) { return o.amount; }))),
    dueCount: due.length,
    lateCount: late.length
  };
  if (overdue.length) row.status = "red";
  else if (late.length) row.status = "amber";
  else if (due.length) row.status = "green";
  else return neutral(row, "no-data");
  return row;
}

function fixedCommitmentsRow(st, income, t, now) {
  var curMonth = todayStr(now).slice(0, 7);
  var total = 0;
  var count = 0;
  (st.recurringExpenses || []).forEach(function (r) {
    if (!r.active || (r.startMonth && r.startMonth > curMonth)) return;
    var amount = r.amount;
    if (r.installment) {
      var remaining = installmentRemaining(r, st.transactions);
      if (!(remaining > 0)) return;
      amount = Math.min(r.amount, remaining);
    }
    total += amount;
    count++;
  });
  var row = { key: "fixedCommitments", target: t.fixedCommitments, total: round2(total), count: count };
  if (income == null || income <= 0) return neutral(row, "no-income");
  row.pct = Math.round((total / income) * 100);
  row.status = statusFor("fixedCommitments", row.pct, t);
  if (row.status !== "green") row.toGreen = Math.max(1, Math.ceil(total - (t.fixedCommitments.green / 100) * income));
  return row;
}

export function verdict(rows) {
  var counts = { green: 0, amber: 0, red: 0 };
  rows.forEach(function (r) { if (counts[r.status] != null) counts[r.status]++; });
  var scored = counts.green + counts.amber + counts.red;
  var level = !scored ? "neutral" : counts.red ? "attention" : counts.amber ? "okay" : "healthy";
  return { level: level, green: counts.green, amber: counts.amber, red: counts.red };
}

// st: the app state (income, incomeSources, transactions, cardBalances,
// creditCards, recurringExpenses, savingsContributions, debts, debtPayments).
export function computeHealth(st, win, thresholds, now) {
  now = now || new Date();
  var t = normaliseThresholds(thresholds);
  var startDay = cycleStartDay(st.incomeSources);
  var keys = windowPeriodKeys(win, startDay, now);
  var firstDate = earliestDate(st.transactions);

  // Periods from before anything was logged would read as "saved nothing,
  // spent nothing, well under budget" — leave them out rather than let them
  // flatter or drag down the averages.
  var usable = firstDate ? keys.filter(function (mk) { return periodEndStr(mk, startDay) > firstDate; }) : [];
  var periods = periodFigures(usable, st, startDay);

  var prevKeys = keys.map(function (_, i) { return shiftMonth(keys[0], i - keys.length); });
  var prevCovered = !!firstDate && firstDate <= periodStartStr(prevKeys[0], startDay);
  var prevPeriods = prevCovered ? periodFigures(prevKeys, st, startDay) : null;

  var range = { start: periodStartStr(keys[0], startDay), end: periodEndStr(keys[keys.length - 1], startDay) };
  var rows = [
    savingsRateRow(periods, prevPeriods, st.income, t),
    bufferRow(st, t, now),
    withinMeansRow(periods, prevPeriods, st.income, t),
    debtLoadRow(st, st.income, t, now),
    cardDisciplineRow(st, range, now),
    fixedCommitmentsRow(st, st.income, t, now)
  ];

  return {
    keys: keys,
    usableCount: usable.length,
    range: range,
    includesCurrent: keys.indexOf(currentPeriodKey(startDay, now)) !== -1,
    rows: rows,
    // With nothing logged at all, "no debt, no direct debits" would score as
    // two greens and call a brand-new account healthy.
    verdict: firstDate ? verdict(rows) : { level: "neutral", green: 0, amber: 0, red: 0 }
  };
}
