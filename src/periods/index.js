// Pay-cycle periods domain.
// A "period" runs from the earliest configured payday of one calendar month
// to the day before that same payday next month (e.g. 15 Aug – 14 Sep), keyed
// "YYYY-MM" as "the period that starts on cycle-start-day of that month".
// Callers pass the cycle start day (see cycleStartDay) rather than state.

import { todayStr, shiftMonth, monthsAgoDate } from "../lib/index.js";

export const WEEKDAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function cycleStartDay(incomeSources) {
  var days = (incomeSources || []).map(function (s) { return s.payDay; }).filter(function (d) { return typeof d === "number" && isFinite(d); });
  return days.length ? Math.min.apply(null, days) : 1;
}

export function periodStartDate(mk, startDay) {
  var parts = mk.split("-").map(Number);
  var y = parts[0], m = parts[1] - 1;
  var lastDay = new Date(y, m + 1, 0).getDate();
  var day = Math.min(startDay, lastDay);
  return new Date(y, m, day);
}

export function periodStartStr(mk, startDay) { return todayStr(periodStartDate(mk, startDay)); }
export function periodEndStr(mk, startDay) { return periodStartStr(shiftMonth(mk, 1), startDay); } // exclusive

export function dateRangeLabel(startD, endD) {
  var startStr = startD.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  var endStr = endD.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  return startStr + " – " + endStr;
}

export function periodLabel(mk, startDay) {
  var startD = periodStartDate(mk, startDay);
  var endD = new Date(periodStartDate(shiftMonth(mk, 1), startDay).getTime() - 86400000);
  return dateRangeLabel(startD, endD);
}

export function currentPeriodKey(startDay, now) {
  now = now || new Date();
  var mk = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
  return now.getDate() >= startDay ? mk : shiftMonth(mk, -1);
}

// ---------- custom date range (alternative to the pay-cycle period) ----------

export function customRangeEndExclusive(range) {
  var d = new Date(range.end + "T00:00:00");
  d.setDate(d.getDate() + 1);
  return todayStr(d);
}

export function txInRange(txs, startStr, endExclusive) {
  return txs.filter(function (t) { return t.date >= startStr && t.date < endExclusive; });
}

export function txSince(txs, startStr) {
  if (startStr == null) return txs.slice();
  return txs.filter(function (t) { return t.date >= startStr; });
}

// ---------- rolling windows used by spending patterns ----------

export function patternsWindowStart(sel, now) {
  if (sel === "all") return null;
  return todayStr(monthsAgoDate(parseInt(sel, 10), now));
}

export function patternsPriorWindowRange(sel, now) {
  if (sel === "all") return null;
  var n = parseInt(sel, 10);
  return { start: todayStr(monthsAgoDate(n * 2, now)), end: todayStr(monthsAgoDate(n, now)) };
}
