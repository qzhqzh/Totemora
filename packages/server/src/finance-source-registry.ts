import { StateDatabase } from "./state-database";
import type { EvidenceTier } from "./intelligence-candidate-store";
import type { FinanceMarket, FinancePreferences } from "./finance-preference-store";

export type FinanceSourceCategory = "disclosures" | "regulation" | "macro" | "global_official";
export type FinanceSourceAvailability = "active" | "covered" | "credential_required" | "commercial";

export interface FinanceSourceDefinition {
  id: string;
  name: string;
  url: string;
  tier: EvidenceTier;
  markets: FinanceMarket[];
  category: FinanceSourceCategory;
  availability: FinanceSourceAvailability;
  official: boolean;
  summary: string;
  covered_by?: string;
}

export interface FinanceSourceItem {
  title: string;
  link: string;
  published_at?: string;
  source: string;
  source_id: string;
  source_url: string;
  evidence_tier: EvidenceTier;
  market: FinanceMarket;
  symbols: string[];
  event_type: string;
  summary?: string;
  cached?: boolean;
}

export interface FinanceSourceHealth extends FinanceSourceDefinition {
  status: "ready" | "degraded" | "not_configured";
  last_checked_at?: string;
  last_success_at?: string;
  latency_ms?: number;
  item_count?: number;
  error?: string;
}

interface ActiveSource extends FinanceSourceDefinition {
  parser: "cninfo" | "csrc" | "pbc" | "stats" | "rss" | "atom" | "hkma";
}

interface SourceCache {
  source_id: string;
  fetched_at: string;
  items: FinanceSourceItem[];
}

const ACTIVE_SOURCES: ActiveSource[] = [
  {
    id: "cninfo-disclosures", name: "巨潮资讯公告速递", url: "https://www.cninfo.com.cn/",
    tier: "S0", markets: ["CN"], category: "disclosures", availability: "active", official: true,
    summary: "深交所法定信息披露平台；采集首页公告速递，保留股票代码、公告编号和原文链接。", parser: "cninfo",
  },
  {
    id: "csrc-regulation", name: "中国证监会新闻与监管", url: "https://www.csrc.gov.cn/csrc/xwfb/index.shtml",
    tier: "S0", markets: ["CN"], category: "regulation", availability: "active", official: true,
    summary: "证监会政策、处罚、监管与新闻发布。", parser: "csrc",
  },
  {
    id: "pbc-policy", name: "中国人民银行", url: "https://www.pbc.gov.cn/",
    tier: "S1", markets: ["CN", "HK"], category: "macro", availability: "active", official: true,
    summary: "货币政策、金融统计、市场运行与公告。", parser: "pbc",
  },
  {
    id: "nbs-releases", name: "国家统计局数据发布", url: "https://www.stats.gov.cn/sj/",
    tier: "S1", markets: ["CN", "HK"], category: "macro", availability: "active", official: true,
    summary: "CPI、PPI、PMI、GDP、工业、消费和就业等官方发布与解读。", parser: "stats",
  },
  {
    id: "federal-reserve", name: "Federal Reserve Releases", url: "https://www.federalreserve.gov/feeds/press_all.xml",
    tier: "S1", markets: ["US", "HK"], category: "global_official", availability: "active", official: true,
    summary: "美联储货币政策、监管、执法与其他官方新闻稿 RSS。", parser: "rss",
  },
  {
    id: "sec-current-filings", name: "SEC EDGAR Current Filings", url: "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&output=atom&count=40",
    tier: "S0", markets: ["US"], category: "disclosures", availability: "active", official: true,
    summary: "SEC 最新公司申报 Atom；只做发现，重要事实回到具体 filing。", parser: "atom",
  },
  {
    id: "hkma-releases", name: "香港金融管理局", url: "https://www.hkma.gov.hk/eng/news-and-media/press-releases/",
    tier: "S1", markets: ["HK"], category: "global_official", availability: "active", official: true,
    summary: "香港货币、银行及金融稳定相关官方发布。", parser: "hkma",
  },
];

const CATALOG_ONLY: FinanceSourceDefinition[] = [
  {
    id: "sse-announcements", name: "上海证券交易所公告", url: "https://www.sse.com.cn/disclosure/listedinfo/announcement/",
    tier: "S0", markets: ["CN"], category: "disclosures", availability: "covered", official: true,
    summary: "上交所公司公告权威回查入口；一期由巨潮公告速递统一发现。", covered_by: "cninfo-disclosures",
  },
  {
    id: "szse-announcements", name: "深圳证券交易所公告", url: "https://www.szse.cn/disclosure/listed/notice/index.html",
    tier: "S0", markets: ["CN"], category: "disclosures", availability: "covered", official: true,
    summary: "深交所公司公告权威回查入口；一期由巨潮公告速递统一发现。", covered_by: "cninfo-disclosures",
  },
  {
    id: "bse-announcements", name: "北京证券交易所公告", url: "https://www.bse.cn/disclosure/announcement.html",
    tier: "S0", markets: ["CN"], category: "disclosures", availability: "covered", official: true,
    summary: "北交所公司公告权威回查入口；一期由巨潮公告速递统一发现。", covered_by: "cninfo-disclosures",
  },
  {
    id: "hkexnews", name: "HKEXnews", url: "https://www.hkexnews.hk/",
    tier: "S0", markets: ["HK"], category: "disclosures", availability: "commercial", official: true,
    summary: "港股发行人公告权威入口；生产级实时接入应采用 HKEX IIS 授权数据流。",
  },
  {
    id: "fred-api", name: "FRED / ALFRED API", url: "https://fred.stlouisfed.org/docs/api/fred/",
    tier: "S1", markets: ["US", "HK"], category: "macro", availability: "credential_required", official: true,
    summary: "圣路易斯联储的宏观序列、发布日历与历史修订；配置 API key 后适合做数值复核和修订检测。",
  },
  {
    id: "bls-api", name: "U.S. Bureau of Labor Statistics API", url: "https://www.bls.gov/developers/",
    tier: "S1", markets: ["US", "HK"], category: "macro", availability: "credential_required", official: true,
    summary: "美国就业、CPI、PPI 等官方时间序列；生产使用注册版 API 以获得较高限额和元数据。",
  },
  {
    id: "bea-api", name: "U.S. Bureau of Economic Analysis API", url: "https://apps.bea.gov/api/",
    tier: "S1", markets: ["US", "HK"], category: "macro", availability: "credential_required", official: true,
    summary: "美国 GDP、行业、国际与地区经济统计的官方结构化接口；配置 API key 后启用。",
  },
  {
    id: "tushare", name: "Tushare Pro", url: "https://tushare.pro/document/2",
    tier: "S3", markets: ["CN", "HK", "US"], category: "disclosures", availability: "credential_required", official: false,
    summary: "结构化行情、交易日历和公告发现；配置 Token 后启用，不能替代官方原文。",
  },
  {
    id: "wind", name: "Wind 数据接口", url: "https://www.wind.com.cn/portal/zh/Home/",
    tier: "S3", markets: ["CN", "HK", "US"], category: "disclosures", availability: "commercial", official: false,
    summary: "专业行情、基本面与事件数据，适合后续稳定性升级。",
  },
  {
    id: "reuters-connect", name: "Reuters Connect", url: "https://reutersagency.com/content-delivery-platforms/reuters-connect/",
    tier: "S2", markets: ["CN", "HK", "US"], category: "global_official", availability: "commercial", official: false,
    summary: "高质量突发新闻与背景报道；只通过正式授权接口接入。",
  },
  {
    id: "bloomberg-data", name: "Bloomberg Data License", url: "https://professional.bloomberg.com/products/data/data-management/data-license/",
    tier: "S2", markets: ["CN", "HK", "US"], category: "global_official", availability: "commercial", official: false,
    summary: "企业级行情、公司行动、基本面与新闻数据；只通过商业许可接入。",
  },
];

export class FinanceSourceRegistry {
  private readonly state: StateDatabase;

  constructor(
    private readonly dataDir: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.state = StateDatabase.open(dataDir);
  }

  catalog(): FinanceSourceDefinition[] {
    return [
      ...ACTIVE_SOURCES.map(({ parser: _parser, ...source }) => source),
      ...CATALOG_ONLY.map((source) => ({ ...source })),
    ];
  }

  status(): FinanceSourceHealth[] {
    const health = new Map(this.state.listRecords<FinanceSourceHealth>("finance_source_health").map((item) => [item.id, item]));
    return this.catalog().map((source) => health.get(source.id) ?? {
      ...source,
      status: source.availability === "active" ? "degraded" : "not_configured",
      error: source.availability === "active" ? "尚未完成首次采集" : availabilityMessage(source),
    });
  }

  async collect(preferences: FinancePreferences): Promise<{ items: FinanceSourceItem[]; warnings: string[] }> {
    const selected = ACTIVE_SOURCES.filter((source) => sourceEnabled(source, preferences));
    const settled = await Promise.all(selected.map((source) => this.collectOne(source)));
    const warnings = settled.flatMap((result) => result.warnings);
    const batches = settled.map((result) => result.items);
    const seen = new Set<string>();
    const items: FinanceSourceItem[] = [];
    for (let index = 0; items.length < 60 && index < 20; index += 1) {
      for (const batch of batches) {
        const item = batch[index];
        if (!item || seen.has(item.link)) continue;
        seen.add(item.link);
        items.push(item);
        if (items.length >= 60) break;
      }
    }
    if (!items.length) throw new Error(`All active finance sources failed: ${warnings.join("; ")}`);
    return { items, warnings };
  }

  private async collectOne(source: ActiveSource): Promise<{ items: FinanceSourceItem[]; warnings: string[] }> {
    const started = Date.now();
    const checkedAt = new Date().toISOString();
    try {
      const body = await fetchWithLimit(this.fetchImpl, source.url, 3_000_000);
      const items = parseSource(source, body).slice(0, 20);
      if (!items.length) throw new Error(`${source.name} returned no recognized entries`);
      const health: FinanceSourceHealth = {
        ...publicSource(source), status: "ready", last_checked_at: checkedAt, last_success_at: checkedAt,
        latency_ms: Date.now() - started, item_count: items.length,
      };
      this.state.putRecord("finance_source_health", source.id, health, checkedAt, checkedAt);
      this.state.putRecord("finance_source_cache", source.id, {
        source_id: source.id, fetched_at: checkedAt, items,
      } satisfies SourceCache, checkedAt, checkedAt);
      return { items, warnings: [] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const prior = this.state.listRecords<FinanceSourceHealth>("finance_source_health").find((item) => item.id === source.id);
      const health: FinanceSourceHealth = {
        ...publicSource(source), status: "degraded", last_checked_at: checkedAt,
        last_success_at: prior?.last_success_at, latency_ms: Date.now() - started,
        item_count: prior?.item_count, error: message.slice(0, 500),
      };
      this.state.putRecord("finance_source_health", source.id, health, prior?.last_checked_at ?? checkedAt, checkedAt);
      const cache = this.state.listRecords<SourceCache>("finance_source_cache").find((item) => item.source_id === source.id);
      if (cache?.items.length && Date.now() - Date.parse(cache.fetched_at) <= 48 * 3_600_000) {
        return {
          items: cache.items.map((item) => ({ ...item, cached: true })),
          warnings: [`${message}; reused ${source.name} cache from ${cache.fetched_at}`],
        };
      }
      return { items: [], warnings: [message] };
    }
  }
}

function publicSource({ parser: _parser, ...source }: ActiveSource): FinanceSourceDefinition {
  return source;
}

function sourceEnabled(source: ActiveSource, preferences: FinancePreferences): boolean {
  if (!source.markets.some((market) => preferences.markets.includes(market))) return false;
  return preferences.channels[source.category];
}

function parseSource(source: ActiveSource, body: string): FinanceSourceItem[] {
  if (source.parser === "rss") return parseRss(source, body);
  if (source.parser === "atom") return parseAtom(source, body);
  return extractAnchors(body).flatMap((anchor): FinanceSourceItem[] => {
    const href = decodeXml(anchor.href.trim());
    const title = cleanText(anchor.title || anchor.body);
    if (!title || title.length < 4 || !acceptedAnchor(source.parser, href, title)) return [];
    const link = sourceLink(source, href);
    if (!link) return [];
    const symbol = link.searchParams.get("stockCode")?.toUpperCase();
    const sourceId = link.searchParams.get("announcementId")
      ?? link.pathname.match(/c(\d+)\/content\.shtml$/)?.[1]
      ?? stableId(source.id, link.toString());
    const market = source.markets[0] ?? "CN";
    const published = link.searchParams.get("announcementTime") ?? dateFromPath(link.pathname);
    return [{
      title, link: link.toString(), published_at: published, source: source.name,
      source_id: sourceId, source_url: source.url, evidence_tier: source.tier, market,
      symbols: symbol ? [symbol] : symbolsFromTitle(title), event_type: classifyEvent(title),
      summary: `${source.name}官方条目；涉及数字和影响判断时应打开原文复核。`,
    }];
  }).filter((item, index, rows) => rows.findIndex((other) => other.link === item.link) === index);
}

function acceptedAnchor(parser: ActiveSource["parser"], href: string, title: string): boolean {
  if (parser === "cninfo") return href.includes("/new/disclosure/detail?") && href.includes("announcementId=");
  if (parser === "csrc") return /\/csrc\/c\d+\/c[^/]+\/content\.shtml/.test(href) && !/会见|出席|致辞/.test(title);
  if (parser === "stats") return /(?:^|\/)\.?(?:\/)?(?:zxfb|sjjd)\//.test(href) && /CPI|PPI|PMI|GDP|生产总值|工业|消费|投资|就业|价格|利润|房地产|采购经理|经济/.test(title);
  if (parser === "pbc") return /\/(?:goutongjiaoliu|rmyh|huobizhengce|diaochatongjisi|jinrongshichangsi)\//.test(href)
    && /货币|金融|利率|汇率|贷款|存款|债券|市场|统计|政策|支付|人民币|宏观/.test(title);
  if (parser === "hkma") return /\/eng\/news-and-media\/(?:press-releases|insight)\//.test(href);
  return false;
}

function parseRss(source: ActiveSource, xml: string): FinanceSourceItem[] {
  return [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].flatMap((match): FinanceSourceItem[] => {
    const item = match[0];
    const title = cleanText(xmlField(item, "title") ?? "");
    const href = decodeXml(xmlField(item, "link") ?? "");
    const link = sourceLink(source, href);
    if (!title || !link) return [];
    return [{
      title, link: link.toString(), published_at: xmlField(item, "pubDate"), source: source.name,
      source_id: xmlField(item, "guid") ?? stableId(source.id, link.toString()), source_url: source.url,
      evidence_tier: source.tier, market: source.markets[0] ?? "US", symbols: symbolsFromTitle(title),
      event_type: classifyEvent(title), summary: cleanText(xmlField(item, "description") ?? "").slice(0, 1_000) || undefined,
    }];
  });
}

function parseAtom(source: ActiveSource, xml: string): FinanceSourceItem[] {
  return [...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].flatMap((match): FinanceSourceItem[] => {
    const entry = match[0];
    const title = cleanText(xmlField(entry, "title") ?? "");
    const href = entry.match(/<link\b[^>]*href=["']([^"']+)["']/i)?.[1] ?? "";
    const link = sourceLink(source, decodeXml(href));
    if (!title || !link) return [];
    return [{
      title, link: link.toString(), published_at: xmlField(entry, "updated"), source: source.name,
      source_id: cleanText(xmlField(entry, "id") ?? "") || stableId(source.id, link.toString()), source_url: source.url,
      evidence_tier: source.tier, market: "US", symbols: symbolsFromTitle(title),
      event_type: classifyEvent(title), summary: cleanText(xmlField(entry, "summary") ?? "").slice(0, 1_000) || undefined,
    }];
  });
}

function extractAnchors(html: string): Array<{ href: string; title: string; body: string }> {
  return [...html.matchAll(/<a\b([^>]*)href=["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi)].map((match) => {
    const attributes = `${match[1]} ${match[3]}`;
    return {
      href: match[2] ?? "", title: attributes.match(/title=["']([^"']+)["']/i)?.[1] ?? "", body: match[4] ?? "",
    };
  });
}

function classifyEvent(title: string): string {
  const rules: Array<[RegExp, string]> = [
    [/立案|处罚|纪律处分|监管措施|风险警示|退市/, "regulatory_action"],
    [/业绩|利润|财报|年报|季报|半年报/, "earnings"],
    [/收购|并购|重组|重大资产|控制权/, "merger_acquisition"],
    [/回购|增持|减持|持股/, "ownership_change"],
    [/分红|派息|股息/, "distribution"],
    [/停牌|复牌|上市|终止上市/, "listing_status"],
    [/利率|货币政策|公开市场|准备金/, "monetary_policy"],
    [/CPI|PPI|PMI|GDP|生产总值|就业|工业|消费|投资/, "macro_release"],
    [/诉讼|仲裁/, "legal_proceeding"],
  ];
  return rules.find(([pattern]) => pattern.test(title))?.[1] ?? "official_update";
}

function symbolsFromTitle(title: string): string[] {
  return [...new Set([...title.matchAll(/\b(?:[036]\d{5}|[A-Z]{1,5})\b/g)].map((match) => match[0]!.toUpperCase()))].slice(0, 10);
}

function dateFromPath(path: string): string | undefined {
  const compact = path.match(/\/(20\d{2})(\d{2})\//);
  return compact ? `${compact[1]}-${compact[2]}` : undefined;
}

function xmlField(xml: string, name: string): string | undefined {
  return xml.match(new RegExp(`<${name}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${name}>`, "i"))?.[1]?.trim();
}

function cleanText(value: string): string {
  return decodeXml(value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function decodeXml(value: string): string {
  return value.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&#39;", "'");
}

function stableId(sourceId: string, value: string): string {
  return `${sourceId}:${new Bun.CryptoHasher("sha256").update(value).digest("hex").slice(0, 20)}`;
}

async function fetchWithLimit(fetchImpl: typeof fetch, value: string, limit: number): Promise<string> {
  const initial = new URL(value);
  assertFinanceSourceUrl(initial, initial.origin);
  let current = initial;
  for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
    const response = await fetchImpl(current, {
      headers: { "user-agent": "Totemora-Finance/0.11 (+https://github.com/qzhqzh/Totemora)" },
      signal: AbortSignal.timeout(20_000), redirect: "manual",
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirectCount === 3) throw new Error(`${initial.hostname} source exceeded 3 redirects`);
      const location = response.headers.get("location");
      if (!location) throw new Error(`${initial.hostname} source redirect omitted Location`);
      current = new URL(location, current);
      assertFinanceSourceUrl(current, initial.origin);
      continue;
    }
    if (!response.ok) throw new Error(`${initial.hostname} source failed (${response.status})`);
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > limit) throw new Error(`${initial.hostname} source exceeded ${limit} bytes`);
    return readResponseWithLimit(response, limit, initial.hostname);
  }
  throw new Error(`${initial.hostname} source redirect failed`);
}

function sourceLink(source: ActiveSource, value: string): URL | undefined {
  try {
    const sourceUrl = new URL(source.url);
    const candidate = new URL(value, sourceUrl);
    assertFinanceSourceUrl(candidate, sourceUrl.origin);
    return candidate;
  } catch {
    return undefined;
  }
}

function assertFinanceSourceUrl(url: URL, allowedOrigin: string): void {
  if (url.protocol !== "https:" || url.origin !== allowedOrigin || url.username || url.password || isPrivateHostname(url.hostname)) {
    throw new Error(`Finance source URL is outside the HTTPS origin allowlist: ${url.hostname}`);
  }
}

function isPrivateHostname(hostname: string): boolean {
  const value = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (value === "localhost" || value.endsWith(".localhost") || value === "::1" || value.startsWith("fe80:")
    || value.startsWith("fc") || value.startsWith("fd")) return true;
  const octets = value.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return octets[0] === 10 || octets[0] === 127 || octets[0] === 0
    || (octets[0] === 169 && octets[1] === 254)
    || (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

async function readResponseWithLimit(response: Response, limit: number, hostname: string): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error(`${hostname} source exceeded ${limit} bytes`);
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function availabilityMessage(source: FinanceSourceDefinition): string {
  if (source.availability === "covered") return `一期由 ${source.covered_by} 覆盖发现，保留为权威回查入口`;
  if (source.availability === "commercial") return "需要商业许可后启用";
  return "需要凭据或自选股范围后启用";
}
