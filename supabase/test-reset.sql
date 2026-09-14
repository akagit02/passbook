-- Passbook — reset_test_data(): restore the E2E seed before every test run.
--
-- TEST Supabase project ("passbook-test") ONLY. NEVER run this against the
-- production project (bvqhlmfacjhgbkwafjgq).
--
-- Why: every add/delete E2E test cleans up after itself, but a test that's
-- interrupted mid-way (a failed assertion, a rate-limited request) leaves its
-- row behind — and then every hand-pinned total in the next run is off by
-- that row, which leaves more orphans, and so on. tests/e2e/global-setup.js
-- signs in as the test user and calls this function before the suite starts,
-- so every run begins from exactly the rows in supabase/test-seed.sql.
--
-- Safety:
--  - SECURITY INVOKER: it runs with the caller's own permissions, under the
--    normal "own rows only" RLS policies, so it physically cannot read or
--    change another account's rows.
--  - It refuses to run for any signed-in email except the E2E test account.
--  - anon and public can't execute it at all.
--
-- Setup (once):
-- 1. Replace YOUR_TEST_USER_EMAIL_HERE below with the TEST_USER_EMAIL used
--    by the E2E suite.
-- 2. Paste the whole file into a New query in the test project's SQL Editor
--    and Run. Safe to re-run ("create or replace").
--
-- Keep the inserts below identical to supabase/test-seed.sql — the numbers
-- pinned in tests/e2e/*.spec.js are derived from that file's comments.

create or replace function public.reset_test_data()
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'reset_test_data: not signed in';
  end if;
  if coalesce(auth.jwt() ->> 'email', '') <> 'YOUR_TEST_USER_EMAIL_HERE' then
    raise exception 'reset_test_data: only the E2E test account may reset its data';
  end if;

  -- Children before parents (contributions -> transactions/goals, balances -> cards).
  delete from savings_contributions where user_id = uid;
  delete from card_balances         where user_id = uid;
  delete from transactions          where user_id = uid;
  delete from recurring_expenses    where user_id = uid;
  delete from planned_expenses      where user_id = uid;
  delete from savings_goals         where user_id = uid;
  delete from credit_cards          where user_id = uid;
  delete from income_sources        where user_id = uid;
  delete from settings              where user_id = uid;

  insert into settings (user_id, currency, income) values
    (uid, 'GBP', 3000);

  insert into income_sources (id, user_id, label, pay_day, sort_order) values
    ('test_salary1', uid, 'Test salary', 1, 0),
    ('test_salary2', uid, 'Test partner salary', 15, 1);

  insert into credit_cards (id, user_id, label, statement_day, payment_day, sort_order) values
    ('premium', uid, 'Test Premium Card', 10, 4, 0),
    ('regular', uid, 'Test Regular Card', 21, 15, 1);

  insert into card_balances (id, user_id, card_id, statement_date, due_date, amount, paid, paid_date) values
    ('test_bal_premium', uid, 'premium', '2026-08-10', '2026-09-04', 120.00, true, '2026-09-02'),
    ('test_bal_regular', uid, 'regular', '2026-08-21', '2026-09-15', 85.50, false, null);

  insert into recurring_expenses (id, user_id, label, amount, day_of_month, category_id, active, installment_total, start_month) values
    ('test_sub', uid, 'Test Streaming Subscription', 9.99, 5, 'entertainment', true, null, null),
    ('test_missing_rent', uid, 'Test Recurring (auto-generates on load)', 50.00, 25, 'bills', true, null, null),
    ('test_installment', uid, 'Test Sofa Installment', 40.00, 24, 'shopping', true, 200.00, null);

  insert into transactions (id, user_id, amount, date, category_id, note, recurring_id, recurring_occurrence, payment_method) values
    ('test_tx_sep_groceries', uid, 45.30, '2026-09-02', 'groceries', 'Weekly shop', null, null, 'cur acc'),
    ('test_tx_sep_transport', uid, 30.00, '2026-09-05', 'transport', 'Fuel', null, null, 'cur acc'),
    ('test_tx_sep_shopping_pcc', uid, 75.00, '2026-09-03', 'shopping', 'New shoes', null, null, 'PCC'),
    ('test_tx_sep_eating_out', uid, 22.50, '2026-09-08', 'eating_out', 'Dinner out', null, null, 'cur acc'),
    ('test_tx_sep_bills', uid, 60.00, '2026-09-12', 'bills', 'Water bill', null, null, 'sal acc'),
    ('test_tx_sep_entertainment_rcc', uid, 40.00, '2026-09-14', 'entertainment', 'Cinema', null, null, 'RCC'),
    ('test_tx_sep_health', uid, 15.00, '2026-09-18', 'health', 'Pharmacy', null, null, 'cur acc'),
    ('test_tx_sep_savings', uid, 200.00, '2026-09-10', 'savings', 'Monthly transfer to ISA', null, null, 'cur acc'),
    ('test_tx_sep_sub', uid, 9.99, '2026-09-05', 'entertainment', 'Test Streaming Subscription', 'test_sub', '2026-09', null),
    ('test_tx_aug_sub', uid, 9.99, '2026-08-05', 'entertainment', 'Test Streaming Subscription', 'test_sub', '2026-08', null),
    ('seed-installment-2026-08', uid, 40.00, '2026-08-24', 'shopping', 'Test Sofa Installment', 'test_installment', '2026-08', null),
    ('test_tx_aug_groceries', uid, 43.00, '2026-08-01', 'groceries', 'Weekly shop', null, null, 'cur acc'),
    ('test_tx_aug_groceries2', uid, 20.00, '2026-08-29', 'groceries', 'Top-up shop', null, null, 'cur acc'),
    ('test_tx_aug_transport', uid, 25.00, '2026-08-05', 'transport', 'Fuel', null, null, 'cur acc'),
    ('test_tx_aug_eating_out', uid, 15.00, '2026-08-10', 'eating_out', 'Lunch out', null, null, 'cur acc'),
    ('test_tx_aug_bills', uid, 55.00, '2026-08-12', 'bills', 'Electricity', null, null, 'sal acc'),
    ('test_tx_aug_shopping_pcc', uid, 60.00, '2026-08-15', 'shopping', 'Clothes', null, null, 'PCC'),
    ('test_tx_aug_entertainment_rcc', uid, 30.00, '2026-08-20', 'entertainment', 'Concert', null, null, 'RCC'),
    ('test_tx_aug_health', uid, 12.00, '2026-08-22', 'health', 'Pharmacy', null, null, 'cur acc'),
    ('test_tx_jul_groceries', uid, 41.00, '2026-07-04', 'groceries', 'Weekly shop', null, null, 'cur acc'),
    ('test_tx_jul_housing', uid, 900.00, '2026-07-01', 'housing', 'Rent', null, null, 'sal acc'),
    ('test_tx_jul_entertainment_rcc', uid, 35.00, '2026-07-22', 'entertainment', 'Concert', null, null, 'RCC'),
    ('test_tx_jun_groceries', uid, 44.00, '2026-06-06', 'groceries', 'Weekly shop', null, null, 'cur acc'),
    ('test_tx_jun_other', uid, 20.00, '2026-06-15', 'other', 'Misc', null, null, 'cur acc'),
    ('test_tx_jun_shopping_pcc', uid, 50.00, '2026-06-25', 'shopping', 'Clothes', null, null, 'PCC'),
    ('test_tx_may_groceries', uid, 38.00, '2026-05-02', 'groceries', 'Weekly shop', null, null, 'cur acc'),
    ('test_tx_may_insurance', uid, 45.00, '2026-05-15', 'insurance', 'Home insurance', null, null, 'wife sal acc'),
    ('test_tx_may_eating_out', uid, 18.00, '2026-05-18', 'eating_out', 'Lunch out', null, null, 'cur acc'),
    ('test_tx_apr_groceries', uid, 42.00, '2026-04-04', 'groceries', 'Weekly shop', null, null, 'cur acc'),
    ('test_tx_apr_bills', uid, 58.00, '2026-04-20', 'bills', 'Electricity', null, null, 'sal acc'),
    ('test_tx_mar_groceries', uid, 40.00, '2026-03-07', 'groceries', 'Weekly shop', null, null, 'cur acc'),
    ('test_tx_mar_transport', uid, 28.00, '2026-03-15', 'transport', 'Fuel', null, null, 'cur acc'),
    ('test_tx_aug_savings', uid, 150.00, '2026-08-10', 'savings', 'Monthly transfer', null, null, 'cur acc'),
    ('test_tx_jul_savings', uid, 100.00, '2026-07-10', 'savings', 'Monthly transfer', null, null, 'cur acc'),
    ('test_tx_jun_savings', uid, 100.00, '2026-06-10', 'savings', 'Monthly transfer', null, null, 'cur acc');

  insert into savings_goals (id, user_id, name, target_amount, horizon, start_date, target_date, archived) values
    ('test_goal1', uid, 'Test Emergency Fund', 1000.00, 'short', '2026-07-01', '2027-01-01', false);

  insert into savings_contributions (id, user_id, transaction_id, amount, date, vehicle, account_label, goal_id, note) values
    ('test_contrib_sep', uid, 'test_tx_sep_savings', 200.00, '2026-09-10', 'cash_isa', 'Test ISA account', 'test_goal1', 'Monthly transfer'),
    ('test_contrib_aug', uid, 'test_tx_aug_savings', 150.00, '2026-08-10', 'cash_isa', 'Test ISA account', 'test_goal1', 'Monthly transfer'),
    ('test_contrib_jul', uid, 'test_tx_jul_savings', 100.00, '2026-07-10', 'premium_bonds', 'Test NS&I holding', null, ''),
    ('test_contrib_jun', uid, 'test_tx_jun_savings', 100.00, '2026-06-10', 'stocks_general', 'Test brokerage', null, '');

  insert into planned_expenses (id, user_id, name, amount, category_id, note, created_at) values
    ('test_planned_laptop', uid, 'New laptop', 900.00, 'shopping', 'Maybe for work', '2026-09-05'),
    ('test_planned_trip', uid, 'Weekend trip', 250.00, 'transport', '', '2026-09-10');
end;
$$;

revoke all on function public.reset_test_data() from public, anon;
grant execute on function public.reset_test_data() to authenticated;
