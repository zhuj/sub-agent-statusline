import { afterEach } from "vitest";
import { __resetLocaleForTests } from "../src/i18n.js";
import { cleanupRegisteredTempDirs } from "./helpers/runtime-harness.js";

const envKeys = [
  "NO_COLOR",
  "OPENCODE_SUBAGENT_STATUSLINE_COLOR",
  "OPENCODE_SUBAGENT_STATUSLINE_INSTANCE",
  "OPENCODE_SUBAGENT_STATUSLINE_PRESERVE_STATE",
  "OPENCODE_SUBAGENT_STATUSLINE_STATE",
  "OPENCODE_SUBAGENT_STATUSLINE_OPENCODE_DB",
  "OPENCODE_SUBAGENT_STATUSLINE_STALE_RUNNING_MS",
  "OPENCODE_SUBAGENT_STATUSLINE_DEBUG_EVENTS",
  "XDG_RUNTIME_DIR",
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

  __resetLocaleForTests();
  await cleanupRegisteredTempDirs();
});
