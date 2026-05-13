// Single-registration policy: a second register overwrites and warns.

export type MediaUploadInput = {
  readonly filePath?: string;
  readonly bytes?: Buffer;
  readonly filename?: string;
  readonly mimeHint?: string;
  readonly responseId?: string;
  readonly mediaIndex?: number;
  readonly toolCallId?: string;
  readonly source?: string;
};

export type MediaUploadResult = {
  readonly fileId: number;
  readonly signedUrl: string;
  readonly signedUrlExpiresAt: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
};

export type MediaUploader = (input: MediaUploadInput) => Promise<MediaUploadResult>;

let registered: MediaUploader | null = null;

export function registerMediaUploader(uploader: MediaUploader): () => void {
  if (registered !== null) {
    // eslint-disable-next-line no-console
    console.warn(
      "[plugin-sdk/media-uploader] overwriting previously-registered uploader; only one plugin should provide this",
    );
  }
  registered = uploader;
  return () => {
    if (registered === uploader) {
      registered = null;
    }
  };
}

export function getMediaUploader(): MediaUploader | null {
  return registered;
}

export function __resetMediaUploaderForTests(): void {
  if (!process.env.VITEST && process.env.NODE_ENV !== "test") {
    throw new Error("__resetMediaUploaderForTests is only available in test environments");
  }
  registered = null;
}
