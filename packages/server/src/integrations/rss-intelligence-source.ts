export interface RssIntelligenceItem {
  title: string;
  link: string;
  published_at?: string;
  source: string;
  category?: string;
  summary?: string;
}

const SUMMARY_LIMIT = 1_200;
const RAW_SUMMARY_LIMIT = 24_000;
const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ",
  ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", hellip: "…", bull: "•",
  middot: "·", copy: "©", reg: "®", trade: "™", times: "×", divide: "÷", laquo: "«", raquo: "»",
};

export function parseRss(xml: string, source: string, category?: string): RssIntelligenceItem[] {
  const items: RssIntelligenceItem[] = [];
  let considered = 0;
  for (const match of xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)) {
    if (considered++ >= 15) break;
    const title = field(match[0], "title");
    const link = field(match[0], "link");
    if (!title || !link) continue;
    const decodedTitle = decodeMetadata(title);
    const summary = sourceSummary(field(match[0], "description"), decodedTitle)
      ?? sourceSummary(field(match[0], "content:encoded"), decodedTitle);
    items.push({ title: decodedTitle, link: decodeMetadata(link), published_at: field(match[0], "pubDate"), source, category,
      ...(summary ? { summary } : {}) });
  }
  return items;
}

function field(xml: string, name: string): string | undefined {
  return xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}\\s*>`, "i"))?.[1]
    ?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
}

// Keep existing metadata/URL decoding intact: no URL canonicalization or rewriting.
function decodeMetadata(value: string): string {
  return value.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&#39;", "'");
}

function sourceSummary(raw: string | undefined, title: string): string | undefined {
  if (!raw) return undefined;
  // Feed responses are already byte-bounded; cap each field before HTML/entity work as well.
  let html = raw.slice(0, RAW_SUMMARY_LIMIT);
  for (let pass = 0; pass < 2; pass += 1) html = decodeEntities(html);
  html = html.replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/<(script|style|noscript|template|svg|math|iframe|object|head|nav|footer|form)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, "");
  if (/<a\b/i.test(html)) {
    // Link lists plus publisher labels are navigation, not an article abstract.
    const surrounding = html.replace(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi, "")
      .replace(/<font\b[^>]*>[\s\S]*?<\/font\s*>/gi, "");
    if (!bodyText(surrounding, title)) return undefined;
  }
  html = html.replace(/<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi, (whole, label: string) => navigationOnly(visibleText(label), title) ? "" : whole);
  const text = bodyText(html, title);
  return text ? text.slice(0, SUMMARY_LIMIT) : undefined;
}

function bodyText(html: string, title: string): string {
  return visibleText(html).split(/\n+/).map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line && !navigationOnly(line, title)).join(" ").trim();
}

function visibleText(html: string): string {
  return html.replace(/<\/?(?:p|div|li|br|h[1-6]|tr|section|article)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, "").replace(/<[^>]*$/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/gu, "");
}

function navigationOnly(text: string, title: string): boolean {
  const normalized = (value: string) => value.toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");
  if (normalized(text) === normalized(title)) return true;
  if (/^(?:no (?:description|summary)(?: available)?|n\/a|暂无(?:摘要|内容)|无摘要)$/i.test(text.trim())) return true;
  const remainder = text.replace(/https?:\/\/\S+/gi, " ")
    .replace(/\b(?:article(?:\s+url)?|comments?(?:\s+url)?|read\s+more|continue\s+reading|full\s+article|view\s+original|discuss(?:ion)?|share|points)\b/gi, " ")
    .replace(/阅读更多|阅读全文|查看原文|点击阅读|评论|讨论|分享/gu, " ")
    .replace(/[\p{P}\p{S}\p{N}\s]+/gu, "");
  return !remainder;
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]+);/gi, (match, entity: string) => {
    if (!entity.startsWith("#")) return ENTITIES[entity.toLowerCase()] ?? match;
    const code = entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "";
  });
}
