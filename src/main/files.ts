import { open, stat } from "node:fs/promises";
import path from "node:path";
import type { UploadSource } from "./fluxer/rest";

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
};

/** A best guess from the extension; the server may correct it in its upload plan. */
export function contentTypeFor(filename: string): string {
  return CONTENT_TYPES[path.extname(filename).toLowerCase()] ?? "application/octet-stream";
}

/** Opens a local file for upload, reading only the ranges asked for so large files never sit in memory whole. */
export async function uploadSource(filePath: string): Promise<UploadSource> {
  const { size } = await stat(filePath);
  const filename = path.basename(filePath);
  return {
    filename,
    size,
    contentType: contentTypeFor(filename),
    read: async (start, end) => {
      const handle = await open(filePath, "r");
      try {
        const buffer = Buffer.alloc(Math.max(0, end - start));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
        return buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    },
  };
}
