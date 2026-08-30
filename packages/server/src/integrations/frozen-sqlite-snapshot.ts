import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";

export async function sha256FrozenSqliteSnapshot(input: {
  sourcePath: string;
  label: string;
  maximumBytes: number;
}): Promise<string> {
  const activeWal = await stat(`${input.sourcePath}-wal`).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  });
  if (activeWal?.size) throw new Error(`${input.label} requires a frozen SQLite backup without an active WAL`);
  let handle: Awaited<ReturnType<typeof open>>;
  try { handle = await open(input.sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { throw new Error(`Unable to open ${input.label.toLowerCase()} (${nodeCode(error)})`); }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error(`${input.label} must be a regular file`);
    if (metadata.size < 1 || metadata.size > input.maximumBytes) {
      throw new Error(`${input.label} must contain 1-${input.maximumBytes} bytes`);
    }
    return createHash("sha256").update(await handle.readFile()).digest("hex");
  } finally {
    await handle.close();
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function nodeCode(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "unknown";
}
