import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export async function loadNotifierClientConfig(input: {
  dataDir: string; baseUrl?: string; tokenFile?: string;
}): Promise<{ baseUrl?: string; operatorToken?: string }> {
  if (!input.baseUrl) return {};
  if (input.tokenFile && !isAbsolute(input.tokenFile)) throw new Error("TOTEMORA_NOTIFIER_TOKEN_FILE must be absolute");
  const path = input.tokenFile ?? resolve(input.dataDir, "secrets/notifier-token");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 1_024) {
      throw new Error("Notifier client token must be a private regular file of at most 1 KiB");
    }
    const token = (await handle.readFile("utf8")).trim();
    if (token.length < 32 || token.length > 256 || /\s/.test(token)) throw new Error("Notifier client token is invalid");
    return { baseUrl: input.baseUrl, operatorToken: token };
  } finally { await handle.close(); }
}
