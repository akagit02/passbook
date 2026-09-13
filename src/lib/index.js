// Pure utility functions with no domain knowledge or state dependency.
// Safe to extract because they're self-contained and testable in isolation.

export function todayStr(d) {
  d = d || new Date();
  var y = d.getFullYear();
  var m = String(d.getMonth() + 1).padStart(2, "0");
  var day = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

export function shiftMonth(mk, delta) {
  var parts = mk.split("-").map(Number);
  var d = new Date(parts[0], parts[1] - 1 + delta, 1);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}

export function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

export function genId() {
  return "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function clampDay(n) {
  n = Math.round(n);
  if (!isFinite(n)) return 1;
  return Math.min(31, Math.max(1, n));
}

export function monthsAgoDate(n, from) {
  from = from || new Date();
  var y = from.getFullYear(), m = from.getMonth() - n;
  var lastDay = new Date(y, m + 1, 0).getDate();
  var day = Math.min(from.getDate(), lastDay);
  return new Date(y, m, day);
}

export function averageGapDays(dateStrs) {
  if (dateStrs.length < 2) return null;
  var sorted = dateStrs.slice().sort();
  var first = new Date(sorted[0] + "T00:00:00");
  var last = new Date(sorted[sorted.length - 1] + "T00:00:00");
  var spanDays = (last - first) / 86400000;
  return spanDays / (sorted.length - 1);
}

export function mostCommonWeekday(dateStrs) {
  if (!dateStrs.length) return null;
  var counts = new Array(7).fill(0);
  dateStrs.forEach(function (d) { counts[new Date(d + "T00:00:00").getDay()]++; });
  var best = 0;
  for (var i = 1; i < 7; i++) { if (counts[i] > counts[best]) best = i; }
  return { day: best, count: counts[best] };
}
