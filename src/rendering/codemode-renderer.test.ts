import {
	createCodemodeExtension,
	type ExtensionAPI,
	type Theme,
	type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseDiff } from "../core/diff.js";
import type { ToolPreviewDetails } from "../core/tool-preview.js";
import * as hunkPreview from "../review/hunk-preview.js";
import { createCodemodeRendererResolver } from "./codemode-renderer.js";
import type { ResultRenderContext } from "./tool-renderers.js";

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
		args: { code: "await tools.edit({path: 'a.ts'});" },
		toolCallId: "parent",
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
function preview(): ToolPreviewDetails {
	return {
		version: 1,
		changes: [
			{ kind: "diff", filePath: "a.ts", diff: parseDiff("old", "first"), omittedLines: 0 },
			{ kind: "new", filePath: "b.ts", content: "second", omittedLines: 0 },
			{ kind: "diff", filePath: "a.ts", diff: parseDiff("first", "last"), omittedLines: 0 },
		],
		omittedChanges: 0,
	};
}
function result(data: unknown = preview(), content: string[] = []) {
	return { content: content.map((text) => ({ type: "text" as const, text })), details: { calls: [], piDiff: data } };
}
function lines(component: Component, width = 150) {
	return component.render(width).map(stripTerminalSequences).join("\n");
}
function baseRenderers() {
	return {
		renderShell: "self",
		renderCall: vi.fn(() => new Text("base script", 0, 0)),
		renderResult: vi.fn<NonNullable<ToolRenderers["renderResult"]>>((result, _options, _theme, ctx) => {
			const component = (ctx.lastComponent as Container | undefined) ?? new Container();
			component.clear();
			component.addChild(
				new Text(
					result.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n"),
					0,
					0,
				),
			);
			return component;
		}),
	} satisfies ToolRenderers;
}
function renderer(base: ToolRenderers = baseRenderers()) {
	return createCodemodeRendererResolver()("codemode", () => base) as ToolRenderers;
}
async function settled(component: Component) {
	component.render(150);
	await vi.waitFor(() => expect(lines(component)).not.toContain("rendering preview"));
	return lines(component);
}
function deferred() {
	let resolve!: (value: string) => void;
	const promise = new Promise<string>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
afterEach(() => vi.mocked(hunkPreview.renderSplit).mockReset());

describe("composed codemode renderer", () => {
	it.each([
		{ content: "", added: 0 },
		{ content: "a", added: 1 },
		{ content: "a\n", added: 1 },
		{ content: "a\n\n", added: 2 },
	])("counts actual additions in new-file summaries for $content", ({ content, added }) => {
		const data: ToolPreviewDetails = {
			version: 1,
			changes: [{ kind: "new", filePath: "new.txt", content, omittedLines: 0 }],
			omittedChanges: 0,
		};
		const component = renderer().renderResult?.(result(data), options, theme, context());
		expect(
			lines(component as Component)
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean),
		).toStrictEqual([`File changes: 1 file, 1 operation +${added} -0`, "ctrl+o to expand"]);
	});
	it("delegates unrelated tools and leaves unavailable/default base result rendering alone", () => {
		const resolver = createCodemodeRendererResolver();
		const base = baseRenderers();
		const next = vi.fn(() => base);
		expect(resolver("edit", next)).toBe(base);
		expect(next).toHaveBeenCalledTimes(1);
		expect(resolver("codemode", () => undefined)).toBeUndefined();
		const callOnly = { renderCall: base.renderCall };
		expect(resolver("codemode", () => callOnly)).toBe(callOnly);
	});

	it("preserves base shell, call rendering, and full native results without modifying arguments", () => {
		const base = baseRenderers();
		const composed = renderer(base);
		const ctx = context();
		const native = result(preview(), ["first script output", "last diagnostic"]);
		const before = structuredClone(native);
		expect(composed.renderShell).toBe("self");
		expect(composed.renderCall).toBe(base.renderCall);
		const output = lines(composed.renderResult?.(native, options, theme, ctx) as Component);
		expect(output).toContain("first script output");
		expect(output).toContain("last diagnostic");
		expect(base.renderResult).toHaveBeenCalledWith(
			native,
			options,
			theme,
			expect.objectContaining({ state: ctx.state }),
		);
		expect(native).toStrictEqual(before);
	});

	it("composes the SDK's native codemode renderer with full call summaries, output, and errors", async () => {
		const registered: ToolRenderers[] = [];
		await createCodemodeExtension()({
			registerTool: (tool: ToolRenderers) => registered.push(tool),
		} as unknown as ExtensionAPI);
		const base = registered[0];
		const composed = renderer(base);
		const ctx = context({ expanded: true, isError: true });
		const native = {
			content: [
				{ type: "text" as const, text: "Script failed\nWall time 0.1 seconds\nOutput:\n" },
				{ type: "text" as const, text: "first native output\nlast native diagnostic" },
			],
			details: {
				calls: [
					{ name: "edit", args: "a.ts", status: "ok", durationMs: 5 },
					{ name: "bash", args: "fail", status: "error", error: "nested failure detail", durationMs: 6 },
				],
				piDiff: preview(),
			},
		};
		const script = composed.renderCall?.(ctx.args, theme, ctx) as Component;
		expect(lines(script)).toContain("await tools.edit");
		const component = composed.renderResult?.(native, { ...options, expanded: true }, theme, ctx) as Component;
		const output = await settled(component);
		expect(output).toContain("edit a.ts 5ms");
		expect(output).toContain("bash fail 6ms");
		expect(output).toContain("nested failure detail");
		expect(output).toContain("first native output");
		expect(output).toContain("last native diagnostic");
		expect(output).toContain("last");
	});

	it("shows one compact aggregate for silent scripts, not one row per operation", () => {
		const component = renderer().renderResult?.(result(), options, theme, context()) as Component;
		const output = lines(component);
		expect(output).toContain("2 files, 3 operations");
		expect(output).toContain("+3 -2");
		expect(output).toContain("ctrl+o to expand");
		expect(output).not.toContain("a.ts");
		expect(output).not.toContain("b.ts");
		expect(hunkPreview.renderSplit).not.toHaveBeenCalled();
	});

	it("shows counted omissions and incompleteness without inventing unknown counts", () => {
		const data = preview();
		data.omittedChanges = 4;
		data.incomplete = true;
		if (data.changes[0].kind === "diff") data.changes[0].omittedLines = 7;
		const output = lines(renderer().renderResult?.(result(data), options, theme, context()) as Component);
		expect(output).toContain("4 changes omitted from capture");
		expect(output).toContain("7 lines omitted from capture");
		expect(output).toContain("capture incomplete");
	});

	it.each([false, true])("shows only a warning for unknown capture loss with expanded=%s", async (expanded) => {
		const data: ToolPreviewDetails = { version: 1, changes: [], omittedChanges: 0, incomplete: true };
		const native = result(data, ["native output"]);
		const before = structuredClone(native);
		const component = renderer().renderResult?.(native, { ...options, expanded }, theme, context()) as Component;
		expect(
			(await settled(component))
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean),
		).toStrictEqual(["native output", "Preview capture incomplete"]);
		expect(native).toStrictEqual(before);
	});

	it("renders stored JSON grouped by file, keeping repeated operations in recorded order", async () => {
		const data = JSON.parse(JSON.stringify(result()));
		const component = renderer().renderResult?.(data, { ...options, expanded: true }, theme, context()) as Component;
		const output = await settled(component);
		expect(output).toContain("first");
		expect(output).toContain("last");
		expect(output).toContain("second");
		expect(output.indexOf("last")).toBeLessThan(output.indexOf("b.ts"));
		expect(hunkPreview.renderSplit).toHaveBeenCalledTimes(3);
	});

	it("keeps actual successful diffs and base errors visible when the script fails", async () => {
		const component = renderer().renderResult?.(
			result(preview(), ["failure after edit", "last error"]),
			{ ...options, expanded: true },
			theme,
			context({ isError: true }),
		) as Component;
		const output = await settled(component);
		expect(output).toContain("failure after edit");
		expect(output).toContain("last error");
		expect(output).toContain("last");
	});

	it.each([
		undefined,
		{ version: 2, changes: [], omittedChanges: 0 },
		{ version: 1, changes: [], omittedChanges: 0 },
	])("does not append empty or invalid persisted previews: %j", (data) => {
		const native = result(null, ["unchanged native output"]);
		native.details.piDiff = data;
		const output = lines(renderer().renderResult?.(native, options, theme, context()) as Component);
		expect(output.trim()).toBe("unchanged native output");
	});

	it("isolates preview and composite components from foreign state and downstream reuse", () => {
		const base = baseRenderers();
		const composed = renderer(base);
		const foreign = new Text("foreign renderer", 0, 0);
		const state = { foreign: { retained: true } };
		const ctx = context({ state, lastComponent: foreign });
		const first = composed.renderResult?.(result(), options, theme, ctx) as Component;
		const firstBase = base.renderResult.mock.results[0].value;
		const second = composed.renderResult?.(result(), { ...options, expanded: true }, theme, {
			...ctx,
			lastComponent: first,
		}) as Component;
		expect(second).toBe(first);
		expect(second).not.toBe(firstBase);
		expect(base.renderResult.mock.calls[0][3].lastComponent).toBeUndefined();
		expect(base.renderResult.mock.calls[1][3].lastComponent).toBe(firstBase);
		expect(base.renderResult.mock.calls[1][3].state).toBe(state);
		expect(state).toStrictEqual({ foreign: { retained: true } });
		expect(lines(foreign).trim()).toBe("foreign renderer");
	});

	it("invalidates stale highlighting through repeated expand-collapse-expand transitions", async () => {
		const old = deferred();
		const fresh = deferred();
		vi.mocked(hunkPreview.renderSplit)
			.mockImplementationOnce(() => old.promise)
			.mockImplementationOnce(() => fresh.promise);
		const composed = renderer();
		const ctx = context();
		const native = result({ version: 1, changes: [preview().changes[0]], omittedChanges: 0 });
		const component = composed.renderResult?.(native, { ...options, expanded: true }, theme, ctx) as Component;
		component.render(150);
		composed.renderResult?.(native, options, theme, ctx);
		expect(lines(component)).toContain("1 file, 1 operation");
		composed.renderResult?.(native, { ...options, expanded: true }, theme, ctx);
		component.render(150);
		fresh.resolve("fresh grouped body");
		await fresh.promise;
		await vi.waitFor(() => expect(lines(component)).toContain("fresh grouped body"));
		old.resolve("stale grouped body");
		await old.promise;
		await Promise.resolve();
		expect(lines(component)).not.toContain("stale grouped body");
		expect(ctx.invalidate).toHaveBeenCalledTimes(1);
	});

	it("keeps result slots separate for parent calls sharing downstream state", () => {
		const composed = renderer();
		const ctx = context();
		const first = composed.renderResult?.(result(preview(), ["first parent"]), options, theme, ctx) as Component;
		const second = composed.renderResult?.(result(preview(), ["other parent"]), options, theme, {
			...ctx,
			toolCallId: "other",
		}) as Component;
		expect(first).not.toBe(second);
		expect(lines(first)).toContain("first parent");
		expect(lines(first)).not.toContain("other parent");
	});

	it("invalidates expanded work on collapse even though the shared component is hidden", async () => {
		const pending = deferred();
		vi.mocked(hunkPreview.renderSplit).mockImplementationOnce(() => pending.promise);
		const composed = renderer();
		const ctx = context();
		const component = composed.renderResult?.(result(), { ...options, expanded: true }, theme, ctx) as Component;
		component.render(150);
		composed.renderResult?.(result(), options, theme, ctx);
		pending.resolve("hidden stale body");
		await pending.promise;
		await Promise.resolve();
		expect(lines(component)).toContain("2 files, 3 operations");
		expect(lines(component)).not.toContain("hidden stale body");
		expect(ctx.invalidate).not.toHaveBeenCalled();
		expect(hunkPreview.renderSplit).toHaveBeenCalledTimes(1);
	});

	it("cancels pending previews when persisted details disappear", async () => {
		const pending = deferred();
		vi.mocked(hunkPreview.renderSplit).mockImplementationOnce(() => pending.promise);
		const composed = renderer();
		const ctx = context();
		const component = composed.renderResult?.(result(), { ...options, expanded: true }, theme, ctx) as Component;
		component.render(150);
		composed.renderResult?.(result(null, ["base only"]), options, theme, ctx);
		pending.resolve("discarded body");
		await pending.promise;
		await Promise.resolve();
		expect(lines(component).trim()).toBe("base only");
		expect(ctx.invalidate).not.toHaveBeenCalled();
	});
});
