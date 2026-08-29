// =============================================================================
// picc-read — src/limits.ts
//
// The env-var override uses `PICC_READ_MAX_OUTPUT_TOKENS` (in place of
// claude-code's `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS`) and a simplified
// context-window check (in place of GrowthBook feature flags).
// =============================================================================

import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  MINIMUM_READ_TOKENS,
} from "./constants.js";

/**
 * Resolve the effective max-output-token cap for a single read.
 *
 * - `PICC_READ_MAX_OUTPUT_TOKENS` overrides the default (floored at
 *   MINIMUM_READ_TOKENS).
 * - If the value is a plain integer, it is used as-is.
 * - (claude-code additionally raises the cap to 30k for 1M-context models via
 *   GrowthBook; pi has no GrowthBook, so that branch is omitted.)
 */
export function getEffectiveMaxTokens(): number {
  const envValue = process.env.PICC_READ_MAX_OUTPUT_TOKENS;
  if (envValue !== undefined) {
    const n = parseInt(envValue, 10);
    if (!Number.isNaN(n)) return Math.max(MINIMUM_READ_TOKENS, n);
  }
  return DEFAULT_MAX_OUTPUT_TOKENS;
}
