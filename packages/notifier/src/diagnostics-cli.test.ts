import { expect, test, spyOn } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDiagnostics } from "./diagnostics-cli";

test("CLI reads private token, shows statuses without event text and targets one configured alias", async () => {
  const dir = await mkdtemp(join(tmpdir(), "notifier-doctor-"));
  const tokenPath = join(dir, "operator-token");
  const token = "operator-secret-" + "x".repeat(48);
  await writeFile(tokenPath, token, { mode: 0o600 });
  const logged: string[] = [];
  const log = spyOn(console, "log").mockImplementation((value: string) => { logged.push(value); });
  const calls: Array<{ path: string; body?: Record<string, unknown> }> = [];
  const mockFetch = (async (value: string | URL | Request, options?: RequestInit) => {
    const path = new URL(value.toString()).pathname;
    expect(options?.headers).toMatchObject({ authorization: `Bearer ${token}` });
    const body = options?.body ? JSON.parse(String(options.body)) as Record<string, unknown> : undefined;
    calls.push({ path, ...(body ? { body } : {}) });
    if (path.endsWith("/events")) return Response.json({ events: [{ event_uuid: "e", status: "failed", title: "private title", body: "private text" }] });
    return Response.json({ status: "completed", deliveries: [{ channel: "bark", target_id: "phone", status: "completed" }] });
  }) as typeof fetch;
  try {
    expect(await runDiagnostics(["events", "--token-file", tokenPath], mockFetch)).toBe(0);
    expect(logged.join("\n")).not.toContain("private text");
    expect(logged.join("\n")).not.toContain("private title");
    expect(await runDiagnostics(["test", "ai", "bark:phone", "smoke-1", "--token-file", tokenPath], mockFetch)).toBe(0);
    expect(calls[1]).toMatchObject({ path: "/api/v1/test", body: { target_id: "phone", channel: "bark", domain: "ai" } });
    expect(logged.join("\n")).not.toContain(token);
  } finally { log.mockRestore(); await rm(dir, { recursive: true, force: true }); }
});
