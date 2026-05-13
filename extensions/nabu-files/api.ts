export {
  definePluginEntry,
  type OpenClawConfig,
  type OpenClawPluginApi,
  type PluginLogger,
} from "openclaw/plugin-sdk/plugin-entry";

export {
  getMediaUploader,
  registerMediaUploader,
  type MediaUploader,
  type MediaUploadInput,
  type MediaUploadResult,
} from "openclaw/plugin-sdk/media-uploader";

export {
  getMediaResolver,
  registerMediaResolver,
  type FileRef,
  type MediaResolver,
  type MediaResolverInput,
} from "openclaw/plugin-sdk/media-resolver";
