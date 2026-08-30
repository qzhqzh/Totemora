import { expect, test } from "bun:test";

import { dealId, dealWindowKey, formatDealDigest, normalizeCollectedDeal, shanghaiHour } from "./deal";

test("deals normalize source evidence and create stable ids and hourly windows", () => {
  const item = normalizeCollectedDeal({
    source_id: "123", title: "测试商品", deal_text: "9.9 元包邮", merchant: "京东商城 | 08-23",
    source_url: "https://m.tuihaowu.com/d.aspx?id=123", image_url: "https://img.example/a.jpg", source_rank: 1,
  });
  expect(item.source_url).toBe("https://m.tuihaowu.com/d.aspx?id=123");
  expect(dealId(item.source_id)).toBe(dealId(item.source_id));
  expect(dealWindowKey("2026-08-30T18")).toBe("deals:digest:2026-08-30:18");
  expect(shanghaiHour(new Date("2026-08-30T10:30:00Z"))).toMatchObject({
    local_hour: "2026-08-30T18", hour: 18,
  });
  expect(() => normalizeCollectedDeal({ ...item, source_url: "http://example.com" })).toThrow("HTTPS URL");
  expect(() => dealWindowKey("2026-02-30T12")).toThrow("real date");
});

test("deal digest preserves merchant, offer, and source link", () => {
  const base = normalizeCollectedDeal({
    source_id: "123", title: "测试商品", deal_text: "9.9 元包邮", merchant: "京东商城 | 08-23",
    source_url: "https://m.tuihaowu.com/d.aspx?id=123", source_rank: 1,
  });
  const body = formatDealDigest([{ ...base, id: dealId(base.source_id), status: "pending",
    discovered_at: "2026-08-30T10:00:00.000Z", updated_at: "2026-08-30T10:00:00.000Z" }]);
  expect(body).toContain("【推好物·京东商城】测试商品");
  expect(body).toContain("9.9 元包邮");
  expect(body).toContain(base.source_url);
});
