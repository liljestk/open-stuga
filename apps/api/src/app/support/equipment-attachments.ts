import type { EquipmentAttachmentUploadInput } from "@climate-twin/contracts";
import { HttpError } from "../../http-error.js";

export const SAFE_ASSET_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "model/gltf+json",
  "model/gltf-binary",
]);

export const SAFE_EQUIPMENT_PHOTO_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

export const SAFE_EQUIPMENT_DOCUMENT_MIME_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "text/markdown",
  "application/rtf",
  "text/rtf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.oasis.opendocument.text",
]);

export const MAX_EQUIPMENT_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export function equipmentAttachmentData(input: EquipmentAttachmentUploadInput): Buffer {
  const dataUrl = input.data.match(/^data:([^;,]+);base64,(.*)$/su);
  if (dataUrl && dataUrl[1]?.toLowerCase() !== input.mimeType) {
    throw new HttpError(400, "ATTACHMENT_MEDIA_TYPE_MISMATCH", "The data URL media type must match mimeType");
  }
  const encoded = dataUrl?.[2] ?? input.data;
  if (encoded.length > Math.ceil(MAX_EQUIPMENT_ATTACHMENT_BYTES / 3) * 4 + 4) {
    throw new HttpError(413, "ATTACHMENT_TOO_LARGE", "Equipment attachments are limited to 10 MiB");
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
    throw new HttpError(400, "INVALID_ATTACHMENT", "data must contain valid base64 bytes");
  }
  const data = Buffer.from(encoded, "base64");
  if (data.length === 0) throw new HttpError(400, "INVALID_ATTACHMENT", "data must contain valid base64 bytes");
  if (data.length > MAX_EQUIPMENT_ATTACHMENT_BYTES) {
    throw new HttpError(413, "ATTACHMENT_TOO_LARGE", "Equipment attachments are limited to 10 MiB");
  }
  return data;
}

export function assertEquipmentAttachmentMediaType(input: EquipmentAttachmentUploadInput): void {
  const allowed = input.kind === "photo"
    ? SAFE_EQUIPMENT_PHOTO_MIME_TYPES
    : SAFE_EQUIPMENT_DOCUMENT_MIME_TYPES;
  if (!allowed.has(input.mimeType)) {
    throw new HttpError(
      415,
      "UNSUPPORTED_ATTACHMENT_TYPE",
      input.kind === "photo"
        ? "Photos must be PNG, JPEG, or WebP"
        : "Documents must be PDF, text, Markdown, RTF, Word, DOCX, or OpenDocument text",
    );
  }
}

export function equipmentAttachmentDisposition(kind: "photo" | "document", name: string): string {
  const fallback = name
    .replace(/[^\x20-\x7E]/gu, "_")
    .replace(/["\\]/gu, "_")
    .slice(0, 180)
    .trim() || "attachment";
  const encoded = [...Buffer.from(name, "utf8")]
    .map((byte) => `%${byte.toString(16).padStart(2, "0").toUpperCase()}`)
    .join("");
  return `${kind === "photo" ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
