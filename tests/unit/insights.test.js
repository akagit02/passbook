import { describe, expect, it } from "vitest";
import { topCategory, biggestCategoryJump, savingsRateNudge } from "../../src/insights/index.js";

describe("insights", () => {
  it("finds the top category", () => {
    expect(topCategory({ a: 10, b: 30 })).toEqual({ catId: "b", amount: 30 });
    expect(topCategory({})).toBeUndefined();
  });

  it("finds the biggest meaningful jump", () => {
    expect(biggestCategoryJump({ a: 150, b: 40, c: 500 }, { a: 100, b: 10, c: 0 })).toEqual({ catId: "a", delta: 50 });
    expect(biggestCategoryJump({ a: 115 }, { a: 100 })).toBeNull(); // under £20
    expect(biggestCategoryJump({ a: 1100 }, { a: 1000 })).toBeNull(); // under 15%
  });

  it("picks the savings-rate message", () => {
    expect(savingsRateNudge({ leftover: -5, putAside: 300 }, 1000).kind).toBe("overspent");
    expect(savingsRateNudge({ leftover: 100, putAside: 250 }, 1000)).toEqual({ kind: "ahead", rate: 25 });
    expect(savingsRateNudge({ leftover: 100, putAside: 150 }, 1000).kind).toBe("closer");
    expect(savingsRateNudge({ leftover: 100, putAside: 50 }, 1000).kind).toBe("low");
    expect(savingsRateNudge({ leftover: 100, putAside: 0 }, 1000).kind).toBe("nothing");
  });
});
