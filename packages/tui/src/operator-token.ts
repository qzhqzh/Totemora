import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function readOperatorToken(dataDir?: string): string | undefined {
  try {
    return readFileSync(resolve(dataDir ?? ".totemora", "operator-token"), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}
