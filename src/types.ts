/**
 * LazyVim-style extension load specs for Pi.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type ExtensionFactory = (api: ExtensionAPI) => unknown;

export type LazyMode = false | true | "after-start";

export type SpecState = "eager" | "pending" | "loading" | "loaded" | "error" | "poisoned";

export interface LazySpec {
	/** Stable id used by /lazy load <name> */
	name: string;
	/** Package source as in settings.packages (npm:..., git:..., or local path) */
	source: string;
	/**
	 * false      — always load with Pi (not managed)
	 * true       — load on demand (cmd / tools / event / keywords / manual)
	 * "after-start" — load shortly after session_start (VeryLazy)
	 */
	lazy?: LazyMode;
	/** Load priority for after-start (lower = earlier). Default 100. */
	priority?: number;
	/** Slash-command names that should stub-load this package on first use */
	cmd?: string[];
	/** Tool names to register as load-on-call stubs */
	tools?: string[];
	/** Keyboard shortcuts that load this package then run optional action */
	keys?: string[];
	/** Pi events that trigger load (e.g. "before_agent_start") */
	event?: string[];
	/** Case-insensitive prompt keywords that trigger load */
	keywords?: string[];
	/** Other spec names that must load first */
	dependencies?: string[];
	/** Optional human description */
	description?: string;
	/** Whether this package's lazy stubs may load in detected child processes. Defaults false in child processes. */
	loadInSubagents?: boolean;
}

export interface LazyConfig {
	version: 1;
	defaults?: {
		lazy?: LazyMode;
	};
	/** When true, keyword/event auto-load is enabled (default true) */
	auto?: boolean;
	/** Maximum packages auto-loaded before one agent turn (default 1). */
	autoLoadLimit?: number;
	/** Number of after-start packages loaded in one event-loop slice (default 1). */
	afterStartBatchSize?: number;
	/** Delay between after-start slices in milliseconds (default 0). */
	afterStartDelayMs?: number;
	/** Delay before the after-start queue starts, in milliseconds (default 750). */
	afterStartInitialDelayMs?: number;
	/** Hold the after-start queue while an agent turn is running (default true). */
	afterStartPauseDuringTurn?: boolean;
	/** Yield at least as long as the previous slice blocked the event loop (default true). */
	afterStartAdaptiveYield?: boolean;
	/** Import the next slice's modules while the current slice activates (default true). */
	afterStartPrefetch?: boolean;
	specs: LazySpec[];
}

export interface ResolvedEntry {
	spec: LazySpec;
	/** Resolved only when the package is first requested. */
	packageRoot: string;
	extensionPaths: string[];
	resolveMs?: number;
	/** True when settings filter keeps extensions[] empty so Pi won't eager-load */
	moduleLazyReady: boolean;
	state: SpecState;
	error?: string;
	loadedAt?: number;
	loadMs?: number;
	loadedTools?: string[];
	loadedCommands?: string[];
	/** Real command handlers captured while loading, keyed by command name. */
	loadedCommandHandlers?: Map<string, (args: string, ctx: any) => Promise<void>>;
	/** Shared by every caller while this entry is being loaded. */
	loadPromise?: Promise<LoadResult>;
	/** True once package resolution ran, so a miss is not rescanned every trigger. */
	resolveAttempted?: boolean;
	/** Factories imported ahead of activation by the after-start prefetcher. */
	prefetchedFactories?: ExtensionFactory[];
	/** In-flight prefetch import, awaited by a real load that overtakes it. */
	prefetchPromise?: Promise<void>;
	prefetchMs?: number;
	/** Normalized once during catalog construction for prompt matching. */
	normalizedKeywords?: string[];
}

export interface LoadResult {
	ok: boolean;
	name: string;
	alreadyLoaded?: boolean;
	loadMs?: number;
	tools?: string[];
	commands?: string[];
	error?: string;
}
