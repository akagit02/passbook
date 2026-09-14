// Spending patterns domain.
// How often each category gets spent on, how much, how far apart, which
// weekday — and whether that frequency is rising or falling.

import { averageGapDays, mostCommonWeekday } from "../lib/index.js";
import { spendingTxs } from "../categories/index.js";
import { txSince, txInRange, patternsWindowStart, patternsPriorWindowRange } from "../periods/index.js";

export function groupTxByCategory(txs) {
  var out = {};
  txs.forEach(function (t) {
    (out[t.categoryId] = out[t.categoryId] || []).push(t);
  });
  return out;
}

export function computeCategoryPattern(catId, txs) {
  var dates = txs.map(function (t) { return t.date; });
  var total = txs.reduce(function (s, t) { return s + t.amount; }, 0);
  return {
    catId: catId,
    count: txs.length,
    avgAmount: total / txs.length,
    avgGapDays: averageGapDays(dates),
    weekday: txs.length >= 3 ? mostCommonWeekday(dates) : null
  };
}

// sel: "3" | "6" | "12" | "all" (months)
export function computePatternsData(transactions, sel, now) {
  var windowStart = patternsWindowStart(sel, now);
  var windowTxs = spendingTxs(txSince(transactions, windowStart));
  var groups = groupTxByCategory(windowTxs);

  var priorRange = patternsPriorWindowRange(sel, now);
  var priorCounts = {};
  if (priorRange) {
    var priorTxs = spendingTxs(txInRange(transactions, priorRange.start, priorRange.end));
    priorTxs.forEach(function (t) { priorCounts[t.categoryId] = (priorCounts[t.categoryId] || 0) + 1; });
  }

  var rows = Object.keys(groups).map(function (catId) {
    var row = computeCategoryPattern(catId, groups[catId]);
    if (!priorRange) {
      row.trend = null;
    } else {
      var prior = priorCounts[catId] || 0;
      if (prior === 0) row.trend = { kind: "none" };
      else if (prior === row.count) row.trend = { kind: "flat" };
      else row.trend = { kind: row.count > prior ? "up" : "down", pct: Math.round(((row.count - prior) / prior) * 100) };
    }
    return row;
  });

  rows.sort(function (a, b) { return b.count - a.count; });
  return rows;
}
