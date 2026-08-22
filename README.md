# picc-read

Claude Code-style **Read** tool for [pi](https://pi.dev) — a faithful port of Claude Code's `Read` tool, overriding pi's built-in `read`.

Part of [picc](https://github.com/Ladbaby/picc), a pi agent setup mirroring Claude Code's harness.

> pi's built-in `read` reads text and images with simple byte/line truncation. It has no PDF
> support, no Jupyter notebooks, no read-dedup, and a different line-numbering format. This
> extension replicates Claude Code's `Read` exactly: text + images + PDF + notebooks, with
> `cat -n` line numbers, a max-output-token cap, and same-range read-dedup.

## Usage

Install via `pi install npm:@ladbabynpm/picc-read`.

## Tool

- **Name:** `read` (default; overrides pi's built-in `read`) or `Read` — configurable (see below).
- **Parameters:** `file_path` (required), plus `offset` (1-based line to start), `limit`
  (number of lines), and `pages` (PDF page range, e.g. `"1-5"`).
- **Dispatch by extension** (exactly like Claude Code):
  - **Text** — line-oriented read with `cat -n` numbers, 256KB whole-file pre-read cap, a
    max-output-token cap (`PICC_READ_MAX_OUTPUT_TOKENS`, default 25000), and read-dedup.
  - **Images** (png/jpg/jpeg/gif/webp) — `sharp` resize/compression to fit the 2000×2000 +
    3.75MB + token budget, returned as an image block with a dimension-metadata line.
  - **PDF** — whole document (base64) or per-page JPEG extraction via `pdftoppm`
    (poppler-utils); `pages` range parameter; files > 10 pages require `pages`.
  - **Jupyter notebooks** (`.ipynb`) — all cells with source + outputs (text + images),
    large outputs elided with a `jq` hint.
- **Read-dedup:** re-reading an identical, unchanged range returns the
  `File unchanged since last read…` stub instead of resending the full content.

## Requirements

- `sharp` (native) — automatic runtime dependency, for image processing.
- `poppler-utils` (`pdftoppm` / `pdfinfo`) on `PATH` — needed for PDF page counts and
  page extraction. Without it, small PDF whole-document reads still work.

## Configuration

| Setting | Where | Values | Default |
|---|---|---|---|
| `toolName` | `config.json` | `"read"` \| `"Read"` | `"read"` |
| `PICC_READ_TOOL_NAME` | env | `"read"` \| `"Read"` | — |
| `PICC_READ_CONFIG_PATH` | env | absolute path to a config.json | `~/.pi/agent/extensions/picc-read/config.json` |
| `PICC_READ_MAX_OUTPUT_TOKENS` | env | integer (floored at 1000) | 25000 |

Precedence for the tool name: `PICC_READ_TOOL_NAME` env > `config.json` > `"read"`.

## What is omitted from the live source

No pi equivalent, so left out: permission checks (pi handles read permissions separately),
GrowthBook killswitches, analytics, skill discovery, file-read listeners, and the
API-based second stage of token validation (pi has no token-counting endpoint — the rough
estimate enforces the cap).

## Development

```bash
npm install
npm run lint        # biome check
npm run typecheck   # tsc --noEmit
npm run test        # vitest run
```

## References

- Claude Code Read tool: `tools/FileReadTool/FileReadTool.ts` (+ `prompt.ts`, `limits.ts`, `UI.tsx`)
- Claude Code readers: `utils/readFileInRange.ts`, `utils/file.ts`, `utils/imageResizer.ts`,
  `utils/notebook.ts`, `utils/pdf.ts`, `utils/pdfUtils.ts`, `utils/path.ts`
