import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NtfyForwardedSourceClient } from "./ntfy-forwarded-source-client";

test("forwarded source accepts the legacy scheme-less HTTPS format and parses bounded ntfy NDJSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "totemora-forwarded-source-"));
  const credentialsFile = join(root, "source");
  await writeFile(credentialsFile, "notify.example/private-topic\nuser\npassword\n", { mode: 0o600 });
  let authorization = "";
  try {
    const client = new NtfyForwardedSourceClient({
      credentialsFile,
      fetchImpl: async (url, init) => {
        expect(String(url)).toBe("https://notify.example/private-topic/json?poll=1&since=100");
        authorization = String(new Headers(init?.headers).get("authorization"));
        return new Response([
          JSON.stringify({ event: "open", time: 100 }),
          JSON.stringify({
            event: "message", id: "m-1", time: 101, title: "Title", message: "Body",
            priority: 4, tags: ["warning"], click: "https://example.com/story", icon: "https://img.example/icon.png",
          }),
        ].join("\n"));
      },
    });
    expect(await client.configured()).toBe(true);
    expect(await client.collect(100)).toEqual([expect.objectContaining({
      source_id: "legacy-forwarded", source_message_id: "m-1", title: "Title", body: "Body",
      priority: 4, tags: ["warning"], occurred_at: "1970-01-01T00:01:41.000Z",
    })]);
    expect(authorization).toMatch(/^Basic /);
    expect(JSON.stringify(await client.collect(100))).not.toContain("password");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("forwarded source rejects broad permissions, insecure URLs, and malformed events", async () => {
  const root = await mkdtemp(join(tmpdir(), "totemora-forwarded-source-safety-"));
  const credentialsFile = join(root, "source");
  try {
    await writeFile(credentialsFile, "https://notify.example/topic\nuser\npassword\n", { mode: 0o600 });
    await chmod(credentialsFile, 0o644);
    await expect(new NtfyForwardedSourceClient({ credentialsFile }).configured()).rejects.toThrow("owner-only");
    await chmod(credentialsFile, 0o600);
    await writeFile(credentialsFile, "http://notify.example/topic\nuser\npassword\n", { mode: 0o600 });
    await expect(new NtfyForwardedSourceClient({ credentialsFile }).configured()).rejects.toThrow("HTTPS");
    await writeFile(credentialsFile, "https://notify.example/topic\nuser\npassword\n", { mode: 0o600 });
    const malformed = new NtfyForwardedSourceClient({
      credentialsFile,
      fetchImpl: async () => new Response(JSON.stringify({ event: "message", id: "m-1", time: "bad", message: "Body" })),
    });
    await expect(malformed.collect(0)).rejects.toMatchObject({ kind: "invalid_response" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("invalid and oversized source responses are bounded and do not expose upstream content", async () => {
  const root = await mkdtemp(join(tmpdir(), "totemora-forwarded-response-"));
  const credentialsFile = join(root, "source");
  try {
    await writeFile(credentialsFile, "https://notify.example/topic\nuser\npassword\n", { mode: 0o600 });
    const bodies = [
      "private invalid NDJSON payload",
      "x".repeat(2 * 1024 * 1024 + 1),
      Array.from({ length: 101 }, (_, i) => JSON.stringify({ event: "message", id: `m-${i}`, time: 100, message: "Body" })).join("\n"),
    ];
    for (const body of bodies) {
      const client = new NtfyForwardedSourceClient({ credentialsFile, fetchImpl: async () => new Response(body) });
      await expect(client.collect(0)).rejects.toMatchObject({ kind: "invalid_response" });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("forwarded source reports TLS failures without leaking its private topic or credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "totemora-forwarded-tls-"));
  const credentialsFile = join(root, "source");
  try {
    await writeFile(credentialsFile, "https://notify.example/private-topic\nuser\nprivate-password\n", { mode: 0o600 });
    const client = new NtfyForwardedSourceClient({
      credentialsFile,
      fetchImpl: async (_url, init) => {
        expect(init?.redirect).toBe("error");
        expect(init).not.toHaveProperty("tls");
        throw new TypeError("fetch failed https://notify.example/private-topic", {
          cause: Object.assign(new Error("certificate expired private-password"), { code: "CERT_HAS_EXPIRED" }),
        });
      },
    });
    await expect(client.collect(0)).rejects.toMatchObject({ kind: "certificate" });
    try { await client.collect(0); } catch (error) {
      expect(String(error)).toContain("certificate");
      expect(String(error)).not.toContain("private-topic");
      expect(String(error)).not.toContain("private-password");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("forwarded source distinguishes rejected credentials from transient upstream failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "totemora-forwarded-http-"));
  const credentialsFile = join(root, "source");
  try {
    await writeFile(credentialsFile, "https://notify.example/topic\nuser\npassword\n", { mode: 0o600 });
    for (const [status, kind] of [[401, "authentication"], [403, "authentication"], [429, "unavailable"], [503, "unavailable"]] as const) {
      const client = new NtfyForwardedSourceClient({ credentialsFile, fetchImpl: async () => new Response("private body", { status }) });
      await expect(client.collect(0)).rejects.toMatchObject({ kind });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
