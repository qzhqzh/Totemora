import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

import type { AgentConfig, LocalConfigSet, ModelUsage } from "@totemora/core";
import { CpaImageProvider, resolveProviderConnection, type ImageReference } from "@totemora/providers";

import type {
  ContentIllustrationGenerator,
  ContentWork,
  IllustrationBrief,
  IllustrationGeneration,
  IllustrationReview,
} from "./content-studio-service";

const DEFAULT_IMAGE_MODEL = "gemini-3.1-flash-image";
const REFERENCE_FILES = ["character.png", "style-user-ip.png"];

export class CpaIllustrationService implements ContentIllustrationGenerator {
  private readonly imageProvider: CpaImageProvider;
  private readonly imageModel: string;
  private readonly referenceDir: string;

  constructor(config: LocalConfigSet, dataDir: string, request: typeof fetch = fetch) {
    const provider = config.providers.providers.cpa;
    if (!provider) throw new Error("CPA provider is not configured");
    const connection = resolveProviderConnection("cpa", provider);
    this.imageProvider = new CpaImageProvider({ id: "cpa", ...connection }, request);
    this.imageModel = process.env.TOTEMORA_CPA_IMAGE_MODEL?.trim() || DEFAULT_IMAGE_MODEL;
    this.referenceDir = process.env.TOTEMORA_ILLUSTRATION_REFERENCE_DIR?.trim()
      || join(dataDir, "illustration-references", "user-ip-v1");
  }

  async generate(input: {
    work: ContentWork;
    member: AgentConfig;
    brief: IllustrationBrief;
    onProgress?: (stage: "generating" | "reviewing", attempt: number) => void;
  }): Promise<IllustrationGeneration> {
    const references = await this.loadReferences();
    let lastReview: IllustrationReview | undefined;
    let totalUsage: ModelUsage | undefined;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      input.onProgress?.("generating", attempt);
      const prompt = buildImagePrompt(input.work, input.brief, lastReview);
      const image = await this.imageProvider.generate({ model: this.imageModel, prompt, references });
      totalUsage = sumUsage(totalUsage, image.usage);
      input.onProgress?.("reviewing", attempt);
      const reviewed = await this.imageProvider.review({
        model: input.member.model,
        image: { data: image.data, mimeType: image.mimeType },
        prompt: buildReviewPrompt(input.work, input.brief),
      });
      totalUsage = sumUsage(totalUsage, reviewed.usage);
      const semanticReview = validateReview(parseJson(reviewed.content));
      const gated = await this.imageProvider.review({
        model: input.member.model,
        image: { data: image.data, mimeType: image.mimeType },
        prompt: buildStyleGatePrompt(),
      });
      totalUsage = sumUsage(totalUsage, gated.usage);
      const styleReview = validateReview(parseJson(gated.content));
      lastReview = mergeReviews(semanticReview, styleReview);
      if (lastReview.outcome === "accepted") {
        return {
          data: image.data, mime_type: image.mimeType, width: image.width, height: image.height,
          image_model: image.model, prompt, attempts: attempt, review: lastReview, usage: totalUsage,
          reference_set: REFERENCE_FILES.filter((name) => references.some((reference) => reference.name === name)),
        };
      }
    }
    throw new Error(`绘影在两次尝试后仍未通过视觉验收：${lastReview?.issues.join("；") || "无有效审核结果"}`);
  }

  private async loadReferences(): Promise<Array<ImageReference & { name: string }>> {
    const references: Array<ImageReference & { name: string }> = [];
    for (const name of REFERENCE_FILES) {
      try {
        references.push({ name, data: await readFile(join(this.referenceDir, name)), mimeType: mimeType(name) });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (!references.some((item) => item.name === "character.png")) {
      throw new Error(`绘影缺少角色锚点：${join(this.referenceDir, "character.png")}`);
    }
    return references;
  }
}

function buildImagePrompt(work: ContentWork, brief: IllustrationBrief, previous?: IllustrationReview): string {
  return [
    "Create one square editorial illustration for the supplied Chinese article. Return image only.",
    `Article title: ${work.title ?? work.topic}`,
    `Visual brief: ${JSON.stringify(brief)}`,
    "The FIRST reference is the immutable character anchor: black hair, purple eyes, black clothing with purple trim, and a small black bird on the head. Preserve those identity traits.",
    "The SECOND reference is the exact approved user-IP visual language. Match its character identity, sparse editorial storytelling, white-space ratio, simple flat fills, and imperfect hand-inked contour feel; do not copy its scene.",
    "Keep the full subject cluster about 25–35% of canvas height and roughly 10–20% of total canvas area. A horizontal scene may span up to 55% width when it remains visually tiny inside dominant white space.",
    "Translate the article's central mechanism into one concrete scene. No generic AI brain, glowing circuitry, poster composition, title, caption, readable text, pseudo-writing, scribbled glyphs, logo, watermark, photorealism, 3D render, smooth vector outline, polished anime key art, gradient background, or decorative border. Every paper, label, screen, sign, and document must be completely blank.",
    previous ? `The previous attempt failed review: ${previous.issues.join("; ")}. Correct these defects without changing the character identity.` : "",
    inputRetryFeedback(work),
    "Hard quality gate: outlines must contain obvious broken gaps, uneven pressure, doubled strokes, and visible hand jitter. Smooth continuous vector-clean contours are a failed result.",
    "Aspect ratio 1:1. Background must be neutral pure #FFFFFF white, never cream, ivory, beige, textured, or gradient. Image only.",
  ].filter(Boolean).join("\n");
}

function buildReviewPrompt(work: ContentWork, brief: IllustrationBrief): string {
  return [
    "You are the tribe member 绘影 performing a strict visual QA. Inspect the attached image against the article and brief.",
    `Article: ${work.title ?? work.topic}`,
    `Brief: ${JSON.stringify(brief)}`,
    "Reject if any required identity trait is missing; if the scene is generic or unrelated; if background is not pure white; if character is not tiny (roughly 20–40%); if there is readable text/logo/watermark; or if outlines are smooth/vector-clean instead of rough, broken and visibly jittery.",
    "Return strict JSON only: {outcome:'accepted'|'changes_requested',semantic_score:0..1,style_score:0..1,line_quality_score:0..1,rationale:string,issues:string[]}. Accept only when all three scores are at least 0.72 and no hard rejection applies.",
  ].join("\n");
}

function buildStyleGatePrompt(): string {
  return [
    "Act as an adversarial production gate. Ignore beauty and inspect the attached image at high zoom.",
    "Hard reject if: (1) background is cream/ivory/beige/textured instead of neutral pure white; (2) any paper, label, screen, block or prop contains readable text, pseudo-writing, scribbled glyphs, signature, logo, or watermark; (3) primary outlines are mechanically uniform, vector-clean, or polished anime rather than visibly imperfect hand-inked strokes with some gaps, pressure variation or jitter; (4) the black-haired purple-eyed black-and-purple character or black bird identity is missing; (5) the subject cluster is taller than about 40% of the canvas or visually overwhelms the dominant white space. A sparse horizontal scene up to 55% width is allowed.",
    "Do not excuse a defect because the overall image is attractive. Return strict JSON only: {outcome:'accepted'|'changes_requested',semantic_score:0..1,style_score:0..1,line_quality_score:0..1,rationale:string,issues:string[]}. Any hard reject must produce changes_requested and a concrete issue.",
  ].join("\n");
}

function validateReview(value: unknown): IllustrationReview {
  const input = value as Partial<IllustrationReview>;
  if (!input || !["accepted", "changes_requested"].includes(input.outcome ?? "")
    || !score(input.semantic_score) || !score(input.style_score) || !score(input.line_quality_score)
    || typeof input.rationale !== "string" || !Array.isArray(input.issues)
    || !input.issues.every((item) => typeof item === "string")) {
    throw new Error("绘影返回了无效的视觉审核结果");
  }
  const outcome = input.semantic_score! >= 0.72 && input.style_score! >= 0.72
    && input.line_quality_score! >= 0.72 && input.issues.length === 0
    ? "accepted" : "changes_requested";
  return { ...input as IllustrationReview, outcome };
}

function mergeReviews(semantic: IllustrationReview, style: IllustrationReview): IllustrationReview {
  const issues = [...new Set([...semantic.issues, ...style.issues])];
  const semanticScore = Math.min(semantic.semantic_score, style.semantic_score);
  const styleScore = Math.min(semantic.style_score, style.style_score);
  const lineQualityScore = Math.min(semantic.line_quality_score, style.line_quality_score);
  const outcome = semantic.outcome === "accepted" && style.outcome === "accepted"
    && semanticScore >= 0.72 && styleScore >= 0.72 && lineQualityScore >= 0.72 && issues.length === 0
    ? "accepted" : "changes_requested";
  return {
    outcome, semantic_score: semanticScore, style_score: styleScore, line_quality_score: lineQualityScore,
    rationale: `语义审查：${semantic.rationale}；对抗式风格门禁：${style.rationale}`,
    issues,
  };
}

function parseJson(content: string): unknown {
  const stripped = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  try { return JSON.parse(start >= 0 && end > start ? stripped.slice(start, end + 1) : stripped); }
  catch { throw new Error("绘影返回了无效 JSON"); }
}

function score(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function mimeType(name: string): ImageReference["mimeType"] {
  const extension = extname(name).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  return "image/jpeg";
}

function sumUsage(left?: ModelUsage, right?: ModelUsage): ModelUsage | undefined {
  if (!left && !right) return undefined;
  return {
    inputTokens: (left?.inputTokens ?? 0) + (right?.inputTokens ?? 0),
    outputTokens: (left?.outputTokens ?? 0) + (right?.outputTokens ?? 0),
    totalTokens: (left?.totalTokens ?? 0) + (right?.totalTokens ?? 0),
  };
}

function inputRetryFeedback(work: ContentWork): string {
  return work.illustration?.retry_feedback
    ? `A previous job failed the production gate: ${work.illustration.retry_feedback}. Treat every listed defect as a hard correction requirement.`
    : "";
}
