import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { STUGBY_PROTOCOL_VERSION, type StugbyNodeIdentity } from "@climate-twin/stugby-protocol";
import { durableAtomicWriteFileSync } from "./durable-write.js";

interface StoredNodeIdentity {
  version: 1;
  nodeId: string;
  displayName: string;
  publicKey: string;
  privateKey: string;
  createdAt: string;
}

export interface StugbyNodeKeys {
  identity: StugbyNodeIdentity;
  sign(value: string | Uint8Array): string;
  verify(value: string | Uint8Array, signature: string, publicKey?: string): boolean;
}

function fingerprint(publicKey: string): string {
  return createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex");
}

function nodeKeys(stored: StoredNodeIdentity): StugbyNodeKeys {
  const privateKey = createPrivateKey({ key: Buffer.from(stored.privateKey, "base64"), format: "der", type: "pkcs8" });
  const ownPublicKey = createPublicKey({ key: Buffer.from(stored.publicKey, "base64"), format: "der", type: "spki" });
  const identity: StugbyNodeIdentity = {
    nodeId: stored.nodeId,
    displayName: stored.displayName,
    publicKey: stored.publicKey,
    keyFingerprint: fingerprint(stored.publicKey),
    protocolVersion: STUGBY_PROTOCOL_VERSION,
  };
  return {
    identity,
    sign: (value) => sign(null, typeof value === "string" ? Buffer.from(value) : value, privateKey).toString("base64"),
    verify: (value, signature, publicKey = stored.publicKey) => {
      try {
        const key: KeyObject = publicKey === stored.publicKey
          ? ownPublicKey
          : createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" });
        return verify(null, typeof value === "string" ? Buffer.from(value) : value, key, Buffer.from(signature, "base64"));
      } catch {
        return false;
      }
    },
  };
}

function generate(displayName: string): StoredNodeIdentity {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    version: 1,
    nodeId: randomUUID(),
    displayName,
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    createdAt: new Date().toISOString(),
  };
}

function parseStoredIdentity(content: string): StoredNodeIdentity {
  const value = JSON.parse(content) as Partial<StoredNodeIdentity>;
  if (value.version !== 1 || typeof value.nodeId !== "string" || typeof value.displayName !== "string"
    || typeof value.publicKey !== "string" || typeof value.privateKey !== "string" || typeof value.createdAt !== "string") {
    throw new Error("The Stugby node identity file is invalid");
  }
  const stored = value as StoredNodeIdentity;
  const derivedPublic = createPublicKey(createPrivateKey({
    key: Buffer.from(stored.privateKey, "base64"),
    format: "der",
    type: "pkcs8",
  })).export({ format: "der", type: "spki" }).toString("base64");
  if (derivedPublic !== stored.publicKey) throw new Error("The Stugby node identity key pair does not match");
  return stored;
}

/**
 * The private node key is an internal implementation secret. It is never
 * represented by a Stugby grant or returned by any federation/admin route.
 */
export function loadOrCreateStugbyNodeKeys(path: string | null, displayName = "Stuga"): StugbyNodeKeys {
  if (!path) return nodeKeys(generate(displayName));
  if (existsSync(path)) return nodeKeys(parseStoredIdentity(readFileSync(path, "utf8")));
  const stored = generate(displayName);
  durableAtomicWriteFileSync(path, `${JSON.stringify(stored, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return nodeKeys(stored);
}

export function publicKeyFingerprint(publicKey: string): string {
  return fingerprint(publicKey);
}
