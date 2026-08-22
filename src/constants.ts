// =============================================================================
// picc-read — constants
//
// Ported from the claude-code replication's `constants/apiLimits.ts` and
// `tools/FileReadTool/limits.ts`.
// =============================================================================

// -----------------------------------------------------------------------------
// Image / PDF API limits (constants/apiLimits.ts)
// -----------------------------------------------------------------------------

export const IMAGE_MAX_WIDTH = 2000;
export const IMAGE_MAX_HEIGHT = 2000;
export const IMAGE_TARGET_RAW_SIZE = 3_750_000; // ~3.75MB target after compression
export const API_IMAGE_MAX_BASE64_SIZE = 5 * 1024 * 1024; // 5MB hard cap on base64 payload

export const PDF_TARGET_RAW_SIZE = 20 * 1024 * 1024; // 20 MB (base64 doc limit)
export const API_PDF_MAX_PAGES = 100;
export const PDF_EXTRACT_SIZE_THRESHOLD = 3 * 1024 * 1024; // 3 MB
export const PDF_MAX_EXTRACT_SIZE = 100 * 1024 * 1024; // 100 MB
export const PDF_MAX_PAGES_PER_READ = 20;
export const PDF_AT_MENTION_INLINE_THRESHOLD = 10;

// -----------------------------------------------------------------------------
// Read tool limits (tools/FileReadTool/limits.ts)
// -----------------------------------------------------------------------------

/** Default cap on output tokens for a single read (~4MB of text, or 32MB with 1M context). */
export const DEFAULT_MAX_OUTPUT_TOKENS = 25_000;

/** Whole-file pre-read cap: files larger than this are never loaded whole. */
export const MAX_OUTPUT_SIZE = 256 * 1024; // 256KB

/** Hard floor when the user overrides via PICC_READ_MAX_OUTPUT_TOKENS. */
export const MINIMUM_READ_TOKENS = 1_000;

/** Prompt-side line constant (tools/FileReadTool/prompt.ts). */
export const MAX_LINES_TO_READ = 2_000;

// -----------------------------------------------------------------------------
// Image formats (FileReadTool.ts)
// -----------------------------------------------------------------------------

export const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
export const IMAGE_MIME_TYPES = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
]);
export const MAX_IMAGE_SIZE_FOR_QWEN = 5 * 1024 * 1024; // 5MB

// -----------------------------------------------------------------------------
// Notebook (utils/notebook.ts)
// -----------------------------------------------------------------------------

export const MAX_NOTEBOOK_SIZE = 10 * 1024 * 1024; // 10MB
