import { expect, test } from "bun:test";

import { DealsSourceClient, parseDealsFragment } from "./deals-source-client";
import { DealSourceAccessBlockedError } from "../domains/deals/deal-retry";

const FRAGMENT = `
<li class="clearfix ui-border-b"><a href="d.aspx?id=123&f=weixinlist">
<div class="pic"><img src="https://img.example/a.jpg"></div>
<div class="clearfix info"><div class="title">测试商品 <br><span>9.9元包邮</span></div>
<div class="other"><span class="mall">京东商城 | 08-23 02:19</span></div></div></a></li>`;

test("deals source parser preserves the legacy public-card semantics", async () => {
  const item = (await parseDealsFragment(FRAGMENT))[0]!;
  expect(item).toEqual({
    source_id: "123",
    title: "测试商品",
    deal_text: "9.9元包邮",
    merchant: "京东商城 | 08-23 02:19",
    source_url: "https://m.tuihaowu.com/d.aspx?id=123&f=weixinlist",
    image_url: "https://img.example/a.jpg",
    source_rank: 1,
  });
});

test("deals source parser refuses an off-origin product link", async () => {
  const external = FRAGMENT.replace("d.aspx?id=123&f=weixinlist", "https://attacker.example/deal?id=123");
  await expect(parseDealsFragment(external)).rejects.toThrow("no longer contains valid items");
});

test("deals source client bounds and validates the upstream payload", async () => {
  const client = new DealsSourceClient({
    fetchImpl: async (url, init) => {
      expect(String(url)).toContain("method=get_list");
      expect(init?.redirect).toBe("manual");
      return new Response(JSON.stringify({ code: 1, data: { html: FRAGMENT } }), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  expect(await client.collect()).toHaveLength(1);
  await expect(new DealsSourceClient({
    fetchImpl: async () => new Response('{"code":0}', { status: 200 }),
  }).collect()).rejects.toThrow("unsupported payload");
  expect(() => new DealsSourceClient({ sourceUrl: "http://example.com" })).toThrow("HTTPS");
});

test("deals source follows a bounded same-origin HTTPS redirect with one timeout budget", async () => {
  const requests: string[] = [];
  const signals: Array<AbortSignal | null | undefined> = [];
  const client = new DealsSourceClient({
    fetchImpl: async (url, init) => {
      requests.push(String(url));
      signals.push(init?.signal);
      expect(init?.redirect).toBe("manual");
      return requests.length === 1
        ? new Response(null, { status: 302, headers: { location: "/new/list?method=get_list" } })
        : new Response(JSON.stringify({ code: 1, data: { html: FRAGMENT } }));
    },
  });
  const items = await client.collect();
  expect(requests).toHaveLength(2);
  expect(requests[1]).toBe("https://m.tuihaowu.com/new/list?method=get_list");
  expect(signals[0]).toBe(signals[1]);
  expect(items[0]!.source_url).toBe("https://m.tuihaowu.com/new/d.aspx?id=123&f=weixinlist");
});

test("deals source reports the live verification redirect without following it or exposing its query", async () => {
  let calls = 0;
  const client = new DealsSourceClient({
    fetchImpl: async () => {
      calls += 1;
      return new Response(null, { status: 302, headers: {
        location: "https://alival.manmanbuy.com/verify.html?url=private-context&clientIp=192.0.2.1",
      } });
    },
  });
  const error = await client.collect().catch((error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  expect(error).toBeInstanceOf(DealSourceAccessBlockedError);
  expect((error as Error).message).toContain("outside its configured origin (alival.manmanbuy.com)");
  expect((error as Error).message).not.toContain("private-context");
  expect((error as Error).message).not.toContain("192.0.2.1");
  expect(calls).toBe(1);
});

test("deals source distinguishes access denial from a transient server failure", async () => {
  for (const status of [401, 403]) {
    const error = await new DealsSourceClient({ fetchImpl: async () => new Response(null, { status }) })
      .collect().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(DealSourceAccessBlockedError);
    expect((error as Error).message).toContain(`HTTP ${status}`);
  }
  const error = await new DealsSourceClient({ fetchImpl: async () => new Response(null, { status: 503 }) })
    .collect().catch((error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(DealSourceAccessBlockedError);
});

test("deals source rejects redirect destinations that expand network access", async () => {
  for (const location of [
    "http://m.tuihaowu.com/list", "https://m.tuihaowu.com:8443/list",
    "https://user:secret@m.tuihaowu.com/list", "//127.0.0.1/private", "https://[::1]/private",
    "https://m.tuihaowu.com.attacker.example/list",
  ]) {
    let calls = 0;
    const client = new DealsSourceClient({ fetchImpl: async () => {
      calls += 1;
      return new Response(null, { status: 307, headers: { location } });
    } });
    await expect(client.collect()).rejects.toThrow("Deals source");
    expect(calls).toBe(1);
  }
});

test("deals source limits redirect chains and rejects missing or malformed locations", async () => {
  let calls = 0;
  await expect(new DealsSourceClient({ fetchImpl: async () => {
    calls += 1;
    return new Response(null, { status: 301, headers: { location: `/hop-${calls}` } });
  } }).collect()).rejects.toThrow("exceeds 3 redirects");
  expect(calls).toBe(4);
  for (const location of [undefined, "https://[invalid"] as const) {
    await expect(new DealsSourceClient({ fetchImpl: async () => new Response(null, {
      status: 302, ...(location ? { headers: { location } } : {}),
    }) }).collect()).rejects.toThrow("Deals source");
  }
});
