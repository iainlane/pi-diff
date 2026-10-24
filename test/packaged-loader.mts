import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type * as Pi from "@earendil-works/pi-coding-agent";

const [hostPath, packagePath, cwd] = process.argv.slice(2);
if (!hostPath || !packagePath || !cwd) {
	throw new Error("Provide the host SDK, packed extension and fixture directory.");
}

const host: typeof Pi = await import(pathToFileURL(join(hostPath, "dist/index.js")).href);
const manifest = JSON.parse(await readFile(join(packagePath, "package.json"), "utf8")) as {
	pi: { extensions: string[] };
};
const entry = manifest.pi.extensions[0];
if (!entry) throw new Error("The package has no Pi extension entry.");

process.chdir(cwd);
const loader = new host.DefaultResourceLoader({
	cwd,
	agentDir: join(cwd, "agent"),
	settingsManager: host.SettingsManager.inMemory({}),
	additionalExtensionPaths: [join(packagePath, entry)],
	noExtensions: true,
	noSkills: true,
	noThemes: true,
	noPromptTemplates: true,
	noContextFiles: true,
});
await loader.reload();
const { extensions, errors, runtime } = loader.getExtensions();
if (errors.length) throw new Error(JSON.stringify(errors));
const tool = extensions[0]?.tools.get("write")?.definition;
if (!tool) throw new Error("The packed extension did not register write.");

const models = await host.ModelRuntime.create({ refreshOnCreate: false });
const runner = new host.ExtensionRunner(
	extensions,
	runtime,
	cwd,
	host.SessionManager.inMemory(cwd),
	new host.ModelRegistry(models),
);
const context = runner.createToolContext("fixture", undefined);

const file = join(cwd, "a.txt");
await writeFile(file, "initial");
let acquired = () => {};
let release = () => {};
const ready = new Promise<void>((resolve) => {
	acquired = resolve;
});
const gate = new Promise<void>((resolve) => {
	release = resolve;
});
const blocked = host.withFileMutationQueue(file, async () => {
	acquired();
	await gate;
	await writeFile(file, "queued");
});
await ready;
let finished = false;
const execution = tool
	.execute("fixture", { path: file, content: "final" }, undefined, undefined, context)
	.then((result) => {
		finished = true;
		return result;
	});
try {
	await new Promise((resolve) => setTimeout(resolve, 100));
	const finishedBeforeQueueRelease = finished;
	const contentBeforeRelease = await readFile(file, "utf8");
	release();
	await blocked;
	const result = await execution;
	process.stdout.write(
		JSON.stringify({
			finishedBeforeQueueRelease,
			contentBeforeRelease,
			finalContent: await readFile(file, "utf8"),
			preview: result.details,
		}),
	);
} finally {
	release();
	await Promise.allSettled([blocked, execution]);
}
