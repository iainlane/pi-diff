import { Buffer } from "node:buffer";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	isRecord,
	MAX_PREVIEW_CHANGES,
	MAX_PREVIEW_DETAILS_BYTES,
	readToolPreview,
	type ToolPreviewDetails,
} from "./tool-preview.js";

const MAX_PENDING_PARENTS = 64;
const MAX_PARENT_ID_BYTES = 4096;
const MAX_PENDING_BYTES = 8 * MAX_PREVIEW_DETAILS_BYTES;

function addOmissions(current: number, count: number): number {
	return Math.min(Number.MAX_SAFE_INTEGER, current + count);
}

// Reserve counter growth so reporting omissions cannot exceed the serialization budget.
function retainedBytes(preview: ToolPreviewDetails): number {
	return Buffer.byteLength(JSON.stringify({ ...preview, omittedChanges: Number.MAX_SAFE_INTEGER }), "utf8");
}

export function registerCodemodePreviews(
	pi: ExtensionAPI,
	options: { disabledTools?: readonly ("edit" | "write")[] } = {},
): void {
	const disabledTools = new Set(options.disabledTools);
	const pending = new Map<string, { preview: ToolPreviewDetails; bytes: number }>();
	let pendingBytes = 0;
	let trackingOverflowed = false;

	const clear = () => {
		pending.clear();
		pendingBytes = 0;
		trackingOverflowed = false;
	};

	pi.on("tool_result", (event) => {
		const collected = pending.get(event.toolCallId);
		if (collected) {
			pending.delete(event.toolCallId);
			pendingBytes -= collected.bytes;
		}

		if (event.toolName === "codemode") {
			// An untracked parent after overflow may have lost changes. Mark that loss
			// without retaining an unbounded second map of discarded parent identifiers.
			const preview =
				collected?.preview ??
				(trackingOverflowed ? { version: 1 as const, changes: [], omittedChanges: 1 } : undefined);
			if (!preview) return;
			return { details: { ...(isRecord(event.details) ? event.details : {}), piDiff: preview } };
		}

		if (
			event.isError ||
			event.parentToolCallId === undefined ||
			(event.toolName !== "edit" && event.toolName !== "write") ||
			disabledTools.has(event.toolName)
		)
			return;
		const incoming = readToolPreview(event.toolName, event.details, event.input);
		if (!incoming || (incoming.changes.length === 0 && incoming.omittedChanges === 0)) return;

		const parentId = event.parentToolCallId;
		let parent = pending.get(parentId);
		if (!parent) {
			if (pending.size >= MAX_PENDING_PARENTS || Buffer.byteLength(parentId, "utf8") > MAX_PARENT_ID_BYTES) {
				trackingOverflowed = true;
				return;
			}
			const preview: ToolPreviewDetails = {
				version: 1,
				changes: [],
				omittedChanges: trackingOverflowed ? 1 : 0,
			};
			parent = { preview, bytes: retainedBytes(preview) };
			pending.set(parentId, parent);
			pendingBytes += parent.bytes;
		}

		parent.preview.omittedChanges = addOmissions(parent.preview.omittedChanges, incoming.omittedChanges);
		for (const change of incoming.changes) {
			if (parent.preview.changes.length >= MAX_PREVIEW_CHANGES) {
				parent.preview.omittedChanges = addOmissions(parent.preview.omittedChanges, 1);
				continue;
			}
			const candidate: ToolPreviewDetails = { ...parent.preview, changes: [...parent.preview.changes, change] };
			const bytes = retainedBytes(candidate);
			if (bytes > MAX_PREVIEW_DETAILS_BYTES || pendingBytes - parent.bytes + bytes > MAX_PENDING_BYTES) {
				parent.preview.omittedChanges = addOmissions(parent.preview.omittedChanges, 1);
				continue;
			}
			pendingBytes += bytes - parent.bytes;
			parent.preview = candidate;
			parent.bytes = bytes;
		}
	});

	pi.on("session_start", clear);
	pi.on("session_shutdown", clear);
	pi.on("session_tree", clear);
	pi.on("agent_end", clear);
}
