import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { cacheClear } from "../src/dedup.js";
import { executeRead, validateReadInput } from "../src/read.js";

describe("executeRead (orchestrator)", () => {
	let cwd: string;
	const sessionA = "session-a";
	const sessionB = "session-b";
	beforeEach(async () => {
		cacheClear();
		cwd = await mkdtemp(join(tmpdir(), "picc-read-orch-"));
	});

	it("reads a text file with cat -n line numbers", async () => {
		const file = join(cwd, "hello.txt");
		await writeFile(file, "one\ntwo\nthree");
		const outcome = await executeRead(
			{ file_path: file },
			cwd,
			sessionA,
		);
		expect(outcome.type).toBe("text");
		if (outcome.type === "text") {
			expect(outcome.content).toBe("1\tone\n2\ttwo\n3\tthree");
			expect(outcome.totalLines).toBe(3);
			expect(outcome.startLine).toBe(1);
		}
	});

	it("honors offset and limit (1-based)", async () => {
		const file = join(cwd, "many.txt");
		await writeFile(file, "l1\nl2\nl3\nl4\nl5");
		const outcome = await executeRead(
			{ file_path: file, offset: 2, limit: 2 },
			cwd,
			sessionA,
		);
		expect(outcome.type).toBe("text");
		if (outcome.type === "text") {
			expect(outcome.content).toBe("2\tl2\n3\tl3");
		}
	});

	it("dedups an identical unchanged re-read within the same session", async () => {
		const file = join(cwd, "dedup.txt");
		await writeFile(file, "stable content");
		await executeRead({ file_path: file }, cwd, sessionA);
		const second = await executeRead({ file_path: file }, cwd, sessionA);
		expect(second.type).toBe("file_unchanged");
	});

	it("does NOT dedup a re-read from a different session (e.g. a subagent)", async () => {
		const file = join(cwd, "cross-session.txt");
		await writeFile(file, "explored by a subagent");
		// A subagent (different in-process session) reads the file first.
		await executeRead({ file_path: file }, cwd, sessionB);
		// The main session reading the same file must get full content, not
		// the "unchanged" stub, since it never read the file itself.
		const mainRead = await executeRead({ file_path: file }, cwd, sessionA);
		expect(mainRead.type).toBe("text");
		if (mainRead.type === "text") {
			expect(mainRead.content).toBe("1\texplored by a subagent");
		}
	});

	it("returns a friendly ENOENT message for missing files", async () => {
		const file = join(cwd, "missing.txt");
		await expect(
			executeRead({ file_path: file }, cwd, sessionA),
		).rejects.toThrow(/File does not exist/);
	});

	it("validates an invalid pages range", () => {
		const r = validateReadInput(
			{ file_path: "x.pdf", pages: "10-1" },
			cwd,
		);
		expect(r.ok).toBe(false);
	});
});
