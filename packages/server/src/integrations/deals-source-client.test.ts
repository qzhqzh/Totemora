import { expect, test } from "bun:test";

import { DealsSourceClient, parseDealsFragment } from "./deals-source-client";

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
      expect(init?.redirect).toBe("error");
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
