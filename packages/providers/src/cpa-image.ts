import type { ModelUsage } from "@totemora/core";

import type { FetchLike, OpenAICompatibleProviderOptions } from "./openai-compatible";
import { readBoundedResponseText } from "./bounded-response";

export interface ImageReference {
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  data: Uint8Array;
}

export interface CpaImageResult extends ImageReference {
  model: string;
  width: number;
  height: number;
  usage?: ModelUsage;
}

interface ChatImageResponse {
  choices?: Array<{ message?: { content?: string | null; images?: Array<{ image_url?: { url?: string } | string }> } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

const MAX_RESPONSE_BYTES = 24 * 1024 * 1024;
const MAX_IMAGE_EDGE = 8_192;
const MAX_IMAGE_PIXELS = 40_000_000;

export class CpaImageProvider {
  constructor(
    private readonly options: OpenAICompatibleProviderOptions,
    private readonly request: FetchLike = fetch,
  ) {}

  async generate(input: {
    model: string;
    prompt: string;
    references?: ImageReference[];
    signal?: AbortSignal;
  }): Promise<CpaImageResult> {
    const payload = await this.complete(input.model, input.prompt, input.references ?? [], input.signal);
    const imageUrl = payload.choices?.[0]?.message?.images?.[0]?.image_url;
    const url = typeof imageUrl === "string" ? imageUrl : imageUrl?.url;
    if (!url) throw new Error("CPA image model returned no image content");
    const image = decodeDataUrl(url);
    const dimensions = imageDimensions(image.data, image.mimeType);
    return { ...image, ...dimensions, model: input.model, usage: mapUsage(payload.usage) };
  }

  async review(input: {
    model: string;
    prompt: string;
    image: ImageReference;
    signal?: AbortSignal;
  }): Promise<{ content: string; usage?: ModelUsage }> {
    const payload = await this.complete(input.model, input.prompt, [input.image], input.signal);
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error("CPA visual reviewer returned no text content");
    return { content, usage: mapUsage(payload.usage) };
  }

  private async complete(model: string, prompt: string, references: ImageReference[], signal?: AbortSignal): Promise<ChatImageResponse> {
    if (!this.options.apiKey) throw new Error(`Missing API key for provider: ${this.options.id}`);
    const url = `${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`;
    assertSecureEndpoint(url);
    const body = JSON.stringify({
      model,
      stream: false,
      messages: [{ role: "user", content: [
        { type: "text", text: prompt },
        ...references.map((reference) => ({
          type: "image_url",
          image_url: { url: `data:${reference.mimeType};base64,${Buffer.from(reference.data).toString("base64")}` },
        })),
      ] }],
    });
    let lastError = "";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await this.request(url, {
          method: "POST",
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000),
          headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json" },
          body,
        });
        const raw = await readBoundedResponseText(
          response,
          MAX_RESPONSE_BYTES,
          "CPA image response exceeds 24 MiB",
        );
        if (!response.ok) {
          lastError = `CPA image request failed (${response.status}): ${raw.replace(/\s+/g, " ").slice(0, 500) || "empty response"}`;
          if ((response.status === 429 || response.status >= 500) && attempt < 2) {
            await delay(1_000 * (attempt + 1));
            continue;
          }
          throw new Error(lastError);
        }
        try { return JSON.parse(raw) as ChatImageResponse; }
        catch { throw new Error("CPA image provider returned invalid JSON"); }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("CPA image request failed")) throw error;
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt < 2) { await delay(1_000 * (attempt + 1)); continue; }
      }
    }
    throw new Error(`CPA image request failed after bounded retries: ${lastError || "unknown network error"}`);
  }
}

function decodeDataUrl(url: string): ImageReference {
  const match = url.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\r\n]+)$/);
  if (!match) throw new Error("CPA image provider returned an unsupported image URL");
  const data = Buffer.from(match[2]!, "base64");
  if (data.length === 0 || data.length > 16 * 1024 * 1024) throw new Error("CPA image payload is empty or exceeds 16 MiB");
  const mimeType = match[1] as ImageReference["mimeType"];
  assertMagic(data, mimeType);
  return { mimeType, data };
}

function assertMagic(data: Uint8Array, mimeType: ImageReference["mimeType"]): void {
  const valid = mimeType === "image/jpeg"
    ? data[0] === 0xff && data[1] === 0xd8
    : mimeType === "image/png"
      ? Buffer.from(data.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : Buffer.from(data.subarray(0, 4)).toString("ascii") === "RIFF" && Buffer.from(data.subarray(8, 12)).toString("ascii") === "WEBP";
  if (!valid) throw new Error(`CPA image bytes do not match ${mimeType}`);
}

function imageDimensions(data: Uint8Array, mimeType: ImageReference["mimeType"]): { width: number; height: number } {
  let dimensions: { width: number; height: number } | undefined;
  if (mimeType === "image/png") {
    if (data.length < 24) throw new Error("CPA image PNG header is truncated");
    dimensions = { width: readU32(data, 16), height: readU32(data, 20) };
  }
  if (!dimensions && mimeType === "image/jpeg") {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) { offset += 1; continue; }
      const marker = data[offset + 1]!;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        dimensions = { height: (data[offset + 5]! << 8) | data[offset + 6]!, width: (data[offset + 7]! << 8) | data[offset + 8]! };
        break;
      }
      const length = (data[offset + 2]! << 8) | data[offset + 3]!;
      if (length < 2) break;
      offset += 2 + length;
    }
  }
  if (!dimensions && mimeType === "image/webp" && data.length >= 30 && Buffer.from(data.subarray(12, 16)).toString("ascii") === "VP8X") {
    dimensions = {
      width: 1 + data[24]! + (data[25]! << 8) + (data[26]! << 16),
      height: 1 + data[27]! + (data[28]! << 8) + (data[29]! << 16),
    };
  }
  if (!dimensions) throw new Error(`Unable to read ${mimeType} dimensions`);
  if (dimensions.width < 1 || dimensions.height < 1
    || dimensions.width > MAX_IMAGE_EDGE || dimensions.height > MAX_IMAGE_EDGE
    || dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) {
    throw new Error(`CPA image dimensions are outside the allowed bounds: ${dimensions.width}x${dimensions.height}`);
  }
  return dimensions;
}

function readU32(data: Uint8Array, offset: number): number {
  return ((data[offset]! << 24) | (data[offset + 1]! << 16) | (data[offset + 2]! << 8) | data[offset + 3]!) >>> 0;
}

function mapUsage(usage?: ChatImageResponse["usage"]): ModelUsage | undefined {
  return usage ? { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens, totalTokens: usage.total_tokens } : undefined;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assertSecureEndpoint(value: string): void {
  const endpoint = new URL(value);
  const loopback = endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1" || endpoint.hostname === "[::1]";
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) {
    throw new Error("CPA image provider requires HTTPS unless the endpoint is loopback");
  }
}
