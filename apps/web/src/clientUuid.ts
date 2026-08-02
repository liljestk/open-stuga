let fallbackSequence = 0;

function fallbackBytes(): Uint8Array {
  const bytes = new Uint8Array(16);
  try {
    if (typeof globalThis.crypto?.getRandomValues === "function") {
      globalThis.crypto.getRandomValues(bytes);
      return bytes;
    }
  } catch {
    // Client-side IDs are also needed on older or restricted LAN browsers.
  }

  fallbackSequence += 1;
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }
  const sequence = fallbackSequence ^ Date.now();
  for (let index = 0; index < 6; index += 1) {
    const targetIndex = bytes.length - 1 - index;
    bytes[targetIndex] = bytes[targetIndex]! ^ (sequence >>> (index * 5) & 0xff);
  }
  return bytes;
}

/** Creates an RFC 4122 v4 UUID, including on trusted LAN pages served over HTTP. */
export function createClientUuid(): string {
  try {
    if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  } catch {
    // Fall through when a browser exposes randomUUID but blocks the call.
  }

  const bytes = fallbackBytes();
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
