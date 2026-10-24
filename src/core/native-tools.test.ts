import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createEditToolDefinition,
	createWriteToolDefinition,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNativeEditTool, createNativeWriteTool } from "./native-tools.js";

let cwd: string;
beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "pi-diff-native-"));
});
afterEach(async () => {
	await rm(cwd, { recursive: true, force: true });
});

describe("native tool adapters", () => {
	it("preserves native tool schemas and prompt metadata", () => {
		for (const [actual, expected] of [
			[createNativeEditTool(cwd), createEditToolDefinition(cwd)],
			[createNativeWriteTool(cwd), createWriteToolDefinition(cwd)],
		]) {
			const metadata = (tool: typeof actual) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
				promptSnippet: tool.promptSnippet,
				promptGuidelines: tool.promptGuidelines,
				constrainedSampling: tool.constrainedSampling,
				prepareArguments: tool.prepareArguments,
			});
			expect(metadata(actual)).toStrictEqual(metadata(expected));
		}
	});

	it("captures previous contents after earlier queued mutations finish", async () => {
		const path = join(cwd, "a.txt");
		await writeFile(path, "initial\n");
		let release = () => {};
		let entered = () => {};
		const ready = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const blocker = withFileMutationQueue(path, async () => {
			entered();
			await gate;
			await writeFile(path, "queued\n");
		});
		await ready;
		const pending = createNativeWriteTool(cwd).execute(
			"write",
			{ path, content: "final\n" },
			undefined,
			undefined,
			undefined as never,
		);
		release();
		await blocker;
		const result = await pending;
		expect({
			content: result.content,
			previous: result.details?.piDiff.changes[0],
			actual: await readFile(path, "utf8"),
		}).toStrictEqual({
			content: [{ type: "text", text: `Successfully wrote to ${path}` }],
			previous: {
				kind: "diff",
				filePath: path,
				omittedLines: 0,
				diff: {
					lines: [
						{
							type: "sep",
							content: "",
							oldNum: null,
							newNum: null,
							hunkMeta: { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 },
						},
						{ type: "del", content: "queued", oldNum: 1, newNum: null },
						{ type: "add", content: "final", oldNum: null, newNum: 1 },
					],
					added: 1,
					removed: 1,
					chars: 13,
				},
			},
			actual: "final\n",
		});
	});

	it("rejects cancelled writes without creating files", async () => {
		const path = join(cwd, "cancelled.txt");
		const controller = new AbortController();
		controller.abort();
		await expect(
			createNativeWriteTool(cwd).execute(
				"write",
				{ path, content: "new" },
				controller.signal,
				undefined,
				undefined as never,
			),
		).rejects.toThrow(/aborted/i);
		await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("does not write after cancellation during the added capture read", async () => {
		const path = join(cwd, "capture.txt");
		await writeFile(path, "original");
		let release = () => {};
		let entered = () => {};
		let writes = 0;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const ready = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const controller = new AbortController();
		const tool = createNativeWriteTool(cwd, {
			mkdir: async () => {},
			readFile: async (absolutePath) => {
				entered();
				await gate;
				return readFile(absolutePath, "utf8");
			},
			writeFile: async (absolutePath, content) => {
				writes++;
				await writeFile(absolutePath, content);
			},
		});
		const pending = tool.execute("capture", { path, content: "new" }, controller.signal, undefined, undefined as never);
		const rejection = expect(pending).rejects.toThrow(/aborted/i);
		await ready;
		controller.abort();
		release();
		await rejection;
		expect({ writes, content: await readFile(path, "utf8") }).toStrictEqual({ writes: 0, content: "original" });
	});

	it("does not fail a native write when previous contents cannot be read", async () => {
		const path = join(cwd, "unreadable.txt");
		const tool = createNativeWriteTool(cwd, {
			mkdir: async () => {},
			readFile: async () => {
				throw Object.assign(new Error("Permission denied"), { code: "EACCES" });
			},
			writeFile: (absolutePath, content) => writeFile(absolutePath, content),
		});
		const result = await tool.execute("write", { path, content: "new" }, undefined, undefined, undefined as never);
		expect({ details: result.details, content: await readFile(path, "utf8") }).toStrictEqual({
			details: { piDiff: { version: 1, changes: [], omittedChanges: 1 } },
			content: "new",
		});
	});

	it("keeps the overlapping-occurrence guard without changing native patch details", async () => {
		const path = join(cwd, "a.txt");
		await writeFile(path, "aaa");
		await expect(
			createNativeEditTool(cwd).execute(
				"edit",
				{ path, edits: [{ oldText: "aa", newText: "X" }] },
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toThrow(/ambiguous/i);
		expect(await readFile(path, "utf8")).toBe("aaa");
		await writeFile(path, "old();  \n");
		const result = await createNativeEditTool(cwd).execute(
			"edit",
			{ path, edits: [{ oldText: "old();\n", newText: "new();\n" }] },
			undefined,
			undefined,
			undefined as never,
		);
		expect(Object.keys(result.details ?? {}).sort()).toStrictEqual(["diff", "firstChangedLine", "patch"]);
		expect(result.details?.patch).toContain("-old();  ");
	});
});
