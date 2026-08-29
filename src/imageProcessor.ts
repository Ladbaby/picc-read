// =============================================================================
// picc-read — src/imageProcessor.ts
//
// Upstream lazily `import('sharp')` / `import('image-processor-napi')`. Per
// project rules picc-read uses a top-level `sharp` import and memoizes the
// function; `getImageProcessor()` simply returns it.
// =============================================================================

import sharpDefault from "sharp";

export type SharpInstance = {
  metadata(): Promise<{
    width?: number;
    height?: number;
    format?: string;
  }>;
  resize(
    width: number,
    height: number,
    options?: { fit?: string; withoutEnlargement?: boolean },
  ): SharpInstance;
  jpeg(options?: { quality?: number }): SharpInstance;
  png(options?: {
    compressionLevel?: number;
    palette?: boolean;
    colors?: number;
  }): SharpInstance;
  webp(options?: { quality?: number }): SharpInstance;
  toBuffer(): Promise<Buffer>;
};

export type SharpFunction = (input: Buffer) => SharpInstance;

// `sharp`'s call signature is a superset of `SharpFunction`, so this is safe.
const sharp: SharpFunction = sharpDefault as unknown as SharpFunction;

/** Return the sharp function (memoized; sharp is a singleton anyway). */
export function getImageProcessor(): SharpFunction {
  return sharp;
}
