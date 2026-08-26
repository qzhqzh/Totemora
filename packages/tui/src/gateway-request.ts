export type GatewayFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const MAX_GATEWAY_RESPONSE_BYTES = 2 * 1024 * 1024;

export async function requestGatewayJson<T>(
  request: GatewayFetch,
  url: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await request(url, init);
  const raw = await readBoundedText(response);
  let payload: unknown;
  try { payload = JSON.parse(raw); }
  catch { throw new Error(`Gateway returned invalid JSON (${response.status})`); }
  if (!response.ok) {
    const detail = payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as { error?: unknown }).error
      : undefined;
    throw new Error(typeof detail === "string" ? detail : `Gateway request failed (${response.status})`);
  }
  return payload as T;
}

async function readBoundedText(response: Response): Promise<string> {
  const message = "Gateway response exceeds 2 MiB";
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_GATEWAY_RESPONSE_BYTES) throw new Error(message);
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_GATEWAY_RESPONSE_BYTES) {
        await reader.cancel(message);
        throw new Error(message);
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
  return new TextDecoder().decode(bytes);
}
