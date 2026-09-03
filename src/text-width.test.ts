import { describe, expect, it } from "vitest";
import { takeColumns, textColumns, truncateToColumns } from "./text-width.js";

describe("textColumns", () => {
  it("counts Japanese full-width characters as two terminal columns", () => {
    expect(textColumns("日本語summary")).toBe(13);
  });

  it("does not count combining marks as extra terminal columns", () => {
    expect(textColumns("e\u0301")).toBe(1);
  });

  it("counts a family ZWJ grapheme as two terminal columns", () => {
    // Given
    const family = "👨‍👩‍👧‍👦";

    // When
    const columns = textColumns(family);

    // Then
    expect(columns).toBe(2);
  });

  it("counts an emoji modifier grapheme as two terminal columns", () => {
    // Given
    const thumbsUp = "👍🏽";

    // When
    const columns = textColumns(thumbsUp);

    // Then
    expect(columns).toBe(2);
  });

  it("counts regional-indicator flag emoji as a single two-column grapheme", () => {
    const flag = "🇦🇷";
    expect(textColumns(flag)).toBe(2);
  });

  it("counts a keycap grapheme as two terminal columns", () => {
    // Given / When / Then
    expect(textColumns("1️⃣")).toBe(2);
  });

  it("preserves ASCII and ambiguous-width characters as one column each", () => {
    // Given / When / Then
    expect(textColumns("A·Ω")).toBe(3);
  });

  it("distinguishes text and emoji presentation for pictographic symbols", () => {
    // Given / When / Then
    expect(textColumns("♥")).toBe(1);
    expect(textColumns("♥️")).toBe(2);
  });

  it("keeps controls and standalone zero-width code points at zero columns", () => {
    // Given / When / Then
    expect(textColumns("\u0000\u001f\u007f\u200d")).toBe(0);
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

  it("returns a complete family grapheme when it exactly fits", () => {
    // Given / When
    const result = takeColumns("👨‍👩‍👧‍👦x", 2);

    // Then
    expect(result).toBe("👨‍👩‍👧‍👦");
  });

  it("returns a complete emoji modifier grapheme when it exactly fits", () => {
    // Given / When
    const result = takeColumns("👍🏽x", 2);

    // Then
    expect(result).toBe("👍🏽");
  });

  it("keeps a regional-indicator flag atomic at its width boundary", () => {
    // Given
    const value = "🇦🇷x";

    // When / Then
    expect(takeColumns(value, 1)).toBe("");
    expect(takeColumns(value, 2)).toBe("🇦🇷");
  });

  it("keeps a keycap grapheme atomic at its width boundary", () => {
    // Given
    const value = "1️⃣x";

    // When / Then
    expect(takeColumns(value, 1)).toBe("");
    expect(takeColumns(value, 2)).toBe("1️⃣");
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
