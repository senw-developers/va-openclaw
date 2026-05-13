// Cross-package seam for core consumers that need to call the Files API
// outside the plugin's register() hook.
export { uploadFile, getFileIdsForToolCall, type UploadCallOptions } from "./src/upload.js";
export { resolveFiles } from "./src/resolve.js";
export type {
  FileResource,
  NabuFilesConfig,
  ResolveResponse,
  ResolvedFile,
} from "./src/nabu-files.interface.js";
