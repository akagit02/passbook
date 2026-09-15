import { test, expect, gbp } from "./fixtures.js";

// Debts tracked outside the ledger (src/debts) — the "Debt" side-nav view.
// Logging a payment here must never create a ledger transaction or move the
// Home leftover figure, since this money was deducted before it ever reached
// the user's own account.

async function goToDebt(page) {
  await page.click("#nav-toggle");
  await page.click("#nav-debt");
  await expect(page.locator("#view-debt")).toBeVisible();
}

test.describe("debts", () => {
  test.beforeEach(async ({ page, signIn }) => {
    await signIn();
    await goToDebt(page);
  });

  test("adding a debt with a starting balance and logging a payment updates the remaining balance", async ({ page }) => {
    await page.fill("#d-label", "E2E temp visa loan");
    await page.fill("#d-original", "4400");
    await page.fill("#d-starting", "2600");
    await page.click("#debt-form button[type=submit]");

    const card = page.locator(".debt-card", { hasText: "E2E temp visa loan" });
    await expect(card).toBeVisible();
    await expect(card).toContainText(gbp(1800) + " left");
    await expect(card).toContainText("of " + gbp(4400));

    await card.locator(".debt-payment-amount").fill("100");
    await card.locator(".debt-payment-form button[type=submit]").click();
    await expect(card).toContainText(gbp(1700) + " left");
    await expect(card.locator(".debt-payment-row")).toHaveCount(1);

    // Never touches the ledger or leftover.
    await page.click("#nav-toggle");
    await page.click("#nav-home");
    await expect(page.locator("#view-home")).toBeVisible();
    await expect(page.locator(".ledger-row", { hasText: "E2E temp visa loan" })).toHaveCount(0);

    // Clean up.
    await goToDebt(page);
    const removeBtn = card.locator(".debt-del");
    await removeBtn.click();
    await removeBtn.click();
    await expect(page.locator(".debt-card", { hasText: "E2E temp visa loan" })).toHaveCount(0);
  });

  test("a finance agreement in Recurring payments shows up under Linked to your ledger", async ({ page }) => {
    // The seeded "Test Sofa Installment" recurring rule (installment_total
    // 200, see supabase/test-seed.sql) should surface here read-only.
    const linked = page.locator("#debt-linked-list .debt-card", { hasText: "Test Sofa Installment" });
    await expect(linked).toBeVisible();
    await expect(linked).toContainText("of " + gbp(200));
  });
});
