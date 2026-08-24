// =============================================================================
// picc-read — src/dedup.ts
//
// Port of claude-code's `readFileState` dedup behaviour.
//
// Adaptor: claude-code stores read state in a shared `ToolUseContext`
// (`readFileState: Map<string, ReadState>`) that Edit/Write also write into.
// pi has no shared context, so this module keeps the cache — but **scoped per
// session** rather than process-global. pi subagents run in the SAME process
// as the parent session and share this module singleton (see
// `picc-subagents/src/agent-runner.ts`), so a flat global map would let a
// subagent's reads make the MAIN agent (or another subagent) return
// "File unchanged since last read" for files it never actually read. Keying by
// session id keeps each session's dedup isolated.
//
// Entries store `offset` + `limit` + floored-mtime so a re-read of the identical,
// unchanged range can return the `FILE_UNCHANGED_STUB` instead of re-sending the
// full content (the earlier Read result is still in that session's context — a
// second full copy wastes tokens on every subsequent turn).
//
// Matches claude-code's guards: dedup only applies when a prior Read in the SAME
// session recorded the same (offset, limit) and the file mtime is unchanged.
// =============================================================================

export type ReadCacheEntry = {
  offset: number;
  limit: number | undefined;
  /** floored mtime in ms, from `getFileModificationTimeAsync` */
  timestamp: number;
};

/**
 * Fallback cache key when no session id is available (e.g. some embedded or test
 * contexts where `ctx.sessionManager.getSessionId()` is not set). All such
 * callers collapse into one shared namespace, which is acceptable since they
 * cannot be distinguished anyway.
 */
export const DEFAULT_SESSION_KEY = "__default__";

/**
 * Per-session cache: outer key is the session id, inner key is the file path.
 * Each session only sees dedup entries it recorded itself.
 */
const cache = new Map<string, Map<string, ReadCacheEntry>>();

function mapFor(session: string): Map<string, ReadCacheEntry> {
  let inner = cache.get(session);
  if (!inner) {
    inner = new Map<string, ReadCacheEntry>();
    cache.set(session, inner);
  }
  return inner;
}

export function cacheGet(
  session: string,
  path: string,
): ReadCacheEntry | undefined {
  return cache.get(session)?.get(path);
}

export function cacheSet(
  session: string,
  path: string,
  entry: ReadCacheEntry,
): void {
  mapFor(session).set(path, entry);
}

export function cacheHas(session: string, path: string): boolean {
  return cache.get(session)?.has(path) ?? false;
}

/** Remove only the given session's entries (used on `session_shutdown`). */
export function cacheClearForSession(session: string): void {
  cache.delete(session);
}

/** Wipe every session's entries (used by tests). */
export function cacheClear(): void {
  cache.clear();
}
