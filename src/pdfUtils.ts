// =============================================================================
// picc-read — src/pdfUtils.ts
//
// Adaptors:
//   - `isPDFSupported()` is hardcoded `true` (claude-code checks the active
//     model; pi's Read tool should offer PDF everywhere and fall back to
//     page-extraction when poppler is missing).
// =============================================================================

// Document extensions that are handled specially.
export const DOCUMENT_EXTENSIONS = new Set(["pdf"]);

/**
 * Parse a page range string into firstPage/lastPage numbers (1-indexed).
 *
 * Supported formats:
 *   - "5"    → { firstPage: 5, lastPage: 5 }
 *   - "1-10" → { firstPage: 1, lastPage: 10 }
 *   - "3-"   → { firstPage: 3, lastPage: Infinity }
 *
 * Returns null on invalid input (non-numeric, zero, inverted range).
 */
export function parsePDFPageRange(
  pages: string,
): { firstPage: number; lastPage: number } | null {
  const trimmed = pages.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.endsWith("-")) {
    const first = parseInt(trimmed.slice(0, -1), 10);
    if (Number.isNaN(first) || first < 1) {
      return null;
    }
    return { firstPage: first, lastPage: Infinity };
  }

  const dashIndex = trimmed.indexOf("-");
  if (dashIndex === -1) {
    const page = parseInt(trimmed, 10);
    if (Number.isNaN(page) || page < 1) {
      return null;
    }
    return { firstPage: page, lastPage: page };
  }

  const first = parseInt(trimmed.slice(0, dashIndex), 10);
  const last = parseInt(trimmed.slice(dashIndex + 1), 10);
  if (
    Number.isNaN(first) ||
    Number.isNaN(last) ||
    first < 1 ||
    last < 1 ||
    last < first
  ) {
    return null;
  }
  return { firstPage: first, lastPage: last };
}

/** Full PDF reading is supported. */
export function isPDFSupported(): boolean {
  return true;
}

/** Check if a file extension is a PDF (with or without leading dot). */
export function isPDFExtension(ext: string): boolean {
  const normalized = ext.startsWith(".") ? ext.slice(1) : ext;
  return DOCUMENT_EXTENSIONS.has(normalized.toLowerCase());
}
