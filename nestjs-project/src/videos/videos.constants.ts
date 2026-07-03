export const VIDEO_QUEUE = 'video-processing' as const;

export const VIDEO_JOB = {
  PROCESS: 'process-video',
} as const;

export const PUBLIC_ID_LENGTH = 11 as const;

// URL-safe alphabet without `_`/`-` so ids are clean in URLs (TD-05).
export const PUBLIC_ID_ALPHABET =
  '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ' as const;

export const PUBLIC_ID_MAX_RETRIES = 5 as const;

// Accepted video MIME types (TD-02). Enforced in the service (not the DTO) so a
// rejection maps to the INVALID_CONTENT_TYPE domain code, not a generic 400.
export const ALLOWED_CONTENT_TYPES = [
  'video/mp4',
  'video/webm',
  'video/x-matroska',
  'video/quicktime',
] as const;
