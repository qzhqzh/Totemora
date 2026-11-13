import { createHash } from "node:crypto";

import { normalizeCollectedDeal, type CollectedDeal } from "../domains/deals/deal";
import { DealSourceAccessBlockedError } from "../domains/deals/deal-retry";
import { readBoundedResponseText } from "./bounded-response";

const DEFAULT_SOURCE = "https://m.tuihaowu.com/cuxiao.aspx";
const MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024;
const MAX_ITEMS = 100;
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

interface DraftDeal {
  href?: string;
  image?: string;
  title: string[];
  deal: string[];
  merchant: string[];
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class DealsSourceClient {
  private readonly sourceUrl: string;

  constructor(private readonly options: {
    sourceUrl?: string;
    fetchImpl?: FetchLike;
    timeoutMs?: number;
  } = {}) {
    this.sourceUrl = sourcePage(options.sourceUrl ?? DEFAULT_SOURCE);
  }

  async collect(): Promise<CollectedDeal[]> {
    const endpoint = new URL(this.sourceUrl);
    endpoint.search = new URLSearchParams({ method: "get_list", page: "1", classid: "" }).toString();
    const { response, url } = await this.fetchSource(endpoint);
    if (!response.ok) {
      await response.body?.cancel();
      if ([401, 403].includes(response.status)) {
        throw new DealSourceAccessBlockedError(`upstream returned HTTP ${response.status}; source access requires review`);
      }
      throw new Error(`Deals source returned HTTP ${response.status}`);
    }
    const text = await readBoundedResponseText(response, MAX_RESPONSE_BYTES, "Deals source response exceeds 2097152 bytes");
    let payload: unknown;
    try { payload = JSON.parse(text); }
    catch { throw new Error("Deals source returned invalid JSON"); }
    const value = payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload as Record<string, unknown> : {};
    const data = value.data && typeof value.data === "object" && !Array.isArray(value.data)
      ? value.data as Record<string, unknown> : {};
    if (value.code !== 1 || typeof data.html !== "string" || !data.html.trim()) {
      throw new Error("Deals source returned an unsupported payload");
    }
    return parseDealsFragment(data.html, url.toString());
  }

  private async fetchSource(endpoint: URL): Promise<{ response: Response; url: URL }> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const request: RequestInit = {
      headers: {
        Accept: "application/json",
        Referer: this.sourceUrl,
        "User-Agent": "Totemora-deals/1.0",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000),
    };
    let url = endpoint;
    for (let redirects = 0; ; redirects += 1) {
      const response = await fetchImpl(url, request);
      if (!REDIRECT_STATUSES.has(response.status)) return { response, url };
      await response.body?.cancel();
      if (redirects >= MAX_REDIRECTS) throw new Error(`Deals source exceeds ${MAX_REDIRECTS} redirects`);
      url = redirectTarget(response.headers.get("location"), url, endpoint.origin);
    }
  }
}

function redirectTarget(location: string | null, current: URL, sourceOrigin: string): URL {
  if (!location || location.length > 2_048 || /[\u0000-\u001F\u007F]/.test(location)) {
    throw new Error("Deals source redirect has no valid location");
  }
  let target: URL;
  try { target = new URL(location, current); }
  catch { throw new Error("Deals source redirect has no valid location"); }
  if (target.protocol !== "https:" || target.username || target.password) {
    throw new Error("Deals source redirect must use HTTPS without credentials");
  }
  if (target.origin !== sourceOrigin) {
    throw new DealSourceAccessBlockedError(`redirected outside its configured origin (${target.hostname}); source access requires review`);
  }
  target.hash = "";
  return target;
}

export async function parseDealsFragment(fragment: string, sourceUrl = DEFAULT_SOURCE): Promise<CollectedDeal[]> {
  if (!fragment.trim() || Buffer.byteLength(fragment, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error("Deals source HTML is empty or too large");
  }
  const drafts: DraftDeal[] = [];
  let current: DraftDeal | undefined;
  const rewriter = new HTMLRewriter()
    .on("li.clearfix", { element(element) {
      const draft: DraftDeal = { title: [], deal: [], merchant: [] };
      current = draft;
      element.onEndTag(() => {
        drafts.push(draft);
        if (current === draft) current = undefined;
      });
    } })
    .on("li.clearfix a[href]", { element(element) {
      if (current && !current.href) current.href = element.getAttribute("href") ?? undefined;
    } })
    .on("li.clearfix img[src]", { element(element) {
      if (current && !current.image) current.image = element.getAttribute("src") ?? undefined;
    } })
    .on("li.clearfix div.title", { text(text) { if (current) current.title.push(text.text); } })
    .on("li.clearfix div.title span", { text(text) { if (current) current.deal.push(text.text); } })
    .on("li.clearfix span.mall", { text(text) { if (current) current.merchant.push(text.text); } });
  await rewriter.transform(new Response(fragment)).text();
  if (drafts.length > MAX_ITEMS) throw new Error(`Deals source exceeds ${MAX_ITEMS} items`);

  const parsed: CollectedDeal[] = [];
  const seen = new Set<string>();
  const sourceOrigin = new URL(sourcePage(sourceUrl)).origin;
  for (const [index, draft] of drafts.entries()) {
    try {
      if (!draft.href) continue;
      const url = new URL(draft.href, sourceUrl);
      if (url.origin !== sourceOrigin) continue;
      const dealText = cleanText(draft.deal.join(" "));
      const combinedTitle = cleanText(draft.title.join(" "));
      const title = dealText && combinedTitle.endsWith(dealText)
        ? cleanText(combinedTitle.slice(0, -dealText.length)) : combinedTitle;
      const sourceId = url.searchParams.get("id")?.trim() || `url:${createHash("sha256").update(url.toString()).digest("hex")}`;
      const image = normalizeOptionalUrl(draft.image, sourceUrl);
      const item = normalizeCollectedDeal({
        source_id: sourceId,
        title,
        deal_text: dealText,
        merchant: cleanText(draft.merchant.join(" ")),
        source_url: url.toString(),
        ...(image ? { image_url: image } : {}),
        source_rank: index + 1,
      });
      if (!seen.has(item.source_id)) {
        seen.add(item.source_id);
        parsed.push(item);
      }
    } catch {
      // One malformed card must not hide valid sibling cards; an entirely changed source still fails below.
    }
  }
  if (!parsed.length) throw new Error("Deals source HTML structure no longer contains valid items");
  return parsed;
}

function sourcePage(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("Deals source URL must be valid HTTPS"); }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Deals source URL must be HTTPS without credentials");
  }
  url.search = "";
  url.hash = "";
  return url.toString();
}

function normalizeOptionalUrl(value: string | undefined, base: string): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value, base);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : undefined;
  } catch { return undefined; }
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
