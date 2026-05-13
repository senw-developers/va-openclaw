// Companion to media-uploader; resolves opaque fileIds to fresh signed URLs.
// Single-registration policy: a second register overwrites and warns.

export type MediaResolverInput = {
  readonly fileIds: ReadonlyArray<number>;
  readonly expirySeconds?: number;
  readonly requestId?: string;
};

export type FileRef =
  | {
      readonly fileId: number;
      readonly signedUrl: string;
      readonly signedUrlExpiresAt: string;
      readonly name: string;
      readonly mimeType: string;
      readonly sizeBytes: number;
    }
  | {
      readonly fileId: number;
      readonly error: "NOT_FOUND";
    };

export type MediaResolver = (input: MediaResolverInput) => Promise<ReadonlyArray<FileRef>>;

let registered: MediaResolver | null = null;

export function registerMediaResolver(resolver: MediaResolver): () => void {
  if (registered !== null) {
    // eslint-disable-next-line no-console
    console.warn(
      "[plugin-sdk/media-resolver] overwriting previously-registered resolver; only one plugin should provide this",
    );
  }
  registered = resolver;
  return () => {
    if (registered === resolver) {
      registered = null;
    }
  };
}

export function getMediaResolver(): MediaResolver | null {
  return registered;
}

export function __resetMediaResolverForTests(): void {
  if (!process.env.VITEST && process.env.NODE_ENV !== "test") {
    throw new Error("__resetMediaResolverForTests is only available in test environments");
  }
  registered = null;
}
