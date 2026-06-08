// Narrow media-output parsing surface for plugins that need to split MEDIA:
// markers out of tool/agent text output into structured media URLs, without
// pulling in the full media runtime.

export {
  splitMediaFromOutput,
  type SplitMediaFromOutputOptions,
  type ParsedMediaOutputSegment,
} from "../media/parse.js";
