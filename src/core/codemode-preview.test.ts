import { Buffer } from "node:buffer";
import type { ExtensionAPI, ToolResultEvent, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import { createTwoFilesPatch } from "diff";
import { describe, expect, it } from "vitest";
import { registerCodemodePreviews } from "./codemode-preview.js";
import {
	MAX_PREVIEW_CHANGES,
	MAX_PREVIEW_DETAILS_BYTES,
	readPreviewDetails,
	readToolPreview,
	writePreviewDetails,
} from "./tool-preview.js";

function harness() {
	const handlers = new Map<string, (event: never, context: never) => unknown>();
	const pi = {
		on: (name: string, handler: (event: never, context: never) => unknown) => {
			handlers.set(name, handler);
		},
	} as unknown as ExtensionAPI;
	registerCodemodePreviews(pi);
	return {
		result: (event: ToolResultEvent) =>
			handlers.get("tool_result")?.(event as never, undefined as never) as ToolResultEventResult | undefined,
		lifecycle: (name: string) => handlers.get(name)?.(undefined as never, undefined as never),
	};
}

function result(overrides: Partial<ToolResultEvent> = {}): ToolResultEvent {
	return {
		type: "tool_result",
		toolName: "codemode",
		toolCallId: "parent",
		input: { code: "" },
		content: [],
		details: { output: "", calls: [] },
		isError: false,
		...overrides,
	};
}

function write(parentToolCallId = "parent", path = "a.txt", content = "new") {
	return result({
		toolName: "write",
		toolCallId: `${parentToolCallId}:write`,
		parentToolCallId,
		input: { path, content },
		details: { piDiff: writePreviewDetails(path, null, content) },
	});
}

function saved(response: ToolResultEventResult | undefined) {
	const details = response?.details as { piDiff?: unknown } | undefined;
	return readPreviewDetails(details?.piDiff);
}

describe("codemode preview persistence", () => {
	it("captures actual native edit patches under the explicit parent id with no script output", () => {
		const events = harness();
		const child = result({
			toolName: "edit",
			toolCallId: "not-derived-from-parent",
			parentToolCallId: "parent",
			input: { path: "a.ts", oldText: "not the actual patch", newText: "not the actual patch" },
			details: { patch: createTwoFilesPatch("a.ts", "a.ts", "old\n", "new\n") },
		});
		expect(events.result(child)).toBeUndefined();
		expect(saved(events.result(result()))).toStrictEqual(readToolPreview("edit", child.details, child.input));
	});

	it("keeps operation order, repeated paths, and concurrent parent calls separate", async () => {
		const events = harness();
		const children = [
			write("parent", "a", "first"),
			write("other", "a", "unrelated"),
			write("parent", "b"),
			write("parent", "a", "last"),
		];
		await Promise.all(children.map(async (child) => events.result(child)));
		expect(saved(events.result(result()))).toStrictEqual({
			version: 1,
			changes: [
				{ kind: "new", filePath: "a", content: "first", omittedLines: 0 },
				{ kind: "new", filePath: "b", content: "new", omittedLines: 0 },
				{ kind: "new", filePath: "a", content: "last", omittedLines: 0 },
			],
			omittedChanges: 0,
		});
		expect(saved(events.result(result({ toolCallId: "other" })))?.changes).toStrictEqual([
			{ kind: "new", filePath: "a", content: "unrelated", omittedLines: 0 },
		]);
	});

	it.each([false, true])("preserves parent fields, content, error status and usage (isError=%s)", (isError) => {
		const events = harness();
		events.result(write());
		const parent = result({
			isError,
			content: [{ type: "text", text: "script output or failure" }],
			details: { output: "kept", calls: [{ name: "write" }], extra: { value: 1 } },
			usage: {
				input: 1,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 3,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		const before = structuredClone(parent);
		expect(events.result(parent)).toStrictEqual({
			details: {
				output: "kept",
				calls: [{ name: "write" }],
				extra: { value: 1 },
				piDiff: writePreviewDetails("a.txt", null, "new"),
			},
		});
		expect(parent).toStrictEqual(before);
	});

	it("retains successful earlier changes when later nested calls fail or are cancelled", () => {
		const events = harness();
		events.result(write());
		events.result({ ...write("parent", "failed"), isError: true });
		expect(saved(events.result(result({ isError: true })))).toStrictEqual(writePreviewDetails("a.txt", null, "new"));
	});

	it("ignores standalone, unrelated, failed, and malformed child results", () => {
		const events = harness();
		for (const event of [
			{ ...write(), parentToolCallId: undefined },
			{ ...write(), toolName: "bash" },
			{ ...write(), isError: true },
			{ ...write(), details: { piDiff: { version: 2, changes: [], omittedChanges: 0 } } },
			{ ...write(), details: undefined },
		])
			events.result(event);
		expect(events.result(result())).toBeUndefined();
	});

	it("does not decorate non-codemode parents and releases their collected state", () => {
		const events = harness();
		events.result(write());
		expect(events.result(result({ toolName: "other-tool" }))).toBeUndefined();
		expect(events.result(result())).toBeUndefined();
	});

	it("persists validated JSON data for reopening independently of live capture state", () => {
		const events = harness();
		events.result(write());
		const response = events.result(result());
		const reopened = JSON.parse(JSON.stringify(response));
		expect(saved(reopened)).toStrictEqual(writePreviewDetails("a.txt", null, "new"));
		expect(events.result(result({ details: reopened.details }))).toBeUndefined();
		expect(saved(reopened)).toStrictEqual(writePreviewDetails("a.txt", null, "new"));
	});

	it.each([
		"session_start",
		"session_shutdown",
		"session_tree",
		"agent_end",
	])("clears transient state on %s", (name) => {
		const events = harness();
		events.result(write());
		events.lifecycle(name);
		expect(events.result(result())).toBeUndefined();
	});

	it.each([undefined, null, "unexpected"])("handles absent/non-object parent details: %j", (details) => {
		const events = harness();
		events.result(write());
		expect(events.result(result({ details }))).toStrictEqual({
			details: { piDiff: writePreviewDetails("a.txt", null, "new") },
		});
	});

	it("retains line truncation and each validated operation kind after JSON reopening", () => {
		const events = harness();
		const preview = {
			version: 1 as const,
			changes: [
				{ kind: "new" as const, filePath: "a", content: "partial", omittedLines: 20 },
				{ kind: "unchanged" as const, filePath: "b" },
			],
			omittedChanges: 3,
		};
		events.result({ ...write(), details: { piDiff: preview } });
		expect(saved(JSON.parse(JSON.stringify(events.result(result()))))).toStrictEqual(preview);
	});

	it("propagates child omissions and caps retained operations without reordering", () => {
		const events = harness();
		for (let i = 0; i < MAX_PREVIEW_CHANGES + 3; i++) events.result(write("parent", `${i}`));
		events.result({ ...write(), details: { piDiff: { version: 1, changes: [], omittedChanges: 4 } } });
		const preview = saved(events.result(result()));
		expect(preview).toStrictEqual({
			version: 1,
			changes: Array.from({ length: MAX_PREVIEW_CHANGES }, (_, i) => ({
				kind: "new",
				filePath: `${i}`,
				content: "new",
				omittedLines: 0,
			})),
			omittedChanges: 7,
		});
	});

	it("bounds serialized parent details and reports dropped large operations", () => {
		const events = harness();
		for (let i = 0; i < 8; i++) events.result(write("parent", `${i}`, "x".repeat(200_000)));
		const preview = saved(events.result(result()));
		expect(preview?.changes).toHaveLength(5);
		expect(preview?.omittedChanges).toBe(3);
		expect(Buffer.byteLength(JSON.stringify(preview))).toBeLessThanOrEqual(MAX_PREVIEW_DETAILS_BYTES);
	});

	it("bounds global retained payload and releases capacity on completion", () => {
		const events = harness();
		for (let parent = 0; parent < 12; parent++) {
			for (let i = 0; i < 5; i++) events.result(write(`${parent}`, `${i}`, "x".repeat(200_000)));
		}
		const previews = Array.from({ length: 12 }, (_, i) => saved(events.result(result({ toolCallId: `${i}` }))));
		expect(previews.every(Boolean)).toBe(true);
		expect(previews.reduce((sum, preview) => sum + (preview?.changes.length ?? 0), 0)).toBeLessThan(60);
		expect(previews.reduce((sum, preview) => sum + (preview?.omittedChanges ?? 0), 0)).toBeGreaterThan(0);
		events.result(write("fresh"));
		expect(saved(events.result(result({ toolCallId: "fresh" })))).toStrictEqual(
			writePreviewDetails("a.txt", null, "new"),
		);
	});

	it("bounds pending parent identifiers and marks untracked parents after capacity exhaustion", () => {
		const events = harness();
		for (let i = 0; i < 1000; i++) events.result(write(`${i}`));
		expect(saved(events.result(result({ toolCallId: "999" })))).toStrictEqual({
			version: 1,
			changes: [],
			omittedChanges: 1,
		});
		events.result(result({ toolCallId: "0" }));
		events.result(write("999", "later"));
		expect(saved(events.result(result({ toolCallId: "999" })))).toStrictEqual({
			version: 1,
			changes: [{ kind: "new", filePath: "later", content: "new", omittedLines: 0 }],
			omittedChanges: 1,
		});
		events.lifecycle("session_start");
		expect(events.result(result({ toolCallId: "999" }))).toBeUndefined();
	});

	it("does not retain arbitrarily large parent identifiers", () => {
		const events = harness();
		const id = "x".repeat(10_000);
		events.result(write(id));
		expect(saved(events.result(result({ toolCallId: id })))).toStrictEqual({
			version: 1,
			changes: [],
			omittedChanges: 1,
		});
	});

	it("clears completed parents before their identifiers are reused", () => {
		const events = harness();
		events.result(write());
		events.result(result());
		events.result(write("parent", "second"));
		expect(saved(events.result(result()))).toStrictEqual(writePreviewDetails("second", null, "new"));
		expect(events.result(result())).toBeUndefined();
	});

	it("saturates omission counters at a serializable safe integer", () => {
		const events = harness();
		for (let i = 0; i < 2; i++)
			events.result({
				...write(),
				details: { piDiff: { version: 1, changes: [], omittedChanges: Number.MAX_SAFE_INTEGER } },
			});
		expect(saved(events.result(result()))).toStrictEqual({
			version: 1,
			changes: [],
			omittedChanges: Number.MAX_SAFE_INTEGER,
		});
	});
});
