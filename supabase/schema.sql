-- Passbook — Supabase schema (per-user data)
-- Run this once in your Supabase project's SQL Editor (Dashboard → SQL Editor → New query → paste → Run).
-- Safe to re-run: everything uses "if not exists" / "or replace" where possible.
--
-- Every table has a user_id column tied to whoever is signed in, and Row
-- Level Security only lets a person read or write rows where user_id matches
-- their own account. That means two different logins never see each other's
-- entries — each person who signs in gets their own private set of income
-- sources, cards, transactions, and so on, even though they're all using the
-- same app and the same database.
--
-- This file does NOT put any of your own data into the tables — it can't,
-- since your user account doesn't exist yet at this point. Once you've
-- created your login (next step after this), see seed-my-data.sql to bring
-- in your income sources, credit cards and direct debits in one go, or just
-- add them by hand from within the app.

-- ── settings (currency + flat monthly income figure, one row per person) ──
create table if not exists settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  currency text not null default 'GBP',
  income numeric
);

-- ── income sources (paydays) ──
create table if not exists income_sources (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  label text not null,
  pay_day integer not null check (pay_day between 1 and 31),
  sort_order integer not null default 0
);
create index if not exists income_sources_user_idx on income_sources (user_id);

-- ── credit cards (statement / payment dates) ──
create table if not exists credit_cards (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  label text not null,
  statement_day integer not null check (statement_day between 1 and 31),
  payment_day integer not null check (payment_day between 1 and 31),
  sort_order integer not null default 0
);
create index if not exists credit_cards_user_idx on credit_cards (user_id);

-- ── ledger transactions (manual entries + auto-generated recurring payments) ──
create table if not exists transactions (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  amount numeric not null,
  date date not null,
  category_id text not null,
  note text not null default '',
  recurring_id text,
  recurring_occurrence text,
  created_at timestamptz not null default now()
);
create index if not exists transactions_user_date_idx on transactions (user_id, date);
create index if not exists transactions_recurring_idx on transactions (recurring_id, recurring_occurrence);

-- "Paid using" — free text backed by a datalist in the app, not a lookup table.
-- Added after the original schema shipped, hence the separate alter rather than
-- a column in the create above (so re-running this file on an existing project
-- picks it up instead of silently skipping the whole create).
alter table transactions add column if not exists payment_method text;

-- ── planned purchases ──
create table if not exists planned_expenses (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  amount numeric not null,
  category_id text not null,
  note text not null default '',
  created_at date not null default current_date
);
create index if not exists planned_expenses_user_idx on planned_expenses (user_id);

-- ── credit card statement balances (entered manually, tracked until paid) ──
create table if not exists card_balances (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  card_id text not null references credit_cards(id) on delete cascade,
  statement_date date not null,
  due_date date not null,
  amount numeric not null,
  paid boolean not null default false,
  paid_date date,
  created_at date not null default current_date
);
create index if not exists card_balances_user_idx on card_balances (user_id);

-- ── recurring payments / direct debits (rules that generate transactions) ──
create table if not exists recurring_expenses (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  label text not null,
  amount numeric not null,
  day_of_month integer not null check (day_of_month between 1 and 31),
  category_id text not null,
  active boolean not null default true,
  installment_total numeric,
  start_month text,
  created_at date not null default current_date
);
create index if not exists recurring_expenses_user_idx on recurring_expenses (user_id);

-- ── savings goals (a target amount and a deadline to hit it by) ──
-- "How long should it take me" is entered in the app as a number of months and
-- stored here as the resulting target_date, so "am I on pace" is a straight
-- date comparison rather than re-deriving the deadline from a duration every
-- time. horizon is the user's own short/long framing — it's what the savings
-- advice tiers off, since money needed inside a couple of years belongs
-- somewhere very different from money that can sit for a decade.
create table if not exists savings_goals (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  target_amount numeric not null,
  horizon text not null default 'long' check (horizon in ('short', 'long')),
  start_date date not null default current_date,
  target_date date not null,
  archived boolean not null default false,
  created_at date not null default current_date
);
create index if not exists savings_goals_user_idx on savings_goals (user_id);

-- ── savings contributions (money deliberately put aside) ──
-- Each contribution is paired with a real row in `transactions` (category
-- "savings"), so putting money aside shows up in the ledger and reduces
-- "left over" through exactly the same path as any other money leaving a bank
-- account — no parallel arithmetic to keep in sync. This table only holds the
-- part the ledger has no place for: *where* the money went.
--
-- `on delete cascade` on transaction_id is what stops a savings entry deleted
-- from the ledger leaving an orphan here quietly inflating the savings total.
create table if not exists savings_contributions (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  transaction_id text references transactions(id) on delete cascade,
  amount numeric not null,
  date date not null,
  vehicle text not null default 'savings_account',
  account_label text not null default '',
  goal_id text references savings_goals(id) on delete set null,
  note text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists savings_contributions_user_date_idx on savings_contributions (user_id, date);
create index if not exists savings_contributions_goal_idx on savings_contributions (goal_id);

-- ── Row Level Security ──
-- Each person only ever sees rows that belong to them. There is no "shared
-- household" access here — if two people should see the same figures, that's
-- a choice you'd make by literally sharing one login between them, not
-- something this schema does automatically.
alter table settings enable row level security;
alter table income_sources enable row level security;
alter table credit_cards enable row level security;
alter table transactions enable row level security;
alter table planned_expenses enable row level security;
alter table card_balances enable row level security;
alter table recurring_expenses enable row level security;
alter table savings_goals enable row level security;
alter table savings_contributions enable row level security;

drop policy if exists "own rows only" on settings;
create policy "own rows only" on settings for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own rows only" on income_sources;
create policy "own rows only" on income_sources for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own rows only" on credit_cards;
create policy "own rows only" on credit_cards for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own rows only" on transactions;
create policy "own rows only" on transactions for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own rows only" on planned_expenses;
create policy "own rows only" on planned_expenses for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own rows only" on card_balances;
create policy "own rows only" on card_balances for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own rows only" on recurring_expenses;
create policy "own rows only" on recurring_expenses for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own rows only" on savings_goals;
create policy "own rows only" on savings_goals for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own rows only" on savings_contributions;
create policy "own rows only" on savings_contributions for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
