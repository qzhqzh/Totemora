import { readFile } from "node:fs/promises";

const ASSETS: Map<string, readonly [string, string]> = new Map([
  ["/admin/", ["index.html", "text/html; charset=utf-8"]],
  ["/admin/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/admin/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/admin/api.js", ["api.js", "text/javascript; charset=utf-8"]],
  ["/admin/targets.js", ["targets.js", "text/javascript; charset=utf-8"]],
  ["/admin/operations.js", ["operations.js", "text/javascript; charset=utf-8"]],
  ["/admin/favicon.svg", ["favicon.svg", "image/svg+xml"]],
] as const);

/** Only these shipped files are public; the HTML contains no token or private configuration. */
export async function adminAsset(pathname: string, method: string): Promise<Response | undefined> {
  if (pathname === "/admin" && method === "GET") {
    return new Response(null, { status: 308, headers: { Location: "/admin/", "Cache-Control": "no-store" } });
  }
  if (method !== "GET" && method !== "HEAD") return undefined;
  const file = ASSETS.get(pathname);
  if (!file) return undefined;
  const content = await readFile(new URL(`../../admin/${file[0]}`, import.meta.url));
  return new Response(method === "HEAD" ? null : content, { headers: {
    "Content-Type": file[1], "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  } });
}
