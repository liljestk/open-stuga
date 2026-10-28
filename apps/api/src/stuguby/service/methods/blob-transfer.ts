import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { STUGBY_MAX_BLOB_BYTES, STUGBY_MEDIA_TYPE, STUGBY_PROTOCOL_VERSION, requestSigningValue, type StugubyBlobMediaType, type StugubyBlobReference, type StugubyMember, type StugubySignedEvent, type StugubySummary } from "@climate-twin/stuguby-protocol";
import { durableAtomicWriteFileSync } from "../../durable-write.js";
import { STUGBY_MAX_STAGED_BLOB_BYTES, sha256 } from "../support/federation-validation.js";
import { StugubyError } from "../support/service-types.js";
import { StugubyServiceCore as StugubyService, registerStugubyServiceMethods, stugubyServiceState, type StugubyServiceInternals } from "../core.js";

declare module "../core.js" {
  interface StugubyServiceInternals {
    downloadReferencedBlobs(
        stuguby: StugubySummary,
        event: StugubySignedEvent,
        references: StugubyBlobReference[],
      ): Promise<void>;
    signedFetch(stuguby: StugubySummary, path: string, input: { method: string; body?: string | Uint8Array; contentType?: string; signal?: AbortSignal; stream?: boolean }): Promise<Response>;
    readBoundedResponse(response: Response, maximumBytes: number, code: string, message: string): Promise<Uint8Array>;
    remoteError(response: Response, fallback: string): Promise<StugubyError>;
    readJsonResponse(response: Response, maximumBytes: number, label: string): Promise<unknown>;
    storeDataUrl(value: string): { digest: string; byteLength: number; mediaType: "image/png" | "image/jpeg" | "image/webp" };
    storeBlob(data: Uint8Array, mediaType: string, expectedDigest?: string): {
            digest: string;
            byteLength: number;
            mediaType: StugubyBlobMediaType;
        };
    storeUploadedBlob(member: StugubyMember, stugubyId: string, data: Uint8Array, mediaType: string, expectedDigest: string): ReturnType<StugubyService["storeBlob"]>;
    deleteUnreferencedBlobs(digests: string[]): void;
    readBlob(digest: string): {
            data: Buffer;
            mediaType: string;
        };
    readBlobFor(member: StugubyMember, stugubyId: string, digest: string): {
            data: Buffer;
            mediaType: string;
        };
  }

  interface StugubyServiceCore {
    storeBlob(data: Uint8Array, mediaType: string, expectedDigest?: string): {
            digest: string;
            byteLength: number;
            mediaType: StugubyBlobMediaType;
        };
    storeUploadedBlob(member: StugubyMember, stugubyId: string, data: Uint8Array, mediaType: string, expectedDigest: string): ReturnType<StugubyService["storeBlob"]>;
    readBlob(digest: string): {
            data: Buffer;
            mediaType: string;
        };
    readBlobFor(member: StugubyMember, stugubyId: string, digest: string): {
            data: Buffer;
            mediaType: string;
        };
  }
}

registerStugubyServiceMethods({
  async downloadReferencedBlobs(this: StugubyServiceInternals,
      stuguby: StugubySummary,
      event: StugubySignedEvent,
      references: StugubyBlobReference[],
    ): Promise<void> {
      if (!event.grantId || event.grantEpoch === null) {
        throw new StugubyError(502, "INVALID_HOME_ASSET_EVENT", "Home asset event is missing its grant identity");
      }
      for (const reference of references) {
        const existing = this.store.getBlob(reference.digest);
        if (existing && (existing.byteLength !== reference.byteLength || existing.mediaType !== reference.mediaType)) {
          throw new StugubyError(502, "HOME_ASSET_REFERENCE_MISMATCH", "Stored Home asset metadata does not match its signed reference");
        }
        if (!existing) {
          const response = await this.signedFetch(stuguby, `/api/v1/stugby-protocol/stugbys/${encodeURIComponent(stuguby.id)}/blobs/${reference.digest}`, { method: "GET" });
          if (!response.ok) throw await this.remoteError(response, "Stuguby Home asset download failed");
          const data = await this.readBoundedResponse(
            response,
            reference.byteLength,
            "REMOTE_BLOB_TOO_LARGE",
            "Coordinator returned a Home asset larger than its signed byte length",
          );
          const stored = this.storeBlob(data, response.headers.get("content-type") ?? reference.mediaType, reference.digest);
          if (stored.byteLength !== reference.byteLength || stored.mediaType !== reference.mediaType) {
            throw new StugubyError(502, "HOME_ASSET_REFERENCE_MISMATCH", "Downloaded Home asset metadata does not match its signed reference");
          }
        }
        this.store.registerBlobReference(stuguby.id, reference.digest, event.grantId, event.grantEpoch, "replica");
      }
    },
  async signedFetch(this: StugubyServiceInternals, stuguby: StugubySummary, path: string, input: { method: string; body?: string | Uint8Array; contentType?: string; signal?: AbortSignal; stream?: boolean }): Promise<Response> {
      const state = this[stugubyServiceState];
      const body = typeof input.body === "string" ? new TextEncoder().encode(input.body) : input.body ?? new Uint8Array();
      const timestamp = new Date().toISOString();
      const requestId = randomUUID();
      const signature = this.keys.sign(requestSigningValue({
        method: input.method,
        path,
        bodyHash: sha256(body),
        timestamp,
        requestId,
        nodeId: this.identity.nodeId,
      }));
      const connectController = input.stream ? new AbortController() : null;
      const connectTimer = connectController ? setTimeout(() => {
        connectController.abort(new Error("Stuguby notification stream connection timed out"));
      }, 30_000) : null;
      connectTimer?.unref();
      const signals = [
        state.lifecycleController.signal,
        connectController?.signal ?? AbortSignal.timeout(input.signal ? 60_000 : 30_000),
      ];
      if (input.signal) signals.push(input.signal);
      try {
        return await state.fetcher(`${stuguby.coordinatorUrl}${path}`, {
          method: input.method,
          headers: {
            "accept": STUGBY_MEDIA_TYPE,
            "content-type": input.contentType ?? STUGBY_MEDIA_TYPE,
            "x-stugby-protocol": STUGBY_PROTOCOL_VERSION,
            "x-stugby-node-id": this.identity.nodeId,
            "x-stugby-timestamp": timestamp,
            "x-stugby-request-id": requestId,
            "x-stugby-signature": signature,
          },
          ...(body.byteLength ? { body: Buffer.from(body) } : {}),
          signal: AbortSignal.any(signals),
          redirect: "error",
        });
      } finally {
        if (connectTimer) clearTimeout(connectTimer);
      }
    },
  async readBoundedResponse(this: StugubyServiceInternals, response: Response, maximumBytes: number, code: string, message: string): Promise<Uint8Array> {
      const declaredLength = response.headers.get("content-length");
      if (declaredLength !== null) {
        const parsedLength = Number(declaredLength);
        if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > maximumBytes) {
          await response.body?.cancel().catch(() => undefined);
          throw new StugubyError(502, code, message);
        }
      }
      if (!response.body) return new Uint8Array();
      const reader = response.body.getReader();
      const body = new Uint8Array(maximumBytes);
      let total = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const nextTotal = total + chunk.value.byteLength;
        if (nextTotal > maximumBytes) {
          await reader.cancel().catch(() => undefined);
          throw new StugubyError(502, code, message);
        }
        body.set(chunk.value, total);
        total = nextTotal;
      }
      return body.slice(0, total);
    },
  async remoteError(this: StugubyServiceInternals, response: Response, fallback: string): Promise<StugubyError> {
      let detail = fallback;
      try {
        const body = await this.readJsonResponse(response, 64 * 1024, "Remote error") as {
          error?: { message?: string; code?: string };
          message?: string;
        };
        detail = body.error?.message ?? body.message ?? fallback;
        return new StugubyError(response.status, body.error?.code ?? "REMOTE_ERROR", detail);
      } catch {
        return new StugubyError(response.status, "REMOTE_ERROR", detail);
      }
    },
  async readJsonResponse(this: StugubyServiceInternals, response: Response, maximumBytes: number, label: string): Promise<unknown> {
      const bytes = await this.readBoundedResponse(
        response,
        maximumBytes,
        "REMOTE_RESPONSE_TOO_LARGE",
        `${label} exceeds the maximum accepted size`,
      );
      try {
        return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      } catch {
        throw new StugubyError(502, "INVALID_REMOTE_JSON", `${label} is not valid JSON`);
      }
    },
  storeDataUrl(this: StugubyServiceInternals, value: string): { digest: string; byteLength: number; mediaType: "image/png" | "image/jpeg" | "image/webp" } {
      const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(value);
      if (!match) throw new StugubyError(400, "INVALID_FLOORPLAN_ASSET", "Floor-plan image must be a PNG, JPEG, or WebP data URL");
      const stored = this.storeBlob(Buffer.from(match[2]!, "base64"), match[1]!);
      return { ...stored, mediaType: stored.mediaType as "image/png" | "image/jpeg" | "image/webp" };
    },
  storeBlob(this: StugubyServiceInternals, data: Uint8Array, mediaType: string, expectedDigest?: string): { digest: string; byteLength: number; mediaType: StugubyBlobMediaType } {
      if (data.byteLength === 0 || data.byteLength > STUGBY_MAX_BLOB_BYTES) throw new StugubyError(413, "BLOB_SIZE_INVALID", `Stuguby assets must be between 1 and ${STUGBY_MAX_BLOB_BYTES} bytes`);
      const normalizedMediaType = mediaType.split(";", 1)[0]!.trim().toLowerCase() as StugubyBlobMediaType;
      if (!["image/png", "image/jpeg", "image/webp", "model/gltf+json", "model/gltf-binary"].includes(normalizedMediaType)) {
        throw new StugubyError(415, "BLOB_TYPE_INVALID", "Stuguby accepts PNG, JPEG, WebP, glTF, and GLB Home assets");
      }
      const bytes = Buffer.from(data);
      let signatureValid = normalizedMediaType === "image/png"
        ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : normalizedMediaType === "image/jpeg"
          ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9
          : normalizedMediaType === "image/webp"
            ? bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP"
            : normalizedMediaType === "model/gltf-binary"
              ? bytes.byteLength >= 12 && bytes.subarray(0, 4).toString("ascii") === "glTF"
                && bytes.readUInt32LE(4) === 2 && bytes.readUInt32LE(8) === bytes.byteLength
              : false;
      if (normalizedMediaType === "model/gltf+json") {
        try {
          const gltf = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as { asset?: { version?: unknown } };
          signatureValid = Boolean(gltf && typeof gltf === "object" && gltf.asset
            && typeof gltf.asset === "object" && typeof gltf.asset.version === "string");
        } catch {
          signatureValid = false;
        }
      }
      if (!signatureValid) throw new StugubyError(415, "BLOB_SIGNATURE_INVALID", "Home asset signature does not match its media type");
      const digest = sha256(bytes);
      if (expectedDigest && digest !== expectedDigest) throw new StugubyError(400, "BLOB_DIGEST_MISMATCH", "Home asset digest does not match its reference");
      const existing = this.store.getBlob(digest);
      if (existing && (existing.byteLength !== bytes.byteLength || existing.mediaType !== normalizedMediaType || existing.relativePath !== digest)) {
        throw new StugubyError(409, "BLOB_METADATA_CONFLICT", "Existing Stuguby asset metadata conflicts with the uploaded bytes");
      }
      const finalPath = join(this[stugubyServiceState].assetDirectory, digest);
      if (!existsSync(finalPath)) {
        durableAtomicWriteFileSync(finalPath, bytes, { mode: 0o600 });
      }
      this.store.registerBlob(digest, bytes.byteLength, normalizedMediaType, digest);
      return { digest, byteLength: bytes.byteLength, mediaType: normalizedMediaType };
    },
  storeUploadedBlob(this: StugubyServiceInternals, member: StugubyMember, stugubyId: string, data: Uint8Array, mediaType: string, expectedDigest: string): ReturnType<StugubyService["storeBlob"]> {
      if (member.stugubyId !== stugubyId || member.role === "viewer") {
        throw new StugubyError(403, "VIEWER_CANNOT_PUBLISH", "An active publishing member is required to upload federation assets");
      }
      const alreadyStored = this.store.getBlob(expectedDigest);
      if (!alreadyStored && this.store.unreferencedBlobBytes() + data.byteLength > STUGBY_MAX_STAGED_BLOB_BYTES) {
        throw new StugubyError(507, "BLOB_STAGING_QUOTA", "The coordinator's unreferenced Stuguby asset staging quota is full");
      }
      return this.storeBlob(data, mediaType, expectedDigest);
    },
  deleteUnreferencedBlobs(this: StugubyServiceInternals, digests: string[]): void {
      for (const digest of new Set(digests)) {
        if (!/^[a-f0-9]{64}$/.test(digest) || this.store.hasBlobReferences(digest)) continue;
        try {
          const metadata = this.store.getBlob(digest);
          if (metadata) {
            const path = join(this[stugubyServiceState].assetDirectory, digest);
            if (existsSync(path)) unlinkSync(path);
          }
          this.store.unregisterBlob(digest);
        } catch {
          // The durable queue is retried on service start, synchronization, or
          // an identical deletion receipt. Never turn a committed consent
          // transition into a failed HTTP response because unlink was transient.
        }
      }
    },
  readBlob(this: StugubyServiceInternals, digest: string): { data: Buffer; mediaType: string } {
      if (!/^[a-f0-9]{64}$/.test(digest)) throw new StugubyError(400, "INVALID_BLOB_DIGEST", "Invalid Stuguby asset digest");
      const metadata = this.store.getBlob(digest);
      if (!metadata) throw new StugubyError(404, "BLOB_NOT_FOUND", "Stuguby asset was not found");
      if (metadata.relativePath !== digest) throw new StugubyError(500, "BLOB_METADATA_INVALID", "Stored Stuguby asset metadata is invalid");
      const data = readFileSync(join(this[stugubyServiceState].assetDirectory, digest));
      if (data.byteLength !== metadata.byteLength || sha256(data) !== digest) throw new StugubyError(500, "BLOB_INTEGRITY_FAILURE", "Stored Stuguby asset failed integrity verification");
      return { data, mediaType: metadata.mediaType };
    },
  readBlobFor(this: StugubyServiceInternals, member: StugubyMember, stugubyId: string, digest: string): { data: Buffer; mediaType: string } {
      if (member.stugubyId !== stugubyId || !this.store.canReadBlob(stugubyId, digest, member.nodeId)) {
        throw new StugubyError(404, "BLOB_NOT_FOUND", "Stuguby asset was not found");
      }
      return this.readBlob(digest);
    },
});
