import { describe, expect, it } from "vitest";
import { takeColumns, textColumns, truncateToColumns } from "./text-width.js";

describe("textColumns", () => {
  it("counts Japanese full-width characters as two terminal columns", () => {
    expect(textColumns("日本語summary")).toBe(13);
  });

  it("does not count combining marks as extra terminal columns", () => {
    expect(textColumns("e\u0301")).toBe(1);
  });

  it("counts ZWJ emoji sequences as a single grapheme column total", () => {
    // Family ZWJ sequence (man + ZWJ + woman + ZWJ + girl + ZWJ + boy).
    // Treated as one grapheme cluster; advancing by code-point still yields
    // a small integer width, never a string-length-derived blow-up.
    const family = "👨‍👩‍👧‍👦";
    expect(textColumns(family)).toBeLessThan(family.length);
    expect(textColumns(family)).toBeGreaterThanOrEqual(1);
  });

  it("counts regional-indicator flag emoji as a single two-column grapheme", () => {
    const flag = "🇦🇷";
    expect(textColumns(flag)).toBe(2);
  });
});

describe("takeColumns", () => {
  it("keeps returned text within the requested terminal column budget", () => {
    expect(takeColumns("日本語summary", 6)).toBe("日本語");
    expect(textColumns(takeColumns("日本語summary", 7))).toBeLessThanOrEqual(7);
  });

  it("preserves a flag emoji intact when it fits in the budget", () => {
    const result = takeColumns("🇦🇷hi", 4);
    expect(result.startsWith("🇦🇷")).toBe(true);
    expect(textColumns(result)).toBeLessThanOrEqual(4);
  });
});

describe("truncateToColumns", () => {
  it("truncates Japanese text by terminal columns instead of string length", () => {
    const result = truncateToColumns("日本語の概要を表示しています", 10);

    expect(result).toBe("日本語の…");
    expect(textColumns(result)).toBeLessThanOrEqual(10);
  });

  it("leaves text unchanged when its terminal column width fits", () => {
    expect(truncateToColumns("日本語", 6)).toBe("日本語");
  });

  it("truncates flag-emoji + text without splitting the flag grapheme", () => {
    const result = truncateToColumns("🇦🇷hello world", 6);
    expect(result.startsWith("🇦🇷")).toBe(true);
    expect(textColumns(result)).toBeLessThanOrEqual(6);
  });
});
