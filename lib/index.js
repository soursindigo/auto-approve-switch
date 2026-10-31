/**
 * auto-approve-switch — host half (Node side of the plugin).
 *
 * ## The interception seam
 *
 * Every tool call DSH is about to execute passes one ordered, extensible
 * policy stage: the `tools/pre-execute` waterfall
 * (`ToolRegistry.prepareExecution` in `@deepseek-ai/dsh-tools`). A listener
 * receives the frozen execution — `{ name, arguments, agent, callId, signal,
 * parent?, schema? }` — plus a `next()` continuation, and answers with a
 * policy decision:
 *
 *   { kind: 'allow' }                             run the tool now
 *   { kind: 'deny',  reason, info? }              fail the call
 *   { kind: 'cancel' }                            abort the call
 *   { kind: 'ask',   reason?, displayReason? }    route to ctx.approval
 *
 * Only a listener that answers `ask` reaches the interactive approval UI
 * (`ToolRegistry.serviceAsk` → `ctx.approval.request`). The shipped
 * 0.2.1 profile contains no `ask` producer for the native tools, so returning
 * `{ kind: 'allow' }` from this stage is exactly "skip the approval prompt".
 *
 * This plugin installs ONE listener:
 *
 *   - switch ON  → return `{ kind: 'allow' }`.
 *   - switch OFF → call `next()` and return nothing, so the call continues
 *                  down the chain exactly as if this plugin were not installed.
 *
 * ## Exact waterfall semantics (what an `allow` here does and does not beat)
 *
 * Cordis runs waterfall listeners outermost-first and stops at the first
 * listener that returns a value (`ctx.waterfall`: returning without calling
 * `next()` vetoes the rest of the chain and the built-in seed).
 *
 *   - A listener registered **before** this one runs first. If it returns
 *     anything — `deny`, `cancel`, or its own `ask` — this plugin never sees
 *     the call, so it can never override it.
 *   - This plugin is registered **last** (its fiber is the most recently
 *     mounted), so with the switch ON it is the final word and other
 *     listeners' `ask`/`deny` decisions *are* skipped. That is inherent to
 *     auto-approval: the point is that nothing prompts. Listeners that must
 *     stay authoritative belong upstream of this plugin (rows listed earlier
 *     in the profile's bundle order, or `guard()`, which this plugin never
 *     touches).
 *   - With the switch OFF this plugin calls `next()` and returns nothing, so
 *     the chain behaves exactly as if it were not installed.
 *
 * ## What this does NOT bypass
 *
 * `tools/pre-execute` is a policy seam, not a sandbox. Filesystem sandboxing
 * (`dsh-fs-sandbox`), bash sandboxing (`dsh-bash-sandbox`), network policy and
 * the monotonic post-waterfall `tools.guard()` stage are separate mechanisms
 * and are untouched. Auto-approve is "never ask me", not "full access".
 *
 * ## Global state
 *
 * `isAutoApproveEnabled` is a module-level boolean (requirement #2), so one
 * value covers every Session and agent on this Host, and the shortcut and the
 * interceptor necessarily agree. Cordis deduplicates plugins by resolved
 * callback, so toggling the row off and on within one Host process reuses this
 * module — and the boolean — instead of resetting it.
 *
 * ## Browser half
 *
 * The UI (shortcut, toast, sidebar switch) lives in `client.ts`. Browser code
 * cannot read this module, so the two halves meet over the documented HTTP
 * route seam (`ctx.webServer.register`, `@deepseek-ai/dsh-host-webserver`):
 *
 *   GET  /auto-approve-switch/status → { ok, enabled, revision, label, ... }
 *   POST /auto-approve-switch/toggle → same, after flipping
 *
 * Every change bumps `revision`, which lets any open page notice a toggle made
 * elsewhere (another window, the terminal, persistence restore).
 *
 * @module auto-approve-switch
 */
import { appendFileSync, mkdirSync, statSync, truncateSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
/** Stable Cordis plugin name; also the prefix of every log line. */
export const name = 'auto-approve-switch';
/** Version marker, so a stale Host module is obvious in a boot log. */
export const PLUGIN_VERSION = '0.5.1';
/** Route prefix owned by this plugin; `client.ts` imports the same constant. */
export const ROUTE_PREFIX = '/auto-approve-switch';
/* ========================================================================== */
/* Global state                                                                */
/* ========================================================================== */
/**
 * THE global switch (requirement #2).
 *
 * A plain module-level boolean, read by every `tools/pre-execute` invocation
 * and every HTTP request in this Host. The default is `true` as specified;
 * `apply()` re-seeds it from config (and persistence may override that).
 */
export let isAutoApproveEnabled = true;
/** Monotonic counter bumped on every effective change. */
let revision = 0;
/** Where the current value came from (`initial`, `shortcut`, `restored`, ...). */
let changeSource = 'initial';
/** Diagnostics counters, exposed on the status route. */
const stats = {
    /** Tool calls claimed with `{ kind: 'allow' }` at `tools/pre-execute`. */
    allowed: 0,
    /** Tool calls handed to the rest of the chain with `next()`. */
    deferred: 0,
    /** Approval prompts answered automatically with `'allowed-once'`. */
    approvals: 0,
    /** Approval prompts handed to the human with `next()`. */
    approvalsDeferred: 0,
};
/** UI copy for the two states (requirement #4). */
export const LABELS = Object.freeze({
    on: '已开启自动放行',
    off: '已恢复手动审批',
});
/** Build a frozen snapshot of the current state. */
export function getStatus() {
    return Object.freeze({
        ok: true,
        enabled: isAutoApproveEnabled,
        revision,
        source: changeSource,
        label: isAutoApproveEnabled ? LABELS.on : LABELS.off,
        stats: Object.freeze({
            allowed: stats.allowed,
            deferred: stats.deferred,
            approvals: stats.approvals,
            approvalsDeferred: stats.approvalsDeferred,
        }),
        plugin: name,
    });
}
/** Host-side subscribers (persistence, diagnostics); the browser polls instead. */
const listeners = new Set();
/** Publish a changed status to Host-side subscribers, containing their errors. */
function publish(status) {
    for (const listener of [...listeners]) {
        try {
            listener(status);
        }
        catch (error) {
            console.error(`[${name}] change listener failed:`, error);
        }
    }
}
/**
 * Assign the switch explicitly. Idempotent: an unchanged value keeps the
 * revision, so polling pages see no spurious change.
 *
 * @param enabled - next value of {@link isAutoApproveEnabled}.
 * @param source  - short tag describing the caller.
 * @returns the new status snapshot.
 */
export function setAutoApproveEnabled(enabled, source = 'api') {
    const next = enabled === true;
    const changed = next !== isAutoApproveEnabled;
    isAutoApproveEnabled = next;
    if (changed) {
        revision += 1;
        changeSource = source;
    }
    const status = getStatus();
    if (changed) {
        log(`${status.label} (source: ${source}, revision: ${revision})`);
        publish(status);
    }
    return status;
}
/**
 * Flip the switch — the one operation the shortcut performs.
 *
 * @param source - short tag describing the caller (`shortcut`, `route`, ...).
 * @returns the new status snapshot.
 */
export function toggleAutoApprove(source = 'shortcut') {
    return setAutoApproveEnabled(!isAutoApproveEnabled, source);
}
/** Subscribe to Host-side changes. @returns the unsubscribe function. */
export function onAutoApproveChange(listener) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
/* ========================================================================== */
/* Diagnostics file                                                            */
/* ========================================================================== */
/**
 * Where the plugin writes its own log, independent of the Host's sink.
 *
 * `$DSH_HOME` (or `~/.dsh`) first: that is the harness home, it exists on every
 * install, and it keeps a link-installed plugin's own directory clean. The
 * working directory of the plugin (resolved from this module) and the temp
 * directory are fallbacks for a read-only or unusual home.
 *
 * The path must never be absolute to one person's checkout: an earlier version
 * pinned `~/agent/auto-approve-switch/...`, which would have written nothing on
 * anybody else's machine.
 */
// One level above this compiled file (`lib/`), i.e. the package root: a log must
// never be written INTO the published `lib/` directory.
//
// `fileURLToPath` rather than `new URL(...).pathname`: on Windows the pathname
// form is `/C:/Users/...`, and `dirname` then produces `/C:` — a directory that
// does not exist, so every log write would fail there.
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
/** Primary log location. */
export const LOG_FILE = join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'auto-approve-switch.log');
/** Tried in order when the primary location is not writable. */
export const LOG_FILE_FALLBACKS = [
    join(PACKAGE_ROOT, 'auto-approve-switch.log'),
    join(tmpdir(), 'auto-approve-switch.log'),
];
/** Set when the last file write failed, so the boot log can say so. */
let logFileError = null;
/**
 * Cap on the diagnostics file (bytes). The log is append-only and records one
 * line per decision, so without a bound it would grow for the lifetime of the
 * installation. Once it would exceed this, the file is truncated and a single
 * marker line explains the gap.
 */
const LOG_MAX_BYTES = 256 * 1024;
/**
 * Truncate the log when it has grown past {@link LOG_MAX_BYTES}.
 * @param file - the log file that was just resolved as writable.
 */
function capLogFile(file) {
    try {
        if (statSync(file).size <= LOG_MAX_BYTES)
            return;
        truncateSync(file, 0);
        appendFileSync(file, `${new Date().toISOString()} [${name}] (log rotated at ${String(LOG_MAX_BYTES)} bytes)\n`);
    }
    catch { /* rotation is best effort; a full disk must not break the plugin */ }
}
/**
 * `ctx.get(name)` without the risk of it throwing.
 *
 * A Cordis context's `get` delegates to the service resolver, which can throw
 * for an unusual or partially-mounted tree. Diagnostics ask about optional
 * services, so a failed lookup must read as "absent" — never propagate out of
 * `apply()`, where it would fail the whole Loader row and silently disable the
 * plugin (that is exactly how a diagnostic line once broke the boot).
 *
 * @param ctx  - context to query.
 * @param name - service name.
 * @returns the service, or `undefined`.
 */
function safeGet(ctx, name) {
    try {
        return typeof ctx.get === 'function' ? ctx.get(name) : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * Diagnostic writer: every boot/interception line goes to stderr (visible in
 * the terminal the app was launched from) AND to {@link LOG_FILE}, so the log
 * can be handed over without screenshotting a terminal.
 */
function log(line) {
    // #region diag
    const text = `[${name}] ${line}\n`;
    try {
        process.stderr.write(text);
    }
    catch { /* stderr not writable */ }
    let lastError = 'unknown';
    for (const target of [LOG_FILE, ...LOG_FILE_FALLBACKS]) {
        try {
            mkdirSync(dirname(target), { recursive: true });
            capLogFile(target);
            appendFileSync(target, `${new Date().toISOString()} ${text}`);
            logFileError = null;
            return;
        }
        catch (error) {
            lastError = String(error?.message ?? error);
        }
    }
    logFileError = lastError;
}
/**
 * In-process bridge for the browser half.
 *
 * The browser talks to this module over the HTTP routes above. On a desktop
 * carrier that applies its own request filter, those routes may never be
 * reachable from the renderer even though the interceptor is running — which
 * leaves the UI unable to show (or change) the real state. Electron desktop
 * builds run the browser half inside the Host process graph, so when the two
 * halves share one JavaScript realm this object is the direct, filter-free
 * path: the client prefers it and falls back to HTTP everywhere else.
 *
 * It is deliberately tiny and side-effect free so a client half that never
 * sees it (plain web, remote pages) simply keeps using HTTP.
 */
const bridge = {
    /** Same file the Host writes, so both halves share one timeline. */
    log: (line) => log(`[client] ${line}`),
    get: () => getStatus(),
    set: (enabled) => setAutoApproveEnabled(enabled, 'bridge'),
    toggle: () => toggleAutoApprove('bridge'),
    subscribe: (listener) => onAutoApproveChange(listener),
};
/** Global slot the browser half looks for (see `src/client.ts`). */
const BRIDGE_GLOBAL = '__DSH_AUTO_APPROVE_SWITCH__';
globalThis[BRIDGE_GLOBAL] = bridge;
// Written at MODULE LOAD time, before apply() is ever called: if the file
// exists but has no `apply()` line, the row was imported and then failed to
// activate; if the file does not exist at all, the row was never imported
// (a load-path / specifier problem, not a plugin bug). That single distinction
// is what makes a silent non-activation diagnosable.
log(`module imported (v${PLUGIN_VERSION}) — waiting for apply(); pid=${String(process.pid)}`);
/** Storage domain name; must stay stable or stored preferences are orphaned. */
const DOMAIN_NAME = 'auto-approve-switch';
/** Table inside that domain. */
const DOMAIN_TABLE = 'settings';
/** Record key inside that table. */
const DOMAIN_KEY = 'autoApprove';
/**
 * Open the plugin's storage domain through the provided facility.
 *
 * @param storageDomain - `ctx.storageDomain` (opens declared domains).
 * @returns a tiny boolean store, or `null` when storage is unusable.
 */
async function openStorage(storageDomain) {
    try {
        const [storage, zod] = await Promise.all([
            import('@deepseek-ai/dsh-storage-domain'),
            import('zod'),
        ]);
        // `zod` is resolved through this package's `node_modules`. It is pinned to
        // 4.4.3 (the version dsh-storage-domain itself depends on) so there is one
        // schema instance in the Host process.
        const spec = storage.defineDomain({
            name: DOMAIN_NAME,
            version: 1,
            tables: {
                [DOMAIN_TABLE]: storage.domainTable(zod.z.object({ enabled: zod.z.boolean() }).strict()),
            },
        });
        const domain = await storageDomain.open(spec);
        const table = domain.table(DOMAIN_TABLE);
        return {
            load: () => {
                const record = table.get(DOMAIN_KEY);
                return Promise.resolve(typeof record?.enabled === 'boolean' ? record.enabled : undefined);
            },
            save: async (enabled) => {
                await table.put(DOMAIN_KEY, { enabled });
            },
            close: async () => {
                await domain.close();
            },
        };
    }
    catch (error) {
        console.warn(`[${name}] 持久化不可用，开关状态仅保存在内存中：${String(error?.message ?? error)}`);
        return null;
    }
}
/**
 * Write every later change back to the store.
 *
 * @param store - the store to keep in sync.
 * @returns a disposer that unsubscribes and closes the store.
 */
function bindPersistence(store) {
    const unsubscribe = onAutoApproveChange((status) => {
        void store.save(status.enabled).catch((error) => {
            console.warn(`[${name}] could not persist auto-approve=${String(status.enabled)}:`, error);
        });
    });
    return () => {
        unsubscribe();
        void store.close().catch(() => { });
    };
}
/* ========================================================================== */
/* HTTP routes                                                                 */
/* ========================================================================== */
/** Whether a request may mutate state: same Host, or a non-browser caller. */
function isSameOrigin(request, expectedHost) {
    const origin = request.headers?.origin;
    // Non-browser callers (curl, scripts) send no Origin; the server is loopback
    // by default, so treating that as same-origin keeps the route testable.
    if (typeof origin !== 'string' || origin === '')
        return true;
    if (expectedHost === undefined)
        return false;
    try {
        return new URL(origin).host === expectedHost;
    }
    catch {
        return false;
    }
}
/** Write one JSON response. */
function sendJson(response, status, body) {
    const text = JSON.stringify(body);
    response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(text),
    });
    response.end(text);
}
/** Read a small JSON body; `undefined` when absent or unparseable. */
async function readJsonBody(request, limit = 4096) {
    const chunks = [];
    let length = 0;
    for await (const chunk of request) {
        length += chunk.length;
        if (length > limit)
            throw new Error('request body too large');
        chunks.push(chunk);
    }
    if (length === 0)
        return undefined;
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
/**
 * Register the status/toggle routes once a `webServer` exists.
 *
 * The UI is a convenience layer: a route that cannot be registered (a path
 * another plugin already owns, an unusual carrier) is logged and skipped. The
 * interceptor is the security-relevant part and must never be taken down by
 * an optional feature's failure — without the routes the sidebar control
 * reports "state unknown", and the browser falls back to whatever the Host
 * does natively.
 *
 * @param ctx - Host context that may acquire `webServer` at any time.
 * @returns a disposer for the registration wait itself.
 */
function registerRoutes(ctx) {
    const fiber = ctx.inject(['webServer'], (webCtx) => {
        webCtx.effect(() => {
            const server = webCtx.webServer;
            /** Register one route, never letting a failure escape (see the file header). */
            const tryRegister = (route) => {
                try {
                    const dispose = server.register(route);
                    log(`route mounted: ${String(route.path)}`);
                    return dispose;
                }
                catch (error) {
                    log(`route NOT mounted: ${String(route.path)}: ${String(error?.message ?? error)}`);
                    return () => { };
                }
            };
            const expectedHost = () => {
                try {
                    return new URL(server.getOrigin()).host;
                }
                catch {
                    return undefined;
                }
            };
            const statusRoute = tryRegister({
                kind: 'exact',
                path: `${ROUTE_PREFIX}/status`,
                handler: (request, response) => {
                    if (request.method !== 'GET') {
                        response.writeHead(405, { allow: 'GET' });
                        response.end();
                        return;
                    }
                    if (!isSameOrigin(request, expectedHost())) {
                        sendJson(response, 403, { ok: false, code: 'origin' });
                        return;
                    }
                    sendJson(response, 200, getStatus());
                },
            });
            /**
             * Shared mutation plumbing for both write routes.
             * @param methods - accepted HTTP methods.
             * @param apply   - derives the new value from the parsed body (`undefined`
             *                  body = "flip"), then applies it.
             */
            const mutationRoute = (path, methods, apply) => tryRegister({
                kind: 'exact',
                path,
                handler: (request, response) => {
                    if (!methods.includes(request.method)) {
                        response.writeHead(405, { allow: methods.join(', ') });
                        response.end();
                        return;
                    }
                    if (!isSameOrigin(request, expectedHost())) {
                        sendJson(response, 403, { ok: false, code: 'origin' });
                        return;
                    }
                    void (async () => {
                        let requested;
                        try {
                            const body = await readJsonBody(request);
                            if (typeof body?.enabled === 'boolean')
                                requested = body.enabled;
                        }
                        catch {
                            // Malformed body: treated as absent below.
                        }
                        sendJson(response, 200, apply(requested));
                    })().catch((error) => {
                        console.error(`[${name}] route failed: ${path}`, error);
                        if (!response.headersSent)
                            sendJson(response, 500, { ok: false, code: 'internal' });
                    });
                },
            });
            // Idempotent set (preferred by the UI): PUT/POST `{ enabled: bool }`.
            // Re-sending the same value is a no-op, so the browser may retry safely
            // after a lost or rewritten response.
            const stateRoute = mutationRoute(`${ROUTE_PREFIX}/state`, ['PUT', 'POST'], (requested) => requested === undefined ? getStatus() : setAutoApproveEnabled(requested, 'route'));
            // Flip-only (kept for scripts and `curl`). An explicit value is accepted
            // too, for convenience; with none it flips exactly once per request.
            const toggleRoute = mutationRoute(`${ROUTE_PREFIX}/toggle`, ['POST'], (requested) => requested === undefined ? toggleAutoApprove('shortcut') : setAutoApproveEnabled(requested, 'route'));
            return () => {
                statusRoute?.();
                stateRoute?.();
                toggleRoute?.();
            };
        }, `${name}: http routes`);
    });
    return () => {
        try {
            fiber?.dispose?.();
        }
        catch { /* already disposed */ }
    };
}
/* ========================================================================== */
/* Plugin entry                                                                */
/* ========================================================================== */
/**
 * Accepted row config — documented only, NOT exported as `Config`.
 *
 * Cordis treats a plugin's exported `Config` as a Schemastery schema and calls
 * `Config.validate(rowConfig)` before `apply`. A plain descriptor object is not
 * a schema, so that call throws
 *
 *   TypeError: Cannot read properties of undefined (reading 'validate')
 *
 * which marks the fiber FAILED (state 3). `apply()` then never runs and the
 * plugin does nothing at all — without crashing the app, because a failed
 * non-required row is only a startup warning. That is exactly how this plugin
 * silently stopped working once the config block was added.
 *
 * The row config shape is therefore declared as a TYPE plus the normalization
 * in {@link apply}, and no `Config` is exported. Attach a real Schemastery
 * schema here if typed validation ever becomes worth the runtime dependency.
 */
/**
 * Cordis services this plugin WAITS for — deliberately none.
 *
 * Cordis's `Inject.resolve` treats an injection declaration as a map of
 * **service names**: an array is a list of names, and an object contributes
 * `Object.keys()` as the names. `{ required: [...], optional: [...] }` therefore
 * declares services literally called `required` and `optional`, which never
 * exist — the fiber waits forever (`pending (waiting for service: optional)`),
 * `apply()` never runs, and the desktop app reports a failed web boot. That
 * shape cost several restarts here; it must never come back.
 *
 * Nothing is required because nothing is needed up front:
 *   - the interceptor is `ctx.on('tools/pre-execute')`, an event listener;
 *   - `webServer` / `storageDomain` are awaited lazily with `ctx.inject([...])`,
 *     which simply stays dormant when they never appear;
 *   - diagnostics use `safeGet()`.
 */
export const inject = [];
/**
 * Install the interceptor, the optional routes and the optional persistence.
 *
 * @param ctx    - Cordis Host context.
 * @param config - row config (validated against {@link Config}).
 */
export function apply(ctx, config = {}) {
    try {
        applyInner(ctx, config);
    }
    catch (error) {
        // Anything thrown out of apply() marks the Loader row FAILED, and a failed
        // non-required row is only a startup warning — the plugin would silently do
        // nothing. Record it in the plugin's own log first, so this is diagnosable
        // without a terminal attached to the app.
        log(`apply() FAILED: ${String(error?.stack ?? error)}`);
        throw error;
    }
}
/**
 * The real plugin body, called by {@link apply} inside a diagnostic wrapper.
 *
 * @param ctx    - Cordis Host context.
 * @param config - row config (normalized here).
 */
function applyInner(ctx, config = {}) {
    const options = {
        defaultEnabled: config?.defaultEnabled !== false,
        persist: config?.persist !== false,
        logDecisions: config?.logDecisions === true,
    };
    // Seed the global from config; a persisted value may override it below.
    isAutoApproveEnabled = options.defaultEnabled;
    revision = 0;
    changeSource = 'initial';
    stats.allowed = 0;
    stats.deferred = 0;
    stats.approvals = 0;
    stats.approvalsDeferred = 0;
    /* ---------------------------------------------------------------------- */
    /* The interceptor (requirement #1)                                        */
    /* ---------------------------------------------------------------------- */
    // `ctx.on` registers a listener that is removed with this plugin's fiber;
    // the disposer is kept anyway so teardown is explicit and testable.
    //
    // The listener is registered LAST in the waterfall (no `prepend`): listeners
    // that registered before it — approval producers, deny policies shipped by
    // the bundles listed earlier in the profile — run first and keep their say.
    // Only when the chain reaches this plugin with the switch ON does it return
    // `{ kind: 'allow' }`, and a value returned there ends the waterfall.
    let offInterceptor = () => { };
    try {
        offInterceptor = ctx.on('tools/pre-execute', (exec, next) => {
            if (stats.allowed + stats.deferred === 0) {
                log('first pre-execute interception observed — plugin is live');
            }
            if (!isAutoApproveEnabled) {
                // OFF → contribute nothing. `next()` hands the decision to the next
                // listener and finally to the waterfall seed, i.e. DSH's native path
                // decides (and prompts) exactly as if this plugin were not installed.
                stats.deferred += 1;
                if (options.logDecisions) {
                    console.info(`[${name}] ↔ 交还原生审批：${String(exec?.name)}`);
                }
                return next();
            }
            // ON → allow immediately, skipping any approval prompt.
            stats.allowed += 1;
            if (options.logDecisions) {
                console.info(`[${name}] ▶ 已放行：${String(exec?.name)}`);
            }
            const decision = { kind: 'allow' };
            return decision;
        });
    }
    catch (error) {
        // The interceptor is the whole point of this plugin: surface it loudly
        // rather than mounting a row that silently approves nothing.
        log(`FATAL: could not register tools/pre-execute listener: ${String(error?.message ?? error)}`);
        throw error;
    }
    /* ---------------------------------------------------------------------- */
    /* Approval prompts — the OTHER half of "skip the dialog"                  */
    /* ---------------------------------------------------------------------- */
    // `tools/pre-execute` decides whether a call is ALLOWED; it does not answer
    // approval prompts. A prompt is produced by whoever calls
    // `ctx.approval.request()` — the bash and fs tools do that from inside their
    // own bodies when a call escalates its sandbox — and `ApprovalService.decide`
    // routes it through the `approval/request` waterfall, whose seed is
    // `'unavailable'`. Answerers are listeners that return an outcome.
    //
    // Without this listener the plugin skips the (rare) policy prompt but leaves
    // the escalation dialog the user actually sees. Returning `'allowed-once'`
    // here is what makes "never ask me" true.
    let offApproval = () => { };
    try {
        offApproval = ctx.on('approval/request', (request, next) => {
            if (!isAutoApproveEnabled) {
                stats.approvalsDeferred += 1;
                return next();
            }
            stats.approvals += 1;
            // Audited in the plugin log: an auto-approved escalation is the single
            // most security-relevant thing this plugin can do, so it is never silent.
            log(`approval auto-approved: tool=${String(request?.toolName)} ` +
                `reason=${String(request?.reason ?? '(none)')}`);
            return 'allowed-once';
        });
    }
    catch (error) {
        log(`could not register approval/request listener: ${String(error?.message ?? error)}`);
    }
    /* ---------------------------------------------------------------------- */
    /* Persistence (optional)                                                  */
    /* ---------------------------------------------------------------------- */
    let releasePersistence = null;
    let closed = false;
    let storageFiber = null;
    if (options.persist) {
        // Optional: a storage failure only costs "state returns to default after
        // restart" and must never fail the row.
        try {
            storageFiber = ctx.inject(['storageDomain'], (storageCtx) => {
                void openStorage(storageCtx.storageDomain).then(async (opened) => {
                    if (opened === null)
                        return;
                    if (closed) {
                        // The plugin went away while storage was still opening.
                        void opened.close().catch(() => { });
                        return;
                    }
                    releasePersistence = bindPersistence(opened);
                    const restored = await opened.load();
                    // Seed the persisted value BEFORE writing anything back, so a first
                    // run (nothing stored yet) writes the current default instead of
                    // racing it.
                    if (restored === undefined)
                        await opened.save(isAutoApproveEnabled).catch(() => { });
                    else
                        setAutoApproveEnabled(restored, 'restored');
                });
            });
        }
        catch (error) {
            console.warn(`[${name}] 无法使用持久化，开关将只在本次运行有效：`, error);
        }
    }
    /* ---------------------------------------------------------------------- */
    /* Routes + lifecycle                                                      */
    /* ---------------------------------------------------------------------- */
    let offRoutes = () => { };
    try {
        offRoutes = registerRoutes(ctx);
    }
    catch (error) {
        console.error(`[${name}] 状态接口注册失败，自动放行本身不受影响：`, error);
    }
    ctx.effect(() => () => {
        closed = true;
        try {
            offInterceptor?.();
        }
        catch { /* already removed with the fiber */ }
        try {
            offApproval?.();
        }
        catch { /* already removed with the fiber */ }
        offRoutes();
        releasePersistence?.();
        try {
            storageFiber?.dispose?.();
        }
        catch { /* already disposed */ }
        listeners.clear();
    }, `${name}: lifecycle`);
    log(`apply() v${PLUGIN_VERSION} — auto-approve ${isAutoApproveEnabled ? 'ON' : 'OFF'}; ` +
        `interceptor registered; routes ${ROUTE_PREFIX}/{status,state,toggle}; ` +
        `webServer=${safeGet(ctx, 'webServer') === undefined ? 'absent' : 'present'}; ` +
        `bridgeGlobal=${typeof globalThis[BRIDGE_GLOBAL]}`);
    log(`log file: ${LOG_FILE}${logFileError === null ? '' : ` (write failed: ${logFileError})`}`);
}
