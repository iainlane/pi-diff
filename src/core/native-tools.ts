import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import {
	createEditToolDefinition,
	createWriteToolDefinition,
	type ToolDefinition,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { isRecord, omittedPreview, type ToolPreviewDetails, writePreviewDetails } from "./tool-preview.js";

export interface WriteCaptureOperations extends WriteOperations {
	readFile: (absolutePath: string) => Promise<string>;
}

const localWriteOperations: WriteCaptureOperations = {
	readFile: (filePath) => readFile(filePath, "utf8"),
	writeFile: (filePath, content) => writeFile(filePath, content, "utf8"),
	mkdir: (directory) => mkdir(directory, { recursive: true }).then(() => {}),
};

type NativeWriteDefinition = ToolDefinition<
	ReturnType<typeof createWriteToolDefinition>["parameters"],
	{ piDiff: ToolPreviewDetails } | undefined
>;

export function createNativeWriteTool(
	cwd: string,
	operations: WriteCaptureOperations = localWriteOperations,
): NativeWriteDefinition {
	const native = createWriteToolDefinition(cwd);
	const renderResult = native.renderResult;
	return {
		...native,
		renderResult: renderResult
			? (result, ...args) => renderResult({ ...result, details: undefined }, ...args)
			: undefined,
		async execute(...args: Parameters<NativeWriteDefinition["execute"]>) {
			const [, params, signal] = args;
			let before: string | null | undefined;
			const tool = createWriteToolDefinition(cwd, {
				operations: {
					mkdir: operations.mkdir,
					writeFile: async (absolutePath, content) => {
						try {
							before = await operations.readFile(absolutePath);
						} catch (error) {
							before = isRecord(error) && error.code === "ENOENT" ? null : undefined;
						}
						if (signal?.aborted) throw new Error("Operation aborted");
						await operations.writeFile(absolutePath, content);
					},
				},
			});
			const result = await tool.execute(...args);
			return {
				...result,
				details: {
					piDiff: before === undefined ? omittedPreview() : writePreviewDetails(params.path, before, params.content),
				},
			};
		},
	};
}

function normaliseMatchText(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.normalize("NFKC")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
		.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
		.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
		.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

function rejectAmbiguousMatches(content: string, filePath: string, edits: Array<{ oldText: string }>): void {
	const normalised = normaliseMatchText(content.replace(/^\uFEFF/, ""));
	for (const [index, edit] of edits.entries()) {
		const oldText = normaliseMatchText(edit.oldText);
		if (!oldText) continue;
		const first = normalised.indexOf(oldText);
		if (first !== -1 && normalised.includes(oldText, first + 1)) {
			throw new Error(
				`Found ambiguous overlapping occurrences for edits[${index}] in ${filePath}. Provide more context to make oldText unique.`,
			);
		}
	}
}

export function createNativeEditTool(cwd: string): ReturnType<typeof createEditToolDefinition> {
	const native = createEditToolDefinition(cwd);
	return {
		...native,
		async execute(...args: Parameters<typeof native.execute>) {
			const [, params] = args;
			const tool = createEditToolDefinition(cwd, {
				operations: {
					access: (filePath) => access(filePath, constants.R_OK | constants.W_OK),
					readFile: async (filePath) => {
						const buffer = await readFile(filePath);
						rejectAmbiguousMatches(buffer.toString("utf8"), params.path, params.edits);
						return buffer;
					},
					writeFile: (filePath, content) => writeFile(filePath, content, "utf8"),
				},
			});
			return tool.execute(...args);
		},
	};
}
