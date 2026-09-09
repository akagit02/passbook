(function () {
  "use strict";
  var sb = window.supabase.createClient(window.PASSBOOK_CONFIG.SUPABASE_URL, window.PASSBOOK_CONFIG.SUPABASE_ANON_KEY);

  var authCard = document.getElementById("auth-card");
  var importCard = document.getElementById("import-card");
  var authStatus = document.getElementById("auth-status");
  var importStatus = document.getElementById("import-status");
  var currentUserId = null;

  function setStatus(el, text, kind) {
    el.textContent = text;
    el.className = "status" + (kind ? " " + kind : "");
  }

  document.getElementById("signin-btn").addEventListener("click", function () {
    var email = document.getElementById("email").value.trim();
    var password = document.getElementById("password").value;
    setStatus(authStatus, "Signing in…", "");
    sb.auth.signInWithPassword({ email: email, password: password }).then(function (res) {
      if (res.error) { setStatus(authStatus, res.error.message, "err"); return; }
      currentUserId = res.data.user.id;
      authCard.hidden = true;
      importCard.hidden = false;
      setStatus(authStatus, "", "");
    });
  });

  document.getElementById("signout-btn").addEventListener("click", function () {
    sb.auth.signOut().then(function () {
      currentUserId = null;
      importCard.hidden = true;
      authCard.hidden = false;
    });
  });

  sb.auth.getSession().then(function (r) {
    if (r.data.session) {
      currentUserId = r.data.session.user.id;
      authCard.hidden = true;
      importCard.hidden = false;
    }
  });

  // ---- row mapping (mirrors app.js — every row is tagged with the signed-in
  // user's id, so imported data only ever shows up under that same login) ----
  function incomeSourceToRow(s, i) { return { id: s.id, user_id: currentUserId, label: s.label, pay_day: s.payDay, sort_order: i }; }
  function creditCardToRow(c, i) { return { id: c.id, user_id: currentUserId, label: c.label, statement_day: c.statementDay, payment_day: c.paymentDay, sort_order: i }; }
  function txToRow(t) {
    return { id: t.id, user_id: currentUserId, amount: t.amount, date: t.date, category_id: t.categoryId, note: t.note || "", recurring_id: t.recurringId || null, recurring_occurrence: t.recurringOccurrence || null };
  }
  function plannedToRow(p) { return { id: p.id, user_id: currentUserId, name: p.name, amount: p.amount, category_id: p.categoryId, note: p.note || "", created_at: p.createdAt }; }
  function balanceToRow(b) {
    return { id: b.id, user_id: currentUserId, card_id: b.cardId, statement_date: b.statementDate, due_date: b.dueDate, amount: b.amount, paid: !!b.paid, paid_date: b.paidDate || null, created_at: b.createdAt };
  }
  function recurringToRow(r) {
    return { id: r.id, user_id: currentUserId, label: r.label, amount: r.amount, day_of_month: r.dayOfMonth, category_id: r.categoryId, active: r.active !== false, installment_total: r.installment ? r.installment.totalOwed : null, start_month: r.startMonth || null, created_at: r.createdAt };
  }

  async function upsertAll(table, rows, onConflict) {
    if (!rows || !rows.length) return { table: table, count: 0 };
    var res = await sb.from(table).upsert(rows, { onConflict: onConflict || "id" });
    if (res.error) throw new Error(table + ": " + res.error.message);
    return { table: table, count: rows.length };
  }

  document.getElementById("import-btn").addEventListener("click", async function () {
    var btn = this;
    var raw = document.getElementById("json-input").value;
    var data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      setStatus(importStatus, "That doesn't look like valid JSON — paste exactly what the old app's export panel gave you.", "err");
      return;
    }

    btn.disabled = true;
    setStatus(importStatus, "Importing…", "");
    var log = [];
    try {
      if (data.incomeSources && data.incomeSources.length) {
        log.push(await upsertAll("income_sources", data.incomeSources.map(incomeSourceToRow)));
      }
      if (data.creditCards && data.creditCards.length) {
        log.push(await upsertAll("credit_cards", data.creditCards.map(creditCardToRow)));
      }
      if (data.recurringExpenses && data.recurringExpenses.length) {
        log.push(await upsertAll("recurring_expenses", data.recurringExpenses.map(recurringToRow)));
      }
      if (data.transactions && data.transactions.length) {
        log.push(await upsertAll("transactions", data.transactions.map(txToRow)));
      }
      if (data.plannedExpenses && data.plannedExpenses.length) {
        log.push(await upsertAll("planned_expenses", data.plannedExpenses.map(plannedToRow)));
      }
      if (data.cardBalances && data.cardBalances.length) {
        log.push(await upsertAll("card_balances", data.cardBalances.map(balanceToRow)));
      }
      if (typeof data.currency === "string" || typeof data.income === "number") {
        var settingsRes = await sb.from("settings").upsert({
          user_id: currentUserId,
          currency: typeof data.currency === "string" ? data.currency : undefined,
          income: typeof data.income === "number" ? data.income : undefined
        }, { onConflict: "user_id" });
        if (settingsRes.error) throw new Error("settings: " + settingsRes.error.message);
        log.push({ table: "settings", count: 1 });
      }

      var summary = log.map(function (l) { return l.table + ": " + l.count; }).join("\n");
      setStatus(importStatus, "Import complete.\n" + (summary || "Nothing to import — the pasted JSON had no data."), "ok");
    } catch (err) {
      setStatus(importStatus, "Import failed: " + err.message, "err");
    } finally {
      btn.disabled = false;
    }
  });
})();
