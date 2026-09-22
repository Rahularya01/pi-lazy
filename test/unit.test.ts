import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.ts";
import { createPiLazy } from "../src/index.ts";
import { loadResolvedEntry, prefetchEntry } from "../src/loader.ts";
import { migrateSettings } from "../src/migrate.ts";
import { isModuleLazyInSettings, resolveExtensionEntries } from "../src/resolve.ts";
import type { LazySpec, LoadResult, ResolvedEntry } from "../src/types.ts";

const tempRoots: string[] = [];
const inheritedChildMarkers = Object.fromEntries(
	Object.entries(process.env).filter(([key]) => key === "PI_IS_SUBAGENT" || /SUBAGENT/.test(key)),
);
for (const key of Object.keys(inheritedChildMarkers)) delete process.env[key];

function tempDir(prefix = "pi-lazy-test-"): string {
	const path = mkdtempSync(join(tmpdir(), prefix));
	tempRoots.push(path);
	return path;
}

test.after(() => {
	for (const path of tempRoots) rmSync(path, { recursive: true, force: true });
	Object.assign(process.env, inheritedChildMarkers);
});

function writeJson(path: string, value: unknown) {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createPackage(root: string, files: Record<string, string>, extensions = Object.keys(files)) {
	mkdirSync(root, { recursive: true });
	for (const [name, body] of Object.entries(files)) {
		const path = join(root, name);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, body, "utf8");
	}
	writeJson(join(root, "package.json"), { type: "module", pi: { extensions } });
}

function resolvedEntry(spec: LazySpec, packageRoot: string, extensionPaths: string[]): ResolvedEntry {
	return { spec, packageRoot, extensionPaths, moduleLazyReady: true, state: "pending" };
}

function mockPi() {
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	const notifications: Array<{ message: string; type?: string }> = [];
	const userMessages: string[] = [];
	let activeTools: string[] = [];
	const api: any = {
		on(event: string, handler: (event: any, ctx: any) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerTool(tool: any) { tools.set(tool.name, tool); },
		registerCommand(name: string, options: any) { commands.set(name, options); },
		registerShortcut() {},
		getActiveTools() { return [...activeTools]; },
		setActiveTools(names: string[]) { activeTools = [...names]; },
		sendUserMessage(message: string) { userMessages.push(message); },
	};
	const ctx: any = {
		cwd: process.cwd(),
		ui: {
			notify(message: string, type?: string) { notifications.push({ message, type }); },
			setStatus() {},
		},
	};
	return {
		api,
		ctx,
		handlers,
		commands,
		tools,
		notifications,
		userMessages,
		async emit(event: string, payload: any = {}) {
			for (const handler of [...(handlers.get(event) ?? [])]) await handler(payload, ctx);
		},
	};
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000) {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

test("config validation retains valid specs and rejects duplicate names", () => {
	const agent = tempDir();
	writeJson(join(agent, "lazy.json"), {
		version: 1,
		specs: [
			{ name: "one", source: "npm:one", cmd: "not-an-array" },
			{ name: "one", source: "npm:duplicate" },
			{ name: "two", source: "npm:two", tools: ["ok", "", 4] },
		],
	});
	const errors: string[] = [];
	const originalError = console.error;
	console.error = (...args) => errors.push(args.join(" "));
	let config: ReturnType<typeof loadConfig>;
	try {
		config = loadConfig(agent);
	} finally {
		console.error = originalError;
	}
	assert.deepEqual(config.specs.map((spec) => spec.name), ["one", "two"]);
	assert.equal(config.specs[0]?.cmd, undefined);
	assert.deepEqual(config.specs[1]?.tools, ["ok"]);
	assert.equal(config.specs.some((spec) => spec.name === "grok-cli"), false);
	assert.ok(errors.some((message) => /duplicate spec name/.test(message)));
});

test("child processes omit lazy stubs unless specs opt in", () => {
	const agent = tempDir();
	writeJson(join(agent, "lazy.json"), {
		version: 1,
		specs: [
			{ name: "default", source: "npm:example-default", lazy: true, tools: ["default_tool"] },
			{ name: "enabled", source: "npm:example-enabled", lazy: true, loadInSubagents: true, tools: ["enabled_tool"] },
			{ name: "disabled", source: "npm:example-disabled", lazy: true, loadInSubagents: false, tools: ["disabled_tool"] },
			{ name: "invalid", source: "npm:example-invalid", lazy: true, loadInSubagents: "false", tools: ["invalid_tool"] },
		],
	});
	writeJson(join(agent, "settings.json"), {
		packages: [
			{ source: "npm:example-default", extensions: [] },
			{ source: "npm:example-enabled", extensions: [] },
			{ source: "npm:example-disabled", extensions: [] },
			{ source: "npm:example-invalid", extensions: [] },
		],
	});
	const previousEnv = { ...process.env };
	try {
		for (const key of Object.keys(process.env)) {
			if (key === "PI_IS_SUBAGENT" || /SUBAGENT/.test(key)) delete process.env[key];
		}
		process.env.PI_SUBAGENT_CHILD = "1";
		const child = mockPi();
		createPiLazy(child.api, agent);
		assert.equal(child.tools.has("default_tool"), false);
		assert.equal(child.tools.has("enabled_tool"), true);
		assert.equal(child.tools.has("disabled_tool"), false);
		assert.equal(child.tools.has("invalid_tool"), false);
	} finally {
		for (const key of Object.keys(process.env)) delete process.env[key];
		Object.assign(process.env, previousEnv);
	}

	process.env.PI_SUBAGENT_DEPTH = "3";
	process.env.PI_SUBAGENT_PARENT_SESSION = "parent-session";
	const parent = mockPi();
	createPiLazy(parent.api, agent);
	delete process.env.PI_SUBAGENT_DEPTH;
	assert.equal(parent.tools.has("default_tool"), true);
	assert.equal(parent.tools.has("enabled_tool"), true);
	assert.equal(parent.tools.has("disabled_tool"), true);
	assert.equal(parent.tools.has("invalid_tool"), true);
});

test("generic child markers disable lazy stubs", () => {
	const agent = tempDir();
	writeJson(join(agent, "lazy.json"), {
		version: 1,
		specs: [{ name: "pkg", source: "npm:example", lazy: true, tools: ["example_tool"] }],
	});
	writeJson(join(agent, "settings.json"), { packages: [{ source: "npm:example", extensions: [] }] });
	const markers = ["PI_IS_SUBAGENT", "PI_SUBAGENT_CHILD", "PI_SUBAGENT_NAME", "PI_AGENT_ROUTER_SUBAGENT"];
	const previousEnv = { ...process.env };
	try {
		for (const marker of markers) {
			for (const key of Object.keys(process.env)) delete process.env[key];
			process.env[marker] = "1";
			const child = mockPi();
			createPiLazy(child.api, agent);
			assert.equal(child.tools.has("example_tool"), false, marker);
		}
	} finally {
		for (const key of Object.keys(process.env)) delete process.env[key];
		Object.assign(process.env, previousEnv);
	}
});

test("migration restores eager extensions without losing package metadata", () => {
	const agent = tempDir();
	writeJson(join(agent, "lazy.json"), { version: 1, specs: [{ name: "pkg", source: "npm:pkg", lazy: false }] });
	writeJson(join(agent, "settings.json"), {
		packages: [{ source: "npm:pkg", extensions: [], enabled: false, prompts: ["prompt.md"] }],
	});
	const result = migrateSettings(agent);
	assert.equal(result.ok, true);
	const settings = JSON.parse(readFileSync(join(agent, "settings.json"), "utf8"));
	assert.deepEqual(settings.packages[0], { source: "npm:pkg", enabled: false, prompts: ["prompt.md"] });
	assert.ok(result.backupPath);
});

test("migration refuses ambiguous duplicate package entries", () => {
	const agent = tempDir();
	writeJson(join(agent, "lazy.json"), { version: 1, specs: [{ name: "pkg", source: "npm:pkg", lazy: true }] });
	writeJson(join(agent, "settings.json"), { packages: ["npm:pkg", { source: "pkg", extensions: [] }] });
	const before = readFileSync(join(agent, "settings.json"), "utf8");
	const result = migrateSettings(agent);
	assert.equal(result.ok, false);
	assert.match(result.error ?? "", /duplicate/);
	assert.equal(readFileSync(join(agent, "settings.json"), "utf8"), before);
});

test("module-lazy readiness fails closed for duplicates and distinguishes explicit versions", () => {
	assert.equal(isModuleLazyInSettings("npm:pkg", [{ source: "npm:pkg", extensions: [] }]), true);
	assert.equal(isModuleLazyInSettings("npm:pkg", [{ source: "npm:pkg", extensions: [] }, "npm:pkg"]), false);
	assert.equal(isModuleLazyInSettings("npm:pkg@2", [{ source: "npm:pkg@1", extensions: [] }]), false);
});

test("extension resolution ignores traversal and returns deterministic directory entries", () => {
	const base = tempDir();
	const root = join(base, "pkg");
	writeFileSync(join(base, "outside.js"), "export default () => {}", "utf8");
	createPackage(root, {
		"extensions/z.js": "export default () => {}",
		"extensions/a.js": "export default () => {}",
	}, ["../outside.js", "extensions"]);
	assert.deepEqual(resolveExtensionEntries(root), [join(root, "extensions/a.js"), join(root, "extensions/z.js")]);
});

test("concurrent callers share one factory activation", async () => {
	const root = tempDir();
	createPackage(root, {
		"index.mjs": `export default async function(pi){ globalThis.__piLazyConcurrent=(globalThis.__piLazyConcurrent||0)+1; await new Promise(r=>setTimeout(r,30)); pi.registerTool({name:"once"}); }`,
	});
	(globalThis as any).__piLazyConcurrent = 0;
	const entry = resolvedEntry({ name: "concurrent", source: root, lazy: true }, root, [join(root, "index.mjs")]);
	const pi = mockPi();
	const deps = { loadDependency: async () => ({ ok: false, name: "unused" }) as LoadResult };
	const [first, second] = await Promise.all([
		loadResolvedEntry(entry, pi.api, pi.ctx, deps),
		loadResolvedEntry(entry, pi.api, pi.ctx, deps),
	]);
	assert.equal(first.ok, true);
	assert.equal(second.ok, true);
	assert.equal((globalThis as any).__piLazyConcurrent, 1);
});

test("dependency cycles return an explicit error", async () => {
	const root = tempDir();
	createPackage(root, { "index.mjs": "export default () => {}" });
	const entries = new Map<string, ResolvedEntry>([
		["a", resolvedEntry({ name: "a", source: root, lazy: true, dependencies: ["b"] }, root, [join(root, "index.mjs")])],
		["b", resolvedEntry({ name: "b", source: root, lazy: true, dependencies: ["a"] }, root, [join(root, "index.mjs")])],
	]);
	const pi = mockPi();
	const load = (name: string, ancestry: string[] = []): Promise<LoadResult> => {
		const entry = entries.get(name)!;
		return loadResolvedEntry(entry, pi.api, pi.ctx, {
			ancestry,
			loadDependency: (dependency, next) => load(dependency, next),
		});
	};
	const result = await load("a");
	assert.equal(result.ok, false);
	assert.match(result.error ?? "", /dependency cycle: a -> b -> a/);
});

test("a failed partial activation is poisoned and cannot be retried", async () => {
	const root = tempDir();
	createPackage(root, {
		"first.mjs": `export default function(pi){ globalThis.__piLazyPartial=(globalThis.__piLazyPartial||0)+1; pi.registerTool({name:"partial"}); }`,
		"second.mjs": "export default function(){ throw new Error('factory exploded'); }",
	});
	(globalThis as any).__piLazyPartial = 0;
	const entry = resolvedEntry({ name: "partial", source: root, lazy: true }, root, [join(root, "first.mjs"), join(root, "second.mjs")]);
	const pi = mockPi();
	const deps = { loadDependency: async () => ({ ok: false, name: "unused" }) as LoadResult };
	const first = await loadResolvedEntry(entry, pi.api, pi.ctx, deps);
	const second = await loadResolvedEntry(entry, pi.api, pi.ctx, deps);
	assert.equal(first.ok, false);
	assert.equal(entry.state, "poisoned");
	assert.match(second.error ?? "", /restart required/);
	assert.equal((globalThis as any).__piLazyPartial, 1);
});

test("loaded factories survive later sessions without duplicate activation", async () => {
	const agent = tempDir();
	const pkg = join(agent, "pkg");
	createPackage(pkg, {
		"index.mjs": `export default function(pi){ globalThis.__piLazySessions=(globalThis.__piLazySessions||0)+1; pi.on("session_start",()=>{}); }`,
	});
	writeJson(join(agent, "lazy.json"), {
		version: 1,
		afterStartDelayMs: 0,
		afterStartInitialDelayMs: 0,
		specs: [{ name: "pkg", source: pkg, lazy: "after-start" }],
	});
	writeJson(join(agent, "settings.json"), { packages: [{ source: pkg, extensions: [] }] });
	(globalThis as any).__piLazySessions = 0;
	const pi = mockPi();
	createPiLazy(pi.api, agent);
	await pi.emit("session_start", { type: "session_start", reason: "startup" });
	await waitFor(() => (globalThis as any).__piLazySessions === 1);
	await pi.emit("session_shutdown", { type: "session_shutdown" });
	await pi.emit("session_start", { type: "session_start", reason: "switch" });
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal((globalThis as any).__piLazySessions, 1);
});

test("migration does not enable a second in-process activation", async () => {
	const agent = tempDir();
	const pkg = join(agent, "pkg");
	createPackage(pkg, { "index.mjs": "export default function(){ globalThis.__piLazyMigrated=(globalThis.__piLazyMigrated||0)+1; }" });
	writeJson(join(agent, "lazy.json"), { version: 1, specs: [{ name: "pkg", source: pkg, lazy: true }] });
	writeJson(join(agent, "settings.json"), { packages: [pkg] });
	(globalThis as any).__piLazyMigrated = 0;
	const pi = mockPi();
	createPiLazy(pi.api, agent);
	await pi.commands.get("lazy").handler("migrate", pi.ctx);
	await pi.commands.get("lazy").handler("load pkg", pi.ctx);
	assert.equal((globalThis as any).__piLazyMigrated, 0);
	assert.ok(pi.notifications.some((item) => /already loaded\/eager/.test(item.message)));
});

test("missing real command reports an error without recursive redispatch", async () => {
	const agent = tempDir();
	const pkg = join(agent, "pkg");
	createPackage(pkg, { "index.mjs": "export default function(){}" });
	writeJson(join(agent, "lazy.json"), { version: 1, specs: [{ name: "pkg", source: pkg, lazy: true, cmd: ["demo"] }] });
	writeJson(join(agent, "settings.json"), { packages: [{ source: pkg, extensions: [] }] });
	const pi = mockPi();
	createPiLazy(pi.api, agent);
	await pi.commands.get("demo").handler("args", pi.ctx);
	assert.deepEqual(pi.userMessages, []);
	assert.ok(pi.notifications.some((item) => /did not register \/demo/.test(item.message)));
});

test("custom event names trigger configured packages", async () => {
	const agent = tempDir();
	const pkg = join(agent, "pkg");
	createPackage(pkg, { "index.mjs": "export default function(){ globalThis.__piLazyEvent=(globalThis.__piLazyEvent||0)+1; }" });
	writeJson(join(agent, "lazy.json"), { version: 1, specs: [{ name: "pkg", source: pkg, lazy: true, event: ["custom_event"] }] });
	writeJson(join(agent, "settings.json"), { packages: [{ source: pkg, extensions: [] }] });
	(globalThis as any).__piLazyEvent = 0;
	const pi = mockPi();
	createPiLazy(pi.api, agent);
	await pi.emit("custom_event", { type: "custom_event" });
	assert.equal((globalThis as any).__piLazyEvent, 1);
});

test("the after-start queue waits for the initial delay before loading", async () => {
	const agent = tempDir();
	const pkg = join(agent, "pkg");
	createPackage(pkg, { "index.mjs": "export default function(){ globalThis.__piLazyDelayed=(globalThis.__piLazyDelayed||0)+1; }" });
	writeJson(join(agent, "lazy.json"), {
		version: 1,
		afterStartInitialDelayMs: 200,
		specs: [{ name: "pkg", source: pkg, lazy: "after-start" }],
	});
	writeJson(join(agent, "settings.json"), { packages: [{ source: pkg, extensions: [] }] });
	(globalThis as any).__piLazyDelayed = 0;
	const pi = mockPi();
	createPiLazy(pi.api, agent);
	await pi.emit("session_start", { type: "session_start", reason: "startup" });
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.equal((globalThis as any).__piLazyDelayed, 0, "must not load during the initial delay");
	await waitFor(() => (globalThis as any).__piLazyDelayed === 1, 2_000);
});

test("the after-start queue is held for the duration of an agent turn", async () => {
	const agent = tempDir();
	const pkg = join(agent, "pkg");
	createPackage(pkg, { "index.mjs": "export default function(){ globalThis.__piLazyTurn=(globalThis.__piLazyTurn||0)+1; }" });
	writeJson(join(agent, "lazy.json"), {
		version: 1,
		afterStartInitialDelayMs: 50,
		specs: [{ name: "pkg", source: pkg, lazy: "after-start" }],
	});
	writeJson(join(agent, "settings.json"), { packages: [{ source: pkg, extensions: [] }] });
	(globalThis as any).__piLazyTurn = 0;
	const pi = mockPi();
	createPiLazy(pi.api, agent);
	await pi.emit("session_start", { type: "session_start", reason: "startup" });
	// The user types straight away: the turn opens inside the initial delay,
	// before the queue's first slice gets to run.
	await pi.emit("before_agent_start", { type: "before_agent_start", prompt: "hello" });
	await new Promise((resolve) => setTimeout(resolve, 250));
	assert.equal((globalThis as any).__piLazyTurn, 0, "must not load while a turn is active");
	await pi.emit("agent_end", { type: "agent_end" });
	await waitFor(() => (globalThis as any).__piLazyTurn === 1);
});

test("prefetched factories activate exactly once", async () => {
	const agent = tempDir();
	const pkg = join(agent, "pkg");
	createPackage(pkg, { "index.mjs": "export default function(){ globalThis.__piLazyPrefetch=(globalThis.__piLazyPrefetch||0)+1; }" });
	(globalThis as any).__piLazyPrefetch = 0;
	const entry = resolvedEntry({ name: "pkg", source: pkg, lazy: true }, pkg, [join(pkg, "index.mjs")]);
	const pi = mockPi();

	await prefetchEntry(entry);
	assert.equal(entry.prefetchedFactories?.length, 1, "prefetch imports without activating");
	assert.equal((globalThis as any).__piLazyPrefetch, 0);

	const result = await loadResolvedEntry(entry, pi.api, undefined, {
		loadDependency: async () => ({ ok: true, name: "noop" }) as LoadResult,
	});
	assert.equal(result.ok, true);
	assert.equal((globalThis as any).__piLazyPrefetch, 1);
	assert.equal(entry.prefetchedFactories, undefined, "prefetch is consumed by the load");
});

test("a load that overtakes an in-flight prefetch imports the module only once", async () => {
	const agent = tempDir();
	const pkg = join(agent, "pkg");
	createPackage(pkg, { "index.mjs": "export default function(){ globalThis.__piLazyRace=(globalThis.__piLazyRace||0)+1; }" });
	(globalThis as any).__piLazyRace = 0;
	const entry = resolvedEntry({ name: "pkg", source: pkg, lazy: true }, pkg, [join(pkg, "index.mjs")]);
	const pi = mockPi();

	const prefetch = prefetchEntry(entry);
	const load = loadResolvedEntry(entry, pi.api, undefined, {
		loadDependency: async () => ({ ok: true, name: "noop" }) as LoadResult,
	});
	const [, result] = await Promise.all([prefetch, load]);
	assert.equal(result.ok, true);
	assert.equal((globalThis as any).__piLazyRace, 1);
});
