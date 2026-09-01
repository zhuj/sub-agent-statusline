import { describe, expect, it } from "vitest";
import {
  __tuiPluginForTests,
  escapeSqlStringForTesting,
} from "../src/tui.js";

/**
 * Lightweight smoke tests for the TUI plugin's public surface and the
 * internal helpers that the plugin exports for testability. These tests do
 * NOT exercise the full createRoot side effects because that requires a
 * real OpenTUI renderer — instead they assert the minimum structural
 * contract the plugin must honor.
 */
describe("TUI plugin exports", () => {
  it("exposes a default plugin module with the expected id and tui entrypoint", async () => {
    const mod = await import("../src/tui.js");
    expect(mod.default).toBeDefined();
    expect(mod.default.id).toBe("subagent-statusline.tui");
    expect(typeof mod.default.tui).toBe("function");
  });

  it("exposes a callable plugin factory export for tests", () => {
    expect(typeof __tuiPluginForTests).toBe("function");
  });
});

describe("escapeSqlStringForTesting", () => {
  it("doubles single quotes for safe SQL literal embedding", () => {
    expect(escapeSqlStringForTesting("a'b")).toBe("a''b");
  });
});