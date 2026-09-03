// Passbook — Supabase connection settings.
//
// Fill these in with your own project's values (Supabase dashboard →
// Settings → API), then redeploy. See README.md for step-by-step instructions.
//
// IMPORTANT: only ever put the "anon" / "public" key here — NEVER the
// "service_role" / secret key. The anon key is safe to ship in client-side
// code like this; the service_role key bypasses Row Level Security entirely
// and must never appear in a file that reaches a browser.

window.PASSBOOK_CONFIG = {
  SUPABASE_URL: "https://bvqhlmfacjhgbkwafjgq.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ2cWhsbWZhY2poZ2Jrd2FmamdxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg0NDg5ODgsImV4cCI6MjEwNDAyNDk4OH0.oDAHQUavWpZPCt0V-HD7jsc636-9cJ6wsdN3fyC5RuE"
};
