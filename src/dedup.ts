// =============================================================================
// picc-read — src/dedup.ts
//
// Port of claude-code's `readFileState` dedup behaviour.
//
// Adaptor: claude-code stores read state in a shared `ToolUseContext`
// (`readFileState: Map<string, ReadState>`) that Edit/Write also write into.
// picc-read has no shared context, so it keeps a module-level `Map` scoped to
// text/notebook reads. Entries store `offset` + `limit` + floored-mtime so a
// re-read of the identical, unchanged range can return the
// `FILE_UNCHANGED_STUB` instead of re-sending the full content (the earlier
// Read result is still in context — a second full copy wastes tokens on every
// subsequent turn).
//
// Matches claude-code's guards: dedup only applies when a prior Read recorded
// the same (offset, limit) and the file mtime is unchanged.
// =============================================================================

export type ReadCacheEntry = {
  offset: number;
  limit: number | undefined;
  /** floored mtime in ms, from `getFileModificationTimeAsync` */
  timestamp: number;
};

const cache = new Map<string, ReadCacheEntry>();

export function cacheGet(path: string): ReadCacheEntry | undefined {
  return cache.get(path);
}

export function cacheSet(
  path: string,
  entry: ReadCacheEntry,
): void {
  cache.set(path, entry);
}

export function cacheHas(path: string): boolean {
  return cache.has(path);
}

export function cacheClear(): void {
  cache.clear();
}
