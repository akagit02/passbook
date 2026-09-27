// Legacy monolithic app, wrapped as an ES module.
// Originally the app.js IIFE body, re-exported as boot(). Pure domain logic
// has been extracted into src/<domain>/index.js; the same-named functions
// left in here are thin wrappers that bind the module-level `state` to those
// pure functions, so the rendering/wiring code below didn't need to change.

import { todayStr, shiftMonth, esc, genId, nextOccurrence } from "./lib/index.js";
import { CATEGORIES, CAT_INDEX, SAVINGS_CAT, SAVINGS_VEHICLES, TIER_LABELS, ISA_ANNUAL_ALLOWANCE, vehicleFor, spendingTxs } from "./categories/index.js";
import * as periodsDomain from "./periods/index.js";
import * as cardsDomain from "./cards/index.js";
import * as cashflowDomain from "./cashflow/index.js";
import * as recurringDomain from "./recurring/index.js";
import * as patternsDomain from "./patterns/index.js";
import * as insightsDomain from "./insights/index.js";
import * as savingsDomain from "./savings/index.js";
import * as debtsDomain from "./debts/index.js";
import * as healthDomain from "./health/index.js";

export async function boot() {
  "use strict";

  // ---------- Supabase client ----------
  var sb = window.supabase.createClient(
    window.PASSBOOK_CONFIG.SUPABASE_URL,
    window.PASSBOOK_CONFIG.SUPABASE_ANON_KEY
  );

  // ---------- credit cards (src/cards) ----------

  function cardForPaymentMethod(pm) { return cardsDomain.cardForPaymentMethod(pm, state.creditCards); }

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
    savingsGoals: [],
    debts: [],
    debtPayments: [],
    healthThresholds: healthDomain.normaliseThresholds(null)
  };
  var viewMonth = null;
  var customRange = null; // {start, end} both "YYYY-MM-DD", inclusive; null = pay-cycle mode via viewMonth
  var LEDGER_COLLAPSE_LIMIT = 3;
  var ledgerExpanded = false;
  var plannedExpanded = false;
  var recurringListExpanded = false;
  var breakdownExpanded = false;
  var patternsExpanded = false;
  var currentView = "home"; // "home" | "savings" | "debt" | "health"
  var showingGoalForm = false;
  var goalSliderTouched = false; // true once the user has dragged the slider by hand this time round
  var savingsFilters = { year: "all", month: "all", vehicle: "all", goal: "all" };
  var editingContributionId = null; // set while #savings-form is editing an existing contribution rather than logging a new one

  // ---------- pay-cycle periods (src/periods) ----------

  function cycleStartDay() { return periodsDomain.cycleStartDay(state.incomeSources); }
  function periodStartStr(mk) { return periodsDomain.periodStartStr(mk, cycleStartDay()); }
  function periodEndStr(mk) { return periodsDomain.periodEndStr(mk, cycleStartDay()); } // exclusive
  function periodLabel(mk) { return periodsDomain.periodLabel(mk, cycleStartDay()); }
  function currentPeriodKey() { return periodsDomain.currentPeriodKey(cycleStartDay()); }

  // ---------- custom date range (alternative to the pay-cycle period above) ----------

  function activeRangeStr() {
    if (customRange) return { start: customRange.start, end: periodsDomain.customRangeEndExclusive(customRange) };
    return { start: periodStartStr(viewMonth), end: periodEndStr(viewMonth) };
  }

  function activeRangeLabel() {
    if (!customRange) return periodLabel(viewMonth);
    return periodsDomain.dateRangeLabel(new Date(customRange.start + "T00:00:00"), new Date(customRange.end + "T00:00:00"));
  }

  function currentTxs() {
    var r = activeRangeStr();
    return periodsDomain.txInRange(state.transactions, r.start, r.end);
  }

  function fmtMoney(n) {
    try {
      return new Intl.NumberFormat("en-GB", { style: "currency", currency: state.currency || "GBP" }).format(n);
    } catch (e) {
      return "£" + n.toFixed(2);
    }
  }

  function txForPeriod(mk) {
    return periodsDomain.txInRange(state.transactions, periodStartStr(mk), periodEndStr(mk));
  }

  var sumBy = cashflowDomain.sumBy;

  // Money deliberately put aside is still money that has left the account, so
  // it comes off "left over" exactly like spending does — but it isn't
  // spending, and lumping the two together would make a good month (a big
  // transfer into an ISA) look identical to a bad one (a big shopping spree).
  // So it's tracked as its own figure. A savings transfer is always treated as
  // cash leaving now, never as card credit, because that's what it is: you
  // can't move money into a savings pot on a credit card.
  function cycleFinancials(txs, startStr, endExclusiveStr) {
    return cashflowDomain.cycleFinancials(txs, startStr, endExclusiveStr, state);
  }

  // ---------- recurring / direct debits (src/recurring) ----------

  function installmentRemaining(rule) { return recurringDomain.installmentRemaining(rule, state.transactions); }
  function installmentPaidSoFar(rule) { return recurringDomain.installmentPaidSoFar(rule, state.transactions); }

  // Generates any due-but-not-yet-logged recurring transactions, adds them to
  // state.transactions, and returns them so the caller can batch-insert them
  // into Supabase.
  function generateRecurringTransactions() {
    var created = recurringDomain.generateRecurringTransactions(state.recurringExpenses, state.transactions);
    Array.prototype.push.apply(state.transactions, created);
    return created;
  }

  // ---------- spending patterns ----------

  var WEEKDAY_LABELS = periodsDomain.WEEKDAY_LABELS;

  function computePatternsData(sel) { return patternsDomain.computePatternsData(state.transactions, sel); }

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
      var top = insightsDomain.topCategory(sums);
      var topCat = CATEGORIES[CAT_INDEX[top.catId]];
      var pct = spent > 0 ? Math.round((top.amount / spent) * 100) : 0;
      cards.push("<strong>" + esc(topCat.label) + "</strong> is your biggest spend this period at " + fmtMoney(top.amount) + " (" + pct + "% of total).");

      var prevSums = customRange ? {} : sumBy(spendingTxs(txForPeriod(shiftMonth(viewMonth, -1))));
      var biggestJump = insightsDomain.biggestCategoryJump(sums, prevSums);
      if (biggestJump) {
        var jc = CATEGORIES[CAT_INDEX[biggestJump.catId]];
        cards.push("<strong>" + esc(jc.label) + "</strong> is up " + fmtMoney(biggestJump.delta) + " versus last period.");
      }

      if (state.income != null && state.income > 0) {
        var range = activeRangeStr();
        var fin = cycleFinancials(allTxs, range.start, range.end);
        var nudge = insightsDomain.savingsRateNudge(fin, state.income);
        var rate = nudge.rate;
        if (nudge.kind === "overspent") {
          cards.push("Spending has outpaced income this period by " + fmtMoney(Math.abs(fin.leftover)) + ".");
        } else if (nudge.kind === "ahead") {
          cards.push("You've put aside " + Math.round(rate) + "% of income this period — ahead of the common 20% guideline.");
        } else if (nudge.kind === "closer") {
          cards.push("You've put aside " + Math.round(rate) + "% of income so far this period, getting closer to the 20% guideline some planners suggest.");
        } else if (nudge.kind === "low") {
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

  function cardSettlement(card, dateStr) { return cardsDomain.cardSettlement(card, dateStr); }

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
  function pendingCardReminders() { return cardsDomain.pendingCardReminders(state.creditCards, state.cardBalances); }

  // Sum of this card's transactions since the previous statement closed, up
  // to and including this one — the amount the real statement *should* show
  // if every purchase on the card was logged in the ledger. Shown as a
  // starting point when confirming a statement so entering it becomes
  // "confirm or adjust" instead of retyping a total by hand; any gap against
  // the real statement is interest, fees, or something not yet logged.
  function derivedStatementAmount(card, closeDateStr) {
    return cardsDomain.derivedStatementAmount(card, closeDateStr, state.transactions, state.creditCards);
  }

  // A £0 statement (an earlier overpayment covered everything) has nothing
  // to pay, so it's saved as already paid.
  function recordCardBalance(cardId, statementDate, amount) {
    var card = state.creditCards.filter(function (c) { return c.id === cardId; })[0];
    if (!card) return;
    var entry = {
      id: genId(),
      cardId: cardId,
      statementDate: statementDate,
      dueDate: cardsDomain.statementDueDate(card, statementDate),
      amount: amount,
      paid: amount === 0,
      paidDate: amount === 0 ? statementDate : null,
      paidAmount: amount === 0 ? 0 : null,
      createdAt: todayStr()
    };
    state.cardBalances.push(entry);
    renderAll();
    dbCall(sb.from("card_balances").insert(balanceToRow(entry)));
  }

  function saveCardPaymentFields(entry, fields) {
    entry.paidAmount = fields.paidAmount;
    entry.paid = fields.paid;
    entry.paidDate = fields.paidDate;
    renderAll();
    dbCall(sb.from("card_balances")
      .update({ paid: fields.paid, paid_date: fields.paidDate, paid_amount: fields.paidAmount })
      .eq("id", entry.id));
  }

  // One more payment towards a statement — may be part of it, all of it, or
  // more than it.
  function payCardBalance(id, amount, dateStr) {
    var entry = state.cardBalances.filter(function (b) { return b.id === id; })[0];
    if (!entry) return;
    saveCardPaymentFields(entry, cardsDomain.applyCardPayment(entry, amount, dateStr));
  }

  // Corrects the total paid towards a statement (0 = not paid after all).
  function setCardBalancePaidTotal(id, total, dateStr) {
    var entry = state.cardBalances.filter(function (b) { return b.id === id; })[0];
    if (!entry) return;
    saveCardPaymentFields(entry, cardsDomain.cardPaymentFields(entry, total, dateStr));
  }

  function cardPayFormHtml(cls, balanceId, amount, dateStr, minAmount, saveLabel) {
    return '<form class="card-pay-form ' + cls + '" data-id="' + esc(balanceId) + '" hidden>' +
      '<input type="number" class="card-pay-amount" inputmode="decimal" step="0.01" min="' + minAmount + '" value="' + amount.toFixed(2) + '" aria-label="Amount paid" required />' +
      '<input type="date" class="card-pay-date" value="' + esc(dateStr) + '" aria-label="Date paid" required />' +
      '<button type="submit">' + saveLabel + "</button>" +
      '<button type="button" class="card-pay-cancel">Cancel</button>' +
      "</form>";
  }

  // Shows/hides a row's pay form from its toggle button, and routes its
  // submit to `onSave(id, amount, dateStr)`.
  function wireCardPayForms(container, toggleSelector, onSave) {
    container.querySelectorAll(toggleSelector).forEach(function (btn) {
      btn.addEventListener("click", function () {
        var form = btn.closest(".card-pay-host").querySelector(".card-pay-form");
        form.hidden = !form.hidden;
        if (!form.hidden) form.querySelector(".card-pay-amount").focus();
      });
    });
    container.querySelectorAll(".card-pay-form").forEach(function (form) {
      form.querySelector(".card-pay-cancel").addEventListener("click", function () { form.hidden = true; });
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var input = form.querySelector(".card-pay-amount");
        var amount = parseFloat(input.value);
        if (!isFinite(amount) || amount < Number(input.min)) { input.focus(); return; }
        onSave(form.dataset.id, Math.round(amount * 100) / 100, form.querySelector(".card-pay-date").value || todayStr());
      });
    });
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
            amount: cardsDomain.remainingDue(b),
            paidSoFar: cardsDomain.paidSoFar(b),
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
          (ev.paidSoFar > 0 ? '<span class="cal-paid-note">left · ' + fmtMoney(ev.paidSoFar) + " paid</span>" : "") +
          (ev.balanceId ? '<button type="button" class="btn-bought cal-mark-paid">Mark as paid</button>' : "") +
          "</div>" +
          (ev.balanceId ? cardPayFormHtml("cal-pay-form", ev.balanceId, ev.amount, todayStr(), "0.01", "Save payment") : "")
        : "";
      return (
        '<div class="cal-row card-pay-host">' +
        '<div class="cal-date"><div class="cal-day">' + dayNum + '</div><div class="cal-mon">' + esc(monLbl) + "</div></div>" +
        '<div class="cal-main"><div class="cal-label">' + esc(ev.label) + '</div><div class="' + subClass + '">' + daysAwayLabel(days) + "</div>" + amountRow + "</div>" +
        '<span class="cal-dot" style="background:' + dotVar + '"></span>' +
        "</div>"
      );
    }).join("");

    // Opens with the amount left prefilled — change it if you paid a
    // different amount (e.g. extra to cover purchases since the statement).
    wireCardPayForms(el, ".cal-mark-paid", payCardBalance);
    renderCardPayments();
  }

  // The latest statement per card with a payment against it, so a payment
  // entered wrongly (amount or date) can be corrected.
  function renderCardPayments() {
    var el = document.getElementById("card-payments-list");
    var rows = cardsDomain.latestPaymentPerCard(state.creditCards, state.cardBalances);
    el.hidden = !rows.length;
    el.innerHTML = rows.length
      ? '<div class="edit-group-label">Card payments</div>' + rows.map(function (r) {
        var b = r.balance;
        var paid = cardsDomain.paidSoFar(b);
        var extra = cardsDomain.extraPaid(b);
        var left = cardsDomain.remainingDue(b);
        var note = extra > 0
          ? " (" + fmtMoney(extra) + " extra — comes off the next statement)"
          : left > 0 ? " (" + fmtMoney(left) + " still to pay)" : "";
        return '<div class="card-payment-row card-pay-host">' +
          '<div class="card-payment-main"><div class="card-payment-text"><strong>' + esc(r.card.label) + "</strong> · " +
          esc(fmtShortDate(b.statementDate)) + " statement " + fmtMoney(b.amount) + " — paid " + fmtMoney(paid) +
          (b.paidDate ? " on " + esc(fmtShortDate(b.paidDate)) : "") + esc(note) + "</div>" +
          '<button type="button" class="link-btn card-payment-edit">Edit</button></div>' +
          cardPayFormHtml("card-payment-edit-form", b.id, paid, b.paidDate || todayStr(), "0", "Save") +
          "</div>";
      }).join("")
      : "";
    wireCardPayForms(el, ".card-payment-edit", setCardBalancePaidTotal);
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
      var logged = Math.round(derivedStatementAmount(p.card, p.statementDate) * 100) / 100;
      var credit = cardsDomain.creditFromPreviousStatement(p.card, p.statementDate, state.cardBalances);
      var suggested = cardsDomain.suggestedStatementAmount(p.card, p.statementDate, state.transactions, state.creditCards, state.cardBalances);
      var suggestedAttr = logged > 0 ? ' value="' + suggested.toFixed(2) + '"' : "";
      var hint = logged > 0
        ? '<div class="card-reminder-hint">Logged on this card since the last statement: ' + fmtMoney(logged) +
          (credit > 0 ? ", less " + fmtMoney(credit) + " extra paid last time = " + fmtMoney(suggested) : "") +
          " — adjust if the real statement differs (interest, fees, anything not logged)</div>"
        : "";
      return (
        '<div class="card-reminder-row" data-card-id="' + esc(p.card.id) + '" data-stmt-date="' + esc(p.statementDate) + '">' +
        '<div class="card-reminder-text">💳 <strong>' + esc(p.card.label) + "</strong> statement generated " + esc(dateLabel) + " — confirm the balance to pay</div>" +
        hint +
        '<div class="amount-input"><span class="currency-prefix">£</span><input type="number" inputmode="decimal" step="0.01" min="0" class="card-reminder-input" placeholder="0.00"' + suggestedAttr + ' /></div>' +
        '<button type="button" class="btn-primary card-reminder-save">Save</button>' +
        "</div>"
      );
    }).join("");

    el.querySelectorAll(".card-reminder-save").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var row = btn.closest(".card-reminder-row");
        var input = row.querySelector(".card-reminder-input");
        var amount = parseFloat(input.value);
        if (!isFinite(amount) || amount < 0) { input.focus(); return; }
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
    if (editingCalendar) document.getElementById("card-payments-list").hidden = true;
    document.getElementById("calendar-edit-form").hidden = !editingCalendar;
    document.getElementById("cal-edit-toggle").textContent = editingCalendar ? "Cancel" : "Edit";
    if (editingCalendar) { renderCalendarEditForm(); } else { renderCalendar(); }
  }

  // Only items assigned to the current pay period show here — an unbought
  // item whose period has passed is bumped forward to the current one by
  // rolloverPlannedItems() (called once on load), which is what keeps it
  // "in the list" instead of aging out of view. A bought item keeps whatever
  // period it was bought in and simply stops showing once that period ends.
  function currentPeriodPlanned() {
    var pk = currentPeriodKey();
    return state.plannedExpenses.filter(function (p) { return (p.periodKey || pk) === pk; });
  }

  function renderPlanned() {
    var listEl = document.getElementById("planned-list");
    var summaryEl = document.getElementById("planned-summary");
    var items = currentPeriodPlanned().slice().sort(function (a, b) { return b.amount - a.amount; });
    // Bought items are done — they don't count towards "would this fit" any more.
    var total = items.reduce(function (s, p) { return p.bought ? s : s + p.amount; }, 0);

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
      var boughtAction = p.bought
        ? '<span class="planned-bought-tick" title="Bought' + (p.boughtDate ? " " + esc(p.boughtDate) : "") + '">✓ Bought</span>' +
          '<button type="button" class="link-btn btn-undo-bought" data-id="' + esc(p.id) + '">Undo</button>'
        : '<button type="button" class="btn-bought" data-id="' + esc(p.id) + '">Bought</button>';
      return (
        '<div class="planned-row' + (p.bought ? " planned-row-bought" : "") + '" data-id="' + esc(p.id) + '">' +
        '<div class="planned-main"><div class="planned-name">' + esc(p.name) + '</div>' +
        '<div class="planned-cat"><span class="cat-dot" style="background:var(--cat-' + idx + ')"></span>' + esc(cat.label) + "</div></div>" +
        '<div class="planned-amount">' + fmtMoney(p.amount) + "</div>" +
        '<div class="planned-actions">' + boughtAction +
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
      btn.addEventListener("click", function () { togglePlannedBought(btn.dataset.id, true); });
    });
    listEl.querySelectorAll(".btn-undo-bought").forEach(function (btn) {
      btn.addEventListener("click", function () { togglePlannedBought(btn.dataset.id, false); });
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
      if (r.paymentMethod) subParts.push(r.paymentMethod);
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
        '<input type="text" class="edit-payment-method" list="payment-method-options" value="' + esc(r.paymentMethod || "") + '" placeholder="Debited from" maxlength="40" autocomplete="off" />' +
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

  // ---------- savings: shared calculations (src/savings) ----------

  var sumAmounts = savingsDomain.sumAmounts;
  var taxYearRange = savingsDomain.taxYearRange;

  function contributionsInRange(startStr, endExclusiveStr) {
    return savingsDomain.contributionsInRange(state.savingsContributions, startStr, endExclusiveStr);
  }
  function medianEssentialMonthly() { return savingsDomain.medianEssentialMonthly(state.transactions); }
  function medianMonthlySavings() { return savingsDomain.medianMonthlySavings(state.transactions); }
  function medianMonthlyLeftover(n) { return savingsDomain.medianMonthlyLeftover(n, state); }
  function goalProgress(g) { return savingsDomain.goalProgress(g, state.savingsContributions, state.transactions); }

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
        '<div class="savings-row-actions">' +
        '<button type="button" class="link-btn savings-edit" data-id="' + esc(c.id) + '">Edit</button>' +
        '<button type="button" class="ledger-del savings-del" data-id="' + esc(c.id) + '">Delete</button>' +
        "</div>" +
        "</div>";
    });
    el.innerHTML = html;

    el.querySelectorAll(".savings-edit").forEach(function (btn) {
      btn.addEventListener("click", function () { startEditingContribution(btn.dataset.id); });
    });
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

    var rows = savingsDomain.holdingsByVehicle(state.savingsContributions);
    var total = sumAmounts(state.savingsContributions);
    var max = rows[0].amount;

    var tierSummary = savingsDomain.tierSplit(rows, total).map(function (s) {
      return TIER_LABELS[s.tier] + " " + s.pct + "%";
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

    var used = savingsDomain.taxYearIsaSplit(state.savingsContributions, ty).isaUsed;
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

  var SUBSCRIPTION_REVIEW_MAX = savingsDomain.SUBSCRIPTION_REVIEW_MAX;

  function cutCandidates() { return savingsDomain.cutCandidates(state.transactions); }

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
      var overdueTotal = overdue.reduce(function (s, b) { return s + cardsDomain.remainingDue(b); }, 0);
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

    var buffer = savingsDomain.reachableBuffer(state.savingsContributions);
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
    var isaSplit = savingsDomain.taxYearIsaSplit(state.savingsContributions, ty);
    var isaUsed = isaSplit.isaUsed;
    var outsideIsa = isaSplit.outsideIsa;
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

  // Two independent lists: debts tracked here (never touch the ledger — see
  // src/debts) and installment-based recurring rules (already fully wired
  // into the ledger via src/recurring's installment fields), so a purchase
  // financed on a store card that *does* generate ledger transactions isn't
  // duplicated here — it's read straight off Recurring payments instead.
  function renderDebtView() {
    var el = document.getElementById("debt-list");
    var summaryEl = document.getElementById("debt-summary");
    var debts = state.debts.slice().sort(function (a, b) { return a.label.localeCompare(b.label); });

    if (!debts.length) {
      summaryEl.textContent = "";
      el.innerHTML = '<p class="empty-state">Nothing tracked yet — add a debt above (an old loan or store card being paid off outside this app).</p>';
    } else {
      var totalRemaining = debts.reduce(function (s, d) { return s + debtsDomain.debtRemaining(d, state.debtPayments); }, 0);
      summaryEl.textContent = fmtMoney(totalRemaining) + " left across " + debts.length + (debts.length === 1 ? " debt" : " debts");

      el.innerHTML = debts.map(function (d) {
        var remaining = debtsDomain.debtRemaining(d, state.debtPayments);
        var pct = debtsDomain.debtProgressPct(d, state.debtPayments);
        var payments = debtsDomain.paymentsForDebt(d.id, state.debtPayments).slice().sort(function (a, b) { return b.date < a.date ? -1 : 1; });
        var paymentsHtml = payments.map(function (p) {
          return '<div class="debt-payment-row"><span>' + esc(p.date) + '</span><span>' + fmtMoney(p.amount) + '</span>' +
            '<button type="button" class="link-btn debt-payment-del" data-id="' + esc(p.id) + '">Delete</button></div>';
        }).join("");
        return (
          '<div class="debt-card" data-id="' + esc(d.id) + '">' +
          '<div class="debt-card-top"><span class="debt-label">' + esc(d.label) + '</span>' +
          '<button type="button" class="link-btn debt-del" data-id="' + esc(d.id) + '">Remove</button></div>' +
          '<div class="debt-figures"><span>' + fmtMoney(remaining) + ' left</span><span class="debt-of">of ' + fmtMoney(d.originalAmount) + '</span></div>' +
          '<div class="bar-track"><div class="bar-fill tier-low" style="width:' + Math.max(2, pct) + '%"></div></div>' +
          '<form class="debt-payment-form" data-debt-id="' + esc(d.id) + '">' +
          '<input type="number" class="debt-payment-amount" inputmode="decimal" step="0.01" min="0.01" placeholder="Amount" required />' +
          '<input type="date" class="debt-payment-date" value="' + esc(todayStr()) + '" required />' +
          '<button type="submit" class="btn-secondary">Log payment</button>' +
          "</form>" +
          (paymentsHtml ? '<div class="debt-payments">' + paymentsHtml + "</div>" : "") +
          "</div>"
        );
      }).join("");

      el.querySelectorAll(".debt-del").forEach(function (btn) {
        btn.addEventListener("click", function () {
          if (btn.dataset.confirming === "1") {
            deleteDebt(btn.dataset.id);
          } else {
            btn.dataset.confirming = "1";
            btn.textContent = "Sure?";
            setTimeout(function () { btn.dataset.confirming = "0"; btn.textContent = "Remove"; }, 2800);
          }
        });
      });
      el.querySelectorAll(".debt-payment-del").forEach(function (btn) {
        btn.addEventListener("click", function () { deleteDebtPayment(btn.dataset.id); });
      });
      el.querySelectorAll(".debt-payment-form").forEach(function (form) {
        form.addEventListener("submit", function (e) {
          e.preventDefault();
          var amount = parseFloat(form.querySelector(".debt-payment-amount").value);
          var date = form.querySelector(".debt-payment-date").value || todayStr();
          if (!isFinite(amount) || amount <= 0) return;
          addDebtPayment(form.dataset.debtId, Math.round(amount * 100) / 100, date);
        });
      });
    }

    var linkedEl = document.getElementById("debt-linked-list");
    var linked = state.recurringExpenses.filter(function (r) { return r.installment; });
    if (!linked.length) {
      linkedEl.innerHTML = '<p class="empty-state">No finance agreements set up in Recurring payments yet.</p>';
      return;
    }
    linkedEl.innerHTML = linked.map(function (r) {
      var remaining = installmentRemaining(r);
      var paid = installmentPaidSoFar(r);
      var pct = r.installment.totalOwed > 0 ? Math.min(100, (paid / r.installment.totalOwed) * 100) : 0;
      return (
        '<div class="debt-card">' +
        '<div class="debt-card-top"><span class="debt-label">' + esc(r.label) + (r.active ? "" : " (inactive)") + '</span></div>' +
        '<div class="debt-figures"><span>' + fmtMoney(remaining) + ' left</span><span class="debt-of">of ' + fmtMoney(r.installment.totalOwed) + '</span></div>' +
        '<div class="bar-track"><div class="bar-fill tier-growth" style="width:' + Math.max(2, pct) + '%"></div></div>' +
        "</div>"
      );
    }).join("");
  }

  function wireDebtForms() {
    document.getElementById("debt-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var label = document.getElementById("d-label").value.trim().slice(0, 60);
      var original = parseFloat(document.getElementById("d-original").value);
      var startingRaw = document.getElementById("d-starting").value;
      var starting = startingRaw ? parseFloat(startingRaw) : 0;
      var dayRaw = document.getElementById("d-day").value;
      if (!label || !isFinite(original) || original <= 0) return;
      var d = {
        id: genId(), label: label, originalAmount: Math.round(original * 100) / 100,
        startingBalance: isFinite(starting) ? Math.round(starting * 100) / 100 : 0,
        paymentDay: dayRaw ? parseInt(dayRaw, 10) : null, active: true, createdAt: todayStr()
      };
      addDebt(d);
      document.getElementById("debt-form").reset();
    });
  }

  // ---------- financial health (src/health) ----------

  var healthWindow = { count: 6 }; // { count: n } = last n complete pay periods; { from, to } = custom inclusive range
  var editingHealthTargets = false;

  var HEALTH_TITLES = {
    savingsRate: "Savings rate",
    bufferMonths: "Emergency buffer",
    withinMeans: "Living within means",
    debtLoad: "Debt load",
    cardDiscipline: "Card discipline",
    fixedCommitments: "Fixed commitments"
  };
  var HEALTH_TARGET_HELP = {
    savingsRate: "% of income put aside",
    bufferMonths: "months of essentials in easy-access savings",
    withinMeans: "% of pay periods under budget",
    debtLoad: "% of income on debt repayments",
    fixedCommitments: "% of income on direct debits"
  };
  // Colour is never the only signal — every dot has a word next to it.
  var HEALTH_STATE_LABELS = { green: "Good", amber: "Watch", red: "Act now", neutral: "No data" };
  var HEALTH_VERDICTS = {
    healthy: { cls: "green", title: "Healthy" },
    okay: { cls: "amber", title: "Okay" },
    attention: { cls: "red", title: "Needs attention" },
    neutral: { cls: "neutral", title: "Not enough data yet" }
  };

  function healthValueText(key, v) {
    if (key === "bufferMonths") return v + (v === 1 ? " month" : " months");
    if (key === "withinMeans") return v + "% of periods";
    return v + "%";
  }

  function healthTargetText(key, green) {
    return (healthDomain.HIGHER_IS_BETTER[key] ? "target at least " : "target at most ") + healthValueText(key, green);
  }

  function healthTrendText(cur, prev) {
    if (prev == null) return "";
    if (cur === prev) return " · same as the window before";
    return " · " + (cur > prev ? "↑" : "↓") + " from " + prev + "% the window before";
  }

  function shortDateLabel(dateStr) {
    return new Date(dateStr + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  }

  // Turns a domain row (numbers only) into the figure, explanation and
  // "to reach green" line shown on the page.
  function healthRowParts(r) {
    var noIncome = "Add your monthly income on Home to measure this.";
    var noData = "Nothing logged in this window yet.";

    if (r.key === "savingsRate") {
      if (r.status === "neutral") return { figure: "—", sub: r.reason === "no-income" ? noIncome : noData };
      return {
        figure: r.pct + "%",
        sub: fmtMoney(r.avgSaved) + " put aside a period on average, against " + fmtMoney(state.income) + " income · " +
          healthTargetText(r.key, r.target.green) + healthTrendText(r.pct, r.prevPct),
        hint: r.toGreen ? "Put aside " + fmtMoney(r.toGreen) + " more a month to reach " + r.target.green + "%." : ""
      };
    }

    if (r.key === "bufferMonths") {
      if (r.status === "neutral") return { figure: "—", sub: "Log a few months of spending so this can size your essentials." };
      return {
        figure: r.months.toFixed(1) + " months",
        sub: fmtMoney(r.buffer) + " in easy-access savings against " + fmtMoney(r.essential) + "/mo of essentials · " +
          healthTargetText(r.key, r.target.green),
        hint: r.toGreen ? "Add " + fmtMoney(r.toGreen) + " to easy-access savings to reach " + healthValueText(r.key, r.target.green) + "." : ""
      };
    }

    if (r.key === "withinMeans") {
      if (r.status === "neutral") return { figure: "—", sub: r.reason === "no-income" ? noIncome : noData };
      var overs = r.overs.slice(0, 3).map(function (o) { return monthShortLabel(o.key) + " (" + fmtMoney(o.amount) + ")"; }).join(", ");
      if (r.overs.length > 3) overs += " and " + (r.overs.length - 3) + " more";
      return {
        figure: r.under + " of " + r.total + " periods",
        sub: (r.overs.length ? "Over budget in " + overs : "Under budget every period") + " · " +
          healthTargetText(r.key, r.target.green) + healthTrendText(r.pct, r.prevPct),
        hint: r.toGreen ? "When you went over it was by " + fmtMoney(r.toGreen) + " on average — trimming that much in those periods closes the gap." : ""
      };
    }

    if (r.key === "debtLoad") {
      if (r.status === "neutral") return { figure: "—", sub: noIncome };
      var parts = [];
      if (!r.count) {
        parts.push("No debts being repaid");
      } else {
        parts.push(fmtMoney(r.monthly) + "/mo in repayments");
        parts.push(fmtMoney(r.totalLeft) + " left across " + r.count + (r.count === 1 ? " debt" : " debts"));
        if (r.payoff) parts.push("clear by ~" + monthShortLabel(r.payoff) + (r.payoffUnknown ? " (some dates unknown)" : ""));
      }
      var debtSub = parts.join(" · ") + " · " + healthTargetText(r.key, r.target.green);
      if (r.outsideLedgerCount) {
        debtSub += ". Includes " + r.outsideLedgerCount + (r.outsideLedgerCount === 1 ? " debt" : " debts") +
          " your employer deducts — left out of the % because your income is already after them.";
      }
      return {
        figure: r.pct + "% of income",
        sub: debtSub,
        hint: r.toGreen
          ? "Clearing " + r.toGreen.label + " (" + fmtMoney(r.toGreen.remaining) + " left) would bring this to " + r.toGreen.pctAfter + "%" +
            (r.toGreen.reachesGreen ? "." : " — the biggest single step, though still above target.")
          : ""
      };
    }

    if (r.key === "cardDiscipline") {
      if (r.status === "red") {
        var list = r.overdue.map(function (o) { return o.cardLabel + " " + fmtMoney(o.amount) + " (due " + shortDateLabel(o.dueDate) + ")"; }).join(", ");
        return {
          figure: r.overdue.length + " overdue",
          sub: "Unpaid past the due date: " + list + ".",
          hint: "Pay " + fmtMoney(r.overdueTotal) + " now — card interest usually costs far more than savings earn."
        };
      }
      if (r.status === "amber") {
        return {
          figure: r.lateCount + " paid late",
          sub: r.lateCount + " of " + r.dueCount + " statements due in this window were paid after the due date.",
          hint: "Pay each statement by its due date — the money calendar on Home shows what's coming up."
        };
      }
      if (r.status === "green") {
        return {
          figure: "On time",
          sub: r.dueCount === 1 ? "The statement due in this window was paid on time." : "All " + r.dueCount + " statements due in this window were paid on time."
        };
      }
      return { figure: "—", sub: "No card statements were due in this window." };
    }

    // fixedCommitments
    if (r.status === "neutral") return { figure: "—", sub: noIncome };
    return {
      figure: r.pct + "% of income",
      sub: fmtMoney(r.total) + "/mo across " + r.count + (r.count === 1 ? " direct debit" : " direct debits") +
        ", committed before the month starts · " + healthTargetText(r.key, r.target.green),
      hint: r.toGreen ? "Trim " + fmtMoney(r.toGreen) + " a month of direct debits to get to " + r.target.green + "%." : ""
    };
  }

  function renderHealthView() {
    var h = healthDomain.computeHealth(state, healthWindow, state.healthThresholds);
    var custom = !!healthWindow.from;

    document.querySelectorAll(".health-win-btn").forEach(function (btn) {
      var active = btn.dataset.win === "custom" ? custom : !custom && String(healthWindow.count) === btn.dataset.win;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    });
    document.getElementById("health-custom").hidden = !custom;

    var startD = new Date(h.range.start + "T00:00:00");
    var endD = new Date(h.range.end + "T00:00:00");
    endD.setDate(endD.getDate() - 1);
    var rangeLabel = periodsDomain.dateRangeLabel(startD, endD);
    if (h.includesCurrent) rangeLabel += " · includes the current, unfinished period";
    if (h.usableCount && h.usableCount < h.keys.length) {
      rangeLabel += " · you've logged " + h.usableCount + " of these " + h.keys.length + " periods";
    }
    document.getElementById("health-range-label").textContent = rangeLabel;

    var v = HEALTH_VERDICTS[h.verdict.level];
    var counts = [];
    if (h.verdict.green) counts.push(h.verdict.green + " good");
    if (h.verdict.amber) counts.push(h.verdict.amber + " to watch");
    if (h.verdict.red) counts.push(h.verdict.red + " to act on");
    var verdictEl = document.getElementById("health-verdict");
    verdictEl.className = "health-verdict health-" + v.cls;
    verdictEl.innerHTML = '<span class="health-dot" aria-hidden="true"></span><span><strong>' + esc(v.title) + "</strong>" +
      (counts.length ? " — " + esc(counts.join(", ")) : "") + "</span>";

    document.getElementById("health-rows").innerHTML = h.rows.map(function (r) {
      var p = healthRowParts(r);
      return (
        '<div class="health-row health-' + r.status + '" data-metric="' + r.key + '">' +
        '<span class="health-dot" aria-hidden="true"></span>' +
        '<div class="health-main">' +
        '<div class="health-top"><span class="health-title">' + esc(HEALTH_TITLES[r.key]) + "</span>" +
        '<span class="health-figure">' + esc(p.figure) + '<span class="health-state">' + HEALTH_STATE_LABELS[r.status] + "</span></span></div>" +
        '<div class="health-sub">' + esc(p.sub) + "</div>" +
        (p.hint ? '<div class="health-hint"><strong>To reach green:</strong> ' + esc(p.hint) + "</div>" : "") +
        "</div></div>"
      );
    }).join("");

    renderHealthTargets();
  }

  function renderHealthTargets() {
    var el = document.getElementById("health-targets");
    var t = state.healthThresholds;
    document.getElementById("health-targets-toggle").textContent = editingHealthTargets ? "Cancel" : "Edit";

    if (!editingHealthTargets) {
      el.innerHTML = healthDomain.METRIC_KEYS.map(function (key) {
        var word = healthDomain.HIGHER_IS_BETTER[key] ? "at least " : "at most ";
        return '<div class="health-target-line"><span>' + esc(HEALTH_TITLES[key]) + "</span><span>" +
          esc("green " + word + healthValueText(key, t[key].green) + " · amber " + word + healthValueText(key, t[key].amber)) +
          "</span></div>";
      }).join("");
      return;
    }

    el.innerHTML =
      '<form id="health-targets-form" class="health-targets-form" novalidate>' +
      healthDomain.METRIC_KEYS.map(function (key) {
        var word = healthDomain.HIGHER_IS_BETTER[key] ? "at least" : "at most";
        return (
          '<fieldset class="health-target-edit"><legend>' + esc(HEALTH_TITLES[key]) +
          ' <span class="opt">(' + esc(HEALTH_TARGET_HELP[key]) + ")</span></legend>" +
          "<label>Green " + word + ' <input type="number" inputmode="decimal" step="any" min="0" name="' + key + '-green" value="' + t[key].green + '" /></label>' +
          "<label>Amber " + word + ' <input type="number" inputmode="decimal" step="any" min="0" name="' + key + '-amber" value="' + t[key].amber + '" /></label>' +
          "</fieldset>"
        );
      }).join("") +
      '<p class="health-target-error" id="health-target-error" role="alert" hidden></p>' +
      '<div class="health-target-actions"><button type="submit" class="btn-primary">Save targets</button>' +
      '<button type="button" class="link-btn" id="health-targets-reset">Reset to defaults</button></div>' +
      "</form>";

    document.getElementById("health-targets-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var form = e.target;
      var next = {};
      var bad = [];
      healthDomain.METRIC_KEYS.forEach(function (key) {
        var g = parseFloat(form.elements[key + "-green"].value);
        var a = parseFloat(form.elements[key + "-amber"].value);
        if (!healthDomain.validThresholdPair(key, g, a)) bad.push(HEALTH_TITLES[key]);
        next[key] = { green: g, amber: a };
      });
      if (bad.length) {
        var err = document.getElementById("health-target-error");
        err.textContent = "Check " + bad.join(", ") + ": use numbers of 0 or more, with green no worse than amber.";
        err.hidden = false;
        return;
      }
      saveHealthThresholds(next);
    });
    document.getElementById("health-targets-reset").addEventListener("click", function () {
      saveHealthThresholds(healthDomain.DEFAULT_THRESHOLDS);
    });
  }

  // Saved on its own rather than folded into the income upsert, so that on a
  // database where the health_thresholds column hasn't been added yet only
  // this save fails (with the usual sync banner) — income keeps saving fine.
  function saveHealthThresholds(t) {
    state.healthThresholds = healthDomain.normaliseThresholds(t);
    editingHealthTargets = false;
    renderAll();
    dbCall(sb.from("settings").upsert({ user_id: currentUserId, health_thresholds: state.healthThresholds }, { onConflict: "user_id" }));
  }

  function populateHealthRangeSelects() {
    var keys = healthDomain.selectablePeriodKeys(state);
    var optionsHtml = keys.map(function (mk) { return '<option value="' + esc(mk) + '">' + esc(periodLabel(mk)) + "</option>"; }).join("");
    var from = document.getElementById("health-from");
    var to = document.getElementById("health-to");
    from.innerHTML = optionsHtml;
    to.innerHTML = optionsHtml;
    from.value = healthWindow.from && keys.indexOf(healthWindow.from) !== -1 ? healthWindow.from : keys[Math.max(0, keys.length - 6)];
    to.value = healthWindow.to && keys.indexOf(healthWindow.to) !== -1 ? healthWindow.to : keys[keys.length - 1];
  }

  function wireHealth() {
    document.querySelectorAll(".health-win-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (btn.dataset.win === "custom") {
          populateHealthRangeSelects();
          healthWindow = { from: document.getElementById("health-from").value, to: document.getElementById("health-to").value };
        } else {
          healthWindow = { count: parseInt(btn.dataset.win, 10) };
        }
        renderHealthView();
      });
    });
    ["health-from", "health-to"].forEach(function (id) {
      document.getElementById(id).addEventListener("change", function () {
        healthWindow = { from: document.getElementById("health-from").value, to: document.getElementById("health-to").value };
        renderHealthView();
      });
    });
    document.getElementById("health-targets-toggle").addEventListener("click", function () {
      editingHealthTargets = !editingHealthTargets;
      renderHealthTargets();
    });
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
    if (currentView === "debt") renderDebtView();
    if (currentView === "health") renderHealthView();
  }

  // The app is a single page with one section visible at a time rather than a
  // router — same shape as the existing panel toggles, no URL handling needed.
  // The pay-period nav belongs to Home only; Savings has its own filters and a
  // period arrow there would just be confusing.
  function showView(name) {
    currentView = name;
    document.getElementById("view-home").hidden = name !== "home";
    document.getElementById("view-savings").hidden = name !== "savings";
    document.getElementById("view-debt").hidden = name !== "debt";
    document.getElementById("view-health").hidden = name !== "health";
    document.querySelector(".month-nav").hidden = name !== "home";
    document.getElementById("range-form").hidden = true;
    document.getElementById("nav-home").classList.toggle("active", name === "home");
    document.getElementById("nav-savings").classList.toggle("active", name === "savings");
    document.getElementById("nav-debt").classList.toggle("active", name === "debt");
    document.getElementById("nav-health").classList.toggle("active", name === "health");
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

  function rowToPlanned(r) {
    return {
      id: r.id, name: r.name, amount: Number(r.amount), categoryId: r.category_id, note: r.note || "",
      createdAt: r.created_at, periodKey: r.period_key || null, bought: !!r.bought, boughtDate: r.bought_date || null
    };
  }
  function plannedToRow(p) {
    return {
      id: p.id, user_id: currentUserId, name: p.name, amount: p.amount, category_id: p.categoryId, note: p.note || "",
      created_at: p.createdAt, period_key: p.periodKey || null, bought: !!p.bought, bought_date: p.boughtDate || null
    };
  }

  function rowToBalance(r) {
    return {
      id: r.id, cardId: r.card_id, statementDate: r.statement_date, dueDate: r.due_date,
      amount: Number(r.amount), paid: !!r.paid, paidDate: r.paid_date || null,
      paidAmount: r.paid_amount == null ? null : Number(r.paid_amount), createdAt: r.created_at
    };
  }
  function balanceToRow(b) {
    var row = {
      id: b.id, user_id: currentUserId, card_id: b.cardId, statement_date: b.statementDate, due_date: b.dueDate,
      amount: b.amount, paid: b.paid, paid_date: b.paidDate || null, created_at: b.createdAt
    };
    // Only sent when set, so recording a statement still works on a database
    // that hasn't had the paid_amount column added yet.
    if (b.paidAmount != null) row.paid_amount = b.paidAmount;
    return row;
  }

  function rowToRecurring(r) {
    return {
      id: r.id, label: r.label, amount: Number(r.amount), dayOfMonth: r.day_of_month, categoryId: r.category_id,
      active: !!r.active, installment: r.installment_total != null ? { totalOwed: Number(r.installment_total) } : null,
      startMonth: r.start_month || null, paymentMethod: r.payment_method || "", createdAt: r.created_at
    };
  }
  function recurringToRow(rec) {
    return {
      id: rec.id, user_id: currentUserId, label: rec.label, amount: rec.amount, day_of_month: rec.dayOfMonth, category_id: rec.categoryId,
      active: rec.active, installment_total: rec.installment ? rec.installment.totalOwed : null,
      start_month: rec.startMonth || null, payment_method: rec.paymentMethod || null, created_at: rec.createdAt
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

  function rowToDebt(r) {
    return {
      id: r.id, label: r.label, originalAmount: Number(r.original_amount), startingBalance: Number(r.starting_balance || 0),
      paymentDay: r.payment_day || null, active: !!r.active, createdAt: r.created_at
    };
  }
  function debtToRow(d) {
    return {
      id: d.id, user_id: currentUserId, label: d.label, original_amount: d.originalAmount, starting_balance: d.startingBalance || 0,
      payment_day: d.paymentDay || null, active: d.active !== false, created_at: d.createdAt
    };
  }

  function rowToDebtPayment(r) {
    return { id: r.id, debtId: r.debt_id, amount: Number(r.amount), date: r.date };
  }
  function debtPaymentToRow(p) {
    return { id: p.id, user_id: currentUserId, debt_id: p.debtId, amount: p.amount, date: p.date };
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
      sb.from("savings_goals").select("*"),
      sb.from("debts").select("*"),
      sb.from("debt_payments").select("*")
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
      savingsGoals: (results[8].data || []).map(rowToGoal),
      debts: (results[9].data || []).map(rowToDebt),
      debtPayments: (results[10].data || []).map(rowToDebtPayment),
      // A database without the health_thresholds column yet just returns no
      // such field here — the defaults cover it.
      healthThresholds: healthDomain.normaliseThresholds(settingsRow && settingsRow.health_thresholds)
    };
  }

  // Bumps every unbought planned item whose period has already passed
  // forward to the current period, in one batched update, so it stays
  // visible in "this month" instead of aging out when its original period
  // ends. A missing period_key (pre-migration rows, or the seeded test data)
  // counts as needing the bump too.
  function rolloverPlannedItems() {
    var pk = currentPeriodKey();
    var stale = state.plannedExpenses.filter(function (p) { return !p.bought && (!p.periodKey || p.periodKey < pk); });
    if (!stale.length) return;
    stale.forEach(function (p) { p.periodKey = pk; });
    dbCall(sb.from("planned_expenses").update({ period_key: pk }).in("id", stale.map(function (p) { return p.id; })));
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

  // Edits both halves of a contribution in place — the savings_contributions
  // row and its paired ledger transaction — so the two never drift apart the
  // way they would if only one side got updated.
  function updateSavingsContribution(id, data) {
    var c = state.savingsContributions.filter(function (x) { return x.id === id; })[0];
    if (!c) return;
    c.amount = data.amount;
    c.date = data.date;
    c.vehicle = data.vehicle;
    c.accountLabel = data.accountLabel || "";
    c.goalId = data.goalId || null;
    c.note = data.note || "";
    var ops = [sb.from("savings_contributions").update(contributionToRow(c)).eq("id", id)];
    if (c.transactionId) {
      var t = state.transactions.filter(function (x) { return x.id === c.transactionId; })[0];
      if (t) {
        t.amount = data.amount;
        t.date = data.date;
        t.note = data.note || vehicleFor(data.vehicle).label;
        t.paymentMethod = data.source || "";
        ops.push(sb.from("transactions").update(txToRow(t)).eq("id", t.id));
      }
    }
    renderAll();
    dbCall(Promise.all(ops));
  }

  function deleteSavingsContribution(id) {
    var c = state.savingsContributions.filter(function (x) { return x.id === id; })[0];
    if (!c) return;
    if (editingContributionId === id) cancelEditingContribution();
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

  // ---------- debts tracked outside the ledger (src/debts) ----------
  // These are debts an employer or similar deducts before you ever see the
  // money — logging a payment here must never touch `transactions` or the
  // leftover figure, since that money was never "yours" to spend in the
  // first place. Contrast with a recurring_expenses installment (e.g. a
  // dining table on finance), which *is* already in the ledger and needs no
  // entry here — see the "linked to your ledger" section of renderDebtView.

  function addDebt(d) {
    state.debts.push(d);
    renderAll();
    dbCall(sb.from("debts").insert(debtToRow(d)));
  }

  function deleteDebt(id) {
    state.debts = state.debts.filter(function (d) { return d.id !== id; });
    state.debtPayments = state.debtPayments.filter(function (p) { return p.debtId !== id; });
    renderAll();
    dbCall(sb.from("debts").delete().eq("id", id));
  }

  function addDebtPayment(debtId, amount, date) {
    var p = { id: genId(), debtId: debtId, amount: amount, date: date };
    state.debtPayments.push(p);
    renderAll();
    dbCall(sb.from("debt_payments").insert(debtPaymentToRow(p)));
  }

  function deleteDebtPayment(id) {
    state.debtPayments = state.debtPayments.filter(function (p) { return p.id !== id; });
    renderAll();
    dbCall(sb.from("debt_payments").delete().eq("id", id));
  }

  // Marking an item bought never touches the ledger — the user adds that
  // transaction themselves — it only flips a flag so the row shows a green
  // tick instead of the "Bought" button. `bought` also takes the item out of
  // rolloverPlannedItems()'s reach, so it stops following the current period
  // once it's done.
  function togglePlannedBought(id, bought) {
    var item = state.plannedExpenses.filter(function (p) { return p.id === id; })[0];
    if (!item) return;
    item.bought = bought;
    item.boughtDate = bought ? todayStr() : null;
    renderAll();
    dbCall(sb.from("planned_expenses").update({ bought: bought, bought_date: item.boughtDate }).eq("id", id));
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

  // Current period plus the next 5, so a planned item can optionally be
  // set aside for a future pay period rather than only "right now". Must run
  // after loadAll() has populated state.incomeSources — cycleStartDay()
  // defaults to day 1 on an empty list, so calling this before sign-in would
  // compute the wrong "current period" for anyone whose actual payday isn't
  // the 1st. Rebuilds from scratch each call since showApp() (and so this)
  // can run more than once per page load (sign out, then sign in again).
  function populatePlannedPeriodSelect() {
    var sel = document.getElementById("p-period");
    sel.innerHTML = "";
    var pk = currentPeriodKey();
    for (var i = 0; i <= 5; i++) {
      var mk = shiftMonth(pk, i);
      var opt = document.createElement("option");
      opt.value = mk;
      opt.textContent = periodLabel(mk) + (i === 0 ? " (this period)" : "");
      sel.appendChild(opt);
    }
  }

  function wirePlannedForm() {
    document.getElementById("planned-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var name = document.getElementById("p-name").value.trim().slice(0, 60);
      var amount = parseFloat(document.getElementById("p-amount").value);
      var categoryId = document.getElementById("p-category").value;
      var periodKey = document.getElementById("p-period").value || currentPeriodKey();
      if (!name || !isFinite(amount) || amount <= 0 || !categoryId) return;
      var p = {
        id: genId(), name: name, amount: Math.round(amount * 100) / 100, categoryId: categoryId, note: "",
        createdAt: todayStr(), periodKey: periodKey, bought: false, boughtDate: null
      };
      state.plannedExpenses.push(p);
      renderAll();
      dbCall(sb.from("planned_expenses").insert(plannedToRow(p)));
      document.getElementById("planned-form").reset();
      document.getElementById("p-period").value = currentPeriodKey();
    });
  }

  function startEditingContribution(id) {
    var c = state.savingsContributions.filter(function (x) { return x.id === id; })[0];
    if (!c) return;
    editingContributionId = id;
    document.getElementById("s-amount").value = c.amount;
    document.getElementById("s-date").value = c.date;
    document.getElementById("s-vehicle").value = c.vehicle;
    document.getElementById("s-account").value = c.accountLabel || "";
    document.getElementById("s-goal").value = c.goalId || "";
    document.getElementById("s-source").value = (state.transactions.filter(function (t) { return t.id === c.transactionId; })[0] || {}).paymentMethod || "";
    document.getElementById("s-note").value = c.note || "";
    document.getElementById("savings-submit").textContent = "Save changes";
    document.getElementById("savings-cancel-edit").hidden = false;
    document.getElementById("savings-form").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function cancelEditingContribution() {
    editingContributionId = null;
    document.getElementById("savings-form").reset();
    document.getElementById("s-date").value = todayStr();
    document.getElementById("savings-submit").textContent = "Log savings";
    document.getElementById("savings-cancel-edit").hidden = true;
  }

  function wireSavingsForm() {
    document.getElementById("s-date").value = todayStr();
    document.getElementById("savings-cancel-edit").addEventListener("click", cancelEditingContribution);
    document.getElementById("savings-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var amount = parseFloat(document.getElementById("s-amount").value);
      var vehicle = document.getElementById("s-vehicle").value;
      if (!isFinite(amount) || amount <= 0 || !vehicle) return;
      var data = {
        amount: Math.round(amount * 100) / 100,
        date: document.getElementById("s-date").value || todayStr(),
        vehicle: vehicle,
        accountLabel: document.getElementById("s-account").value.trim().slice(0, 40),
        goalId: document.getElementById("s-goal").value || null,
        source: document.getElementById("s-source").value.trim().slice(0, 40),
        note: document.getElementById("s-note").value.trim().slice(0, 80)
      };
      if (editingContributionId) {
        updateSavingsContribution(editingContributionId, data);
        cancelEditingContribution();
        return;
      }
      addSavingsContribution(data);
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
      var paymentMethod = document.getElementById("rec-payment-method").value.trim().slice(0, 40);
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
        paymentMethod: paymentMethod,
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
        var paymentMethod = row.querySelector(".edit-payment-method").value.trim().slice(0, 40);
        var active = row.querySelector(".edit-active").checked;
        var startMonth = row.querySelector(".edit-start").value;
        updated.push({
          id: id,
          label: label,
          amount: isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : (existing ? existing.amount : 0),
          dayOfMonth: day,
          categoryId: CAT_INDEX.hasOwnProperty(categoryId) ? categoryId : "other",
          paymentMethod: paymentMethod,
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
    populatePlannedPeriodSelect();
    rolloverPlannedItems();
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
    document.getElementById("nav-debt").addEventListener("click", function () { showView("debt"); });
    document.getElementById("nav-health").addEventListener("click", function () { showView("health"); });
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
    wireDebtForms();
    wireHealth();
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
}
