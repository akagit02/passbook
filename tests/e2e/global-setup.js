import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Hard safety gate: docs/REFACTOR_PLAN.md rule 2 is "never write to the
// production Supabase project" — and this repo's owner has confirmed their
// local "test" login IS their real production account, so there is no safe
// fallback if this check is skipped. E2E tests add/delete real rows, so
// refuse to run at all unless config.js is unmistakably pointed at the
// separate test project.
//
// This is deliberately a literal string match on the known production
// project ref, not an allowlist of "safe" hosts — an allowlist would need
// updating every time the test project's ref changes, while the production
// ref never changes. See docs/REFACTOR_PLAN.md Phase 0 (§0.2/§0.3).
const PROD_PROJECT_REF = "bvqhlmfacjhgbkwafjgq";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONFIG_PATH = join(ROOT, "config.js");

export default function globalSetup() {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(
      "config.js not found. Run `npm run config` with PASSBOOK_SUPABASE_URL / " +
      "PASSBOOK_SUPABASE_ANON_KEY set to your TEST Supabase project first."
    );
  }

  const configContents = readFileSync(CONFIG_PATH, "utf8");

  if (configContents.includes(PROD_PROJECT_REF)) {
    throw new Error(
      "\n\n" +
      "REFUSING TO RUN E2E TESTS: config.js points at the PRODUCTION Supabase " +
      "project (" + PROD_PROJECT_REF + "). These tests create and delete real " +
      "rows and must only ever run against a separate test project.\n\n" +
      "Fix: set PASSBOOK_SUPABASE_URL and PASSBOOK_SUPABASE_ANON_KEY to your " +
      "test project's values, then run `npm run config` to regenerate " +
      "config.js, before running `npm run test:e2e` again.\n"
    );
  }

  if (!process.env.TEST_USER_EMAIL || !process.env.TEST_USER_PASSWORD) {
    throw new Error(
      "TEST_USER_EMAIL and TEST_USER_PASSWORD must be set — these sign in to " +
      "the test Supabase project's seeded account (see supabase/test-seed.sql)."
    );
  }
}
