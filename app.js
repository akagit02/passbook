(function () {
  "use strict";

  // ---------- Supabase client ----------
  var sb = window.supabase.createClient(
    window.PASSBOOK_CONFIG.SUPABASE_URL,
    window.PASSBOOK_CONFIG.SUPABASE_ANON_KEY
  );

  var CATEGORIES = [
    { id: "housing", label: "Housing" },
    { id: "groceries", label: "Groceries" },
    { id: "transport", label: "Transport" },
    { id: "eating_out", label: "Eating out" },
    { id: "bills", label: "Bills & utilities" },
    { id: "shopping", label: "Shopping" },
    { id: "health", label: "Health" },
    { id: "entertainment", label: "Entertainment" },
    { id: "other", label: "Other" },
    { id: "insurance", label: "Insurance" },
    { id: "savings", label: "Savings" }
  ];
  var CAT_INDEX = {};
  CATEGORIES.forEach(function (c, i) { CAT_INDEX[c.id] = i; });

  // "Paid using" is a free-text field backed by a datalist (see
  // #payment-method-options in index.html), not a locked set of DB rows —
  // this list just needs to match what's in that datalist.
  var PAYMENT_METHODS = ["PCC", "RCC", "sal acc", "wife sal acc", "cur acc"];

  var editingIncome = false;
  var editingCalendar = false;
  var editingRecurring = false;
  var currentUserId = null;
  var patternsWindow = "6"; // "3" | "6" | "12" | "all"

  var state = {
    currency: "GBP",
    income: null,
    incomeSources: [],
    creditCards: [],
    transactions: [],
    plannedExpenses: [],
    cardBalances: [],
    recurringExpenses: []
  };
  var viewMonth = null;
  var customRange = null; // {start, end} both "YYYY-MM-DD", inclusive; null = pay-cycle mode via viewMonth

  function todayStr(d) {
    d = d || new Date();
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }

  function shiftMonth(mk, delta) {
    var parts = mk.split("-").map(Number);
    var d = new Date(parts[0], parts[1] - 1 + delta, 1);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
  }

  // ---------- pay-cycle periods ----------
  // A "period" runs from the earliest configured payday of one calendar month
  // to the day before that same payday next month (e.g. 15 Aug – 14 Sep), so
  // spending is tracked in line with when salary actually lands rather than
  // resetting mid-cycle on the 1st. The period is keyed the same way a
  // calendar month was ("YYYY-MM"), just reinterpreted as "the period that
  // starts on cycle-start-day of that month".

  function cycleStartDay() {
    var days = (state.incomeSources || []).map(function (s) { return s.payDay; }).filter(function (d) { return typeof d === "number" && isFinite(d); });
    return days.length ? Math.min.apply(null, days) : 1;
  }

  function periodStartDate(mk) {
    var parts = mk.split("-").map(Number);
    var y = parts[0], m = parts[1] - 1;
    var lastDay = new Date(y, m + 1, 0).getDate();
    var day = Math.min(cycleStartDay(), lastDay);
    return new Date(y, m, day);
  }

  function periodStartStr(mk) { return todayStr(periodStartDate(mk)); }
  function periodEndStr(mk) { return periodStartStr(shiftMonth(mk, 1)); } // exclusive

  // ---------- custom date range (alternative to the pay-cycle period above) ----------

  function customRangeEndExclusive(range) {
    var d = new Date(range.end + "T00:00:00");
    d.setDate(d.getDate() + 1);
    return todayStr(d);
  }

  function activeRangeStr() {
    if (customRange) return { start: customRange.start, end: customRangeEndExclusive(customRange) };
    return { start: periodStartStr(viewMonth), end: periodEndStr(viewMonth) };
  }

  function activeRangeLabel() {
    if (!customRange) return periodLabel(viewMonth);
    var startD = new Date(customRange.start + "T00:00:00");
    var endD = new Date(customRange.end + "T00:00:00");
    var startStr = startD.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    var endStr = endD.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
    return startStr + " – " + endStr;
  }

  function currentTxs() {
    var r = activeRangeStr();
    return state.transactions.filter(function (t) { return t.date >= r.start && t.date < r.end; });
  }

  function periodLabel(mk) {
    var startD = periodStartDate(mk);
    var endD = new Date(periodStartDate(shiftMonth(mk, 1)).getTime() - 86400000);
    var startStr = startD.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    var endStr = endD.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
    return startStr + " – " + endStr;
  }

  function currentPeriodKey() {
    var now = new Date();
    var mk = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
    return now.getDate() >= cycleStartDay() ? mk : shiftMonth(mk, -1);
  }

  function fmtMoney(n) {
    try {
      return new Intl.NumberFormat("en-GB", { style: "currency", currency: state.currency || "GBP" }).format(n);
    } catch (e) {
      return "£" + n.toFixed(2);
    }
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function genId() {
    return "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function clampDay(n) {
    n = Math.round(n);
    if (!isFinite(n)) return 1;
    return Math.min(31, Math.max(1, n));
  }

  function txForPeriod(mk) {
    var start = periodStartStr(mk);
    var end = periodEndStr(mk);
    return state.transactions.filter(function (t) { return t.date >= start && t.date < end; });
  }

  function sumBy(txs) {
    var out = {};
    txs.forEach(function (t) { out[t.categoryId] = (out[t.categoryId] || 0) + t.amount; });
    return out;
  }

  function totalOutstandingCardBalance() {
    return state.cardBalances.reduce(function (s, b) { return s + (b.paid ? 0 : b.amount); }, 0);
  }

  // ---------- recurring / direct debits ----------

  function recurringOccurrenceDate(rule, monthKey) {
    var parts = monthKey.split("-").map(Number);
    var y = parts[0], m = parts[1] - 1;
    var lastDay = new Date(y, m + 1, 0).getDate();
    var day = Math.min(rule.dayOfMonth, lastDay);
    return new Date(y, m, day);
  }

  function installmentPaidSoFar(rule) {
    return state.transactions.reduce(function (s, t) {
      return t.recurringId === rule.id ? s + t.amount : s;
    }, 0);
  }

  function installmentRemaining(rule) {
    if (!rule.installment) return null;
    var paid = installmentPaidSoFar(rule);
    var remaining = Math.round((rule.installment.totalOwed - paid) * 100) / 100;
    return Math.max(0, remaining);
  }

  // Generates any due-but-not-yet-logged recurring transactions and returns
  // the array of newly created ones (already pushed into state.transactions)
  // so the caller can batch-insert them into Supabase.
  function generateRecurringTransactions() {
    var mk = todayStr().slice(0, 7);
    var now = new Date();
    var today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var created = [];

    state.recurringExpenses.forEach(function (rule) {
      if (!rule.active) return;
      if (rule.startMonth && mk < rule.startMonth) return; // hasn't started yet
      var already = state.transactions.some(function (t) { return t.recurringId === rule.id && t.recurringOccurrence === mk; });
      if (already) return;

      var occDate = recurringOccurrenceDate(rule, mk);
      if (occDate > today0) return; // this cycle hasn't happened yet

      var amount = rule.amount;
      if (rule.installment) {
        var remaining = installmentRemaining(rule);
        if (remaining <= 0) return; // fully paid off — stop generating
        amount = Math.round(Math.min(amount, remaining) * 100) / 100;
      }

      var t = {
        id: genId(),
        amount: amount,
        date: todayStr(occDate),
        categoryId: rule.categoryId,
        note: rule.label,
        recurringId: rule.id,
        recurringOccurrence: mk
      };
      state.transactions.push(t);
      created.push(t);
    });

    return created;
  }

  // ---------- spending patterns ----------

  var WEEKDAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  function monthsAgoDate(n, from) {
    from = from || new Date();
    var y = from.getFullYear(), m = from.getMonth() - n;
    var lastDay = new Date(y, m + 1, 0).getDate();
    var day = Math.min(from.getDate(), lastDay);
    return new Date(y, m, day);
  }

  function patternsWindowStart(sel) {
    if (sel === "all") return null;
    return todayStr(monthsAgoDate(parseInt(sel, 10)));
  }

  function patternsPriorWindowRange(sel) {
    if (sel === "all") return null;
    var n = parseInt(sel, 10);
    return { start: todayStr(monthsAgoDate(n * 2)), end: todayStr(monthsAgoDate(n)) };
  }

  function txSince(startStr) {
    if (startStr == null) return state.transactions.slice();
    return state.transactions.filter(function (t) { return t.date >= startStr; });
  }

  function txInRange(startStr, endExclusive) {
    return state.transactions.filter(function (t) { return t.date >= startStr && t.date < endExclusive; });
  }

  function groupTxByCategory(txs) {
    var out = {};
    txs.forEach(function (t) {
      (out[t.categoryId] = out[t.categoryId] || []).push(t);
    });
    return out;
  }

  function averageGapDays(dateStrs) {
    if (dateStrs.length < 2) return null;
    var sorted = dateStrs.slice().sort();
    var first = new Date(sorted[0] + "T00:00:00");
    var last = new Date(sorted[sorted.length - 1] + "T00:00:00");
    var spanDays = (last - first) / 86400000;
    return spanDays / (sorted.length - 1);
  }

  function mostCommonWeekday(dateStrs) {
    if (!dateStrs.length) return null;
    var counts = new Array(7).fill(0);
    dateStrs.forEach(function (d) { counts[new Date(d + "T00:00:00").getDay()]++; });
    var best = 0;
    for (var i = 1; i < 7; i++) { if (counts[i] > counts[best]) best = i; }
    return { day: best, count: counts[best] };
  }

  function computeCategoryPattern(catId, txs) {
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

  function computePatternsData(sel) {
    var windowStart = patternsWindowStart(sel);
    var currentTxs = txSince(windowStart);
    var groups = groupTxByCategory(currentTxs);

    var priorRange = patternsPriorWindowRange(sel);
    var priorCounts = {};
    if (priorRange) {
      var priorTxs = txInRange(priorRange.start, priorRange.end);
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

  // ---------- rendering ----------

  function populateCategorySelect(selectId) {
    var sel = document.getElementById(selectId);
    CATEGORIES.forEach(function (c) {
      var opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = c.label;
      sel.appendChild(opt);
    });
  }

  function renderMonthLabel() {
    document.getElementById("month-label").textContent = activeRangeLabel();
    document.getElementById("prev-month").hidden = !!customRange;
    document.getElementById("next-month").hidden = !!customRange;
    document.getElementById("range-clear").hidden = !customRange;
  }

  function leftoverSub(income, saved, cardsOwed) {
    if (income == null) return "add income to see this";
    var base = saved >= 0 ? "under budget" : "over budget";
    if (cardsOwed > 0) return base + " · includes " + fmtMoney(cardsOwed) + " owed on cards";
    return base;
  }

  function renderStats() {
    var el = document.getElementById("stats");
    var txs = currentTxs();
    var spent = txs.reduce(function (s, t) { return s + t.amount; }, 0);
    var income = state.income;
    var cardsOwed = totalOutstandingCardBalance();
    var saved = income != null ? income - spent - cardsOwed : null;
    var rate = income != null && income > 0 ? (saved / income) * 100 : null;

    var incomeTileInner;
    if (editingIncome) {
      incomeTileInner =
        '<div class="stat-label">Monthly income</div>' +
        '<div class="income-edit">' +
        '<input id="income-input" type="number" inputmode="decimal" step="0.01" min="0" placeholder="0.00" value="' +
        (income != null ? income : "") + '" />' +
        '<button type="button" class="save" id="income-save">Save</button>' +
        '<button type="button" class="cancel" id="income-cancel">✕</button>' +
        "</div>";
    } else {
      incomeTileInner =
        '<div class="stat-label">Monthly income</div>' +
        '<div class="stat-value">' + (income != null ? fmtMoney(income) : "Set income") + "</div>" +
        '<div class="stat-sub">' + (income != null ? "tap to edit" : "tap to add") + "</div>";
    }

    var savedClass = saved == null ? "" : saved >= 0 ? "positive" : "negative";
    var rateText = rate == null ? "—" : Math.round(rate) + "%";

    el.innerHTML =
      '<div class="stat-tile editable" id="income-tile">' + incomeTileInner + "</div>" +
      '<div class="stat-tile">' +
      '<div class="stat-label">Spent this period</div>' +
      '<div class="stat-value">' + fmtMoney(spent) + "</div>" +
      '<div class="stat-sub">' + txs.length + (txs.length === 1 ? " expense" : " expenses") + "</div>" +
      "</div>" +
      '<div class="stat-tile">' +
      '<div class="stat-label">Left over</div>' +
      '<div class="stat-value ' + savedClass + '">' + (saved == null ? "—" : fmtMoney(saved)) + "</div>" +
      '<div class="stat-sub">' + leftoverSub(income, saved, cardsOwed) + "</div>" +
      "</div>" +
      '<div class="stat-tile">' +
      '<div class="stat-label">Savings rate</div>' +
      '<div class="stat-value ' + savedClass + '">' + rateText + "</div>" +
      '<div class="stat-sub">of income kept</div>' +
      "</div>";

    if (!editingIncome) {
      document.getElementById("income-tile").addEventListener("click", function () {
        editingIncome = true;
        renderStats();
        var inp = document.getElementById("income-input");
        if (inp) inp.focus();
      });
    } else {
      document.getElementById("income-tile").addEventListener("click", function (e) { e.stopPropagation(); });
      document.getElementById("income-save").addEventListener("click", function () {
        var v = parseFloat(document.getElementById("income-input").value);
        state.income = isFinite(v) && v > 0 ? v : null;
        editingIncome = false;
        renderAll();
        dbCall(sb.from("settings").upsert({ user_id: currentUserId, income: state.income }, { onConflict: "user_id" }));
      });
      document.getElementById("income-cancel").addEventListener("click", function () {
        editingIncome = false;
        renderStats();
      });
    }
  }

  function renderLedger() {
    var listEl = document.getElementById("ledger-list");
    var countEl = document.getElementById("ledger-count");
    var txs = currentTxs().slice().sort(function (a, b) {
      return a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? 1 : -1;
    });
    countEl.textContent = txs.length ? txs.length + (txs.length === 1 ? " entry" : " entries") : "";

    if (!txs.length) {
      listEl.innerHTML = '<p class="empty-state">No expenses logged for ' + esc(activeRangeLabel()) + " yet — add your first one above.</p>";
      return;
    }

    listEl.innerHTML = txs.map(function (t) {
      var cat = CATEGORIES[CAT_INDEX[t.categoryId]] || CATEGORIES[CATEGORIES.length - 1];
      var d = new Date(t.date + "T00:00:00");
      var dateShort = d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
      return (
        '<div class="ledger-row" data-id="' + esc(t.id) + '">' +
        '<div class="ledger-date">' + esc(dateShort) + "</div>" +
        '<div class="ledger-main">' +
        '<div class="ledger-cat"><span class="cat-dot" style="background:var(--cat-' + (CAT_INDEX[t.categoryId] + 1) + ')"></span>' + esc(cat.label) +
        (t.paymentMethod ? ' <span class="pm-badge">' + esc(t.paymentMethod) + "</span>" : "") + "</div>" +
        (t.note ? '<div class="ledger-note">' + esc(t.note) + "</div>" : "") +
        "</div>" +
        '<div class="ledger-amount">' + fmtMoney(t.amount) + "</div>" +
        '<button type="button" class="ledger-del" data-id="' + esc(t.id) + '">Delete</button>' +
        "</div>"
      );
    }).join("");

    listEl.querySelectorAll(".ledger-del").forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (btn.dataset.confirming === "1") {
          deleteTransaction(btn.dataset.id);
        } else {
          btn.dataset.confirming = "1";
          btn.textContent = "Sure?";
          btn.classList.add("confirming");
          setTimeout(function () {
            btn.dataset.confirming = "0";
            btn.textContent = "Delete";
            btn.classList.remove("confirming");
          }, 2800);
        }
      });
    });
  }

  function renderBreakdown() {
    var el = document.getElementById("breakdown");
    var txs = currentTxs();
    var sums = sumBy(txs);
    var prevSums = customRange ? {} : sumBy(txForPeriod(shiftMonth(viewMonth, -1)));
    var rows = Object.keys(sums).map(function (catId) {
      return { catId: catId, amount: sums[catId] };
    }).sort(function (a, b) { return b.amount - a.amount; });

    if (!rows.length) {
      el.innerHTML = '<p class="empty-state">Nothing to break down yet.</p>';
      return;
    }

    var max = rows[0].amount;
    el.innerHTML = rows.map(function (r) {
      var cat = CATEGORIES[CAT_INDEX[r.catId]];
      var idx = CAT_INDEX[r.catId] + 1;
      var prev = prevSums[r.catId] || 0;
      var delta = r.amount - prev;
      var deltaHtml = "";
      if (prev > 0 && Math.abs(delta) >= 1) {
        deltaHtml = '<span class="breakdown-delta ' + (delta > 0 ? "up" : "down") + '">' + (delta > 0 ? "+" : "−") + fmtMoney(Math.abs(delta)) + "</span>";
      }
      return (
        '<div class="breakdown-row">' +
        '<div class="breakdown-top"><div class="breakdown-cat"><span class="cat-dot" style="background:var(--cat-' + idx + ')"></span><span class="label">' + esc(cat.label) + "</span></div>" +
        '<div>' + '<span class="breakdown-amt">' + fmtMoney(r.amount) + "</span>" + deltaHtml + "</div></div>" +
        '<div class="bar-track"><div class="bar-fill" style="width:' + Math.max(4, (r.amount / max) * 100) + "%;background:var(--cat-" + idx + ')"></div></div>' +
        "</div>"
      );
    }).join("");
  }

  function windowLabel(sel) {
    if (sel === "all") return "all time";
    return "the last " + sel + " months";
  }

  function renderPatterns() {
    var el = document.getElementById("patterns-list");
    var rows = computePatternsData(patternsWindow);

    if (!state.transactions.length) {
      el.innerHTML = '<p class="empty-state">Add a few expenses to see your spending patterns here.</p>';
      return;
    }
    if (!rows.length) {
      el.innerHTML = '<p class="empty-state">No expenses logged in ' + esc(windowLabel(patternsWindow)) + " — try a wider window.</p>";
      return;
    }

    var max = rows[0].count;
    el.innerHTML = rows.map(function (r) {
      var cat = CATEGORIES[CAT_INDEX[r.catId]] || CATEGORIES[CATEGORIES.length - 1];
      var idx = CAT_INDEX[r.catId] + 1;

      var trendHtml = "";
      if (r.trend) {
        if (r.trend.kind === "up") trendHtml = '<span class="breakdown-delta up">+' + r.trend.pct + "%</span>";
        else if (r.trend.kind === "down") trendHtml = '<span class="breakdown-delta down">−' + Math.abs(r.trend.pct) + "%</span>";
        else if (r.trend.kind === "flat") trendHtml = '<span class="breakdown-delta flat">steady</span>';
        else trendHtml = '<span class="breakdown-delta flat">no prior data</span>';
      }

      var subParts = [fmtMoney(r.avgAmount) + " avg"];
      if (r.avgGapDays == null) subParts.push("only 1 purchase in this window");
      else subParts.push("about every " + Math.round(r.avgGapDays) + (Math.round(r.avgGapDays) === 1 ? " day" : " days"));
      if (r.weekday) subParts.push("mostly " + WEEKDAY_LABELS[r.weekday.day]);

      return (
        '<div class="breakdown-row">' +
        '<div class="breakdown-top"><div class="breakdown-cat"><span class="cat-dot" style="background:var(--cat-' + idx + ')"></span><span class="label">' + esc(cat.label) + "</span></div>" +
        '<div>' + '<span class="breakdown-amt">' + r.count + (r.count === 1 ? " time" : " times") + "</span>" + trendHtml + "</div></div>" +
        '<div class="bar-track"><div class="bar-fill" style="width:' + Math.max(4, (r.count / max) * 100) + "%;background:var(--cat-" + idx + ')"></div></div>' +
        '<div class="pattern-sub">' + esc(subParts.join(" · ")) + "</div>" +
        "</div>"
      );
    }).join("");
  }

  function renderInsights() {
    var el = document.getElementById("insights");
    var txs = currentTxs();
    var cards = [];

    if (!txs.length) {
      cards.push("No expenses logged for " + esc(activeRangeLabel()) + " yet. Once you add a few, this panel will surface patterns automatically.");
    } else {
      var sums = sumBy(txs);
      var spent = txs.reduce(function (s, t) { return s + t.amount; }, 0);
      var top = Object.keys(sums).map(function (k) { return { catId: k, amount: sums[k] }; }).sort(function (a, b) { return b.amount - a.amount; })[0];
      var topCat = CATEGORIES[CAT_INDEX[top.catId]];
      var pct = spent > 0 ? Math.round((top.amount / spent) * 100) : 0;
      cards.push("<strong>" + esc(topCat.label) + "</strong> is your biggest spend this period at " + fmtMoney(top.amount) + " (" + pct + "% of total).");

      var prevSums = customRange ? {} : sumBy(txForPeriod(shiftMonth(viewMonth, -1)));
      var biggestJump = null;
      Object.keys(sums).forEach(function (catId) {
        var prev = prevSums[catId] || 0;
        var delta = sums[catId] - prev;
        if (prev > 0 && delta > 20 && delta / prev > 0.15) {
          if (!biggestJump || delta > biggestJump.delta) biggestJump = { catId: catId, delta: delta };
        }
      });
      if (biggestJump) {
        var jc = CATEGORIES[CAT_INDEX[biggestJump.catId]];
        cards.push("<strong>" + esc(jc.label) + "</strong> is up " + fmtMoney(biggestJump.delta) + " versus last period.");
      }

      if (state.income != null && state.income > 0) {
        var saved = state.income - spent;
        var rate = (saved / state.income) * 100;
        if (rate >= 20) {
          cards.push("You're saving " + Math.round(rate) + "% of income this period — ahead of the common 20% guideline.");
        } else if (rate >= 10) {
          cards.push("Saving " + Math.round(rate) + "% of income so far this period, getting closer to the 20% guideline some planners suggest.");
        } else if (rate >= 0) {
          cards.push("Only " + Math.round(rate) + "% of income left over this period — " + esc(topCat.label) + " is where most of it went.");
        } else {
          cards.push("Spending has outpaced income this period by " + fmtMoney(Math.abs(saved)) + ".");
        }
      } else {
        cards.push("Add your monthly income above to see a savings rate here.");
      }
    }

    el.innerHTML = cards.slice(0, 4).map(function (c) { return '<div class="insight-card">' + c + "</div>"; }).join("");
  }

  function nextOccurrence(day, from) {
    from = from || new Date();
    var today0 = new Date(from.getFullYear(), from.getMonth(), from.getDate());
    var candidate = new Date(today0.getFullYear(), today0.getMonth(), day);
    if (candidate < today0) candidate = new Date(today0.getFullYear(), today0.getMonth() + 1, day);
    return candidate;
  }

  function lastOccurrence(day, from) {
    from = from || new Date();
    var today0 = new Date(from.getFullYear(), from.getMonth(), from.getDate());
    var candidate = new Date(today0.getFullYear(), today0.getMonth(), day);
    if (candidate > today0) candidate = new Date(today0.getFullYear(), today0.getMonth() - 1, day);
    return candidate;
  }

  function daysAwayLabel(n) {
    if (n === 0) return "today";
    if (n === 1) return "tomorrow";
    if (n > 1) return "in " + n + " days";
    if (n === -1) return "1 day overdue";
    return (-n) + " days overdue";
  }

  function ordinal(n) {
    var v = n % 100;
    if (v >= 11 && v <= 13) return n + "th";
    switch (n % 10) {
      case 1: return n + "st";
      case 2: return n + "nd";
      case 3: return n + "rd";
      default: return n + "th";
    }
  }

  function categoryOptionsHtml(selectedId) {
    return CATEGORIES.map(function (c) {
      return '<option value="' + esc(c.id) + '"' + (c.id === selectedId ? " selected" : "") + ">" + esc(c.label) + "</option>";
    }).join("");
  }

  function monthShortLabel(mk) {
    var d = new Date(mk + "-01T00:00:00");
    return d.toLocaleDateString("en-GB", { month: "short", year: "numeric" });
  }

  // credit card statement/payment reminders

  function pendingCardReminders() {
    var now = new Date();
    var out = [];
    state.creditCards.forEach(function (c) {
      var stmtDateStr = todayStr(lastOccurrence(c.statementDay, now));
      var exists = state.cardBalances.some(function (b) { return b.cardId === c.id && b.statementDate === stmtDateStr; });
      if (!exists) out.push({ card: c, statementDate: stmtDateStr });
    });
    return out;
  }

  function recordCardBalance(cardId, statementDate, amount) {
    var card = state.creditCards.filter(function (c) { return c.id === cardId; })[0];
    if (!card) return;
    var stmtDateObj = new Date(statementDate + "T00:00:00");
    var dueDateObj = nextOccurrence(card.paymentDay, stmtDateObj);
    var entry = {
      id: genId(),
      cardId: cardId,
      statementDate: statementDate,
      dueDate: todayStr(dueDateObj),
      amount: amount,
      paid: false,
      paidDate: null,
      createdAt: todayStr()
    };
    state.cardBalances.push(entry);
    renderAll();
    dbCall(sb.from("card_balances").insert(balanceToRow(entry)));
  }

  function markCardBalancePaid(id) {
    var entry = state.cardBalances.filter(function (b) { return b.id === id; })[0];
    if (!entry) return;
    entry.paid = true;
    entry.paidDate = todayStr();
    renderAll();
    dbCall(sb.from("card_balances").update({ paid: true, paid_date: entry.paidDate }).eq("id", id));
  }

  function renderCalendar() {
    var el = document.getElementById("calendar-list");
    var now = new Date();
    var today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var events = [];
    state.incomeSources.forEach(function (s) {
      events.push({ date: nextOccurrence(s.payDay, now), label: s.label, type: "income" });
    });
    state.creditCards.forEach(function (c) {
      events.push({ date: nextOccurrence(c.statementDay, now), label: c.label + " — statement closes", type: "statement" });

      var unpaid = state.cardBalances.filter(function (b) { return b.cardId === c.id && !b.paid; });
      if (unpaid.length) {
        unpaid.forEach(function (b) {
          events.push({
            date: new Date(b.dueDate + "T00:00:00"),
            label: c.label + " — payment due",
            type: "payment",
            amount: b.amount,
            balanceId: b.id
          });
        });
      } else {
        events.push({ date: nextOccurrence(c.paymentDay, now), label: c.label + " — payment due", type: "payment" });
      }
    });
    events.sort(function (a, b) { return a.date - b.date; });

    el.innerHTML = events.map(function (ev) {
      var days = Math.round((ev.date - today0) / 86400000);
      var dayNum = String(ev.date.getDate()).padStart(2, "0");
      var monLbl = ev.date.toLocaleDateString("en-GB", { month: "short" });
      var dotVar = ev.type === "income" ? "var(--positive)" : ev.type === "payment" ? "var(--negative)" : "var(--brass)";
      var subClass = days < 0 ? "cal-sub overdue" : "cal-sub";
      var amountRow = ev.amount != null
        ? '<div class="cal-amount-row"><span class="cal-amount">' + fmtMoney(ev.amount) + "</span>" +
          (ev.balanceId ? '<button type="button" class="btn-bought cal-mark-paid" data-id="' + esc(ev.balanceId) + '">Mark as paid</button>' : "") +
          "</div>"
        : "";
      return (
        '<div class="cal-row">' +
        '<div class="cal-date"><div class="cal-day">' + dayNum + '</div><div class="cal-mon">' + esc(monLbl) + "</div></div>" +
        '<div class="cal-main"><div class="cal-label">' + esc(ev.label) + '</div><div class="' + subClass + '">' + daysAwayLabel(days) + "</div>" + amountRow + "</div>" +
        '<span class="cal-dot" style="background:' + dotVar + '"></span>' +
        "</div>"
      );
    }).join("");

    el.querySelectorAll(".cal-mark-paid").forEach(function (btn) {
      btn.addEventListener("click", function () { markCardBalancePaid(btn.dataset.id); });
    });
  }

  function renderCardReminders() {
    var el = document.getElementById("card-reminder-banner");
    var pending = pendingCardReminders();
    if (!pending.length) {
      el.hidden = true;
      el.innerHTML = "";
      return;
    }
    el.hidden = false;
    el.innerHTML = pending.map(function (p) {
      var d = new Date(p.statementDate + "T00:00:00");
      var dateLabel = d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
      return (
        '<div class="card-reminder-row" data-card-id="' + esc(p.card.id) + '" data-stmt-date="' + esc(p.statementDate) + '">' +
        '<div class="card-reminder-text">💳 <strong>' + esc(p.card.label) + "</strong> statement generated " + esc(dateLabel) + " — enter the balance to pay</div>" +
        '<div class="amount-input"><span class="currency-prefix">£</span><input type="number" inputmode="decimal" step="0.01" min="0.01" class="card-reminder-input" placeholder="0.00" /></div>' +
        '<button type="button" class="btn-primary card-reminder-save">Save</button>' +
        "</div>"
      );
    }).join("");

    el.querySelectorAll(".card-reminder-save").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var row = btn.closest(".card-reminder-row");
        var input = row.querySelector(".card-reminder-input");
        var amount = parseFloat(input.value);
        if (!isFinite(amount) || amount <= 0) { input.focus(); return; }
        recordCardBalance(row.dataset.cardId, row.dataset.stmtDate, Math.round(amount * 100) / 100);
      });
      btn.previousElementSibling.querySelector("input").addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); btn.click(); }
      });
    });
  }

  function renderCalendarEditForm() {
    var form = document.getElementById("calendar-edit-form");
    var rows = "";
    rows += '<div class="edit-group-label">Income</div>';
    state.incomeSources.forEach(function (s) {
      rows +=
        '<div class="edit-row" data-kind="income" data-id="' + esc(s.id) + '">' +
        '<input type="text" class="edit-label" value="' + esc(s.label) + '" maxlength="40" />' +
        '<span class="edit-suffix">day</span><input type="number" class="edit-day" min="1" max="31" value="' + s.payDay + '" />' +
        '<button type="button" class="link-btn edit-remove">Remove</button>' +
        "</div>";
    });
    rows += '<button type="button" class="link-btn edit-add" data-add="income">+ Add income source</button>';
    rows += '<div class="edit-group-label">Credit cards</div>';
    state.creditCards.forEach(function (c) {
      rows +=
        '<div class="edit-row" data-kind="card" data-id="' + esc(c.id) + '">' +
        '<input type="text" class="edit-label" value="' + esc(c.label) + '" maxlength="40" />' +
        '<span class="edit-suffix">statement</span><input type="number" class="edit-stmt" min="1" max="31" value="' + c.statementDay + '" />' +
        '<span class="edit-suffix">payment</span><input type="number" class="edit-pay" min="1" max="31" value="' + c.paymentDay + '" />' +
        '<button type="button" class="link-btn edit-remove">Remove</button>' +
        "</div>";
    });
    rows += '<button type="button" class="link-btn edit-add" data-add="card">+ Add credit card</button>';
    rows += '<button type="submit" class="btn-primary">Save dates</button>';
    form.innerHTML = rows;

    form.querySelectorAll(".edit-remove").forEach(function (btn) {
      btn.addEventListener("click", function () { btn.closest(".edit-row").remove(); });
    });
    var addIncomeBtn = form.querySelector('.edit-add[data-add="income"]');
    addIncomeBtn.addEventListener("click", function () {
      var row = document.createElement("div");
      row.className = "edit-row";
      row.dataset.kind = "income";
      row.dataset.id = "";
      row.innerHTML =
        '<input type="text" class="edit-label" value="New income" maxlength="40" />' +
        '<span class="edit-suffix">day</span><input type="number" class="edit-day" min="1" max="31" value="1" />' +
        '<button type="button" class="link-btn edit-remove">Remove</button>';
      row.querySelector(".edit-remove").addEventListener("click", function () { row.remove(); });
      addIncomeBtn.insertAdjacentElement("beforebegin", row);
      row.querySelector(".edit-label").focus();
      row.querySelector(".edit-label").select();
    });
    var addCardBtn = form.querySelector('.edit-add[data-add="card"]');
    addCardBtn.addEventListener("click", function () {
      var row = document.createElement("div");
      row.className = "edit-row";
      row.dataset.kind = "card";
      row.dataset.id = "";
      row.innerHTML =
        '<input type="text" class="edit-label" value="New card" maxlength="40" />' +
        '<span class="edit-suffix">statement</span><input type="number" class="edit-stmt" min="1" max="31" value="1" />' +
        '<span class="edit-suffix">payment</span><input type="number" class="edit-pay" min="1" max="31" value="1" />' +
        '<button type="button" class="link-btn edit-remove">Remove</button>';
      row.querySelector(".edit-remove").addEventListener("click", function () { row.remove(); });
      addCardBtn.insertAdjacentElement("beforebegin", row);
      row.querySelector(".edit-label").focus();
      row.querySelector(".edit-label").select();
    });
  }

  function renderCalendarPanel() {
    document.getElementById("calendar-list").hidden = editingCalendar;
    document.getElementById("calendar-edit-form").hidden = !editingCalendar;
    document.getElementById("cal-edit-toggle").textContent = editingCalendar ? "Cancel" : "Edit";
    if (editingCalendar) { renderCalendarEditForm(); } else { renderCalendar(); }
  }

  function renderPlanned() {
    var listEl = document.getElementById("planned-list");
    var summaryEl = document.getElementById("planned-summary");
    var items = state.plannedExpenses.slice().sort(function (a, b) { return b.amount - a.amount; });
    var total = items.reduce(function (s, p) { return s + p.amount; }, 0);

    if (!items.length) {
      summaryEl.textContent = "";
      listEl.innerHTML = '<p class="empty-state">Nothing planned yet — add a big purchase you\'re thinking about above.</p>';
      return;
    }

    var summary = fmtMoney(total) + " planned";
    if (state.income != null) {
      var txs = currentTxs();
      var spent = txs.reduce(function (s, t) { return s + t.amount; }, 0);
      var leftover = state.income - spent - totalOutstandingCardBalance();
      if (total <= leftover) {
        summary += " · fits within this period's " + fmtMoney(leftover) + " leftover";
      } else {
        summary += " · " + fmtMoney(total - leftover) + " more than this period's leftover";
      }
    }
    summaryEl.textContent = summary;

    listEl.innerHTML = items.map(function (p) {
      var cat = CATEGORIES[CAT_INDEX[p.categoryId]] || CATEGORIES[CATEGORIES.length - 1];
      var idx = CAT_INDEX[p.categoryId] + 1;
      return (
        '<div class="planned-row" data-id="' + esc(p.id) + '">' +
        '<div class="planned-main"><div class="planned-name">' + esc(p.name) + '</div>' +
        '<div class="planned-cat"><span class="cat-dot" style="background:var(--cat-' + idx + ')"></span>' + esc(cat.label) + "</div></div>" +
        '<div class="planned-amount">' + fmtMoney(p.amount) + "</div>" +
        '<div class="planned-actions"><button type="button" class="btn-bought" data-id="' + esc(p.id) + '">Bought</button>' +
        '<button type="button" class="ledger-del" data-id="' + esc(p.id) + '">Remove</button></div>' +
        "</div>"
      );
    }).join("");

    listEl.querySelectorAll(".btn-bought").forEach(function (btn) {
      btn.addEventListener("click", function () { markPlannedBought(btn.dataset.id); });
    });
    listEl.querySelectorAll(".ledger-del").forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (btn.dataset.confirming === "1") {
          removePlanned(btn.dataset.id);
        } else {
          btn.dataset.confirming = "1";
          btn.textContent = "Sure?";
          btn.classList.add("confirming");
          setTimeout(function () {
            btn.dataset.confirming = "0";
            btn.textContent = "Remove";
            btn.classList.remove("confirming");
          }, 2800);
        }
      });
    });
  }

  function renderRecurring() {
    var listEl = document.getElementById("recurring-list");
    var summaryEl = document.getElementById("recurring-summary");
    var rules = state.recurringExpenses.slice().sort(function (a, b) { return a.dayOfMonth - b.dayOfMonth; });
    var activeRules = rules.filter(function (r) { return r.active; });
    var monthlyTotal = activeRules.reduce(function (s, r) { return s + r.amount; }, 0);

    summaryEl.textContent = rules.length
      ? fmtMoney(monthlyTotal) + "/mo across " + activeRules.length + (activeRules.length === 1 ? " payment" : " payments") +
        (rules.length > activeRules.length ? " · " + (rules.length - activeRules.length) + " paused" : "")
      : "";

    if (!rules.length) {
      listEl.innerHTML = '<p class="empty-state">No direct debits set up yet.</p>';
      return;
    }

    listEl.innerHTML = rules.map(function (r) {
      var cat = CATEGORIES[CAT_INDEX[r.categoryId]] || CATEGORIES[CATEGORIES.length - 1];
      var idx = CAT_INDEX[r.categoryId] + 1;
      var subParts = [cat.label];
      if (r.installment) {
        var remaining = installmentRemaining(r);
        var paid = Math.round((r.installment.totalOwed - remaining) * 100) / 100;
        subParts.push(fmtMoney(paid) + " of " + fmtMoney(r.installment.totalOwed) + " paid" + (remaining <= 0 ? " — done" : ""));
      }
      if (r.startMonth && r.startMonth > todayStr().slice(0, 7)) subParts.push("starts " + monthShortLabel(r.startMonth));
      if (!r.active) subParts.push("paused");
      return (
        '<div class="recurring-row' + (r.active ? "" : " paused") + '">' +
        '<div class="recurring-main">' +
        '<div class="recurring-label"><span class="cat-dot" style="background:var(--cat-' + idx + ')"></span>' + esc(r.label) +
        '<span class="recurring-day">· ' + ordinal(r.dayOfMonth) + '</span></div>' +
        '<div class="recurring-sub">' + esc(subParts.join(" · ")) + "</div>" +
        "</div>" +
        '<div class="recurring-amount">' + fmtMoney(r.amount) + "</div>" +
        "</div>"
      );
    }).join("");
  }

  function renderRecurringEditForm() {
    var form = document.getElementById("recurring-edit-form");
    var rules = state.recurringExpenses.slice().sort(function (a, b) { return a.dayOfMonth - b.dayOfMonth; });
    var rows = rules.map(function (r) {
      return (
        '<div class="edit-row" data-rule-id="' + esc(r.id) + '">' +
        '<input type="text" class="edit-label" value="' + esc(r.label) + '" maxlength="60" />' +
        '<span class="edit-suffix">£</span><input type="number" step="0.01" min="0" class="edit-amount" value="' + r.amount + '" />' +
        '<span class="edit-suffix">day</span><input type="number" class="edit-day" min="1" max="31" value="' + r.dayOfMonth + '" />' +
        '<select class="edit-category">' + categoryOptionsHtml(r.categoryId) + "</select>" +
        '<span class="edit-suffix">from</span><input type="month" class="edit-start" value="' + esc(r.startMonth || "") + '" title="Starts (blank = always)" />' +
        '<label class="edit-active-toggle"><input type="checkbox" class="edit-active" ' + (r.active ? "checked" : "") + ' /> active</label>' +
        '<button type="button" class="link-btn edit-remove">Remove</button>' +
        "</div>"
      );
    }).join("");
    form.innerHTML = '<div class="edit-group-label">Direct debits</div>' + rows + '<button type="submit" class="btn-primary">Save changes</button>';

    form.querySelectorAll(".edit-remove").forEach(function (btn) {
      btn.addEventListener("click", function () { btn.closest(".edit-row").remove(); });
    });
  }

  function renderRecurringPanel() {
    document.getElementById("recurring-list").hidden = editingRecurring;
    document.getElementById("recurring-edit-form").hidden = !editingRecurring;
    document.getElementById("recurring-edit-toggle").textContent = editingRecurring ? "Cancel" : "Edit";
    if (editingRecurring) { renderRecurringEditForm(); } else { renderRecurring(); }
  }

  function renderAll() {
    renderMonthLabel();
    renderCardReminders();
    renderStats();
    renderLedger();
    renderBreakdown();
    renderPatterns();
    renderInsights();
    renderCalendarPanel();
    renderPlanned();
    renderRecurringPanel();
  }

  // ---------- persistence (Supabase) ----------

  function showBanner() {
    var el = document.getElementById("sync-banner");
    el.textContent = "Couldn't save that change — check your connection and try again.";
    el.hidden = false;
  }
  function hideBanner() {
    document.getElementById("sync-banner").hidden = true;
  }

  // Fires a Supabase call (or Promise.all of several) in the background.
  // The UI has already been updated optimistically before this is called;
  // this only surfaces a banner if the write actually failed.
  function dbCall(p) {
    Promise.resolve(p).then(function (res) {
      if (Array.isArray(res)) {
        var failed = res.filter(function (r) { return r && r.error; })[0];
        if (failed) { console.error(failed.error); showBanner(); } else { hideBanner(); }
      } else if (res && res.error) {
        console.error(res.error);
        showBanner();
      } else {
        hideBanner();
      }
    }).catch(function (err) {
      console.error(err);
      showBanner();
    });
  }

  // ---------- row <-> state mapping ----------

  // Every insert/upsert includes user_id so Row Level Security's "with check"
  // clause is satisfied — each row is only ever written under the signed-in
  // user's own id, which is also what keeps one person's data invisible to
  // anyone else who signs in.
  function rowToIncomeSource(r) { return { id: r.id, label: r.label, payDay: r.pay_day }; }
  function incomeSourceToRow(s, sortOrder) { return { id: s.id, user_id: currentUserId, label: s.label, pay_day: s.payDay, sort_order: sortOrder }; }

  function rowToCreditCard(r) { return { id: r.id, label: r.label, statementDay: r.statement_day, paymentDay: r.payment_day }; }
  function creditCardToRow(c, sortOrder) { return { id: c.id, user_id: currentUserId, label: c.label, statement_day: c.statementDay, payment_day: c.paymentDay, sort_order: sortOrder }; }

  function rowToTx(r) {
    return {
      id: r.id, amount: Number(r.amount), date: r.date, categoryId: r.category_id,
      note: r.note || "", recurringId: r.recurring_id || null, recurringOccurrence: r.recurring_occurrence || null,
      paymentMethod: r.payment_method || ""
    };
  }
  function txToRow(t) {
    return {
      id: t.id, user_id: currentUserId, amount: t.amount, date: t.date, category_id: t.categoryId,
      note: t.note || "", recurring_id: t.recurringId || null, recurring_occurrence: t.recurringOccurrence || null,
      payment_method: t.paymentMethod || null
    };
  }

  function rowToPlanned(r) { return { id: r.id, name: r.name, amount: Number(r.amount), categoryId: r.category_id, note: r.note || "", createdAt: r.created_at }; }
  function plannedToRow(p) { return { id: p.id, user_id: currentUserId, name: p.name, amount: p.amount, category_id: p.categoryId, note: p.note || "", created_at: p.createdAt }; }

  function rowToBalance(r) {
    return {
      id: r.id, cardId: r.card_id, statementDate: r.statement_date, dueDate: r.due_date,
      amount: Number(r.amount), paid: !!r.paid, paidDate: r.paid_date || null, createdAt: r.created_at
    };
  }
  function balanceToRow(b) {
    return {
      id: b.id, user_id: currentUserId, card_id: b.cardId, statement_date: b.statementDate, due_date: b.dueDate,
      amount: b.amount, paid: b.paid, paid_date: b.paidDate || null, created_at: b.createdAt
    };
  }

  function rowToRecurring(r) {
    return {
      id: r.id, label: r.label, amount: Number(r.amount), dayOfMonth: r.day_of_month, categoryId: r.category_id,
      active: !!r.active, installment: r.installment_total != null ? { totalOwed: Number(r.installment_total) } : null,
      startMonth: r.start_month || null, createdAt: r.created_at
    };
  }
  function recurringToRow(rec) {
    return {
      id: rec.id, user_id: currentUserId, label: rec.label, amount: rec.amount, day_of_month: rec.dayOfMonth, category_id: rec.categoryId,
      active: rec.active, installment_total: rec.installment ? rec.installment.totalOwed : null,
      start_month: rec.startMonth || null, created_at: rec.createdAt
    };
  }

  async function loadAll() {
    var results = await Promise.all([
      sb.from("settings").select("*").maybeSingle(),
      sb.from("income_sources").select("*").order("sort_order"),
      sb.from("credit_cards").select("*").order("sort_order"),
      sb.from("transactions").select("*"),
      sb.from("planned_expenses").select("*"),
      sb.from("card_balances").select("*"),
      sb.from("recurring_expenses").select("*")
    ]);

    var firstError = results.map(function (r) { return r.error; }).filter(Boolean)[0];
    if (firstError) throw firstError;

    var settingsRow = results[0].data;
    state = {
      currency: (settingsRow && settingsRow.currency) || "GBP",
      income: settingsRow && settingsRow.income != null ? Number(settingsRow.income) : null,
      incomeSources: (results[1].data || []).map(rowToIncomeSource),
      creditCards: (results[2].data || []).map(rowToCreditCard),
      transactions: (results[3].data || []).map(rowToTx),
      plannedExpenses: (results[4].data || []).map(rowToPlanned),
      cardBalances: (results[5].data || []).map(rowToBalance),
      recurringExpenses: (results[6].data || []).map(rowToRecurring)
    };
  }

  function addTransaction(data) {
    var t = {
      id: genId(), amount: data.amount, date: data.date, categoryId: data.categoryId, note: data.note,
      recurringId: null, recurringOccurrence: null, paymentMethod: data.paymentMethod || ""
    };
    state.transactions.push(t);
    renderAll();
    dbCall(sb.from("transactions").insert(txToRow(t)));
  }

  function deleteTransaction(id) {
    state.transactions = state.transactions.filter(function (t) { return t.id !== id; });
    renderAll();
    dbCall(sb.from("transactions").delete().eq("id", id));
  }

  function markPlannedBought(id) {
    var item = state.plannedExpenses.filter(function (p) { return p.id === id; })[0];
    if (!item) return;
    state.plannedExpenses = state.plannedExpenses.filter(function (p) { return p.id !== id; });
    var t = {
      id: genId(), amount: item.amount, date: todayStr(), categoryId: item.categoryId,
      note: item.note ? (item.name + " — " + item.note) : item.name, recurringId: null, recurringOccurrence: null
    };
    state.transactions.push(t);
    renderAll();
    dbCall(Promise.all([
      sb.from("planned_expenses").delete().eq("id", id),
      sb.from("transactions").insert(txToRow(t))
    ]));
  }

  function removePlanned(id) {
    state.plannedExpenses = state.plannedExpenses.filter(function (p) { return p.id !== id; });
    renderAll();
    dbCall(sb.from("planned_expenses").delete().eq("id", id));
  }

  // ---------- wiring ----------

  function wireForm() {
    document.getElementById("f-date").value = todayStr();
    document.getElementById("add-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var amount = parseFloat(document.getElementById("f-amount").value);
      var categoryId = document.getElementById("f-category").value;
      var date = document.getElementById("f-date").value || todayStr();
      var note = document.getElementById("f-note").value.trim().slice(0, 80);
      var paymentMethod = document.getElementById("f-payment-method").value.trim().slice(0, 40);
      if (!isFinite(amount) || amount <= 0 || !categoryId) return;
      addTransaction({ amount: Math.round(amount * 100) / 100, date: date, categoryId: categoryId, note: note, paymentMethod: paymentMethod });
      document.getElementById("add-form").reset();
      document.getElementById("f-date").value = todayStr();
      document.getElementById("f-amount").focus();
    });
  }

  function wirePlannedForm() {
    document.getElementById("planned-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var name = document.getElementById("p-name").value.trim().slice(0, 60);
      var amount = parseFloat(document.getElementById("p-amount").value);
      var categoryId = document.getElementById("p-category").value;
      if (!name || !isFinite(amount) || amount <= 0 || !categoryId) return;
      var p = { id: genId(), name: name, amount: Math.round(amount * 100) / 100, categoryId: categoryId, note: "", createdAt: todayStr() };
      state.plannedExpenses.push(p);
      renderAll();
      dbCall(sb.from("planned_expenses").insert(plannedToRow(p)));
      document.getElementById("planned-form").reset();
    });
  }

  function clampDayInput(v, fallback) {
    var n = parseInt(v, 10);
    if (!isFinite(n)) return fallback;
    return Math.min(31, Math.max(1, n));
  }

  function wireCalendarEdit() {
    document.getElementById("cal-edit-toggle").addEventListener("click", function () {
      editingCalendar = !editingCalendar;
      renderCalendarPanel();
    });
    document.getElementById("calendar-edit-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var oldIncomeIds = state.incomeSources.map(function (s) { return s.id; });
      var oldCardIds = state.creditCards.map(function (c) { return c.id; });

      var incomeRows = document.querySelectorAll('.edit-row[data-kind="income"]');
      var newIncome = [];
      incomeRows.forEach(function (row, i) {
        var label = row.querySelector(".edit-label").value.trim().slice(0, 40) || ("Income " + (i + 1));
        var day = clampDayInput(row.querySelector(".edit-day").value, 1);
        newIncome.push({ id: row.dataset.id || genId(), label: label, payDay: day });
      });
      var cardRows = document.querySelectorAll('.edit-row[data-kind="card"]');
      var newCards = [];
      cardRows.forEach(function (row, i) {
        var label = row.querySelector(".edit-label").value.trim().slice(0, 40) || ("Card " + (i + 1));
        var stmt = clampDayInput(row.querySelector(".edit-stmt").value, 1);
        var pay = clampDayInput(row.querySelector(".edit-pay").value, 1);
        newCards.push({ id: row.dataset.id || genId(), label: label, statementDay: stmt, paymentDay: pay });
      });

      var removedIncomeIds = oldIncomeIds.filter(function (id) { return newIncome.every(function (s) { return s.id !== id; }); });
      var removedCardIds = oldCardIds.filter(function (id) { return newCards.every(function (c) { return c.id !== id; }); });

      state.incomeSources = newIncome;
      state.creditCards = newCards;
      editingCalendar = false;
      renderAll();

      var ops = [];
      if (newIncome.length) ops.push(sb.from("income_sources").upsert(newIncome.map(function (s, i) { return incomeSourceToRow(s, i); })));
      if (removedIncomeIds.length) ops.push(sb.from("income_sources").delete().in("id", removedIncomeIds));
      if (newCards.length) ops.push(sb.from("credit_cards").upsert(newCards.map(function (c, i) { return creditCardToRow(c, i); })));
      if (removedCardIds.length) ops.push(sb.from("credit_cards").delete().in("id", removedCardIds));
      dbCall(Promise.all(ops));
    });
  }

  function wireExportPanel() {
    var details = document.getElementById("export-panel");
    var textarea = document.getElementById("export-textarea");
    details.addEventListener("toggle", function () {
      if (details.open) textarea.value = JSON.stringify(state, null, 2);
    });
    document.getElementById("export-select-btn").addEventListener("click", function () {
      textarea.value = JSON.stringify(state, null, 2);
      textarea.focus();
      textarea.select();
    });
  }

  function wirePatternsWindow() {
    document.getElementById("patterns-window").addEventListener("change", function (e) {
      patternsWindow = e.target.value;
      renderPatterns();
    });
  }

  function wireRecurringAddForm() {
    document.getElementById("recurring-add-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var label = document.getElementById("rec-label").value.trim().slice(0, 60);
      var amount = parseFloat(document.getElementById("rec-amount").value);
      var day = clampDayInput(document.getElementById("rec-day").value, 1);
      var categoryId = document.getElementById("rec-category").value;
      var startsRaw = document.getElementById("rec-starts").value; // "" or "YYYY-MM"
      var totalRaw = document.getElementById("rec-total").value;
      var total = parseFloat(totalRaw);

      if (!label || !isFinite(amount) || amount <= 0 || !categoryId) return;

      var rule = {
        id: genId(),
        label: label,
        amount: Math.round(amount * 100) / 100,
        dayOfMonth: day,
        categoryId: categoryId,
        active: true,
        installment: (totalRaw && isFinite(total) && total > 0) ? { totalOwed: Math.round(total * 100) / 100 } : null,
        startMonth: /^\d{4}-\d{2}$/.test(startsRaw) ? startsRaw : null,
        createdAt: todayStr()
      };
      state.recurringExpenses.push(rule);
      var generated = generateRecurringTransactions();
      renderAll();

      var ops = [sb.from("recurring_expenses").insert(recurringToRow(rule))];
      if (generated.length) ops.push(sb.from("transactions").insert(generated.map(txToRow)));
      dbCall(Promise.all(ops));

      document.getElementById("recurring-add-form").reset();
    });
  }

  function wireRecurringEdit() {
    document.getElementById("recurring-edit-toggle").addEventListener("click", function () {
      editingRecurring = !editingRecurring;
      renderRecurringPanel();
    });
    document.getElementById("recurring-edit-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var oldIds = state.recurringExpenses.map(function (r) { return r.id; });
      var rows = document.querySelectorAll("#recurring-edit-form .edit-row");
      var updated = [];
      rows.forEach(function (row) {
        var id = row.dataset.ruleId;
        var existing = state.recurringExpenses.filter(function (r) { return r.id === id; })[0];
        var label = row.querySelector(".edit-label").value.trim().slice(0, 60) || (existing ? existing.label : "Payment");
        var amount = parseFloat(row.querySelector(".edit-amount").value);
        var day = clampDayInput(row.querySelector(".edit-day").value, existing ? existing.dayOfMonth : 1);
        var categoryId = row.querySelector(".edit-category").value;
        var active = row.querySelector(".edit-active").checked;
        var startMonth = row.querySelector(".edit-start").value;
        updated.push({
          id: id,
          label: label,
          amount: isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : (existing ? existing.amount : 0),
          dayOfMonth: day,
          categoryId: CAT_INDEX.hasOwnProperty(categoryId) ? categoryId : "other",
          active: active,
          installment: existing ? existing.installment : null,
          startMonth: /^\d{4}-\d{2}$/.test(startMonth) ? startMonth : null,
          createdAt: existing ? existing.createdAt : todayStr()
        });
      });
      var removedIds = oldIds.filter(function (id) { return updated.every(function (r) { return r.id !== id; }); });

      state.recurringExpenses = updated;
      editingRecurring = false;
      var generated = generateRecurringTransactions();
      renderAll();

      var ops = [];
      if (updated.length) ops.push(sb.from("recurring_expenses").upsert(updated.map(recurringToRow)));
      if (removedIds.length) ops.push(sb.from("recurring_expenses").delete().in("id", removedIds));
      if (generated.length) ops.push(sb.from("transactions").insert(generated.map(txToRow)));
      dbCall(Promise.all(ops));
    });
  }

  function wireMonthNav() {
    document.getElementById("prev-month").addEventListener("click", function () {
      viewMonth = shiftMonth(viewMonth, -1);
      renderAll();
    });
    document.getElementById("next-month").addEventListener("click", function () {
      viewMonth = shiftMonth(viewMonth, 1);
      renderAll();
    });
  }

  function wireRangePicker() {
    var toggleBtn = document.getElementById("range-toggle");
    var clearBtn = document.getElementById("range-clear");
    var form = document.getElementById("range-form");
    var startInput = document.getElementById("range-start");
    var endInput = document.getElementById("range-end");

    toggleBtn.addEventListener("click", function () {
      if (!form.hidden) { form.hidden = true; return; }
      var r = activeRangeStr();
      startInput.value = customRange ? customRange.start : r.start;
      endInput.value = customRange ? customRange.end : todayStr(new Date(new Date(r.end + "T00:00:00").getTime() - 86400000));
      form.hidden = false;
    });

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (!startInput.value || !endInput.value || startInput.value > endInput.value) return;
      customRange = { start: startInput.value, end: endInput.value };
      form.hidden = true;
      renderAll();
    });

    clearBtn.addEventListener("click", function () {
      customRange = null;
      form.hidden = true;
      renderAll();
    });
  }

  // ---------- auth ----------

  function showAuthScreen() {
    document.getElementById("app").hidden = true;
    document.getElementById("auth-screen").hidden = false;
    var btn = document.getElementById("auth-submit");
    btn.disabled = false;
    btn.textContent = "Sign in";
  }

  async function showApp() {
    document.getElementById("auth-error").hidden = true;
    document.getElementById("auth-screen").hidden = true;
    try {
      await loadAll();
    } catch (err) {
      console.error(err);
      showBanner();
    }
    viewMonth = currentPeriodKey();
    var generated = generateRecurringTransactions();
    if (generated.length) dbCall(sb.from("transactions").insert(generated.map(txToRow)));
    renderAll();
    document.getElementById("app").hidden = false;
  }

  function handleSession(session) {
    if (session && session.user) {
      if (currentUserId !== session.user.id) {
        currentUserId = session.user.id;
        showApp();
      }
    } else {
      currentUserId = null;
      showAuthScreen();
    }
  }

  function wireAuthForm() {
    var form = document.getElementById("auth-form");
    var errEl = document.getElementById("auth-error");
    var submitBtn = document.getElementById("auth-submit");
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      errEl.hidden = true;
      submitBtn.disabled = true;
      submitBtn.textContent = "Signing in…";
      var email = document.getElementById("auth-email").value.trim();
      var password = document.getElementById("auth-password").value;
      sb.auth.signInWithPassword({ email: email, password: password }).then(function (res) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Sign in";
        if (res.error) {
          errEl.textContent = res.error.message || "Could not sign in.";
          errEl.hidden = false;
        } else {
          document.getElementById("auth-password").value = "";
        }
      });
    });
  }

  // ---------- boot ----------

  function wireStatic() {
    populateCategorySelect("f-category");
    populateCategorySelect("p-category");
    populateCategorySelect("rec-category");
    wireForm();
    wirePlannedForm();
    wireCalendarEdit();
    wireRecurringEdit();
    wireRecurringAddForm();
    wireExportPanel();
    wirePatternsWindow();
    wireMonthNav();
    wireRangePicker();
    wireAuthForm();
    document.getElementById("signout-btn").addEventListener("click", function () {
      sb.auth.signOut();
    });
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && currentUserId) {
        var generated = generateRecurringTransactions();
        if (generated.length) {
          renderAll();
          dbCall(sb.from("transactions").insert(generated.map(txToRow)));
        }
      }
    });
  }

  async function boot() {
    wireStatic();
    var sessionRes = await sb.auth.getSession();
    handleSession(sessionRes.data.session);
    sb.auth.onAuthStateChange(function (event, session) {
      handleSession(session);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
