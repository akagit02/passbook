import { test, expect, gbp } from "./fixtures.js";

// Characterization tests for the Home view, run against the CURRENT
// (pre-refactor) app and the fixed dataset in supabase/test-seed.sql, at the
// fixed clock 2026-09-20 (tests/e2e/fixtures.js). Every number here is
// hand-derived in test-seed.sql's comments — see there before changing
// either file. These must pass unmodified on main before Phase 1 of
// docs/REFACTOR_PLAN.md starts, and again after every phase.

test.describe("auth", () => {
  test("shows the auth screen when signed out, and signs in", async ({ page, signIn }) => {
    await signIn();
    await expect(page.locator("#auth-screen")).toBeHidden();
    await expect(page.locator("#app")).toBeVisible();
  });
});

test.describe("home stats", () => {
  test.beforeEach(async ({ signIn }) => {
    await signIn();
  });

  test("shows the pay-cycle period label for September 2026", async ({ page }) => {
    // cycleStartDay() = 1 (both seeded income sources' pay days are 1 and
    // 15), so periods line up with calendar months.
    await expect(page.locator("#month-label")).toHaveText("1 Sep – 30 Sep 2026");
    await expect(page.locator("#prev-month")).toBeVisible();
    await expect(page.locator("#range-clear")).toBeHidden();
  });

  test("renders the five stat tiles with the seeded September totals", async ({ page }) => {
    const tiles = page.locator("#stats .stat-tile");
    await expect(tiles).toHaveCount(5);

    await expect(tiles.nth(0)).toContainText("Monthly income");
    await expect(tiles.nth(0)).toContainText(gbp(3000));

    await expect(tiles.nth(1)).toContainText("Spent this period");
    await expect(tiles.nth(1)).toContainText(gbp(297.79));
    await expect(tiles.nth(1)).toContainText("8 expenses");

    await expect(tiles.nth(2)).toContainText("Put aside");
    await expect(tiles.nth(2)).toContainText(gbp(200));
    await expect(tiles.nth(2)).toContainText("1 transfer");

    await expect(tiles.nth(3)).toContainText("Left over");
    await expect(tiles.nth(3)).toContainText(gbp(2411.71));
    await expect(tiles.nth(3)).toContainText("under budget");
    await expect(tiles.nth(3)).toContainText(gbp(205.5) + " due on cards");
    await expect(tiles.nth(3)).toContainText(gbp(200) + " put aside");

    await expect(tiles.nth(4)).toContainText("Savings rate");
    await expect(tiles.nth(4)).toContainText("7%");
  });

  test("income tile is editable in place", async ({ page }) => {
    await page.click("#income-tile");
    await expect(page.locator("#income-input")).toBeVisible();
    await page.click("#income-cancel");
    await expect(page.locator("#income-input")).toBeHidden();
    await expect(page.locator("#stats .stat-tile").first()).toContainText(gbp(3000));
  });
});

test.describe("ledger", () => {
  test.beforeEach(async ({ signIn }) => {
    await signIn();
  });

  test("shows entry count and collapses to the first 3 rows", async ({ page }) => {
    await expect(page.locator("#ledger-count")).toHaveText("9 entries");

    const visibleRows = page.locator("#ledger-list .ledger-row:visible");
    await expect(visibleRows).toHaveCount(3);

    // Sorted newest-first: 09-18 health, 09-14 entertainment, 09-12 bills.
    await expect(visibleRows.nth(0)).toContainText(gbp(15));
    await expect(visibleRows.nth(0)).toContainText("Health");
    await expect(visibleRows.nth(0)).toContainText("Pharmacy");

    const toggle = page.locator("#ledger-toggle");
    await expect(toggle).toHaveText("Show 6 more entries");
    await toggle.click();
    await expect(page.locator("#ledger-list .ledger-row:visible")).toHaveCount(9);
    await expect(toggle).toHaveText("Show less");
  });

  test("shows a plain payment-method badge on a cash row and a settlement tooltip on a card row", async ({ page }) => {
    await page.click("#ledger-toggle"); // expand to see every row
    const healthRow = page.locator(".ledger-row", { hasText: "Pharmacy" });
    await expect(healthRow.locator(".pm-badge")).toHaveText("cur acc");
    await expect(healthRow.locator(".pm-badge")).not.toHaveAttribute("title", /.+/);

    const cardRow = page.locator(".ledger-row", { hasText: "New shoes" });
    await expect(cardRow.locator(".pm-badge")).toHaveText("PCC");
    await expect(cardRow.locator(".pm-badge")).toHaveAttribute("title", /statement.*due/);
  });

  test("adds and deletes a transaction without disturbing the seeded ones", async ({ page }) => {
    await page.selectOption("#f-category", "other");
    await page.fill("#f-amount", "12.34");
    await page.fill("#f-note", "E2E temp expense");
    await page.click("#add-form button[type=submit]");

    await expect(page.locator("#ledger-count")).toHaveText("10 entries");
    const row = page.locator(".ledger-row", { hasText: "E2E temp expense" });
    await expect(row).toBeVisible();
    await expect(row).toContainText(gbp(12.34));

    const del = row.locator(".ledger-del");
    await del.click();
    await expect(del).toHaveText("Sure?");
    await del.click();

    await expect(page.locator(".ledger-row", { hasText: "E2E temp expense" })).toHaveCount(0);
    await expect(page.locator("#ledger-count")).toHaveText("9 entries");
  });
});

test.describe("breakdown", () => {
  test.beforeEach(async ({ signIn }) => {
    await signIn();
  });

  test("groups September spending into 7 categories, Shopping highest", async ({ page }) => {
    const toggle = page.locator("#breakdown-toggle");
    await expect(toggle).toHaveText("Show 7 categories");
    await toggle.click();

    const rows = page.locator(".breakdown-rows .breakdown-row");
    await expect(rows).toHaveCount(7);
    await expect(rows.first()).toContainText("Shopping");
    await expect(rows.first()).toContainText(gbp(75));
  });
});

test.describe("spending patterns", () => {
  test.beforeEach(async ({ signIn }) => {
    await signIn();
  });

  test("category count changes with the time window", async ({ page }) => {
    const toggle = page.locator("#patterns-toggle");
    await expect(toggle).toHaveText("Show 10 categories"); // default window = 6 months

    await page.selectOption("#patterns-window", "3");
    await expect(toggle).toHaveText("Show 8 categories"); // May's insurance & June's "other" fall outside 3 months

    await page.selectOption("#patterns-window", "12");
    await expect(toggle).toHaveText("Show 10 categories");

    await page.selectOption("#patterns-window", "all");
    await expect(toggle).toHaveText("Show 10 categories");
  });

  test("flags groceries as mostly happening on Saturdays over all time", async ({ page }) => {
    await page.selectOption("#patterns-window", "all");
    await page.click("#patterns-toggle");
    const groceriesRow = page.locator(".patterns-rows .breakdown-row", { hasText: "Groceries" });
    await expect(groceriesRow).toContainText("mostly Saturday");
  });
});

test.describe("insights", () => {
  test.beforeEach(async ({ signIn }) => {
    await signIn();
  });

  test("surfaces the top category and a savings-rate nudge", async ({ page }) => {
    const cards = page.locator("#insights .insight-card");
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0)).toHaveText(
      "Shopping is your biggest spend this period at " + gbp(75) + " (25% of total)."
    );
    await expect(cards.nth(1)).toHaveText(
      "Only 7% of income put aside this period, with " + gbp(2411.71) +
      " still unspent — the Savings tab can log a transfer."
    );
  });
});

test.describe("custom date range", () => {
  test.beforeEach(async ({ signIn }) => {
    await signIn();
  });

  test("switches to a manual range and back to the pay cycle", async ({ page }) => {
    await page.click("#range-toggle");
    await page.fill("#range-start", "2026-08-01");
    await page.fill("#range-end", "2026-08-31");
    await page.click("#range-form button[type=submit]");

    await expect(page.locator("#month-label")).toHaveText("1 Aug – 31 Aug 2026");
    await expect(page.locator("#prev-month")).toBeHidden();
    await expect(page.locator("#range-clear")).toBeVisible();

    const tiles = page.locator("#stats .stat-tile");
    await expect(tiles.nth(1)).toContainText(gbp(350));
    await expect(tiles.nth(1)).toContainText("11 expenses");
    await expect(tiles.nth(2)).toContainText(gbp(150));
    await expect(tiles.nth(3)).toContainText(gbp(2590));

    await page.click("#range-clear");
    await expect(page.locator("#month-label")).toHaveText("1 Sep – 30 Sep 2026");
    await expect(page.locator("#prev-month")).toBeVisible();
  });
});
