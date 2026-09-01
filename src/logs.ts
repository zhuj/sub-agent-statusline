import { open } from "node:fs/promises";

const MAX_LOG_READ_BYTES = 1024 * 1024;

export async function readOpenCodeLogFileIfSmall(
  path: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (signal?.aborted) return undefined;

  try {
    const file = await open(path, "r");
    try {
      const stats = await file.stat();
      if (!stats.isFile() || stats.size > MAX_LOG_READ_BYTES || signal?.aborted) {
        return undefined;
      }

      const contents = Buffer.alloc(stats.size);
      const { bytesRead } = await file.read(contents, 0, stats.size, 0);
      if (signal?.aborted) return undefined;
      return contents.subarray(0, bytesRead).toString("utf8");
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof Error) return undefined;
    throw error;
  }
}
