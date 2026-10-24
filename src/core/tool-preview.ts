import { Buffer } from "node:buffer";
import { type DiffLine, type HunkMeta, type ParsedDiff, parseDiff, parsePatchFiles } from "./diff.js";

export const MAX_PREVIEW_BYTES = 256 * 1024;
export const MAX_PREVIEW_CHANGES = 64;
export const MAX_PREVIEW_DETAILS_BYTES = 1024 * 1024;

export type FilePreview =
	| { kind: "diff"; filePath: string; diff: ParsedDiff; omittedLines: number }
	| { kind: "new"; filePath: string; content: string; omittedLines: number }
	| { kind: "unchanged"; filePath: string };

export function previewLines(content: string): string[] {
	if (!content) return [];
	const lines = content.split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines;
}

export interface ToolPreviewDetails {
	version: 1;
	changes: FilePreview[];
	omittedChanges: number;
	incomplete?: true;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function serialisedBytes(value: unknown): number {
	try {
		return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

function readHunkMeta(value: unknown): HunkMeta | undefined {
	if (!isRecord(value)) return undefined;
	const { oldStart, oldLines, newStart, newLines, context } = value;
	if (!isCount(oldStart) || !isCount(oldLines) || !isCount(newStart) || !isCount(newLines)) return undefined;
	if (context !== undefined && typeof context !== "string") return undefined;
	return { oldStart, oldLines, newStart, newLines, context };
}

function readDiffLine(value: unknown): DiffLine | undefined {
	if (!isRecord(value)) return undefined;
	const { type, oldNum, newNum, content } = value;
	if (type !== "add" && type !== "del" && type !== "ctx" && type !== "sep") return undefined;
	if (oldNum !== null && !isCount(oldNum)) return undefined;
	if (newNum !== null && !isCount(newNum)) return undefined;
	if (typeof content !== "string") return undefined;
	const hunkMeta = value.hunkMeta === undefined ? undefined : readHunkMeta(value.hunkMeta);
	if (value.hunkMeta !== undefined && hunkMeta === undefined) return undefined;
	const line: DiffLine = { type, oldNum, newNum, content };
	if (hunkMeta) line.hunkMeta = hunkMeta;
	return line;
}

function readDiff(value: unknown): ParsedDiff | undefined {
	if (!isRecord(value) || !Array.isArray(value.lines)) return undefined;
	if (!isCount(value.added) || !isCount(value.removed) || !isCount(value.chars)) return undefined;
	const lines: DiffLine[] = [];
	for (const item of value.lines) {
		const line = readDiffLine(item);
		if (!line) return undefined;
		lines.push(line);
	}
	return { lines, added: value.added, removed: value.removed, chars: value.chars };
}

function readFilePreview(value: unknown): FilePreview | undefined {
	if (!isRecord(value) || typeof value.filePath !== "string") return undefined;
	if (serialisedBytes(value) > MAX_PREVIEW_BYTES) return undefined;
	const { filePath } = value;
	if (value.kind === "unchanged") return { kind: "unchanged", filePath };
	if (!isCount(value.omittedLines)) return undefined;
	if (value.kind === "new" && typeof value.content === "string") {
		return { kind: "new", filePath, content: value.content, omittedLines: value.omittedLines };
	}
	if (value.kind !== "diff") return undefined;
	const diff = readDiff(value.diff);
	return diff ? { kind: "diff", filePath, diff, omittedLines: value.omittedLines } : undefined;
}

export function readPreviewDetails(value: unknown): ToolPreviewDetails | undefined {
	if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.changes)) return undefined;
	if (!isCount(value.omittedChanges) || value.changes.length > MAX_PREVIEW_CHANGES) return undefined;
	if (value.incomplete !== undefined && value.incomplete !== true) return undefined;
	if (serialisedBytes(value) > MAX_PREVIEW_DETAILS_BYTES) return undefined;
	const changes: FilePreview[] = [];
	for (const item of value.changes) {
		const change = readFilePreview(item);
		if (!change) return undefined;
		changes.push(change);
	}
	const details: ToolPreviewDetails = { version: 1, changes, omittedChanges: value.omittedChanges };
	if (value.incomplete) details.incomplete = true;
	return details;
}

function singlePreview(preview: FilePreview): ToolPreviewDetails {
	if (serialisedBytes(preview) > MAX_PREVIEW_BYTES) return omittedPreview();
	return { version: 1, changes: [preview], omittedChanges: 0 };
}

export function omittedPreview(): ToolPreviewDetails {
	return { version: 1, changes: [], omittedChanges: 1 };
}

export function writePreviewDetails(filePath: string, oldContent: string | null, content: string): ToolPreviewDetails {
	if (Buffer.byteLength(content, "utf8") + Buffer.byteLength(oldContent ?? "", "utf8") > MAX_PREVIEW_BYTES) {
		return omittedPreview();
	}
	if (oldContent === null) return singlePreview({ kind: "new", filePath, content, omittedLines: 0 });
	if (oldContent === content) return singlePreview({ kind: "unchanged", filePath });
	return singlePreview({ kind: "diff", filePath, diff: parseDiff(oldContent, content, 3), omittedLines: 0 });
}

function readLegacyWritePreview(details: Record<string, unknown>, args: unknown): ToolPreviewDetails | undefined {
	if (details._type === "noChange") {
		if (!isRecord(args) || typeof args.path !== "string") return undefined;
		return singlePreview({ kind: "unchanged", filePath: args.path });
	}
	if (details._type !== "diff" && details._type !== "new") return undefined;
	const candidate =
		details._type === "diff"
			? { kind: "diff", filePath: details.filePath, diff: details.diff, omittedLines: 0 }
			: { kind: "new", filePath: details.filePath, content: details.content, omittedLines: 0 };
	if (serialisedBytes(candidate) > MAX_PREVIEW_BYTES) return omittedPreview();
	const preview = readFilePreview(candidate);
	return preview ? singlePreview(preview) : undefined;
}

export function readToolPreview(name: string, details: unknown, args: unknown): ToolPreviewDetails | undefined {
	if (!isRecord(details)) return undefined;
	const saved = readPreviewDetails(details.piDiff);
	if (saved) return saved;
	if (name === "write") return readLegacyWritePreview(details, args);
	if (name !== "edit" || typeof details.patch !== "string" || !isRecord(args)) return undefined;
	if (typeof args.path !== "string") return undefined;
	if (Buffer.byteLength(details.patch, "utf8") > MAX_PREVIEW_BYTES) return omittedPreview();
	const diff = parsePatchFiles(details.patch)[0];
	return diff ? singlePreview({ kind: "diff", filePath: args.path, diff, omittedLines: 0 }) : undefined;
}
