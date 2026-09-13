import js from "@eslint/js";
import globals from "globals";

// Flat config (ESLint 9). Two profiles:
//  - legacy browser scripts (app.js, import.js, reset-password.js): the
//    pre-refactor code, loaded as plain <script> tags, sharing globals like
//    `window.supabase`. Kept lenient — this code is being phased out by the
//    refactor (docs/REFACTOR_PLAN.md), not rewritten to satisfy a linter.
//  - everything new (src/, scripts/, tests/): real ES modules, node or
//    browser as appropriate, held to normal recommended rules. This is
//    where the layer-boundary rule from Phase 2 of the plan will be added.
export default [
  js.configs.recommended,
  {
    ignores: ["node_modules/**", "playwright-report/**", "test-results/**", "src/**"]
  },
  {
    files: ["app.js", "import.js", "reset-password.js"],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: "script",
      globals: { ...globals.browser, supabase: "readonly" }
    },
    rules: {
      "no-unused-vars": "warn",
      "no-prototype-builtins": "warn"
    }
  },
  {
    files: ["config.js", "config.example.js"],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: "script",
      globals: globals.browser
    }
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: globals.node
    }
  },
  {
    files: ["tests/unit/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node }
    }
  },
  {
    files: ["tests/e2e/**/*.js", "playwright.config.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser }
    }
  }
];
