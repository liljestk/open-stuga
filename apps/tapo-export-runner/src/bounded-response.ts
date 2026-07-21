export class ResponseLimitError extends Error {
  constructor(readonly maximumBytes: number) {
    super(`Response body exceeds the ${maximumBytes}-byte safety limit`);
    this.name = "ResponseLimitError";
  }
}

/** Reads a web response with both advertised-length and streaming byte caps. */
export async function readBoundedResponseText(response: Response, maximumBytes: number): Promise<string> {
  const advertised = response.headers.get("content-length");
  if (advertised !== null) {
    const length = /^\d+$/u.test(advertised) ? Number(advertised) : Number.NaN;
    if (!Number.isSafeInteger(length) || length < 0 || length > maximumBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new ResponseLimitError(maximumBytes);
    }
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseLimitError(maximumBytes);
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
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
