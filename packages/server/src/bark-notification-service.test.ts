import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
