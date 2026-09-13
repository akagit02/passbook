// Home-view insights domain.
// Decides *what* is worth saying about a period; the wording and HTML stay
// with the renderer.

// Largest category in a { catId: amount } map, or undefined if empty.
export function topCategory(sums) {
  return Object.keys(sums).map(function (k) { return { catId: k, amount: sums[k] }; }).sort(function (a, b) { return b.amount - a.amount; })[0];
}

// The category that grew most versus the previous period — ignoring
// categories that were zero before and rises that are small in absolute
// (≤ £20) or relative (≤ 15%) terms. null when nothing qualifies.
export function biggestCategoryJump(sums, prevSums) {
  var biggestJump = null;
  Object.keys(sums).forEach(function (catId) {
    var prev = prevSums[catId] || 0;
    var delta = sums[catId] - prev;
    if (prev > 0 && delta > 20 && delta / prev > 0.15) {
      if (!biggestJump || delta > biggestJump.delta) biggestJump = { catId: catId, delta: delta };
    }
  });
  return biggestJump;
}

// Which savings-rate message applies, given cycleFinancials output and a
// positive income. kind: "overspent" | "ahead" | "closer" | "low" | "nothing".
export function savingsRateNudge(fin, income) {
  var rate = (fin.putAside / income) * 100;
  var kind;
  if (fin.leftover < 0) kind = "overspent";
  else if (rate >= 20) kind = "ahead";
  else if (rate >= 10) kind = "closer";
  else if (fin.putAside > 0) kind = "low";
  else kind = "nothing";
  return { kind: kind, rate: rate };
}
