import { readFile } from "node:fs/promises";
import { vi } from "vitest";

export async function readJsonFixture<T>(name: string): Promise<T> {
  const url = new URL(`../fixtures/events/${name}.json`, import.meta.url);
  return JSON.parse(await readFile(url, "utf8")) as T;
}

export function useFrozenTime(isoTimestamp: string): Date {
  const now = new Date(isoTimestamp);
  vi.useFakeTimers();
  vi.setSystemTime(now);
  return now;
}
