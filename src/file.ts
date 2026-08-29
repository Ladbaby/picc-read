// =============================================================================
// picc-read — src/file.ts
//
// Adaptors vs upstream:
//   - fs access uses plain `node:fs` / `node:fs/promises` directly (in place
//     of claude-code's `getFsImplementation()`).
//   - `isCompactLinePrefixEnabled()` is hardcoded `true` (claude-code gates it
//     behind a GrowthBook killswitch; pi has no GrowthBook, compact is the
//     default).
//   - `expandPath` keeps claude-code's `posixPathToWindowsPath` behaviour.
// =============================================================================

import { createReadStream, fstat, readdirSync } from "node:fs";
import { stat as fsStat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import { formatFileSize } from "./format.js";

// -----------------------------------------------------------------------------
// readFileInRange (utils/readFileInRange.ts)
// -----------------------------------------------------------------------------

const FAST_PATH_MAX_SIZE = 10 * 1024 * 1024; // 10 MB

export type ReadFileRangeResult = {
  content: string;
  lineCount: number;
  totalLines: number;
  totalBytes: number;
  readBytes: number;
  mtimeMs: number;
  /** true when output was clipped to maxBytes under truncate mode */
  truncatedByBytes?: boolean;
};

export class FileTooLargeError extends Error {
  constructor(
    public sizeInBytes: number,
    public maxSizeBytes: number,
  ) {
    super(
      `File content (${formatFileSize(sizeInBytes)}) exceeds maximum allowed size (${formatFileSize(maxSizeBytes)}). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`,
    );
    this.name = "FileTooLargeError";
  }
}

/**
 * Read a range of lines from a file.
 *
 * Fast path (regular files < 10MB): readFile + in-memory split.
 * Streaming path (large files, pipes, devices): createReadStream + manual
 * newline scanning; only selected-range lines are accumulated.
 */
export async function readFileInRange(
  filePath: string,
  offset = 0,
  maxLines?: number,
  maxBytes?: number,
  signal?: AbortSignal,
  options?: { truncateOnByteLimit?: boolean },
): Promise<ReadFileRangeResult> {
  signal?.throwIfAborted();
  const truncateOnByteLimit = options?.truncateOnByteLimit ?? false;

  const stats = await fsStat(filePath);

  if (stats.isDirectory()) {
    throw new Error(
      `EISDIR: illegal operation on a directory, read '${filePath}'`,
    );
  }

  if (stats.isFile() && stats.size < FAST_PATH_MAX_SIZE) {
    if (!truncateOnByteLimit && maxBytes !== undefined && stats.size > maxBytes) {
      throw new FileTooLargeError(stats.size, maxBytes);
    }
    const text = await readFile(filePath, { encoding: "utf8", signal });
    return readFileInRangeFast(
      text,
      stats.mtimeMs,
      offset,
      maxLines,
      truncateOnByteLimit ? maxBytes : undefined,
    );
  }

  return readFileInRangeStreaming(
    filePath,
    offset,
    maxLines,
    maxBytes,
    truncateOnByteLimit,
    signal,
  );
}

function readFileInRangeFast(
  raw: string,
  mtimeMs: number,
  offset: number,
  maxLines: number | undefined,
  truncateAtBytes: number | undefined,
): ReadFileRangeResult {
  const endLine = maxLines !== undefined ? offset + maxLines : Infinity;

  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;

  const selectedLines: string[] = [];
  let lineIndex = 0;
  let startPos = 0;
  let selectedBytes = 0;
  let truncatedByBytes = false;

  function tryPush(line: string): boolean {
    if (truncateAtBytes !== undefined) {
      const sep = selectedLines.length > 0 ? 1 : 0;
      const nextBytes = selectedBytes + sep + Buffer.byteLength(line);
      if (nextBytes > truncateAtBytes) {
        truncatedByBytes = true;
        return false;
      }
      selectedBytes = nextBytes;
    }
    selectedLines.push(line);
    return true;
  }

  while (text.indexOf("\n", startPos) !== -1) {
    const newlinePos = text.indexOf("\n", startPos);
    if (lineIndex >= offset && lineIndex < endLine && !truncatedByBytes) {
      let line = text.slice(startPos, newlinePos);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      tryPush(line);
    }
    lineIndex++;
    startPos = newlinePos + 1;
  }

  if (lineIndex >= offset && lineIndex < endLine && !truncatedByBytes) {
    let line = text.slice(startPos);
    if (line.endsWith("\r")) {
      line = line.slice(0, -1);
    }
    tryPush(line);
  }
  lineIndex++;

  const content = selectedLines.join("\n");
  return {
    content,
    lineCount: selectedLines.length,
    totalLines: lineIndex,
    totalBytes: Buffer.byteLength(text, "utf8"),
    readBytes: Buffer.byteLength(content, "utf8"),
    mtimeMs,
    ...(truncatedByBytes ? { truncatedByBytes: true } : {}),
  };
}

type StreamState = {
  stream: ReturnType<typeof createReadStream>;
  offset: number;
  endLine: number;
  maxBytes: number | undefined;
  truncateOnByteLimit: boolean;
  resolve: (value: ReadFileRangeResult) => void;
  totalBytesRead: number;
  selectedBytes: number;
  truncatedByBytes: boolean;
  currentLineIndex: number;
  selectedLines: string[];
  partial: string;
  isFirstChunk: boolean;
  resolveMtime: (ms: number) => void;
  mtimeReady: Promise<number>;
};

function streamOnOpen(this: StreamState, fd: number): void {
  fstat(fd, (err, stats) => {
    this.resolveMtime(err ? 0 : stats.mtimeMs);
  });
}

function streamOnData(this: StreamState, rawChunk: string | Buffer): void {
  let chunk = rawChunk;
  if (typeof chunk !== "string") {
    chunk = chunk.toString("utf8");
  }
  if (this.isFirstChunk) {
    this.isFirstChunk = false;
    if (chunk.charCodeAt(0) === 0xfeff) {
      chunk = chunk.slice(1);
    }
  }

  this.totalBytesRead += Buffer.byteLength(chunk);
  if (
    !this.truncateOnByteLimit &&
    this.maxBytes !== undefined &&
    this.totalBytesRead > this.maxBytes
  ) {
    this.stream.destroy(new FileTooLargeError(this.totalBytesRead, this.maxBytes));
    return;
  }

  const data = this.partial.length > 0 ? this.partial + chunk : chunk;
  this.partial = "";

  let startPos = 0;
  while (data.indexOf("\n", startPos) !== -1) {
    const newlinePos = data.indexOf("\n", startPos);
    if (this.currentLineIndex >= this.offset && this.currentLineIndex < this.endLine) {
      let line = data.slice(startPos, newlinePos);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      if (this.truncateOnByteLimit && this.maxBytes !== undefined) {
        const sep = this.selectedLines.length > 0 ? 1 : 0;
        const nextBytes = this.selectedBytes + sep + Buffer.byteLength(line);
        if (nextBytes > this.maxBytes) {
          this.truncatedByBytes = true;
          this.endLine = this.currentLineIndex;
        } else {
          this.selectedBytes = nextBytes;
          this.selectedLines.push(line);
        }
      } else {
        this.selectedLines.push(line);
      }
    }
    this.currentLineIndex++;
    startPos = newlinePos + 1;
  }

  if (startPos < data.length) {
    if (this.currentLineIndex >= this.offset && this.currentLineIndex < this.endLine) {
      const fragment = data.slice(startPos);
      if (this.truncateOnByteLimit && this.maxBytes !== undefined) {
        const sep = this.selectedLines.length > 0 ? 1 : 0;
        const fragBytes = this.selectedBytes + sep + Buffer.byteLength(fragment);
        if (fragBytes > this.maxBytes) {
          this.truncatedByBytes = true;
          this.endLine = this.currentLineIndex;
          return;
        }
      }
      this.partial = fragment;
    }
  }
}

function streamOnEnd(this: StreamState): void {
  let line = this.partial;
  if (line.endsWith("\r")) {
    line = line.slice(0, -1);
  }
  if (this.currentLineIndex >= this.offset && this.currentLineIndex < this.endLine) {
    if (this.truncateOnByteLimit && this.maxBytes !== undefined) {
      const sep = this.selectedLines.length > 0 ? 1 : 0;
      const nextBytes = this.selectedBytes + sep + Buffer.byteLength(line);
      if (nextBytes > this.maxBytes) {
        this.truncatedByBytes = true;
      } else {
        this.selectedLines.push(line);
      }
    } else {
      this.selectedLines.push(line);
    }
  }
  this.currentLineIndex++;

  const content = this.selectedLines.join("\n");
  const truncated = this.truncatedByBytes;
  this.mtimeReady.then((mtimeMs) => {
    this.resolve({
      content,
      lineCount: this.selectedLines.length,
      totalLines: this.currentLineIndex,
      totalBytes: this.totalBytesRead,
      readBytes: Buffer.byteLength(content, "utf8"),
      mtimeMs,
      ...(truncated ? { truncatedByBytes: true } : {}),
    });
  });
}

function readFileInRangeStreaming(
  filePath: string,
  offset: number,
  maxLines: number | undefined,
  maxBytes: number | undefined,
  truncateOnByteLimit: boolean,
  signal?: AbortSignal,
): Promise<ReadFileRangeResult> {
  return new Promise((resolve, reject) => {
    const state: StreamState = {
      stream: createReadStream(filePath, {
        encoding: "utf8",
        highWaterMark: 512 * 1024,
        ...(signal ? { signal } : undefined),
      }),
      offset,
      endLine: maxLines !== undefined ? offset + maxLines : Infinity,
      maxBytes,
      truncateOnByteLimit,
      resolve,
      totalBytesRead: 0,
      selectedBytes: 0,
      truncatedByBytes: false,
      currentLineIndex: 0,
      selectedLines: [],
      partial: "",
      isFirstChunk: true,
      resolveMtime: () => {},
      mtimeReady: null as unknown as Promise<number>,
    };
    state.mtimeReady = new Promise<number>((r) => {
      state.resolveMtime = r;
    });

    state.stream.once("open", streamOnOpen.bind(state));
    state.stream.on("data", streamOnData.bind(state));
    state.stream.once("end", streamOnEnd.bind(state));
    state.stream.once("error", reject);
  });
}

// -----------------------------------------------------------------------------
// addLineNumbers + related (utils/file.ts)
// -----------------------------------------------------------------------------

export const FILE_NOT_FOUND_CWD_NOTE = "Note: your current working directory is";

/** Whether to use the compact `N\t` line-number prefix. Always on in picc-read. */
export function isCompactLinePrefixEnabled(): boolean {
  return true;
}

/**
 * Adds `cat -n` style line numbers to the content.
 *
 * Ported from `utils/file.ts:addLineNumbers`.
 */
export function addLineNumbers({
  content,
  // 1-indexed
  startLine,
}: {
  content: string;
  startLine: number;
}): string {
  if (!content) {
    return "";
  }

  const lines = content.split(/\r?\n/);

  if (isCompactLinePrefixEnabled()) {
    return lines
      .map((line, index) => `${index + startLine}\t${line}`)
      .join("\n");
  }

  return lines
    .map((line, index) => {
      const numStr = String(index + startLine);
      if (numStr.length >= 6) {
        return `${numStr}→${line}`;
      }
      return `${numStr.padStart(6, " ")}→${line}`;
    })
    .join("\n");
}

/** Async mtime in floored ms — used for read-dedup. */
export async function getFileModificationTimeAsync(
  filePath: string,
): Promise<number> {
  const s = await fsStat(filePath);
  return Math.floor(s.mtimeMs);
}

/**
 * Find a file with the same base name but a different extension in the same
 * directory (for "Did you mean …?" hints).
 */
export function findSimilarFile(filePath: string): string | undefined {
  try {
    const dir = dirname(filePath);
    const fileBaseName = basename(filePath, extname(filePath));
    const files = readdirSync(dir, { withFileTypes: true });
    const similar = files.filter(
      (f) =>
        basename(f.name, extname(f.name)) === fileBaseName &&
        join(dir, f.name) !== filePath,
    );
    return similar[0]?.name;
  } catch {
    return undefined;
  }
}

/**
 * Suggest a corrected path under cwd when a file is not found ("dropped repo
 * folder" pattern).
 */
export async function suggestPathUnderCwd(
  requestedPath: string,
  cwd: string,
): Promise<string | undefined> {
  const cwdParent = dirname(cwd);

  let resolvedPath = requestedPath;
  try {
    const resolvedDir = await realpath(dirname(requestedPath));
    resolvedPath = join(resolvedDir, basename(requestedPath));
  } catch {
    // Parent directory doesn't exist; use the original path
  }

  const cwdParentPrefix = cwdParent === "/" ? "/" : cwdParent + "/";
  if (
    !resolvedPath.startsWith(cwdParentPrefix) ||
    resolvedPath.startsWith(cwd + "/") ||
    resolvedPath === cwd
  ) {
    return undefined;
  }

  const relFromParent = relative(cwdParent, resolvedPath);
  const correctedPath = join(cwd, relFromParent);
  try {
    await fsStat(correctedPath);
    return correctedPath;
  } catch {
    return undefined;
  }
}
