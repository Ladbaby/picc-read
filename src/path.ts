// =============================================================================
// picc-read — src/path.ts
//
// Adaptors vs upstream:
//   - `getCwd()` / `getFsImplementation().cwd()` → `process.cwd()`
//   - `getPlatform()` → `process.platform`
// =============================================================================

import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";
import { posixPathToWindowsPath } from "./windowsPaths.js";

/**
 * Expand `~` to the home directory, convert Windows POSIX-style paths, and
 * resolve relative paths against `baseDir`.
 *
 * Ported from `utils/path.ts:expandPath`.
 */
export function expandPath(path: string, baseDir?: string): string {
  const actualBaseDir = baseDir ?? process.cwd();

  if (typeof path !== "string") {
    throw new TypeError(`Path must be a string, received ${typeof path}`);
  }
  if (typeof actualBaseDir !== "string") {
    throw new TypeError(
      `Base directory must be a string, received ${typeof actualBaseDir}`,
    );
  }

  if (path.includes("\0") || actualBaseDir.includes("\0")) {
    throw new Error("Path contains null bytes");
  }

  const trimmedPath = path.trim();
  if (!trimmedPath) {
    return normalize(actualBaseDir).normalize("NFC");
  }

  if (trimmedPath === "~") {
    return homedir().normalize("NFC");
  }

  if (trimmedPath.startsWith("~/")) {
    return join(homedir(), trimmedPath.slice(2)).normalize("NFC");
  }

  let processedPath = trimmedPath;
  if (process.platform === "win32" && trimmedPath.match(/^\/[a-z]\//i)) {
    try {
      processedPath = posixPathToWindowsPath(trimmedPath);
    } catch {
      processedPath = trimmedPath;
    }
  }

  if (isAbsolute(processedPath)) {
    return normalize(processedPath).normalize("NFC");
  }

  return resolve(actualBaseDir, processedPath).normalize("NFC");
}
