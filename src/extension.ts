import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCodemodePreviews } from "./core/codemode-preview.js";
import { loadPiDiffConfig } from "./core/config.js";
import { computeHunkBlocks, getSepStyle, parseDiff, parsePatchFiles, resolveSepStyle } from "./core/diff.js";
import { createNativeEditTool, createNativeWriteTool } from "./core/native-tools.js";
import { createCodemodeRendererResolver } from "./rendering/codemode-renderer.js";
import {
	createToolRenderers,
	formatToolHeaderName,
	formatToolHeaderPath,
	isToolResultError,
} from "./rendering/tool-renderers.js";
import { applyDiffPalette, normalizeShikiContrast, renderSplit, renderUnified } from "./review/hunk-preview.js";

export const __testing = {
	computeHunkBlocks,
	formatToolHeaderName,
	formatToolHeaderPath,
	isToolResultError,
	normalizeShikiContrast,
	getSepStyle,
	parseDiff,
	parsePatchFiles,
	resolveSepStyle,
	renderSplit,
	renderUnified,
};

export default function diffRendererExtension(pi: ExtensionAPI): void {
	applyDiffPalette();
	resolveSepStyle();

	const cwd = process.cwd();
	const disabledTools = new Set(loadPiDiffConfig().disabledTools ?? []);
	if (!disabledTools.has("write")) pi.registerTool(createNativeWriteTool(cwd));
	if (!disabledTools.has("edit")) pi.registerTool(createNativeEditTool(cwd));

	registerCodemodePreviews(pi, { disabledTools: [...disabledTools] });
	pi.registerToolRenderer(createCodemodeRendererResolver());

	const write = createToolRenderers("write");
	const edit = createToolRenderers("edit");
	pi.registerToolRenderer((name, next) => {
		if (name === "write" && !disabledTools.has("write")) return write;
		if (name === "edit" && !disabledTools.has("edit")) return edit;
		return next();
	});
}
