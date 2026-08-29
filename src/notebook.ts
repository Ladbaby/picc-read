// =============================================================================
// picc-read — src/notebook.ts
//
// Adaptors:
//   - `getFsImplementation().readFileBytes` → `node:fs/promises.readFile`.
//   - `expandPath` → local `src/path.ts`.
//   - `formatOutput` (BashTool) → a small local truncation helper.
//   - Anthropic `ToolResultBlockParam` rendering (`mapNotebookCellsToToolResult`)
//     is re-exposed as `renderNotebookCells`, which returns pi's
//     `(TextContent | ImageContent)[]` content array instead of an Anthropic
//     tool_result block.
// =============================================================================

import { readFile } from "node:fs/promises";
import { expandPath } from "./path.js";

// Structural mirrors of pi's `TextContent` / `ImageContent` (pi-ai). Kept local
// to avoid a direct import from the nested `pi-ai` package; picc-read only
// depends on `pi-coding-agent`, whose `AgentToolResult.content` accepts these
// shapes structurally.
export type TextContent = { type: "text"; text: string };
export type ImageContent = {
  type: "image";
  data: string;
  mimeType: string;
};

const LARGE_OUTPUT_THRESHOLD = 10_000;

// -----------------------------------------------------------------------------
// Types (from claude-code types/notebook.ts)
// -----------------------------------------------------------------------------

type NotebookCellOutput =
  | {
      output_type: "stream";
      text: string | string[];
    }
  | {
      output_type: "execute_result" | "display_data";
      data: Record<string, unknown>;
    }
  | {
      output_type: "error";
      ename: string;
      evalue: string;
      traceback: string[];
    };

type NotebookCell = {
  id?: string;
  cell_type: "code" | "markdown" | "raw";
  source: string | string[];
  execution_count?: number | null;
  outputs?: NotebookCellOutput[];
};

type NotebookContent = {
  metadata?: { language_info?: { name?: string } };
  cells: NotebookCell[];
};

type NotebookOutputImage = {
  image_data: string;
  media_type: "image/png" | "image/jpeg";
};

type NotebookCellSourceOutput = {
  output_type: string;
  text?: string;
  image?: NotebookOutputImage;
};

export type NotebookCellSource = {
  cellType: string;
  source: string;
  execution_count?: number;
  cell_id: string;
  language?: string;
  outputs?: NotebookCellSourceOutput[];
};

// -----------------------------------------------------------------------------
// Cell processing (ported)
// -----------------------------------------------------------------------------

function isLargeOutputs(
  outputs: (NotebookCellSourceOutput | undefined)[],
): boolean {
  let size = 0;
  for (const o of outputs) {
    if (!o) continue;
    size += (o.text?.length ?? 0);
    if (size > LARGE_OUTPUT_THRESHOLD) return true;
  }
  return false;
}

function truncateOutput(text: string): string {
  const MAX = 20_000;
  if (text.length <= MAX) return text;
  return `${text.slice(0, MAX)}\n... [output truncated]`;
}

function processOutputText(text: string | string[] | undefined): string {
  if (!text) return "";
  const rawText = Array.isArray(text) ? text.join("") : text;
  return truncateOutput(rawText);
}

function extractImage(data: Record<string, unknown>): NotebookOutputImage | undefined {
  if (typeof data["image/png"] === "string") {
    return {
      image_data: (data["image/png"] as string).replace(/\s/g, ""),
      media_type: "image/png",
    };
  }
  if (typeof data["image/jpeg"] === "string") {
    return {
      image_data: (data["image/jpeg"] as string).replace(/\s/g, ""),
      media_type: "image/jpeg",
    };
  }
  return undefined;
}

function processOutput(output: NotebookCellOutput): NotebookCellSourceOutput {
  switch (output.output_type) {
    case "stream":
      return {
        output_type: output.output_type,
        text: processOutputText(output.text),
      };
    case "execute_result":
    case "display_data":
      return {
        output_type: output.output_type,
        text: processOutputText(
          (output.data?.["text/plain"] as string) ?? undefined,
        ),
        image: output.data ? extractImage(output.data) : undefined,
      };
    case "error":
      return {
        output_type: output.output_type,
        text: processOutputText(
          `${output.ename}: ${output.evalue}\n${output.traceback.join("\n")}`,
        ),
      };
  }
}

function processCell(
  cell: NotebookCell,
  index: number,
  codeLanguage: string,
  includeLargeOutputs: boolean,
): NotebookCellSource {
  const cellId = cell.id ?? `cell-${index}`;
  const cellData: NotebookCellSource = {
    cellType: cell.cell_type,
    source: Array.isArray(cell.source) ? cell.source.join("") : cell.source,
    execution_count:
      cell.cell_type === "code" ? cell.execution_count || undefined : undefined,
    cell_id: cellId,
  };
  if (cell.cell_type === "code") {
    cellData.language = codeLanguage;
  }
  if (cell.cell_type === "code" && cell.outputs?.length) {
    const outputs = cell.outputs.map(processOutput);
    if (!includeLargeOutputs && isLargeOutputs(outputs)) {
      cellData.outputs = [
        {
          output_type: "stream",
          text: `Outputs are too large to include. Use bash with: cat <notebook_path> | jq '.cells[${index}].outputs'`,
        },
      ];
    } else {
      cellData.outputs = outputs;
    }
  }
  return cellData;
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/** Read and parse a Jupyter notebook into processed cell data. */
export async function readNotebook(
  notebookPath: string,
  cellId?: string,
): Promise<NotebookCellSource[]> {
  const fullPath = expandPath(notebookPath);
  const buffer = await readFile(fullPath);
  const content = buffer.toString("utf-8");
  const notebook = JSON.parse(content) as NotebookContent;
  const language = notebook.metadata?.language_info?.name ?? "python";
  if (cellId) {
    const cell = notebook.cells.find((c) => c.id === cellId);
    if (!cell) {
      throw new Error(`Cell with ID "${cellId}" not found in notebook`);
    }
    return [processCell(cell, notebook.cells.indexOf(cell), language, true)];
  }
  return notebook.cells.map((cell, index) =>
    processCell(cell, index, language, false),
  );
}

// -----------------------------------------------------------------------------
// Rendering (pi content array instead of an Anthropic tool_result block)
// -----------------------------------------------------------------------------

function cellContent(cell: NotebookCellSource): TextContent {
  const metadata: string[] = [];
  if (cell.cellType !== "code") {
    metadata.push(`<cell_type>${cell.cellType}</cell_type>`);
  }
  if (cell.language !== "python" && cell.cellType === "code") {
    metadata.push(`<language>${cell.language}</language>`);
  }
  const cellContent = `<cell id="${cell.cell_id}">${metadata.join("")}${cell.source}</cell id="${cell.cell_id}">`;
  return { type: "text", text: cellContent };
}

function cellOutputs(
  cell: NotebookCellSource,
): (TextContent | ImageContent)[] {
  const outputs: (TextContent | ImageContent)[] = [];
  for (const output of cell.outputs ?? []) {
    if (output.text) {
      outputs.push({ type: "text", text: `\n${output.text}` });
    }
    if (output.image) {
      outputs.push({
        type: "image",
        data: output.image.image_data,
        mimeType: output.image.media_type,
      });
    }
  }
  return outputs;
}

/**
 * Render notebook cells into a pi content array, merging adjacent text
 * segments the way claude-code's `mapNotebookCellsToToolResult` merges
 * adjacent text blocks.
 */
export function renderNotebookCells(
  cells: NotebookCellSource[],
): (TextContent | ImageContent)[] {
  const blocks: (TextContent | ImageContent)[] = cells.flatMap((cell) => [
    cellContent(cell),
    ...cellOutputs(cell),
  ]);

  return blocks.reduce<(TextContent | ImageContent)[]>((acc, curr) => {
    const prev = acc[acc.length - 1];
    if (prev && prev.type === "text" && curr.type === "text") {
      prev.text += "\n" + curr.text;
      return acc;
    }
    acc.push(curr);
    return acc;
  }, []);
}

export function parseCellId(cellId: string): number | undefined {
  const match = cellId.match(/^cell-(\d+)$/);
  if (match?.[1]) {
    const index = parseInt(match[1], 10);
    return Number.isNaN(index) ? undefined : index;
  }
  return undefined;
}
