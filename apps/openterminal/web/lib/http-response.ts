const MAX_UPSTREAM_RESPONSE_BYTES = 8 * 1024 * 1024;

export async function readLimitedResponse(
  response: Response,
  maximumBytes = MAX_UPSTREAM_RESPONSE_BYTES,
): Promise<ArrayBuffer | null> {
  if (response.status === 204) return null;
  const reader = response.body?.getReader();
  if (!reader) return new ArrayBuffer(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel();
      throw new Error("upstream_response_too_large");
    }
    chunks.push(value);
  }
  const combined = Buffer.concat(chunks);
  return combined.buffer.slice(
    combined.byteOffset,
    combined.byteOffset + combined.byteLength,
  ) as ArrayBuffer;
}
