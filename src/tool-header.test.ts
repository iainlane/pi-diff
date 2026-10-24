import type { ToolRendererResolver, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Spacer, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import diffRendererExtension, { __testing } from "./index.js";

vi.mock("./core/config.js", () => ({
	configIndicatorStyle: () => undefined,
	loadPiDiffConfig: () => ({}),
}));

const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
	bg: (_name: string, text: string) => text,
	getFgAnsi: () => "\x1b[38;2;100;180;120m",
	getBgAnsi: () => "\x1b[48;2;10;10;10m",
};

type RenderContext = Parameters<NonNullable<ToolRenderers["renderResult"]>>[3];

function context(args: unknown, overrides: Partial<RenderContext> = {}): RenderContext {
	return {
		args,
		toolCallId: "fixture",
		state: {},
		lastComponent: undefined,
		cwd: process.cwd(),
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: true,
		showImages: false,
		isError: false,
		durationMs: undefined,
		outputPad: 1,
		invalidate() {},
		...overrides,
	};
}

async function renderedTools() {
	const definitions = new Map<string, ToolRenderers>();
	const resolvers: ToolRendererResolver[] = [];
	await diffRendererExtension({
		on() {},
		registerToolRenderer(resolver: ToolRendererResolver) {
			resolvers.push(resolver);
		},
		registerTool(tool: ToolRenderers & { name: string }) {
			definitions.set(tool.name, tool);
		},
	} as never);
	return (name: string) => {
		const resolve = (index: number): ToolRenderers | undefined =>
			index < resolvers.length ? resolvers[index](name, () => resolve(index + 1)) : definitions.get(name);
		const tool = resolve(0);
		if (!tool?.renderCall || !tool.renderResult) throw new Error(`Missing renderer for ${name}`);
		return { ...tool, renderCall: tool.renderCall, renderResult: tool.renderResult };
	};
}

function shell(padding: number, ...components: Component[]): string[] {
	const box = new Box(padding, 1);
	for (const component of components) box.addChild(component);
	return [...new Spacer(1).render(80), ...box.render(80)].map(stripTerminalSequences);
}

describe("tool header formatting", () => {
	it.each([
		["write", "← write"],
		["edit", "← edit"],
		["create", "← create"],
		["read", "read"],
	])("formats %s", (name, expected) => {
		expect(__testing.formatToolHeaderName(name)).toBe(expected);
	});

	it("uses toolTitle for file paths", () => {
		expect(
			__testing.formatToolHeaderPath({ fg: (name: string, text: string) => `${name}:${text}` }, "src/index.ts"),
		).toBe("toolTitle:src/index.ts");
	});

	it.each([
		[true, false, true],
		[false, true, true],
		[false, false, false],
	])("uses result and context error flags", (result, ctx, expected) => {
		expect(__testing.isToolResultError({ isError: result }, { isError: ctx })).toBe(expected);
	});
});

describe.each([0, 1, 2])("native tool shell with outputPad %i", (padding) => {
	it.each(["write", "edit"])("pads the %s title only through the host shell", async (name) => {
		const get = await renderedTools();
		const tool = get(name);
		const args = { path: "package.json", content: "next", edits: [{ oldText: "old", newText: "new" }] };
		const call = tool.renderCall(args, theme as never, context(args));
		const lines = shell(padding, call);
		expect(lines.map((line) => line.trim())).toStrictEqual(["", "", `← ${name} package.json`, ""]);
		expect(lines[2].match(/^ */)?.[0]).toBe(" ".repeat(padding));
	});

	it.each(["write", "edit"])("expands the %s diff within the inset width", async (name) => {
		const get = await renderedTools();
		const tool = get(name);
		const args = { path: "package.json" };
		const diff = __testing.parseDiff("old();\n", "new();\n");
		const result = {
			content: [{ type: "text" as const, text: "ok" }],
			details: {
				piDiff: {
					version: 1,
					changes: [{ kind: "diff", filePath: "package.json", diff, omittedLines: 0 }],
					omittedChanges: 0,
				},
			},
		};
		const call = tool.renderCall(args, theme as never, context(args));
		let resolve = () => {};
		const settled = new Promise<void>((done) => {
			resolve = done;
		});
		const body = tool.renderResult(
			result,
			{ expanded: true, isPartial: false },
			theme as never,
			context(args, { invalidate: resolve }),
		);
		const pending = shell(padding, call, body);
		expect(pending.some((line) => line.includes("rendering preview"))).toBe(true);
		await settled;
		const lines = shell(padding, call, body);
		expect(lines.some((line) => line.includes("new();"))).toBe(true);
		expect(lines.at(-1)?.trim()).toBe("");
		expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
		expect(lines.filter((line) => line.trim()).every((line) => line.startsWith(" ".repeat(padding)))).toBe(true);
	});

	it.each(["write", "edit"])("preserves the complete %s error body", async (name) => {
		const tool = (await renderedTools())(name);
		const args = { path: "package.json" };
		const call = tool.renderCall(args, theme as never, context(args));
		const body = tool.renderResult(
			{
				content: [
					{ type: "text", text: "first failure" },
					{ type: "text", text: "second failure" },
				],
				details: undefined,
			},
			{ expanded: false, isPartial: false },
			theme as never,
			context(args, { isError: true }),
		);
		expect(shell(padding, call, body).map((line) => line.trim())).toStrictEqual([
			"",
			"",
			`← ${name} package.json`,
			"first failure",
			"second failure",
			"",
		]);
	});
});
