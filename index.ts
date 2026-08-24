/**
 * picc-read: Claude Code-style Read tool for pi.
 *
 * A faithful port of Claude Code's `Read` tool (`tools/FileReadTool/FileReadTool.ts`),
 * registering a tool named `read`/`Read` that **overrides pi's built-in `read`**
 * tool (same-name, last-write-wins — see `core/tools/index.js`).
 *
 * Supported input types (dispatched by file extension, exactly like Claude Code):
 *   - **Text** — line-oriented read with `cat -n` style numbers, `offset` (1-based)
 *     + `limit`, a 256KB whole-file pre-read cap, a max-output-token cap
 *     (`PICC_READ_MAX_OUTPUT_TOKENS`), and read-dedup (`file_unchanged` stub).
 *   - **Images** (png/jpg/jpeg/gif/webp) — sharp-based resize/compression to fit
 *     the 2000x2000 + 3.75MB + token budget, returned as an image block.
 *   - **PDF** — whole document (base64) or per-page JPEG extraction via
 *     `pdftoppm` (poppler-utils); `pages` range parameter.
 *   - **Jupyter notebooks** (`.ipynb`) — all cells with source + outputs
 *     (text + images), large outputs elided with a `jq` hint.
 *
 * Omitted from the live source (no pi equivalent):
 *   - permission checks (`checkReadPermissionForTool` — pi's permission system
 *     is separate and handles read permissions)
 *   - GrowthBook killswitches, analytics (`logEvent`), skill discovery,
 *     file-read listeners, auto-memory freshness prefixes
 *   - the API-based second stage of `validateContentTokens` (no token-counting
 *     endpoint in pi; the rough estimate enforces the cap)
 *
 * Tool name configuration:
 *   - Default: `"read"` (lowercase; pi's built-in tool name).
 *   - Set `config.json` `toolName` to `"Read"` (default location
 *     `~/.pi/agent/extensions/picc-read/config.json`), or set
 *     `PICC_READ_TOOL_NAME=Read`. Valid values: `"read"`, `"Read"`.
 *
 * Requires `sharp` (native) for image processing. PDF page extraction and page
 * counts additionally require `poppler-utils` (`pdftoppm` / `pdfinfo`) on PATH;
 * without them, PDF whole-document reads still work when the file is small.
 *
 * References:
 * - Claude Code Read tool: tools/FileReadTool/FileReadTool.ts (+ prompt.ts, UI.tsx, limits.ts)
 * - Claude Code readers: utils/readFileInRange.ts, utils/file.ts, utils/imageResizer.ts,
 *   utils/notebook.ts, utils/pdf.ts, utils/pdfUtils.ts, utils/path.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	cacheClearForSession,
	DEFAULT_SESSION_KEY,
} from "./src/dedup.js";
import { formatFileSize } from "./src/format.js";
import {
	type ImageContent,
	readNotebook,
	renderNotebookCells,
	type TextContent,
} from "./src/notebook.js";
import {
	DESCRIPTION,
	FILE_UNCHANGED_STUB,
} from "./src/prompt.js";
import {
	executeRead,
	type ImageFileRead,
	type PDFFileRead,
	type PDFPartsRead,
	type ReadInput,
	type ReadOutcome,
	type TextFileRead,
	validateReadInput,
} from "./src/read.js";

// ============================================================================
// Config (mirrors picc-grep)
// ============================================================================

const VALID_TOOL_NAMES = ["read", "Read"] as const;
type ToolName = (typeof VALID_TOOL_NAMES)[number];

function resolveConfigPath(): string {
	const env = process.env.PICC_READ_CONFIG_PATH;
	if (env) return env;
	return join(homedir(), ".pi", "agent", "extensions", "picc-read", "config.json");
}

function readToolNameFromConfig(): ToolName | undefined {
	const configPath = resolveConfigPath();
	if (!existsSync(configPath)) return undefined;
	try {
		const raw = readFileSync(configPath, "utf-8");
		const parsed = JSON.parse(raw) as { toolName?: unknown };
		const val = parsed?.toolName;
		if (
			typeof val === "string" &&
			(VALID_TOOL_NAMES as readonly string[]).includes(val)
		) {
			return val as ToolName;
		}
		if (val !== undefined) {
			console.warn(
				`[picc-read] config.json: invalid toolName "${val}" — valid values are ${VALID_TOOL_NAMES.join(", ")}. Falling back to "read".`,
			);
		}
	} catch {
		// unreadable / malformed — fall through to default
	}
	return undefined;
}

function loadToolName(): ToolName {
	const envVal = process.env.PICC_READ_TOOL_NAME;
	if (typeof envVal === "string") {
		if ((VALID_TOOL_NAMES as readonly string[]).includes(envVal)) {
			return envVal as ToolName;
		}
		console.warn(
			`[picc-read] PICC_READ_TOOL_NAME="${envVal}" is invalid — valid values are ${VALID_TOOL_NAMES.join(", ")}. Falling back to "read".`,
		);
	}
	return readToolNameFromConfig() ?? "read";
}

// ============================================================================
// Schema
// ============================================================================

const READ_SCHEMA = Type.Object({
	file_path: Type.String({
		description: "The absolute path to the file to read",
	}),
	offset: Type.Optional(
		Type.Number({
			description:
				"The line number to start reading from. Only provide if the file is too large to read at once",
		}),
	),
	limit: Type.Optional(
		Type.Number({
			description:
				"The number of lines to read. Only provide if the file is too large to read at once.",
		}),
	),
	pages: Type.Optional(
		Type.String({
			description:
				'Page range for PDF files (e.g., "1-5", "3", "10-20"). Only applicable to PDF files. Maximum 20 pages per request.',
		}),
	),
});

// ============================================================================
// Result rendering
// ============================================================================

type ReadDetails = {
	type: string;
	path?: string;
	totalLines?: number;
	numLines?: number;
};

type ResultContent = TextContent | ImageContent;

function textContent(outcome: TextFileRead): ResultContent {
	if (outcome.content) {
		return { type: "text", text: outcome.content };
	}
	const warning =
		outcome.totalLines === 0
			? "<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>"
			: `<system-reminder>Warning: the file exists but is shorter than the provided offset (${outcome.startLine}). The file has ${outcome.totalLines} lines.</system-reminder>`;
	return { type: "text", text: warning };
}

function resultContent(outcome: ReadOutcome): ResultContent[] {
	switch (outcome.type) {
		case "text":
			return [textContent(outcome)];
		case "image": {
			const f = outcome as ImageFileRead;
			const blocks: ResultContent[] = [
				{ type: "image", data: f.base64, mimeType: f.mimeType },
			];
			if (f.metadataText) {
				blocks.push({ type: "text", text: f.metadataText });
			}
			return blocks;
		}
		case "pdf": {
			const f = outcome as PDFFileRead;
			return [
				{
					type: "text",
					text: `PDF file read: ${f.filePath} (${formatFileSize(f.originalSize)})`,
				},
			];
		}
		case "parts": {
			const f = outcome as PDFPartsRead;
			const blocks: ResultContent[] = [
				{
					type: "text",
					text: `PDF pages extracted: ${f.count} page(s) from ${f.filePath}`,
				},
			];
			for (const page of f.pages ?? []) {
				if (page.metadataText) {
					blocks.push({ type: "text", text: page.metadataText });
				}
				blocks.push({
					type: "image",
					data: page.base64,
					mimeType: page.mimeType,
				});
			}
			return blocks;
		}
		case "file_unchanged":
			return [{ type: "text", text: FILE_UNCHANGED_STUB }];
		case "notebook":
			// Placeholder — the entry point re-reads cells to render them.
			return [
				{
					type: "text",
					text: `Read ${outcome.cellCount} cell(s) from ${outcome.filePath}`,
				},
			];
	}
}

function buildDetails(outcome: ReadOutcome): ReadDetails {
	if (outcome.type === "text") {
		return {
			type: "text",
			path: outcome.filePath,
			totalLines: outcome.totalLines,
			numLines: outcome.numLines,
		};
	}
	return { type: outcome.type, path: outcome.filePath };
}

// ============================================================================
// Extension entry point
// ============================================================================

export default function (pi: ExtensionAPI): void {
	const toolName = loadToolName();

	// Free this session's read-dedup entries when it shuts down. Subagent
	// sessions run in-process and would otherwise leak their cache entries into
	// the shared module forever.
	pi.on("session_shutdown", (_event, ctx) => {
		cacheClearForSession(
			ctx.sessionManager.getSessionId?.() ?? DEFAULT_SESSION_KEY,
		);
	});

	pi.registerTool({
		name: toolName,
		label: toolName,
		description: DESCRIPTION,
		promptSnippet: "Read files (text, images, PDF, notebooks)",
		promptGuidelines: [],
		parameters: READ_SCHEMA,
		executionMode: "parallel",
		async execute(
			_toolCallId,
			params,
			signal,
			_onUpdate,
			ctx: ExtensionContext,
		) {
			const input = params as ReadInput;
			const cwd = ctx.cwd;
			// Scope read-dedup to this session so in-process subagents (which
			// share the picc-read module) can't make this session return a
			// "File unchanged since last read" stub for files it never read.
			const session =
				ctx.sessionManager.getSessionId?.() ?? DEFAULT_SESSION_KEY;

			const validation = validateReadInput(input, cwd);
			if (!validation.ok) {
				return {
					content: [{ type: "text", text: validation.message }],
					isError: true,
					details: { type: "error", path: input.file_path },
				};
			}

			try {
				const outcome = await executeRead(input, cwd, session, signal);

				let content: ResultContent[];
				if (outcome.type === "notebook") {
					const cells = await readNotebook(outcome.filePath);
					content = renderNotebookCells(cells);
				} else {
					content = resultContent(outcome);
				}

				return {
					content,
					details: buildDetails(outcome),
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: message }],
					isError: true,
					details: { type: "error", path: input.file_path },
				};
			}
		},
	});
}
