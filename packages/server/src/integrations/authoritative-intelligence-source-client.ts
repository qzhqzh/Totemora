import { readBoundedResponseText } from "./bounded-response";

export interface AuthoritativeIntelligenceItem {
  title: string;
  link: string;
  published_at?: string;
  source: string;
  summary?: string;
  category: "cybersecurity" | "critical_event";
}

export const CISA_KEV_SOURCE = {
  id: "cisa-kev",
  name: "CISA 已利用漏洞",
  kind: "官方 JSON",
  url: "https://www.cisa.gov/known-exploited-vulnerabilities-catalog",
  summary: "CISA 已确认在野利用的漏洞目录，只读取最近七天新增项。",
} as const;

export const USGS_SIGNIFICANT_SOURCE = {
  id: "usgs-significant-day",
  name: "USGS 重大地震",
  kind: "官方 GeoJSON",
  url: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_day.geojson",
  summary: "USGS 最近一天重大地震实时摘要；空列表表示当前没有重大事件。",
} as const;

const CISA_FEED_URL = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";
const RESPONSE_LIMIT_BYTES = 4_000_000;

export class AuthoritativeIntelligenceSourceClient {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async collectCisa(now = new Date()): Promise<AuthoritativeIntelligenceItem[]> {
    const payload = objectValue(await this.fetchJson(CISA_FEED_URL, "CISA KEV"), "CISA KEV payload");
    if (!Array.isArray(payload.vulnerabilities)) throw new Error("CISA KEV payload has no vulnerabilities array");
    const cutoff = startOfUtcDay(now).getTime() - 7 * 86_400_000;
    return payload.vulnerabilities.flatMap((raw): AuthoritativeIntelligenceItem[] => {
      if (!isObject(raw)) return [];
      const cve = safeText(raw.cveID, 32);
      const dateAdded = safeText(raw.dateAdded, 10);
      const addedAt = Date.parse(`${dateAdded}T00:00:00.000Z`);
      if (!/^CVE-\d{4}-\d{4,}$/.test(cve) || Number.isNaN(addedAt) || addedAt < cutoff) return [];
      const vendor = safeText(raw.vendorProject, 100);
      const product = safeText(raw.product, 120);
      const name = safeText(raw.vulnerabilityName, 240);
      const ransomware = safeText(raw.knownRansomwareCampaignUse, 40).toLowerCase() === "known"
        ? "已知勒索软件利用" : "";
      const description = safeText(raw.shortDescription, 700);
      const action = safeText(raw.requiredAction, 400);
      const dueDate = safeText(raw.dueDate, 10);
      const title = [cve, vendor, product, name, ransomware].filter(Boolean).join("｜").slice(0, 500);
      const summary = [description, action && `处置：${action}`, dueDate && `要求期限：${dueDate}`]
        .filter(Boolean).join(" ").slice(0, 1_200);
      return [{
        title,
        link: `${CISA_KEV_SOURCE.url}?search_api_fulltext=${encodeURIComponent(cve)}`,
        published_at: new Date(addedAt).toISOString(),
        source: "cisa.gov",
        ...(summary ? { summary } : {}),
        category: "cybersecurity",
      }];
    }).slice(0, 20);
  }

  async collectUsgs(): Promise<AuthoritativeIntelligenceItem[]> {
    const payload = objectValue(
      await this.fetchJson(USGS_SIGNIFICANT_SOURCE.url, "USGS significant earthquakes"),
      "USGS payload",
    );
    if (!Array.isArray(payload.features)) throw new Error("USGS payload has no features array");
    return payload.features.flatMap((raw): AuthoritativeIntelligenceItem[] => {
      if (!isObject(raw) || !isObject(raw.properties)) return [];
      const properties = raw.properties;
      const url = publicUsgsUrl(properties.url);
      if (!url) return [];
      const magnitude = finiteNumber(properties.mag);
      const place = safeText(properties.place, 300) || "未知地点";
      const occurredAt = isoTimestamp(properties.time);
      const alert = safeText(properties.alert, 30);
      const tsunami = finiteNumber(properties.tsunami) === 1;
      const significance = finiteNumber(properties.sig);
      const summary = [
        magnitude === undefined ? "震级待确认" : `震级 M${magnitude}`,
        `地点：${place}`,
        significance === undefined ? "" : `显著性：${significance}`,
        alert ? `警报：${alert}` : "",
        tsunami ? "海啸标记：是" : "",
      ].filter(Boolean).join("；");
      return [{
        title: `${magnitude === undefined ? "地震" : `M${magnitude} 地震`}｜${place}`.slice(0, 500),
        link: url,
        ...(occurredAt ? { published_at: occurredAt } : {}),
        source: "earthquake.usgs.gov",
        summary,
        category: "critical_event",
      }];
    }).slice(0, 20);
  }

  private async fetchJson(url: string, label: string): Promise<unknown> {
    const response = await this.fetchImpl(url, {
      headers: { "user-agent": "Totemora-Intelligence/1.0 (+https://github.com/qzhqzh/Totemora)" },
      signal: AbortSignal.timeout(20_000),
      redirect: "error",
    });
    const text = await readBoundedResponseText(
      response, RESPONSE_LIMIT_BYTES, `${label} response exceeded ${RESPONSE_LIMIT_BYTES} bytes`,
    );
    if (!response.ok) throw new Error(`${label} source failed (${response.status})`);
    try { return JSON.parse(text) as unknown; }
    catch { throw new Error(`${label} source returned invalid JSON`); }
  }
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeText(value: unknown, maximum: number): string {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, maximum) : "";
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isoTimestamp(value: unknown): string | undefined {
  const timestamp = finiteNumber(value);
  if (timestamp === undefined || timestamp <= 0) return undefined;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function publicUsgsUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.hostname === "earthquake.usgs.gov"
      && !parsed.username && !parsed.password ? parsed.toString() : undefined;
  } catch { return undefined; }
}

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
