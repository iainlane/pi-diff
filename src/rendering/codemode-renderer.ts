import type { Theme, ToolRendererResolver } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Spacer, Text } from "@earendil-works/pi-tui";
import { COLLAPSED_EXPAND_LABEL } from "../collapsed-hint.js";
import {
	type FilePreview,
	isRecord,
	previewLines,
	readPreviewDetails,
	type ToolPreviewDetails,
} from "../core/tool-preview.js";
import { type ResultRenderContext, renderPreviewChanges } from "./tool-renderers.js";

interface ResultSlot {
	component: Container;
	baseComponent?: Component;
	previewState: object;
}

function countLabel(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function groupedChanges(previews: ToolPreviewDetails): ToolPreviewDetails {
	const files = new Map<string, FilePreview[]>();
	for (const change of previews.changes) {
		const operations = files.get(change.filePath) ?? [];
		operations.push(change);
		files.set(change.filePath, operations);
	}
	return { ...previews, changes: [...files.values()].flat() };
}

function compactSummary(previews: ToolPreviewDetails, theme: Theme): Component {
	const files = new Set<string>();
	let added = 0;
	let removed = 0;
	let omittedLines = 0;
	for (const change of previews.changes) {
		files.add(change.filePath);
		if (change.kind === "unchanged") continue;
		omittedLines += change.omittedLines;
		if (change.kind === "diff") {
			added += change.diff.added;
			removed += change.diff.removed;
		} else {
			added += previewLines(change.content).length;
		}
	}
	const summary = `${countLabel(files.size, "file")}, ${countLabel(previews.changes.length, "operation")}`;
	const output = [
		`${theme.fg("toolTitle", `File changes: ${summary}`)} ${theme.fg("toolDiffAdded", `+${added}`)} ${theme.fg("toolDiffRemoved", `-${removed}`)}`,
	];
	if (omittedLines) output.push(theme.fg("muted", `${countLabel(omittedLines, "line")} omitted from capture`));
	if (previews.omittedChanges) {
		output.push(theme.fg("muted", `${countLabel(previews.omittedChanges, "change")} omitted from capture`));
	}
	if (previews.incomplete) output.push(theme.fg("warning", "capture incomplete"));
	if (previews.changes.length) output.push(theme.fg("muted", COLLAPSED_EXPAND_LABEL));
	return new Text(output.join("\n"), 0, 0);
}

export function createCodemodeRendererResolver(): ToolRendererResolver {
	const slots = new WeakMap<object, Map<string, ResultSlot>>();
	const slotFor = (context: ResultRenderContext): ResultSlot => {
		const state: object = isRecord(context.state) ? context.state : context;
		let rows = slots.get(state);
		if (!rows) {
			rows = new Map();
			slots.set(state, rows);
		}
		let slot = rows.get(context.toolCallId);
		if (!slot) {
			slot = { component: new Container(), previewState: {} };
			rows.set(context.toolCallId, slot);
		}
		return slot;
	};

	return (toolName, next) => {
		const base = next();
		if (toolName !== "codemode" || !base?.renderResult) return base;
		const renderBaseResult = base.renderResult;
		return {
			...base,
			renderResult(result, options, theme, context) {
				const slot = slotFor(context);
				slot.baseComponent = renderBaseResult.call(base, result, options, theme, {
					...context,
					lastComponent: slot.baseComponent,
				});
				const previews = isRecord(result.details) ? readPreviewDetails(result.details.piDiff) : undefined;
				// Update the shared view even while hidden to invalidate outstanding expanded work.
				const preview = renderPreviewChanges(
					groupedChanges(previews ?? { version: 1, changes: [], omittedChanges: 0 }),
					previews ? options : { ...options, expanded: false },
					theme,
					{ ...context, state: slot.previewState, lastComponent: undefined },
				);
				slot.component.clear();
				slot.component.addChild(slot.baseComponent);
				if (previews && (previews.changes.length || previews.omittedChanges || previews.incomplete)) {
					slot.component.addChild(new Spacer(1));
					slot.component.addChild(options.expanded ? preview : compactSummary(previews, theme));
				}
				return slot.component;
			},
		};
	};
}
