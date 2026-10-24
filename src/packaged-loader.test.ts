import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parseDiff } from "./core/diff.js";

it("loads the packed Pi entry with the host mutation queue across separate SDK installations", async () => {
	const root = dirname(dirname(fileURLToPath(import.meta.url)));
	const fixture = await mkdtemp(join(tmpdir(), "pi-diff-packed-"));
	const home = join(fixture, "home");
	const env = {
		...process.env,
		HOME: home,
		PI_CODING_AGENT_DIR: join(home, "agent"),
		npm_config_cache: join(fixture, "cache"),
	};
	try {
		await mkdir(home);
		execFileSync("npm", ["run", "build"], { cwd: root, env, stdio: "pipe" });
		const packed = JSON.parse(
			execFileSync("npm", ["pack", "--json", "--pack-destination", fixture], {
				cwd: root,
				env,
				encoding: "utf8",
			}),
		) as Array<{ filename: string; files: Array<{ path: string }> }>;
		const archive = packed[0];
		if (!archive) throw new Error("npm pack produced no archive.");
		expect(archive.files.filter(({ path }) => /(?:\.test\.|^test\/)/.test(path))).toStrictEqual([]);
		execFileSync("tar", ["-xzf", join(fixture, archive.filename), "-C", fixture]);
		const localSdk = join(root, "node_modules/@earendil-works/pi-coding-agent");
		const hostSdk = join(fixture, "host-sdk");
		await mkdir(hostSdk);
		await cp(join(localSdk, "dist"), join(hostSdk, "dist"), { recursive: true });
		await cp(join(localSdk, "package.json"), join(hostSdk, "package.json"));
		await symlink(join(localSdk, "node_modules"), join(hostSdk, "node_modules"), "dir");
		await symlink(join(root, "node_modules"), join(fixture, "node_modules"), "dir");
		const packagePath = join(fixture, "package");
		await symlink(join(root, "node_modules"), join(packagePath, "node_modules"), "dir");
		const cwd = join(fixture, "workspace");
		await mkdir(cwd);
		const output = execFileSync(process.execPath, [join(root, "test/packaged-loader.mts"), hostSdk, packagePath, cwd], {
			cwd,
			env,
			encoding: "utf8",
			timeout: 15000,
		});
		expect(JSON.parse(output)).toStrictEqual({
			finishedBeforeQueueRelease: false,
			contentBeforeRelease: "initial",
			finalContent: "final",
			preview: {
				piDiff: {
					version: 1,
					changes: [
						{ kind: "diff", filePath: join(cwd, "a.txt"), diff: parseDiff("queued", "final"), omittedLines: 0 },
					],
					omittedChanges: 0,
				},
			},
		});
	} finally {
		await rm(fixture, { recursive: true, force: true });
	}
}, 20000);
