import { resolve } from "node:path";

const rootAssets = new Set(["index.html", "app.js", "styles.css"]);
const moduleAsset = /^(?:features|shared)\/[a-z0-9]+(?:-[a-z0-9]+)*\.js$/;

export function resolveWebAsset(webRoot: string, pathname: string): string | undefined {
  const fileName = pathname === "/" || pathname === "/skills" || pathname === "/skills/"
    ? "index.html"
    : pathname.startsWith("/") ? pathname.slice(1) : pathname;
  if (!rootAssets.has(fileName) && !moduleAsset.test(fileName)) return undefined;
  return resolve(webRoot, fileName);
}
