import {
  type StugubyDeletionReceipt,
  type StugubyBlobMediaType,
  type StugubyBlobReference,
  type StugubyMember,
  type StugubySignedEvent,
  type StugubySummary,
} from "@climate-twin/stuguby-protocol";
import { StugubyError } from "../support/01-stuguby-error-to-without-local-grant-identity.js";
import { StugubyServiceCore as StugubyService } from "../core.js";
import "../core.js";

declare module "../core.js" {
  interface StugubyServiceInternals {
    recordDeletionReceipt(actor: StugubyMember, receipt: StugubyDeletionReceipt): void;
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
    requireStuguby(id: string): StugubySummary;
    requireLocalPublisher(id: string): StugubySummary;
    requireCoordinator(id: string): StugubySummary;
    requireReadyCoordinator(id: string): StugubySummary;
  }

  interface StugubyServiceCore {
    recordDeletionReceipt(actor: StugubyMember, receipt: StugubyDeletionReceipt): void;
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
