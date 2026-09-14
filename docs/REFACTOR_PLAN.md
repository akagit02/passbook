# Passbook — De-monolith refactor plan

**Written:** 2026-09-13 · **For:** the model executing the refactor · **Owner:** repo owner (approves every gate)

## 0. Read this first — hard rules

1. **All work happens on the branch `refactor/modular-architecture`.** Never commit to or push `main`. Never merge. The owner merges after sign-off (§9).
2. **Never write to the production Supabase project** (`bvqhlmfacjhgbkwafjgq`). The owner's "test login" is the *same* account as production — any write made while testing against prod is a real change to their finances. All manual and automated testing runs against a separate **test** Supabase project (§2). If the test project isn't set up yet, stop and ask; do not "just quickly check" against prod.
3. **$0 budget.** Only free tiers: Vercel Hobby, Supabase Free, GitHub (Actions free minutes), npm dev dependencies. Do not introduce anything that needs a paid plan, a credit card, or an always-on server. If a step seems to need one, stop and ask.
4. **Behaviour must not change** during Phases 1–4. This is a structural move. Bug fixes and features are out of scope unless listed in Phase 5. If you find a bug, add it to `TECH_DEBT.md` and keep going.
5. **Stop at every GATE** and report to the owner: what changed, test results, anything surprising. Wait for a go-ahead before the next phase.
6. `supabase/schema.sql` and `supabase/seed-my-data.sql` had **uncommitted changes on `main`** when this plan was written (seed file may contain the owner's real user id). Do not commit, stash, or discard them — ask the owner what to do with them before branching.
7. Small commits, one concern each, every commit leaves the app working. Commit messages follow the existing style (imperative, "why"-focused).

## 1. Where we are, and where we're going

### Today
- `app.js`: ~2,835 lines, one IIFE, everything private. Constants, date math, pay-cycle logic, card settlement, recurring generation, patterns, savings maths, DOM rendering, event wiring, Supabase queries, row mappers, auth and boot all share closure variables (`state`, `sb`, `currentUserId`, `viewMonth`, `customRange`, a dozen `*Expanded` / `editing*` flags).
- `index.html`: ~1,320 lines including inline CSS. Loads supabase-js UMD from jsDelivr, then `config.js`, then `app.js`.
- `import.html/js`, `reset-password.html/js`: small standalone pages, own copies of client setup.
- No build step, no `package.json`, no tests. Vercel serves the folder statically. CSP in `vercel.json` (`script-src 'self' https://cdn.jsdelivr.net`, `connect-src` = prod Supabase only).
- `config.js` hardcodes prod URL + anon key, so every Vercel preview deploy also talks to prod.

### Target: a modular monolith with service-shaped boundaries
True microservices (separately deployed services, each with its own database) are the wrong move here: on free tiers they add cold starts, cross-service auth, and quota burn for no benefit to a single user. What *does* carry forward to an enterprise app is **clean domain boundaries**: each domain owns its data access, its pure logic, and its UI, and talks to others only through an explicit interface. Any one of them can later be lifted into a Supabase Edge Function / Postgres function / Vercel function without rewriting the others. Phase 5 does exactly that for the pieces that genuinely belong on the server.

Layers (dependencies point downward only):

```
features/*   UI: render + wire events for one screen area   (may import: state, domain, data, lib)
state/       single store, subscribe/notify                  (may import: lib)
data/        Supabase access: repositories + row mappers     (may import: lib, config)
domain/      PURE business logic — no DOM, no Supabase, no   (may import: lib only)
             Date.now(); "now" and state passed in
lib/         formatting, dates, ids, escaping                (imports nothing)
config/      environment config
```

Domains: **ledger** (transactions), **cashflow** (periods, leftover), **cards** (credit cards, statements, balances), **recurring** (direct debits, installments, generation), **planned** (planned purchases), **insights** (breakdown, patterns, insights), **savings** (contributions, goals, ISA, cut/allocation advice), **settings/income**, **auth**.

Target layout:

```
index.html  import.html  reset-password.html
css/app.css                      (extracted from index.html <style>)
config.js                        (generated at build — see §2; not hand-edited)
src/
  main.js                        boot: wire features, auth listener
  config/env.js                  reads window.PASSBOOK_CONFIG, validates it
  lib/  dates.js  format.js  html.js (esc)  ids.js  math.js (median, sum)
  domain/
    categories.js                CATEGORIES, CAT_INDEX, discretionary, SAVINGS_CAT
    periods.js                   cycleStartDay, periodStart/End, currentPeriodKey, labels, custom range
    cashflow.js                  spendingTxs, cycleFinancials, cardDuesInRange
    cards.js                     CARD_ALIASES, cardForPaymentMethod, cardSettlement,
                                 pendingCardReminders, derivedStatementAmount
    recurring.js                 occurrence dates, installments, generateRecurringTransactions
    patterns.js                  computePatternsData and helpers
    insights.js                  breakdown sums, insight text inputs (data, not HTML)
    savings.js                   vehicles, tax year, goalProgress, monthly medians,
                                 cutCandidates, allocation advice data
  data/
    supabase.js                  creates the client once from env
    sync.js                      dbCall + sync-failure banner hook
    mappers.js                   rowTo*/*ToRow (userId passed in, not a closure)
    repos/  settings.js incomeSources.js creditCards.js transactions.js planned.js
            cardBalances.js recurring.js savings.js
    loadAll.js
  state/store.js                 getState/setState/subscribe; UI flags live here too
  features/
    auth/  nav/  stats/  ledger/  breakdown/  patterns/  insights/  calendar/
    cardReminders/  planned/  recurring/  savings/  rangePicker/  export/
tests/
  unit/                          Vitest, one file per domain/lib module
  e2e/                           Playwright against the test Supabase project
supabase/
  schema.sql                     unchanged semantics
  functions.sql                  Phase 5 RPCs
  test-seed.sql                  synthetic data for the test project (no real data)
scripts/build-config.mjs
docs/REFACTOR_PLAN.md            this file
```

Use **native ES modules** (`<script type="module" src="src/main.js">`). No bundler in this refactor: it keeps deploys identical in shape, needs no CSP change for `'self'` scripts, and avoids a second big change. Keep supabase-js as the pinned UMD `<script>` with its SRI hash; `src/data/supabase.js` reads `window.supabase`. (A bundler/TypeScript can be a later, separate project.)

## 2. Phase 0 — Safety net (no app code changes) → GATE 0

Nothing gets moved until this exists, because it's the only way to prove the refactor changed nothing.

**0.1 Branch.** Resolve rule 6 with the owner, then `git switch -c refactor/modular-architecture` from an up-to-date `main`.

**0.2 Test Supabase project (owner does the dashboard steps; you write the SQL and instructions).**
Supabase Free allows two active projects. Owner creates `passbook-test`, runs `supabase/schema.sql` in it, creates a test user (Auto Confirm) and adds redirect URLs for localhost and the Vercel preview domain. You write `supabase/test-seed.sql`: synthetic income sources, two cards matching the `premium`/`regular` aliases, several months of transactions across every category and payment method (including PCC/RCC, savings-category rows with contributions, recurring-generated rows with `recurring_occurrence`, an installment rule, card balances paid and unpaid, a goal). Never copy real data. Note: free projects pause after inactivity — if tests fail with connection errors, ask the owner to resume it.

**0.3 Per-environment config, still $0.**
- Add a minimal `package.json` (private, dev deps only).
- `scripts/build-config.mjs` writes `config.js` from `PASSBOOK_SUPABASE_URL` / `PASSBOOK_SUPABASE_ANON_KEY` env vars, failing loudly if either is missing or if the key's JWT payload role isn't `anon`.
- `vercel.json`: `"buildCommand": "node scripts/build-config.mjs"`, `"outputDirectory": "."` (or equivalent — verify against current Vercel docs; don't guess). Owner sets env vars in Vercel: **Production → prod project**, **Preview → test project**. This is what makes branch preview deploys safe to click around in.
- Add the test project's host to CSP `connect-src`.
- Keep the committed `config.js` pointing at prod until the owner confirms the Vercel env vars work; then it becomes a gitignored generated file with a `config.example.js`. Local dev: `.env.local` (gitignored) → `npm run config` → serve.

**0.4 Tooling.** `vitest`, `@playwright/test`, `eslint` (flat config, browser globals), a static server (`npx serve` or similar). Scripts: `test`, `test:e2e`, `lint`, `serve`, `config`.

**0.5 Characterization E2E tests, written against the *current, unmodified* app.** Playwright, test project, fixed clock (`page.clock.setFixedTime(...)` to a date inside the seeded data so pay cycles and "today" are deterministic). Cover, asserting on visible text/numbers:
- sign in / sign out; auth screen shown when signed out
- Home stats tiles (income, spent, put aside, left over, savings rate) for the seeded period, previous period, and a custom date range
- ledger: rows, count, collapse/expand, PM badge tooltip; add a transaction → totals update → reload → still there; delete with the "Sure?" confirm
- breakdown and patterns (each window: 3/6/12/all), insights text
- money calendar: events and ordering; edit form add/remove income & card; card reminder banner with the derived pre-filled amount; record balance; mark paid
- planned: add, "Bought" (converts to transaction), remove, fits-in-leftover summary
- recurring: list, add, edit, pause; generation of missed occurrences on load (seed a rule whose occurrences are missing)
- savings view: stats tiles, filters, log, holdings, ISA meter, goals incl. slider, cut analysis, allocation advice; add/delete contribution (both rows), add/delete goal
- export panel, side nav, profile modal; `import.html` and `reset-password.html` load without console errors
- every test also fails on any `console.error` or CSP violation

Each test that writes must clean up (or re-run `test-seed.sql` in a global setup via the test user — RLS means the anon key + test login can reset its own rows). Tests must pass on unmodified `main` code before Phase 1 starts. **Record the baseline** (screenshots of Home and Savings at the fixed clock) in `tests/e2e/__baseline__`.

**0.6 CI.** GitHub Actions on push to the branch/PRs: lint + unit tests. E2E in CI only if the owner adds the test project URL/anon key/test credentials as repo secrets; otherwise E2E runs locally and results go in the gate report.

**GATE 0 report:** test project working, preview deploy hitting the test project (verify in the browser network tab, not by assumption), E2E green on unmodified code.

## 3. Phase 1 — Extract `lib/` and `domain/` (pure logic) → GATE 1

Highest value, lowest risk: this is where the money maths lives.

- Switch `index.html` to `type="module"` with a thin `src/main.js` that imports the still-mostly-intact app code (move the IIFE body into `src/legacy-app.js` as a module first; confirm E2E green before anything else).
- Move functions out one domain at a time, in this order: `lib/*` → `categories` → `periods` → `cashflow` → `cards` → `recurring` → `patterns` → `insights` → `savings`.
- Make them pure. Everything that currently reads closure state takes it as arguments:
  - `cycleStartDay(incomeSources)`, `periodStartDate(mk, incomeSources)`
  - `cardForPaymentMethod(pm, creditCards)`, `cycleFinancials(txs, range, { income, cardBalances, creditCards })`
  - `generateRecurringTransactions(state, now, genId)` **returns** new transactions; it must not push into state (caller does)
  - anything calling `new Date()` / `todayStr()` with no arg takes `now` explicitly
- `legacy-app.js` keeps thin wrappers that pass `state` in, so call sites don't all change at once.
- Unit tests per module, including the edge cases the comments in `app.js` call out: day 31 in February, purchase on statement closing day vs day after, payday on the 31st, pay cycle crossing year end, installment final partial payment and stop, backfill floor (`RECURRING_BACKFILL_FLOOR` 2026-08-15), tax year boundary on 5/6 April, goal `tooNew` under two months, savings excluded from spending everywhere.
- Keep the explanatory comments from `app.js` with the functions they explain — they document real decisions.

**GATE 1:** unit coverage report for `domain/` (aim ≥90% lines), E2E green, `legacy-app.js` line count.

## 4. Phase 2 — Extract `data/` → GATE 2

- `data/supabase.js` creates the one client. `import.js` and `reset-password.js` use it too (convert them to modules) instead of their own setup.
- Mappers take `userId` as a parameter.
- One repository per table exposing intent-level functions (`transactions.insert(tx)`, `transactions.remove(id)`, `cardBalances.markPaid(id, date)`…). **No other module may import `supabase.js` except repos and auth.** Add an ESLint `no-restricted-imports` rule to enforce layer boundaries (§1 diagram).
- `sync.js` keeps `dbCall`'s existing optimistic-update + failure-banner behaviour exactly.
- Unit-test mappers (round-trip row → state → row). Repos get a thin fake client in unit tests; real behaviour is covered by E2E.

**GATE 2:** E2E green, boundary lint rule passing.

## 5. Phase 3 — State store and features → GATE 3

- `state/store.js`: `getState()`, `update(fn)`, `subscribe(listener)`. Move the loose flags (`viewMonth`, `customRange`, `currentView`, `editing*`, `*Expanded`, `patternsWindow`, `savingsFilters`, `currentUserId`) into it as a `ui` slice. Keep it simple; no framework.
- One folder per feature, each exporting `mount(rootEl)` (wire events once) and `render(state)`. `renderAll` becomes a subscriber that calls each feature's `render`. Preserve current render granularity where features re-render themselves (e.g. toggles call their own render).
- Keep HTML-string rendering and `esc()` exactly as today — the XSS protection depends on every interpolated value going through `esc`. While moving, check every template interpolation; a missing `esc` is a stop-and-report finding.
- Features never call each other; cross-feature effects go through store updates.
- Extract `index.html` inline `<style>` to `css/app.css`. If `'unsafe-inline'` in `style-src` is still needed afterwards (inline `style=` attributes for category colours), leave it and note it in `TECH_DEBT.md`.
- Delete `legacy-app.js` when empty.

**GATE 3:** E2E green, screenshots match baseline, no file in `src/` over ~400 lines, `app.js` gone.

## 6. Phase 4 — Hardening the new structure → GATE 4

- Update `README.md` (setup now includes test project, env vars, `npm` scripts, local dev) and `SPEC.md` if it references structure. Add a short `docs/ARCHITECTURE.md` with the layer diagram and "where does new code go" rules.
- Update `TECH_DEBT.md`: remove the "app.js is ~2,500 lines" entry; update file references in other entries (e.g. password min length now lives in `features/auth` and `reset-password.js`).
- Lighthouse / manual check that load time didn't regress noticeably from many module requests; if it did, report numbers rather than adding a bundler unasked.

**GATE 4:** docs reviewed by owner.

## 7. Phase 5 — Move server-worthy logic to the backend (free tier) → GATE 5

Only these, each as its own commit set, each applied to the **test project first**, SQL kept in `supabase/functions.sql` (idempotent, `create or replace`, `security invoker` so RLS still applies, explicit `grant execute ... to authenticated`):

1. **Atomic savings contribution** — Postgres function `add_savings_contribution(...)` inserting the transaction and contribution rows in one transaction, called via `sb.rpc()`. Fixes the "two inserts with no transaction" tech-debt entry.
2. **Recurring generation on the server** — Postgres function `generate_recurring_transactions(p_today date)` mirroring `domain/recurring.js` exactly (including backfill floor, clamped day-of-month, installment cap), idempotent via a unique constraint on `(user_id, recurring_id, recurring_occurrence)`. Removes the race where two open tabs can both generate the same occurrence. Keep the JS domain function as the spec; add a test that runs both against the same seeded data and compares.
3. **Optional, only if owner wants it:** a Supabase Edge Function for anything needing secrets later (e.g. email). Not needed now.

Do not move read-side calculations (periods, patterns, insights) to the server — they're cheap in the browser and moving them would spend free-tier quota for nothing.

Production schema changes are **not** applied by you. Produce a `docs/PROD_MIGRATION.md` checklist: exact SQL to run, in order, how to verify, how to roll back (`drop function`, drop constraint).

**GATE 5:** E2E green including new RPC paths; comparison test green.

## 8. What the gate reports must contain

- Commits in the phase (hash + subject)
- `npm run lint`, `npm test`, `npm run test:e2e` results (counts, not just "passed")
- Anything you found and parked in `TECH_DEBT.md`
- Anything that needs the owner to act (dashboard steps, secrets)
- Open questions

## 9. Merge to `main` (owner-driven)

1. Rebase/merge latest `main` into the branch; E2E green again.
2. Open a PR `refactor/modular-architecture → main` with a summary per phase and the test results.
3. Owner clicks through the **Vercel preview** (test DB) against the manual checklist in §2 0.5.
4. Owner applies `docs/PROD_MIGRATION.md` to prod Supabase *before* merging if Phase 5 is included (new code needs the RPCs; old code is unaffected by their presence, so this order is safe).
5. Owner confirms Vercel **Production** env vars point to prod.
6. Owner merges (merge commit, not squash, so phases stay revertable).
7. Post-deploy smoke check on production is **read-only**: sign in, confirm Home and Savings numbers match what the owner saw before the deploy, no console/CSP errors. No test writes on prod.
8. Rollback: revert the merge commit and redeploy; RPCs/constraint can stay (harmless) or be dropped per the migration doc.
