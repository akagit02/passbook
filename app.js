(function () {
  "use strict";

  // ---------- Supabase client ----------
  var sb = window.supabase.createClient(
    window.PASSBOOK_CONFIG.SUPABASE_URL,
    window.PASSBOOK_CONFIG.SUPABASE_ANON_KEY
  );

  // `discretionary` marks the categories the "where you could cut" analysis is
  // allowed to suggest trimming. Everything without it is treated as a cost
  // you can't simply decide to stop paying — it also forms the "essential
  // spend" figure the emergency-fund target is sized against.
  var CATEGORIES = [
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
  var CAT_INDEX = {};
  CATEGORIES.forEach(function (c, i) { CAT_INDEX[c.id] = i; });

  // ---------- savings ----------

  // Money put aside is logged as an ordinary transaction in this category (so
  // it lands in the ledger and comes off "left over" through the same path as
  // any other money leaving a bank account), paired with a row in
  // savings_contributions holding the part the ledger has no room for: where
  // it went. Everything that treats transactions as *spending* has to exclude
  // this category — see spendingTxs().
  var SAVINGS_CAT = "savings";

  // `tier` is what the allocation advice reasons about: cash is instantly
  // reachable and doesn't move in value, low is capital-preservation with a
  // modest yield, growth is expected to return more over long periods while
  // being free to fall in the short ones. `isa` marks the two that draw on the
  // annual ISA allowance.
  var SAVINGS_VEHICLES = [
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
  var VEHICLE_BY_ID = {};
  SAVINGS_VEHICLES.forEach(function (v) { VEHICLE_BY_ID[v.id] = v; });

  var TIER_LABELS = { cash: "Easy access cash", low: "Lower risk", growth: "Growth / market risk", other: "Other" };

  // UK ISA subscription limit and tax-year boundary (6 April). Both are
  // policy numbers that can change in a Budget — they live here as named
  // constants so updating them is a one-line change.
  var ISA_ANNUAL_ALLOWANCE = 20000;
  var TAX_YEAR_START_MONTH = 3; // April, 0-indexed
  var TAX_YEAR_START_DAY = 6;

  function vehicleFor(id) { return VEHICLE_BY_ID[id] || VEHICLE_BY_ID.other; }

  // "Paid using" is a free-text field backed by a datalist (see
  // #payment-method-options in index.html), not a locked set of DB rows —
  // this list just needs to match what's in that datalist.
  var PAYMENT_METHODS = ["PCC", "RCC", "sal acc", "wife sal acc", "cur acc"];

  // "PCC" (Premium credit card) and "RCC" (Regular credit card) are the two
  // "paid using" values that actually mean a credit card was used, rather
  // than money leaving a bank account straight away — everything else in
  // PAYMENT_METHODS is a cash-equivalent account. This maps those two
  // shorthands to the matching row in credit_cards (matched by id first,
  // falling back to the label so a renamed/re-seeded card still resolves)
  // without needing a schema change to store the link explicitly.
  var CARD_ALIASES = { PCC: { id: "premium", label: /premium/i }, RCC: { id: "regular", label: /regular/i } };

  function cardForPaymentMethod(pm) {
    var alias = CARD_ALIASES[pm];
    if (!alias) return null;
    var byId = state.creditCards.filter(function (c) { return c.id === alias.id; })[0];
    if (byId) return byId;
    return state.creditCards.filter(function (c) { return alias.label.test(c.label); })[0] || null;
  }

  function isCardTransaction(t) { return !!cardForPaymentMethod(t.paymentMethod); }

  function isSavingsTx(t) { return t.categoryId === SAVINGS_CAT; }

  // Everything that answers "what did I spend?" — the breakdown, the patterns,
  // the insights, the cut analysis — has to run through this. Savings sitting
  // in the same transactions table would otherwise show up as the third
  // biggest "expense" of the month.
  function spendingTxs(txs) { return txs.filter(function (t) { return !isSavingsTx(t); }); }

  var editingIncome = false;
  var editingCalendar = false;
  var editingRecurring = false;
  var currentUserId = null;
  var authMode = "signin";
  var patternsWindow = "6"; // "3" | "6" | "12" | "all"

  var state = {
    currency: "GBP",
    income: null,
    incomeSources: [],
    creditCards: [],
    transactions: [],
    plannedExpenses: [],
    cardBalances: [],
    recurringExpenses: [],
    savingsContributions: [],
    savingsGoals: []
  };
  var viewMonth = null;
  var customRange = null; // {start, end} both "YYYY-MM-DD", inclusive; null = pay-cycle mode via viewMonth
  var LEDGER_COLLAPSE_LIMIT = 3;
  var ledgerExpanded = false;
  var plannedExpanded = false;
  var recurringListExpanded = false;
  var breakdownExpanded = false;
  var patternsExpanded = false;
  var currentView = "home"; // "home" | "savings"
  var showingGoalForm = false;
  var goalSliderTouched = false; // true once the user has dragged the slider by hand this time round
  var savingsFilters = { year: "all", month: "all", vehicle: "all", goal: "all" };

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

  // A card transaction is committed spend the moment it's logged (it belongs
  // in "spent this period" like anything else), but the cash for it doesn't
  // leave the bank until the statement it lands on gets paid — so it must
  // never also be subtracted from "leftover" in the period it was bought.
  // The cash-out figure for a period is: everything paid by non-card methods
  // in that period, plus whichever card statements have their *due date*
  // (not their purchase date, not their statement date) inside that period.
  // Every card pound is counted in exactly one due-date period, no matter
  // which period it was actually spent in — that's what stops the double
  // count and also makes purchases made just after a statement closes show
  // up (correctly) a full cycle later than ones made just before it closes.
  function cardDuesInRange(startStr, endExclusiveStr) {
    return state.cardBalances
      .filter(function (b) { return b.dueDate >= startStr && b.dueDate < endExclusiveStr; })
      .reduce(function (s, b) { return s + b.amount; }, 0);
  }

  // Money deliberately put aside is still money that has left the account, so
  // it comes off "left over" exactly like spending does — but it isn't
  // spending, and lumping the two together would make a good month (a big
  // transfer into an ISA) look identical to a bad one (a big shopping spree).
  // So it's tracked as its own figure. A savings transfer is always treated as
  // cash leaving now, never as card credit, because that's what it is: you
  // can't move money into a savings pot on a credit card.
  function cycleFinancials(txs, startStr, endExclusiveStr) {
    var cashSpent = 0;
    var putAside = 0;
    txs.forEach(function (t) {
      if (isSavingsTx(t)) { putAside += t.amount; return; }
      if (!isCardTransaction(t)) cashSpent += t.amount;
    });
    var cardDues = cardDuesInRange(startStr, endExclusiveStr);
    var leftover = state.income == null ? null : state.income - cashSpent - putAside - cardDues;
    return { cashSpent: cashSpent, putAside: putAside, cardDues: cardDues, leftover: leftover };
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

  // Recurring transactions are never backfilled earlier than this date, no
  // matter how old a rule's own start month is — keeps auto-generation from
  // resurrecting history from before this feature's rollout.
  var RECURRING_BACKFILL_FLOOR = new Date(2026, 7, 15); // 15 Aug 2026
  var RECURRING_BACKFILL_FLOOR_MONTH = "2026-08";

  // Generates any due-but-not-yet-logged recurring transactions — walking
  // forward one pay-cycle month at a time, from RECURRING_BACKFILL_FLOOR (or
  // the rule's own startMonth if later) up through the current month — so a
  // rule that was missed for several months in a row gets every missed
  // occurrence logged, not just the most recent one. Returns the array of
  // newly created ones (already pushed into state.transactions) so the
  // caller can batch-insert them into Supabase.
  function generateRecurringTransactions() {
    var now = new Date();
    var today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var currentMk = todayStr().slice(0, 7);
    var created = [];

    state.recurringExpenses.forEach(function (rule) {
      if (!rule.active) return;
      var mk = (rule.startMonth && rule.startMonth > RECURRING_BACKFILL_FLOOR_MONTH) ? rule.startMonth : RECURRING_BACKFILL_FLOOR_MONTH;

      while (mk <= currentMk) {
        var already = state.transactions.some(function (t) { return t.recurringId === rule.id && t.recurringOccurrence === mk; });
        if (already) { mk = shiftMonth(mk, 1); continue; }

        var occDate = recurringOccurrenceDate(rule, mk);
        if (occDate > today0) break; // this and every later occurrence hasn't happened yet
        if (occDate < RECURRING_BACKFILL_FLOOR) { mk = shiftMonth(mk, 1); continue; }

        var amount = rule.amount;
        if (rule.installment) {
          var remaining = installmentRemaining(rule);
          if (remaining <= 0) break; // fully paid off — stop generating
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

        mk = shiftMonth(mk, 1);
      }
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
    var currentTxs = spendingTxs(txSince(windowStart));
    var groups = groupTxByCategory(currentTxs);

    var priorRange = patternsPriorWindowRange(sel);
    var priorCounts = {};
    if (priorRange) {
      var priorTxs = spendingTxs(txInRange(priorRange.start, priorRange.end));
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

  function leftoverSub(income, saved, cardDues, putAside) {
    if (income == null) return "add income to see this";
    var base = saved >= 0 ? "under budget" : "over budget";
    var extras = [];
    if (cardDues > 0) extras.push("includes " + fmtMoney(cardDues) + " due on cards");
    if (putAside > 0) extras.push("after " + fmtMoney(putAside) + " put aside");
    return extras.length ? base + " · " + extras.join(" · ") : base;
  }

  function renderStats() {
    var el = document.getElementById("stats");
    var txs = currentTxs();
    var range = activeRangeStr();
    var spendTxs = spendingTxs(txs);
    var spent = spendTxs.reduce(function (s, t) { return s + t.amount; }, 0);
    var income = state.income;
    var fin = cycleFinancials(txs, range.start, range.end);
    var saved = fin.leftover;
    // Savings rate is what you deliberately moved into savings, not what
    // happened to be left at the end — those are very different achievements,
    // and only the first is something you chose.
    var rate = income != null && income > 0 ? (fin.putAside / income) * 100 : null;

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
    var rateClass = rate == null ? "" : rate > 0 ? "positive" : "";
    var putAsideCount = txs.length - spendTxs.length;

    el.innerHTML =
      '<div class="stat-tile editable" id="income-tile">' + incomeTileInner + "</div>" +
      '<div class="stat-tile">' +
      '<div class="stat-label">Spent this period</div>' +
      '<div class="stat-value">' + fmtMoney(spent) + "</div>" +
      '<div class="stat-sub">' + spendTxs.length + (spendTxs.length === 1 ? " expense" : " expenses") + "</div>" +
      "</div>" +
      '<div class="stat-tile">' +
      '<div class="stat-label">Put aside</div>' +
      '<div class="stat-value ' + (fin.putAside > 0 ? "positive" : "") + '">' + fmtMoney(fin.putAside) + "</div>" +
      '<div class="stat-sub">' + (putAsideCount ? putAsideCount + (putAsideCount === 1 ? " transfer" : " transfers") : "nothing saved yet") + "</div>" +
      "</div>" +
      '<div class="stat-tile">' +
      '<div class="stat-label">Left over</div>' +
      '<div class="stat-value ' + savedClass + '">' + (saved == null ? "—" : fmtMoney(saved)) + "</div>" +
      '<div class="stat-sub">' + leftoverSub(income, saved, fin.cardDues, fin.putAside) + "</div>" +
      "</div>" +
      '<div class="stat-tile">' +
      '<div class="stat-label">Savings rate</div>' +
      '<div class="stat-value ' + rateClass + '">' + rateText + "</div>" +
      '<div class="stat-sub">of income put aside</div>' +
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

    var rowsHtml = txs.map(function (t) {
      var cat = CATEGORIES[CAT_INDEX[t.categoryId]] || CATEGORIES[CATEGORIES.length - 1];
      var d = new Date(t.date + "T00:00:00");
      var dateShort = d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
      var pmBadge = "";
      if (t.paymentMethod) {
        var card = cardForPaymentMethod(t.paymentMethod);
        var titleAttr = "";
        if (card) {
          var settle = cardSettlement(card, t.date);
          titleAttr = ' title="Bills on the ' + esc(fmtShortDate(settle.closeDateStr)) +
            " statement · due " + esc(fmtShortDate(settle.dueDateStr)) + '"';
        }
        pmBadge = ' <span class="pm-badge"' + titleAttr + '>' + esc(t.paymentMethod) + "</span>";
      }
      return (
        '<div class="ledger-row" data-id="' + esc(t.id) + '">' +
        '<div class="ledger-date">' + esc(dateShort) + "</div>" +
        '<div class="ledger-main">' +
        '<div class="ledger-cat"><span class="cat-dot" style="background:var(--cat-' + (CAT_INDEX[t.categoryId] + 1) + ')"></span>' + esc(cat.label) +
        pmBadge + "</div>" +
        (t.note ? '<div class="ledger-note">' + esc(t.note) + "</div>" : "") +
        "</div>" +
        '<div class="ledger-amount">' + fmtMoney(t.amount) + "</div>" +
        '<button type="button" class="ledger-del" data-id="' + esc(t.id) + '">Delete</button>' +
        "</div>"
      );
    });

    var visibleHtml = rowsHtml.slice(0, LEDGER_COLLAPSE_LIMIT).join("");
    var restCount = rowsHtml.length - LEDGER_COLLAPSE_LIMIT;
    var restHtml = "";
    if (restCount > 0) {
      restHtml = '<div class="ledger-rest"' + (ledgerExpanded ? "" : " hidden") + ">" +
        rowsHtml.slice(LEDGER_COLLAPSE_LIMIT).join("") + "</div>" +
        '<button type="button" class="list-toggle-btn" id="ledger-toggle">' +
        (ledgerExpanded ? "Show less" : "Show " + restCount + " more " + (restCount === 1 ? "entry" : "entries")) +
        "</button>";
    }
    listEl.innerHTML = visibleHtml + restHtml;

    var ledgerToggle = document.getElementById("ledger-toggle");
    if (ledgerToggle) {
      ledgerToggle.addEventListener("click", function () {
        ledgerExpanded = !ledgerExpanded;
        renderLedger();
      });
    }

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
    var sums = sumBy(spendingTxs(currentTxs()));
    var prevSums = customRange ? {} : sumBy(spendingTxs(txForPeriod(shiftMonth(viewMonth, -1))));
    var rows = Object.keys(sums).map(function (catId) {
      return { catId: catId, amount: sums[catId] };
    }).sort(function (a, b) { return b.amount - a.amount; });

    if (!rows.length) {
      el.innerHTML = '<p class="empty-state">Nothing to break down yet.</p>';
      return;
    }

    var max = rows[0].amount;
    var rowsHtml = rows.map(function (r) {
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

    el.innerHTML =
      '<button type="button" class="list-toggle-btn list-toggle-btn-top" id="breakdown-toggle">' +
      (breakdownExpanded ? "Hide" : "Show") + " " + rows.length + (rows.length === 1 ? " category" : " categories") +
      "</button>" +
      '<div class="breakdown-rows"' + (breakdownExpanded ? "" : " hidden") + ">" + rowsHtml + "</div>";

    document.getElementById("breakdown-toggle").addEventListener("click", function () {
      breakdownExpanded = !breakdownExpanded;
      renderBreakdown();
    });
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
    var rowsHtml = rows.map(function (r) {
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

    el.innerHTML =
      '<button type="button" class="list-toggle-btn list-toggle-btn-top" id="patterns-toggle">' +
      (patternsExpanded ? "Hide" : "Show") + " " + rows.length + (rows.length === 1 ? " category" : " categories") +
      "</button>" +
      '<div class="patterns-rows"' + (patternsExpanded ? "" : " hidden") + ">" + rowsHtml + "</div>";

    document.getElementById("patterns-toggle").addEventListener("click", function () {
      patternsExpanded = !patternsExpanded;
      renderPatterns();
    });
  }

  function renderInsights() {
    var el = document.getElementById("insights");
    var allTxs = currentTxs();
    var txs = spendingTxs(allTxs);
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

      var prevSums = customRange ? {} : sumBy(spendingTxs(txForPeriod(shiftMonth(viewMonth, -1))));
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
        var range = activeRangeStr();
        var fin = cycleFinancials(allTxs, range.start, range.end);
        var rate = (fin.putAside / state.income) * 100;
        if (fin.leftover < 0) {
          cards.push("Spending has outpaced income this period by " + fmtMoney(Math.abs(fin.leftover)) + ".");
        } else if (rate >= 20) {
          cards.push("You've put aside " + Math.round(rate) + "% of income this period — ahead of the common 20% guideline.");
        } else if (rate >= 10) {
          cards.push("You've put aside " + Math.round(rate) + "% of income so far this period, getting closer to the 20% guideline some planners suggest.");
        } else if (fin.putAside > 0) {
          cards.push("Only " + Math.round(rate) + "% of income put aside this period, with " + fmtMoney(fin.leftover) + " still unspent — the Savings tab can log a transfer.");
        } else {
          cards.push(fmtMoney(fin.leftover) + " is unspent this period but none of it has been put aside yet — the Savings tab can log a transfer.");
        }
      } else {
        cards.push("Add your monthly income above to see a savings rate here.");
      }
    }

    el.innerHTML = cards.slice(0, 4).map(function (c) { return '<div class="insight-card">' + c + "</div>"; }).join("");
  }

  // Builds the date for "day" in month m of year y, clamped to that month's
  // actual last day — so a card/rule with day 31 lands on 28/29 Feb instead
  // of silently overflowing into March (new Date(y, 1, 31) rolls forward).
  function dateInMonth(y, m, day) {
    var lastDay = new Date(y, m + 1, 0).getDate();
    return new Date(y, m, Math.min(day, lastDay));
  }

  function nextOccurrence(day, from) {
    from = from || new Date();
    var today0 = new Date(from.getFullYear(), from.getMonth(), from.getDate());
    var candidate = dateInMonth(today0.getFullYear(), today0.getMonth(), day);
    if (candidate < today0) candidate = dateInMonth(today0.getFullYear(), today0.getMonth() + 1, day);
    return candidate;
  }

  function lastOccurrence(day, from) {
    from = from || new Date();
    var today0 = new Date(from.getFullYear(), from.getMonth(), from.getDate());
    var candidate = dateInMonth(today0.getFullYear(), today0.getMonth(), day);
    if (candidate > today0) candidate = dateInMonth(today0.getFullYear(), today0.getMonth() - 1, day);
    return candidate;
  }

  // Which statement a card purchase made on `dateStr` will be billed on, and
  // when that statement is due. A purchase ON the statement's closing day
  // itself is included in that day's statement (matches the app's existing
  // convention of treating the statement day as "closed" that day — see
  // pendingCardReminders' use of lastOccurrence below); anything after rolls
  // to the following month's statement. This is what makes a purchase made
  // right after a statement closes correctly show up a full cycle later than
  // one made just before it, instead of both looking the same.
  function cardSettlement(card, dateStr) {
    var purchase = new Date(dateStr + "T00:00:00");
    var closeDate = nextOccurrence(card.statementDay, purchase);
    var dueDate = nextOccurrence(card.paymentDay, closeDate);
    return { closeDateStr: todayStr(closeDate), dueDateStr: todayStr(dueDate) };
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

  function fmtShortDate(dateStr) {
    return new Date(dateStr + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
  }

  // credit card statement/payment reminders

  // Every statement day for a card that has already closed and has no
  // recorded balance yet — not just the most recent one. Walking forward
  // from the statement right after the last one recorded (or, for a card
  // with no history at all, from just its latest closed statement, so a
  // freshly-added card doesn't get flooded with reminders for months before
  // anyone was tracking it) means a month you forgot to enter still shows up
  // instead of being silently replaced by the newer one.
  function pendingCardReminders() {
    var now = new Date();
    var out = [];
    state.creditCards.forEach(function (c) {
      var latestCloseForCard = lastOccurrence(c.statementDay, now);
      var recorded = state.cardBalances.filter(function (b) { return b.cardId === c.id; });
      var cursor;
      if (recorded.length) {
        var mostRecentStr = recorded.map(function (b) { return b.statementDate; }).sort().slice(-1)[0];
        cursor = nextOccurrence(c.statementDay, new Date(mostRecentStr + "T00:00:00"));
      } else {
        cursor = latestCloseForCard;
      }
      var guard = 0;
      while (cursor <= latestCloseForCard && guard < 24) {
        var stmtDateStr = todayStr(cursor);
        var exists = recorded.some(function (b) { return b.statementDate === stmtDateStr; });
        if (!exists) out.push({ card: c, statementDate: stmtDateStr });
        cursor = nextOccurrence(c.statementDay, new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1));
        guard++;
      }
    });
    return out;
  }

  // Sum of this card's transactions since the previous statement closed, up
  // to and including this one — the amount the real statement *should* show
  // if every purchase on the card was logged in the ledger. Shown as a
  // starting point when confirming a statement so entering it becomes
  // "confirm or adjust" instead of retyping a total by hand; any gap against
  // the real statement is interest, fees, or something not yet logged.
  function derivedStatementAmount(card, closeDateStr) {
    var dayBefore = new Date(new Date(closeDateStr + "T00:00:00").getTime() - 86400000);
    var prevCloseStr = todayStr(lastOccurrence(card.statementDay, dayBefore));
    return state.transactions
      .filter(function (t) {
        if (t.date <= prevCloseStr || t.date > closeDateStr) return false;
        var tc = cardForPaymentMethod(t.paymentMethod);
        return !!tc && tc.id === card.id;
      })
      .reduce(function (s, t) { return s + t.amount; }, 0);
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
      var suggested = Math.round(derivedStatementAmount(p.card, p.statementDate) * 100) / 100;
      var suggestedAttr = suggested > 0 ? ' value="' + suggested.toFixed(2) + '"' : "";
      var hint = suggested > 0
        ? '<div class="card-reminder-hint">Logged on this card since the last statement: ' + fmtMoney(suggested) +
          " — adjust if the real statement differs (interest, fees, anything not logged)</div>"
        : "";
      return (
        '<div class="card-reminder-row" data-card-id="' + esc(p.card.id) + '" data-stmt-date="' + esc(p.statementDate) + '">' +
        '<div class="card-reminder-text">💳 <strong>' + esc(p.card.label) + "</strong> statement generated " + esc(dateLabel) + " — confirm the balance to pay</div>" +
        hint +
        '<div class="amount-input"><span class="currency-prefix">£</span><input type="number" inputmode="decimal" step="0.01" min="0.01" class="card-reminder-input" placeholder="0.00"' + suggestedAttr + ' /></div>' +
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
      var range = activeRangeStr();
      var leftover = cycleFinancials(txs, range.start, range.end).leftover;
      if (total <= leftover) {
        summary += " · fits within this period's " + fmtMoney(leftover) + " leftover";
      } else {
        summary += " · " + fmtMoney(total - leftover) + " more than this period's leftover";
      }
    }
    summaryEl.textContent = summary;

    var rowsHtml = items.map(function (p) {
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

    listEl.innerHTML =
      '<button type="button" class="list-toggle-btn list-toggle-btn-top" id="planned-toggle">' +
      (plannedExpanded ? "Hide" : "Show") + " " + items.length + (items.length === 1 ? " item" : " items") +
      "</button>" +
      '<div class="planned-rows"' + (plannedExpanded ? "" : " hidden") + ">" + rowsHtml + "</div>";

    document.getElementById("planned-toggle").addEventListener("click", function () {
      plannedExpanded = !plannedExpanded;
      renderPlanned();
    });

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

    var rowsHtml = rules.map(function (r) {
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

    listEl.innerHTML =
      '<button type="button" class="list-toggle-btn list-toggle-btn-top" id="recurring-list-toggle">' +
      (recurringListExpanded ? "Hide" : "Show") + " " + rules.length + (rules.length === 1 ? " payment" : " payments") +
      "</button>" +
      '<div class="recurring-rows"' + (recurringListExpanded ? "" : " hidden") + ">" + rowsHtml + "</div>";

    document.getElementById("recurring-list-toggle").addEventListener("click", function () {
      recurringListExpanded = !recurringListExpanded;
      renderRecurring();
    });
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

  // ---------- savings: shared calculations ----------

  function median(nums) {
    if (!nums.length) return 0;
    var s = nums.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  // The UK tax year runs 6 April to 5 April, and the ISA allowance resets with
  // it — an unused allowance doesn't roll over, which is the whole reason this
  // is worth showing.
  function taxYearRange(d) {
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

  function contributionsInRange(startStr, endExclusiveStr) {
    return state.savingsContributions.filter(function (c) {
      return c.date >= startStr && c.date < endExclusiveStr;
    });
  }

  function sumAmounts(rows) { return rows.reduce(function (s, r) { return s + r.amount; }, 0); }

  function savedTowards(goalId) {
    return sumAmounts(state.savingsContributions.filter(function (c) { return c.goalId === goalId; }));
  }

  // Totals for the last `months` *complete* calendar months, oldest first. The
  // current month is deliberately left out — it's only part-way through, and
  // including it would drag every average down and make spending look like
  // it's falling every time you check early in the month.
  function monthlyTotals(months, predicate) {
    var now = new Date();
    var out = [];
    for (var i = months; i >= 1; i--) {
      var from = new Date(now.getFullYear(), now.getMonth() - i, 1);
      var to = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      var startStr = todayStr(from), endStr = todayStr(to);
      var total = 0;
      state.transactions.forEach(function (t) {
        if (t.date >= startStr && t.date < endStr && predicate(t)) total += t.amount;
      });
      out.push(total);
    }
    return out;
  }

  function categoryMonthlyTotals(catId, months) {
    return monthlyTotals(months, function (t) { return t.categoryId === catId; });
  }

  // What it costs to simply keep going: everything that isn't discretionary
  // and isn't a savings transfer. This is what an emergency fund is sized
  // against — three to six months of *this*, not of total outgoings.
  function medianEssentialMonthly() {
    return median(monthlyTotals(6, function (t) {
      var cat = CATEGORIES[CAT_INDEX[t.categoryId]];
      return cat && !cat.discretionary && !isSavingsTx(t);
    }));
  }

  function medianMonthlySavings() {
    return median(monthlyTotals(6, isSavingsTx));
  }

  // Leftover for each of the last `n` complete pay cycles, so goal pacing can
  // be checked against what actually tends to be spare rather than against
  // income on paper.
  function medianMonthlyLeftover(n) {
    if (state.income == null) return null;
    var vals = [];
    var mk = currentPeriodKey();
    for (var i = 1; i <= n; i++) {
      var m = shiftMonth(mk, -i);
      var start = periodStartStr(m), end = periodEndStr(m);
      var txs = state.transactions.filter(function (t) { return t.date >= start && t.date < end; });
      var fin = cycleFinancials(txs, start, end);
      if (fin.leftover != null) vals.push(fin.leftover);
    }
    return vals.length ? median(vals) : null;
  }

  function monthsBetween(fromStr, toStr) {
    var a = new Date(fromStr + "T00:00:00"), b = new Date(toStr + "T00:00:00");
    return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()) + (b.getDate() - a.getDate()) / 30.4;
  }

  function goalProgress(g) {
    var saved = savedTowards(g.id);
    var remaining = Math.max(0, g.targetAmount - saved);
    var monthsLeft = monthsBetween(todayStr(), g.targetDate);
    var requiredMonthly = remaining <= 0 ? 0 : monthsLeft <= 0 ? remaining : remaining / monthsLeft;
    var contribs = state.savingsContributions.filter(function (c) { return c.goalId === g.id; });
    var actualMonthly = median(monthlyTotals(6, function (t) {
      return contribs.some(function (c) { return c.transactionId === t.id; });
    }));
    // A goal set last week has no pace yet — judging it against a six-month
    // median would call every new goal "behind" on the day it's created, which
    // is noise rather than information.
    var monthsElapsed = monthsBetween(g.startDate, todayStr());
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

  // ---------- savings: rendering ----------

  function renderSavingsStats() {
    var el = document.getElementById("savings-stats");
    var all = sumAmounts(state.savingsContributions);
    var ty = taxYearRange();
    var thisTaxYear = sumAmounts(contributionsInRange(ty.start, ty.end));
    var now = new Date();
    var monthStart = todayStr(new Date(now.getFullYear(), now.getMonth(), 1));
    var monthEnd = todayStr(new Date(now.getFullYear(), now.getMonth() + 1, 1));
    var thisMonth = sumAmounts(contributionsInRange(monthStart, monthEnd));
    var typical = medianMonthlySavings();

    var goals = state.savingsGoals.filter(function (g) { return !g.archived; });
    var onTrack = goals.filter(function (g) {
      var p = goalProgress(g);
      return p.complete || (!p.overdue && (p.tooNew || p.actualMonthly >= p.requiredMonthly));
    }).length;

    el.innerHTML =
      '<div class="stat-tile">' +
      '<div class="stat-label">Put aside all time</div>' +
      '<div class="stat-value">' + fmtMoney(all) + "</div>" +
      '<div class="stat-sub">' + state.savingsContributions.length +
      (state.savingsContributions.length === 1 ? " contribution" : " contributions") + "</div>" +
      "</div>" +
      '<div class="stat-tile">' +
      '<div class="stat-label">This tax year</div>' +
      '<div class="stat-value">' + fmtMoney(thisTaxYear) + "</div>" +
      '<div class="stat-sub">' + esc(ty.label) + " · since 6 Apr</div>" +
      "</div>" +
      '<div class="stat-tile">' +
      '<div class="stat-label">This month</div>' +
      '<div class="stat-value ' + (thisMonth > 0 ? "positive" : "") + '">' + fmtMoney(thisMonth) + "</div>" +
      '<div class="stat-sub">' + now.toLocaleDateString("en-GB", { month: "long" }) + "</div>" +
      "</div>" +
      '<div class="stat-tile">' +
      '<div class="stat-label">Typical month</div>' +
      '<div class="stat-value">' + fmtMoney(typical) + "</div>" +
      '<div class="stat-sub">median of last 6 months</div>' +
      "</div>" +
      '<div class="stat-tile">' +
      '<div class="stat-label">Goals on track</div>' +
      '<div class="stat-value ' + (goals.length && onTrack === goals.length ? "positive" : "") + '">' +
      (goals.length ? onTrack + " / " + goals.length : "—") + "</div>" +
      '<div class="stat-sub">' + (goals.length ? "at your recent pace" : "no goals set yet") + "</div>" +
      "</div>";
  }

  function filteredContributions() {
    return state.savingsContributions.filter(function (c) {
      if (savingsFilters.year !== "all" && c.date.slice(0, 4) !== savingsFilters.year) return false;
      if (savingsFilters.month !== "all" && c.date.slice(5, 7) !== savingsFilters.month) return false;
      if (savingsFilters.vehicle !== "all" && c.vehicle !== savingsFilters.vehicle) return false;
      if (savingsFilters.goal === "none" && c.goalId) return false;
      if (savingsFilters.goal !== "all" && savingsFilters.goal !== "none" && c.goalId !== savingsFilters.goal) return false;
      return true;
    });
  }

  function renderSavingsFilters() {
    var years = {};
    state.savingsContributions.forEach(function (c) { years[c.date.slice(0, 4)] = true; });
    var yearOpts = ['<option value="all">All years</option>'].concat(
      Object.keys(years).sort().reverse().map(function (y) {
        return '<option value="' + esc(y) + '"' + (savingsFilters.year === y ? " selected" : "") + ">" + esc(y) + "</option>";
      })
    );
    document.getElementById("savings-filter-year").innerHTML = yearOpts.join("");

    var monthOpts = ['<option value="all">All months</option>'];
    for (var m = 1; m <= 12; m++) {
      var mm = String(m).padStart(2, "0");
      var label = new Date(2000, m - 1, 1).toLocaleDateString("en-GB", { month: "long" });
      monthOpts.push('<option value="' + mm + '"' + (savingsFilters.month === mm ? " selected" : "") + ">" + esc(label) + "</option>");
    }
    document.getElementById("savings-filter-month").innerHTML = monthOpts.join("");

    var vehicleOpts = ['<option value="all">All destinations</option>'].concat(
      SAVINGS_VEHICLES.map(function (v) {
        return '<option value="' + esc(v.id) + '"' + (savingsFilters.vehicle === v.id ? " selected" : "") + ">" + esc(v.label) + "</option>";
      })
    );
    document.getElementById("savings-filter-vehicle").innerHTML = vehicleOpts.join("");

    var goalOpts = ['<option value="all">All goals</option>', '<option value="none"' + (savingsFilters.goal === "none" ? " selected" : "") + ">Not tied to a goal</option>"].concat(
      state.savingsGoals.map(function (g) {
        return '<option value="' + esc(g.id) + '"' + (savingsFilters.goal === g.id ? " selected" : "") + ">" + esc(g.name) + "</option>";
      })
    );
    document.getElementById("savings-filter-goal").innerHTML = goalOpts.join("");
  }

  function renderSavingsLog() {
    var el = document.getElementById("savings-log");
    var summaryEl = document.getElementById("savings-log-summary");
    var rows = filteredContributions().slice().sort(function (a, b) {
      return a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? 1 : -1;
    });

    summaryEl.textContent = rows.length
      ? rows.length + (rows.length === 1 ? " entry · " : " entries · ") + fmtMoney(sumAmounts(rows))
      : "";

    if (!rows.length) {
      el.innerHTML = state.savingsContributions.length
        ? '<p class="empty-state">Nothing matches those filters.</p>'
        : '<p class="empty-state">Nothing put aside yet — log your first transfer above and it will show up here and in the ledger.</p>';
      return;
    }

    // Grouped by month so "how much did I put away in March" is readable at a
    // glance rather than something you have to add up by eye.
    var html = "";
    var lastMonth = null;
    rows.forEach(function (c) {
      var mk = c.date.slice(0, 7);
      if (mk !== lastMonth) {
        lastMonth = mk;
        var monthTotal = sumAmounts(rows.filter(function (r) { return r.date.slice(0, 7) === mk; }));
        html += '<div class="savings-month-head"><span>' + esc(monthShortLabel(mk)) + "</span>" +
          '<span class="savings-month-total">' + fmtMoney(monthTotal) + "</span></div>";
      }
      var v = vehicleFor(c.vehicle);
      var d = new Date(c.date + "T00:00:00");
      var goal = state.savingsGoals.filter(function (g) { return g.id === c.goalId; })[0];
      var subParts = [];
      if (c.accountLabel) subParts.push(c.accountLabel);
      if (c.note) subParts.push(c.note);
      html +=
        '<div class="savings-row">' +
        '<div class="ledger-date">' + esc(d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" })) + "</div>" +
        '<div class="savings-main">' +
        '<div class="savings-dest"><span class="tier-dot tier-' + esc(v.tier) + '"></span>' + esc(v.label) +
        (goal ? ' <span class="goal-badge">' + esc(goal.name) + "</span>" : "") + "</div>" +
        (subParts.length ? '<div class="savings-sub">' + esc(subParts.join(" · ")) + "</div>" : "") +
        "</div>" +
        '<div class="ledger-amount">' + fmtMoney(c.amount) + "</div>" +
        '<button type="button" class="ledger-del savings-del" data-id="' + esc(c.id) + '">Delete</button>' +
        "</div>";
    });
    el.innerHTML = html;

    el.querySelectorAll(".savings-del").forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (btn.dataset.confirming === "1") {
          deleteSavingsContribution(btn.dataset.id);
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

  function renderHoldings() {
    var el = document.getElementById("savings-holdings");
    if (!state.savingsContributions.length) {
      el.innerHTML = '<p class="empty-state">Once you log a contribution, this shows how your savings are split.</p>';
      return;
    }

    var byVehicle = {};
    state.savingsContributions.forEach(function (c) {
      byVehicle[c.vehicle] = (byVehicle[c.vehicle] || 0) + c.amount;
    });
    var rows = Object.keys(byVehicle).map(function (id) {
      return { vehicle: vehicleFor(id), amount: byVehicle[id] };
    }).sort(function (a, b) { return b.amount - a.amount; });

    var total = sumAmounts(state.savingsContributions);
    var max = rows[0].amount;

    var byTier = {};
    rows.forEach(function (r) { byTier[r.vehicle.tier] = (byTier[r.vehicle.tier] || 0) + r.amount; });
    var tierSummary = ["cash", "low", "growth", "other"].filter(function (t) { return byTier[t]; }).map(function (t) {
      return TIER_LABELS[t] + " " + Math.round((byTier[t] / total) * 100) + "%";
    }).join(" · ");

    el.innerHTML = rows.map(function (r) {
      return (
        '<div class="holding-row">' +
        '<div class="holding-top">' +
        '<div class="holding-name"><span class="tier-dot tier-' + esc(r.vehicle.tier) + '"></span><span class="label">' + esc(r.vehicle.label) + "</span></div>" +
        '<span class="holding-amt">' + fmtMoney(r.amount) + "</span>" +
        "</div>" +
        '<div class="bar-track"><div class="bar-fill tier-' + esc(r.vehicle.tier) + '" style="width:' + Math.max(4, (r.amount / max) * 100) + '%"></div></div>' +
        "</div>"
      );
    }).join("") + '<p class="isa-note">' + esc(tierSummary) + "</p>";
  }

  function renderIsaAllowance() {
    var el = document.getElementById("isa-allowance");
    var ty = taxYearRange();
    document.getElementById("isa-year-label").textContent = ty.label;

    var used = sumAmounts(contributionsInRange(ty.start, ty.end).filter(function (c) {
      return vehicleFor(c.vehicle).isa;
    }));
    var remaining = Math.max(0, ISA_ANNUAL_ALLOWANCE - used);
    var pct = Math.min(100, (used / ISA_ANNUAL_ALLOWANCE) * 100);
    var daysLeft = Math.max(0, Math.ceil((ty.endDate - new Date()) / 86400000));

    var note = used === 0
      ? "Nothing sheltered in an ISA this tax year. The allowance doesn't carry over — whatever is unused on 5 April is gone."
      : remaining === 0
        ? "Allowance fully used for " + ty.label + "."
        : fmtMoney(remaining) + " of allowance left, " + daysLeft + (daysLeft === 1 ? " day" : " days") + " to use it. It doesn't carry over into next year.";

    el.innerHTML =
      '<div class="isa-figures"><span class="isa-used">' + fmtMoney(used) + "</span>" +
      '<span class="isa-of">of ' + fmtMoney(ISA_ANNUAL_ALLOWANCE) + "</span></div>" +
      '<div class="bar-track"><div class="bar-fill tier-low" style="width:' + Math.max(2, pct) + '%"></div></div>' +
      '<p class="isa-note">' + esc(note) + "</p>";
  }

  function renderGoals() {
    var el = document.getElementById("goals-list");
    var goals = state.savingsGoals.filter(function (g) { return !g.archived; }).sort(function (a, b) {
      return a.targetDate < b.targetDate ? -1 : a.targetDate > b.targetDate ? 1 : 0;
    });

    if (!goals.length) {
      el.innerHTML = '<p class="empty-state">No goals yet. Add one to see how much a month it needs, and whether your recent pace gets you there.</p>';
      return;
    }

    var totalRequired = 0;
    var html = goals.map(function (g) {
      var p = goalProgress(g);
      totalRequired += p.requiredMonthly;

      var verdict, verdictClass;
      if (p.complete) {
        verdict = "Funded";
        verdictClass = "on-track";
      } else if (p.overdue) {
        verdict = "Past its date, " + fmtMoney(p.remaining) + " short";
        verdictClass = "behind";
      } else if (p.tooNew) {
        verdict = "Too new to judge the pace";
        verdictClass = "";
      } else if (p.actualMonthly >= p.requiredMonthly) {
        verdict = "On track at your recent pace";
        verdictClass = "on-track";
      } else {
        verdict = "Behind by " + fmtMoney(p.requiredMonthly - p.actualMonthly) + "/mo";
        verdictClass = "behind";
      }

      var monthsLabel = p.overdue ? "overdue" : Math.max(0, Math.round(p.monthsLeft)) + " months left";
      var targetLabel = new Date(g.targetDate + "T00:00:00").toLocaleDateString("en-GB", { month: "short", year: "numeric" });

      return (
        '<div class="goal-row">' +
        '<div class="goal-top">' +
        '<div class="goal-name">' + esc(g.name) +
        '<span class="goal-horizon">' + (g.horizon === "short" ? "Short term" : "Long term") + "</span></div>" +
        '<div class="goal-amounts">' + fmtMoney(p.saved) + " / " + fmtMoney(g.targetAmount) + "</div>" +
        "</div>" +
        '<div class="bar-track goal-bar"><div class="bar-fill ' + (p.complete ? "tier-low" : "tier-growth") +
        '" style="width:' + Math.max(2, p.pct) + '%"></div></div>' +
        '<div class="goal-meta">' +
        "<span>" + esc(targetLabel) + " · " + esc(monthsLabel) +
        (p.complete ? "" : " · needs " + fmtMoney(p.requiredMonthly) + "/mo") + "</span>" +
        '<span class="goal-verdict ' + verdictClass + '">' + esc(verdict) + "</span>" +
        "</div>" +
        '<div class="goal-actions"><button type="button" class="ledger-del goal-del" data-id="' + esc(g.id) + '">Delete goal</button></div>' +
        "</div>"
      );
    }).join("");

    // Goals all draw on the same leftover, so the number that decides whether
    // the set is realistic is the combined monthly requirement — not any one
    // goal on its own.
    var spare = medianMonthlyLeftover(6);
    if (totalRequired > 0 && spare != null) {
      var fits = spare >= totalRequired;
      html += '<p class="isa-note">All goals together need <strong>' + fmtMoney(totalRequired) +
        "/mo</strong>. Your typical month leaves " + fmtMoney(spare) + " spare — " +
        (fits ? "that fits." : "about " + fmtMoney(totalRequired - spare) + " a month short, so something has to give: a longer deadline, a smaller target, or less spending.") +
        "</p>";
    }

    el.innerHTML = html;

    el.querySelectorAll(".goal-del").forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (btn.dataset.confirming === "1") {
          deleteSavingsGoal(btn.dataset.id);
        } else {
          btn.dataset.confirming = "1";
          btn.textContent = "Sure? Contributions are kept";
          btn.classList.add("confirming");
          setTimeout(function () {
            btn.dataset.confirming = "0";
            btn.textContent = "Delete goal";
            btn.classList.remove("confirming");
          }, 3200);
        }
      });
    });
  }

  // ---------- savings: where you could cut ----------

  // How much of a category a suggestion assumes you'd actually give up. A
  // quarter is deliberately modest — the point is a number you might really
  // hit, not the fantasy one you get by assuming eating out drops to zero.
  var TRIM_FRACTION = 0.25;
  var SUBSCRIPTION_REVIEW_MAX = 20;

  function cutCandidates() {
    var now = new Date();
    var freqFrom = todayStr(new Date(now.getFullYear(), now.getMonth() - 3, 1));
    var freqTo = todayStr(new Date(now.getFullYear(), now.getMonth(), 1));

    return CATEGORIES.filter(function (c) { return c.discretionary; }).map(function (cat) {
      var totals = categoryMonthlyTotals(cat.id, 6);
      // Median rather than mean: one Christmas or one holiday shouldn't become
      // the baseline you're told to cut from.
      var base = median(totals);
      var last = totals[totals.length - 1];
      var recent = state.transactions.filter(function (t) {
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

  function renderCutAnalysis() {
    var el = document.getElementById("savings-cuts");
    var headEl = document.getElementById("cut-headline");
    var rows = cutCandidates();

    if (!rows.length) {
      headEl.textContent = "";
      el.innerHTML = '<p class="empty-state">Once there are a few complete months of expenses logged, this works out where there is realistically room to trim.</p>';
      return;
    }

    var top = rows.slice(0, 3);
    var freed = top.reduce(function (s, r) { return s + r.trim; }, 0);
    headEl.textContent = "~" + fmtMoney(freed) + "/mo";

    var cards = top.map(function (r) {
      var bits = ["<strong>" + esc(r.cat.label) + "</strong> runs " + fmtMoney(r.base) + " in a typical month"];
      if (r.perMonth >= 1) {
        bits.push("about " + Math.round(r.perMonth) + " charges a month averaging " + fmtMoney(r.avgAmount));
      }
      var card = bits.join(", ") + ". Trimming a quarter frees <strong>" + fmtMoney(r.trim) +
        "/mo</strong> — " + fmtMoney(r.trim * 12) + " a year.";
      if (r.overshoot) card += " Last month ran " + fmtMoney(r.overshoot) + " above your usual.";
      return card;
    });

    var small = state.recurringExpenses.filter(function (rec) {
      return rec.active && !rec.installment && rec.amount <= SUBSCRIPTION_REVIEW_MAX;
    });
    if (small.length >= 2) {
      var smallTotal = small.reduce(function (s, r) { return s + r.amount; }, 0);
      cards.push("<strong>" + small.length + " standing payments</strong> of " + fmtMoney(SUBSCRIPTION_REVIEW_MAX) +
        " or less go out every month, " + fmtMoney(smallTotal) + "/mo between them (" + fmtMoney(smallTotal * 12) +
        " a year). Small enough not to notice, worth checking you still use them all.");
    }

    var plannedTotal = state.plannedExpenses.reduce(function (s, p) { return s + p.amount; }, 0);
    var spare = medianMonthlyLeftover(6);
    if (plannedTotal > 0 && spare != null && spare > 0 && plannedTotal > spare) {
      cards.push("Your planned purchases come to " + fmtMoney(plannedTotal) + " — about " +
        Math.ceil(plannedTotal / spare) + " months of everything you typically have spare. Worth deciding which of them actually happen before committing that money to savings.");
    }

    el.innerHTML = cards.map(function (c) { return '<div class="insight-card">' + c + "</div>"; }).join("");
  }

  // ---------- savings: where it could go ----------

  // Deliberately ordered as a set of gates, not a menu. Debt and a cash buffer
  // come before any allocation advice at all, because no plausible investment
  // return beats clearing expensive credit, and investing money you'll need at
  // short notice is how a market dip turns into a forced sale.
  function renderAllocationAdvice() {
    var el = document.getElementById("savings-allocation");
    var cards = [];
    var essential = medianEssentialMonthly();

    if (essential <= 0) {
      el.innerHTML = '<div class="insight-card">Log a couple of complete months of expenses and this will work out your emergency-fund target and where new savings could sensibly go.</div>';
      return;
    }

    var today = todayStr();
    var overdue = state.cardBalances.filter(function (b) { return !b.paid && b.dueDate < today; });
    if (overdue.length) {
      var overdueTotal = sumAmounts(overdue);
      cards.push("<strong>Clear the " + fmtMoney(overdueTotal) + " overdue on your cards first.</strong> " +
        "Card interest runs far above anything a savings account or a fund is likely to return, so paying it off is the highest guaranteed return available to you right now.");
    }

    var installs = state.recurringExpenses.filter(function (r) { return r.active && r.installment; });
    if (installs.length) {
      var owed = installs.reduce(function (s, r) { return s + (installmentRemaining(r) || 0); }, 0);
      if (owed > 0) {
        cards.push("You still owe <strong>" + fmtMoney(owed) + "</strong> across " + installs.length +
          (installs.length === 1 ? " finance agreement" : " finance agreements") +
          ". If any of it charges more than about 8&ndash;10% a year, overpaying it beats investing the same money.");
      }
    }

    // The buffer has to be money you can actually reach this week — cash and
    // capital-preservation holdings only. A stocks ISA is not an emergency fund.
    var buffer = sumAmounts(state.savingsContributions.filter(function (c) {
      var tier = vehicleFor(c.vehicle).tier;
      return tier === "cash" || tier === "low";
    }));
    var bufferMin = essential * 3;
    var bufferMax = essential * 6;
    var bufferReady = buffer >= bufferMin;

    if (!bufferReady) {
      var pace = medianMonthlySavings();
      var short = bufferMin - buffer;
      var paceLine = pace > 0
        ? " At your recent " + fmtMoney(pace) + "/mo that takes about " + Math.ceil(short / pace) + " months."
        : "";
      cards.push("<strong>Fill the buffer before investing anything.</strong> Your essentials run " +
        fmtMoney(essential) + "/mo, so three months is " + fmtMoney(bufferMin) + " and six is " + fmtMoney(bufferMax) +
        ". You have " + fmtMoney(buffer) + " reachable — " + fmtMoney(short) + " short of the three-month mark." + paceLine +
        " Keep this part in easy-access cash or a cash ISA, not in anything that can fall in value.");
    } else {
      cards.push("<strong>Your buffer is covered</strong> — " + fmtMoney(buffer) + " reachable against essentials of " +
        fmtMoney(essential) + "/mo (" + (buffer / essential).toFixed(1) + " months). " +
        (buffer > bufferMax
          ? "That is past the six-month mark, so roughly " + fmtMoney(buffer - bufferMax) + " of it is sitting in cash doing less than it could."
          : "New money beyond this can start taking some risk."));
    }

    var goals = state.savingsGoals.filter(function (g) { return !g.archived; }).map(function (g) {
      var p = goalProgress(g);
      return { goal: g, p: p };
    }).filter(function (x) { return !x.p.complete; });

    // Horizon buckets, decided by the deadline rather than the label alone —
    // a goal you called "long term" but dated 18 months out is short-term
    // money whatever it's named, and the market doesn't care what you called it.
    var nearTerm = goals.filter(function (x) { return x.p.monthsLeft <= 24 || x.goal.horizon === "short"; });
    var midTerm = goals.filter(function (x) {
      return x.goal.horizon !== "short" && x.p.monthsLeft > 24 && x.p.monthsLeft <= 60;
    });
    var longTerm = goals.filter(function (x) { return x.p.monthsLeft > 60 && x.goal.horizon === "long"; });

    function goalNames(list) { return list.map(function (x) { return x.goal.name; }).join(", "); }
    function needOf(list) { return list.reduce(function (s, x) { return s + x.p.requiredMonthly; }, 0); }

    if (nearTerm.length) {
      cards.push("<strong>Average return, low risk</strong> — for the " + fmtMoney(needOf(nearTerm)) + "/mo going towards " +
        esc(goalNames(nearTerm)) +
        ". Needed inside two years, so it can't afford to fall: a cash ISA, an easy-access or fixed-rate savings account, or premium bonds. Tax-free interest inside an ISA is the whole edge here.");
    }

    if (bufferReady && midTerm.length) {
      cards.push("<strong>A mix, for the awkward middle</strong> — the " + fmtMoney(needOf(midTerm)) + "/mo going towards " +
        esc(goalNames(midTerm)) +
        " is two to five years out. Too far for cash alone to be the obvious answer, too close to ride out a bad run in full. The usual shape is a split: the part you'd hate to lose in cash, the rest taking market risk.");
    }

    if (bufferReady && longTerm.length) {
      cards.push("<strong>High return, high risk</strong> — for the " + fmtMoney(needOf(longTerm)) + "/mo going towards " +
        esc(goalNames(longTerm)) +
        ". Five years or more away, which is long enough to sit through a fall: a stocks &amp; shares ISA holding broad, low-cost index funds is the usual shape. Expect it to drop sharply at some point — money you'd panic about doesn't belong here.");
    }

    if (!goals.length) {
      cards.push("<strong>No goals set yet.</strong> Add one with a target and a deadline and this will split your contributions by how far off the money is needed — which is the single thing that decides how much risk it can take.");
    }

    // Worth saying plainly rather than inventing a category to fill.
    cards.push("<strong>High return, low risk doesn't exist as an investment.</strong> " +
      "Anything paying well above cash is paying you for taking risk. The genuine exceptions are structural, not market-based: an employer pension match (an instant return on the matched part, before markets do anything), " +
      "the tax saved by using an ISA or pension wrapper at all, and clearing debt that charges more than a safe account pays.");

    var ty = taxYearRange();
    var isaUsed = sumAmounts(contributionsInRange(ty.start, ty.end).filter(function (c) { return vehicleFor(c.vehicle).isa; }));
    var outsideIsa = sumAmounts(contributionsInRange(ty.start, ty.end).filter(function (c) {
      var v = vehicleFor(c.vehicle);
      return !v.isa && (v.tier === "growth" || v.tier === "cash");
    }));
    if (outsideIsa > 0 && isaUsed < ISA_ANNUAL_ALLOWANCE) {
      cards.push("You've put " + fmtMoney(outsideIsa) + " outside an ISA this tax year with " +
        fmtMoney(ISA_ANNUAL_ALLOWANCE - isaUsed) + " of allowance still unused. Same money, same investments, less tax on the interest and gains — and the unused allowance disappears on 5 April.");
    }

    el.innerHTML = cards.map(function (c) { return '<div class="insight-card">' + c + "</div>"; }).join("");
  }

  // Rebuilt whenever goals change, so a newly added goal is immediately
  // selectable — the current selections are carried across so a re-render
  // triggered mid-entry doesn't quietly reset a half-filled form.
  function renderSavingsFormSelects() {
    var vehicleEl = document.getElementById("s-vehicle");
    var keptVehicle = vehicleEl.value;
    vehicleEl.innerHTML = SAVINGS_VEHICLES.map(function (v) {
      return '<option value="' + esc(v.id) + '">' + esc(v.label) + "</option>";
    }).join("");
    vehicleEl.value = keptVehicle || "savings_account";

    var goalEl = document.getElementById("s-goal");
    var keptGoal = goalEl.value;
    goalEl.innerHTML = '<option value="">No specific goal</option>' +
      state.savingsGoals.filter(function (g) { return !g.archived; }).map(function (g) {
        return '<option value="' + esc(g.id) + '">' + esc(g.name) + "</option>";
      }).join("");
    goalEl.value = keptGoal;
  }

  function renderSavingsView() {
    renderSavingsStats();
    renderSavingsFilters();
    renderSavingsLog();
    renderHoldings();
    renderIsaAllowance();
    renderSavingsFormSelects();
    renderGoals();
    renderCutAnalysis();
    renderAllocationAdvice();
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
    if (currentView === "savings") renderSavingsView();
  }

  // The app is a single page with one section visible at a time rather than a
  // router — same shape as the existing panel toggles, no URL handling needed.
  // The pay-period nav belongs to Home only; Savings has its own filters and a
  // period arrow there would just be confusing.
  function showView(name) {
    currentView = name;
    document.getElementById("view-home").hidden = name !== "home";
    document.getElementById("view-savings").hidden = name !== "savings";
    document.querySelector(".month-nav").hidden = name !== "home";
    document.getElementById("range-form").hidden = true;
    document.getElementById("nav-home").classList.toggle("active", name === "home");
    document.getElementById("nav-savings").classList.toggle("active", name === "savings");
    closeSideNav();
    renderAll();
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

  function rowToContribution(r) {
    return {
      id: r.id, transactionId: r.transaction_id || null, amount: Number(r.amount), date: r.date,
      vehicle: r.vehicle, accountLabel: r.account_label || "", goalId: r.goal_id || null, note: r.note || ""
    };
  }
  function contributionToRow(c) {
    return {
      id: c.id, user_id: currentUserId, transaction_id: c.transactionId || null, amount: c.amount, date: c.date,
      vehicle: c.vehicle, account_label: c.accountLabel || "", goal_id: c.goalId || null, note: c.note || ""
    };
  }

  function rowToGoal(r) {
    return {
      id: r.id, name: r.name, targetAmount: Number(r.target_amount), horizon: r.horizon,
      startDate: r.start_date, targetDate: r.target_date, archived: !!r.archived
    };
  }
  function goalToRow(g) {
    return {
      id: g.id, user_id: currentUserId, name: g.name, target_amount: g.targetAmount, horizon: g.horizon,
      start_date: g.startDate, target_date: g.targetDate, archived: g.archived
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
      sb.from("recurring_expenses").select("*"),
      sb.from("savings_contributions").select("*"),
      sb.from("savings_goals").select("*")
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
      recurringExpenses: (results[6].data || []).map(rowToRecurring),
      savingsContributions: (results[7].data || []).map(rowToContribution),
      savingsGoals: (results[8].data || []).map(rowToGoal)
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

  // Deleting the ledger row for a savings transfer removes the contribution
  // too — the database does it via `on delete cascade`, this keeps the local
  // copy in step so the savings totals don't stay wrong until the next reload.
  function deleteTransaction(id) {
    state.transactions = state.transactions.filter(function (t) { return t.id !== id; });
    state.savingsContributions = state.savingsContributions.filter(function (c) { return c.transactionId !== id; });
    renderAll();
    dbCall(sb.from("transactions").delete().eq("id", id));
  }

  // ---------- savings writes ----------

  // One user action, two rows: the ledger transaction that makes the money
  // leave "left over", and the contribution that records where it went. They
  // are inserted together and the transaction goes first, because the
  // contribution's transaction_id points at it.
  function addSavingsContribution(data) {
    var t = {
      id: genId(), amount: data.amount, date: data.date, categoryId: SAVINGS_CAT,
      note: data.note || vehicleFor(data.vehicle).label,
      recurringId: null, recurringOccurrence: null, paymentMethod: data.source || ""
    };
    var c = {
      id: genId(), transactionId: t.id, amount: data.amount, date: data.date, vehicle: data.vehicle,
      accountLabel: data.accountLabel || "", goalId: data.goalId || null, note: data.note || ""
    };
    state.transactions.push(t);
    state.savingsContributions.push(c);
    renderAll();
    dbCall(sb.from("transactions").insert(txToRow(t)).then(function (res) {
      if (res && res.error) return res;
      return sb.from("savings_contributions").insert(contributionToRow(c));
    }));
  }

  function deleteSavingsContribution(id) {
    var c = state.savingsContributions.filter(function (x) { return x.id === id; })[0];
    if (!c) return;
    state.savingsContributions = state.savingsContributions.filter(function (x) { return x.id !== id; });
    var ops = [sb.from("savings_contributions").delete().eq("id", id)];
    if (c.transactionId) {
      state.transactions = state.transactions.filter(function (t) { return t.id !== c.transactionId; });
      ops.push(sb.from("transactions").delete().eq("id", c.transactionId));
    }
    renderAll();
    dbCall(Promise.all(ops));
  }

  function addSavingsGoal(g) {
    state.savingsGoals.push(g);
    renderAll();
    dbCall(sb.from("savings_goals").insert(goalToRow(g)));
  }

  // Contributions already logged against a deleted goal keep their money in
  // the savings total — only the link goes (the FK is `on delete set null`),
  // so removing a goal never quietly loses a record of cash you actually moved.
  function deleteSavingsGoal(id) {
    state.savingsGoals = state.savingsGoals.filter(function (g) { return g.id !== id; });
    state.savingsContributions.forEach(function (c) { if (c.goalId === id) c.goalId = null; });
    renderAll();
    dbCall(sb.from("savings_goals").delete().eq("id", id));
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

  function wireSavingsForm() {
    document.getElementById("s-date").value = todayStr();
    document.getElementById("savings-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var amount = parseFloat(document.getElementById("s-amount").value);
      var vehicle = document.getElementById("s-vehicle").value;
      if (!isFinite(amount) || amount <= 0 || !vehicle) return;
      addSavingsContribution({
        amount: Math.round(amount * 100) / 100,
        date: document.getElementById("s-date").value || todayStr(),
        vehicle: vehicle,
        accountLabel: document.getElementById("s-account").value.trim().slice(0, 40),
        goalId: document.getElementById("s-goal").value || null,
        source: document.getElementById("s-source").value.trim().slice(0, 40),
        note: document.getElementById("s-note").value.trim().slice(0, 80)
      });
      document.getElementById("s-amount").value = "";
      document.getElementById("s-note").value = "";
      document.getElementById("s-date").value = todayStr();
      document.getElementById("s-amount").focus();
    });
  }

  var GOAL_SLIDER_STEP = 100;
  var GOAL_SLIDER_MAX = 1000;

  // A reality-check calculator that lives inside the add-goal form: for
  // whatever monthly amount the slider is at, shows the plain sum (no
  // interest, no compounding) it adds up to over the entered duration, next
  // to the target -- so it's obvious before saving whether a target and a
  // duration actually go together. It never changes what gets submitted;
  // the target amount and duration stay exactly what's typed into their own
  // fields regardless of where the slider sits.
  //
  // Until the user drags the slider by hand, it tracks target/months
  // automatically, snapped to the nearest £100 and clamped to the 0-1000
  // range -- "the amount that would be needed". Touching it once stops that
  // auto-tracking so exploring nearby amounts doesn't keep snapping back.
  function updateGoalSlider() {
    var slider = document.getElementById("g-monthly-slider");
    var target = parseFloat(document.getElementById("g-target").value);
    var months = parseInt(document.getElementById("g-months").value, 10);
    var hasTarget = isFinite(target) && target > 0;
    var hasMonths = isFinite(months) && months > 0;

    if (!goalSliderTouched) {
      var needed = hasTarget && hasMonths ? target / months : 0;
      var snapped = Math.round(needed / GOAL_SLIDER_STEP) * GOAL_SLIDER_STEP;
      slider.value = Math.max(0, Math.min(GOAL_SLIDER_MAX, snapped));
    }

    var el = document.getElementById("g-slider-readout");
    if (!hasTarget || !hasMonths) {
      el.textContent = "Fill in a target and a duration above, then drag the slider to see what different monthly amounts would add up to.";
      return;
    }

    var monthly = Number(slider.value);
    var total = monthly * months;
    var diff = Math.round((total - target) * 100) / 100;
    var base = "<strong>" + fmtMoney(monthly) + "/mo</strong> × " + months + (months === 1 ? " month" : " months") +
      " = <strong>" + fmtMoney(total) + "</strong> total, no interest — ";
    var compare;
    if (diff === 0) {
      compare = '<span class="goal-verdict on-track">exactly meets your ' + fmtMoney(target) + " target</span>";
    } else if (diff > 0) {
      compare = '<span class="goal-verdict on-track">' + fmtMoney(diff) + " over your " + fmtMoney(target) + " target</span>";
    } else {
      compare = '<span class="goal-verdict behind">' + fmtMoney(Math.abs(diff)) + " short of your " + fmtMoney(target) + " target</span>";
    }
    el.innerHTML = base + compare + ".";
  }

  function resetGoalSlider() {
    goalSliderTouched = false;
    document.getElementById("g-monthly-slider").value = 0;
    updateGoalSlider();
  }

  function wireGoalForm() {
    var form = document.getElementById("goal-form");
    document.getElementById("goal-form-toggle").addEventListener("click", function () {
      showingGoalForm = !showingGoalForm;
      form.hidden = !showingGoalForm;
      document.getElementById("goal-form-toggle").textContent = showingGoalForm ? "Cancel" : "+ Add a goal";
      if (showingGoalForm) {
        resetGoalSlider();
        document.getElementById("g-name").focus();
      }
    });

    document.getElementById("g-target").addEventListener("input", updateGoalSlider);
    document.getElementById("g-months").addEventListener("input", updateGoalSlider);
    document.getElementById("g-monthly-slider").addEventListener("input", function () {
      goalSliderTouched = true;
      updateGoalSlider();
    });

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var name = document.getElementById("g-name").value.trim().slice(0, 60);
      var target = parseFloat(document.getElementById("g-target").value);
      var months = parseInt(document.getElementById("g-months").value, 10);
      var horizon = document.getElementById("g-horizon").value;
      if (!name || !isFinite(target) || target <= 0 || !isFinite(months) || months <= 0) return;

      // The duration is what you enter; the deadline is what gets stored, so
      // "am I on pace" stays a plain date comparison later on.
      var start = new Date();
      var targetDate = new Date(start.getFullYear(), start.getMonth() + months, start.getDate());
      addSavingsGoal({
        id: genId(), name: name, targetAmount: Math.round(target * 100) / 100, horizon: horizon,
        startDate: todayStr(start), targetDate: todayStr(targetDate), archived: false
      });

      form.reset();
      form.hidden = true;
      showingGoalForm = false;
      document.getElementById("goal-form-toggle").textContent = "+ Add a goal";
      resetGoalSlider();
    });
  }

  function wireSavingsFilters() {
    [["savings-filter-year", "year"], ["savings-filter-month", "month"],
     ["savings-filter-vehicle", "vehicle"], ["savings-filter-goal", "goal"]].forEach(function (pair) {
      document.getElementById(pair[0]).addEventListener("change", function (e) {
        savingsFilters[pair[1]] = e.target.value;
        renderSavingsLog();
      });
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
      ledgerExpanded = false;
      renderAll();
    });
    document.getElementById("next-month").addEventListener("click", function () {
      viewMonth = shiftMonth(viewMonth, 1);
      ledgerExpanded = false;
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
      ledgerExpanded = false;
      form.hidden = true;
      renderAll();
    });

    clearBtn.addEventListener("click", function () {
      customRange = null;
      ledgerExpanded = false;
      form.hidden = true;
      renderAll();
    });
  }

  // ---------- auth ----------

  function setAuthMode(mode) {
    authMode = mode;
    document.getElementById("auth-error").hidden = true;
    document.getElementById("auth-notice").hidden = true;
    var tagline = document.getElementById("auth-tagline");
    var submitBtn = document.getElementById("auth-submit");
    var toggleBtn = document.getElementById("auth-toggle-mode");
    var forgotLink = document.getElementById("auth-forgot-link");
    var passwordField = document.getElementById("auth-password-field");
    var passwordInput = document.getElementById("auth-password");
    var hint = document.getElementById("auth-password-hint");
    submitBtn.disabled = false;
    if (mode === "register") {
      tagline.textContent = "Create your household ledger account";
      submitBtn.textContent = "Create account";
      toggleBtn.textContent = "Already have an account? Sign in";
      passwordField.hidden = false;
      passwordInput.required = true;
      passwordInput.autocomplete = "new-password";
      hint.hidden = false;
      forgotLink.hidden = true;
    } else if (mode === "forgot") {
      tagline.textContent = "Reset your password";
      submitBtn.textContent = "Send reset link";
      toggleBtn.textContent = "Back to sign in";
      passwordField.hidden = true;
      passwordInput.required = false;
      hint.hidden = true;
      forgotLink.hidden = true;
    } else {
      tagline.textContent = "Sign in to your household ledger";
      submitBtn.textContent = "Sign in";
      toggleBtn.textContent = "New here? Create an account";
      passwordField.hidden = false;
      passwordInput.required = true;
      passwordInput.autocomplete = "current-password";
      hint.hidden = true;
      forgotLink.hidden = false;
    }
  }

  function showAuthScreen() {
    document.getElementById("app").hidden = true;
    document.getElementById("auth-screen").hidden = false;
    setAuthMode("signin");
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
    showView("home");
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

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function wireAuthForm() {
    var form = document.getElementById("auth-form");
    var errEl = document.getElementById("auth-error");
    var noticeEl = document.getElementById("auth-notice");
    var submitBtn = document.getElementById("auth-submit");

    document.getElementById("auth-toggle-mode").addEventListener("click", function () {
      setAuthMode(authMode === "signin" ? "register" : "signin");
    });

    document.getElementById("auth-forgot-link").addEventListener("click", function () {
      setAuthMode("forgot");
    });

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      errEl.hidden = true;
      noticeEl.hidden = true;
      var email = document.getElementById("auth-email").value.trim();
      var password = document.getElementById("auth-password").value;

      if (!EMAIL_RE.test(email)) {
        errEl.textContent = "Enter a valid email address.";
        errEl.hidden = false;
        return;
      }

      if (authMode === "forgot") {
        submitBtn.disabled = true;
        submitBtn.textContent = "Sending…";
        sb.auth.resetPasswordForEmail(email, {
          redirectTo: window.location.origin + "/reset-password.html"
        }).then(function (res) {
          submitBtn.disabled = false;
          submitBtn.textContent = "Send reset link";
          if (res.error) {
            errEl.textContent = res.error.message || "Could not send reset link.";
            errEl.hidden = false;
            return;
          }
          setAuthMode("signin");
          noticeEl.textContent = "If an account exists for that email, we've sent a password reset link.";
          noticeEl.hidden = false;
        });
        return;
      }

      if (password.length < 6) {
        errEl.textContent = "Password must be at least 6 characters.";
        errEl.hidden = false;
        return;
      }

      var registering = authMode === "register";
      submitBtn.disabled = true;
      submitBtn.textContent = registering ? "Creating account…" : "Signing in…";

      var authCall = registering
        ? sb.auth.signUp({ email: email, password: password })
        : sb.auth.signInWithPassword({ email: email, password: password });

      authCall.then(function (res) {
        submitBtn.disabled = false;
        submitBtn.textContent = registering ? "Create account" : "Sign in";
        if (res.error) {
          errEl.textContent = res.error.message || (registering ? "Could not create account." : "Could not sign in.");
          errEl.hidden = false;
          return;
        }
        document.getElementById("auth-password").value = "";
        if (registering && !res.data.session) {
          setAuthMode("signin");
          noticeEl.textContent = "Account created. Check your email to confirm your address, then sign in.";
          noticeEl.hidden = false;
        }
      });
    });
  }

  // ---------- side nav / profile ----------

  function openSideNav() {
    document.getElementById("side-nav").classList.add("open");
    document.getElementById("nav-overlay").hidden = false;
  }

  function closeSideNav() {
    document.getElementById("side-nav").classList.remove("open");
    document.getElementById("nav-overlay").hidden = true;
  }

  function closeProfileModal() {
    document.getElementById("profile-modal").hidden = true;
    document.getElementById("profile-overlay").hidden = true;
  }

  async function openProfileModal() {
    closeSideNav();
    var res = await sb.auth.getUser();
    var user = res && res.data ? res.data.user : null;
    var email = (user && user.email) || "—";
    var name = (user && user.user_metadata && (user.user_metadata.full_name || user.user_metadata.name)) ||
      (user && user.email ? user.email.split("@")[0] : "—");
    var lastLogin = user && user.last_sign_in_at ? new Date(user.last_sign_in_at).toLocaleString() : "—";
    document.getElementById("profile-name").textContent = name;
    document.getElementById("profile-email").textContent = email;
    document.getElementById("profile-last-login").textContent = lastLogin;
    document.getElementById("profile-modal").hidden = false;
    document.getElementById("profile-overlay").hidden = false;
  }

  function wireSideNav() {
    document.getElementById("nav-toggle").addEventListener("click", openSideNav);
    document.getElementById("nav-close").addEventListener("click", closeSideNav);
    document.getElementById("nav-overlay").addEventListener("click", closeSideNav);
    document.getElementById("nav-home").addEventListener("click", function () { showView("home"); });
    document.getElementById("nav-savings").addEventListener("click", function () { showView("savings"); });
    document.getElementById("nav-profile").addEventListener("click", openProfileModal);
    document.getElementById("profile-close").addEventListener("click", closeProfileModal);
    document.getElementById("profile-overlay").addEventListener("click", closeProfileModal);
    document.getElementById("profile-signout-btn").addEventListener("click", function () {
      closeProfileModal();
      sb.auth.signOut();
    });
  }

  // ---------- boot ----------

  function wireStatic() {
    populateCategorySelect("f-category");
    populateCategorySelect("p-category");
    populateCategorySelect("rec-category");
    wireForm();
    wirePlannedForm();
    wireSavingsForm();
    wireGoalForm();
    wireSavingsFilters();
    wireCalendarEdit();
    wireRecurringEdit();
    wireRecurringAddForm();
    wireExportPanel();
    wirePatternsWindow();
    wireMonthNav();
    wireRangePicker();
    wireAuthForm();
    wireSideNav();
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
