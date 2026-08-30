import { resolve } from "node:path";

const rootAssets = new Set(["index.html", "codex.html", "app.js", "codex-app.js", "styles.css", "codex-styles.css"]);
const moduleAsset = /^(?:features|shared)\/[a-z0-9]+(?:-[a-z0-9]+)*\.js$/;

export function resolveWebAsset(webRoot: string, pathname: string): string | undefined {
  const fileName = pathname === "/codex" || pathname === "/codex/"
    ? "codex.html"
    : pathname === "/" || pathname === "/skills" || pathname === "/skills/" ? "index.html"
    : pathname.startsWith("/") ? pathname.slice(1) : pathname;
  if (!rootAssets.has(fileName) && !moduleAsset.test(fileName)) return undefined;
  return resolve(webRoot, fileName);
}
