import { createTwoFilesPatch } from "diff";
import { describe, expect, it } from "vitest";
import { parseDiff } from "./diff.js";
import { MAX_PREVIEW_BYTES, readPreviewDetails, readToolPreview, writePreviewDetails } from "./tool-preview.js";

describe("native tool previews", () => {
	it("parses the actual native patch without replacing native details", () => {
		const details = { patch: createTwoFilesPatch("a.ts", "a.ts", "old();  \n", "new();\n"), firstChangedLine: 1 };
		const original = structuredClone(details);
		const preview = readToolPreview("edit", details, { path: "a.ts" });
		expect(preview).toStrictEqual({
			version: 1,
			changes: [
				{
					kind: "diff",
					filePath: "a.ts",
					omittedLines: 0,
					diff: {
						lines: [
							{
								type: "sep",
								content: "",
								oldNum: null,
								newNum: null,
								hunkMeta: { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, context: undefined },
							},
							{ type: "del", content: "old();  ", oldNum: 1, newNum: null },
							{ type: "add", content: "new();", oldNum: null, newNum: 1 },
						],
						added: 1,
						removed: 1,
						chars: 14,
					},
				},
			],
			omittedChanges: 0,
		});
		expect(details).toStrictEqual(original);
	});

	it.each([
		[null],
		[{ version: 2, changes: [], omittedChanges: 0 }],
		[{ version: 1, changes: [{ kind: "new", filePath: "a", content: 42, omittedLines: 0 }], omittedChanges: 0 }],
		[{ version: 1, changes: [], omittedChanges: -1 }],
	])("rejects unsupported or malformed persisted data: %j", (value) => {
		expect(readPreviewDetails(value)).toBeUndefined();
	});

	it("round-trips write capture through JSON", () => {
		const details = writePreviewDetails("a.ts", null, "const value = 1;\n");
		expect(readToolPreview("write", { piDiff: JSON.parse(JSON.stringify(details)) }, { path: "a.ts" })).toStrictEqual({
			version: 1,
			changes: [{ kind: "new", filePath: "a.ts", content: "const value = 1;\n", omittedLines: 0 }],
			omittedChanges: 0,
		});
	});

	it.each([
		{
			details: {
				_type: "diff",
				filePath: "saved.ts",
				diff: parseDiff("old();\n", "new();\n"),
				oldContent: "old();\n",
				newContent: "new();\n",
			},
			expected: {
				kind: "diff",
				filePath: "saved.ts",
				diff: {
					lines: [
						{
							type: "sep",
							content: "",
							oldNum: null,
							newNum: null,
							hunkMeta: { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, context: undefined },
						},
						{ type: "del", content: "old();", oldNum: 1, newNum: null },
						{ type: "add", content: "new();", oldNum: null, newNum: 1 },
					],
					added: 1,
					removed: 1,
					chars: 14,
				},
				omittedLines: 0,
			},
		},
		{
			details: { _type: "new", filePath: "saved.ts", content: "created();\n", lines: 2 },
			expected: { kind: "new", filePath: "saved.ts", content: "created();\n", omittedLines: 0 },
		},
		{
			details: { _type: "noChange" },
			expected: { kind: "unchanged", filePath: "saved.ts" },
		},
	])("reads historical write details without changing stored data: $details._type", ({ details, expected }) => {
		const saved = JSON.parse(JSON.stringify(details));
		const before = structuredClone(saved);
		expect(readToolPreview("write", saved, { path: "saved.ts" })).toStrictEqual({
			version: 1,
			changes: [expected],
			omittedChanges: 0,
		});
		expect(saved).toStrictEqual(before);
	});

	it.each([
		{
			_type: "diff",
			filePath: "saved.ts",
			diff: { lines: [{ type: "add", oldNum: null, newNum: 1, content: 42 }], added: 1, removed: 0, chars: 1 },
		},
		{ _type: "new", filePath: "saved.ts", content: 42 },
		{ _type: "diff", diff: parseDiff("old", "new") },
	])("rejects malformed historical write details: %j", (details) => {
		expect(readToolPreview("write", details, { path: "saved.ts" })).toBeUndefined();
	});

	it.each([
		{ _type: "new", filePath: "large.ts", content: "x".repeat(MAX_PREVIEW_BYTES + 1) },
		{
			_type: "diff",
			filePath: "large.ts",
			diff: {
				lines: [{ type: "add", oldNum: null, newNum: 1, content: "x".repeat(MAX_PREVIEW_BYTES + 1) }],
				added: 1,
				removed: 0,
				chars: MAX_PREVIEW_BYTES + 1,
			},
		},
	])("bounds historical write previews: $_type", (details) => {
		expect(readToolPreview("write", details, { path: "large.ts" })).toStrictEqual({
			version: 1,
			changes: [],
			omittedChanges: 1,
		});
	});

	it("preserves incomplete capture separately from known omission counts", () => {
		const details = { version: 1, changes: [], omittedChanges: 0, incomplete: true };
		expect(readPreviewDetails(JSON.parse(JSON.stringify(details)))).toStrictEqual(details);
	});

	it("reports oversized capture explicitly", () => {
		expect(writePreviewDetails("large.txt", "old", "x".repeat(MAX_PREVIEW_BYTES + 1))).toStrictEqual({
			version: 1,
			changes: [],
			omittedChanges: 1,
		});
	});

	it("distinguishes unchanged files from new empty files", () => {
		expect(writePreviewDetails("a", "", "")).toStrictEqual({
			version: 1,
			changes: [{ kind: "unchanged", filePath: "a" }],
			omittedChanges: 0,
		});
		expect(writePreviewDetails("a", null, "")).toStrictEqual({
			version: 1,
			changes: [{ kind: "new", filePath: "a", content: "", omittedLines: 0 }],
			omittedChanges: 0,
		});
	});
});
