import "server-only";

/** Copy bytes into an owned ArrayBuffer accepted by Fetch BodyInit. */
export function copyBytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  return body;
}
