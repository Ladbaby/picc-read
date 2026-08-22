// =============================================================================
// picc-read — src/windowsPaths.ts
//
// Faithful port of the claude-code replication's `utils/windowsPaths.ts`
// `posixPathToWindowsPath` (the pure-JS variant, memoization dropped).
//
// On Windows, Git Bash (MSYS2) passes POSIX-style paths like `/c/Users/...`.
// This module converts that to a real Windows path so file APIs work.
// =============================================================================

/** Convert a POSIX path to a Windows path using pure JS. */
export function posixPathToWindowsPath(posixPath: string): string {
  // Handle UNC paths: //server/share -> \\server\share
  if (posixPath.startsWith("//")) {
    return posixPath.replace(/\//g, "\\");
  }
  // Handle /cygdrive/c/... format
  const cygdriveMatch = posixPath.match(/^\/cygdrive\/([A-Za-z])(\/|$)/);
  if (cygdriveMatch) {
    const driveLetter = cygdriveMatch[1]!.toUpperCase();
    const rest = posixPath
      .slice(("/cygdrive/" + cygdriveMatch[1]).length);
    return driveLetter + ":" + (rest || "\\").replace(/\//g, "\\");
  }
  // Handle /c/... format (MSYS2/Git Bash)
  const driveMatch = posixPath.match(/^\/([A-Za-z])(\/|$)/);
  if (driveMatch) {
    const driveLetter = driveMatch[1]!.toUpperCase();
    const rest = posixPath.slice(2);
    return driveLetter + ":" + (rest || "\\").replace(/\//g, "\\");
  }
  // Already Windows or relative — just flip slashes
  return posixPath.replace(/\//g, "\\");
}
