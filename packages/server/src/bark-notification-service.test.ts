import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BarkDeliveryError, BarkNotificationService } from "./bark-notification-service";

test("self-hosted Bark uses V2 JSON without putting the device key in the URL", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-bark-"));
  await mkdir(join(dataDir, "secrets"), { recursive: true });
  await writeFile(join(dataDir, "secrets", "bark-device-key"), "device-secret\n");
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const request = async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return new Response(JSON.stringify({ code: 200 }), { status: 200 });
  };
  const service = new BarkNotificationService(dataDir, request as typeof fetch);
  await service.push({ id: "candidate-1", title: "测试", body: "正文", url: "https://example.com/item" });
  expect(requests[0]!.url).toBe("http://127.0.0.1:18080/push");
  expect(requests[0]!.url).not.toContain("device-secret");
  expect(JSON.parse(String(requests[0]!.init?.body))).toMatchObject({
    device_key: "device-secret", id: "candidate-1", group: "Totemora 部落情报",
  });
  expect(await service.targetIds()).toEqual(["primary"]);
  expect(await service.targetIds("ai")).toEqual(["primary"]);
  expect(await service.targets()).toMatchObject([{
    id: "primary", domains: ["ai", "finance"], enabled: true,
  }]);
  expect(JSON.stringify(await service.status())).not.toContain("device-secret");
  await rm(dataDir, { recursive: true, force: true });
});

test("Bark opens a thirty-minute circuit after three retryable channel failures", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-bark-circuit-"));
  await mkdir(join(dataDir, "secrets"), { recursive: true });
  await writeFile(join(dataDir, "secrets", "bark-device-key"), "device-secret\n");
  let requests = 0;
  const service = new BarkNotificationService(dataDir, (async () => {
    requests += 1;
    return new Response("unavailable", { status: 503 });
  }) as unknown as typeof fetch);
  for (let index = 0; index < 3; index += 1) {
    await expect(service.push({ title: "测试", body: "正文" })).rejects.toBeInstanceOf(BarkDeliveryError);
  }
  expect(await service.status()).toMatchObject({
    channel_status: "open", consecutive_failures: 3, retry_after: expect.any(String),
  });
  await expect(service.push({ title: "测试", body: "正文" })).rejects.toThrow("circuit is open");
  expect(requests).toBe(3);
  await rm(dataDir, { recursive: true, force: true });
});

test("Bark routes multiple configured targets by domain and returns target receipts without secrets", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-bark-targets-"));
  await mkdir(join(dataDir, "secrets"), { recursive: true });
  await writeFile(join(dataDir, "secrets", "bark-targets.json"), JSON.stringify([
    { id: "ai-phone", device_key: "ai-device-secret", domains: ["ai"], enabled: true, server_url: "https://ai.example.test" },
    { id: "finance-phone", device_key: "finance-device-secret", domains: ["finance"], enabled: true, server_url: "https://finance.example.test" },
    { id: "disabled-phone", device_key: "disabled-device-secret", domains: ["ai", "finance"], enabled: false, server_url: "https://disabled.example.test" },
  ]));
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const service = new BarkNotificationService(dataDir, (async (input, init) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return Response.json({ code: 200 }, { status: 200 });
  }) as typeof fetch);

  expect(await service.targetIds()).toEqual(["ai-phone", "finance-phone"]);
  expect(await service.targetIds("ai")).toEqual(["ai-phone"]);
  expect(await service.targetIds("finance")).toEqual(["finance-phone"]);
  expect((await service.status(false, "ai")).targets.map((target) => target.id)).toEqual(["ai-phone", "disabled-phone"]);

  const receipt = await service.push({ domain: "finance", title: "财务", body: "正文" });
  expect(receipt).toMatchObject({ target_id: "finance-phone", status: 200, accepted: true });
  expect(requests).toMatchObject([{
    url: "https://finance.example.test/push",
    body: { device_key: "finance-device-secret" },
  }]);

  const publicState = JSON.stringify({ targets: await service.targets(), status: await service.status() });
  expect(publicState).not.toContain("device-secret");
  expect(publicState).not.toContain("authorization");
  await rm(dataDir, { recursive: true, force: true });
});

test("Bark deduplicates targets by server URL and device key while rejecting duplicate IDs", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-bark-dedupe-"));
  await mkdir(join(dataDir, "secrets"), { recursive: true });
  await writeFile(join(dataDir, "secrets", "bark-targets.json"), JSON.stringify([
    { id: "first", device_key: "same-device", domains: ["ai"], enabled: true, server_url: "https://same.example.test" },
    { id: "second", device_key: "same-device", domains: ["finance"], enabled: true, server_url: "https://same.example.test/" },
  ]));
  const service = new BarkNotificationService(
    dataDir,
    (async () => Response.json({ code: 200 })) as unknown as typeof fetch,
  );
  expect((await service.targets()).map((target) => target.id)).toEqual(["first"]);

  await writeFile(join(dataDir, "secrets", "bark-targets.json"), JSON.stringify([
    { id: "duplicate", device_key: "one", domains: ["ai"], enabled: true, server_url: "https://one.example.test" },
    { id: "duplicate", device_key: "two", domains: ["finance"], enabled: true, server_url: "https://two.example.test" },
  ]));
  await expect(service.targets()).rejects.toThrow("id is duplicated");
  await rm(dataDir, { recursive: true, force: true });
});

test("Bark isolates per-target failures and circuits", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-bark-isolation-"));
  await mkdir(join(dataDir, "secrets"), { recursive: true });
  await writeFile(join(dataDir, "secrets", "bark-targets.json"), JSON.stringify([
    { id: "unavailable", device_key: "unavailable-secret", domains: ["ai"], enabled: true, server_url: "https://unavailable.example.test" },
    { id: "healthy", device_key: "healthy-secret", domains: ["ai"], enabled: true, server_url: "https://healthy.example.test" },
  ]));
  const requests: string[] = [];
  const service = new BarkNotificationService(dataDir, (async (input) => {
    const url = String(input);
    requests.push(url);
    return url.includes("unavailable.example.test")
      ? new Response("unavailable", { status: 503 })
      : Response.json({ code: 200 }, { status: 200 });
  }) as typeof fetch);

  const first = await service.push({ domain: "ai", title: "测试", body: "正文" });
  expect(first).toMatchObject({ target_id: "healthy", accepted: true });
  expect(first.receipts).toHaveLength(1);
  expect(first.failures).toMatchObject([{ target_id: "unavailable", status: 503, retryable: true }]);
  for (let index = 0; index < 2; index += 1) {
    await expect(service.pushTo("unavailable", { title: "测试", body: "正文" })).rejects.toBeInstanceOf(BarkDeliveryError);
  }
  expect((await service.status()).targets).toMatchObject([
    { id: "unavailable", channel_status: "open", consecutive_failures: 3 },
    { id: "healthy", channel_status: "ready", consecutive_failures: 0 },
  ]);
  const beforeHealthy = requests.filter((url) => url.includes("healthy.example.test")).length;
  await service.pushTo("healthy", { title: "继续", body: "健康目标仍可发送" });
  expect(requests.filter((url) => url.includes("healthy.example.test"))).toHaveLength(beforeHealthy + 1);
  await rm(dataDir, { recursive: true, force: true });
});

test("Bark rejects unsupported domains and non-HTTPS non-local servers", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-bark-validation-"));
  await mkdir(join(dataDir, "secrets"), { recursive: true });
  await writeFile(join(dataDir, "secrets", "bark-targets.json"), JSON.stringify([
    { id: "bad-domain", device_key: "secret", domains: ["sports"], enabled: true, server_url: "https://example.test" },
  ]));
  const service = new BarkNotificationService(dataDir);
  await expect(service.status()).rejects.toThrow("unsupported domain");
  await writeFile(join(dataDir, "secrets", "bark-targets.json"), JSON.stringify([
    { id: "bad-server", device_key: "secret", domains: ["ai"], enabled: true, server_url: "http://example.test" },
  ]));
  await expect(service.status()).rejects.toThrow("HTTPS");
  await rm(dataDir, { recursive: true, force: true });
});

test("Bark management atomically stores masked targets and preserves keys on metadata updates", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-bark-management-"));
  await mkdir(join(dataDir, "secrets"), { recursive: true });
  await writeFile(join(dataDir, "secrets", "bark-device-key"), "primary-secret\n");
  let deliveryHealthy = false;
  const service = new BarkNotificationService(dataDir, (async () => (
    deliveryHealthy ? Response.json({ code: 200 }) : new Response("unavailable", { status: 503 })
  )) as unknown as typeof fetch);
  const created = await service.upsertManagedTarget({
    id: "finance-phone", label: "财经手机", device_key: "finance-secret-1234",
    domains: ["finance"], enabled: true, server_url: "http://127.0.0.1:18080",
  }, "create");
  expect(created).toMatchObject({
    id: "finance-phone", label: "财经手机", domains: ["finance"], enabled: true,
    source: "managed", key_suffix: "1234",
  });
  expect(JSON.stringify(created)).not.toContain("finance-secret");
  const targetFile = join(dataDir, "secrets", "bark-targets.json");
  expect((await stat(targetFile)).mode & 0o777).toBe(0o600);

  await expect(service.upsertManagedTarget({
    id: "finance-phone", label: "重复设备", device_key: "replacement-secret",
  }, "create")).rejects.toMatchObject({ status: 409 });
  await expect(service.upsertManagedTarget({ id: "missing-phone", enabled: false }, "update"))
    .rejects.toMatchObject({ status: 404 });
  await expect(service.upsertManagedTarget({
    id: "untrusted", label: "不可信服务", device_key: "untrusted-secret",
    server_url: "https://attacker.example.test", domains: ["ai"], enabled: true,
  }, "create")).rejects.toThrow("not allowlisted");

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await expect(service.pushTo("finance-phone", { title: "测试", body: "正文" })).rejects.toThrow();
  }
  expect((await service.status()).targets.find((target) => target.id === "finance-phone"))
    .toMatchObject({ channel_status: "open" });
  deliveryHealthy = true;
  const updated = await service.upsertManagedTarget({
    id: "finance-phone", label: "随身设备", device_key: "corrected-secret-5678",
    domains: ["ai", "finance"], enabled: true,
  }, "update");
  expect(updated).toMatchObject({ label: "随身设备", domains: ["ai", "finance"], enabled: true });
  expect(await readFile(targetFile, "utf8")).toContain("corrected-secret-5678");
  await expect(service.pushTo("finance-phone", { title: "恢复", body: "立即测试" })).resolves.toMatchObject({ accepted: true });
  expect((await service.targets()).find((target) => target.id === "primary")).toMatchObject({ source: "legacy" });
  const audit = JSON.stringify(await service.listManagementAudit());
  expect(audit).not.toContain("finance-secret");
  expect(audit).toContain("key_changed");
  await expect(service.upsertManagedTarget({ id: "primary", label: "覆盖主设备" })).rejects.toThrow("reserved");
  await rm(dataDir, { recursive: true, force: true });
});

test("Bark never returns a complete short device key", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-bark-short-key-"));
  await mkdir(join(dataDir, "secrets"), { recursive: true });
  await writeFile(join(dataDir, "secrets", "bark-device-key"), "tiny\n");
  const state = JSON.stringify(await new BarkNotificationService(dataDir).status());
  expect(state).not.toContain("tiny");
  expect(state).not.toContain("key_suffix");
  await rm(dataDir, { recursive: true, force: true });
});
