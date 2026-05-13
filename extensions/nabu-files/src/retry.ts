import { RETRY_BACKOFF_MS } from "./nabu-files.constants.js";

export async function withBackoff<T>(opts: {
  attempts: number;
  shouldRetry?: (err: unknown) => boolean;
  run: (attempt: number) => Promise<T>;
}): Promise<T> {
  const max = Math.max(1, opts.attempts);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      return await opts.run(attempt);
    } catch (err) {
      lastErr = err;
      const canRetry = attempt < max && (opts.shouldRetry?.(err) ?? true);
      if (!canRetry) break;
      const delay = RETRY_BACKOFF_MS[attempt - 1] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1];
      await sleep(delay);
    }
  }
  throw lastErr;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 5xx, 429, and network errors retry; other 4xx are terminal.
export function isRetryableHttpError(err: unknown): boolean {
  const status = (err as { statusCode?: number } | null)?.statusCode;
  if (status === undefined) return true;
  if (status === 429) return true;
  if (status >= 500) return true;
  return false;
}
