export interface NabuFilesConfig {
  apiToken: string;
  apiBaseUrl?: string;
  requestTimeoutMs?: number;
  maxRetries?: number;
  maxConcurrentUploads?: number;
}

// Backend uses `fileId` (aligned with `/skill-resolve`); `id` is tolerated
// for transitional safety against older backend deploys.
export interface FileResource {
  fileId?: number;
  id?: number;
  signedUrl: string;
  signedUrlExpiresAt: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

export type ResolvedFile =
  | {
      fileId: number;
      signedUrl: string;
      signedUrlExpiresAt: string;
      name: string;
      mimeType: string;
      sizeBytes: number;
    }
  | { fileId: number; error: "NOT_FOUND" };

export interface ResolveResponse {
  files: ResolvedFile[];
}

export interface FilesApiErrorEnvelope {
  statusCode?: number;
  code?: string;
  message?: string;
  data?: unknown;
}
