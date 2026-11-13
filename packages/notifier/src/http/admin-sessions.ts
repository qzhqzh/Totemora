import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { HttpError, json, readJson } from "./http-boundary";

const SESSION_AGE_SECONDS = 12 * 60 * 60;
const COOKIE = "notifier_admin";

export class AdminSessions {
  private readonly sessions = new Map<string, number>();
  constructor(private readonly operatorToken: string) {}

  async route(request: Request, url: URL): Promise<Response | undefined> {
    if (url.pathname === "/admin/api/session" && request.method === "GET") {
      return json({ authenticated: this.authorized(request) });
    }
    if (url.pathname === "/admin/api/login" && request.method === "POST") {
      checkOrigin(request, url);
      const payload = await readJson(request, 1_024);
      if (!payload || typeof payload !== "object" || Array.isArray(payload)
        || Object.keys(payload).some((key) => key !== "token")
        || typeof (payload as { token?: unknown }).token !== "string"
        || !constantEqual((payload as { token: string }).token, this.operatorToken)) {
        throw new HttpError(401, "Invalid operator credential");
      }
      for (const [key, expiry] of this.sessions) if (expiry <= Date.now()) this.sessions.delete(key);
      if (this.sessions.size >= 128) throw new HttpError(429, "Too many admin sessions");
      const secret = randomBytes(32).toString("base64url");
      this.sessions.set(secret, Date.now() + SESSION_AGE_SECONDS * 1_000);
      const response = json({ authenticated: true });
      response.headers.set("Set-Cookie", cookie(secret, url, request, SESSION_AGE_SECONDS));
      return response;
    }
    if (url.pathname === "/admin/api/logout" && request.method === "POST") {
      checkOrigin(request, url);
      const secret = getCookie(request);
      if (secret) this.sessions.delete(secret);
      const response = json({ authenticated: false });
      response.headers.set("Set-Cookie", cookie("", url, request, 0));
      return response;
    }
    return undefined;
  }

  require(request: Request, url: URL): void {
    if (!this.authorized(request)) throw new HttpError(401, "Operator session required");
    if (!["GET", "HEAD"].includes(request.method)) checkOrigin(request, url);
  }

  private authorized(request: Request): boolean {
    const secret = getCookie(request);
    if (!secret) return false;
    const expiry = this.sessions.get(secret);
    if (!expiry) return false;
    if (expiry <= Date.now()) { this.sessions.delete(secret); return false; }
    return true;
  }
}

export function checkOrigin(request: Request, url: URL): void {
  const origin = request.headers.get("origin");
  const forwardedHttps = request.headers.get("x-forwarded-proto") === "https";
  if (!origin || origin !== url.origin
    && !(forwardedHttps && origin === `https://${url.host}`)) {
    throw new HttpError(403, "Same-origin request required");
  }
}

function getCookie(request: Request): string | undefined {
  const match = request.headers.get("cookie")?.match(/(?:^|;\s*)notifier_admin=([A-Za-z0-9_-]{43})(?:;|$)/);
  return match?.[1];
}

function cookie(secret: string, url: URL, request: Request, age: number): string {
  const secure = url.protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
  return `${COOKIE}=${secret}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? "; Secure" : ""}`;
}

function constantEqual(value: string, expected: string): boolean {
  const first = createHash("sha256").update(value).digest();
  const second = createHash("sha256").update(expected).digest();
  return timingSafeEqual(first, second);
}
