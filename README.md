# Passbook  

A personal expense tracker: quick expense logging, planned purchases, recurring
direct debits, credit card statement reminders, and a pay-cycle-aware "leftover"
figure. This version stores data in Supabase (Postgres) and is deployed as a
static site on Vercel, with real email/password login.

**Each login has its own private data.** Anyone can have an account on this
app, but nobody can see anyone else's income, cards, transactions or bills —
that's enforced by the database itself (Row Level Security), not just hidden
in the interface.

## What's in this folder

- `index.html`, `app.js` — the app itself.
- `config.js` — your Supabase project's URL and public API key. **Edit this
  before deploying.**
- `import.html` — a one-time tool for bringing your data across from the old
  version of Passbook.
- `supabase/schema.sql` — the database schema. Run this once in Supabase.
- `supabase/seed-my-data.sql` — a one-time script that fills in *your* two
  credit cards, two income sources, and 13 direct debits, once your login
  exists. Nobody else who signs in later needs or uses this file — see
  "Letting someone else use this" below.

## 1. Set up the database

1. Open your Supabase project → **SQL Editor** → **New query**.
2. Paste in the entire contents of `supabase/schema.sql` and click **Run**.
   This creates all the tables and turns on Row Level Security, so a signed-in
   user can only ever read or write their own rows. It doesn't put any actual
   data in yet — it can't, since no login exists at this point.
3. Safe to re-run later — it won't duplicate anything or wipe existing data.

## 2. Create your login

1. In Supabase, go to **Authentication → Users → Add user**.
2. Enter an email and password. Tick **Auto Confirm User** so you can sign in
   immediately without a confirmation email.
3. Click on the account you just created and copy its **User UID** (a long
   code like `8a1b2c3d-4e5f-6789-a0b1-c2d3e4f5a6b7`) — you'll need it in the
   next step.
4. (Recommended) Go to **Authentication → Providers → Email** and turn
   **off** "Allow new users to sign up". This app has no public sign-up page,
   but disabling it at the project level closes off the possibility entirely
   — the only way in is an account you create yourself in this dashboard.

## 3. Seed your own data

1. Open `supabase/seed-my-data.sql` in a text editor.
2. Replace every `YOUR_USER_ID_HERE` with the User UID you copied in step 2.
3. Paste the whole thing into a **New query** in the Supabase SQL Editor and
   click **Run**. This adds your two credit cards, two income sources, and
   the 13 direct debits, all tied to your account.

## 4. Fill in `config.js`

Open `config.js` in this folder and fill in your project's values, found in
Supabase under **Settings → API**:

- `SUPABASE_URL` → "Project URL"
- `SUPABASE_ANON_KEY` → the key labelled **`anon` `public`**

**Never use the `service_role` / secret key here.** That key bypasses all the
access rules the schema sets up and must never end up in a file that's sent
to a browser. The `anon` key is the only one this app needs, and it's safe to
have it in client-side code — it doesn't grant any access without a valid
sign-in on top of it.

## 5. Deploy to Vercel

This is a static site — no build step. Easiest path:

**Option A — drag and drop:**
1. Go to [vercel.com](https://vercel.com) and sign in (or create a free
   account).
2. From the dashboard, choose **Add New → Project**, then look for the
   option to deploy without Git — drag this whole `passbook-web` folder
   (with your edited `config.js`) onto the page.
3. Vercel gives you a live URL (something like `passbook-xyz.vercel.app`)
   within about a minute.

**Option B — Vercel CLI**, if you have Node installed locally:
```
cd passbook-web
npx vercel
```
Follow the prompts (first deploy asks a few setup questions; accept the
defaults). It prints your live URL when done.

Either way, redeploying later after an edit is the same action again — drag
the folder in again, or re-run `npx vercel`.

### Allow password reset emails to work

The login screen's **Forgot password?** link emails a recovery link that
lands on `reset-password.html`. Supabase rejects that redirect unless you
allow it explicitly:

1. In Supabase, go to **Authentication → URL Configuration → Redirect URLs**.
2. Add `<your-deployed-url>/reset-password.html` (e.g.
   `https://passbook-xyz.vercel.app/reset-password.html`).
3. If you also test locally, add your local URL too (e.g.
   `http://localhost:8765/reset-password.html`).

## 6. Bring your transaction history across

The old Passbook (the Claude Artifact version) has an **Export data** panel
near the bottom of the page. Open it, click **Select all**, copy
(Ctrl/Cmd+C), and keep that text somewhere safe (a text file) for a moment.

Once the new app is deployed and reachable at its own URL:

1. Go to `<your-deployed-url>/import.html`.
2. Sign in with the login you created in step 2.
3. Paste the exported JSON into the box and click **Import into Supabase**.

This is safe to run more than once — matching records are updated in place,
not duplicated — so if you add more expenses to the old app before finishing
the switch, just export again and re-import. Everything you import is tagged
with whichever account you're signed in as when you run it.

## Letting someone else use this

Because data is private per login, adding a second person (a friend, another
family member with their own separate finances) is just:

1. Create another account for them the same way as step 2 — a new email and
   password under **Authentication → Users**.
2. That's it. When they sign in, they start on a completely empty ledger —
   nothing of yours is visible. They add their own income sources and credit
   cards from **Money calendar → Edit → "+ Add income source"** / **"+ Add
   credit card"**, and their own recurring bills from the **Recurring
   payments** panel's **Add a direct debit** form, all from inside the app.
   There's no SQL step for them — `seed-my-data.sql` is specific to your data.

If instead you want someone (like a spouse) to see and edit the exact same
numbers as you — one shared ledger, not two separate ones — the simplest
approach is to just have both of you sign in with the same login. There's no
separate "shared household" mode; sharing one account *is* how you'd share
one ledger.

## If something goes wrong

- **"Couldn't save that change" banner**: usually a lost connection, or the
  database schema wasn't fully applied. Re-check step 1, and check the
  browser's developer console for the underlying error.
- **Can't sign in**: double check the account was created under
  **Authentication → Users** in Supabase (not just invited), and that "Auto
  Confirm User" was ticked, or that the invite email was completed.
- **Seeded data or import didn't show up**: almost always a mismatched user
  id — double check every `YOUR_USER_ID_HERE` in `seed-my-data.sql` was
  replaced with the UID of the account you're actually signed in as. The
  import tool logs how many rows it wrote for each table at the end — if a
  table shows 0, check the exported JSON actually contained that section
  (open it in a text editor and search for the key, e.g. `"transactions"`).
