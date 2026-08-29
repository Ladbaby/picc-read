// =============================================================================
// picc-read — src/tokenEstimation.ts
//
// Adaptor: claude-code uses `countTokensWithAPI` (a model call) as a second
// stage when the rough estimate is high. pi has no token-counting endpoint, so
// the rough estimate alone enforces the cap (as agreed in the plan).
// =============================================================================

import { getEffectiveMaxTokens } from "./limits.js";

/** Rough token estimate: `length / bytesPerToken` (default 4). */
export function roughTokenCountEstimation(
  content: string,
  bytesPerToken: number = 4,
): number {
  return Math.round(content.length / bytesPerToken);
}

/**
 * Returns an estimated bytes-per-token ratio for a given file extension.
 * Dense JSON has many single-character tokens, so its ratio is closer to 2.
 */
export function bytesPerTokenForFileType(fileExtension: string): number {
  switch (fileExtension) {
    case "json":
    case "jsonl":
    case "jsonc":
      return 2;
    default:
      return 4;
  }
}

/** Rough estimate with a type-aware bytes-per-token ratio. */
export function roughTokenCountEstimationForFileType(
  content: string,
  fileExtension: string,
): number {
  return roughTokenCountEstimation(
    content,
    bytesPerTokenForFileType(fileExtension),
  );
}

/** Error thrown when a read exceeds the max-token cap. */
export class MaxFileReadTokenExceededError extends Error {
  constructor(
    public tokenCount: number,
    public maxTokens: number,
  ) {
    super(
      `File content (${tokenCount} tokens) exceeds maximum allowed tokens (${maxTokens}). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`,
    );
    this.name = "MaxFileReadTokenExceededError";
  }
}

/**
 * Validate that read content is within the max-token cap.
 *
 * Port of `tools/FileReadTool/FileReadTool.ts:validateContentTokens`, using
 * only the rough estimate (no API call).
 */
export async function validateContentTokens(
  content: string,
  ext: string,
  maxTokens?: number,
): Promise<void> {
  const effectiveMaxTokens = maxTokens ?? getEffectiveMaxTokens();
  const tokenEstimate = roughTokenCountEstimationForFileType(content, ext);
  if (!tokenEstimate || tokenEstimate <= effectiveMaxTokens / 4) return;
  if (tokenEstimate > effectiveMaxTokens) {
    throw new MaxFileReadTokenExceededError(
      tokenEstimate,
      effectiveMaxTokens,
    );
  }
}
