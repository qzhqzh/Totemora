const GATEWAY_RESPONSE_LIMIT_BYTES = 2 * 1024 * 1024;

export async function readGatewayResponseText(response: Response): Promise<string> {
  const message = "Totemora Gateway response exceeds 2 MiB";
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > GATEWAY_RESPONSE_LIMIT_BYTES) throw new Error(message);
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > GATEWAY_RESPONSE_LIMIT_BYTES) {
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
