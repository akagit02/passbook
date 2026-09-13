import { test, expect, gbp } from "./fixtures.js";

// Characterization tests for the Savings view. Figures are derived in the
// comments of supabase/test-seed.sql and re-derived (goal pacing, ISA totals,
// holdings split) in the PR/commit that added this file — see git history
// if these ever need re-checking by hand.

async function goToSavings(page) {
  await page.click("#nav-toggle");
  await page.click("#nav-savings");
  await expect(page.locator("#view-savings")).toBeVisible();
}

test.describe("savings stats", () => {
  test.beforeEach(async ({ page, signIn }) => {
    await signIn();
    await goToSavings(page);
  });

  test("renders the five savings stat tiles", async ({ page }) => {
    const tiles = page.locator("#savings-stats .stat-tile");
    await expect(tiles).toHaveCount(5);

    await expect(tiles.nth(0)).toContainText("Put aside all time");
    await expect(tiles.nth(0)).toContainText(gbp(550));
    await expect(tiles.nth(0)).toContainText("4 contributions");

    await expect(tiles.nth(1)).toContainText("This tax year");
    await expect(tiles.nth(1)).toContainText(gbp(550));
    await expect(tiles.nth(1)).toContainText("2026/27");

    await expect(tiles.nth(2)).toContainText("This month");
    await expect(tiles.nth(2)).toContainText(gbp(200));

    await expect(tiles.nth(3)).toContainText("Typical month");
    await expect(tiles.nth(3)).toContainText(gbp(50));

    await expect(tiles.nth(4)).toContainText("Goals on track");
    await expect(tiles.nth(4)).toContainText("0 / 1");
  });

  test("ISA allowance shows this tax year's usage", async ({ page }) => {
    const el = page.locator("#isa-allowance");
    await expect(page.locator("#isa-year-label")).toHaveText("2026/27");
    await expect(el).toContainText(gbp(350));
    await expect(el).toContainText("of " + gbp(20000));
    await expect(el.locator(".isa-note")).toContainText(gbp(19650) + " of allowance left");
    await expect(el.locator(".isa-note")).toContainText(/\d+ days to use it/);
  });

  test("holdings are split by vehicle and summarised by risk tier", async ({ page }) => {
    const rows = page.locator("#savings-holdings .holding-row");
    await expect(rows).toHaveCount(3); // cash_isa, premium_bonds, stocks_general
    await expect(rows.first()).toContainText("Cash ISA");
    await expect(rows.first()).toContainText(gbp(350));
    await expect(page.locator("#savings-holdings .isa-note")).toHaveText("Lower risk 82% · Growth / market risk 18%");
  });
});

test.describe("savings goals", () => {
  test.beforeEach(async ({ page, signIn }) => {
    await signIn();
    await goToSavings(page);
  });

  test("shows pacing for the seeded goal", async ({ page }) => {
    const row = page.locator(".goal-row", { hasText: "Test Emergency Fund" });
    await expect(row).toContainText("Short term");
    await expect(row).toContainText(gbp(350) + " / " + gbp(1000));
    await expect(row).toContainText("Jan 2027");
    await expect(row).toContainText("3 months left");
    await expect(row).toContainText("needs " + gbp(192.59) + "/mo");
    await expect(row.locator(".goal-verdict")).toHaveText("Behind by " + gbp(192.59) + "/mo");
  });
});

test.describe("savings log", () => {
  test.beforeEach(async ({ page, signIn }) => {
    await signIn();
    await goToSavings(page);
  });

  test("filtering by destination narrows the log to that vehicle", async ({ page }) => {
    await expect(page.locator("#savings-log .savings-row")).toHaveCount(4);
    await page.selectOption("#savings-filter-vehicle", "cash_isa");
    await expect(page.locator("#savings-log .savings-row")).toHaveCount(2);
    await page.selectOption("#savings-filter-vehicle", "all");
    await expect(page.locator("#savings-log .savings-row")).toHaveCount(4);
  });

  test("adds and deletes a contribution, restoring the seeded totals", async ({ page }) => {
    await page.fill("#s-amount", "75");
    await page.selectOption("#s-vehicle", "other");
    await page.fill("#s-note", "E2E temp contribution");
    await page.click("#savings-form button[type=submit]");

    await expect(page.locator("#savings-log .savings-row")).toHaveCount(5);
    await expect(page.locator("#savings-stats .stat-tile").first()).toContainText(gbp(625)); // 550 + 75

    const row = page.locator(".savings-row", { hasText: "E2E temp contribution" });
    const del = row.locator(".savings-del");
    await del.click();
    await expect(del).toHaveText("Sure?");
    await del.click();

    await expect(page.locator("#savings-log .savings-row")).toHaveCount(4);
    await expect(page.locator("#savings-stats .stat-tile").first()).toContainText(gbp(550));

    // The paired transactions-table row must be gone too, or "Spent this
    // period" / "Put aside" on Home would silently drift from the Savings
    // tab (see TECH_DEBT.md's note on the two-insert contribution write).
    await page.click("#nav-toggle");
    await page.click("#nav-home");
    await expect(page.locator(".ledger-row", { hasText: "E2E temp contribution" })).toHaveCount(0);
  });
});

test.describe("cut analysis and allocation advice", () => {
  test.beforeEach(async ({ page, signIn }) => {
    await signIn();
    await goToSavings(page);
  });

  // cutCandidates() bases each suggestion on the MEDIAN of the last 6
  // complete months (March-August) per discretionary category, and drops
  // anything whose median is 0 (see the TRIM_FRACTION >= 5 filter in
  // app.js). The seed data's discretionary spend (eating_out, shopping,
  // entertainment) is real but sparse — nonzero in only 2 of those 6 months
  // per category — so every median lands at 0 and the panel is correctly
  // empty. This pins that "sparse history but not literally zero" is still
  // treated as "not enough to suggest a cut", which is itself worth locking
  // down: it's an easy off-by-one to break in a naive rewrite (e.g. using
  // the mean, or a 3-month window, would silently start showing cards here).
  test("cut analysis stays empty when discretionary spend is too sparse to median above zero", async ({ page }) => {
    await expect(page.locator("#cut-headline")).toHaveText("");
    await expect(page.locator("#savings-cuts")).toContainText(
      "Once there are a few complete months of expenses logged, this works out where there is realistically room to trim."
    );
  });

  test("allocation advice renders without error once a savings rate exists", async ({ page }) => {
    await expect(page.locator("#savings-allocation")).not.toBeEmpty();
  });
});
