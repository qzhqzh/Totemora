import { expect, test } from "bun:test";

import { CpaImageProvider } from "./cpa-image";

test("CPA image provider retries a transient upstream failure and validates returned image bytes", async () => {
  let calls = 0;
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const provider = new CpaImageProvider({ id: "cpa", baseUrl: "http://127.0.0.1:31000/v1", apiKey: "secret" }, async () => {
    calls += 1;
    return calls === 1
      ? new Response('{"error":{"message":"oauth token EOF"}}', { status: 500 })
      : Response.json({ choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${png}` } }] } }] });
  });

  const result = await provider.generate({ model: "gemini-image", prompt: "one pixel" });

  expect(calls).toBe(2);
  expect(result).toMatchObject({ mimeType: "image/png", width: 1, height: 1, model: "gemini-image" });
});

test("CPA image provider refuses bearer credentials over non-loopback HTTP", async () => {
  const provider = new CpaImageProvider({ id: "cpa", baseUrl: "http://cpa.test/v1", apiKey: "secret" });
  await expect(provider.generate({ model: "gemini-image", prompt: "unsafe" }))
    .rejects.toThrow("requires HTTPS unless the endpoint is loopback");
});

test("CPA image provider rejects oversized response bodies before JSON parsing", async () => {
  const provider = new CpaImageProvider(
    { id: "cpa", baseUrl: "http://127.0.0.1:31000/v1", apiKey: "secret" },
    async () => new Response("{}", { headers: { "content-length": String(25 * 1024 * 1024) } }),
  );
  await expect(provider.generate({ model: "gemini-image", prompt: "oversized" }))
    .rejects.toThrow("exceeds 24 MiB");
});
