import { test, expect } from "./fixtures.js";

test.describe("side nav and profile", () => {
  test.beforeEach(async ({ signIn }) => {
    await signIn();
  });

  test("navigates between Home and Savings via the side nav", async ({ page }) => {
    await page.click("#nav-toggle");
    await expect(page.locator("#side-nav")).toHaveClass(/open/);
    await page.click("#nav-savings");
    await expect(page.locator("#view-savings")).toBeVisible();
    await expect(page.locator("#view-home")).toBeHidden();

    await page.click("#nav-toggle");
    await page.click("#nav-home");
    await expect(page.locator("#view-home")).toBeVisible();
    await expect(page.locator("#view-savings")).toBeHidden();
  });

  test("profile modal shows the signed-in account's email", async ({ page }) => {
    await page.click("#nav-toggle");
    await page.click("#nav-profile");
    await expect(page.locator("#profile-modal")).toBeVisible();
    await expect(page.locator("#profile-email")).toHaveText(process.env.TEST_USER_EMAIL);
    await page.click("#profile-close");
    await expect(page.locator("#profile-modal")).toBeHidden();
  });

  test("signing out returns to the auth screen", async ({ page }) => {
    await page.click("#nav-toggle");
    await page.click("#nav-profile");
    await page.click("#profile-signout-btn");
    await expect(page.locator("#auth-screen")).toBeVisible({ timeout: 15000 });
    await expect(page.locator("#app")).toBeHidden();
  });
});

test.describe("export panel", () => {
  test.beforeEach(async ({ signIn }) => {
    await signIn();
  });

  test("populates the export textarea with the current state as JSON", async ({ page }) => {
    await page.locator("#export-panel summary").click();
    await page.click("#export-select-btn");
    const value = await page.inputValue("#export-textarea");
    const parsed = JSON.parse(value);
    expect(parsed).toHaveProperty("transactions");
    expect(Array.isArray(parsed.transactions)).toBe(true);
    expect(parsed.transactions.length).toBeGreaterThan(0);
  });
});

test.describe("standalone pages load cleanly", () => {
  // Not signing in on either page — this only checks they render without
  // throwing, per docs/REFACTOR_PLAN.md §0.5. import.html's own sign-in flow
  // and reset-password.html's recovery-token flow aren't exercised here: the
  // former would need a second live session against the test account mid
  // test-run, and the latter needs a real recovery link from an email, which
  // no test account here is set up to receive. Console/page-error checking
  // is automatic — see the `page` fixture in tests/e2e/fixtures.js.
  test("import.html renders its sign-in form", async ({ page }) => {
    await page.goto("/import.html");
    await expect(page.locator("h1")).toHaveText("Passbook — Import data");
    await expect(page.locator("#signin-btn")).toBeVisible();
  });

  test("reset-password.html renders without a recovery token", async ({ page }) => {
    await page.goto("/reset-password.html");
    await expect(page).toHaveTitle("Passbook — Reset password");
  });
});
