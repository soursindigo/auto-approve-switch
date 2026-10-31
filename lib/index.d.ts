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
import type { Context } from '@deepseek-ai/cordis';
/** Stable Cordis plugin name; also the prefix of every log line. */
export declare const name = "auto-approve-switch";
/** Version marker, so a stale Host module is obvious in a boot log. */
export declare const PLUGIN_VERSION = "0.5.1";
/** Route prefix owned by this plugin; `client.ts` imports the same constant. */
export declare const ROUTE_PREFIX = "/auto-approve-switch";
/** The exact `tools/pre-execute` decision this plugin returns while ON. */
export interface AllowDecision {
    readonly kind: 'allow';
}
/**
 * Per-row config — see the `Config` schema below. Every field is optional; an
 * empty row gets the documented behaviour (auto-approval ON, persistent).
 */
export interface PluginConfig {
    /**
     * Value of the switch when the Host boots (before any restored preference).
     * @default true
     */
    defaultEnabled?: boolean;
    /**
     * Restore/persist the switch through `ctx.storageDomain` when that service is
     * mounted, so a Host restart does not silently re-enable auto-approval.
     * @default true
     */
    persist?: boolean;
    /**
     * Log one line per decision (tool name + allowed/deferred). Handy while
     * verifying the plugin, noisy afterwards.
     * @default false
     */
    logDecisions?: boolean;
}
/**
 * THE global switch (requirement #2).
 *
 * A plain module-level boolean, read by every `tools/pre-execute` invocation
 * and every HTTP request in this Host. The default is `true` as specified;
 * `apply()` re-seeds it from config (and persistence may override that).
 */
export declare let isAutoApproveEnabled: boolean;
/** UI copy for the two states (requirement #4). */
export declare const LABELS: Readonly<{
    on: "已开启自动放行";
    off: "已恢复手动审批";
}>;
/** State snapshot shared by the status route, the log and the browser half. */
export interface Status {
    readonly ok: true;
    readonly enabled: boolean;
    readonly revision: number;
    readonly source: string;
    /** `已开启自动放行` or `已恢复手动审批`. */
    readonly label: string;
    readonly stats: {
        readonly allowed: number;
        readonly deferred: number;
        readonly approvals: number;
        readonly approvalsDeferred: number;
    };
    readonly plugin: string;
}
/** Build a frozen snapshot of the current state. */
export declare function getStatus(): Status;
/** Type of a state-change subscriber. */
export type ChangeListener = (status: Status) => void;
/**
 * Assign the switch explicitly. Idempotent: an unchanged value keeps the
 * revision, so polling pages see no spurious change.
 *
 * @param enabled - next value of {@link isAutoApproveEnabled}.
 * @param source  - short tag describing the caller.
 * @returns the new status snapshot.
 */
export declare function setAutoApproveEnabled(enabled: boolean, source?: string): Status;
/**
 * Flip the switch — the one operation the shortcut performs.
 *
 * @param source - short tag describing the caller (`shortcut`, `route`, ...).
 * @returns the new status snapshot.
 */
export declare function toggleAutoApprove(source?: string): Status;
/** Subscribe to Host-side changes. @returns the unsubscribe function. */
export declare function onAutoApproveChange(listener: ChangeListener): () => void;
/** Primary log location. */
export declare const LOG_FILE: string;
/** Tried in order when the primary location is not writable. */
export declare const LOG_FILE_FALLBACKS: string[];
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
export declare const inject: readonly string[];
/**
 * Install the interceptor, the optional routes and the optional persistence.
 *
 * @param ctx    - Cordis Host context.
 * @param config - row config (validated against {@link Config}).
 */
export declare function apply(ctx: Context, config?: PluginConfig): void;
