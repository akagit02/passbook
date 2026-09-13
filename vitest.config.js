import { defineConfig } from "vitest/config";

// Unit tests target tests/unit/, mirroring src/domain and src/lib once
// Phase 1 of docs/REFACTOR_PLAN.md extracts them. Pure logic — no DOM needed.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.js"]
  }
});
