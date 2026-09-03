-- Passbook — seed your own data
-- Run this AFTER you've: 1) run schema.sql, and 2) created your login under
-- Authentication → Users. It sets up your two credit cards, two income
-- sources, and the 13 direct debits from your earlier setup, all tied to
-- your account so they only ever show up when you're signed in.
--
-- ── Find your user id ──
-- In Supabase, go to Authentication → Users, click on your account, and
-- copy the "User UID" shown there (a long code like
-- 8a1b2c3d-4e5f-6789-a0b1-c2d3e4f5a6b7). Then use your browser's Find &
-- Replace (or just carefully select-and-retype) to replace every occurrence
-- of 6f704a2e-03c3-4efe-bdaa-a04d5b66265e below with that value before running this.
--
-- If someone else creates their own separate login later, this file isn't
-- for them — they start with a clean slate and add their own income
-- sources, cards and direct debits from inside the app itself (Money
-- calendar → Edit → "+ Add income source" / "+ Add credit card", and the
-- Recurring payments panel's "Add a direct debit" form).

insert into income_sources (id, user_id, label, pay_day, sort_order) values
  ('you', '6f704a2e-03c3-4efe-bdaa-a04d5b66265e', 'Your salary', 24, 0),
  ('wife', '6f704a2e-03c3-4efe-bdaa-a04d5b66265e', 'Wife''s salary', 15, 1)
on conflict (id) do nothing;

insert into credit_cards (id, user_id, label, statement_day, payment_day, sort_order) values
  ('premium', '6f704a2e-03c3-4efe-bdaa-a04d5b66265e', 'Premium card', 10, 4, 0),
  ('regular', '6f704a2e-03c3-4efe-bdaa-a04d5b66265e', 'Regular card', 21, 15, 1)
on conflict (id) do nothing;

insert into recurring_expenses (id, user_id, label, amount, day_of_month, category_id, active, installment_total, start_month) values
  ('aviva1', '6f704a2e-03c3-4efe-bdaa-a04d5b66265e', 'Aviva insurance', 29.64, 10, 'insurance', true, null, null),
  ('aviva2', '6f704a2e-03c3-4efe-bdaa-a04d5b66265e', 'Aviva insurance', 12.47, 10, 'insurance', true, null, null),
  ('aviva3', '6f704a2e-03c3-4efe-bdaa-a04d5b66265e', 'Aviva insurance', 10.34, 10, 'insurance', true, null, null),
  ('D&G','6f704a2e-03c3-4efe-bdaa-a04d5b66265e', 'Xbox Insurance',3.89,7, 'insurance',true, null, null ),
  ('Apple Care','6f704a2e-03c3-4efe-bdaa-a04d5b66265e','Iphone Insurance', 3,8.99,'insurance',true, null, null ),
  ('sim', '6f704a2e-03c3-4efe-bdaa-a04d5b66265e', 'SIM', 14.30, 17, 'bills', true, null, null),
  ('tvlicence', '6f704a2e-03c3-4efe-bdaa-a04d5b66265e', 'TV licence', 36, 24, 'bills', true, null, null),
  ('counciltax', '6f704a2e-03c3-4efe-bdaa-a04d5b66265e', 'Council tax', 240, 28, 'housing', true, null, null),
  ('mortgage', '6f704a2e-03c3-4efe-bdaa-a04d5b66265e', 'Mortgage', 1979.06, 1, 'housing', true, null, null),
  ('lv', '6f704a2e-03c3-4efe-bdaa-a04d5b66265e', 'LV= insurance', 32.14, 1, 'insurance', true, null, null),
  ('lisa', '6f704a2e-03c3-4efe-bdaa-a04d5b66265e', 'Moneybox LISA', 1, 1, 'savings', true, null, null),
  ('wifi', '6f704a2e-03c3-4efe-bdaa-a04d5b66265e', 'Wifi', 39, 1, 'bills', true, null, null),
  ('electricity', '6f704a2e-03c3-4efe-bdaa-a04d5b66265e', 'Electricity', 120.84, 25, 'bills', true, null, null),
  ('carinsurance', '6f704a2e-03c3-4efe-bdaa-a04d5b66265e', 'Car insurance', 104.05, 25, 'insurance', true, null, null),
  ('diningtable', '6f704a2e-03c3-4efe-bdaa-a04d5b66265e', 'Dining table EMI', 133.34, 24, 'shopping', true, 1600, null)
on conflict (id) do nothing;

-- One-off: the first dining table installment (£133.34) was paid outside the
-- app on 24 Aug 2026, before this feature existed — this records it once as
-- history so the £1,600 total and remaining balance are accurate from the
-- start. (If you already have this transaction from importing your export
-- from the old app, skip this block — it would otherwise be logged twice.)
insert into transactions (id, user_id, amount, date, category_id, note, recurring_id, recurring_occurrence) values
  ('seed-diningtable-2026-08', '6f704a2e-03c3-4efe-bdaa-a04d5b66265e', 133.34, '2026-08-24', 'shopping', 'Dining table EMI', 'diningtable', '2026-08')
on conflict (id) do nothing;

-- Optional: sets your currency explicitly (it already defaults to GBP).
insert into settings (user_id, currency) values ('6f704a2e-03c3-4efe-bdaa-a04d5b66265e', 'GBP')
on conflict (user_id) do update set currency = excluded.currency;
