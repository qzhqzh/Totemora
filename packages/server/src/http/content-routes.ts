import type {
  ContentStudioService,
  ContentFormat,
  ContentStudioPreferences,
  ContentWork,
  CreateContentInput,
} from "../content-studio-service";
import { HttpError, json, readJson } from "./http-boundary";
import {
  inputObject,
  optionalBoolean,
  optionalEnum,
  optionalNumber,
  optionalString,
  optionalStringArray,
} from "./input-schema";

export type ContentRouteService = Pick<ContentStudioService,
  "list" | "preferences" | "savePreferences" | "markCopied" | "get" | "retryIllustration" | "readIllustration"
>;

export interface ContentRouteDependencies {
  getContent(): Promise<ContentRouteService>;
  enqueue(input: CreateContentInput): Promise<ContentWork>;
  requireOperator(request: Request): void;
}

const CONTENT_FORMATS = ["x_hot_post", "longform_tutorial"] as const;

export async function handleContentRoutes(
  request: Request,
  url: URL,
  dependencies: ContentRouteDependencies,
): Promise<Response | undefined> {
  if (!url.pathname.startsWith("/api/content")) return undefined;

  if (request.method === "GET" && url.pathname === "/api/content/works") {
    dependencies.requireOperator(request);
    return json({ works: (await dependencies.getContent()).list(readLimit(url)) });
  }
  if (request.method === "POST" && url.pathname === "/api/content/works") {
    dependencies.requireOperator(request);
    const input = createInput(await readJson(request, 16_000));
    return json(await translate(() => dependencies.enqueue(input)), 202);
  }
  if (request.method === "GET" && url.pathname === "/api/content/preferences") {
    return json((await dependencies.getContent()).preferences());
  }
  if (request.method === "PUT" && url.pathname === "/api/content/preferences") {
    dependencies.requireOperator(request);
    const input = preferencesInput(await readJson(request, 8_000));
    return json(await translate(async () => (await dependencies.getContent()).savePreferences(input)));
  }

  const copied = url.pathname.match(/^\/api\/content\/works\/([^/]+)\/copied$/);
  if (request.method === "POST" && copied) {
    dependencies.requireOperator(request);
    return json(await translate(() => dependencies.getContent()
      .then((content) => content.markCopied(copied[1]!))));
  }

  const retry = url.pathname.match(/^\/api\/content\/works\/([^/]+)\/illustration\/retry$/);
  if (request.method === "POST" && retry) {
    dependencies.requireOperator(request);
    const content = await dependencies.getContent();
    const work = content.get(retry[1]!);
    if (!work) return json({ error: "Content work not found" }, 404);
    if (work.status !== "ready" || !work.body) {
      return json({ error: "Only ready content can regenerate an illustration" }, 409);
    }
    void content.retryIllustration(work.id).catch((error) => {
      console.error(JSON.stringify({ event: "content_illustration_retry_failed", work_id: work.id, error: message(error) }));
    });
    return json(work, 202);
  }

  const illustration = url.pathname.match(/^\/api\/content\/works\/([^/]+)\/illustration$/);
  if (request.method === "GET" && illustration) {
    dependencies.requireOperator(request);
    const result = await (await dependencies.getContent()).readIllustration(illustration[1]!);
    if (!result) return json({ error: "Content illustration not found" }, 404);
    return new Response(Buffer.from(result.data), { headers: {
      "content-type": result.mimeType,
      "content-disposition": `inline; filename="${result.filename}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    } });
  }

  const work = url.pathname.match(/^\/api\/content\/works\/([^/]+)$/);
  if (request.method === "GET" && work) {
    dependencies.requireOperator(request);
    const result = (await dependencies.getContent()).get(work[1]!);
    return result ? json(result) : json({ error: "Content work not found" }, 404);
  }
  return undefined;
}

function createInput(value: unknown): CreateContentInput {
  const input = inputObject(value);
  const format = optionalEnum(input.format, "format", CONTENT_FORMATS);
  if (!format) throw new HttpError(400, "format is required");
  return {
    format,
    source_candidate_id: optionalString(input.source_candidate_id, "source_candidate_id", 256),
    topic: optionalString(input.topic, "topic", 2_000),
  };
}

function preferencesInput(value: unknown): Partial<ContentStudioPreferences> {
  const input = inputObject(value);
  const formats = optionalStringArray(input.formats, "formats", 2, 40);
  if (formats?.some((format) => !CONTENT_FORMATS.includes(format as ContentFormat))) {
    throw new HttpError(400, `formats must contain only ${CONTENT_FORMATS.join(", ")}`);
  }
  return {
    enabled: optionalBoolean(input.enabled, "enabled"),
    min_interval_hours: optionalNumber(input.min_interval_hours, "min_interval_hours", { minimum: 1, maximum: 168 }),
    max_interval_hours: optionalNumber(input.max_interval_hours, "max_interval_hours", { minimum: 1, maximum: 168 }),
    formats: formats as ContentFormat[] | undefined,
  };
}

function readLimit(url: URL): number {
  const raw = url.searchParams.get("limit");
  if (raw === null) return 100;
  if (!/^\d+$/.test(raw)) throw new HttpError(400, "limit must be a positive integer");
  return Math.max(1, Math.min(500, Number(raw)));
}

async function translate<T>(operation: () => Promise<T> | T): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const detail = message(error);
    if (detail.startsWith("Intelligence candidate not found:") || detail.startsWith("Content work not found:")) {
      throw new HttpError(404, detail);
    }
    if (detail.startsWith("Only ready content") || detail.startsWith("Content work cannot")) {
      throw new HttpError(409, detail);
    }
    if (detail === "source_candidate_id or topic is required when the candidate pool is empty"
      || detail === "max_interval_hours must be greater than or equal to min_interval_hours"
      || detail === "At least one content format is required") {
      throw new HttpError(400, detail);
    }
    throw error;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
