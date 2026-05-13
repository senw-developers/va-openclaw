export const DEFAULT_API_BASE_URL = "http://app:6001";
export const SKILL_UPLOAD_PATH = "/api/v1/files-api/skill-upload";
export const SKILL_RESOLVE_PATH = "/api/v1/files-api/skill-resolve";
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_MAX_CONCURRENT_UPLOADS = 8;
export const RETRY_BACKOFF_MS = [250, 1_000, 4_000] as const;
// Backend caps each /skill-resolve call at 100 fileIds.
export const RESOLVE_BATCH_MAX = 100;
export const LOG_PREFIX = "[nabu-files]";
export const PLUGIN_ID = "nabu-files";
