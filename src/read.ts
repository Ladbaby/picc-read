// =============================================================================
// picc-read — src/read.ts
//
// The core orchestrator: a faithful port of claude-code's
// `tools/FileReadTool/FileReadTool.ts` (`call` + `callInner` + `readImageWithTokenBudget`),
// adapted so results are returned as pi `AgentToolResult`-friendly discriminated
// unions instead of Anthropic `tool_result` blocks.
//
// Adaptors vs upstream:
//   - `context.readFileState` dedup → module-level `src/dedup.ts` cache.
//   - `getDefaultFileReadingLimits()` → `MAX_OUTPUT_SIZE` / `getEffectiveMaxTokens()`.
//   - `countTokensWithAPI` second stage dropped (rough estimate only — no token
//     counting endpoint in pi).
//   - GrowthBook killswitches / analytics / skill discovery / file-read
//     listeners are no-ops (no GrowthBook, analytics, or skills in pi).
//   - PDF `document` supplemental blocks and image `metadata` supplemental user
//     messages are inlined directly into the returned `content` array so results
//     are self-contained for pi (no side-channel `newMessages`).
//   - `offset` defaults to 1 (1-based), matching claude-code.
// =============================================================================

import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import {
  IMAGE_EXTENSIONS,
  MAX_OUTPUT_SIZE,
  PDF_AT_MENTION_INLINE_THRESHOLD,
  PDF_EXTRACT_SIZE_THRESHOLD,
  PDF_MAX_PAGES_PER_READ,
} from "./constants.js";
import { cacheGet, cacheSet } from "./dedup.js";
import {
  addLineNumbers,
  FILE_NOT_FOUND_CWD_NOTE,
  FileTooLargeError,
  findSimilarFile,
  getFileModificationTimeAsync,
  readFileInRange,
  suggestPathUnderCwd,
} from "./file.js";
import { formatFileSize } from "./format.js";
import {
  compressImageBufferWithTokenLimit,
  createImageMetadataText,
  detectImageFormatFromBuffer,
  type ImageDimensions,
  ImageResizeError,
  maybeResizeAndDownsampleImageBuffer,
} from "./imageResizer.js";
import { getEffectiveMaxTokens } from "./limits.js";
import { readNotebook } from "./notebook.js";
import { expandPath } from "./path.js";
import {
  extractPDFPages,
  getPDFPageCount,
  readPDF,
} from "./pdf.js";
import {
  isPDFExtension,
  isPDFSupported,
  parsePDFPageRange,
} from "./pdfUtils.js";
import { validateContentTokens } from "./tokenEstimation.js";

// -----------------------------------------------------------------------------
// Device / binary guards (ported from FileReadTool.ts + constants/files.ts)
// -----------------------------------------------------------------------------

// Device files that would hang the process: infinite output or blocking input.
// Checked by path only (no I/O). Safe devices like /dev/null are intentionally
// omitted.
const BLOCKED_DEVICE_PATHS = new Set([
  // Infinite output — never reach EOF
  "/dev/zero",
  "/dev/random",
  "/dev/urandom",
  "/dev/full",
  // Blocks waiting for input
  "/dev/stdin",
  "/dev/tty",
  "/dev/console",
  // Nonsensical to read
  "/dev/stdout",
  "/dev/stderr",
  // fd aliases for stdin/stdout/stderr
  "/dev/fd/0",
  "/dev/fd/1",
  "/dev/fd/2",
]);

function isBlockedDevicePath(filePath: string): boolean {
  if (BLOCKED_DEVICE_PATHS.has(filePath)) return true;
  // /proc/self/fd/0-2 and /proc/<pid>/fd/0-2 are Linux aliases for stdio
  if (
    filePath.startsWith("/proc/") &&
    (filePath.endsWith("/fd/0") ||
      filePath.endsWith("/fd/1") ||
      filePath.endsWith("/fd/2"))
  )
    return true;
  return false;
}

// Binary extensions that are neither rendered natively (image/pdf) nor text —
// reading them is rejected up front. Port of claude-code constants/files.ts.
// (Image and PDF extensions are excluded at the call site below.)
const BINARY_EXTENSIONS = new Set([
  ".bmp",
  ".ico",
  ".tiff",
  ".tif",
  ".mp4",
  ".mov",
  ".avi",
  ".mkv",
  ".webm",
  ".wmv",
  ".flv",
  ".m4v",
  ".mpeg",
  ".mpg",
  ".mp3",
  ".wav",
  ".ogg",
  ".flac",
  ".aac",
  ".m4a",
  ".wma",
  ".aiff",
  ".opus",
  ".zip",
  ".tar",
  ".gz",
  ".bz2",
  ".7z",
  ".rar",
  ".xz",
  ".z",
  ".tgz",
  ".iso",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".o",
  ".a",
  ".obj",
  ".lib",
  ".app",
  ".msi",
  ".deb",
  ".rpm",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".odt",
  ".ods",
  ".odp",
  ".ttf",
  ".otf",
  ".woff",
  ".woff2",
  ".eot",
  ".pyc",
  ".pyo",
  ".class",
  ".jar",
  ".war",
  ".ear",
  ".node",
  ".wasm",
  ".rlib",
  ".sqlite",
  ".sqlite3",
  ".db",
  ".mdb",
  ".idx",
  ".psd",
  ".ai",
  ".eps",
  ".sketch",
  ".fig",
  ".xd",
  ".blend",
  ".3ds",
  ".max",
  ".swf",
  ".fla",
  ".lockb",
  ".dat",
  ".data",
]);

function hasBinaryExtension(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

// -----------------------------------------------------------------------------
// macOS screenshot alternate-space helper (ported)
// -----------------------------------------------------------------------------

// Narrow no-break space (U+202F) used by some macOS versions in screenshot filenames
const THIN_SPACE = String.fromCharCode(8239);

function getAlternateScreenshotPath(filePath: string): string | undefined {
  const filename = filePath.split(/[\\/]/).pop() ?? "";
  const amPmPattern = /^(.+)([ \u202f])(AM|PM)(\.png)$/;
  const match = filename.match(amPmPattern);
  if (!match) return undefined;

  const currentSpace = match[2];
  const alternateSpace = currentSpace === " " ? THIN_SPACE : " ";
  return filePath.replace(
    `${currentSpace}${match[3]}${match[4]}`,
    `${alternateSpace}${match[3]}${match[4]}`,
  );
}

// -----------------------------------------------------------------------------
// Read results (pi-friendly discriminated union)
// -----------------------------------------------------------------------------

export type TextFileRead = {
  type: "text";
  filePath: string;
  content: string;
  numLines: number;
  startLine: number;
  totalLines: number;
};

export type ImageFileRead = {
  type: "image";
  filePath: string;
  base64: string;
  mimeType: string;
  originalSize: number;
  dimensions?: ImageDimensions;
  /** Optional `[Image: ...]` metadata line (dimensions + source). */
  metadataText?: string;
};

export type NotebookFileRead = {
  type: "notebook";
  filePath: string;
  cellCount: number;
};

export type PDFFileRead = {
  type: "pdf";
  filePath: string;
  originalSize: number;
};

export type PDFPartsRead = {
  type: "parts";
  filePath: string;
  originalSize: number;
  count: number;
  outputDir: string;
  /** Rendered page images (inlined for pi self-contained results). */
  pages?: (ImageFileRead & { metadataText?: string })[];
};

export type FileUnchangedRead = {
  type: "file_unchanged";
  filePath: string;
};

export type ReadOutcome =
  | TextFileRead
  | ImageFileRead
  | NotebookFileRead
  | PDFFileRead
  | PDFPartsRead
  | FileUnchangedRead;

// -----------------------------------------------------------------------------
// Validation (port of FileReadTool.validateInput, minus permission checks)
// -----------------------------------------------------------------------------

export type ReadInput = {
  file_path: string;
  offset?: number;
  limit?: number;
  pages?: string;
};

export function validateReadInput(
  input: ReadInput,
  cwd: string,
): { ok: true } | { ok: false; message: string } {
  const { file_path, pages } = input;

  if (pages !== undefined) {
    const parsed = parsePDFPageRange(pages);
    if (!parsed) {
      return {
        ok: false,
        message: `Invalid pages parameter: "${pages}". Use formats like "1-5", "3", or "10-20". Pages are 1-indexed.`,
      };
    }
    const rangeSize =
      parsed.lastPage === Infinity
        ? PDF_MAX_PAGES_PER_READ + 1
        : parsed.lastPage - parsed.firstPage + 1;
    if (rangeSize > PDF_MAX_PAGES_PER_READ) {
      return {
        ok: false,
        message: `Page range "${pages}" exceeds maximum of ${PDF_MAX_PAGES_PER_READ} pages per request. Please use a smaller range.`,
      };
    }
  }

  const fullFilePath = expandPath(file_path, cwd);
  const ext = extname(fullFilePath).toLowerCase();

  // Binary extension check (string check only, no I/O). PDF, images, and SVG
  // are excluded — this tool renders them natively.
  if (
    hasBinaryExtension(fullFilePath) &&
    !isPDFExtension(ext) &&
    !IMAGE_EXTENSIONS.has(ext.slice(1))
  ) {
    return {
      ok: false,
      message: `This tool cannot read binary files. The file appears to be a binary ${ext} file. Please use appropriate tools for binary file analysis.`,
    };
  }

  // Block device files that would hang.
  if (isBlockedDevicePath(fullFilePath)) {
    return {
      ok: false,
      message: `Cannot read '${file_path}': this device file would block or produce infinite output.`,
    };
  }

  return { ok: true };
}

// -----------------------------------------------------------------------------
// Image reading (port of readImageWithTokenBudget)
// -----------------------------------------------------------------------------

type ImageResult = {
  base64: string;
  mediaType: string;
  originalSize: number;
  dimensions?: ImageDimensions;
};

async function readImageWithTokenBudget(
  filePath: string,
  maxTokens: number,
): Promise<ImageResult> {
  const imageBuffer = await readFile(filePath);
  const originalSize = imageBuffer.length;

  if (originalSize === 0) {
    throw new Error(`Image file is empty: ${filePath}`);
  }

  const detectedMediaType = detectImageFormatFromBuffer(imageBuffer);
  const detectedFormat = detectedMediaType.split("/")[1] || "png";

  let result: ImageResult;
  try {
    const resized = await maybeResizeAndDownsampleImageBuffer(
      imageBuffer,
      originalSize,
      detectedFormat,
    );
    result = {
      base64: resized.buffer.toString("base64"),
      mediaType: `image/${resized.mediaType}`,
      originalSize,
      dimensions: resized.dimensions,
    };
  } catch (e) {
    if (e instanceof ImageResizeError) throw e;
    result = {
      base64: imageBuffer.toString("base64"),
      mediaType: `image/${detectedFormat}`,
      originalSize,
    };
  }

  // Check if it fits in the token budget.
  const estimatedTokens = Math.ceil(result.base64.length * 0.125);
  if (estimatedTokens > maxTokens) {
    try {
      const compressed = await compressImageBufferWithTokenLimit(
        imageBuffer,
        maxTokens,
        detectedMediaType,
      );
      return {
        base64: compressed.base64,
        mediaType: compressed.mediaType,
        originalSize,
      };
    } catch {
      return {
        base64: imageBuffer.toString("base64"),
        mediaType: detectedMediaType,
        originalSize,
      };
    }
  }

  return result;
}

// -----------------------------------------------------------------------------
// Per-type readers (port of callInner branches)
// -----------------------------------------------------------------------------

async function readNotebookFile(
  file_path: string,
  fullFilePath: string,
  resolvedFilePath: string,
  offset: number,
  limit: number | undefined,
  maxSizeBytes: number,
  maxTokens: number,
): Promise<ReadOutcome> {
  const cells = await readNotebook(resolvedFilePath);
  const cellsJson = JSON.stringify(cells);

  const cellsJsonBytes = Buffer.byteLength(cellsJson);
  if (cellsJsonBytes > maxSizeBytes) {
    throw new Error(
      `Notebook content (${formatFileSize(cellsJsonBytes)}) exceeds maximum allowed size (${formatFileSize(maxSizeBytes)}). ` +
        `Use bash with jq to read specific portions:\n` +
        `  cat "${file_path}" | jq '.cells[:20]' # First 20 cells\n` +
        `  cat "${file_path}" | jq '.cells[100:120]' # Cells 100-120\n` +
        `  cat "${file_path}" | jq '.cells | length' # Count total cells\n` +
        `  cat "${file_path}" | jq '.cells[] | select(.cell_type=="code") | .source' # All code sources`,
    );
  }

  await validateContentTokens(cellsJson, "ipynb", maxTokens);

  const mtimeMs = await getFileModificationTimeAsync(resolvedFilePath);
  cacheSet(fullFilePath, {
    offset,
    limit,
    timestamp: mtimeMs,
  });

  return {
    type: "notebook",
    filePath: file_path,
    cellCount: cells.length,
  };
}

async function readImageFile(
  file_path: string,
  resolvedFilePath: string,
  maxTokens: number,
): Promise<ImageFileRead> {
  const img = await readImageWithTokenBudget(resolvedFilePath, maxTokens);
  const metadataText = img.dimensions
    ? createImageMetadataText(img.dimensions)
    : null;
  return {
    type: "image",
    filePath: file_path,
    base64: img.base64,
    mimeType: img.mediaType,
    originalSize: img.originalSize,
    dimensions: img.dimensions,
    ...(metadataText ? { metadataText } : {}),
  };
}

async function readPdfFile(
  file_path: string,
  _fullFilePath: string,
  resolvedFilePath: string,
  pages: string | undefined,
  _maxSizeBytes: number,
): Promise<
  | (PDFPartsRead & { pages: (ImageFileRead & { metadataText?: string })[] })
  | PDFFileRead
> {
  if (pages) {
    const parsedRange = parsePDFPageRange(pages);
    const extractResult = await extractPDFPages(
      resolvedFilePath,
      parsedRange ?? undefined,
    );
    if (!extractResult.success) {
      throw new Error(extractResult.error.message);
    }

    const entries = await readdir(extractResult.data.file.outputDir);
    const imageFiles = entries.filter((f) => f.endsWith(".jpg")).sort();
    const pagesResult: (ImageFileRead & { metadataText?: string })[] = [];
    for (const f of imageFiles) {
      const imgPath = join(extractResult.data.file.outputDir, f);
      const imgBuffer = await readFile(imgPath);
      const resized = await maybeResizeAndDownsampleImageBuffer(
        imgBuffer,
        imgBuffer.length,
        "jpeg",
      );
      const meta = createImageMetadataText(resized.dimensions);
      pagesResult.push({
        type: "image",
        filePath: imgPath,
        base64: resized.buffer.toString("base64"),
        mimeType: `image/${resized.mediaType}`,
        originalSize: imgBuffer.length,
        dimensions: resized.dimensions,
        ...(meta ? { metadataText: meta } : {}),
      });
    }

    return {
      type: "parts",
      filePath: file_path,
      originalSize: extractResult.data.file.originalSize,
      count: extractResult.data.file.count,
      outputDir: extractResult.data.file.outputDir,
      pages: pagesResult,
    };
  }

  const pageCount = await getPDFPageCount(resolvedFilePath);
  if (pageCount !== null && pageCount > PDF_AT_MENTION_INLINE_THRESHOLD) {
    throw new Error(
      `This PDF has ${pageCount} pages, which is too many to read at once. ` +
        `Use the pages parameter to read specific page ranges (e.g., pages: "1-5"). ` +
        `Maximum ${PDF_MAX_PAGES_PER_READ} pages per request.`,
    );
  }

  const s = await stat(resolvedFilePath);
  const shouldExtractPages =
    !isPDFSupported() || s.size > PDF_EXTRACT_SIZE_THRESHOLD;

  if (shouldExtractPages) {
    // Best effort: if poppler is missing we surface the error from readPDF's
    // downstream handling rather than failing hard here (claude-code logs and
    // continues, but with isPDFSupported() === true extraction is only an
    // optimization for large files — full read still works).
    const extractResult = await extractPDFPages(resolvedFilePath);
    if (extractResult.success) {
      const entries = await readdir(extractResult.data.file.outputDir);
      const imageFiles = entries.filter((f) => f.endsWith(".jpg")).sort();
      const pagesResult: (ImageFileRead & { metadataText?: string })[] = [];
      for (const f of imageFiles) {
        const imgPath = join(extractResult.data.file.outputDir, f);
        const imgBuffer = await readFile(imgPath);
        const resized = await maybeResizeAndDownsampleImageBuffer(
          imgBuffer,
          imgBuffer.length,
          "jpeg",
        );
        const meta = createImageMetadataText(resized.dimensions);
        pagesResult.push({
          type: "image",
          filePath: imgPath,
          base64: resized.buffer.toString("base64"),
          mimeType: `image/${resized.mediaType}`,
          originalSize: imgBuffer.length,
          dimensions: resized.dimensions,
          ...(meta ? { metadataText: meta } : {}),
        });
      }
      if (pagesResult.length > 0) {
        return {
          type: "parts",
          filePath: file_path,
          originalSize: s.size,
          count: pagesResult.length,
          outputDir: extractResult.data.file.outputDir,
          pages: pagesResult,
        };
      }
    }
  }

  if (!isPDFSupported()) {
    throw new Error(
      "Reading full PDFs is not supported with this model. Use a newer model, " +
        `or use the pages parameter to read specific page ranges (maximum ${PDF_MAX_PAGES_PER_READ} pages per request). ` +
        "Page extraction requires poppler-utils: install with `brew install poppler` on macOS or `apt-get install poppler-utils` on Debian/Ubuntu.",
    );
  }

  const readResult = await readPDF(resolvedFilePath);
  if (!readResult.success) {
    throw new Error(readResult.error.message);
  }
  return {
    type: "pdf",
    filePath: file_path,
    originalSize: readResult.data.file.originalSize,
  };
}

async function readTextFile(
  file_path: string,
  fullFilePath: string,
  resolvedFilePath: string,
  ext: string,
  offset: number,
  limit: number | undefined,
  maxSizeBytes: number,
  maxTokens: number,
  signal?: AbortSignal,
): Promise<TextFileRead> {
  const lineOffset = offset === 0 ? 0 : offset - 1;
  const { content, lineCount, totalLines, mtimeMs } = await readFileInRange(
    resolvedFilePath,
    lineOffset,
    limit,
    limit === undefined ? maxSizeBytes : undefined,
    signal,
  );

  await validateContentTokens(content, ext, maxTokens);

  cacheSet(fullFilePath, {
    offset,
    limit,
    timestamp: Math.floor(mtimeMs),
  });

  return {
    type: "text",
    filePath: file_path,
    content: addLineNumbers({ content, startLine: offset }),
    numLines: lineCount,
    startLine: offset,
    totalLines,
  };
}

// -----------------------------------------------------------------------------
// Orchestrator (port of call + callInner dispatch)
// -----------------------------------------------------------------------------

export async function executeRead(
  input: ReadInput,
  cwd: string,
  signal?: AbortSignal,
): Promise<ReadOutcome> {
  const maxSizeBytes = MAX_OUTPUT_SIZE;
  const maxTokens = getEffectiveMaxTokens();

  const file_path = input.file_path;
  const offset = input.offset ?? 1;
  const limit = input.limit;
  const pages = input.pages;

  const ext = extname(file_path).toLowerCase().slice(1);
  const fullFilePath = expandPath(file_path, cwd);

  // Dedup: identical range, unchanged mtime → stub (text + notebook only).
  const existingState = cacheGet(fullFilePath);
  if (existingState && existingState.offset === offset) {
    const rangeMatch = existingState.limit === limit;
    if (rangeMatch) {
      try {
        const mtimeMs = await getFileModificationTimeAsync(fullFilePath);
        if (mtimeMs === existingState.timestamp) {
          return { type: "file_unchanged", filePath: file_path };
        }
      } catch {
        // stat failed — fall through to full read
      }
    }
  }

  const callInner = (resolvedFilePath: string): Promise<ReadOutcome> => {
    if (ext === "ipynb") {
      return readNotebookFile(
        file_path,
        fullFilePath,
        resolvedFilePath,
        offset,
        limit,
        maxSizeBytes,
        maxTokens,
      );
    }
    if (IMAGE_EXTENSIONS.has(ext)) {
      return readImageFile(file_path, resolvedFilePath, maxTokens);
    }
    if (isPDFExtension(ext)) {
      return readPdfFile(
        file_path,
        fullFilePath,
        resolvedFilePath,
        pages,
        maxSizeBytes,
      );
    }
    return readTextFile(
      file_path,
      fullFilePath,
      resolvedFilePath,
      ext,
      offset,
      limit,
      maxSizeBytes,
      maxTokens,
      signal,
    );
  };

  try {
    return await callInner(fullFilePath);
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (code === "ENOENT") {
      // macOS screenshots may use a thin space before AM/PM — try the
      // alternate before giving up.
      const altPath = getAlternateScreenshotPath(fullFilePath);
      if (altPath) {
        try {
          return await callInner(altPath);
        } catch (altError) {
          if ((altError as { code?: string })?.code !== "ENOENT") {
            throw altError;
          }
        }
      }

      const similarFilename = findSimilarFile(fullFilePath);
      const cwdSuggestion = await suggestPathUnderCwd(fullFilePath, cwd);
      let message = `File does not exist. ${FILE_NOT_FOUND_CWD_NOTE} ${cwd}.`;
      if (cwdSuggestion) {
        message += ` Did you mean ${cwdSuggestion}?`;
      } else if (similarFilename) {
        message += ` Did you mean ${similarFilename}?`;
      }
      throw new Error(message);
    }
    throw error;
  }
}

// Re-export for the entry point's error rendering.
export { FileTooLargeError };
