import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, type Component, stripTerminalSequences, Text, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseDiff } from "../core/diff.js";
import type { ToolPreviewDetails } from "../core/tool-preview.js";
import * as hunkPreview from "../review/hunk-preview.js";
import { createToolRenderers, type ResultRenderContext, renderPreviewChanges } from "./tool-renderers.js";

vi.mock("../review/hunk-preview.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../review/hunk-preview.js")>();
	return { ...actual, renderSplit: vi.fn(actual.renderSplit) };
});

const theme = {
	fg: (_name: string, text: string) => text,
	bg: (_name: string, text: string) => text,
	bold: (text: string) => text,
	getFgAnsi: () => "\x1b[38;2;100;180;120m",
	getBgAnsi: () => "\x1b[48;2;10;10;10m",
} as unknown as Theme;
const options = { expanded: false, isPartial: false };
function context(overrides: Partial<ResultRenderContext> = {}): ResultRenderContext {
	return {
		args: { path: "file.ts" },
		toolCallId: "call",
		invalidate: vi.fn(),
		lastComponent: undefined,
		state: {},
		cwd: "/tmp",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		durationMs: undefined,
		outputPad: 1,
		...overrides,
	};
}
function preview(old = "old();", next = "new();"): ToolPreviewDetails {
	return {
		version: 1,
		changes: [{ kind: "diff", filePath: "file.ts", diff: parseDiff(old, next), omittedLines: 0 }],
		omittedChanges: 0,
	};
}
function lines(component: Component, width = 100): string[] {
	return component.render(width).map(stripTerminalSequences);
}
async function settled(component: Component, width = 100): Promise<string[]> {
	component.render(width);
	await vi.waitFor(() => expect(lines(component, width).join("\n")).not.toContain("rendering"));
	return lines(component, width);
}
function deferred() {
	let resolve!: (value: string) => void;
	const promise = new Promise<string>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
afterEach(() => vi.mocked(hunkPreview.renderSplit).mockClear());

describe("native tool renderers", () => {
	it.each(["edit", "write"] as const)("renders %s with the native default shell and path", (name) => {
		const renderers = createToolRenderers(name);
		expect(renderers.renderShell).toBe("default");
		const call = renderers.renderCall?.({ path: "src/文件.ts" }, theme, context());
		expect(lines(call as Component)[0].trimEnd()).toBe(`← ${name} src/文件.ts`);
	});

	it.each(["edit", "write"] as const)("renders collapsed %s stats without changing metadata", (name) => {
		const data = preview();
		const result = { content: [{ type: "text" as const, text: "native output" }], details: { piDiff: data, other: 1 } };
		const before = structuredClone(result);
		const rendered = createToolRenderers(name).renderResult?.(result, options, theme, context());
		expect(lines(rendered as Component).join("\n")).toContain("file.ts +1 -1");
		expect(lines(rendered as Component).join("\n")).toContain("ctrl+o to expand");
		expect(hunkPreview.renderSplit).not.toHaveBeenCalled();
		expect(result).toEqual(before);
	});

	it("reads actual native edit patches from context.args", async () => {
		const result = { content: [], details: { patch: "@@ -1 +1 @@\n-real old\n+real new\n" } };
		const component = createToolRenderers("edit").renderResult?.(
			result,
			{ ...options, expanded: true },
			theme,
			context({ args: { path: "actual.txt", newText: "not the result" } }),
		);
		const output = (await settled(component as Component)).join("\n");
		expect(output).toContain("actual.txt");
		expect(output).toContain("real new");
		expect(output).not.toContain("not the result");
	});

	it.each(["edit", "write"] as const)("keeps complete %s errors including later text blocks", (name) => {
		const message = `failure ${"detail ".repeat(60)}`;
		const result = {
			content: [
				{ type: "text" as const, text: message },
				{ type: "text" as const, text: "last diagnostic" },
			],
			details: { piDiff: preview() },
			isError: true,
		};
		const component = createToolRenderers(name).renderResult?.(result, options, theme, context());
		const output = lines(component as Component, 1000).join("\n");
		expect(output).toContain(message);
		expect(output).toContain("last diagnostic");
		expect(output).not.toContain("ctrl+o");
	});

	it("honors the context error flag and preserves fallback native output", () => {
		const renderers = createToolRenderers("write");
		const result = { content: [{ type: "text" as const, text: "native diagnostic" }], details: undefined };
		expect(
			lines(renderers.renderResult?.(result, options, theme, context({ isError: true })) as Component).join("\n"),
		).toContain("native diagnostic");
		expect(lines(renderers.renderResult?.(result, options, theme, context()) as Component).join("\n")).toContain(
			"native diagnostic",
		);
	});
});

describe("shared preview changes", () => {
	it.each([52, 140])("renders all captured hunks at width %s with shared layout selection", async (width) => {
		const old = Array.from({ length: 100 }, (_, i) => `old${i}`).join("\n");
		const next = old.replaceAll("old", "new");
		const data = preview(old, next);
		const component = renderPreviewChanges(data, { ...options, expanded: true }, theme, context());
		const output = await settled(component, width);
		expect(output.join("\n")).toContain("new99");
		expect(output.join("\n")).not.toContain("more lines");
		expect(hunkPreview.renderSplit).toHaveBeenCalledWith(
			data.changes[0].kind === "diff" ? data.changes[0].diff : undefined,
			"typescript",
			201,
			expect.anything(),
			width,
			{ compactGutter: true },
		);
		expect(output.every((line) => visibleWidth(line) <= width)).toBe(true);
		expect(output.filter((line) => line.includes("old99") && line.includes("new99"))).toHaveLength(width >= 80 ? 1 : 0);
	});

	it("renders new, empty and unchanged files plus explicit capture omissions", async () => {
		const data: ToolPreviewDetails = {
			version: 1,
			changes: [
				{ kind: "new", filePath: "new.txt", content: "first\nlast", omittedLines: 7 },
				{ kind: "new", filePath: "empty.txt", content: "", omittedLines: 0 },
				{ kind: "unchanged", filePath: "same.txt" },
			],
			omittedChanges: 2,
		};
		const output = (await settled(renderPreviewChanges(data, { ...options, expanded: true }, theme, context()))).join(
			"\n",
		);
		expect(output).toContain("new.txt");
		expect(output).toContain("last");
		expect(output).toContain("empty.txt");
		expect(output).toContain("same.txt unchanged");
		expect(output).toContain("7 lines omitted from capture");
		expect(output).toContain("2 changes omitted from capture");
	});

	it("shows omission notices even when collapsed", () => {
		const data = preview();
		if (data.changes[0].kind === "diff") data.changes[0].omittedLines = 3;
		data.omittedChanges = 1;
		const output = lines(renderPreviewChanges(data, options, theme, context())).join("\n");
		expect(output).toContain("3 lines omitted from capture");
		expect(output).toContain("1 change omitted from capture");
	});

	it.each([0, 1])("leaves outputPad=%s to the host shell", async (outputPad) => {
		const component = renderPreviewChanges(preview(), { ...options, expanded: true }, theme, context({ outputPad }));
		await settled(component, 100 - outputPad * 2);
		const box = new Box(outputPad, 1);
		box.addChild(component);
		const output = box.render(100).map(stripTerminalSequences);
		expect(output[1].match(/^ */)?.[0].length).toBe(outputPad);
		expect(output.every((line) => visibleWidth(line) <= 100)).toBe(true);
	});

	it("uses visible widths for narrow Unicode paths", async () => {
		const data: ToolPreviewDetails = {
			version: 1,
			changes: [{ kind: "new", filePath: "文件".repeat(30), content: "界".repeat(50), omittedLines: 0 }],
			omittedChanges: 0,
		};
		const output = await settled(renderPreviewChanges(data, { ...options, expanded: true }, theme, context()), 24);
		expect(output.every((line) => visibleWidth(line) <= 24)).toBe(true);
	});

	it("does not mutate or reuse another renderer's component/state", () => {
		const foreign = new Text("other renderer", 0, 0);
		const state = { other: { value: 1 } };
		const ctx = context({ state, lastComponent: foreign });
		const call = createToolRenderers("edit").renderCall?.({ path: "file.ts" }, theme, ctx);
		const result = renderPreviewChanges(preview(), options, theme, ctx);
		expect(call).not.toBe(foreign);
		expect(result).not.toBe(foreign);
		expect(result).not.toBe(call);
		expect(state).toEqual({ other: { value: 1 } });
		expect(lines(foreign)[0].trimEnd()).toBe("other renderer");
	});

	it("ignores outstanding highlighting when collapsed before completion", async () => {
		const task = deferred();
		vi.mocked(hunkPreview.renderSplit).mockImplementationOnce(() => task.promise);
		const ctx = context();
		const component = renderPreviewChanges(preview(), { ...options, expanded: true }, theme, ctx);
		component.render(100);
		expect(renderPreviewChanges(preview(), options, theme, ctx)).toBe(component);
		task.resolve("stale expanded body");
		await task.promise;
		await Promise.resolve();
		expect(lines(component).join("\n")).not.toContain("stale expanded body");
		expect(ctx.invalidate).not.toHaveBeenCalled();
	});

	it.each(["width", "theme", "content"])("ignores stale completion after %s changes", async (change) => {
		const old = deferred();
		const next = deferred();
		vi.mocked(hunkPreview.renderSplit)
			.mockImplementationOnce(() => old.promise)
			.mockImplementationOnce(() => next.promise);
		const ctx = context();
		const component = renderPreviewChanges(preview(), { ...options, expanded: true }, theme, ctx);
		component.render(100);
		const nextTheme =
			change === "theme" ? ({ ...theme, fg: (_name: string, text: string) => `light:${text}` } as Theme) : theme;
		renderPreviewChanges(
			change === "content" ? preview("old();", "two();") : preview(),
			{ ...options, expanded: true },
			nextTheme,
			ctx,
		);
		component.render(change === "width" ? 80 : 100);
		next.resolve("fresh body");
		await next.promise;
		await vi.waitFor(() => expect(lines(component, change === "width" ? 80 : 100).join("\n")).toContain("fresh body"));
		old.resolve("stale body");
		await old.promise;
		await Promise.resolve();
		expect(lines(component, change === "width" ? 80 : 100).join("\n")).not.toContain("stale body");
		expect(ctx.invalidate).toHaveBeenCalledTimes(1);
	});

	it("does not run later file highlighting after an obsolete grouped preview finishes", async () => {
		const task = deferred();
		vi.mocked(hunkPreview.renderSplit).mockImplementationOnce(() => task.promise);
		const data = preview();
		data.changes.push({ kind: "new", filePath: "next.ts", content: "later", omittedLines: 0 });
		const ctx = context();
		const component = renderPreviewChanges(data, { ...options, expanded: true }, theme, ctx);
		component.render(100);
		renderPreviewChanges(data, options, theme, ctx);
		task.resolve("obsolete first file");
		await task.promise;
		await Promise.resolve();
		expect(hunkPreview.renderSplit).toHaveBeenCalledTimes(1);
		expect(lines(component).join("\n")).not.toContain("obsolete first file");
	});

	it("rejects old work after an expand-collapse-expand cycle with an identical key", async () => {
		const old = deferred();
		const next = deferred();
		vi.mocked(hunkPreview.renderSplit)
			.mockImplementationOnce(() => old.promise)
			.mockImplementationOnce(() => next.promise);
		const ctx = context();
		const component = renderPreviewChanges(preview(), { ...options, expanded: true }, theme, ctx);
		component.render(100);
		renderPreviewChanges(preview(), options, theme, ctx);
		renderPreviewChanges(preview(), { ...options, expanded: true }, theme, ctx);
		component.render(100);
		next.resolve("fresh expansion");
		await next.promise;
		await vi.waitFor(() => expect(lines(component).join("\n")).toContain("fresh expansion"));
		old.resolve("old expansion");
		await old.promise;
		await Promise.resolve();
		expect(lines(component).join("\n")).not.toContain("old expansion");
		expect(ctx.invalidate).toHaveBeenCalledTimes(1);
	});

	it("caches identical captures without restarting asynchronous rendering", async () => {
		const ctx = context();
		const component = renderPreviewChanges(preview(), { ...options, expanded: true }, theme, ctx);
		await settled(component);
		expect(renderPreviewChanges(preview(), { ...options, expanded: true }, theme, ctx)).toBe(component);
		component.render(100);
		expect(hunkPreview.renderSplit).toHaveBeenCalledTimes(1);
	});

	it("keeps separate call/result slots and cancels expanded work when a native error arrives", async () => {
		const task = deferred();
		vi.mocked(hunkPreview.renderSplit).mockImplementationOnce(() => task.promise);
		const ctx = context();
		const renderers = createToolRenderers("edit");
		const call = renderers.renderCall?.({ path: "file.ts" }, theme, ctx) as Component;
		const result = { content: [], details: { piDiff: preview() } };
		const component = renderers.renderResult?.(result, { ...options, expanded: true }, theme, ctx) as Component;
		expect(component).not.toBe(call);
		component.render(100);
		expect(
			renderers.renderResult?.(
				{ content: [{ type: "text", text: "native failure" }], details: undefined },
				options,
				theme,
				{ ...ctx, isError: true },
			),
		).toBe(component);
		task.resolve("stale success");
		await task.promise;
		await Promise.resolve();
		expect(lines(component).join("\n")).toContain("native failure");
		expect(lines(component).join("\n")).not.toContain("stale success");
		expect(lines(call)[0].trimEnd()).toBe("← edit file.ts");
		expect(ctx.invalidate).not.toHaveBeenCalled();
	});

	it("retains separate recorded operations and all distant captured hunks", async () => {
		const source = Array.from({ length: 120 }, (_, i) => `line${i}`).join("\n");
		const changed = source.replace("line1\n", "first change\n").replace("line110\n", "last change\n");
		const data = preview(source, changed);
		data.changes.push({ kind: "new", filePath: "file.ts", content: "later operation", omittedLines: 0 });
		const output = (await settled(renderPreviewChanges(data, { ...options, expanded: true }, theme, context()))).join(
			"\n",
		);
		expect(output).toContain("first change");
		expect(output).toContain("last change");
		expect(output).toContain("later operation");
		expect(hunkPreview.renderSplit).toHaveBeenCalledTimes(2);
	});

	it("keeps the shared large-input fallback and all captured new-file lines", async () => {
		const content = Array.from({ length: 1000 }, (_, i) => `row${i} ${"x".repeat(81)}`).join("\n");
		const data: ToolPreviewDetails = {
			version: 1,
			changes: [{ kind: "new", filePath: "large.ts", content, omittedLines: 0 }],
			omittedChanges: 0,
		};
		const output = (
			await settled(renderPreviewChanges(data, { ...options, expanded: true }, theme, context()), 140)
		).join("\n");
		expect(output).toContain("row999");
		expect(output).not.toContain("more lines");
		expect(hunkPreview.renderSplit).toHaveBeenCalledWith(
			expect.objectContaining({ chars: content.length }),
			"typescript",
			1000,
			expect.anything(),
			140,
			{ compactGutter: true },
		);
	});

	it.each(["dark", "light"])("uses shared theme colors for the %s palette", async (appearance) => {
		const color = appearance === "light" ? "\x1b[38;2;20;70;30m" : "\x1b[38;2;140;230;160m";
		const palette = {
			...theme,
			fg: (_name: string, text: string) => `${color}${text}\x1b[0m`,
			getFgAnsi: () => color,
			getBgAnsi: () => (appearance === "light" ? "\x1b[48;2;250;250;250m" : "\x1b[48;2;10;10;10m"),
		} as Theme;
		const component = renderPreviewChanges(preview(), { ...options, expanded: true }, palette, context());
		await settled(component);
		expect(component.render(100).join("\n")).toContain(color);
		expect(hunkPreview.renderSplit).toHaveBeenCalledWith(
			expect.anything(),
			"typescript",
			expect.any(Number),
			{ fgAdd: color, fgDel: color, fgCtx: color },
			100,
			{ compactGutter: true },
		);
	});

	it("retains readable captured content if the shared renderer rejects", async () => {
		vi.mocked(hunkPreview.renderSplit).mockRejectedValueOnce(new Error("highlight failed"));
		const output = (
			await settled(renderPreviewChanges(preview(), { ...options, expanded: true }, theme, context()))
		).join("\n");
		expect(output).toContain("new();");
	});
});
