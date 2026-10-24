import type { Theme, ToolRenderers, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { type Component, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { COLLAPSED_EXPAND_LABEL } from "../collapsed-hint.js";
import type { ParsedDiff } from "../core/diff.js";
import { type FilePreview, isRecord, readToolPreview, type ToolPreviewDetails } from "../core/tool-preview.js";
import { lang, renderSplit, resolveDiffColors, themeCacheKey } from "../review/hunk-preview.js";

export type ResultRenderContext = Parameters<NonNullable<ToolRenderers["renderResult"]>>[3];
type ComponentSlots = WeakMap<object, Map<string, PreviewText>>;

class PreviewText extends Text {
	private viewKey = "";
	private revision = 0;
	private width: number | undefined;
	private immediate: (width: number, pending: boolean) => string = () => "";
	private task: ((width: number, isCurrent: () => boolean) => Promise<string>) | undefined;
	private redraw: () => void = () => {};

	constructor() {
		super("", 0, 0);
	}

	setView(
		key: string,
		immediate: (width: number, pending: boolean) => string,
		redraw: () => void,
		task?: (width: number, isCurrent: () => boolean) => Promise<string>,
	): void {
		this.redraw = redraw;
		if (this.viewKey === key) return;
		this.viewKey = key;
		this.revision++;
		this.width = undefined;
		this.immediate = immediate;
		this.task = task;
	}

	override render(width: number): string[] {
		const renderWidth = Math.max(1, Math.floor(width));
		if (this.width !== renderWidth) {
			this.width = renderWidth;
			const revision = ++this.revision;
			this.setText(this.immediate(renderWidth, this.task !== undefined));
			if (this.task) {
				Promise.resolve(this.task(renderWidth, () => this.revision === revision))
					.then((rendered) => {
						if (this.revision !== revision) return;
						this.setText(rendered);
						this.redraw();
					})
					.catch(() => {
						if (this.revision !== revision) return;
						this.setText(this.immediate(renderWidth, false));
						this.redraw();
					});
			}
		}
		return super.render(renderWidth);
	}
}

function componentFor(slots: ComponentSlots, context: ResultRenderContext): PreviewText {
	// Keep composition state outside context.state and never adopt another renderer's lastComponent.
	const state: object = isRecord(context.state) ? context.state : context;
	let rows = slots.get(state);
	if (!rows) {
		rows = new Map();
		slots.set(state, rows);
	}
	let component = rows.get(context.toolCallId);
	if (!component) {
		component = new PreviewText();
		rows.set(context.toolCallId, component);
	}
	return component;
}

function fitLine(line: string, width: number): string {
	return visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line;
}

function omitted(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"} omitted from capture`;
}

function newFileDiff(content: string): ParsedDiff {
	const source = content ? content.split("\n") : [];
	return {
		lines: source.map((line, index) => ({ type: "add", oldNum: null, newNum: index + 1, content: line })),
		added: source.length,
		removed: 0,
		chars: content.length,
	};
}

function summary(change: FilePreview, theme: Theme): string {
	const path = theme.fg("toolTitle", change.filePath);
	if (change.kind === "unchanged") return `${path} ${theme.fg("muted", "unchanged")}`;
	if (change.kind === "new") {
		const count = change.content ? change.content.split("\n").length : 0;
		return `${path} ${theme.fg("success", `new file (${count} lines)`)}`;
	}
	return `${path} ${theme.fg("toolDiffAdded", `+${change.diff.added}`)} ${theme.fg("toolDiffRemoved", `-${change.diff.removed}`)}`;
}

function summaryLines(previews: ToolPreviewDetails, theme: Theme, width: number): string[] {
	const output: string[] = [];
	for (const change of previews.changes) {
		output.push(fitLine(summary(change, theme), width));
		if (change.kind !== "unchanged" && change.omittedLines) {
			output.push(theme.fg("muted", omitted(change.omittedLines, "line")));
		}
	}
	if (previews.omittedChanges) output.push(theme.fg("muted", omitted(previews.omittedChanges, "change")));
	if (previews.incomplete) output.push(theme.fg("warning", "Preview capture incomplete"));
	return output;
}

async function expandedChanges(
	previews: ToolPreviewDetails,
	theme: Theme,
	width: number,
	isCurrent: () => boolean,
): Promise<string> {
	const output: string[] = [];
	for (const change of previews.changes) {
		if (!isCurrent()) return "";
		output.push(fitLine(summary(change, theme), width));
		if (change.kind !== "unchanged") {
			const diff = change.kind === "new" ? newFileDiff(change.content) : change.diff;
			if (diff.lines.length) {
				try {
					const body = await renderSplit(
						diff,
						lang(change.filePath),
						diff.lines.length,
						resolveDiffColors(theme),
						width,
						{ compactGutter: true },
					);
					for (const line of body.split("\n")) output.push(fitLine(line, width));
				} catch {
					for (const line of diff.lines) {
						output.push(`${line.type === "add" ? "+" : line.type === "del" ? "-" : " "} ${line.content}`);
					}
				}
			}
			if (change.omittedLines) output.push(theme.fg("muted", omitted(change.omittedLines, "line")));
		}
	}
	if (previews.omittedChanges) output.push(theme.fg("muted", omitted(previews.omittedChanges, "change")));
	if (previews.incomplete) output.push(theme.fg("warning", "Preview capture incomplete"));
	return output.join("\n");
}

function setPreviewChanges(
	component: PreviewText,
	previews: ToolPreviewDetails,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ResultRenderContext,
): Component {
	const key = JSON.stringify([
		previews,
		options,
		themeCacheKey(theme),
		previews.incomplete ? theme.fg("warning", "Preview capture incomplete") : "",
	]);
	component.setView(
		key,
		(width, pending) => {
			const output = summaryLines(previews, theme, width);
			if (pending && previews.changes.some((change) => change.kind !== "unchanged")) {
				output.push(theme.fg("muted", "rendering preview…"));
			} else if (!options.expanded && previews.changes.some((change) => change.kind !== "unchanged")) {
				output.push(theme.fg("muted", COLLAPSED_EXPAND_LABEL));
			}
			return output.join("\n");
		},
		context.invalidate,
		options.expanded ? (width, isCurrent) => expandedChanges(previews, theme, width, isCurrent) : undefined,
	);
	return component;
}

const previewSlots: ComponentSlots = new WeakMap();

export function renderPreviewChanges(
	previews: ToolPreviewDetails,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ResultRenderContext,
): Component {
	return setPreviewChanges(componentFor(previewSlots, context), previews, options, theme, context);
}

export function createToolRenderers(name: "edit" | "write"): ToolRenderers {
	const callSlots: ComponentSlots = new WeakMap();
	const resultSlots: ComponentSlots = new WeakMap();
	return {
		renderShell: "default",
		renderCall(args, theme, context) {
			const component = componentFor(callSlots, context);
			const path = isRecord(args) && typeof args.path === "string" ? args.path : "";
			const title = `${theme.fg("toolTitle", theme.bold(`← ${name}`))} ${theme.fg("toolTitle", path)}`;
			component.setView(
				JSON.stringify([title, themeCacheKey(theme)]),
				(width) => fitLine(title, width),
				context.invalidate,
			);
			return component;
		},
		renderResult(result, options, theme, context) {
			const component = componentFor(resultSlots, context);
			const isError = context.isError || (isRecord(result) && result.isError === true);
			const nativeText = result.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			if (!isError) {
				const previews = readToolPreview(name, result.details, context.args);
				if (previews) return setPreviewChanges(component, previews, options, theme, context);
			}
			const output = isError ? theme.fg("error", nativeText || "Error") : nativeText;
			component.setView(JSON.stringify([isError, output, themeCacheKey(theme)]), () => output, context.invalidate);
			return component;
		},
	};
}
