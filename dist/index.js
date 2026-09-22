// src/index.ts
import { Type } from "typebox";
import { getAgentDir as getAgentDir4 } from "@earendil-works/pi-coding-agent";

// src/config.ts
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
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
var CONFIG_VERSION = 1;
var DEFAULT_AFTER_START_INITIAL_DELAY_MS = 750;
function getLazyConfigPath(agentDir = getAgentDir()) {
  return join(agentDir, "lazy.json");
}
function getSettingsPath(agentDir = getAgentDir()) {
  return join(agentDir, "settings.json");
}
function defaultConfig() {
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
        description: "Subagent orchestration"
      },
      {
        name: "todo",
        source: "npm:@juicesharp/rpiv-todo",
        lazy: "after-start",
        priority: 20,
        cmd: ["todo"],
        tools: ["todo"]
      },
      {
        name: "ask-user",
        source: "npm:@juicesharp/rpiv-ask-user-question",
        lazy: "after-start",
        priority: 20,
        tools: ["ask_user_question"]
      },
      {
        name: "hypa",
        source: "npm:@hypabolic/pi-hypa",
        lazy: "after-start",
        priority: 30,
        description: "Hypa compressed tools"
      },
      {
        name: "paster",
        source: "npm:pi-paster",
        lazy: "after-start",
        priority: 40,
        description: "Clipboard / paste helpers"
      },
      // On-demand — heavy / situational
      {
        name: "web",
        source: "npm:pi-web-access",
        lazy: true,
        cmd: ["web"],
        tools: ["web_search", "fetch_content", "get_search_content"],
        keywords: ["web search", "search the web", "fetch url", "youtube"],
        description: "Web search / fetch / video"
      },
      {
        name: "mcp",
        source: "npm:pi-mcp-adapter",
        lazy: true,
        cmd: ["mcp"],
        keywords: ["mcp", "playwright", "clickup"],
        description: "MCP server bridge"
      },
      {
        name: "context-mode",
        source: "npm:context-mode",
        lazy: true,
        cmd: ["context-mode", "ctx"],
        tools: ["ctx_execute", "ctx_search", "ctx_index"],
        keywords: ["context-mode", "ctx_execute"],
        description: "Context-mode tools + skills"
      },
      {
        name: "lens",
        source: "npm:pi-lens",
        lazy: true,
        cmd: ["lens"],
        tools: ["lens_diagnostics", "symbol_search", "module_report", "lsp_diagnostics"],
        keywords: ["diagnostics", "symbol search", "ast-grep", "lsp"],
        description: "pi-lens code intelligence"
      },
      {
        name: "plannotator",
        source: "npm:@plannotator/pi-extension",
        lazy: true,
        cmd: ["plannotator", "plan"],
        keywords: ["plannotator", "plan mode"],
        description: "Plan mode / plannotator"
      }
    ]
  };
}
function normalizeMode(value, fallback = true) {
  if (value === false || value === true || value === "after-start") return value;
  return fallback;
}
function normalizePositiveInteger(value, fallback) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}
function normalizeNonNegativeInteger(value, fallback) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}
function normalizeBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}
function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function normalizeStringArray(value, field, issues) {
  if (value === void 0) return void 0;
  if (!Array.isArray(value)) {
    issues.push(`${field} must be an array of strings`);
    return void 0;
  }
  const result = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim().length === 0) {
      issues.push(`${field} contains an empty or non-string value`);
      continue;
    }
    const normalized = item.trim();
    if (!result.includes(normalized)) result.push(normalized);
  }
  return result.length > 0 ? result : void 0;
}
function normalizeSpec(value, index, defaultsLazy, issues) {
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
  const lazy = value.lazy === void 0 ? defaultsLazy : normalizeMode(value.lazy, defaultsLazy);
  if (value.lazy !== void 0 && lazy === defaultsLazy && value.lazy !== defaultsLazy) {
    issues.push(`${field}.lazy must be false, true, or "after-start"`);
  }
  let priority;
  if (value.priority !== void 0) {
    if (typeof value.priority === "number" && Number.isFinite(value.priority) && Number.isInteger(value.priority)) {
      priority = value.priority;
    } else {
      issues.push(`${field}.priority must be a finite integer`);
    }
  }
  const description = value.description === void 0 || typeof value.description === "string" ? value.description : void 0;
  if (value.description !== void 0 && description === void 0) {
    issues.push(`${field}.description must be a string`);
  }
  let loadInSubagents;
  if (value.loadInSubagents !== void 0) {
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
    ...priority === void 0 ? {} : { priority },
    ...description === void 0 ? {} : { description },
    ...loadInSubagents === void 0 ? {} : { loadInSubagents },
    cmd: normalizeStringArray(value.cmd, `${field}.cmd`, issues),
    tools: normalizeStringArray(value.tools, `${field}.tools`, issues),
    keys: normalizeStringArray(value.keys, `${field}.keys`, issues),
    event: normalizeStringArray(value.event, `${field}.event`, issues),
    keywords: normalizeStringArray(value.keywords, `${field}.keywords`, issues),
    dependencies: normalizeStringArray(value.dependencies, `${field}.dependencies`, issues)
  };
}
function reportConfigIssues(path, issues) {
  for (const issue of issues) console.error(`[pi-lazy] invalid ${path}: ${issue}`);
}
function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  let fd;
  try {
    const mode = existsSync(path) ? statSync(path).mode : 384;
    fd = openSync(tempPath, "wx", mode);
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}
`, "utf-8");
    fsyncSync(fd);
    closeSync(fd);
    fd = void 0;
    renameSync(tempPath, path);
    try {
      const dirFd = openSync(dirname(path), "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch {
    }
  } catch (err) {
    if (fd !== void 0) {
      try {
        closeSync(fd);
      } catch {
      }
    }
    try {
      unlinkSync(tempPath);
    } catch {
    }
    throw err;
  }
}
function loadConfig(agentDir = getAgentDir()) {
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
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (!isRecord(parsed)) throw new Error("root must be a JSON object");
    const raw = parsed;
    const issues = [];
    const supportedVersion = raw.version === void 0 || raw.version === CONFIG_VERSION;
    if (!supportedVersion) {
      issues.push(`unsupported version ${String(raw.version)} (expected ${CONFIG_VERSION})`);
    }
    const defaults = isRecord(raw.defaults) ? raw.defaults : {};
    if (raw.defaults !== void 0 && !isRecord(raw.defaults)) issues.push("defaults must be an object");
    const defaultsLazy = normalizeMode(defaults.lazy, true);
    if (defaults.lazy !== void 0 && defaultsLazy === true && defaults.lazy !== true) {
      issues.push('defaults.lazy must be false, true, or "after-start"');
    }
    const specs = [];
    const names = /* @__PURE__ */ new Set();
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
        DEFAULT_AFTER_START_INITIAL_DELAY_MS
      ),
      afterStartPauseDuringTurn: normalizeBoolean(raw.afterStartPauseDuringTurn, true),
      afterStartAdaptiveYield: normalizeBoolean(raw.afterStartAdaptiveYield, true),
      afterStartPrefetch: normalizeBoolean(raw.afterStartPrefetch, true),
      specs
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[pi-lazy] failed to parse lazy.json: ${message}`);
    return defaultConfig();
  }
}
function saveConfig(config, agentDir = getAgentDir()) {
  const path = getLazyConfigPath(agentDir);
  atomicWriteJson(path, config);
  return path;
}
function isManagedLazy(spec) {
  return spec.lazy !== false;
}

// src/loader.ts
import { existsSync as existsSync2, readFileSync as readFileSync2, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname as dirname2, join as join2 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
function fileUrl(path) {
  return pathToFileURL(path).href;
}
function asFactory(mod) {
  if (typeof mod === "function") return mod;
  if (mod && typeof mod === "object") {
    const d = mod.default;
    if (typeof d === "function") return d;
  }
  return null;
}
var cachedPiPackageJson;
var cachedCreateJiti;
var aliasesPromise;
var jitiInstance;
function resolvePiPackageJson() {
  if (cachedPiPackageJson !== void 0) return cachedPiPackageJson;
  const finish = (value) => cachedPiPackageJson = value;
  try {
    const bin = realpathSync(process.argv[1] ?? "");
    let dir = dirname2(bin);
    for (let i = 0; i < 10; i++) {
      const pkgPath = join2(dir, "package.json");
      if (existsSync2(pkgPath)) {
        try {
          const name = JSON.parse(readFileSync2(pkgPath, "utf-8")).name;
          if (name === "@earendil-works/pi-coding-agent" || name === "@mariozechner/pi-coding-agent") {
            return finish(pkgPath);
          }
        } catch {
        }
      }
      const parent = dirname2(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
  }
  try {
    const url = import.meta.resolve("@earendil-works/pi-coding-agent/package.json");
    return finish(fileURLToPath(url));
  } catch {
  }
  try {
    const require2 = createRequire(import.meta.url);
    return finish(require2.resolve("@earendil-works/pi-coding-agent/package.json"));
  } catch {
  }
  for (const guess of [
    join2(dirname2(process.execPath), "../lib/node_modules/@earendil-works/pi-coding-agent/package.json"),
    join2(dirname2(process.execPath), "../lib/node_modules/@mariozechner/pi-coding-agent/package.json")
  ]) {
    if (existsSync2(guess)) return finish(guess);
  }
  return finish(null);
}
function resolveJitiCreate() {
  if (cachedCreateJiti !== void 0) return cachedCreateJiti;
  const candidates = [];
  const pushResolve = (from) => {
    try {
      const require2 = createRequire(from);
      candidates.push(require2.resolve("jiti"));
    } catch {
    }
  };
  const piPkg = resolvePiPackageJson();
  if (piPkg) pushResolve(piPkg);
  pushResolve(fileURLToPath(import.meta.url));
  if (piPkg) {
    let dir = dirname2(piPkg);
    for (let i = 0; i < 6; i++) {
      const nested = join2(dir, "node_modules", "jiti", "lib", "jiti.cjs");
      const nestedPkg = join2(dir, "node_modules", "jiti", "package.json");
      if (existsSync2(nestedPkg)) {
        try {
          const require2 = createRequire(nestedPkg);
          candidates.push(require2.resolve("jiti"));
        } catch {
          if (existsSync2(nested)) candidates.push(nested);
        }
        break;
      }
      const parent = dirname2(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  for (const jitiPath of [...new Set(candidates)]) {
    try {
      const require2 = createRequire(jitiPath);
      const jitiMod = require2(jitiPath);
      if (typeof jitiMod?.createJiti === "function") {
        return cachedCreateJiti = jitiMod.createJiti.bind(jitiMod);
      }
      if (typeof jitiMod === "function") {
        return cachedCreateJiti = jitiMod;
      }
    } catch {
    }
  }
  return cachedCreateJiti = null;
}
async function importFactory(extensionPath) {
  if (/\.(js|mjs|cjs)$/.test(extensionPath)) {
    try {
      const mod = await import(fileUrl(extensionPath));
      const factory = asFactory(mod);
      if (factory) return factory;
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? String(err.code) : "";
      if (!(err instanceof SyntaxError) && ![
        "ERR_MODULE_NOT_FOUND",
        "ERR_PACKAGE_PATH_NOT_EXPORTED",
        "ERR_UNKNOWN_FILE_EXTENSION"
      ].includes(code)) {
        throw new Error(`Failed to import extension module ${extensionPath}: ${err instanceof Error ? err.message : String(err)}`, {
          cause: err
        });
      }
    }
  }
  const createJiti = resolveJitiCreate();
  if (!createJiti) {
    throw new Error("jiti not available \u2014 cannot load TypeScript extensions at runtime");
  }
  try {
    const aliases = await (aliasesPromise ??= buildAliases());
    const jiti = jitiInstance ??= createJiti(import.meta.url, {
      interopDefault: true,
      // Keep transformed extension modules fresh across reloads.
      moduleCache: false,
      alias: aliases
    });
    if (jiti && typeof jiti.import === "function") {
      try {
        const mod2 = await jiti.import(extensionPath, { default: true });
        const factory = asFactory(mod2);
        if (factory) return factory;
      } catch (firstErr) {
        const msg = firstErr instanceof Error ? firstErr.message : String(firstErr);
        if (/does not provide an export named|default/i.test(msg)) {
          const mod2 = await jiti.import(extensionPath);
          return asFactory(mod2);
        }
        throw firstErr;
      }
      const mod = await jiti.import(extensionPath);
      return asFactory(mod);
    }
    throw new Error("jiti instance missing async import()");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to import extension module ${extensionPath}: ${message}`, { cause: err });
  }
}
function tryResolveFrom(fromPkgJson, spec) {
  if (!fromPkgJson) return null;
  try {
    const require2 = createRequire(fromPkgJson);
    return require2.resolve(spec);
  } catch {
    return null;
  }
}
function firstExisting(...paths) {
  for (const p of paths) {
    if (p && existsSync2(p)) return p;
  }
  return null;
}
async function buildAliases() {
  const aliases = {};
  const piPkg = resolvePiPackageJson();
  const piRoot = piPkg ? dirname2(piPkg) : null;
  const piModuleRoots = piRoot ? [join2(piRoot, "node_modules"), dirname2(dirname2(piRoot))] : [];
  const requireFromPi = piPkg ? createRequire(piPkg) : null;
  const piModule = (pkg, file) => firstExisting(...piModuleRoots.map((root) => join2(root, pkg, file)));
  const set = (spec, path) => {
    if (path) aliases[spec] = path;
  };
  const resolveSpec = (spec) => {
    try {
      const resolved = import.meta.resolve(spec);
      return resolved.startsWith("file:") ? fileURLToPath(resolved) : resolved;
    } catch {
    }
    if (requireFromPi) {
      try {
        return requireFromPi.resolve(spec);
      } catch {
      }
    }
    return tryResolveFrom(piPkg, spec);
  };
  const piCoding = firstExisting(
    resolveSpec("@earendil-works/pi-coding-agent"),
    piRoot ? join2(piRoot, "dist/index.js") : null
  );
  set("@earendil-works/pi-coding-agent", piCoding);
  set("@mariozechner/pi-coding-agent", piCoding);
  const agentCore = firstExisting(
    resolveSpec("@earendil-works/pi-agent-core"),
    piModule("@earendil-works/pi-agent-core", "dist/index.js")
  );
  set("@earendil-works/pi-agent-core", agentCore);
  set("@mariozechner/pi-agent-core", agentCore);
  const tui = firstExisting(
    resolveSpec("@earendil-works/pi-tui"),
    piModule("@earendil-works/pi-tui", "dist/index.js")
  );
  set("@earendil-works/pi-tui", tui);
  set("@mariozechner/pi-tui", tui);
  const aiCompat = firstExisting(
    resolveSpec("@earendil-works/pi-ai/compat"),
    piModule("@earendil-works/pi-ai", "dist/compat.js")
  );
  const aiOauth = firstExisting(
    resolveSpec("@earendil-works/pi-ai/oauth"),
    piModule("@earendil-works/pi-ai", "dist/oauth.js")
  );
  const aiProviders = firstExisting(
    resolveSpec("@earendil-works/pi-ai/providers/all"),
    piModule("@earendil-works/pi-ai", "dist/providers/all.js")
  );
  set("@earendil-works/pi-ai/providers/all", aiProviders);
  set("@mariozechner/pi-ai/providers/all", aiProviders);
  set("@earendil-works/pi-ai/oauth", aiOauth);
  set("@mariozechner/pi-ai/oauth", aiOauth);
  set("@earendil-works/pi-ai/compat", aiCompat);
  set("@mariozechner/pi-ai/compat", aiCompat);
  const ai = firstExisting(
    resolveSpec("@earendil-works/pi-ai"),
    piModule("@earendil-works/pi-ai", "dist/index.js")
  );
  set("@earendil-works/pi-ai", ai);
  set("@mariozechner/pi-ai", ai);
  const typebox = resolveSpec("typebox");
  const typeboxCompile = resolveSpec("typebox/compile");
  const typeboxValue = resolveSpec("typebox/value");
  set("typebox", typebox);
  set("typebox/compile", typeboxCompile);
  set("typebox/value", typeboxValue);
  set("@sinclair/typebox", typebox);
  set("@sinclair/typebox/compile", typeboxCompile);
  set("@sinclair/typebox/value", typeboxValue);
  return aliases;
}
function createTrackingApi(pi, track) {
  const on = (event, handler) => {
    if (event === "session_start") track.sessionStartHandlers.push(handler);
    if (event === "resources_discover") track.resourcesDiscoverHandlers.push(handler);
    return pi.on(event, handler);
  };
  const registerTool = (tool) => {
    track.tools.push(tool.name);
    return pi.registerTool(tool);
  };
  const registerCommand = (name, options) => {
    track.commands.push(name);
    const handler = options?.handler;
    if (typeof handler === "function") track.commandHandlers.set(name, handler);
    return pi.registerCommand(name, options);
  };
  return new Proxy(pi, {
    get(target, prop, receiver) {
      if (prop === "on") return on;
      if (prop === "registerTool") return registerTool;
      if (prop === "registerCommand") return registerCommand;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}
async function importEntryFactories(entry) {
  const factories = [];
  for (const extPath of entry.extensionPaths) {
    const factory = await importFactory(extPath);
    if (!factory) throw new Error(`Extension does not export a default factory: ${extPath}`);
    factories.push(factory);
  }
  return factories;
}
function prefetchEntry(entry) {
  if (entry.prefetchPromise) return entry.prefetchPromise;
  if (entry.prefetchedFactories) return Promise.resolve();
  if (entry.state !== "pending" || !entry.moduleLazyReady) return Promise.resolve();
  if (!entry.packageRoot || entry.extensionPaths.length === 0) return Promise.resolve();
  const started = Date.now();
  const promise = importEntryFactories(entry).then((factories) => {
    entry.prefetchedFactories = factories;
    entry.prefetchMs = Date.now() - started;
  }).catch(() => {
    entry.prefetchedFactories = void 0;
  }).finally(() => {
    if (entry.prefetchPromise === promise) entry.prefetchPromise = void 0;
  });
  entry.prefetchPromise = promise;
  return promise;
}
async function loadResolvedEntry(entry, pi, ctx, deps) {
  const { spec } = entry;
  const ancestry = deps.ancestry ?? [];
  if (ancestry.includes(spec.name)) {
    return {
      ok: false,
      name: spec.name,
      error: `dependency cycle: ${[...ancestry, spec.name].join(" -> ")}`
    };
  }
  if (entry.state === "loaded") {
    return {
      ok: true,
      name: spec.name,
      alreadyLoaded: true,
      tools: entry.loadedTools,
      commands: entry.loadedCommands,
      // IMPORTANT: LoadResult must stay structuredClone-safe. Never include
      // commandHandlers (Map<string, Function>) here — pi structuredClones
      // tool-result `details` for the transcript and functions throw
      // DataCloneError: "... could not be cloned."
      loadMs: entry.loadMs
    };
  }
  if (entry.state === "poisoned") {
    return { ok: false, name: spec.name, error: entry.error ?? "partial activation failed \u2014 restart required" };
  }
  if (entry.loadPromise) return entry.loadPromise;
  if (entry.state === "loading") {
    return { ok: false, name: spec.name, error: "already loading" };
  }
  if (!entry.moduleLazyReady) {
    return {
      ok: false,
      name: spec.name,
      error: "not module-lazy ready \u2014 run /lazy migrate and restart pi (package still eager-loaded by settings)"
    };
  }
  if (!entry.packageRoot || entry.extensionPaths.length === 0) {
    return {
      ok: false,
      name: spec.name,
      error: entry.packageRoot ? "no extension entrypoints found in package" : `package not installed for ${spec.source}`
    };
  }
  entry.state = "loading";
  const loadPromise = (async () => {
    const started = Date.now();
    const track = {
      tools: [],
      commands: [],
      commandHandlers: /* @__PURE__ */ new Map(),
      sessionStartHandlers: [],
      resourcesDiscoverHandlers: []
    };
    const api = createTrackingApi(pi, track);
    let activationStarted = false;
    try {
      for (const dep of spec.dependencies ?? []) {
        const depResult = await deps.loadDependency(dep, [...ancestry, spec.name]);
        if (!depResult.ok && !depResult.alreadyLoaded) {
          throw new Error(`dependency ${dep} failed: ${depResult.error}`);
        }
      }
      if (entry.prefetchPromise) await entry.prefetchPromise;
      const factories = entry.prefetchedFactories ?? await importEntryFactories(entry);
      entry.prefetchedFactories = void 0;
      for (const factory of factories) {
        activationStarted = true;
        await factory(api);
      }
      if (ctx && track.sessionStartHandlers.length > 0) {
        const event = { type: "session_start", reason: "startup" };
        for (const handler of track.sessionStartHandlers) {
          try {
            await handler(event, ctx);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[pi-lazy] session_start handler error in ${spec.name}: ${message}`);
          }
        }
      }
      if (ctx && track.resourcesDiscoverHandlers.length > 0) {
        const event = { type: "resources_discover", cwd: ctx.cwd, reason: "startup" };
        for (const handler of track.resourcesDiscoverHandlers) {
          try {
            await handler(event, ctx);
          } catch {
          }
        }
      }
      if (track.tools.length > 0 && typeof pi.getActiveTools === "function" && typeof pi.setActiveTools === "function") {
        try {
          const active = pi.getActiveTools();
          const merged = [.../* @__PURE__ */ new Set([...active, ...track.tools])];
          pi.setActiveTools(merged);
        } catch {
        }
      }
      const loadMs = Date.now() - started;
      entry.state = "loaded";
      entry.loadedAt = Date.now();
      entry.loadMs = loadMs;
      entry.loadedTools = [...new Set(track.tools)];
      entry.loadedCommands = [...new Set(track.commands)];
      entry.loadedCommandHandlers = track.commandHandlers;
      entry.error = void 0;
      return {
        ok: true,
        name: spec.name,
        loadMs,
        tools: entry.loadedTools,
        commands: entry.loadedCommands
        // IMPORTANT: LoadResult must stay structuredClone-safe. Never include
        // commandHandlers (Map<string, Function>) here — pi structuredClones
        // tool-result `details` for the transcript and functions throw
        // DataCloneError: "... could not be cloned."
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      entry.state = activationStarted ? "poisoned" : "error";
      entry.error = activationStarted ? `${message} (partial activation may have occurred \u2014 restart required)` : message;
      return { ok: false, name: spec.name, error: entry.error };
    }
  })();
  entry.loadPromise = loadPromise;
  try {
    return await loadPromise;
  } finally {
    entry.loadPromise = void 0;
  }
}

// src/migrate.ts
import { copyFileSync, existsSync as existsSync4, readFileSync as readFileSync4 } from "node:fs";
import { getAgentDir as getAgentDir3 } from "@earendil-works/pi-coding-agent";

// src/resolve.ts
import { existsSync as existsSync3, readdirSync, readFileSync as readFileSync3, statSync as statSync2 } from "node:fs";
import { isAbsolute, join as join3, relative, resolve, sep } from "node:path";
import { getAgentDir as getAgentDir2 } from "@earendil-works/pi-coding-agent";
function isRecord2(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function safeIsDirectory(path) {
  try {
    return statSync2(path).isDirectory();
  } catch {
    return false;
  }
}
function npmPackageName(source) {
  if (source.startsWith("npm:")) {
    const rest = source.slice(4);
    if (rest.startsWith("@")) {
      const m = rest.match(/^(@[^/]+\/[^@]+)/);
      return m?.[1] ?? rest;
    }
    return rest.split("@")[0] ?? rest;
  }
  if (!source.includes(":") && !source.startsWith(".") && !source.startsWith("/")) {
    return source.startsWith("@") ? source.match(/^(@[^/]+\/[^@]+)/)?.[1] ?? source : source.split("@")[0];
  }
  return null;
}
function npmPackageIdentity(source) {
  const name = npmPackageName(source);
  if (!name) return null;
  const rest = source.startsWith("npm:") ? source.slice(4) : source;
  const selector = rest.slice(name.length);
  return { name, ...selector.startsWith("@") && selector.length > 1 ? { selector: selector.slice(1) } : {} };
}
function resolvePackageRoot(source, agentDir = getAgentDir2(), cwd = process.cwd()) {
  const npmName = npmPackageName(source);
  if (npmName) {
    const candidates = [
      join3(agentDir, "npm", "node_modules", npmName),
      join3(cwd, ".pi", "npm", "node_modules", npmName)
    ];
    for (const c of candidates) {
      if (safeIsDirectory(c)) return c;
    }
    return null;
  }
  if (source.startsWith("git:") || source.startsWith("https://") || source.startsWith("http://") || source.startsWith("ssh://")) {
    const gitRoot = join3(agentDir, "git");
    if (existsSync3(gitRoot)) {
    }
    return null;
  }
  const local = resolve(cwd, source);
  if (safeIsDirectory(local)) return local;
  return null;
}
function readPiManifest(packageRoot) {
  const pj = join3(packageRoot, "package.json");
  if (!existsSync3(pj)) return null;
  try {
    const pkg = JSON.parse(readFileSync3(pj, "utf-8"));
    if (!isRecord2(pkg) || !isRecord2(pkg.pi)) return null;
    const extensions = Array.isArray(pkg.pi.extensions) ? pkg.pi.extensions.filter((entry) => typeof entry === "string" && entry.length > 0) : void 0;
    return { extensions };
  } catch {
    return null;
  }
}
function isExtensionFile(name) {
  return name.endsWith(".ts") || name.endsWith(".js") || name.endsWith(".mts") || name.endsWith(".mjs");
}
function resolveExtensionEntries(packageRoot) {
  const manifest = readPiManifest(packageRoot);
  if (manifest?.extensions?.length) {
    const entries = [];
    for (const extPath of manifest.extensions) {
      const resolved = resolve(packageRoot, extPath);
      const withinRoot = relative(packageRoot, resolved);
      if (withinRoot === ".." || withinRoot.startsWith(`..${sep}`) || isAbsolute(withinRoot)) continue;
      if (!existsSync3(resolved)) continue;
      let st;
      try {
        st = statSync2(resolved);
      } catch {
        continue;
      }
      if (st.isFile() && isExtensionFile(resolved)) {
        entries.push(resolved);
        continue;
      }
      if (st.isDirectory()) {
        const indexTs2 = join3(resolved, "index.ts");
        const indexJs2 = join3(resolved, "index.js");
        if (existsSync3(indexTs2)) entries.push(indexTs2);
        else if (existsSync3(indexJs2)) entries.push(indexJs2);
        else {
          try {
            for (const item of readdirSync(resolved, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
              if (item.isFile() && isExtensionFile(item.name)) {
                entries.push(join3(resolved, item.name));
              }
            }
          } catch {
          }
        }
      }
    }
    if (entries.length > 0) return entries;
  }
  const indexTs = join3(packageRoot, "index.ts");
  const indexJs = join3(packageRoot, "index.js");
  if (existsSync3(indexTs)) return [indexTs];
  if (existsSync3(indexJs)) return [indexJs];
  return [];
}
function resolveSpecPaths(spec, agentDir = getAgentDir2(), cwd = process.cwd()) {
  const packageRoot = resolvePackageRoot(spec.source, agentDir, cwd);
  if (!packageRoot) {
    return { packageRoot: null, extensionPaths: [] };
  }
  return {
    packageRoot,
    extensionPaths: resolveExtensionEntries(packageRoot)
  };
}
function isModuleLazyInSettings(source, settingsPackages) {
  const matches = [];
  for (const entry of settingsPackages) {
    if (typeof entry === "string") {
      if (sourcesMatch(entry, source)) matches.push(entry);
      continue;
    }
    if (entry && typeof entry === "object") {
      const obj = entry;
      if (typeof obj.source === "string" && sourcesMatch(obj.source, source)) matches.push(entry);
    }
  }
  if (matches.length !== 1) return false;
  const match = matches[0];
  return !!match && typeof match === "object" && Array.isArray(match.extensions) && match.extensions.length === 0;
}
function normalizeSourceKey(source) {
  const trimmed = source.trim();
  const npm = npmPackageName(trimmed);
  if (npm) return `npm:${trimmed.startsWith("npm:") ? trimmed.slice(4) : trimmed}`;
  return trimmed;
}
function sourcesMatch(left, right) {
  const leftNpm = npmPackageIdentity(left);
  const rightNpm = npmPackageIdentity(right);
  if (leftNpm || rightNpm) {
    if (!leftNpm || !rightNpm || leftNpm.name !== rightNpm.name) return false;
    return !leftNpm.selector || !rightNpm.selector || leftNpm.selector === rightNpm.selector;
  }
  return normalizeSourceKey(left) === normalizeSourceKey(right);
}
function findSettingsPackageIndex(settingsPackages, source) {
  return findSettingsPackageIndices(settingsPackages, source)[0] ?? -1;
}
function findSettingsPackageIndices(settingsPackages, source) {
  const indices = [];
  settingsPackages.forEach((entry, index) => {
    if (typeof entry === "string") {
      if (sourcesMatch(entry, source)) indices.push(index);
      return;
    }
    if (entry && typeof entry === "object" && typeof entry.source === "string") {
      if (sourcesMatch(entry.source, source)) indices.push(index);
      return;
    }
  });
  return indices;
}

// src/migrate.ts
function packageSource(spec) {
  if (spec.source.startsWith("npm:") || spec.source.startsWith("git:") || spec.source.startsWith("http://") || spec.source.startsWith("https://") || spec.source.startsWith("ssh://") || spec.source.startsWith("/") || spec.source.startsWith(".")) {
    return spec.source;
  }
  return `npm:${spec.source}`;
}
function migrateSettings(agentDir = getAgentDir3()) {
  const settingsPath = getSettingsPath(agentDir);
  const config = loadConfig(agentDir);
  const managed = config.specs.filter(isManagedLazy);
  if (!existsSync4(settingsPath)) {
    return { ok: false, settingsPath, changed: [], skipped: [], added: [], error: "settings.json not found" };
  }
  let settings;
  try {
    const parsed = JSON.parse(readFileSync4(settingsPath, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("settings.json root must be an object");
    }
    settings = parsed;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, settingsPath, changed: [], skipped: [], added: [], error: message };
  }
  const packages = Array.isArray(settings.packages) ? [...settings.packages] : [];
  const changed = [];
  const skipped = [];
  const added = [];
  for (const spec of config.specs) {
    const matches = findSettingsPackageIndices(packages, spec.source);
    if (matches.length > 1) {
      return {
        ok: false,
        settingsPath,
        changed,
        skipped,
        added,
        error: `duplicate settings.packages entries for ${spec.source} at indices ${matches.join(", ")}`
      };
    }
  }
  for (const spec of managed) {
    const source = packageSource(spec);
    const idx = findSettingsPackageIndex(packages, spec.source);
    if (idx === -1) {
      packages.push({ source, extensions: [] });
      added.push(spec.name);
      changed.push(`${spec.name} (added)`);
      continue;
    }
    const current = packages[idx];
    if (typeof current === "string") {
      packages[idx] = { source: current, extensions: [] };
      changed.push(spec.name);
      continue;
    }
    if (current && typeof current === "object") {
      const obj = { ...current };
      if (Array.isArray(obj.extensions) && obj.extensions.length === 0) {
        skipped.push(spec.name);
        continue;
      }
      obj.extensions = [];
      if (typeof obj.source !== "string") obj.source = source;
      packages[idx] = obj;
      changed.push(spec.name);
      continue;
    }
    skipped.push(spec.name);
  }
  for (const spec of config.specs.filter((s) => s.lazy === false)) {
    const idx = findSettingsPackageIndex(packages, spec.source);
    if (idx === -1) continue;
    const current = packages[idx];
    if (!current || typeof current !== "object") continue;
    const obj = current;
    if (!(Array.isArray(obj.extensions) && obj.extensions.length === 0 && typeof obj.source === "string")) {
      continue;
    }
    const restored = { ...obj };
    delete restored.extensions;
    packages[idx] = Object.keys(restored).length === 1 ? restored.source : restored;
    changed.push(`${spec.name} (restored eager)`);
  }
  if (changed.length === 0) {
    return { ok: true, settingsPath, changed, skipped, added };
  }
  const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
  const backupPath = `${settingsPath}.bak.lazy-${stamp}`;
  try {
    copyFileSync(settingsPath, backupPath);
    settings.packages = packages;
    atomicWriteJson(settingsPath, settings);
    return { ok: true, backupPath, settingsPath, changed, skipped, added };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, backupPath, settingsPath, changed, skipped, added, error: message };
  }
}

// src/index.ts
import { performance } from "node:perf_hooks";
import { copyFileSync as copyFileSync2, existsSync as existsSync5, readFileSync as readFileSync5 } from "node:fs";
function isNonEmptyEnv(name) {
  return Boolean(process.env[name]?.trim());
}
var CHILD_MARKER_KEYS = [
  "PI_IS_SUBAGENT",
  "PI_SUBAGENT_NAME",
  "PI_SUBAGENT_ID",
  "PI_SUBAGENT_RUN_ID",
  "PI_SUBAGENT_SESSION_ID",
  "PI_SUBAGENT_SESSION",
  "PI_SUBAGENT_ACTIVITY_FILE",
  "PI_AGENT_ROUTER_SUBAGENT"
];
function isChildProcess() {
  const childFlag = process.env.PI_SUBAGENT_CHILD?.trim().toLowerCase();
  if (childFlag === "1" || childFlag === "true") return true;
  if (CHILD_MARKER_KEYS.some((key) => isNonEmptyEnv(key))) return true;
  return isNonEmptyEnv("PI_SUBAGENT_CHILD_AGENT") && isNonEmptyEnv("PI_SUBAGENT_PARENT_PID");
}
function activeSpecs(config) {
  if (!isChildProcess()) return config.specs;
  return config.specs.filter((spec) => spec.loadInSubagents === true);
}
var MAX_ADAPTIVE_YIELD_MS = 250;
var PAUSE_TIMEOUT_MS = 6e4;
function sleep(ms) {
  return new Promise((resolve2) => {
    setTimeout(resolve2, ms);
  });
}
function drainResumeWaiters(rt) {
  const waiters = rt.resumeWaiters;
  rt.resumeWaiters = [];
  for (const resolve2 of waiters) resolve2();
}
function waitWhilePaused(rt, generation) {
  if (!rt.turnActive) return Promise.resolve();
  if (rt.queueCancelled || generation !== rt.sessionGeneration) return Promise.resolve();
  return new Promise((resolve2) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve2();
    };
    const timer = setTimeout(finish, PAUSE_TIMEOUT_MS);
    timer.unref?.();
    rt.resumeWaiters.push(finish);
  });
}
function readSettingsPackages(agentDir) {
  const path = getSettingsPath(agentDir);
  if (!existsSync5(path)) return [];
  try {
    const settings = JSON.parse(readFileSync5(path, "utf-8"));
    return Array.isArray(settings.packages) ? settings.packages : [];
  } catch {
    return [];
  }
}
function buildCatalog(config, agentDir) {
  const packages = readSettingsPackages(agentDir);
  const map = /* @__PURE__ */ new Map();
  for (const spec of activeSpecs(config)) {
    const managed = isManagedLazy(spec);
    const moduleLazyReady = managed && isModuleLazyInSettings(spec.source, packages);
    let state;
    if (!managed) {
      state = "eager";
    } else if (!moduleLazyReady) {
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
      normalizedKeywords: (spec.keywords ?? []).map((keyword) => keyword.toLowerCase())
    });
  }
  return map;
}
function formatStatus(rt) {
  const all = [...rt.entries.values()];
  const loaded = all.filter((e) => e.state === "loaded").length;
  const pending = all.filter((e) => e.state === "pending").length;
  const eager = all.filter((e) => e.state === "eager").length;
  const errors = all.filter((e) => e.state === "error" || e.state === "poisoned").length;
  const parts = [`lazy ${loaded}\u2191`, `${pending}\xB7`, `${eager}\u26A1`];
  if (errors) parts.push(`${errors}\u2717`);
  if (rt.restartRequired) parts.push("restart required");
  return parts.join(" ");
}
function refreshStatus(pi, rt, ctx) {
  rt.status = formatStatus(rt);
  const target = rt.sessionCtx ?? ctx;
  if (!target) return;
  try {
    const ui = target.ui;
    if (ui && typeof ui.setStatus === "function") {
      ui.setStatus("pi-lazy", rt.status);
    }
  } catch {
  }
}
function notifySafe(ctx, message, type) {
  if (!ctx) return;
  try {
    ctx.ui.notify(message, type);
  } catch {
  }
}
function recordTiming(rt, label, started) {
  rt.profile.push({ label, ms: performance.now() - started });
  if (rt.profile.length > 100) rt.profile.shift();
}
function ensureResolved(rt, entry, ctx) {
  if (entry.resolveAttempted) return true;
  const started = performance.now();
  try {
    const resolved = resolveSpecPaths(entry.spec, getAgentDir4(), (ctx ?? rt.sessionCtx)?.cwd ?? process.cwd());
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
async function prefetchQuietly(rt, entry, ctx) {
  try {
    if (entry.state !== "pending" || !entry.moduleLazyReady) return;
    if (!ensureResolved(rt, entry, ctx)) return;
    const started = performance.now();
    await prefetchEntry(entry);
    if (entry.prefetchedFactories) recordTiming(rt, `prefetch:${entry.spec.name}`, started);
  } catch {
  }
}
async function loadByName(pi, rt, name, ctx, ancestry = []) {
  const key = name.trim();
  if (!key) return { ok: false, name: key, error: "spec name must not be empty" };
  const entry = rt.entries.get(key) ?? [...rt.entries.values()].find(
    (e) => e.spec.source === key || e.spec.name.toLowerCase() === key.toLowerCase()
  );
  if (!entry) {
    return { ok: false, name: key, error: `unknown spec '${key}' \u2014 see /lazy list` };
  }
  if (entry.state === "eager") {
    return {
      ok: true,
      name: entry.spec.name,
      alreadyLoaded: true,
      error: void 0
    };
  }
  if (!ensureResolved(rt, entry, ctx)) {
    return { ok: false, name: entry.spec.name, error: entry.error };
  }
  const started = performance.now();
  const result = await loadResolvedEntry(entry, pi, ctx ?? rt.sessionCtx, {
    ancestry,
    loadDependency: (dep, nextAncestry) => loadByName(pi, rt, dep, ctx, nextAncestry)
  });
  recordTiming(rt, `load:${entry.spec.name}`, started);
  refreshStatus(pi, rt, ctx ?? rt.sessionCtx);
  return result;
}
function registerStubs(pi, rt) {
  const cmdOwners = /* @__PURE__ */ new Map();
  const toolOwners = /* @__PURE__ */ new Map();
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
        pi.registerShortcut(key, {
          description: `Load lazy package ${spec.name}`,
          handler: async (ctx) => {
            const res = await loadByName(pi, rt, spec.name, ctx);
            ctx.ui.notify(
              res.ok ? res.alreadyLoaded ? `${spec.name} already loaded` : `loaded ${spec.name}${res.loadMs != null ? ` (${res.loadMs}ms)` : ""}` : `failed ${spec.name}: ${res.error}`,
              res.ok ? "info" : "error"
            );
          }
        });
      } catch {
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
        const real = rt.entries.get(owner)?.loadedCommandHandlers?.get(cmd);
        if (real) {
          await real(args, ctx);
          return;
        }
        ctx.ui.notify(
          `lazy: '${owner}' loaded but did not register /${cmd}; update lazy.json to the package's actual command name`,
          "error"
        );
      }
    });
  }
  for (const [toolName, owner] of toolOwners) {
    pi.registerTool({
      name: toolName,
      label: `Lazy: ${toolName}`,
      description: `Lazy stub for ${toolName}. Loads package '${owner}' on first use, then activates the real tool. Call again after activation if needed.`,
      parameters: Type.Object({
        _lazy: Type.Optional(Type.String({ description: "Ignored. Present so the tool is valid before load." }))
      }, { additionalProperties: true }),
      async execute(_id, _params, _signal, _onUpdate, ctx) {
        const res = await loadByName(pi, rt, owner, ctx);
        if (!res.ok) {
          return {
            content: [{ type: "text", text: `Failed to load '${owner}': ${res.error}` }],
            details: { ok: false, error: res.error }
          };
        }
        const tools = res.tools?.length ? res.tools.join(", ") : "(see package)";
        return {
          content: [
            {
              type: "text",
              text: res.alreadyLoaded ? `Package '${owner}' already available. Use the real tools now.` : `Loaded '${owner}'${res.loadMs != null ? ` in ${res.loadMs}ms` : ""}. Registered tools: ${tools}. Call the real tool again on the next turn.`
            }
          ],
          details: { ok: true, loaded: owner, tools: res.tools ?? [], alreadyLoaded: !!res.alreadyLoaded }
        };
      }
    });
  }
}
function registerEventTriggers(pi, rt) {
  const eventMap = /* @__PURE__ */ new Map();
  for (const entry of rt.entries.values()) {
    if (entry.state !== "pending") continue;
    for (const ev of entry.spec.event ?? []) {
      const list = eventMap.get(ev) ?? [];
      list.push(entry.spec.name);
      eventMap.set(ev, list);
    }
  }
  const loadTriggered = async (names, ctx) => {
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
  pi.on("before_agent_start", async (event, ctx) => {
    rt.turnActive = true;
    if (!rt.auto) return;
    const prompt = (event.prompt ?? "").toLowerCase();
    const toLoad = /* @__PURE__ */ new Set();
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
      pi.on(eventName, async (_event, ctx) => {
        if (rt.auto) await loadTriggered(owners, ctx);
      });
    } catch (err) {
      console.error(`[pi-lazy] unsupported event trigger '${eventName}': ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
async function runAfterStart(pi, rt, ctx, generation) {
  const queue = [...rt.entries.values()].filter((e) => e.state === "pending" && e.spec.lazy === "after-start").sort((a, b) => (a.spec.priority ?? 100) - (b.spec.priority ?? 100));
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
    if (prefetch) {
      for (const entry of next) void prefetchQuietly(rt, entry, rt.sessionCtx ?? ctx);
    }
    let blockedMs = 0;
    for (const entry of batch) {
      if (stale()) return;
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
      const yieldMs = adaptive ? Math.max(delayMs, Math.min(Math.round(blockedMs), MAX_ADAPTIVE_YIELD_MS)) : delayMs;
      await sleep(yieldMs);
    }
  }
  refreshStatus(pi, rt, rt.sessionCtx ?? ctx);
}
function listLines(rt) {
  const lines = [];
  const order = ["pending", "loading", "loaded", "error", "poisoned", "eager"];
  const sorted = [...rt.entries.values()].sort((a, b) => {
    const ai = order.indexOf(a.state);
    const bi = order.indexOf(b.state);
    if (ai !== bi) return ai - bi;
    return a.spec.name.localeCompare(b.spec.name);
  });
  for (const e of sorted) {
    const mode = e.spec.lazy === false ? "eager" : e.spec.lazy === "after-start" ? "after-start" : "on-demand";
    const ms = e.loadMs != null ? ` ${e.loadMs}ms` : "";
    const err = e.error ? ` \u2014 ${e.error}` : "";
    const ready = e.moduleLazyReady ? "" : e.state === "eager" && isManagedLazy(e.spec) ? " (migrate+restart needed)" : "";
    lines.push(`${e.state.padEnd(8)} ${e.spec.name.padEnd(16)} ${mode.padEnd(12)} ${e.spec.source}${ms}${ready}${err}`);
  }
  return lines;
}
function createPiLazy(pi, agentDir = getAgentDir4()) {
  const config = loadConfig(agentDir);
  const catalogStarted = performance.now();
  const rt = {
    config,
    entries: buildCatalog(config, agentDir),
    auto: config.auto !== false,
    afterStartQueued: false,
    status: "lazy \u2026",
    profile: [],
    queueCancelled: false,
    sessionGeneration: 0,
    restartRequired: false,
    turnActive: false,
    resumeWaiters: []
  };
  recordTiming(rt, "catalog", catalogStarted);
  registerStubs(pi, rt);
  registerEventTriggers(pi, rt);
  const endTurn = () => {
    rt.turnActive = false;
    drainResumeWaiters(rt);
  };
  try {
    pi.on("agent_end", () => {
      endTurn();
    });
    pi.on("agent_settled", () => {
      endTurn();
    });
  } catch (err) {
    console.error(`[pi-lazy] turn-end events unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  pi.on("session_start", async (event, ctx) => {
    rt.sessionGeneration++;
    const generation = rt.sessionGeneration;
    rt.sessionCtx = ctx;
    rt.queueCancelled = false;
    rt.turnActive = false;
    drainResumeWaiters(rt);
    refreshStatus(pi, rt, ctx);
    const needsMigrate = [...rt.entries.values()].some(
      (e) => isManagedLazy(e.spec) && !e.moduleLazyReady
    );
    if (needsMigrate && event.reason === "startup") {
      ctx.ui.notify("pi-lazy: run /lazy migrate then restart for true module-lazy", "info");
    }
    rt.afterStartQueued = true;
    const initialDelayMs = rt.config.afterStartInitialDelayMs ?? DEFAULT_AFTER_START_INITIAL_DELAY_MS;
    setTimeout(() => {
      void runAfterStart(pi, rt, ctx, generation).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[pi-lazy] after-start queue failed: ${message}`);
        notifySafe(rt.sessionCtx, `lazy: after-start queue failed: ${message}`, "warning");
      }).finally(() => {
        if (generation === rt.sessionGeneration) rt.afterStartQueued = false;
      });
    }, initialDelayMs);
  });
  pi.on("session_shutdown", () => {
    rt.sessionGeneration++;
    rt.sessionCtx = void 0;
    rt.afterStartQueued = false;
    rt.queueCancelled = true;
    rt.turnActive = false;
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
          ...listLines(rt)
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
        const lines = rt.profile.length ? rt.profile.map((item) => `${item.label.padEnd(24)} ${item.ms.toFixed(1)}ms`) : ["no timings recorded"];
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }
      if (sub === "init") {
        try {
          const currentPath = getLazyConfigPath(agentDir);
          let backup = "";
          if (existsSync5(currentPath)) {
            const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
            backup = `${currentPath}.bak.init-${stamp}`;
            copyFileSync2(currentPath, backup);
          }
          const path = saveConfig(defaultConfig(), agentDir);
          rt.restartRequired = true;
          refreshStatus(pi, rt, ctx);
          ctx.ui.notify(`wrote default config \u2192 ${path}${backup ? `
backup: ${backup}` : ""}
Reload or restart Pi to apply it.`, "info");
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
          "Restart pi to apply module-lazy (extensions filtered to [])."
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
          `loaded ${res.name}${res.loadMs != null ? ` in ${res.loadMs}ms` : ""}${res.tools?.length ? ` \u2014 tools: ${res.tools.join(", ")}` : ""}`,
          "info"
        );
        return;
      }
      ctx.ui.notify("usage: /lazy [status|list|profile|load <name>|migrate|auto on|off|init|config]", "warning");
    }
  });
  pi.registerTool({
    name: "lazy_load",
    label: "Lazy Load",
    description: "Load a deferred Pi extension package managed by pi-lazy (LazyVim-style). Use when a capability is pending/on-demand (web, mcp, lens, plannotator, context-mode, etc.). Prefer /lazy list names.",
    promptSnippet: "Load a deferred pi-lazy extension package on demand",
    parameters: Type.Object({
      name: Type.String({ description: "Spec name from /lazy list (e.g. web, mcp, lens, plannotator)" })
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const res = await loadByName(pi, rt, params.name, ctx);
      const details = {
        ok: res.ok,
        name: res.name,
        alreadyLoaded: !!res.alreadyLoaded,
        loadMs: res.loadMs ?? null,
        tools: res.tools ?? [],
        commands: res.commands ?? [],
        error: res.error ?? void 0
      };
      if (!res.ok) {
        return {
          content: [{ type: "text", text: `Failed: ${res.error}` }],
          details
        };
      }
      return {
        content: [
          {
            type: "text",
            text: res.alreadyLoaded ? `'${res.name}' already loaded or eager.` : `Loaded '${res.name}' in ${res.loadMs ?? "?"}ms. tools=[${(res.tools ?? []).join(", ")}] commands=[${(res.commands ?? []).join(", ")}]`
          }
        ],
        details
      };
    }
  });
}
function piLazy(pi) {
  return createPiLazy(pi, getAgentDir4());
}
export {
  createPiLazy,
  piLazy as default
};
