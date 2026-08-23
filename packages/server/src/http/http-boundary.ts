const DEFAULT_JSON_LIMIT = 128_000;

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

export async function readJson(request: Request, maximumBytes = DEFAULT_JSON_LIMIT): Promise<unknown> {
  const value = await readBody(request, maximumBytes);
  if (!value.length) throw new HttpError(400, "Request body must contain JSON");
  return parseJson(value);
}

export async function readOptionalJson(request: Request, maximumBytes = DEFAULT_JSON_LIMIT): Promise<unknown> {
  const value = await readBody(request, maximumBytes);
  return value.length ? parseJson(value) : {};
}

async function readBody(request: Request, maximumBytes: number): Promise<Uint8Array> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new HttpError(413, "Request body is too large");
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("Request body is too large");
        throw new HttpError(413, "Request body is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, "Request body must contain valid JSON");
  }
}
