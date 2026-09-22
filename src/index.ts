/**
 * pi-lazy — LazyVim-style extension manager for Pi Coding Agent.
 *
 * Load strategies:
 *   lazy: false         always-on (Pi loads normally)
 *   lazy: "after-start" VeryLazy — load after session_start
 *   lazy: true          on demand via cmd / tools / events / keywords / /lazy load
 *
 * True module-lazy requires `/lazy migrate` once (sets packages[].extensions = []).
 */

import { Type } from "typebox";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_AFTER_START_INITIAL_DELAY_MS,
	defaultConfig,
	getLazyConfigPath,
	isManagedLazy,
	loadConfig,
	saveConfig,
} from "./config.ts";
import { loadResolvedEntry, prefetchEntry } from "./loader.ts";
import { migrateSettings } from "./migrate.ts";
import { isModuleLazyInSettings, resolveSpecPaths } from "./resolve.ts";
import { performance } from "node:perf_hooks";
import type { LazyConfig, LoadResult, ResolvedEntry } from "./types.ts";

function isNonEmptyEnv(name: string): boolean {
	return Boolean(process.env[name]?.trim());
}

const CHILD_MARKER_KEYS = [
	"PI_IS_SUBAGENT",
	"PI_SUBAGENT_NAME",
	"PI_SUBAGENT_ID",
	"PI_SUBAGENT_RUN_ID",
	"PI_SUBAGENT_SESSION_ID",
	"PI_SUBAGENT_SESSION",
	"PI_SUBAGENT_ACTIVITY_FILE",
	"PI_AGENT_ROUTER_SUBAGENT",
] as const;

function isChildProcess(): boolean {
	const childFlag = process.env.PI_SUBAGENT_CHILD?.trim().toLowerCase();
	if (childFlag === "1" || childFlag === "true") return true;
	if (CHILD_MARKER_KEYS.some((key) => isNonEmptyEnv(key))) return true;
	return isNonEmptyEnv("PI_SUBAGENT_CHILD_AGENT") && isNonEmptyEnv("PI_SUBAGENT_PARENT_PID");
}

function activeSpecs(config: LazyConfig) {
	if (!isChildProcess()) return config.specs;
	return config.specs.filter((spec) => spec.loadInSubagents === true);
}
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { getSettingsPath } from "./config.ts";

interface Runtime {
	config: LazyConfig;
	entries: Map<string, ResolvedEntry>;
	auto: boolean;
	sessionCtx?: ExtensionContext;
	afterStartQueued: boolean;
	status: string;
	profile: Array<{ label: string; ms: number }>;
	queueCancelled: boolean;
	sessionGeneration: number;
	restartRequired: boolean;
	/** True between before_agent_start and agent_end/agent_settled. */
	turnActive: boolean;
	/** Resolvers for after-start slices parked until the current turn finishes. */
	resumeWaiters: Array<() => void>;
}

/** Upper bound on one adaptive yield, so a slow package cannot stall the queue. */
const MAX_ADAPTIVE_YIELD_MS = 250;

/** Failsafe in case the host never emits a turn-end event for a started turn. */
const PAUSE_TIMEOUT_MS = 60_000;

function sleep(ms: number): Promise<void> {
	return new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});
}

function drainResumeWaiters(rt: Runtime) {
	const waiters = rt.resumeWaiters;
	rt.resumeWaiters = [];
	for (const resolve of waiters) resolve();
}

/**
 * Park the after-start queue while the agent is working.
 *
 * Activating a package is mostly synchronous CPU, so a slice that runs during a
 * turn stalls streaming output and keystroke handling. Waiting costs nothing —
 * these packages are deferred by definition.
 */
function waitWhilePaused(rt: Runtime, generation: number): Promise<void> {
	if (!rt.turnActive) return Promise.resolve();
	if (rt.queueCancelled || generation !== rt.sessionGeneration) return Promise.resolve();
	return new Promise<void>((resolve) => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(finish, PAUSE_TIMEOUT_MS);
		timer.unref?.();
		rt.resumeWaiters.push(finish);
	});
}

function readSettingsPackages(agentDir: string): unknown[] {
	const path = getSettingsPath(agentDir);
	if (!existsSync(path)) return [];
	try {
		const settings = JSON.parse(readFileSync(path, "utf-8")) as { packages?: unknown[] };
		return Array.isArray(settings.packages) ? settings.packages : [];
	} catch {
		return [];
	}
}

function buildCatalog(config: LazyConfig, agentDir: string): Map<string, ResolvedEntry> {
	const packages = readSettingsPackages(agentDir);
	const map = new Map<string, ResolvedEntry>();

	for (const spec of activeSpecs(config)) {
		const managed = isManagedLazy(spec);
		const moduleLazyReady = managed && isModuleLazyInSettings(spec.source, packages);

		let state: ResolvedEntry["state"];
		if (!managed) {
			state = "eager";
		} else if (!moduleLazyReady) {
			// Still eager in settings — Pi already loaded (or will load) the factory
			state = "eager";
		} else {
			state = "pending";
		}

		map.set(spec.name, {
			spec,
			// Avoid filesystem/package.json scans for packages that are never loaded.
			packageRoot: "",
			extensionPaths: [],
			moduleLazyReady,
			state,
			normalizedKeywords: (spec.keywords ?? []).map((keyword) => keyword.toLowerCase()),
		});
	}

	return map;
}

function formatStatus(rt: Runtime): string {
	const all = [...rt.entries.values()];
	const loaded = all.filter((e) => e.state === "loaded").length;
	const pending = all.filter((e) => e.state === "pending").length;
	const eager = all.filter((e) => e.state === "eager").length;
	const errors = all.filter((e) => e.state === "error" || e.state === "poisoned").length;
	const parts = [`lazy ${loaded}↑`, `${pending}·`, `${eager}⚡`];
	if (errors) parts.push(`${errors}✗`);
	if (rt.restartRequired) parts.push("restart required");
	return parts.join(" ");
}

function refreshStatus(pi: ExtensionAPI, rt: Runtime, ctx?: ExtensionContext) {
	rt.status = formatStatus(rt);
	// Prefer the freshest known ctx: a passed-in ctx captured before an async
	// gap (e.g. runAfterStart's setTimeout) can go stale if the session gets
	// replaced/reloaded in the meantime, while rt.sessionCtx is updated
	// synchronously by every session_start.
	const target = rt.sessionCtx ?? ctx;
	if (!target) return;
	try {
		// ctx.ui is a getter that throws once the ctx is stale, so even reading
		// it must be guarded — a status-bar update is never worth crashing pi.
		const ui = target.ui;
		if (ui && typeof ui.setStatus === "function") {
			ui.setStatus("pi-lazy", rt.status);
		}
	} catch {
		// stale ctx — session was replaced/reloaded since this ctx was captured.
	}
}

/** Best-effort notify: a stale ctx must never crash the whole pi process. */
function notifySafe(ctx: ExtensionContext | undefined, message: string, type?: "info" | "warning" | "error") {
	if (!ctx) return;
	try {
		ctx.ui.notify(message, type);
	} catch {
		// stale ctx — session was replaced/reloaded since this ctx was captured.
	}
}

function recordTiming(rt: Runtime, label: string, started: number) {
	rt.profile.push({ label, ms: performance.now() - started });
	if (rt.profile.length > 100) rt.profile.shift();
}

/**
 * Resolve package metadata on first use, not during startup catalog creation.
 * Returns false only when resolution threw; a package that is simply not
 * installed resolves to empty paths and is reported later by the loader.
 */
function ensureResolved(rt: Runtime, entry: ResolvedEntry, ctx?: ExtensionContext): boolean {
	if (entry.resolveAttempted) return true;
	const started = performance.now();
	try {
		const resolved = resolveSpecPaths(entry.spec, getAgentDir(), (ctx ?? rt.sessionCtx)?.cwd ?? process.cwd());
		entry.packageRoot = resolved.packageRoot ?? "";
		entry.extensionPaths = resolved.extensionPaths;
		entry.resolveMs = performance.now() - started;
		entry.resolveAttempted = true;
		recordTiming(rt, `resolve:${entry.spec.name}`, started);
		return true;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		entry.resolveAttempted = true;
		entry.state = "error";
		entry.error = `failed to resolve ${entry.spec.source}: ${message}`;
		return false;
	}
}

/**
 * Import an upcoming entry's modules while the current one activates. Purely an
 * optimization: any failure is swallowed here and re-surfaced by the real load.
 */
async function prefetchQuietly(rt: Runtime, entry: ResolvedEntry, ctx?: ExtensionContext) {
	try {
		if (entry.state !== "pending" || !entry.moduleLazyReady) return;
		if (!ensureResolved(rt, entry, ctx)) return;
		const started = performance.now();
		await prefetchEntry(entry);
		if (entry.prefetchedFactories) recordTiming(rt, `prefetch:${entry.spec.name}`, started);
	} catch {
		/* the real load re-imports and reports the error */
	}
}

async function loadByName(
	pi: ExtensionAPI,
	rt: Runtime,
	name: string,
	ctx?: ExtensionContext,
	ancestry: string[] = [],
): Promise<LoadResult> {
	const key = name.trim();
	if (!key) return { ok: false, name: key, error: "spec name must not be empty" };
	const entry =
		rt.entries.get(key) ??
		[...rt.entries.values()].find(
			(e) => e.spec.source === key || e.spec.name.toLowerCase() === key.toLowerCase(),
		);

	if (!entry) {
		return { ok: false, name: key, error: `unknown spec '${key}' — see /lazy list` };
	}

	// Eager packages are already loaded by Pi
	if (entry.state === "eager") {
		return {
			ok: true,
			name: entry.spec.name,
			alreadyLoaded: true,
			error: undefined,
		};
	}

	if (!ensureResolved(rt, entry, ctx)) {
		return { ok: false, name: entry.spec.name, error: entry.error };
	}
	const started = performance.now();
	const result = await loadResolvedEntry(entry, pi, ctx ?? rt.sessionCtx, {
		ancestry,
		loadDependency: (dep, nextAncestry) => loadByName(pi, rt, dep, ctx, nextAncestry),
	});
	recordTiming(rt, `load:${entry.spec.name}`, started);

	refreshStatus(pi, rt, ctx ?? rt.sessionCtx);
	return result;
}

function registerStubs(pi: ExtensionAPI, rt: Runtime) {
	const cmdOwners = new Map<string, string>(); // cmd -> spec name
	const toolOwners = new Map<string, string>();

	for (const entry of rt.entries.values()) {
		if (entry.state !== "pending") continue;
		const { spec } = entry;
		for (const cmd of spec.cmd ?? []) {
			if (cmdOwners.has(cmd)) {
				console.error(`[pi-lazy] command stub '${cmd}' is claimed by both '${cmdOwners.get(cmd)}' and '${spec.name}'`);
				continue;
			}
			cmdOwners.set(cmd, spec.name);
		}
		for (const tool of spec.tools ?? []) {
			if (toolOwners.has(tool)) {
				console.error(`[pi-lazy] tool stub '${tool}' is claimed by both '${toolOwners.get(tool)}' and '${spec.name}'`);
				continue;
			}
			toolOwners.set(tool, spec.name);
		}
		for (const key of spec.keys ?? []) {
			try {
				pi.registerShortcut(key as any, {
					description: `Load lazy package ${spec.name}`,
					handler: async (ctx) => {
						const res = await loadByName(pi, rt, spec.name, ctx);
						ctx.ui.notify(
							res.ok
								? res.alreadyLoaded
									? `${spec.name} already loaded`
									: `loaded ${spec.name}${res.loadMs != null ? ` (${res.loadMs}ms)` : ""}`
								: `failed ${spec.name}: ${res.error}`,
							res.ok ? "info" : "error",
						);
					},
				});
			} catch {
				/* duplicate shortcut */
			}
		}
	}

	for (const [cmd, owner] of cmdOwners) {
		pi.registerCommand(cmd, {
			description: `[lazy] load ${owner} then run /${cmd}`,
			handler: async (args, ctx) => {
				const res = await loadByName(pi, rt, owner, ctx);
				if (!res.ok) {
					ctx.ui.notify(`lazy: failed to load ${owner}: ${res.error}`, "error");
					return;
				}
				if (!res.alreadyLoaded) {
					ctx.ui.notify(`lazy: loaded ${owner}${res.loadMs != null ? ` in ${res.loadMs}ms` : ""}`, "info");
				}
				// Call the real command's handler in-process. sendUserMessage()
				// injects text back into the conversation as a literal chat
				// message rather than re-running slash-command dispatch, so a
				// re-sent "/cmd" never reaches the newly loaded handler — it
				// just gets shown to the LLM as a stray prompt.
				const real = rt.entries.get(owner)?.loadedCommandHandlers?.get(cmd);
				if (real) {
					await real(args, ctx);
					return;
				}
					ctx.ui.notify(
						`lazy: '${owner}' loaded but did not register /${cmd}; update lazy.json to the package's actual command name`,
						"error",
					);
				},
		});
	}

	for (const [toolName, owner] of toolOwners) {
		pi.registerTool({
			name: toolName,
			label: `Lazy: ${toolName}`,
			description: `Lazy stub for ${toolName}. Loads package '${owner}' on first use, then activates the real tool. Call again after activation if needed.`,
			parameters: Type.Object({
				_lazy: Type.Optional(Type.String({ description: "Ignored. Present so the tool is valid before load." })),
			}, { additionalProperties: true }),
			async execute(_id, _params, _signal, _onUpdate, ctx) {
				const res = await loadByName(pi, rt, owner, ctx);
				if (!res.ok) {
					return {
						content: [{ type: "text", text: `Failed to load '${owner}': ${res.error}` }],
						details: { ok: false, error: res.error },
					};
				}
				const tools = res.tools?.length ? res.tools.join(", ") : "(see package)";
				return {
					content: [
						{
							type: "text",
							text: res.alreadyLoaded
								? `Package '${owner}' already available. Use the real tools now.`
								: `Loaded '${owner}'${res.loadMs != null ? ` in ${res.loadMs}ms` : ""}. Registered tools: ${tools}. Call the real tool again on the next turn.`,
						},
					],
					details: { ok: true, loaded: owner, tools: res.tools ?? [], alreadyLoaded: !!res.alreadyLoaded },
				};
			},
		});
	}
}

function registerEventTriggers(pi: ExtensionAPI, rt: Runtime) {
	const eventMap = new Map<string, string[]>(); // event -> spec names
	for (const entry of rt.entries.values()) {
		if (entry.state !== "pending") continue;
		for (const ev of entry.spec.event ?? []) {
			const list = eventMap.get(ev) ?? [];
			list.push(entry.spec.name);
			eventMap.set(ev, list);
		}
	}

	const loadTriggered = async (names: Iterable<string>, ctx: ExtensionContext) => {
		const limit = rt.config.autoLoadLimit ?? 1;
		let loaded = 0;
		for (const name of new Set(names)) {
			if (loaded >= limit) break;
			const current = rt.sessionCtx ?? ctx;
			const res = await loadByName(pi, rt, name, current);
			if (res.ok && !res.alreadyLoaded) {
				loaded++;
				notifySafe(rt.sessionCtx ?? current, `lazy: auto-loaded ${name}`, "info");
			}
		}
	};

	// before_agent_start combines explicit event owners with keyword matches.
	pi.on("before_agent_start", async (event, ctx) => {
		// Set before the auto guard: the after-start queue must back off during a
		// turn regardless of whether keyword auto-loading is enabled.
		rt.turnActive = true;
		if (!rt.auto) return;
		const prompt = (event.prompt ?? "").toLowerCase();
		const toLoad = new Set<string>();

		for (const name of eventMap.get("before_agent_start") ?? []) {
			toLoad.add(name);
		}

		for (const entry of rt.entries.values()) {
			if (entry.state !== "pending") continue;
			for (const keyword of entry.normalizedKeywords ?? []) {
				if (prompt.includes(keyword)) {
					toLoad.add(entry.spec.name);
					break;
				}
			}
		}

		await loadTriggered(toLoad, ctx);
	});

	for (const [eventName, owners] of eventMap) {
		if (eventName === "before_agent_start") continue;
		try {
			(pi.on as Function)(eventName, async (_event: unknown, ctx: ExtensionContext) => {
				if (rt.auto) await loadTriggered(owners, ctx);
			});
		} catch (err) {
			console.error(`[pi-lazy] unsupported event trigger '${eventName}': ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}

async function runAfterStart(pi: ExtensionAPI, rt: Runtime, ctx: ExtensionContext, generation: number) {
	const queue = [...rt.entries.values()]
		.filter((e) => e.state === "pending" && e.spec.lazy === "after-start")
		.sort((a, b) => (a.spec.priority ?? 100) - (b.spec.priority ?? 100));

	const batchSize = rt.config.afterStartBatchSize ?? 1;
	const delayMs = rt.config.afterStartDelayMs ?? 0;
	const adaptive = rt.config.afterStartAdaptiveYield !== false;
	const prefetch = rt.config.afterStartPrefetch !== false;
	const stale = () => rt.queueCancelled || generation !== rt.sessionGeneration;

	for (let i = 0; i < queue.length && !stale(); i += batchSize) {
		await waitWhilePaused(rt, generation);
		if (stale()) return;

		const batch = queue.slice(i, i + batchSize);
		const next = queue.slice(i + batchSize, i + batchSize * 2);
		// Overlap the next slice's imports with this slice's activation. Factory
		// execution below stays strictly serial and in priority order.
		if (prefetch) {
			for (const entry of next) void prefetchQuietly(rt, entry, rt.sessionCtx ?? ctx);
		}

		let blockedMs = 0;
		for (const entry of batch) {
			if (stale()) return;
			// The ctx passed in was captured by session_start before the timer that
			// scheduled this call; if the session was replaced/reloaded in that gap
			// (or between iterations here), rt.sessionCtx already points at the fresh one.
			const current = rt.sessionCtx ?? ctx;
			const started = performance.now();
			const res = await loadByName(pi, rt, entry.spec.name, current);
			blockedMs += performance.now() - started;
			if (stale()) return;
			if (!res.ok) {
				notifySafe(rt.sessionCtx ?? current, `lazy: after-start failed ${entry.spec.name}: ${res.error}`, "warning");
			}
		}

		if (i + batchSize < queue.length && !stale()) {
			// Give the UI back at least as much time as the slice took from it,
			// capped so a pathologically slow package cannot stall the whole queue.
			const yieldMs = adaptive
				? Math.max(delayMs, Math.min(Math.round(blockedMs), MAX_ADAPTIVE_YIELD_MS))
				: delayMs;
			await sleep(yieldMs);
		}
	}
	refreshStatus(pi, rt, rt.sessionCtx ?? ctx);
}

function listLines(rt: Runtime): string[] {
	const lines: string[] = [];
	const order = ["pending", "loading", "loaded", "error", "poisoned", "eager"] as const;
	const sorted = [...rt.entries.values()].sort((a, b) => {
		const ai = order.indexOf(a.state as (typeof order)[number]);
		const bi = order.indexOf(b.state as (typeof order)[number]);
		if (ai !== bi) return ai - bi;
		return a.spec.name.localeCompare(b.spec.name);
	});

	for (const e of sorted) {
		const mode = e.spec.lazy === false ? "eager" : e.spec.lazy === "after-start" ? "after-start" : "on-demand";
		const ms = e.loadMs != null ? ` ${e.loadMs}ms` : "";
		const err = e.error ? ` — ${e.error}` : "";
		const ready = e.moduleLazyReady ? "" : e.state === "eager" && isManagedLazy(e.spec) ? " (migrate+restart needed)" : "";
		lines.push(`${e.state.padEnd(8)} ${e.spec.name.padEnd(16)} ${mode.padEnd(12)} ${e.spec.source}${ms}${ready}${err}`);
	}
	return lines;
}

export function createPiLazy(pi: ExtensionAPI, agentDir = getAgentDir()) {
	const config = loadConfig(agentDir);
	const catalogStarted = performance.now();
	const rt: Runtime = {
		config,
		entries: buildCatalog(config, agentDir),
		auto: config.auto !== false,
		afterStartQueued: false,
		status: "lazy …",
		profile: [],
		queueCancelled: false,
		sessionGeneration: 0,
		restartRequired: false,
		turnActive: false,
		resumeWaiters: [],
	};
	recordTiming(rt, "catalog", catalogStarted);
	registerStubs(pi, rt);
	registerEventTriggers(pi, rt);

	const endTurn = () => {
		rt.turnActive = false;
		drainResumeWaiters(rt);
	};
	// agent_settled is the later of the two; agent_end covers hosts that never
	// settle (aborted or errored turns). Both are idempotent.
	try {
		pi.on("agent_end", () => {
			endTurn();
		});
		pi.on("agent_settled", () => {
			endTurn();
		});
	} catch (err) {
		// An older host without these events simply never pauses the queue.
		console.error(`[pi-lazy] turn-end events unavailable: ${err instanceof Error ? err.message : String(err)}`);
	}

	pi.on("session_start", async (event, ctx) => {
		rt.sessionGeneration++;
		const generation = rt.sessionGeneration;
		rt.sessionCtx = ctx;
		rt.queueCancelled = false;
		rt.turnActive = false;
		// Waiters parked by the previous session are now stale; release them so
		// they exit on their generation check.
		drainResumeWaiters(rt);
		refreshStatus(pi, rt, ctx);

		const needsMigrate = [...rt.entries.values()].some(
			(e) => isManagedLazy(e.spec) && !e.moduleLazyReady,
		);
		if (needsMigrate && event.reason === "startup") {
			ctx.ui.notify("pi-lazy: run /lazy migrate then restart for true module-lazy", "info");
		}

		rt.afterStartQueued = true;
		// VeryLazy: yield so first paint / prompt isn't blocked. A generation token
		// makes older scheduled work harmless if sessions change in the meantime.
		const initialDelayMs = rt.config.afterStartInitialDelayMs ?? DEFAULT_AFTER_START_INITIAL_DELAY_MS;
		setTimeout(() => {
			void runAfterStart(pi, rt, ctx, generation)
				.catch((err) => {
					const message = err instanceof Error ? err.message : String(err);
					console.error(`[pi-lazy] after-start queue failed: ${message}`);
					notifySafe(rt.sessionCtx, `lazy: after-start queue failed: ${message}`, "warning");
				})
				.finally(() => {
					if (generation === rt.sessionGeneration) rt.afterStartQueued = false;
				});
		}, initialDelayMs);
	});

	pi.on("session_shutdown", () => {
		rt.sessionGeneration++;
		rt.sessionCtx = undefined;
		rt.afterStartQueued = false;
		rt.queueCancelled = true;
		rt.turnActive = false;
		// Release parked slices so they observe the cancellation instead of
		// holding their timers until the pause failsafe fires.
		drainResumeWaiters(rt);
	});

	pi.registerCommand("lazy", {
		description: "LazyVim-style extension manager (list|load|migrate|auto|init|status)",
		getArgumentCompletions: (prefix) => {
			const sub = ["status", "list", "load", "migrate", "auto", "init", "config", "profile"];
			const names = [...rt.entries.keys()].map((n) => `load ${n}`);
			const items = [...sub, ...names, "auto on", "auto off"].map((v) => ({ value: v, label: v }));
			const filtered = items.filter((i) => i.value.startsWith(prefix) || i.value.includes(prefix));
			return filtered.length ? filtered : null;
		},
		handler: async (args, ctx) => {
			const raw = (args ?? "").trim();
			const [head, ...rest] = raw.split(/\s+/);
			const sub = (head || "status").toLowerCase();

			if (sub === "status" || sub === "") {
				const lines = [
					formatStatus(rt),
					`auto: ${rt.auto ? "on" : "off"}`,
					`config: ${getLazyConfigPath(agentDir)}`,
					"",
					...listLines(rt),
				];
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			if (sub === "list") {
				ctx.ui.notify(listLines(rt).join("\n") || "no specs", "info");
				return;
			}

			if (sub === "config") {
				ctx.ui.notify(getLazyConfigPath(agentDir), "info");
				return;
			}

			if (sub === "profile") {
				const lines = rt.profile.length
					? rt.profile.map((item) => `${item.label.padEnd(24)} ${item.ms.toFixed(1)}ms`)
					: ["no timings recorded"];
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			if (sub === "init") {
				try {
					const currentPath = getLazyConfigPath(agentDir);
					let backup = "";
					if (existsSync(currentPath)) {
						const stamp = new Date().toISOString().replace(/[:.]/g, "-");
						backup = `${currentPath}.bak.init-${stamp}`;
						copyFileSync(currentPath, backup);
					}
					const path = saveConfig(defaultConfig(), agentDir);
					rt.restartRequired = true;
					refreshStatus(pi, rt, ctx);
					ctx.ui.notify(`wrote default config → ${path}${backup ? `\nbackup: ${backup}` : ""}\nReload or restart Pi to apply it.`, "info");
				} catch (err) {
					ctx.ui.notify(`failed to initialize config: ${err instanceof Error ? err.message : String(err)}`, "error");
				}
				return;
			}

			if (sub === "auto") {
				const mode = (rest[0] ?? "").toLowerCase();
				if (mode === "on" || mode === "off") {
					const previous = rt.auto;
					try {
						rt.auto = mode === "on";
						rt.config.auto = rt.auto;
						saveConfig(rt.config, agentDir);
						ctx.ui.notify(`lazy auto ${mode}`, "info");
					} catch (err) {
						rt.auto = previous;
						rt.config.auto = previous;
						ctx.ui.notify(`failed to save config: ${err instanceof Error ? err.message : String(err)}`, "error");
					}
					return;
				}
				ctx.ui.notify(`lazy auto is ${rt.auto ? "on" : "off"} (usage: /lazy auto on|off)`, "info");
				return;
			}

			if (sub === "migrate") {
				const result = migrateSettings(agentDir);
				if (!result.ok) {
					ctx.ui.notify(`migrate failed: ${result.error}`, "error");
					return;
				}
				const lines = [
					result.changed.length ? `updated: ${result.changed.join(", ")}` : "no package changes needed",
					result.skipped.length ? `already lazy: ${result.skipped.join(", ")}` : "",
					result.added.length ? `added: ${result.added.join(", ")}` : "",
					result.backupPath ? `backup: ${result.backupPath}` : "",
					"Restart pi to apply module-lazy (extensions filtered to []).",
				].filter(Boolean);
				ctx.ui.notify(lines.join("\n"), "info");
				if (result.changed.length > 0) rt.restartRequired = true;
				refreshStatus(pi, rt, ctx);
				return;
			}

			if (sub === "load") {
				const name = rest.join(" ").trim();
				if (!name) {
					ctx.ui.notify("usage: /lazy load <name>", "warning");
					return;
				}
				const res = await loadByName(pi, rt, name, ctx);
				if (!res.ok) {
					ctx.ui.notify(`load failed: ${res.error}`, "error");
					return;
				}
				if (res.alreadyLoaded) {
					ctx.ui.notify(`${res.name} already loaded/eager`, "info");
					return;
				}
				ctx.ui.notify(
					`loaded ${res.name}${res.loadMs != null ? ` in ${res.loadMs}ms` : ""}${
						res.tools?.length ? ` — tools: ${res.tools.join(", ")}` : ""
					}`,
					"info",
				);
				return;
			}

			ctx.ui.notify("usage: /lazy [status|list|profile|load <name>|migrate|auto on|off|init|config]", "warning");
		},
	});

	pi.registerTool({
		name: "lazy_load",
		label: "Lazy Load",
		description:
			"Load a deferred Pi extension package managed by pi-lazy (LazyVim-style). Use when a capability is pending/on-demand (web, mcp, lens, plannotator, context-mode, etc.). Prefer /lazy list names.",
		promptSnippet: "Load a deferred pi-lazy extension package on demand",
		parameters: Type.Object({
			name: Type.String({ description: "Spec name from /lazy list (e.g. web, mcp, lens, plannotator)" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const res = await loadByName(pi, rt, params.name, ctx);
			// Serialize a safe, structuredClone-friendly details payload. LoadResult
			// may contain only primitives now, but keeping an explicit allowlist here
			// means a future non-serializable field can never crash the transcript
			// (pi structuredClones tool-result `details`).
			const details = {
				ok: res.ok,
				name: res.name,
				alreadyLoaded: !!res.alreadyLoaded,
				loadMs: res.loadMs ?? null,
				tools: res.tools ?? [],
				commands: res.commands ?? [],
				error: res.error ?? undefined,
			};
			if (!res.ok) {
				return {
					content: [{ type: "text", text: `Failed: ${res.error}` }],
					details,
				};
			}
			return {
				content: [
					{
						type: "text",
						text: res.alreadyLoaded
							? `'${res.name}' already loaded or eager.`
							: `Loaded '${res.name}' in ${res.loadMs ?? "?"}ms. tools=[${(res.tools ?? []).join(", ")}] commands=[${(res.commands ?? []).join(", ")}]`,
					},
				],
				details,
			};
		},
	});
}

export default function piLazy(pi: ExtensionAPI) {
	return createPiLazy(pi, getAgentDir());
}
