import { readBoundedResponseText } from "./bounded-response";
import type { ResearchDirection } from "../research-direction-store";

export interface ResearchIntelligenceItem {
  title: string;
  link: string;
  published_at?: string;
  source: string;
  summary?: string;
  category: "research_preprint" | "research_article";
  research_direction_ids: string[];
  research_direction_names: string[];
}

export const ARXIV_RESEARCH_SOURCE = {
  id: "arxiv-research",
  name: "arXiv 科研预印本",
  kind: "官方 Atom API",
  url: "https://arxiv.org/",
  summary: "按已启用科研方向检索最近七天的预印本；未经同行评审，作为前沿发现线索。",
} as const;

export const EUROPE_PMC_RESEARCH_SOURCE = {
  id: "europe-pmc-research",
  name: "Europe PMC 生命科学文献",
  kind: "官方文献 REST API",
  url: "https://europepmc.org/",
  summary: "按已启用科研方向检索最近七天的生命科学论文与预印本元数据；索引状态不替代原文复核。",
} as const;

const ARXIV_API_URL = "https://export.arxiv.org/api/query";
const EUROPE_PMC_API_URL = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";
const RESPONSE_LIMIT_BYTES = 4_000_000;
const LOOKBACK_DAYS = 7;
const RESULT_LIMIT = 12;

export class ResearchIntelligenceSourceClient {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async collectArxiv(directions: ResearchDirection[], now = new Date()): Promise<ResearchIntelligenceItem[]> {
    const activeDirections = directions.filter((direction) => direction.enabled);
    const terms = researchQueryTerms(activeDirections);
    if (!terms.length) return [];
    const url = new URL(ARXIV_API_URL);
    const start = arxivTimestamp(new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000));
    const end = arxivTimestamp(now);
    const directionQuery = terms.map((term) => `all:"${term}"`).join(" OR ");
    url.searchParams.set("search_query", `(${directionQuery}) AND submittedDate:[${start} TO ${end}]`);
    url.searchParams.set("start", "0");
    url.searchParams.set("max_results", String(RESULT_LIMIT));
    url.searchParams.set("sortBy", "submittedDate");
    url.searchParams.set("sortOrder", "descending");
    const xml = await this.fetchText(url, "arXiv research");
    return [...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].slice(0, RESULT_LIMIT).flatMap((match) => {
      const entry = match[0];
      const title = xmlField(entry, "title", 500);
      const link = arxivArticleUrl(xmlField(entry, "id", 500));
      if (!title || !link || title.toLowerCase() === "error") return [];
      const categories = [...entry.matchAll(/<category\b[^>]*\bterm=(?:"([^"]+)"|'([^']+)')[^>]*\/?\s*>/gi)]
        .map((category) => safeText(category[1] ?? category[2], 40)).filter(Boolean).slice(0, 6);
      const authors = [...entry.matchAll(/<author\b[\s\S]*?<name\b[^>]*>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi)]
        .map((author) => cleanXmlText(author[1], 100)).filter(Boolean).slice(0, 4);
      const abstract = xmlField(entry, "summary", 900);
      const matchedDirections = matchResearchDirections(`${title}\n${abstract}`, activeDirections);
      if (!matchedDirections.length) return [];
      const summary = [
        `研究方向：${matchedDirections.map((direction) => direction.name).join(" / ")}`,
        "证据状态：arXiv 预印本，尚未经过同行评审",
        categories.length ? `分类：${categories.join(" / ")}` : "",
        authors.length ? `作者：${authors.join("、")}` : "",
        abstract ? `摘要：${abstract}` : "",
      ].filter(Boolean).join("；").slice(0, 1_200);
      return [{
        title,
        link,
        published_at: isoDate(xmlField(entry, "published", 80)),
        source: "arXiv · 预印本",
        ...(summary ? { summary } : {}),
        category: "research_preprint" as const,
        research_direction_ids: matchedDirections.map((direction) => direction.id),
        research_direction_names: matchedDirections.map((direction) => direction.name),
      }];
    });
  }

  async collectEuropePmc(directions: ResearchDirection[], now = new Date()): Promise<ResearchIntelligenceItem[]> {
    const activeDirections = directions.filter((direction) => direction.enabled);
    const terms = researchQueryTerms(activeDirections);
    if (!terms.length) return [];
    const url = new URL(EUROPE_PMC_API_URL);
    const start = dateOnly(new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000));
    const end = dateOnly(now);
    const directionQuery = terms.map((term) => `TITLE_ABS:"${term}"`).join(" OR ");
    url.searchParams.set("query", `(${directionQuery}) AND FIRST_PDATE:[${start} TO ${end}] sort_date:y`);
    url.searchParams.set("format", "json");
    url.searchParams.set("resultType", "core");
    url.searchParams.set("pageSize", String(RESULT_LIMIT));
    const payload = objectValue(await this.fetchJson(url, "Europe PMC research"), "Europe PMC payload");
    const resultList = objectValue(payload.resultList, "Europe PMC resultList");
    if (!Array.isArray(resultList.result)) throw new Error("Europe PMC resultList has no result array");
    return resultList.result.slice(0, RESULT_LIMIT).flatMap((raw): ResearchIntelligenceItem[] => {
      if (!isObject(raw)) return [];
      const title = safeText(raw.title, 500);
      const link = europePmcArticleUrl(raw);
      if (!title || !link) return [];
      const publicationTypes = publicationTypeNames(raw.pubTypeList);
      const preprint = safeText(raw.isPreprint, 8).toUpperCase() === "Y"
        || publicationTypes.some((value) => value.toLowerCase().includes("preprint"));
      const journal = safeText(raw.journalTitle, 180);
      const authors = safeText(raw.authorString, 280);
      const abstract = safeText(raw.abstractText, 900);
      const matchedDirections = matchResearchDirections(`${title}\n${abstract}`, activeDirections);
      if (!matchedDirections.length) return [];
      const citedBy = finiteNumber(raw.citedByCount);
      const summary = [
        `研究方向：${matchedDirections.map((direction) => direction.name).join(" / ")}`,
        preprint ? "证据状态：预印本，尚未经过同行评审" : "证据状态：已进入文献索引，同行评审状态以原文为准",
        journal ? `载体：${journal}` : "",
        publicationTypes.length ? `类型：${publicationTypes.slice(0, 3).join(" / ")}` : "",
        authors ? `作者：${authors}` : "",
        citedBy && citedBy > 0 ? `Europe PMC 引用记录：${Math.floor(citedBy)}` : "",
        abstract ? `摘要：${abstract}` : "",
      ].filter(Boolean).join("；").slice(0, 1_200);
      return [{
        title,
        link,
        published_at: isoDate(safeText(raw.firstPublicationDate ?? raw.electronicPublicationDate, 80)),
        source: `Europe PMC · ${preprint ? "预印本" : journal || "期刊记录"}`,
        ...(summary ? { summary } : {}),
        category: preprint ? "research_preprint" : "research_article",
        research_direction_ids: matchedDirections.map((direction) => direction.id),
        research_direction_names: matchedDirections.map((direction) => direction.name),
      }];
    });
  }

  private async fetchText(url: URL, label: string): Promise<string> {
    const response = await this.fetchImpl(url, {
      headers: { "user-agent": "Totemora-Research-Radar/1.0 (+https://github.com/qzhqzh/Totemora)" },
      signal: AbortSignal.timeout(20_000),
      redirect: "error",
    });
    const text = await readBoundedResponseText(
      response, RESPONSE_LIMIT_BYTES, `${label} response exceeded ${RESPONSE_LIMIT_BYTES} bytes`,
    );
    if (!response.ok) throw new Error(`${label} source failed (${response.status})`);
    return text;
  }

  private async fetchJson(url: URL, label: string): Promise<unknown> {
    const text = await this.fetchText(url, label);
    try { return JSON.parse(text) as unknown; }
    catch { throw new Error(`${label} source returned invalid JSON`); }
  }
}

function arxivArticleUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.hostname !== "arxiv.org" || !url.pathname.startsWith("/abs/") || url.username || url.password) return undefined;
    url.protocol = "https:";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch { return undefined; }
}

function europePmcArticleUrl(value: Record<string, unknown>): string | undefined {
  const doi = safeText(value.doi, 240);
  if (/^10\.\d{4,9}\/\S+$/i.test(doi)) {
    const url = new URL("https://doi.org/");
    url.pathname = `/${doi}`;
    return url.toString();
  }
  const source = safeText(value.source, 16);
  const id = safeText(value.id ?? value.pmid ?? value.pmcid, 80);
  if (!/^[A-Z0-9._-]+$/i.test(source) || !/^[A-Z0-9._-]+$/i.test(id)) return undefined;
  return `https://europepmc.org/article/${encodeURIComponent(source)}/${encodeURIComponent(id)}`;
}

function publicationTypeNames(value: unknown): string[] {
  if (!isObject(value) || !Array.isArray(value.publicationType)) return [];
  return value.publicationType.map((item) => safeText(item, 80)).filter(Boolean).slice(0, 8);
}

function xmlField(xml: string, name: string, maximum: number): string {
  const value = xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"))?.[1];
  return cleanXmlText(value, maximum);
}

function cleanXmlText(value: unknown, maximum: number): string {
  return safeText(typeof value === "string" ? decodeXml(value.replace(/<[^>]+>/g, " ")) : value, maximum);
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&#39;", "'")
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .replace(/&#x([0-9a-f]+);/gi, (_, number) => String.fromCodePoint(Number.parseInt(number, 16)));
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
    ? value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum)
    : "";
}

function finiteNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function isoDate(value: string): string | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : new Date(timestamp).toISOString();
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function arxivTimestamp(value: Date): string {
  return value.toISOString().replace(/[-:]/g, "").slice(0, 12);
}

function researchQueryTerms(directions: ResearchDirection[]): string[] {
  return [...new Set(directions.flatMap((direction) => direction.keywords)
    .map((keyword) => keyword.normalize("NFKC")
      .replace(/[\\"()[\]{}:+*?~^]/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean))];
}

function matchResearchDirections(text: string, directions: ResearchDirection[]): ResearchDirection[] {
  const normalizedText = text.normalize("NFKC").toLocaleLowerCase();
  return directions.filter((direction) => direction.keywords.some((keyword) => {
    const normalizedKeyword = keyword.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
    if (!normalizedKeyword) return false;
    if (!/^[a-z0-9 ]+$/.test(normalizedKeyword)) return normalizedText.includes(normalizedKeyword);
    const pattern = normalizedKeyword.split(" ").map(escapeRegExp).join("\\s+");
    return new RegExp(`(?:^|[^a-z0-9])${pattern}(?:$|[^a-z0-9])`, "i").test(normalizedText);
  }));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
