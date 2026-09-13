import { test, expect, gbp, waitForSync } from "./fixtures.js";

test.describe("planned purchases", () => {
  test.beforeEach(async ({ signIn }) => {
    await signIn();
  });

  test("lists the seeded items and shows whether they fit this period's leftover", async ({ page }) => {
    const toggle = page.locator("#planned-toggle");
    await expect(toggle).toHaveText("Show 2 items");
    // 900 (laptop) + 250 (trip) = 1150, which is within September's 2,411.71
    // leftover (see tests/e2e/home.spec.js for that derivation).
    await expect(page.locator("#planned-summary")).toContainText(gbp(1150) + " planned");
    await expect(page.locator("#planned-summary")).toContainText("fits within this period's " + gbp(2411.71) + " leftover");

    await toggle.click();
    const rows = page.locator("#planned-list .planned-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: "New laptop" })).toContainText(gbp(900));
    await expect(rows.filter({ hasText: "Weekend trip" })).toContainText(gbp(250));
  });

  test("removing a planned item deletes it permanently (tested on a throwaway item)", async ({ page }) => {
    await page.fill("#p-name", "E2E temp planned");
    await page.fill("#p-amount", "40");
    await page.selectOption("#p-category", "other");
    await page.click("#planned-form button[type=submit]");

    await expect(page.locator("#planned-toggle")).toHaveText("Show 3 items");
    await page.click("#planned-toggle"); // rows are hidden until expanded
    const row = page.locator(".planned-row", { hasText: "E2E temp planned" });
    await expect(row).toBeVisible();

    const removeBtn = row.locator(".ledger-del");
    await removeBtn.click();
    await expect(removeBtn).toHaveText("Sure?");
    await removeBtn.click();

    await expect(page.locator(".planned-row", { hasText: "E2E temp planned" })).toHaveCount(0);
    // Still "Hide" not "Show": the toggle click earlier in this test expanded
    // the list, and removing an item doesn't collapse it back.
    await expect(page.locator("#planned-toggle")).toHaveText("Hide 2 items");
    await waitForSync(page);
  });

  test("marking an item as bought converts it into a ledger transaction", async ({ page }) => {
    await page.fill("#p-name", "E2E temp bought item");
    await page.fill("#p-amount", "17.50");
    await page.selectOption("#p-category", "other");
    await page.click("#planned-form button[type=submit]");
    await page.click("#planned-toggle"); // rows are hidden until expanded

    const row = page.locator(".planned-row", { hasText: "E2E temp bought item" });
    await row.locator(".btn-bought").click();

    await expect(page.locator(".planned-row", { hasText: "E2E temp bought item" })).toHaveCount(0);

    // Clean up the transaction markPlannedBought() created, so the ledger
    // count in tests/e2e/home.spec.js stays exactly 9 for every run.
    const ledgerRow = page.locator(".ledger-row", { hasText: "E2E temp bought item" });
    await expect(ledgerRow).toContainText(gbp(17.5));
    const del = ledgerRow.locator(".ledger-del");
    await del.click();
    await del.click();
    await expect(page.locator(".ledger-row", { hasText: "E2E temp bought item" })).toHaveCount(0);
    await waitForSync(page);
  });
});
