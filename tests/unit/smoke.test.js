import { describe, expect, it } from "vitest";

// Confirms the Vitest wiring itself works. Replace/extend with real
// src/domain and src/lib tests starting in Phase 1 of docs/REFACTOR_PLAN.md.
describe("test runner", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
