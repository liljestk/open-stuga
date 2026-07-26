import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;

function decodeKey(value: string): Buffer {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9_-]+$/u.test(normalized)) throw new Error("Tracking key file is invalid");
  const key = Buffer.from(normalized, "base64url");
  if (key.length !== KEY_BYTES || key.toString("base64url") !== normalized) {
    throw new Error("Tracking key file must contain exactly 32 base64url bytes");
  }
  return key;
}

export function loadOrCreateTrackingKey(path: string | null): Buffer {
  if (!path) return randomBytes(KEY_BYTES);
  if (existsSync(path)) return decodeKey(readFileSync(path, "utf8"));
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const key = randomBytes(KEY_BYTES);
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, `${key.toString("base64url")}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, path);
    return key;
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* Best-effort temporary cleanup. */ }
    if (existsSync(path)) return decodeKey(readFileSync(path, "utf8"));
    throw error;
  }
}

export class TrackingSecretBox {
  constructor(private readonly key: Uint8Array) {
    if (key.byteLength !== KEY_BYTES) throw new Error("Tracking encryption key must contain 32 bytes");
  }

  encrypt(secret: Uint8Array): string {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce, { authTagLength: AUTH_TAG_BYTES });
    const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ["v1", nonce.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
  }

  decrypt(envelope: string): Buffer {
    const [version, nonceValue, tagValue, ciphertextValue, extra] = envelope.split(".");
    if (version !== "v1" || !nonceValue || !tagValue || !ciphertextValue || extra !== undefined) {
      throw new Error("Tracking secret envelope is invalid");
    }
    const nonce = Buffer.from(nonceValue, "base64url");
    const tag = Buffer.from(tagValue, "base64url");
    const ciphertext = Buffer.from(ciphertextValue, "base64url");
    if (nonce.length !== NONCE_BYTES || tag.length !== AUTH_TAG_BYTES || ciphertext.length === 0) {
      throw new Error("Tracking secret envelope is invalid");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.key, nonce, { authTagLength: AUTH_TAG_BYTES });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }
}
