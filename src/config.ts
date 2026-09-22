import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { LazyConfig, LazyMode, LazySpec } from "./types.ts";

export const CONFIG_VERSION = 1 as const;

/**
 * The after-start queue competes with Pi's first paint and with the user typing
 * their first prompt, so it waits before starting. Loading a heavy extension is
 * mostly synchronous CPU (transform + module evaluation), which blocks the event
 * loop no matter how the queue is sliced — the only cure is to not start early.
 */
export const DEFAULT_AFTER_START_INITIAL_DELAY_MS = 750;

export function getLazyConfigPath(agentDir = getAgentDir()): string {
	return join(agentDir, "lazy.json");
}

export function getSettingsPath(agentDir = getAgentDir()): string {
	return join(agentDir, "settings.json");
}

export function defaultConfig(): LazyConfig {
	return {
		version: 1,
		defaults: { lazy: true },
		auto: true,
		autoLoadLimit: 1,
		afterStartBatchSize: 1,
		afterStartDelayMs: 0,
		afterStartInitialDelayMs: DEFAULT_AFTER_START_INITIAL_DELAY_MS,
		afterStartPauseDuringTurn: true,
		afterStartAdaptiveYield: true,
		afterStartPrefetch: true,
		specs: [
			// Providers / always-on identity
			{ name: "grok-cli", source: "npm:pi-grok-cli", lazy: false, description: "Grok CLI provider" },
			{ name: "antigravity", source: "npm:pi-antigravity", lazy: false, description: "Antigravity provider" },
			{ name: "cursor", source: "npm:@rahularya01/pi-cursor", lazy: false, description: "Cursor provider bridge" },

			// VeryLazy — common after UI is up
			{
				name: "subagents",
				source: "npm:pi-subagents",
				lazy: "after-start",
				priority: 10,
				description: "Subagent orchestration",
			},
			{
				name: "todo",
				source: "npm:@juicesharp/rpiv-todo",
				lazy: "after-start",
				priority: 20,
				cmd: ["todo"],
				tools: ["todo"],
			},
			{
				name: "ask-user",
				source: "npm:@juicesharp/rpiv-ask-user-question",
				lazy: "after-start",
				priority: 20,
				tools: ["ask_user_question"],
			},
			{
				name: "hypa",
				source: "npm:@hypabolic/pi-hypa",
				lazy: "after-start",
				priority: 30,
				description: "Hypa compressed tools",
			},
			{
				name: "paster",
				source: "npm:pi-paster",
				lazy: "after-start",
				priority: 40,
				description: "Clipboard / paste helpers",
			},

			// On-demand — heavy / situational
			{
				name: "web",
				source: "npm:pi-web-access",
				lazy: true,
				cmd: ["web"],
				tools: ["web_search", "fetch_content", "get_search_content"],
				keywords: ["web search", "search the web", "fetch url", "youtube"],
				description: "Web search / fetch / video",
			},
			{
				name: "mcp",
				source: "npm:pi-mcp-adapter",
				lazy: true,
				cmd: ["mcp"],
				keywords: ["mcp", "playwright", "clickup"],
				description: "MCP server bridge",
			},
			{
				name: "context-mode",
				source: "npm:context-mode",
				lazy: true,
				cmd: ["context-mode", "ctx"],
				tools: ["ctx_execute", "ctx_search", "ctx_index"],
				keywords: ["context-mode", "ctx_execute"],
				description: "Context-mode tools + skills",
			},
			{
				name: "lens",
				source: "npm:pi-lens",
				lazy: true,
				cmd: ["lens"],
				tools: ["lens_diagnostics", "symbol_search", "module_report", "lsp_diagnostics"],
				keywords: ["diagnostics", "symbol search", "ast-grep", "lsp"],
				description: "pi-lens code intelligence",
			},
			{
				name: "plannotator",
				source: "npm:@plannotator/pi-extension",
				lazy: true,
				cmd: ["plannotator", "plan"],
				keywords: ["plannotator", "plan mode"],
				description: "Plan mode / plannotator",
			},
		],
	};
}

export function normalizeMode(value: unknown, fallback: LazyMode = true): LazyMode {
	if (value === false || value === true || value === "after-start") return value;
	return fallback;
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function normalizeNonNegativeInteger(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeStringArray(value: unknown, field: string, issues: string[]): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		issues.push(`${field} must be an array of strings`);
		return undefined;
	}
	const result: string[] = [];
	for (const item of value) {
		if (typeof item !== "string" || item.trim().length === 0) {
			issues.push(`${field} contains an empty or non-string value`);
			continue;
		}
		const normalized = item.trim();
		if (!result.includes(normalized)) result.push(normalized);
	}
	return result.length > 0 ? result : undefined;
}

function normalizeSpec(value: unknown, index: number, defaultsLazy: LazyMode, issues: string[]): LazySpec | null {
	const field = `specs[${index}]`;
	if (!isRecord(value)) {
		issues.push(`${field} must be an object`);
		return null;
	}

	const name = typeof value.name === "string" ? value.name.trim() : "";
	const source = typeof value.source === "string" ? value.source.trim() : "";
	if (!name) issues.push(`${field}.name must be a non-empty string`);
	if (!source) issues.push(`${field}.source must be a non-empty string`);
	if (!name || !source) return null;

	const lazy = value.lazy === undefined ? defaultsLazy : normalizeMode(value.lazy, defaultsLazy);
	if (value.lazy !== undefined && lazy === defaultsLazy && value.lazy !== defaultsLazy) {
		issues.push(`${field}.lazy must be false, true, or "after-start"`);
	}

	let priority: number | undefined;
	if (value.priority !== undefined) {
		if (typeof value.priority === "number" && Number.isFinite(value.priority) && Number.isInteger(value.priority)) {
			priority = value.priority;
		} else {
			issues.push(`${field}.priority must be a finite integer`);
		}
	}

	const description = value.description === undefined || typeof value.description === "string" ? value.description : undefined;
	if (value.description !== undefined && description === undefined) {
		issues.push(`${field}.description must be a string`);
	}

	let loadInSubagents: boolean | undefined;
	if (value.loadInSubagents !== undefined) {
		if (typeof value.loadInSubagents === "boolean") {
			loadInSubagents = value.loadInSubagents;
		} else {
			issues.push(`${field}.loadInSubagents must be a boolean`);
		}
	}

	return {
		name,
		source,
		lazy,
		...(priority === undefined ? {} : { priority }),
		...(description === undefined ? {} : { description }),
		...(loadInSubagents === undefined ? {} : { loadInSubagents }),
		cmd: normalizeStringArray(value.cmd, `${field}.cmd`, issues),
		tools: normalizeStringArray(value.tools, `${field}.tools`, issues),
		keys: normalizeStringArray(value.keys, `${field}.keys`, issues),
		event: normalizeStringArray(value.event, `${field}.event`, issues),
		keywords: normalizeStringArray(value.keywords, `${field}.keywords`, issues),
		dependencies: normalizeStringArray(value.dependencies, `${field}.dependencies`, issues),
	};
}

function reportConfigIssues(path: string, issues: string[]) {
	for (const issue of issues) console.error(`[pi-lazy] invalid ${path}: ${issue}`);
}

/** Write JSON without ever exposing a partially-written target file. */
export function atomicWriteJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	let fd: number | undefined;
	try {
		const mode = existsSync(path) ? statSync(path).mode : 0o600;
		fd = openSync(tempPath, "wx", mode);
		writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(tempPath, path);
		try {
			const dirFd = openSync(dirname(path), "r");
			try {
				fsyncSync(dirFd);
			} finally {
				closeSync(dirFd);
			}
		} catch {
			// Some platforms do not allow fsync on directories; the rename itself is
			// still atomic, so durability falls back to the platform default.
		}
	} catch (err) {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				/* ignore cleanup failure */
			}
		}
		try {
			unlinkSync(tempPath);
		} catch {
			/* temp file may not exist */
		}
		throw err;
	}
}

export function loadConfig(agentDir = getAgentDir()): LazyConfig {
	const path = getLazyConfigPath(agentDir);
	if (!existsSync(path)) {
		const cfg = defaultConfig();
		try {
			saveConfig(cfg, agentDir);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(`[pi-lazy] failed to create lazy.json: ${message}`);
		}
		return cfg;
	}

	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (!isRecord(parsed)) throw new Error("root must be a JSON object");
		const raw = parsed;
		const issues: string[] = [];
		const supportedVersion = raw.version === undefined || raw.version === CONFIG_VERSION;
		if (!supportedVersion) {
			issues.push(`unsupported version ${String(raw.version)} (expected ${CONFIG_VERSION})`);
		}
		const defaults = isRecord(raw.defaults) ? raw.defaults : {};
		if (raw.defaults !== undefined && !isRecord(raw.defaults)) issues.push("defaults must be an object");
		const defaultsLazy = normalizeMode(defaults.lazy, true);
		if (defaults.lazy !== undefined && defaultsLazy === true && defaults.lazy !== true) {
			issues.push('defaults.lazy must be false, true, or "after-start"');
		}

		const specs: LazySpec[] = [];
		const names = new Set<string>();
		if (!supportedVersion) {
			issues.push("unsupported configuration is disabled until it is migrated");
		} else if (!Array.isArray(raw.specs)) {
			issues.push("specs must be an array; no packages will be managed until it is fixed");
		} else {
			for (let i = 0; i < raw.specs.length; i++) {
				const spec = normalizeSpec(raw.specs[i], i, defaultsLazy, issues);
				if (!spec) continue;
				if (names.has(spec.name)) {
					issues.push(`duplicate spec name '${spec.name}' at specs[${i}]`);
					continue;
				}
				names.add(spec.name);
				specs.push(spec);
			}
		}
		for (const spec of specs) {
			for (const dependency of spec.dependencies ?? []) {
				if (!names.has(dependency)) issues.push(`spec '${spec.name}' references unknown dependency '${dependency}'`);
			}
		}
		reportConfigIssues(path, issues);

		return {
			version: 1,
			defaults: { lazy: defaultsLazy },
			auto: raw.auto !== false,
			autoLoadLimit: normalizePositiveInteger(raw.autoLoadLimit, 1),
			afterStartBatchSize: normalizePositiveInteger(raw.afterStartBatchSize, 1),
			afterStartDelayMs: normalizeNonNegativeInteger(raw.afterStartDelayMs, 0),
			afterStartInitialDelayMs: normalizeNonNegativeInteger(
				raw.afterStartInitialDelayMs,
				DEFAULT_AFTER_START_INITIAL_DELAY_MS,
			),
			afterStartPauseDuringTurn: normalizeBoolean(raw.afterStartPauseDuringTurn, true),
			afterStartAdaptiveYield: normalizeBoolean(raw.afterStartAdaptiveYield, true),
			afterStartPrefetch: normalizeBoolean(raw.afterStartPrefetch, true),
			specs,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`[pi-lazy] failed to parse lazy.json: ${message}`);
		return defaultConfig();
	}
}

export function saveConfig(config: LazyConfig, agentDir = getAgentDir()): string {
	const path = getLazyConfigPath(agentDir);
	atomicWriteJson(path, config);
	return path;
}

export function isManagedLazy(spec: LazySpec): boolean {
	return spec.lazy !== false;
}
