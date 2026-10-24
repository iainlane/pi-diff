import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai/compat";
import {
	createAgentSession,
	createCodemodeExtension,
	DefaultResourceLoader,
	type ExtensionFactory,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import piDiff from "../extension.js";
import { invalidatePiDiffConfig } from "./config.js";
import { isRecord, readPreviewDetails } from "./tool-preview.js";

const editA = "await tools.edit({path:'a.ts',edits:[{oldText:'const a = 1;',newText:'const a = 10;'}]});";
const writeB = "await tools.write({path:'b.ts',content:'const b = 20;\\n'});";
const firstA = { filePath: "a.ts", removed: ["const a = 1;"], added: ["const a = 10;"] };
const changedB = { filePath: "b.ts", removed: ["const b = 2;"], added: ["const b = 20;"] };

const scenarios = [
	{
		name: "parallel calls and repeated edits",
		code: `await Promise.all([tools.edit({path:'a.ts',edits:[{oldText:'const a = 1;',newText:'const a = 10;'}]}), tools.write({path:'b.ts',content:'const b = 20;\\n'})]); await tools.edit({path:'a.ts',edits:[{oldText:'const a = 10;',newText:'const a = 100;'}]});`,
		cancel: false,
		expected: {
			isError: false,
			files: ["const a = 100;\n", "const b = 20;\n"],
			operations: [firstA, { filePath: "a.ts", removed: ["const a = 10;"], added: ["const a = 100;"] }, changedB],
		},
	},
	{
		name: "script failure after a successful mutation",
		code: `${editA} throw new Error('fixture failed');`,
		cancel: false,
		expected: { isError: true, files: ["const a = 10;\n", "const b = 2;\n"], operations: [firstA] },
	},
	{
		name: "cancellation with a queued write after a successful edit",
		code: `${editA} ${writeB}`,
		cancel: true,
		expected: { isError: true, files: ["const a = 10;\n", "const b = 2;\n"], operations: [firstA] },
	},
];

function scriptedProvider(code: string, model: Model<"pi-diff-offline">): ExtensionFactory {
	let calls = 0;
	return (pi) => {
		pi.registerProvider(model.provider, {
			apiKey: "offline-fixture-key",
			api: model.api,
			baseUrl: model.baseUrl,
			models: [model],
			streamSimple: () => {
				const content: AssistantMessage["content"] =
					calls++ === 0
						? [{ type: "toolCall", id: "fixture-call", name: "codemode", arguments: { code } }]
						: [{ type: "text", text: "Done." }];
				const reason = content[0].type === "toolCall" ? "toolUse" : "stop";
				const message: AssistantMessage = {
					role: "assistant",
					content,
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: reason,
					timestamp: 1,
				};
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason, message });
					stream.end();
				});
				return stream;
			},
		});
	};
}

it.each(scenarios)("persists real SDK previews after $name", async ({ code, cancel, expected }) => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-diff-sdk-"));
	const previous = process.cwd();
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	let release = () => {};
	let held: Promise<void> | undefined;
	try {
		process.chdir(cwd);
		await writeFile(join(cwd, "pi-diff.json"), JSON.stringify({ disabledTools: [] }));
		invalidatePiDiffConfig();
		await writeFile(join(cwd, "a.ts"), "const a = 1;\n");
		await writeFile(join(cwd, "b.ts"), "const b = 2;\n");
		const model: Model<"pi-diff-offline"> = {
			id: "fixture",
			name: "Offline fixture",
			api: "pi-diff-offline",
			provider: "pi-diff-offline",
			baseUrl: "http://127.0.0.1:1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		};
		const runtime = await ModelRuntime.create({
			authPath: join(cwd, "auth.json"),
			modelsPath: join(cwd, "models.json"),
		});
		const settings = SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
			defaultTools: ["+codemode"],
		});
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir: join(cwd, "agent"),
			settingsManager: settings,
			noExtensions: true,
			noSkills: true,
			noThemes: true,
			noPromptTemplates: true,
			noContextFiles: true,
			extensionFactories: [scriptedProvider(code, model), createCodemodeExtension({ mode: "on" }), piDiff],
		});
		await loader.reload();
		const manager = SessionManager.create(cwd, join(cwd, "sessions"));
		({ session } = await createAgentSession({
			cwd,
			agentDir: join(cwd, "agent"),
			resourceLoader: loader,
			modelRuntime: runtime,
			model,
			thinkingLevel: "off",
			sessionManager: manager,
			settingsManager: settings,
			tools: ["edit", "write", "codemode"],
		}));
		await session.bindExtensions({});
		let writeStarted = () => {};
		const started = new Promise<void>((resolve) => {
			writeStarted = resolve;
		});
		const events: string[] = [];
		session.subscribe((event) => {
			if (
				(event.type === "tool_execution_start" || event.type === "tool_execution_end") &&
				event.parentToolCallId === "fixture-call"
			) {
				events.push(event.type);
				if (event.type === "tool_execution_start" && event.toolName === "write") writeStarted();
			}
		});
		if (cancel) {
			let ready = () => {};
			const acquired = new Promise<void>((resolve) => {
				ready = resolve;
			});
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			held = withFileMutationQueue(join(cwd, "b.ts"), async () => {
				ready();
				await gate;
			});
			await acquired;
			const pending = session.prompt("Apply the fixed fixture edits.");
			await Promise.race([
				started,
				pending.then(() => {
					throw new Error("The queued write did not start");
				}),
			]);
			const aborted = session.abort();
			release();
			await Promise.all([pending, aborted, held]);
		} else {
			await session.prompt("Apply the fixed fixture edits.");
		}
		const parent = session.messages.find(
			(message) => message.role === "toolResult" && message.toolCallId === "fixture-call",
		);
		if (parent?.role !== "toolResult") throw new Error("The codemode result was not recorded");
		const details = readPreviewDetails(isRecord(parent.details) ? parent.details.piDiff : undefined);
		if (!details) throw new Error("The codemode result has no valid previews");
		const operations = details.changes
			.map((change) => {
				if (change.kind !== "diff") throw new Error("Expected a diff for an existing file");
				return {
					filePath: change.filePath,
					removed: change.diff.lines.filter((line) => line.type === "del").map((line) => line.content),
					added: change.diff.lines.filter((line) => line.type === "add").map((line) => line.content),
				};
			})
			.sort((a, b) => a.filePath.localeCompare(b.filePath));
		expect({
			isError: parent.isError,
			files: await Promise.all(["a.ts", "b.ts"].map((file) => readFile(join(cwd, file), "utf8"))),
			operations,
			version: details.version,
			omittedChanges: details.omittedChanges,
			incomplete: details.incomplete,
			patchTool: session.getAllTools().some((tool) => tool.name === "apply_patch"),
		}).toStrictEqual({ ...expected, version: 1, omittedChanges: 0, incomplete: undefined, patchTool: false });
		expect(
			parent.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n"),
		).not.toContain("const a = 10;");
		if (expected.operations.length === 3)
			expect(events.slice(0, 2)).toStrictEqual(["tool_execution_start", "tool_execution_start"]);
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("The session was not persisted");
		const persisted = SessionManager.open(sessionFile)
			.getBranch()
			.find(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					entry.message.toolCallId === "fixture-call",
			);
		if (persisted?.type !== "message" || persisted.message.role !== "toolResult")
			throw new Error("The codemode result was not reopened");
		expect(persisted.message.details).toStrictEqual(JSON.parse(JSON.stringify(parent.details)));
	} finally {
		release();
		await session?.abort();
		session?.dispose();
		await held;
		process.chdir(previous);
		invalidatePiDiffConfig();
		await rm(cwd, { recursive: true, force: true });
	}
});
