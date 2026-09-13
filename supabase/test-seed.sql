-- Passbook — synthetic data for the TEST Supabase project only.
--
-- This is the E2E-test counterpart to seed-my-data.sql. Everything in here
-- is made up — no real income, no real spending, no real accounts. It exists
-- so tests/e2e/*.spec.js can assert on known numbers instead of guessing at
-- whatever real data happens to be in the account.
--
-- NEVER run this against the production project (bvqhlmfacjhgbkwafjgq).
-- It belongs only in the separate "passbook-test" project created per
-- docs/REFACTOR_PLAN.md Phase 0 (§0.2).
--
-- Setup:
-- 1. Create the test Supabase project, run schema.sql in it (SQL Editor).
-- 2. Authentication -> Users -> Add user. Use an email/password you'll set
--    as TEST_USER_EMAIL / TEST_USER_PASSWORD for the E2E tests. Tick
--    "Auto Confirm User". Copy its User UID.
-- 3. Replace every YOUR_TEST_USER_ID_HERE below with that UID.
-- 4. Paste the whole file into a New query in the SQL Editor and Run.
-- 5. Safe to re-run: every insert is "on conflict do nothing" (or "do
--    update" for settings, matching seed-my-data.sql's convention).
--
-- The E2E suite runs with a fixed clock of 2026-09-20 (see
-- tests/e2e/fixtures.js) — every date below and every assertion in the
-- tests is chosen relative to that "today". If you ever need to change the
-- fixed clock, every hand-computed total in tests/e2e/home.spec.js needs
-- re-deriving to match — they are not computed from this file at test time,
-- they're pinned numbers checked against what the app renders.
--
-- Income sources use pay days of 1 and 15, which makes cycleStartDay() = 1,
-- so pay-cycle "periods" line up exactly with calendar months — the current
-- period at the fixed clock is 2026-09-01 to 2026-09-30 inclusive. That's
-- deliberate: it removes a whole axis of date-math from the test data.

insert into settings (user_id, currency, income) values
  ('YOUR_TEST_USER_ID_HERE', 'GBP', 3000)
on conflict (user_id) do update set currency = excluded.currency, income = excluded.income;

insert into income_sources (id, user_id, label, pay_day, sort_order) values
  ('test_salary1', 'YOUR_TEST_USER_ID_HERE', 'Test salary', 1, 0),
  ('test_salary2', 'YOUR_TEST_USER_ID_HERE', 'Test partner salary', 15, 1)
on conflict (id) do nothing;

insert into credit_cards (id, user_id, label, statement_day, payment_day, sort_order) values
  ('premium', 'YOUR_TEST_USER_ID_HERE', 'Test Premium Card', 10, 4, 0),
  ('regular', 'YOUR_TEST_USER_ID_HERE', 'Test Regular Card', 21, 15, 1)
on conflict (id) do nothing;

-- Both statements' due dates land inside the September test period
-- (2026-09-01..2026-09-30) regardless of paid status — cardDuesInRange()
-- counts by due date, not by whether it's been paid. Together they're the
-- £205.50 "card dues" baked into the Home stats leftover figure in
-- tests/e2e/home.spec.js.
insert into card_balances (id, user_id, card_id, statement_date, due_date, amount, paid, paid_date) values
  ('test_bal_premium', 'YOUR_TEST_USER_ID_HERE', 'premium', '2026-08-10', '2026-09-04', 120.00, true, '2026-09-02'),
  ('test_bal_regular', 'YOUR_TEST_USER_ID_HERE', 'regular', '2026-08-21', '2026-09-15', 85.50, false, null)
on conflict (id) do nothing;

-- Three recurring rules covering the three interesting states:
--  - test_sub: fully up to date (both months' occurrences already logged
--    below as transactions) — list it, don't regenerate it.
--  - test_missing_rent: NO occurrence logged yet. On first sign-in,
--    generateRecurringTransactions() must backfill its August occurrence
--    (2026-08-25) — September's (2026-09-25) hasn't happened yet relative
--    to the fixed clock (2026-09-20), so only one new row appears, and only
--    in August, never touching the September totals below. Re-running the
--    app after that is a no-op (idempotent).
--  - test_installment: partway through a capped installment (paid 40 of
--    200), due again 2026-09-24 — also in the future relative to the fixed
--    clock, so "remaining" stays at 160 for every test run.
insert into recurring_expenses (id, user_id, label, amount, day_of_month, category_id, active, installment_total, start_month) values
  ('test_sub', 'YOUR_TEST_USER_ID_HERE', 'Test Streaming Subscription', 9.99, 5, 'entertainment', true, null, null),
  ('test_missing_rent', 'YOUR_TEST_USER_ID_HERE', 'Test Recurring (auto-generates on load)', 50.00, 25, 'bills', true, null, null),
  ('test_installment', 'YOUR_TEST_USER_ID_HERE', 'Test Sofa Installment', 40.00, 24, 'shopping', true, 200.00, null)
on conflict (id) do nothing;

-- ── transactions ──
-- September rows (the "current period" at the fixed clock) are the ones
-- tests/e2e/home.spec.js pins exact totals against:
--   cash spent   = 45.30 + 30.00 + 22.50 + 60.00 + 15.00 + 9.99 = £182.79
--   card spent   = 75.00 + 40.00                                = £115.00
--   spent total  = cash + card                                  = £297.79 (8 expenses)
--   put aside    = 200.00                                       (1 transfer)
--   card dues    = 120.00 + 85.50 (see card_balances above)     = £205.50
--   left over    = income(3000) - 182.79 - 200.00 - 205.50      = £2,411.71
--   savings rate = 200 / 3000 * 100, rounded                    = 7%
insert into transactions (id, user_id, amount, date, category_id, note, recurring_id, recurring_occurrence, payment_method) values
  ('test_tx_sep_groceries', 'YOUR_TEST_USER_ID_HERE', 45.30, '2026-09-02', 'groceries', 'Weekly shop', null, null, 'cur acc'),
  ('test_tx_sep_transport', 'YOUR_TEST_USER_ID_HERE', 30.00, '2026-09-05', 'transport', 'Fuel', null, null, 'cur acc'),
  ('test_tx_sep_shopping_pcc', 'YOUR_TEST_USER_ID_HERE', 75.00, '2026-09-03', 'shopping', 'New shoes', null, null, 'PCC'),
  ('test_tx_sep_eating_out', 'YOUR_TEST_USER_ID_HERE', 22.50, '2026-09-08', 'eating_out', 'Dinner out', null, null, 'cur acc'),
  ('test_tx_sep_bills', 'YOUR_TEST_USER_ID_HERE', 60.00, '2026-09-12', 'bills', 'Water bill', null, null, 'sal acc'),
  ('test_tx_sep_entertainment_rcc', 'YOUR_TEST_USER_ID_HERE', 40.00, '2026-09-14', 'entertainment', 'Cinema', null, null, 'RCC'),
  ('test_tx_sep_health', 'YOUR_TEST_USER_ID_HERE', 15.00, '2026-09-18', 'health', 'Pharmacy', null, null, 'cur acc'),
  ('test_tx_sep_savings', 'YOUR_TEST_USER_ID_HERE', 200.00, '2026-09-10', 'savings', 'Monthly transfer to ISA', null, null, 'cur acc'),
  ('test_tx_sep_sub', 'YOUR_TEST_USER_ID_HERE', 9.99, '2026-09-05', 'entertainment', 'Test Streaming Subscription', 'test_sub', '2026-09', null),
  ('test_tx_aug_sub', 'YOUR_TEST_USER_ID_HERE', 9.99, '2026-08-05', 'entertainment', 'Test Streaming Subscription', 'test_sub', '2026-08', null),
  ('seed-installment-2026-08', 'YOUR_TEST_USER_ID_HERE', 40.00, '2026-08-24', 'shopping', 'Test Sofa Installment', 'test_installment', '2026-08', null),
  -- Earlier months: enough spread across categories/payment methods/weekdays
  -- for breakdown, patterns (3/6/12/all windows) and prior-period deltas to
  -- have something to show, without being totals the tests pin exactly.
  -- Groceries deliberately lands on a Saturday most months, for the spending
  -- patterns "mostly Saturday" weekday check.
  ('test_tx_aug_groceries', 'YOUR_TEST_USER_ID_HERE', 43.00, '2026-08-01', 'groceries', 'Weekly shop', null, null, 'cur acc'),
  ('test_tx_aug_groceries2', 'YOUR_TEST_USER_ID_HERE', 20.00, '2026-08-29', 'groceries', 'Top-up shop', null, null, 'cur acc'),
  ('test_tx_aug_transport', 'YOUR_TEST_USER_ID_HERE', 25.00, '2026-08-05', 'transport', 'Fuel', null, null, 'cur acc'),
  ('test_tx_aug_eating_out', 'YOUR_TEST_USER_ID_HERE', 15.00, '2026-08-10', 'eating_out', 'Lunch out', null, null, 'cur acc'),
  ('test_tx_aug_bills', 'YOUR_TEST_USER_ID_HERE', 55.00, '2026-08-12', 'bills', 'Electricity', null, null, 'sal acc'),
  ('test_tx_aug_shopping_pcc', 'YOUR_TEST_USER_ID_HERE', 60.00, '2026-08-15', 'shopping', 'Clothes', null, null, 'PCC'),
  ('test_tx_aug_entertainment_rcc', 'YOUR_TEST_USER_ID_HERE', 30.00, '2026-08-20', 'entertainment', 'Concert', null, null, 'RCC'),
  ('test_tx_aug_health', 'YOUR_TEST_USER_ID_HERE', 12.00, '2026-08-22', 'health', 'Pharmacy', null, null, 'cur acc'),
  ('test_tx_jul_groceries', 'YOUR_TEST_USER_ID_HERE', 41.00, '2026-07-04', 'groceries', 'Weekly shop', null, null, 'cur acc'),
  ('test_tx_jul_housing', 'YOUR_TEST_USER_ID_HERE', 900.00, '2026-07-01', 'housing', 'Rent', null, null, 'sal acc'),
  ('test_tx_jul_entertainment_rcc', 'YOUR_TEST_USER_ID_HERE', 35.00, '2026-07-22', 'entertainment', 'Concert', null, null, 'RCC'),
  ('test_tx_jun_groceries', 'YOUR_TEST_USER_ID_HERE', 44.00, '2026-06-06', 'groceries', 'Weekly shop', null, null, 'cur acc'),
  ('test_tx_jun_other', 'YOUR_TEST_USER_ID_HERE', 20.00, '2026-06-15', 'other', 'Misc', null, null, 'cur acc'),
  ('test_tx_jun_shopping_pcc', 'YOUR_TEST_USER_ID_HERE', 50.00, '2026-06-25', 'shopping', 'Clothes', null, null, 'PCC'),
  ('test_tx_may_groceries', 'YOUR_TEST_USER_ID_HERE', 38.00, '2026-05-02', 'groceries', 'Weekly shop', null, null, 'cur acc'),
  ('test_tx_may_insurance', 'YOUR_TEST_USER_ID_HERE', 45.00, '2026-05-15', 'insurance', 'Home insurance', null, null, 'wife sal acc'),
  ('test_tx_may_eating_out', 'YOUR_TEST_USER_ID_HERE', 18.00, '2026-05-18', 'eating_out', 'Lunch out', null, null, 'cur acc'),
  ('test_tx_apr_groceries', 'YOUR_TEST_USER_ID_HERE', 42.00, '2026-04-04', 'groceries', 'Weekly shop', null, null, 'cur acc'),
  ('test_tx_apr_bills', 'YOUR_TEST_USER_ID_HERE', 58.00, '2026-04-20', 'bills', 'Electricity', null, null, 'sal acc'),
  ('test_tx_mar_groceries', 'YOUR_TEST_USER_ID_HERE', 40.00, '2026-03-07', 'groceries', 'Weekly shop', null, null, 'cur acc'),
  ('test_tx_mar_transport', 'YOUR_TEST_USER_ID_HERE', 28.00, '2026-03-15', 'transport', 'Fuel', null, null, 'cur acc'),
  -- Savings-category ledger rows backing the savings_contributions below
  -- (one contribution = one transactions row + one savings_contributions
  -- row, see addSavingsContribution() in app.js).
  ('test_tx_aug_savings', 'YOUR_TEST_USER_ID_HERE', 150.00, '2026-08-10', 'savings', 'Monthly transfer', null, null, 'cur acc'),
  ('test_tx_jul_savings', 'YOUR_TEST_USER_ID_HERE', 100.00, '2026-07-10', 'savings', 'Monthly transfer', null, null, 'cur acc'),
  ('test_tx_jun_savings', 'YOUR_TEST_USER_ID_HERE', 100.00, '2026-06-10', 'savings', 'Monthly transfer', null, null, 'cur acc')
on conflict (id) do nothing;

-- ── savings goal + contributions ──
-- ISA-flagged contributions (cash_isa) this tax year (since 2026-04-06):
-- 150 (Aug) + 200 (Sept) = £350 of the £20,000 allowance — the number the
-- ISA allowance meter test pins.
insert into savings_goals (id, user_id, name, target_amount, horizon, start_date, target_date, archived) values
  ('test_goal1', 'YOUR_TEST_USER_ID_HERE', 'Test Emergency Fund', 1000.00, 'short', '2026-07-01', '2027-01-01', false)
on conflict (id) do nothing;

insert into savings_contributions (id, user_id, transaction_id, amount, date, vehicle, account_label, goal_id, note) values
  ('test_contrib_sep', 'YOUR_TEST_USER_ID_HERE', 'test_tx_sep_savings', 200.00, '2026-09-10', 'cash_isa', 'Test ISA account', 'test_goal1', 'Monthly transfer'),
  ('test_contrib_aug', 'YOUR_TEST_USER_ID_HERE', 'test_tx_aug_savings', 150.00, '2026-08-10', 'cash_isa', 'Test ISA account', 'test_goal1', 'Monthly transfer'),
  ('test_contrib_jul', 'YOUR_TEST_USER_ID_HERE', 'test_tx_jul_savings', 100.00, '2026-07-10', 'premium_bonds', 'Test NS&I holding', null, ''),
  ('test_contrib_jun', 'YOUR_TEST_USER_ID_HERE', 'test_tx_jun_savings', 100.00, '2026-06-10', 'stocks_general', 'Test brokerage', null, '')
on conflict (id) do nothing;

-- ── planned purchases ──
insert into planned_expenses (id, user_id, name, amount, category_id, note, created_at) values
  ('test_planned_laptop', 'YOUR_TEST_USER_ID_HERE', 'New laptop', 900.00, 'shopping', 'Maybe for work', '2026-09-05'),
  ('test_planned_trip', 'YOUR_TEST_USER_ID_HERE', 'Weekend trip', 250.00, 'transport', '', '2026-09-10')
on conflict (id) do nothing;
