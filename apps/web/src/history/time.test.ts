import { describe, expect, it } from "vitest";

import { addDays, eventDayKey, localDayBounds, localDayKey, statsDayKeys } from "./time";

describe("history time", () => {
  it("formats a local calendar day and round-trips its half-open bounds", () => {
    const noon = new Date(2026, 0, 15, 12, 30);
    expect(localDayKey(noon)).toBe("2026-01-15");

    const bounds = localDayBounds("2026-01-15");
    expect(bounds.from).toBe(new Date(2026, 0, 15).toISOString());
    expect(bounds.to).toBe(new Date(2026, 0, 16).toISOString());
  });

  it("bounds the day at local midnight and handles DST-length days", () => {
    const bounds = localDayBounds("2026-03-08");
    expect(new Date(bounds.from).getHours()).toBe(0);
    expect(new Date(bounds.to).getHours()).toBe(0);
    const hours = (Date.parse(bounds.to) - Date.parse(bounds.from)) / 3_600_000;
    expect(hours).toBeGreaterThanOrEqual(23);
    expect(hours).toBeLessThanOrEqual(25);
  });

  it("adds days across month and year boundaries", () => {
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("builds the stats window from the last seven local days plus a selected day", () => {
    expect(statsDayKeys("2026-01-15", "2026-01-15")).toEqual([
      "2026-01-09",
      "2026-01-10",
      "2026-01-11",
      "2026-01-12",
      "2026-01-13",
      "2026-01-14",
      "2026-01-15",
    ]);
    expect(statsDayKeys("2025-12-01", "2026-01-15")).toEqual([
      "2025-12-01",
      "2026-01-09",
      "2026-01-10",
      "2026-01-11",
      "2026-01-12",
      "2026-01-13",
      "2026-01-14",
      "2026-01-15",
    ]);
  });

  it("groups an event by its local received day", () => {
    const event = { receivedAt: new Date(2026, 0, 15, 23, 30).toISOString() };
    expect(eventDayKey(event)).toBe("2026-01-15");
  });
});
