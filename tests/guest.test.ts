import { describe, expect, it } from "vitest";

import { clientAddress, utcDay, visitorId } from "@/lib/guest";

describe("clientAddress", () => {
  it("takes the first entry of x-forwarded-for", () => {
    const h = new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" });
    expect(clientAddress(h)).toBe("203.0.113.7");
  });

  it("falls back to x-real-ip", () => {
    expect(clientAddress(new Headers({ "x-real-ip": " 198.51.100.2 " }))).toBe("198.51.100.2");
  });

  it("returns null with no address headers", () => {
    expect(clientAddress(new Headers())).toBeNull();
  });
});

describe("visitorId", () => {
  it("is stable within a day and opaque", () => {
    const a = visitorId("203.0.113.7", "k", "2026-11-11");
    expect(a).toBe(visitorId("203.0.113.7", "k", "2026-11-11"));
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toContain("203");
  });

  it("changes with the day, the address and the key", () => {
    const base = visitorId("203.0.113.7", "k", "2026-11-11");
    expect(visitorId("203.0.113.7", "k", "2026-11-12")).not.toBe(base);
    expect(visitorId("203.0.113.8", "k", "2026-11-11")).not.toBe(base);
    expect(visitorId("203.0.113.7", "other", "2026-11-11")).not.toBe(base);
  });

  it("is long enough for the database check", () => {
    expect(visitorId("x", "k").length).toBeGreaterThanOrEqual(16);
  });
});

describe("utcDay", () => {
  it("formats as an ISO date in UTC", () => {
    expect(utcDay(new Date("2026-11-11T23:30:00-07:00"))).toBe("2026-11-12");
  });
});
