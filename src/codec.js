/** Chrome messages are JSON, so encode binary values before crossing contexts. */
export function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(binary);
}
export function base64ToBytes(value) { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
export async function pack(value) {
  if (value instanceof Blob) return { __applyBotBinary: "blob", type: value.type, data: bytesToBase64(new Uint8Array(await value.arrayBuffer())) };
  if (value instanceof Uint8Array) return { __applyBotBinary: "bytes", data: bytesToBase64(value) };
  if (Array.isArray(value)) return Promise.all(value.map(pack));
  if (value && typeof value === "object") return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([k, v]) => [k, await pack(v)])));
  return value;
}
export function unpack(value) {
  if (value?.__applyBotBinary === "blob") return new Blob([base64ToBytes(value.data)], { type: value.type });
  if (value?.__applyBotBinary === "bytes") return base64ToBytes(value.data);
  if (Array.isArray(value)) return value.map(unpack);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unpack(v)]));
  return value;
}
