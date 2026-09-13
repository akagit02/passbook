import { test, expect, gbp } from "./fixtures.js";

// Money calendar + credit card reminders. Event dates below are all derived
// from nextOccurrence()/lastOccurrence() against the fixed clock 2026-09-20
// and the seeded income sources / cards / card_balances — see
// supabase/test-seed.sql.

test.describe("money calendar", () => {
  test.beforeEach(async ({ signIn }) => {
    await signIn();
  });

  test("orders six upcoming events, earliest first, flagging the overdue card payment", async ({ page }) => {
    const rows = page.locator("#calendar-list .cal-row");
    await expect(rows).toHaveCount(6);

    // Test Regular Card's only recorded balance is unpaid and due 2026-09-15
    // — five days before the fixed "today" of 2026-09-20 — so it must sort
    // first and read as overdue.
    const first = rows.first();
    await expect(first).toContainText("Test Regular Card");
    await expect(first).toContainText("payment due");
    await expect(first).toContainText(gbp(85.5));
    await expect(first.locator(".cal-sub")).toHaveClass(/overdue/);
    await expect(first.locator(".cal-sub")).toHaveText("5 days overdue");
    await expect(first.locator(".cal-mark-paid")).toBeVisible();
  });

  test("edit form pre-fills existing income sources and cards, and cancels without saving", async ({ page }) => {
    await page.click("#cal-edit-toggle");
    await expect(page.locator("#calendar-edit-form")).toBeVisible();

    const incomeRows = page.locator('#calendar-edit-form .edit-row[data-kind="income"]');
    await expect(incomeRows).toHaveCount(2);
    await expect(incomeRows.filter({ has: page.locator('.edit-label[value="Test salary"]') })).toHaveCount(1);

    const cardRows = page.locator('#calendar-edit-form .edit-row[data-kind="card"]');
    await expect(cardRows).toHaveCount(2);

    await page.click("#cal-edit-toggle"); // cancel
    await expect(page.locator("#calendar-edit-form")).toBeHidden();
    await expect(page.locator("#calendar-list")).toBeVisible();
    await expect(page.locator("#calendar-list .cal-row")).toHaveCount(6);
  });
});

test.describe("card statement reminders", () => {
  test.beforeEach(async ({ signIn }) => {
    await signIn();
  });

  // Only Test Premium Card has an un-recorded closed statement (10 Sep —
  // Test Regular Card's own August statement is already recorded in
  // card_balances). The suggested amount is derivedStatementAmount(): every
  // PCC-tagged transaction after the prior close (10 Aug) up to and
  // including this one — £60.00 (Aug 15) + £75.00 (Sep 3) = £135.00.
  //
  // This test is deliberately read-only: recordCardBalance() has no
  // corresponding "un-record" action in the app, so clicking Save here would
  // permanently alter the seeded dataset for every future test run. If a
  // delete/admin path for card_balances is ever added, promote this to a
  // full add-then-remove round trip like the ledger/savings tests.
  test("shows one pending reminder with a derived suggested amount", async ({ page }) => {
    const banner = page.locator("#card-reminder-banner");
    await expect(banner).toBeVisible();
    const rows = banner.locator(".card-reminder-row");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Test Premium Card");
    await expect(rows.first()).toContainText("10 Sep");
    await expect(rows.first().locator(".card-reminder-input")).toHaveValue("135.00");
    await expect(rows.first()).toContainText(gbp(135));
  });
});
