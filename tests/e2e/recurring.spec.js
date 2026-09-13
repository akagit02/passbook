import { test, expect, gbp } from "./fixtures.js";

test.describe("recurring payments", () => {
  test.beforeEach(async ({ signIn }) => {
    await signIn();
  });

  test("lists the three seeded rules with the installment's paid-so-far progress", async ({ page }) => {
    await expect(page.locator("#recurring-summary")).toHaveText(gbp(99.99) + "/mo across 3 payments");
    const toggle = page.locator("#recurring-list-toggle");
    await expect(toggle).toHaveText("Show 3 payments");
    await toggle.click();

    const rows = page.locator("#recurring-list .recurring-row");
    await expect(rows).toHaveCount(3);

    const installmentRow = rows.filter({ hasText: "Test Sofa Installment" });
    await expect(installmentRow).toContainText(gbp(40));
    await expect(installmentRow).toContainText(gbp(40) + " of " + gbp(200) + " paid");
    await expect(installmentRow).not.toContainText("done");
    await expect(installmentRow).toContainText("24th");
  });

  test("on sign-in, backfills the missing rule's overdue August occurrence exactly once", async ({ page }) => {
    // test_missing_rent (day 25, seeded with zero occurrences) must have
    // generated its 2026-08-25 row by the time the app finishes loading —
    // generateRecurringTransactions() runs inside showApp(), before the
    // first render. Its September occurrence (25th) is still in the future
    // relative to the fixed clock (2026-09-20), so exactly one row exists,
    // dated in August — it must not appear in September's ledger/stats.
    await expect(page.locator("#ledger-count")).toHaveText("9 entries"); // unchanged from home.spec.js

    await page.click("#range-toggle");
    await page.fill("#range-start", "2026-08-01");
    await page.fill("#range-end", "2026-08-31");
    await page.click("#range-form button[type=submit]");
    await expect(page.locator(".ledger-row", { hasText: "Test Recurring (auto-generates on load)" })).toHaveCount(1);
    await page.click("#range-clear");
  });

  test("adding a future-dated rule doesn't touch this period, and removing it cleans up fully", async ({ page }) => {
    await page.fill("#rec-label", "E2E temp recurring");
    await page.fill("#rec-amount", "5");
    await page.fill("#rec-day", "10");
    await page.selectOption("#rec-category", "other");
    // A start month after the current one guarantees generateRecurringTransactions()
    // creates nothing immediately (see docs comment in supabase/test-seed.sql
    // on why every other day-of-month value generates something on add) —
    // keeping this test a clean add/remove with no spawned ledger row to
    // separately clean up.
    await page.fill("#rec-starts", "2026-10");
    await page.click("#recurring-add-form button[type=submit]");

    await expect(page.locator("#recurring-list-toggle")).toHaveText("Show 4 payments");
    await expect(page.locator("#recurring-summary")).toHaveText(gbp(104.99) + "/mo across 4 payments");
    await expect(page.locator("#ledger-count")).toHaveText("9 entries"); // no spawned transaction

    await page.click("#recurring-edit-toggle");
    const row = page.locator("#recurring-edit-form .edit-row").filter({
      has: page.locator('.edit-label[value="E2E temp recurring"]')
    });
    await row.locator(".edit-remove").click();
    await page.click("#recurring-edit-form button[type=submit]");

    await expect(page.locator("#recurring-list-toggle")).toHaveText("Show 3 payments");
    await expect(page.locator("#recurring-summary")).toHaveText(gbp(99.99) + "/mo across 3 payments");
  });
});
