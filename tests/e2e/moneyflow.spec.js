import { test, expect, gbp } from "./fixtures.js";

// Read-only: nothing here adds or deletes a row. September's pinned figures
// are the ones derived in supabase/test-seed.sql (spent £297.79 across 8
// expenses, £200 put aside, income £3,000).
test.describe("financial health — where money goes", () => {
  test.beforeEach(async ({ page, signIn }) => {
    await signIn();
    await page.click("#nav-toggle");
    await page.click("#nav-health");
    await expect(page.locator("#view-health")).toBeVisible();
  });

  test("the pie lives on its own tab and stays hidden until that tab is opened", async ({ page }) => {
    await expect(page.locator("#health-panel-check")).toBeVisible();
    await expect(page.locator("#health-panel-flow")).toBeHidden();

    await page.click("#health-tab-flow");
    await expect(page.locator("#health-panel-flow")).toBeVisible();
    await expect(page.locator("#health-panel-check")).toBeHidden();
    await expect(page.locator("#flow-chart svg .flow-slice")).toHaveCount(3);

    await page.click("#health-tab-check");
    await expect(page.locator("#health-rows .health-row")).toHaveCount(6);
  });

  test("drills from income down to a category and the card that paid", async ({ page }) => {
    await page.click("#health-tab-flow");
    await expect(page.locator("#flow-range-label")).toContainText("1 Sept – 30 Sept 2026");

    const rows = page.locator("#flow-legend .flow-row");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText("Not spent or saved");
    await expect(rows.nth(0)).toContainText(gbp(2502.21));
    await expect(page.locator('.flow-row[data-key="spending"]')).toContainText(gbp(297.79));
    await expect(page.locator('.flow-row[data-key="savings"]')).toContainText(gbp(200));
    await expect(page.locator("#flow-figures")).toContainText("7% of income");

    await page.click('.flow-row[data-key="spending"]');
    await expect(page.locator("#flow-view")).toHaveValue("category");
    await expect(page.locator("#flow-title")).toContainText("Spending by category");
    await expect(rows.nth(0)).toContainText("Shopping");
    await expect(rows.nth(0)).toContainText(gbp(75));

    await page.click('.flow-row[data-key="shopping"]');
    await expect(page.locator("#flow-category")).toHaveValue("shopping");
    await expect(page.locator("#flow-title")).toContainText("Shopping by card or account");
    await expect(rows).toHaveCount(1);
    await expect(rows.nth(0)).toContainText("PCC");

    await page.click("#flow-up");
    await page.click("#flow-up");
    await expect(page.locator("#flow-view")).toHaveValue("overview");
    await expect(page.locator("#flow-up")).toBeHidden();
  });

  test("filters by payment method and by custom dates", async ({ page }) => {
    await page.click("#health-tab-flow");
    await page.selectOption("#flow-view", "category");
    await page.selectOption("#flow-payment", "RCC");
    const rows = page.locator("#flow-legend .flow-row");
    await expect(rows).toHaveCount(1);
    await expect(rows.nth(0)).toContainText("Entertainment");
    await expect(rows.nth(0)).toContainText(gbp(40));

    await page.selectOption("#flow-payment", "");
    await page.click('.flow-range-btn[data-range="custom"]');
    await page.fill("#flow-from", "2026-09-01");
    await page.fill("#flow-to", "2026-09-05");
    await page.locator("#flow-to").dispatchEvent("change");
    // 1–5 Sept: shopping 75.00, groceries 45.30, transport 30.00, subscription 9.99.
    await expect(page.locator("#flow-title")).toContainText(gbp(160.29));
    await expect(rows).toHaveCount(4);
  });
});
