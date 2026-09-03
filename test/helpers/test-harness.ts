import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";

const tempDirs = new Set<string>();

export interface FileHarness {
  readonly dir: string;
  readonly statePath: string;
  readonly textPath: string;
}

export async function createFileHarness(): Promise<FileHarness> {
  const dir = await mkdtemp(join(tmpdir(), "subagent-statusline-test-"));
  tempDirs.add(dir);

  const statePath = join(dir, "state.json");
  const textPath = join(dir, "status.txt");
  process.env.OPENCODE_SUBAGENT_STATUSLINE_STATE = statePath;
  process.env.NO_COLOR = "1";

  return { dir, statePath, textPath };
}

export async function cleanupRegisteredTempDirs(): Promise<void> {
  await Promise.all(
    [...tempDirs].map(async (dir) => {
      await rm(dir, { force: true, recursive: true });
      tempDirs.delete(dir);
    }),
  );
}

export async function readJsonFixture(name: string): Promise<unknown> {
  const url = new URL(`../fixtures/events/${name}.json`, import.meta.url);
  const parsed: unknown = JSON.parse(await readFile(url, "utf8"));
  return parsed;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export function useFrozenTime(isoTimestamp: string): Date {
  const now = new Date(isoTimestamp);
  vi.useFakeTimers();
  vi.setSystemTime(now);
  return now;
}
