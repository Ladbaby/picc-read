// =============================================================================
// picc-read — src/execFileNoThrow.ts
//
// Adaptor for claude-code's `utils/execFileNoThrow.ts` (which uses `execa`).
// Uses `node:child_process:execFile` (callback form, wrapped in a Promise) and
// returns the same `{ stdout, stderr, code, error? }` shape pdf.ts consumes.
//
// Note: imported from `node:child_process` (not `node:child_process/promises`)
// so it resolves cleanly under `moduleResolution: "Bundler"`.
// =============================================================================

import { execFile as execFileCb } from "node:child_process";

type ExecFileOptions = {
  abortSignal?: AbortSignal;
  timeout?: number;
  useCwd?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

/**
 * Run a command, never throwing. Returns exit code + captured stdout/stderr.
 * Mirrors claude-code `execFileNoThrow`'s return shape.
 */
export async function execFileNoThrow(
  file: string,
  args: string[],
  options: ExecFileOptions = {},
): Promise<{ stdout: string; stderr: string; code: number; error?: string }> {
  const result = await new Promise<{
    code: number;
    stdout: string;
    stderr: string;
    message?: string;
    killed?: boolean;
  }>((resolve) => {
    execFileCb(
      file,
      args,
      {
        timeout: options.timeout,
        signal: options.abortSignal,
        cwd: options.cwd,
        env: options.env as NodeJS.ProcessEnv | undefined,
        maxBuffer: 20 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        // Exit code: 0 on success; 127 for ENOENT (binary missing); 124 for
        // timeout/killed; else the numeric exit code (default 1).
        const err = error as
          | (NodeJS.ErrnoException & { code?: number; killed?: boolean })
          | undefined;
        let code = 0;
        if (error) {
          if (err?.code === "ENOENT") {
            code = 127;
          } else if (err?.killed || err?.code === 124) {
            code = 124;
          } else if (typeof err?.code === "number") {
            code = err.code;
          } else {
            code = 1;
          }
        }
        resolve({
          code,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          message: err?.message,
          killed: err?.killed,
        });
      },
    );
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code,
    error: result.message,
  };
}
