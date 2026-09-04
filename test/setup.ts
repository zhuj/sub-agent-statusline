import { afterEach, vi } from "vitest";

const envKeys = [
  "NO_COLOR",
  "OPENCODE_SUBAGENT_STATUSLINE_COLOR",
];

const originalEnv = new Map(
  envKeys.map((key) => [key, process.env[key]]),
);

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();

  for (const key of envKeys) {
    const original = originalEnv.get(key);
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
});
