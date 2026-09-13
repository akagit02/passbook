// Template for local development. Copy this to config.js (already
// gitignored-by-convention for local overrides — see README) and fill in
// your own Supabase project's values, OR just set PASSBOOK_SUPABASE_URL and
// PASSBOOK_SUPABASE_ANON_KEY as environment variables and run `npm run
// config`, which does the same thing via scripts/build-config.mjs.
//
// IMPORTANT: only ever put the "anon" / "public" key here — NEVER the
// "service_role" / secret key. See config.js's own comment for why.

window.PASSBOOK_CONFIG = {
  SUPABASE_URL: "https://YOUR-TEST-PROJECT.supabase.co",
  SUPABASE_ANON_KEY: "YOUR-TEST-PROJECT-ANON-KEY"
};
