import { describe, expect, it } from "vitest";
import {
  NONE, presetRange, incomeForRange, paymentMethodsIn, computeFlow, pieSlices, pieGeometry
} from "../../src/moneyflow/index.js";

const now = new Date(2026, 8, 20); // 20 Sep 2026 — current pay period "2026-09" with payday on the 1st

// September: 400 housing (300 EMI on sal acc, 100 no subcategory on PCC),
// 200 shopping on PCC, 100 eating out on RCC, 50 groceries with no payment
// method, and 250 into savings from sal acc. August has one 999 expense that
// must stay out of a September range.
function fixture() {
  return {
    income: 3000,
    incomeSources: [{ payDay: 1 }],
    transactions: [
      { id: "h1", amount: 300, date: "2026-09-02", categoryId: "housing", subcategoryId: "emi", paymentMethod: "sal acc" },
      { id: "h2", amount: 100, date: "2026-09-03", categoryId: "housing", subcategoryId: null, paymentMethod: "PCC" },
      { id: "s1", amount: 200, date: "2026-09-05", categoryId: "shopping", paymentMethod: "PCC" },
      { id: "e1", amount: 100, date: "2026-09-06", categoryId: "eating_out", paymentMethod: "RCC" },
      { id: "g1", amount: 50, date: "2026-09-07", categoryId: "groceries", paymentMethod: "" },
      { id: "v1", amount: 250, date: "2026-09-10", categoryId: "savings", paymentMethod: "sal acc" },
      { id: "old", amount: 999, date: "2026-08-20", categoryId: "shopping", paymentMethod: "PCC" }
    ],
    savingsContributions: [{ id: "c1", transactionId: "v1", amount: 250, date: "2026-09-10", vehicle: "cash_isa" }]
  };
}

const sep = { start: "2026-09-01", end: "2026-10-01", view: "overview", categoryId: "", subcategoryId: "", paymentMethod: "" };
function flow(over) { return computeFlow(fixture(), Object.assign({}, sep, over), 1); }
function amounts(f) { return f.slices.map((s) => [s.key, s.amount]); }

describe("money flow ranges", () => {
  it("resolves presets to pay periods, end exclusive", () => {
    expect(presetRange("current", 1, now)).toEqual({ start: "2026-09-01", end: "2026-10-01" });
    expect(presetRange("last", 1, now)).toEqual({ start: "2026-08-01", end: "2026-09-01" });
    expect(presetRange("3", 1, now)).toEqual({ start: "2026-06-01", end: "2026-09-01" });
    expect(presetRange("current", 25, now)).toEqual({ start: "2026-08-25", end: "2026-09-25" });
  });

  it("counts income once per pay period and pro rata for part of one", () => {
    expect(incomeForRange(3000, "2026-09-01", "2026-10-01", 1)).toBe(3000);
    expect(incomeForRange(3000, "2026-06-01", "2026-09-01", 1)).toBe(9000);
    expect(incomeForRange(3000, "2026-09-01", "2026-09-16", 1)).toBe(1500); // 15 of 30 days
    expect(incomeForRange(3000, "2026-08-25", "2026-09-25", 25)).toBe(3000);
    expect(incomeForRange(null, "2026-09-01", "2026-10-01", 1)).toBe(null);
  });

  it("lists built-in payment methods first, then anything else typed in", () => {
    const methods = paymentMethodsIn([{ paymentMethod: "Monzo" }, { paymentMethod: "PCC" }, { paymentMethod: "" }, { paymentMethod: "Amex" }]);
    expect(methods).toEqual(["PCC", "RCC", "sal acc", "wife sal acc", "cur acc", "Amex", "Monzo"]);
  });
});

describe("money flow levels", () => {
  it("top level splits income into spending, savings and what's left", () => {
    const f = flow();
    expect(f.dimension).toBe("overview");
    expect(amounts(f)).toEqual([["spending", 750], ["savings", 250], ["unspent", 2000]]);
    expect(f).toMatchObject({ income: 3000, spent: 750, saved: 250, unspent: 2000, total: 3000 });
  });

  it("drops the leftover slice when more went out than came in", () => {
    const st = fixture();
    st.income = 500;
    const f = computeFlow(st, sep, 1);
    expect(amounts(f)).toEqual([["spending", 750], ["savings", 250]]);
    expect(f.unspent).toBe(-500);
  });

  it("has no income figure without income set or once a payment method is picked", () => {
    const st = fixture();
    st.income = null;
    expect(computeFlow(st, sep, 1).income).toBe(null);
    const f = flow({ paymentMethod: "sal acc" });
    expect(f.income).toBe(null);
    expect(amounts(f)).toEqual([["spending", 300], ["savings", 250]]);
  });

  it("splits spending by category, largest first, leaving savings out", () => {
    const f = flow({ view: "category" });
    expect(f.dimension).toBe("category");
    expect(amounts(f)).toEqual([["housing", 400], ["shopping", 200], ["eating_out", 100], ["groceries", 50]]);
    expect(f.slices[0].drill).toEqual({ categoryId: "housing" });
    expect(f.total).toBe(750);
  });

  it("splits a category by subcategory, then a subcategory by who paid", () => {
    const subs = flow({ view: "category", categoryId: "housing" });
    expect(subs.dimension).toBe("subcategory");
    expect(amounts(subs)).toEqual([["emi", 300], [NONE, 100]]);
    expect(subs.slices.map((s) => s.label)).toEqual(["EMI", "No subcategory"]);

    const paid = flow({ view: "category", categoryId: "housing", subcategoryId: NONE });
    expect(paid.dimension).toBe("payment");
    expect(amounts(paid)).toEqual([["PCC", 100]]);
  });

  it("goes straight to who paid for a category with no subcategories", () => {
    const f = flow({ view: "category", categoryId: "shopping" });
    expect(f.dimension).toBe("payment");
    expect(amounts(f)).toEqual([["PCC", 200]]);
  });

  it("splits spending by card or account, with unrecorded ones grouped", () => {
    const f = flow({ view: "payment" });
    expect(amounts(f)).toEqual([["PCC", 300], ["sal acc", 300], ["RCC", 100], [NONE, 50]]);
    expect(f.slices[3].label).toBe("Not recorded");
  });

  it("filters by payment method without repainting the categories left", () => {
    const all = flow({ view: "category" });
    const pcc = flow({ view: "category", paymentMethod: "PCC" });
    expect(amounts(pcc)).toEqual([["shopping", 200], ["housing", 100]]);
    const colorOf = (f, key) => f.slices.find((s) => s.key === key).color;
    expect(colorOf(pcc, "shopping")).toBe(colorOf(all, "shopping"));
    expect(amounts(flow({ view: "category", paymentMethod: NONE }))).toEqual([["groceries", 50]]);
  });

  it("splits savings by where the money went", () => {
    const f = flow({ view: "savings" });
    expect(f.dimension).toBe("vehicle");
    expect(f.slices.map((s) => [s.label, s.amount])).toEqual([["Cash ISA", 250]]);
  });

  it("returns no slices for an empty range", () => {
    const f = flow({ start: "2025-01-01", end: "2025-02-01", view: "category" });
    expect(f.slices).toEqual([]);
    expect(f.total).toBe(0);
  });
});

describe("pie drawing", () => {
  it("folds the tail into one slice past the limit, keeping the total", () => {
    const slices = [50, 40, 30, 20, 10, 5, 3, 2].map((amount, i) => ({ key: "k" + i, label: "L" + i, amount, count: 1, color: i + 1 }));
    const drawn = pieSlices(slices, 6);
    expect(drawn).toHaveLength(6);
    expect(drawn[5]).toMatchObject({ key: "__rest", amount: 10, count: 3, color: 0, label: "3 smaller ones" });
    expect(pieSlices(slices.slice(0, 6), 6)).toHaveLength(6);
  });

  it("gives each wedge its share and draws a lone slice as a full circle", () => {
    const geo = pieGeometry([75, 25], 100, 100, 100);
    expect(geo.map((g) => g.share)).toEqual([0.75, 0.25]);
    expect(geo[0].d).toBe("M100 100 L100.00 0.00 A100 100 0 1 1 0.00 100.00 Z");
    expect(geo[1].d).toBe("M100 100 L0.00 100.00 A100 100 0 0 1 100.00 0.00 Z");

    const whole = pieGeometry([10], 100, 100, 100);
    expect(whole[0].share).toBe(1);
    expect(whole[0].d.match(/A/g)).toHaveLength(2);
  });
});
