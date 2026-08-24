import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	cacheClear,
	cacheGet,
	cacheSet,
} from "../src/dedup.js";
import {
	addLineNumbers,
	readFileInRange,
} from "../src/file.js";
import { formatFileSize } from "../src/format.js";
import { getEffectiveMaxTokens } from "../src/limits.js";
import { expandPath } from "../src/path.js";
import { parsePDFPageRange } from "../src/pdfUtils.js";
import {
	bytesPerTokenForFileType,
	roughTokenCountEstimationForFileType,
} from "../src/tokenEstimation.js";

describe("addLineNumbers", () => {
	it("numbers lines starting at startLine with tab separators", () => {
		expect(
			addLineNumbers({ content: "a\nb\nc", startLine: 1 }),
		).toBe("1\ta\n2\tb\n3\tc");
	});
	it("resumes numbering from startLine", () => {
		expect(addLineNumbers({ content: "x", startLine: 5 })).toBe("5\tx");
	});
	it("returns empty string for empty content", () => {
		expect(addLineNumbers({ content: "", startLine: 1 })).toBe("");
	});
});

describe("formatFileSize", () => {
	it("formats bytes / KB / MB", () => {
		expect(formatFileSize(512)).toBe("512 bytes");
		expect(formatFileSize(2048)).toBe("2KB");
		expect(formatFileSize(5 * 1024 * 1024)).toBe("5MB");
	});
});

describe("parsePDFPageRange", () => {
	it("parses a single page", () => {
		expect(parsePDFPageRange("3")).toEqual({ firstPage: 3, lastPage: 3 });
	});
	it("parses a range", () => {
		expect(parsePDFPageRange("1-10")).toEqual({
			firstPage: 1,
			lastPage: 10,
		});
	});
	it("parses an open-ended range", () => {
		expect(parsePDFPageRange("3-")).toEqual({
			firstPage: 3,
			lastPage: Infinity,
		});
	});
	it("rejects invalid input", () => {
		expect(parsePDFPageRange("")).toBeNull();
		expect(parsePDFPageRange("abc")).toBeNull();
		expect(parsePDFPageRange("0")).toBeNull();
		expect(parsePDFPageRange("10-1")).toBeNull();
	});
});

describe("token estimation", () => {
	it("uses 2 bytes/token for json, 4 otherwise", () => {
		expect(bytesPerTokenForFileType("json")).toBe(2);
		expect(bytesPerTokenForFileType("ts")).toBe(4);
	});
	it("estimates tokens proportionally", () => {
		expect(roughTokenCountEstimationForFileType("abcd", "txt")).toBe(1);
		expect(roughTokenCountEstimationForFileType("abcd", "json")).toBe(2);
	});
});

describe("expandPath", () => {
	it("resolves relative paths against baseDir", () => {
		const base = tmpdir();
		const result = expandPath("a/b.txt", base);
		expect(normalize(result)).toBe(normalize(join(base, "a", "b.txt")));
	});
	it("expands ~ to home", () => {
		expect(normalize(expandPath("~"))).toBe(normalize(homedir()));
	});
	it("throws on null bytes", () => {
		expect(() => expandPath("a\0b")).toThrow(/null bytes/i);
	});
});

describe("readFileInRange", () => {
	let dir: string;
	afterEach(async () => {
		cacheClear();
	});
	it("reads a range with offset and limit", async () => {
		dir = await mkdtemp(join(tmpdir(), "picc-read-"));
		const file = join(dir, "lines.txt");
		await writeFile(file, "l1\nl2\nl3\nl4\nl5");
		const r = await readFileInRange(file, 1, 2); // offset line 2 (0-based 1), 2 lines
		expect(r.content).toBe("l2\nl3");
		expect(r.lineCount).toBe(2);
		expect(r.totalLines).toBe(5);
	});
	it("reads whole file with 0 offset", async () => {
		dir = await mkdtemp(join(tmpdir(), "picc-read-"));
		const file = join(dir, "all.txt");
		await writeFile(file, "a\nb\nc");
		const r = await readFileInRange(file, 0);
		expect(r.content).toBe("a\nb\nc");
	});
});

describe("dedup cache", () => {
	it("stores and retrieves entries per session", () => {
		cacheClear();
		expect(cacheGet("s1", "/x")).toBeUndefined();
		cacheSet("s1", "/x", { offset: 1, limit: undefined, timestamp: 100 });
		expect(cacheGet("s1", "/x")?.timestamp).toBe(100);
	});
	it("keeps sessions isolated", () => {
		cacheClear();
		cacheSet("s1", "/x", { offset: 1, limit: undefined, timestamp: 100 });
		expect(cacheGet("s2", "/x")).toBeUndefined();
	});
});

describe("getEffectiveMaxTokens", () => {
	it("honors PICC_READ_MAX_OUTPUT_TOKENS with a floor", () => {
		const prev = process.env.PICC_READ_MAX_OUTPUT_TOKENS;
		try {
			process.env.PICC_READ_MAX_OUTPUT_TOKENS = "99999";
			expect(getEffectiveMaxTokens()).toBe(99999);
			process.env.PICC_READ_MAX_OUTPUT_TOKENS = "1";
			expect(getEffectiveMaxTokens()).toBe(1000); // floored
		} finally {
			if (prev === undefined) delete process.env.PICC_READ_MAX_OUTPUT_TOKENS;
			else process.env.PICC_READ_MAX_OUTPUT_TOKENS = prev;
		}
	});
});
