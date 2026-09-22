# Changelog

## 0.3.1

- Republish from restored `main` after an unauthorized force-push on 2026-08-27 rewrote this repository's default branch. npm `0.3.0` was published on 2026-08-24, before that rewrite. Install from npm or this tag, not from a clone taken during the incident.

## Unreleased

- Avoid duplicate extension-tool registration in Pi child processes. Lazy stubs
  are now omitted from detected child processes by default for every spec;
  individual specs can opt in with `loadInSubagents: true`. This applies across
  compatible subagent implementations without requiring a destructive
  `extensions: []` child allowlist.

## 0.3.0

Startup responsiveness. The after-start queue previously began on a
`setTimeout(0)` from `session_start` and then ran uninterrupted, so a stack of
`"after-start"` packages loaded back to back while Pi was still painting and
while the user was typing their first prompt. Activating an extension is mostly
synchronous work (TypeScript transform plus module-graph evaluation), so each
one blocked the event loop for its full duration.

- **Delay the queue.** New `afterStartInitialDelayMs` (default `750`) keeps the
  first slice clear of Pi's first paint and first keystrokes. Previously
  hard-coded to `0`.
- **Pause during agent turns.** New `afterStartPauseDuringTurn` (default `true`)
  parks the queue at `before_agent_start` and resumes it at `agent_end` /
  `agent_settled`, so loading never competes with streaming output. A 60 s
  failsafe releases the queue if a host never reports the end of a turn.
- **Adaptive yielding.** New `afterStartAdaptiveYield` (default `true`) sleeps
  for as long as the previous slice blocked the event loop, capped at 250 ms, so
  heavy packages give back more time than light ones. `afterStartDelayMs` is now
  the floor rather than the whole delay.
- **Overlap imports with activation.** New `afterStartPrefetch` (default `true`)
  imports the next slice's modules while the current slice's factories run.
  Factory execution remains strictly serial and in `priority` order; a prefetch
  failure happens before any factory runs, so it is discarded and re-surfaced by
  the real load.
- Package resolution is now attempted once per entry instead of being rescanned
  on every trigger for packages that are not installed.
- All four new fields default to the documented values when absent, so existing
  `lazy.json` files keep working untouched.

## 0.2.8

- Documentation: Improved README readability and onboarding with a table of contents, a clearer LazyVim analogy explanation, and streamlined usage sections.
- CI: Drop Node 20 from CI test matrix due to upstream `@earendil-works/pi-coding-agent` devDependency requirement while keeping package runtime support at Node >=20.

## 0.2.7

- Coalesce concurrent loads, reject dependency cycles, and prevent retries after partial factory activation.
- Preserve loaded extensions across session changes and cancel stale after-start queues with generation tokens.
- Make configuration/settings writes atomic; validate config fields and preserve package metadata during migration.
- Keep migrated packages eager until restart, support configured event names, and remove recursive command redispatch.
- Replace machine-specific integration/smoke scripts with hermetic tests and portable artifact verification.
- Move the Pi host to peer/dev dependencies and update the lockfile to clear dependency audit findings.

## 0.2.6

- **Fix DataCloneError on every lazy load** ("`... could not be cloned`"):
  `loadResolvedEntry` returned `commandHandlers` — a `Map` of command name to
  handler **function** — inside `LoadResult`, and the `lazy_load` tool
  forwarded the whole object as tool-result `details`. Pi `structuredClone`s
  tool-result details for the transcript, and functions cannot be cloned, so
  every lazy load crashed with `DataCloneError: <handler> could not be
  cloned.`
- Remove `commandHandlers` from `LoadResult`. Stub-command dispatch already
  reads `entry.loadedCommandHandlers` directly, so nothing consumed it from
  the result; internal `ResolvedEntry` tracking is unchanged.
- Sanitize `lazy_load` tool `details` to an explicit primitive allowlist
  (`ok`, `name`, `alreadyLoaded`, `loadMs`, `tools`, `commands`, `error`) as
  defense in depth, so a future non-serializable field can never crash the
  transcript.

## 0.2.5

- Fix stub command re-dispatch: after lazy-loading the real package, invoke its
  captured `registerCommand` handler directly instead of re-injecting `/cmd`
  via `sendUserMessage({ deliverAs: "followUp" })`. The follow-up path bypasses
  slash-command dispatch entirely and lands the literal `/cmd` text in the
  conversation as a plain chat message, so the real command (e.g. `/mcp`)
  never actually ran on first invocation.
- `loader.ts` now captures each `registerCommand` call's handler during the
  tracked load and exposes it via `ResolvedEntry.loadedCommandHandlers` /
  `LoadResult.commandHandlers`, keyed by command name.

## 0.2.4

- Resilient stale-ctx handling: guard all async-gap `ctx.ui` accesses so a replaced/reloaded session never crashes the pi process.
- Track `rt.sessionCtx` synchronously on `session_start` and prefer it over captured ctx across `loadByName` iterations, `setTimeout` gaps, and after-start batches.
- Extract `notifySafe()` and `refreshStatus()` stale-ctx guards for reuse.

## 0.2.3

- Resolve lazy-loaded extension peer dependencies from the active Pi runtime,
  including hoisted Bun/npm installations.

## 0.2.2

- Retry npm publishing without provenance only when npm reports an existing transparency-log entry.

## 0.2.1

- Include required Pi runtime dependencies in the published package so the compiled extension entry resolves after installation.

## 0.2.0

- Defer package resolution until first load and cache jiti/Pi loader setup.
- Publish a compiled `dist/index.js` extension entry.
- Add cooperative after-start batching, bounded automatic loads, and `/lazy profile` timings.
- Add an isolated startup benchmark that never mutates the live Pi agent configuration.

## 0.1.1

- Fix jiti resolution: prefer `createJiti` over the CJS default function wrapper
- Sync `j(path)` broke top-level await in lazy-loaded TS extensions (`rpiv-todo`, `rpiv-ask-user-question`)
- Pass `moduleCache: false` like pi-core when importing extension modules

## 0.1.0

- Initial release: LazyVim-style extension manager for Pi Coding Agent
- Load strategies: eager, `after-start` (VeryLazy), on-demand
- Triggers: `/lazy load`, stub commands/tools, keywords, events, shortcuts
- `/lazy migrate` rewrites `settings.packages` to `extensions: []` for true module-lazy
- Config: `~/.pi/agent/lazy.json`
