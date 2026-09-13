import { test as base, expect } from "@playwright/test";

// Every hand-computed number in these tests (see supabase/test-seed.sql) is
// pinned against "now" = this instant. Change it and every such number needs
// re-deriving, not just the clock.
export const FIXED_NOW = "2026-09-20T09:00:00";

// Extends Playwright's `test` with:
//  - a fixed clock, set before any app script runs (so `new Date()` inside
//    app.js sees FIXED_NOW from the very first render)
//  - automatic console/page-error capture, asserted empty in a fixture
//    teardown — matches docs/REFACTOR_PLAN.md §0.5's "every test also fails
//    on any console.error or CSP violation" requirement. A CSP violation
//    surfaces as a `console.error` ("Refused to ... because it violates the
//    following Content Security Policy directive...."), so this one check
//    covers both.
//  - `signIn`, a helper that gets past the auth screen using the seeded test
//    account (TEST_USER_EMAIL / TEST_USER_PASSWORD), and waits for the Home
//    view to actually be visible before handing back control.
export const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    page.on("pageerror", (err) => {
      errors.push(String(err));
    });

    await page.clock.install({ time: new Date(FIXED_NOW) });

    await use(page);

    expect(errors, "no console errors or CSP violations during this test").toEqual([]);
  },

  signIn: async ({ page }, use) => {
    const email = process.env.TEST_USER_EMAIL;
    const password = process.env.TEST_USER_PASSWORD;
    if (!email || !password) {
      throw new Error("TEST_USER_EMAIL / TEST_USER_PASSWORD must be set (see tests/e2e/global-setup.js).");
    }

    async function signIn() {
      await page.goto("/index.html");
      await expect(page.locator("#auth-screen")).toBeVisible();
      await page.fill("#auth-email", email);
      await page.fill("#auth-password", password);
      await page.click("#auth-submit");
      await expect(page.locator("#app")).toBeVisible({ timeout: 15000 });
      await expect(page.locator("#view-home")).toBeVisible();
      // renderStats() etc. run synchronously once #app is shown, but give
      // the income tile a moment in case a slow network delays loadAll().
      await expect(page.locator("#stats .stat-tile").first()).toBeVisible();
    }

    await use(signIn);
  }
});

export { expect };

// dbCall() in app.js fires every Supabase write in the background without
// the caller awaiting it (see app.js's own comment above dbCall — the UI
// updates optimistically first, this is fire-and-forget on top). Two
// concrete ways that bites an E2E test:
//  - Playwright tears the page down at the end of a test; if a write is
//    still in flight when that happens, the fetch is cancelled before it
//    reaches Supabase, silently, with no console error. A cleanup delete
//    that "passed" (the local UI showed 0) can still leave the row in the
//    shared test account for the next test/run to trip over.
//  - Two of a single action's OWN writes can race each other: e.g. adding a
//    savings contribution does insert-transaction-THEN-insert-contribution;
//    deleting it immediately afterwards fires its own two deletes right
//    away, and if the delete of the transaction lands before the add's own
//    contribution insert does, that insert 409s on the foreign key.
// Call this after any action whose write must actually land before the next
// step (usually: a test's final cleanup, or immediately after an add whose
// own multi-step write you're about to un-do).
export async function waitForSync(page) {
  await page.waitForTimeout(800);
}

// Money strings as fmtMoney() (Intl.NumberFormat en-GB/GBP) renders them —
// centralised so a test failure shows "expected '£297.79'" rather than a
// hand-typed literal that might not match the app's own formatting quirks
// (e.g. non-breaking space between symbol and digits on some platforms).
export function gbp(n) {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(n);
}
