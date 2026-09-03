import { access, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readPackage = async (): Promise<Record<string, unknown>> => {
  const parsed: unknown = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  if (!isRecord(parsed)) {
    throw new TypeError("package.json must contain an object");
  }
  return parsed;
};

describe("published package contract", () => {
  it("exports only the root and TUI entrypoints", async () => {
    // Given
    const packageJson = await readPackage();

    // When
    const exportsField = packageJson["exports"];

    // Then
    expect(exportsField).toEqual({
      ".": { types: "./dist/tui.d.ts", import: "./dist/tui.js" },
      "./tui": { types: "./dist/tui.d.ts", import: "./dist/tui.js" },
    });
  });

  it("has no runtime source or runtime integration test", async () => {
    // Given
    const paths = [
      new URL("../src/index.ts", import.meta.url),
      new URL("./index.integration.test.ts", import.meta.url),
    ];

    // When
    const results = await Promise.allSettled(paths.map((path) => access(path)));

    // Then
    expect(results.every(({ status }) => status === "rejected")).toBe(true);
  });
});
