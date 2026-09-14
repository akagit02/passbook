import { describe, expect, it } from "vitest";
import {
  cycleStartDay, periodStartStr, periodEndStr, periodLabel, dateRangeLabel, currentPeriodKey,
  customRangeEndExclusive, txInRange, txSince, patternsWindowStart, patternsPriorWindowRange
} from "../../src/periods/index.js";

describe("periods", () => {
  it("cycle starts on the earliest numeric payday, defaulting to the 1st", () => {
    expect(cycleStartDay([{ payDay: 25 }, { payDay: 15 }, { payDay: null }])).toBe(15);
    expect(cycleStartDay([])).toBe(1);
    expect(cycleStartDay(undefined)).toBe(1);
  });

  it("clamps the period start to the month's last day", () => {
    expect(periodStartStr("2026-02", 31)).toBe("2026-02-28");
    expect(periodStartStr("2026-08", 15)).toBe("2026-08-15");
    expect(periodEndStr("2026-08", 15)).toBe("2026-09-15");
    expect(periodEndStr("2026-12", 15)).toBe("2027-01-15");
  });

  it("labels a period from its start to the day before the next one", () => {
    expect(periodLabel("2026-08", 15)).toBe(dateRangeLabel(new Date(2026, 7, 15), new Date(2026, 8, 14)));
  });

  it("current period key rolls back before the cycle start day", () => {
    expect(currentPeriodKey(15, new Date(2026, 8, 20))).toBe("2026-09");
    expect(currentPeriodKey(15, new Date(2026, 8, 15))).toBe("2026-09");
    expect(currentPeriodKey(15, new Date(2026, 8, 10))).toBe("2026-08");
    expect(currentPeriodKey(15, new Date(2026, 0, 3))).toBe("2025-12");
  });

  it("custom range end is exclusive (day after the inclusive end)", () => {
    expect(customRangeEndExclusive({ start: "2026-09-01", end: "2026-09-30" })).toBe("2026-10-01");
  });

  it("filters transactions by date range", () => {
    const txs = [{ date: "2026-08-31" }, { date: "2026-09-01" }, { date: "2026-09-15" }];
    expect(txInRange(txs, "2026-09-01", "2026-09-15")).toEqual([{ date: "2026-09-01" }]);
    expect(txSince(txs, "2026-09-01")).toHaveLength(2);
    const copy = txSince(txs, null);
    expect(copy).toEqual(txs);
    expect(copy).not.toBe(txs);
  });

  it("patterns windows", () => {
    const now = new Date(2026, 8, 20);
    expect(patternsWindowStart("all", now)).toBeNull();
    expect(patternsWindowStart("3", now)).toBe("2026-06-20");
    expect(patternsPriorWindowRange("all", now)).toBeNull();
    expect(patternsPriorWindowRange("3", now)).toEqual({ start: "2026-03-20", end: "2026-06-20" });
  });
});
