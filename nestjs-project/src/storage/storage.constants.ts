/**
 * Storage policy parameters fixed by phase-03-videos/TD-02 and TD-08.
 */
export const STORAGE = {
  /** Presigned URL lifetime for upload parts and streaming/download GETs (1h). */
  PRESIGN_EXPIRES_SECONDS: 3600,
  /** Multipart part size — 100 MiB ⇒ 10GB fits in 100 parts (TD-02). */
  MULTIPART_PART_SIZE_BYTES: 100 * 1024 * 1024,
  /** Max accepted upload size — 10 GiB (TD-02). */
  MAX_UPLOAD_SIZE_BYTES: 10 * 1024 * 1024 * 1024,
  /** Bucket lifecycle: abort incomplete multipart uploads after N days (TD-02, AMB-2). */
  ABORT_INCOMPLETE_MULTIPART_DAYS: 7,
} as const;

/** Object key of a video's original file (TD-08 prefixed layout). */
export function videoOriginalKey(videoId: string): string {
  return `videos/${videoId}/original`;
}

/** Object key of a video's generated thumbnail (TD-08 prefixed layout). */
export function videoThumbnailKey(videoId: string): string {
  return `videos/${videoId}/thumbnail.jpg`;
}
