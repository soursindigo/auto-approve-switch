/**
 * auto-approve-switch — client half (browser side of the plugin).
 *
 * This file is the source of `lib/client.js`. It is bundled as a DSH **client
 * module** (factory-form CJS reaching `window.__ModuleLoader__`), which the
 * Host discovers from `package.json → dsh.client` and serves under `/plugins`.
 * The bundle exports `apply(ctx)`, `inject` and `name`, like every shipped
 * client plugin.
 *
 * ## Shortcut (requirement #3)
 *
 * DSH has a first-class shortcut service: `ctx.shortcuts.register(command)`
 * (`@deepseek-ai/dsh-client-shortcuts`). A command declares per-device
 * defaults, and the service:
 *
 *   - validates them at registration (reserved combinations and collisions
 *     with other commands throw),
 *   - lists them in 设置 → 快捷键, where the user may rebind them,
 *   - persists overrides per device, and
 *   - routes key presses to `resolve(context).run()`.
 *
 * The default is ⌘⌥A on macOS desktop and Ctrl+Alt+A on Windows desktop
 * (Windows spells the combination `Ctrl + Alt + A`). Web variants are declared
 * as `primary+alt` too: the service admits any three-modifier combination
 * there, and the browser delivers it when the OS or browser has not claimed
 * it. No other shipped command binds `KeyA` with that modifier set (the
 * nearest neighbor is ⌘⌥⇧A "session.archive"), so registration cannot fail on
 * a collision.
 *
 * If the shortcut service is missing (an unusual shell), the plugin falls back
 * to a document-level `keydown` listener so the feature never silently
 * disappears, and the sidebar switch remains available regardless.
 *
 * ## UI feedback (requirement #4)
 *
 * The toast is the shell's own primitive — `Toast` from
 * `@deepseek-ai/dsh-client-ui-primitives`, the platform seed module the shell
 * ships (the same component 设置页 / 回收站 notices use). `Toast` portals to
 * `document.body`, is fixed at the top center, and auto-dismisses via
 * `onDone`. Text is exactly the requested copy:
 *
 *   on  → 已开启自动放行
 *   off → 已恢复手动审批
 *
 * The primitives module is `require`d defensively: if a future shell drops it,
 * the plugin logs the same text with `console.info` instead of failing to load.
 *
 * ## Talking to the host half
 *
 * Browser code cannot see the Host module that owns `isAutoApproveEnabled`, so
 * the two halves use the documented HTTP route seam from the host half:
 *
 *   GET  /auto-approve-switch/status
 *   POST /auto-approve-switch/toggle
 *
 * Every mutation bumps a host-side `revision`; the client re-reads the status
 * while mounted so a toggle made from another window (or restored from
 * storage) also updates this page and shows its own toast.
 *
 * @module auto-approve-switch/client
 */

/* -------------------------------------------------------------------------- */
/* Module graph                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The bundle loader's synchronous `require`. The module system passes it into
 * the factory; `scripts/build.mjs` declares it as a bundle global so esbuild
 * leaves it as a free variable instead of trying to resolve it at build time.
 */
declare const require: (specifier: string) => any

// The shell already holds these instances, so requiring them adds no
// dependency: `react`, `react-dom/client` and the primitives module are
// "platform seed words" in the shell's frozen module table and resolve
// synchronously (see `client-modules` §共享模块).
const React: any = require('react')
const primitives: any = require('@deepseek-ai/dsh-client-ui-primitives')
const ReactDOM: any = require('react-dom/client')

/** Shortcut command id; also the key of a persisted binding override. */
const COMMAND_ID = 'auto-approve-switch.toggle'
/** Route prefix (mirrors `ROUTE_PREFIX` in `src/index.ts`). */
const ROUTE_PREFIX = '/auto-approve-switch'
/** Toast copy (requirement #4). */
const LABEL_ON = '已开启自动放行'
const LABEL_OFF = '已恢复手动审批'
/** How long the toast stays on screen (ms); the primitive fades out after this. */
const TOAST_HOLD_MS = 2200
/** Status polling cadence while the page is hidden and in sync (ms). */
const HIDDEN_POLL_MS = 8000

/** Minimal typing for the Cordis client context we use. */
interface ClientContext {
  readonly effect: (execute: () => unknown, label?: string) => () => void
  readonly inject: (services: string[] | Record<string, unknown>, callback: (ctx: ClientContext) => unknown) => unknown
  readonly on?: (event: string, listener: (...args: any[]) => unknown) => () => void
  readonly get?: <T = any>(name: string) => T | undefined
  readonly slots?: any
  readonly shortcuts?: ShortcutService
  readonly sessions?: any
  readonly [key: string]: any
}

/** The subset of the shortcut service this plugin uses. */
interface ShortcutService {
  register: (command: {
    id: string
    label: () => string
    aliases?: string[]
    defaults: Record<string, { code: string; modifiers: string[] } | undefined>
    regions: string[]
    modals: string[]
    resolve: (context: { region: string; modal: string | null; target: unknown }) =>
      | { status: 'pass' }
      | { status: 'blocked'; reason: string }
      | { status: 'handled'; run: () => void }
  }) => () => void
  readonly catalog?: { getSnapshot: () => ReadonlyArray<{ id: string; keys?: string[] }> }
}

/** Host status payload (`GET /auto-approve-switch/status`). */
interface HostStatus {
  ok: true
  enabled: boolean
  revision: number
  source: string
  label: string
  plugin: string
}

/* -------------------------------------------------------------------------- */
/* Host bridge                                                                */
/* -------------------------------------------------------------------------- */

/** Read the current Host status; throws on transport or protocol failure. */
async function fetchStatus(): Promise<HostStatus> {
  const response = await fetch(`${ROUTE_PREFIX}/status`, { cache: 'no-store' })
  if (!response.ok) throw new Error(`status ${String(response.status)}`)
  const body = await response.json()
  if (body?.ok !== true || typeof body.enabled !== 'boolean') {
    throw new Error('unexpected status payload')
  }
  return body as HostStatus
}

/**
 * Transport failure carrying the HTTP status when there was one.
 *
 * The status matters: a `4xx` on the PATCH means the Host understood the
 * request and refused it (definitive — never retried), while a `404`/network
 * error means the request never reached the plugin (retried).
 */
class ToggleError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message)
  }
}

/**
 * Send the requested value to the Host.
 *
 * `PUT /auto-approve-switch/state` is idempotent: sending the same value twice
 * is harmless, which is what makes background retries safe after a lost
 * response. The older flip-every-time `POST /toggle` is still accepted by the
 * Host for scripts, but this plugin never uses it for user actions — a retried
 * flip would silently undo itself.
 *
 * @param enabled - the value to apply.
 * @returns the Host status after applying it.
 */
async function putState(enabled: boolean): Promise<HostStatus> {
  let response
  try {
    response = await fetch(`${ROUTE_PREFIX}/state`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled }),
      cache: 'no-store',
    })
  }
  catch (error) {
    throw new ToggleError(String((error as Error)?.message ?? error), null)
  }
  if (!response.ok) throw new ToggleError(`Host 返回 ${String(response.status)}`, response.status)
  const body = await response.json().catch(() => null)
  // Some proxies answer 200 with an empty body; fall back to a status read.
  if (body?.ok !== true || typeof body.enabled !== 'boolean') {
    return await fetchStatus()
  }
  return body as HostStatus
}

/* -------------------------------------------------------------------------- */
/* Toast                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Show a toast with the shell's own primitive.
 *
 * `Toast` reports dismissal through `onDone` rather than mounting imperatively,
 * so it is rendered through one React root per toast; the primitive portals
 * itself to `document.body`, so the hosting div never affects layout. The
 * element is left mounted for one framework tick after `onDone` so React is
 * never asked to render an empty root from inside its own callback.
 *
 * Contract used (from the shipped primitive): `{ text, icon?, tone?,
 * holdMs?, actions?, onDone }`; `tone: 'success'` renders the shell's check
 * glyph, otherwise the supplied `icon` is used.
 *
 * @param text - message to display.
 * @param tone - `success` for the ON state, `info` for the OFF state.
 */
function showToast(text: string, tone: 'success' | 'info'): void {
  const Toast = primitives?.Toast
  const createRoot = ReactDOM?.createRoot
  if (typeof Toast !== 'function' || typeof createRoot !== 'function') {
    // Fallback (requirement #4): no primitive in this shell → console output.
    console.info(`[auto-approve-switch] ${text}`)
    return
  }
  const host = document.createElement('div')
  host.dataset.autoApproveSwitchToast = ''
  document.body.appendChild(host)
  const root = createRoot(host)
  let done = false
  const finish = (): void => {
    if (done) return
    done = true
    window.setTimeout(() => {
      root.unmount()
      host.remove()
    }, 0)
  }
  const icon = tone === 'info' && typeof primitives.IconWarningOutlineRegular === 'function'
    ? React.createElement(primitives.IconWarningOutlineRegular, { size: 18 })
    : undefined
  root.render(
    React.createElement(Toast, {
      text,
      ...(tone === 'success' ? { tone: 'success' } : {}),
      ...(icon === undefined ? {} : { icon }),
      holdMs: TOAST_HOLD_MS,
      onDone: finish,
    }),
  )
}

/* -------------------------------------------------------------------------- */
/* Switch store                                                               */
/* -------------------------------------------------------------------------- */

interface StoreState {
  /** Last value confirmed by the Host; `null` before the first successful read. */
  enabled: boolean | null
  /** Host revision of that value. */
  revision: number
  /** True while a toggle is pending confirmation. */
  pending: boolean
  /** Last transport error text, for the tooltip. */
  error: string | null
  /** Whether the Host route answered at least once. */
  connected: boolean
  /**
   * The Host has this page's last toggle but did not confirm it: either the
   * response was lost, or it returned an error while the switch still IS the
   * requested value. Retried in the background.
   */
  unconfirmed: boolean
}

/**
 * Persisted *pending intent*.
 *
 * The sidebar reads the Host over `GET /status`. A page that cannot reach the
 * Host must still toggle, and must not report a failure for a toggle the Host
 * actually performed — so the intent is written here BEFORE the request and
 * cleared only by a status read that proves it (or a definitive 4xx). It
 * survives a refresh and an Electron restart.
 */
const INTENT_KEY = 'auto-approve-switch.intent'
/** Fixed poll for a status the page still trusts. */
const POLL_MS = 1500
/** Poll used while an intent is unconfirmed (fast confirm, low load). */
const CONFIRM_POLL_MS = 300
/** Poll used while the Host is unreachable (back off). */
const RETRY_POLL_MS = 4000
/** While retrying: re-issue the PATCH this often before backing off to confirm-only. */
const REPLAY_WINDOW_MS = 60000

interface PendingIntent {
  /** The value the user asked for. */
  readonly enabled: boolean
  /** Local timestamp (ms) of the request. */
  readonly at: number
}

/** Read the persisted intent (defensive: any parse failure means "none"). */
function readIntent(): PendingIntent | null {
  try {
    const raw = window.localStorage.getItem(INTENT_KEY)
    if (raw === null) return null
    const parsed = JSON.parse(raw)
    if (typeof parsed?.enabled === 'boolean' && typeof parsed?.at === 'number') {
      return { enabled: parsed.enabled, at: parsed.at }
    }
  }
  catch { /* unavailable or corrupt: treat as none */ }
  return null
}

/** Persist (or clear) the intent. */
function writeIntent(intent: PendingIntent | null): void {
  try {
    if (intent === null) window.localStorage.removeItem(INTENT_KEY)
    else window.localStorage.setItem(INTENT_KEY, JSON.stringify(intent))
  }
  catch { /* storage disabled: in-memory state still works */ }
}

type Listener = () => void

/**
 * Tiny external store for the switch, shared by the shortcut, the toast and
 * the sidebar control. Uses `useSyncExternalStore` for reading.
 */
class SwitchStore {
  private state: StoreState = { enabled: null, revision: -1, pending: false, error: null, connected: false, unconfirmed: false }
  private readonly listeners = new Set<Listener>()
  private disposed = false
  /** The intent currently outstanding, or `null` when the page is in sync. */
  private intent: PendingIntent | null = null
  /** Coalesces concurrent submissions of the same intent. */
  private inFlight: Promise<void> | null = null

  constructor() {
    // A reload may find an intent recorded by an earlier page: adopt it and
    // show it, then confirm against the Host (see `resume`).
    const restored = readIntent()
    if (restored !== null) {
      this.intent = restored
      this.state = { ...this.state, enabled: restored.enabled, pending: true, unconfirmed: true }
    }
  }

  /** Whether the Host still has to confirm something this page asked for. */
  get hasUnconfirmedIntent(): boolean {
    return this.intent !== null
  }

  /** How often the sync loop should poll right now (ms). */
  get pollDelay(): number {
    if (this.intent === null) return POLL_MS
    return Date.now() - this.intent.at < REPLAY_WINDOW_MS ? CONFIRM_POLL_MS : RETRY_POLL_MS
  }

  /** When set, toggles are applied in-process instead of over HTTP. */
  private bridgeToggle: (() => { enabled: boolean; revision: number }) | null = null
  private bridgeSet: ((enabled: boolean) => { enabled: boolean; revision: number }) | null = null

  /**
   * Install (or remove) the in-process bridge used by `toggle()`/`setEnabled()`.
   *
   * Both verbs are wired because the sidebar renders a `Switch`: it reports the
   * value the user chose, so applying it must be idempotent ("set"), while the
   * shortcut still sends "the other one" ("toggle").
   *
   * @param toggle - flips the value in-process, or `null` for the HTTP path.
   * @param set    - applies an explicit value in-process, or `null`.
   */
  useBridge(
    toggle: (() => { enabled: boolean; revision: number }) | null,
    set: ((enabled: boolean) => { enabled: boolean; revision: number }) | null = null,
  ): void {
    this.bridgeToggle = toggle
    this.bridgeSet = set
  }

  /**
   * Adopt a status pushed by the Host module itself (same realm).
   *
   * Unlike `reconcile` this never sends anything: a direct push is by
   * definition the Host's own newest truth, so it clears any local intent and
   * never toasts — the user already saw their own toggle.
   *
   * @param status - the Host's current status.
   */
  adoptSnapshot(status: { enabled: boolean; revision: number }): void {
    if (this.disposed) return
    if (this.intent !== null && status.enabled === this.intent.enabled) {
      this.intent = null
      writeIntent(null)
    }
    this.set({
      enabled: status.enabled,
      revision: status.revision,
      pending: false,
      unconfirmed: false,
      connected: true,
      error: null,
    })
  }

  getSnapshot = (): StoreState => this.state

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Replace state and notify; a no-op once the plugin is disposed. */
  private set(patch: Partial<StoreState>): void {
    if (this.disposed) return
    this.state = { ...this.state, ...patch }
    for (const listener of [...this.listeners]) {
      try {
        listener()
      }
      catch (error) {
        console.error('[auto-approve-switch] store listener failed', error)
      }
    }
  }

  /**
   * Read the Host status once.
   * @param announce - show a toast when the value changed *elsewhere*.
   */
  async refresh(announce = true): Promise<void> {
    try {
      const status = await fetchStatus()
      this.set({ connected: true, error: null })
      await this.reconcile(status, announce)
    }
    catch (error) {
      const message = String((error as Error)?.message ?? error)
      this.set({ connected: false, error: message })
      diag(`status read failed: ${message}`)
    }
  }

  /**
   * Compare a Host status against the current state and the outstanding intent.
   *
   * Three outcomes:
   *  - no intent           → adopt the Host value; toast only if it changed
   *                          elsewhere (another window, a restart restore).
   *  - intent confirmed    → adopt it, clear the intent, keep quiet (the user
   *                          already saw the toast when they pressed the key).
   *  - intent outstanding  → keep showing the requested value; try to replay it.
   *
   * @param status   - fresh Host status.
   * @param announce - whether a change made elsewhere should toast.
   */
  private async reconcile(status: HostStatus, announce: boolean): Promise<void> {
    const intent = this.intent
    // Only ever move BACKWARDS in time: a slow response that raced past a
    // newer request must not overwrite the newer state (this was the
    // "switched on but can no longer switch off" symptom).
    if (status.revision !== 0 && status.revision < this.state.revision) return
    if (intent === null) {
      const previous = this.state
      const changedElsewhere = previous.enabled !== null
        && previous.enabled !== status.enabled
        && status.revision !== previous.revision
      this.set({ enabled: status.enabled, revision: status.revision, pending: false, unconfirmed: false })
      // A value we did not write may legitimately have come from the Host
      // restarting (and restoring the persisted choice). Say so instead of
      // pretending the user just toggled it.
      if (announce && changedElsewhere) {
        showToast(`${status.enabled ? LABEL_ON : LABEL_OFF}（已同步 Host 状态）`, status.enabled ? 'success' : 'info')
      }
      return
    }
    if (status.enabled === intent.enabled) {
      // Confirmed: the Host holds exactly what the user asked for.
      this.intent = null
      writeIntent(null)
      this.set({ enabled: status.enabled, revision: status.revision, pending: false, unconfirmed: false })
      return
    }
    // Still not applied: keep the optimistic value visible and resubmit. A
    // Phase-1 Host answers 404 here and merely confirms nothing changed, so the
    // value is simply never adopted and the intent is retried.
    this.set({ enabled: intent.enabled, revision: status.revision, pending: true, unconfirmed: true })
    if (Date.now() - intent.at < REPLAY_WINDOW_MS) {
      await this.submit(intent).catch(() => {})
    }
  }

  /**
   * Apply the outstanding intent on the Host (one request at a time).
   *
   * @param intent - the requested value and its timestamp.
   */
  private submit(intent: PendingIntent): Promise<void> {
    if (this.inFlight !== null) return this.inFlight
    this.inFlight = (async () => {
      try {
        const status = await putState(intent.enabled)
        if (this.intent?.at !== intent.at) return // superseded by a newer request
        if (status.enabled === intent.enabled) {
          this.intent = null
          writeIntent(null)
          this.set({ enabled: status.enabled, revision: status.revision, pending: false, unconfirmed: false, connected: true, error: null })
        }
        else {
          this.set({ revision: status.revision, error: `Host 仍为 ${status.enabled ? '开' : '关'}，正在后台重试`})
        }
      }
      finally {
        this.inFlight = null
      }
    })()
    return this.inFlight
  }

  /**
   * Flip the switch.
   *
   * The toggle is **optimistic**: the requested value is shown and persisted
   * before the request goes out, so a request the page cannot observe (a proxy
   * that rewrites the response, a transient network error) never looks like a
   * failure of a toggle that in fact happened. The Host is then asked to apply
   * it, idempotently, and keeps being retried until a status read confirms it.
   *
   * Only a definitive refusal (`4xx`) from the Host rolls the value back.
   */
  async toggle(): Promise<void> {
    if (this.state.pending && this.inFlight !== null) return

    // In-process: the Host module answers synchronously and its answer is the
    // truth. No intent, no retry loop, no transport to be filtered.
    if (this.bridgeToggle !== null) {
      try {
        const status = this.bridgeToggle()
        diag(`toggle via bridge -> enabled=${String(status.enabled)} revision=${String(status.revision)}`)
        this.intent = null
        writeIntent(null)
        this.set({ enabled: status.enabled, revision: status.revision, pending: false, unconfirmed: false, connected: true, error: null })
        showToast(status.enabled ? LABEL_ON : LABEL_OFF, status.enabled ? 'success' : 'info')
      }
      catch (error) {
        const message = String((error as Error)?.message ?? error)
        this.set({ pending: false, error: message })
        showToast(`⚠️ 切换失败：${message}`, 'info')
      }
      return
    }

    // Flip relative to what is shown now, so two quick presses mean "back".
    // When the value is unknown (`null`, no successful read yet) there is
    // nothing trustworthy to invert: assume the documented default (ON), so the
    // first press asks for OFF — the only useful action in that situation.
    const target = this.state.enabled === null ? false : !this.state.enabled
    const intent: PendingIntent = { enabled: target, at: Date.now() }
    this.intent = intent
    writeIntent(intent)
    // Show it immediately: the sidebar and the toast must reflect the user's
    // action, not the transport's luck.
    this.set({ enabled: target, pending: true, unconfirmed: true, error: null })
    showToast(target ? LABEL_ON : LABEL_OFF, target ? 'success' : 'info')
    try {
      await this.submit(intent)
    }
    catch (error) {
      const status = error instanceof ToggleError ? error.status : null
      const definitive = status !== null && status >= 400 && status < 500 && status !== 404
      diag(`toggle failed: ${String((error as Error)?.message ?? error)} (definitive=${String(definitive)})`)
      if (!definitive) {
        // Unreachable or unobserved: keep the intent and retry in the
        // background. No error toast — the state is shown as pending instead.
        this.set({ pending: true, unconfirmed: true, connected: false, error: String((error as Error)?.message ?? error) })
        return
      }
      // The Host refused: roll back to the value it confirmed last.
      this.intent = null
      writeIntent(null)
      const message = String((error as Error)?.message ?? error)
      this.set({ enabled: !target, pending: false, unconfirmed: false, error: message })
      showToast(`⚠️ 切换失败：Host 拒绝（${message}）`, 'info')
    }
  }

  /**
   * Apply an explicit value (what the `Switch` reports).
   *
   * A toggle dialog is not involved: the requested value goes to the Host
   * verbatim, so switching on an already-on switch cannot turn it off.
   *
   * @param enabled - the value the user selected.
   */
  async setEnabled(enabled: boolean): Promise<void> {
    if (this.bridgeSet !== null) {
      try {
        const status = this.bridgeSet(enabled)
        this.intent = null
        writeIntent(null)
        this.set({ enabled: status.enabled, revision: status.revision, pending: false, unconfirmed: false, connected: true, error: null })
        showToast(status.enabled ? LABEL_ON : LABEL_OFF, status.enabled ? 'success' : 'info')
      }
      catch (error) {
        const message = String((error as Error)?.message ?? error)
        this.set({ pending: false, error: message })
        showToast(`切换失败：${message}`, 'info')
      }
      return
    }
    if (this.state.enabled === enabled) return
    // The HTTP path already exposes an idempotent set route, so reuse the same
    // optimistic-intent machinery the shortcut uses.
    const intent: PendingIntent = { enabled, at: Date.now() }
    this.intent = intent
    writeIntent(intent)
    this.set({ enabled, pending: true, unconfirmed: true, error: null })
    showToast(enabled ? LABEL_ON : LABEL_OFF, enabled ? 'success' : 'info')
    try {
      await this.submit(intent)
    }
    catch (error) {
      const status = error instanceof ToggleError ? error.status : null
      const definitive = status !== null && status >= 400 && status < 500 && status !== 404
      if (!definitive) {
        this.set({ pending: true, unconfirmed: true, connected: false, error: String((error as Error)?.message ?? error) })
        return
      }
      // Definitive refusal: roll back and say so, exactly like `toggle()`.
      // Without this the switch silently snapped back with no explanation.
      this.intent = null
      writeIntent(null)
      const message = String((error as Error)?.message ?? error)
      this.set({ pending: false, unconfirmed: false, error: message })
      showToast(`切换失败：${message}`, 'info')
    }
  }

  /** Stop notifying and ignore late responses. */
  dispose(): void {
    this.disposed = true
    this.listeners.clear()
  }
}

/* -------------------------------------------------------------------------- */
/* Sidebar control                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The slot the control mounts into.
 *
 * `sidebar.footer.action` is the shell's stable, always-present footer action
 * seat (used by shipped plugins); the control therefore renders without
 * depending on any session being open. `ctx.slots.inject` waits for the slot to
 * be declared and re-registers if it is replaced, and the registration is
 * owned by this plugin's fiber (removed automatically on unload).
 */
const SLOT_KEY = 'sidebar.footer.action'

/**
 * The sidebar control: the shell's own `Switch`, so it looks and behaves like
 * every other toggle in the application instead of a hand-styled fragment.
 *
 * `Switch` is exported by `@deepseek-ai/dsh-client-ui-primitives` with the
 * contract `{ checked, onChange, label, disabled?, title?, className? }` — the
 * same component the settings pages use. Falling back to a plain button keeps
 * the control usable if a future shell drops it.
 *
 * A click hands the requested value straight to the store, which applies it
 * (in-process when the bridge is present, over HTTP otherwise) and updates the
 * state from the Host's answer — never from a local guess.
 */
function AutoApproveSwitchControl(props: { readonly store: SwitchStore; readonly shortcutHint: string }): any {
  const { store, shortcutHint } = props
  const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot)
  const on = state.enabled === true
  const title = state.enabled === null
      ? `自动放行：正在读取状态${state.error === null ? '' : `（${state.error}）`}`
      : state.unconfirmed
        ? `${state.enabled ? LABEL_ON : LABEL_OFF}（等待确认，后台重试中） · ${shortcutHint}`
        : `${state.enabled ? LABEL_ON : LABEL_OFF} · 快捷键 ${shortcutHint}`

  const Switch = primitives?.Switch
  const apply = (next: boolean): void => {
    void store.setEnabled(next)
  }

  if (typeof Switch === 'function') {
    return React.createElement(Switch, {
      checked: on,
      disabled: state.pending,
      // `Switch` takes the visible label as a string; it supplies its own
      // spacing, track, knob and focus ring from the shell's design tokens.
      label: '自动放行',
      title,
      className: 'auto-approve-switch',
      onChange: apply,
    })
  }

  // Fallback for a shell without the primitive: a plain but obvious button.
  return React.createElement(
    'button',
    {
      type: 'button',
      className: 'auto-approve-switch',
      'data-auto-approve-switch': on ? 'on' : 'off',
      'aria-pressed': on,
      'aria-label': title,
      title,
      disabled: state.pending,
      onClick: () => apply(!on),
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '4px 10px',
        borderRadius: '999px',
        border: '1px solid color-mix(in oklab, currentColor 20%, transparent)',
        background: on ? 'color-mix(in oklab, #22c55e 20%, transparent)' : 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: '12px',
        lineHeight: '18px',
        cursor: state.pending ? 'progress' : 'pointer',
        opacity: state.enabled === null ? 0.6 : 1,
      },
    },
    React.createElement('span', {
      'aria-hidden': true,
      style: {
        width: '7px', height: '7px', borderRadius: '50%', flex: 'none',
        background: state.enabled === null ? '#9ca3af' : on ? '#22c55e' : '#ef4444',
      },
    }),
    React.createElement('span', null, '自动放行'),
    React.createElement('span', { 'aria-hidden': true, style: { opacity: 0.6 } }, on ? '开' : state.enabled === null ? '—' : '关'),
  )
}

/* -------------------------------------------------------------------------- */
/* Shortcut                                                                   */
/* -------------------------------------------------------------------------- */

/** The documented default bindings: ⌘⌥A on macOS desktop, Ctrl+Alt+A on Windows. */
const SHORTCUT_DEFAULTS: Record<string, { code: string; modifiers: string[] }> = {
  'desktop:macos': { code: 'KeyA', modifiers: ['primary', 'alt'] },
  'desktop:windows': { code: 'KeyA', modifiers: ['primary', 'alt'] },
  'desktop:linux': { code: 'KeyA', modifiers: ['primary', 'alt'] },
  'web:macos': { code: 'KeyA', modifiers: ['primary', 'alt'] },
  'web:windows': { code: 'KeyA', modifiers: ['primary', 'alt'] },
  'web:linux': { code: 'KeyA', modifiers: ['primary', 'alt'] },
}

/**
 * Human-readable hint for the platform's default binding.
 * @returns `⌘⌥A` on macOS, `Ctrl+Alt+A` elsewhere.
 */
function shortcutHint(): string {
  let mac = true
  try {
    mac = /Mac|iPhone|iPad/i.test(String(navigator.platform || navigator.userAgent))
  }
  catch { /* keep the default */ }
  return mac ? '⌘⌥A' : 'Ctrl+Alt+A'
}

/**
 * Register the toggle command.
 *
 * @param ctx - client context providing `shortcuts`.
 * @param store - the switch store to toggle.
 * @returns whether the command was registered with the shortcut service.
 */
function registerShortcut(ctx: ClientContext, store: SwitchStore): boolean {
  // An undeclared service read can throw on a Cordis context proxy, so this
  // lookup is guarded: no shortcut service simply means "use the fallback".
  let shortcuts: ShortcutService | undefined
  try {
    shortcuts = ctx.shortcuts
  }
  catch {
    return false
  }
  if (shortcuts === undefined || typeof shortcuts.register !== 'function') return false
  try {
    const dispose = shortcuts.register({
      id: COMMAND_ID,
      label: () => '切换自动放行',
      aliases: ['auto approve', 'auto approve switch', '自动放行', '审批'],
      defaults: SHORTCUT_DEFAULTS,
      // Active everywhere a keystroke can land, including the composer and the
      // terminal, because the switch is global rather than per-panel.
      regions: ['page', 'editable', 'terminal'],
      // Allowed while the approval UI itself is open: that is exactly when a
      // user may want to stop the next prompt.
      modals: ['approval', 'settings', 'dialog', 'other'],
      resolve: () => {
        if (store.getSnapshot().pending) {
          return { status: 'blocked', reason: '正在切换自动放行，请稍候' }
        }
        return {
          status: 'handled',
          run: () => {
            void store.toggle()
          },
        }
      },
    })
    ctx.effect(() => dispose, 'auto-approve-switch: shortcut')
    return true
  }
  catch (error) {
    console.error('[auto-approve-switch] could not register the shortcut command', error)
    return false
  }
}

/**
 * Fallback keyboard listener for shells without the shortcut service.
 *
 * Mirrors the declared default exactly (primary+alt+A, no shift). Ignores
 * repeats and IME composition so holding the keys toggles once.
 *
 * @returns the remove-listener disposer.
 */
function installKeyboardFallback(store: SwitchStore): () => void {
  const handler = (event: KeyboardEvent): void => {
    if (event.repeat || event.isComposing) return
    if (event.code !== 'KeyA' || event.shiftKey) return
    // `primary` is Command on macOS and Control elsewhere.
    const primary = /Mac|iPhone|iPad/i.test(String(navigator.platform || navigator.userAgent))
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.metaKey
    if (!primary || !event.altKey) return
    event.preventDefault()
    void store.toggle()
  }
  window.addEventListener('keydown', handler, true)
  return () => window.removeEventListener('keydown', handler, true)
}

/* -------------------------------------------------------------------------- */
/* Plugin entry                                                               */
/* -------------------------------------------------------------------------- */

/** Cordis plugin name (shown in 设置 → 插件). */
export const name = 'auto-approve-switch'

/**
 * No service is required — on purpose.
 *
 * The Web boot treats ANY entry that does not activate as a fatal error
 * (`web boot: N entry did not activate`), so waiting for a service that is
 * absent turns an optional UI feature into a broken application. `slots` and
 * `shortcuts` are therefore read defensively inside `apply`, which degrades per
 * feature: keyboard fallback without the shortcut service, console output
 * without the Toast primitive, no sidebar seat without the slot.
 *
 * An array is the only expressible form anyway: Cordis reads an injection
 * object's keys as service names, so `{ optional: [...] }` would wait for a
 * service literally named `optional` — forever.
 */
export const inject: readonly string[] = []

/**
 * Mount the toggle: shortcut, sidebar control, status polling.
 *
 * @param ctx - Cordis client context.
 */
/**
 * Where the switch actually lives, as seen from this page.
 *
 * `direct` — the Host module is in the same JavaScript realm (Electron desktop:
 * the browser half runs inside the Host process graph). Used when available:
 * no request, no filtering, no latency.
 * `http`   — the documented route seam, used by a plain web Host and any page
 * that cannot see the module.
 */
const DIRECT_BRIDGE_GLOBAL = '__DSH_AUTO_APPROVE_SWITCH__'

interface DirectBridge {
  log?: (line: string) => void
  get: () => { enabled: boolean; revision: number }
  set: (enabled: boolean) => { enabled: boolean; revision: number }
  toggle: () => { enabled: boolean; revision: number }
  subscribe: (listener: () => void) => () => void
}

/** The in-process bridge, when this page shares a realm with the Host. */
function directBridge(): DirectBridge | null {
  try {
    const candidate = (globalThis as any)[DIRECT_BRIDGE_GLOBAL]
    if (candidate !== null && typeof candidate === 'object'
      && typeof candidate.get === 'function'
      && typeof candidate.set === 'function'
      && typeof candidate.subscribe === 'function') {
      return candidate as DirectBridge
    }
  }
  catch { /* inaccessible global: use HTTP */ }
  return null
}

/**
 * Client-side diagnostics.
 *
 * Written through the Host bridge when it exists (same file as the Host half),
 * otherwise to the browser console. Every failure path calls this, so the log
 * says exactly what the page tried and what came back.
 *
 * @param line - one diagnostic line.
 */
let diagTarget: ((line: string) => void) | null = null
function diag(line: string): void {
  try {
    if (diagTarget !== null) diagTarget(line)
    else console.info(`[auto-approve-switch] ${line}`)
  }
  catch { /* logging must never break the plugin */ }
}

export function apply(ctx: ClientContext): void {
  // One store per plugin fiber. It is reachable from the shortcut and the
  // sidebar registration through `inject` factories (see `ctx.slots.inject`
  // below) and is disposed by the host-sync effect.
  const store = new SwitchStore()
  const bridge = directBridge()
  diagTarget = bridge !== null && typeof bridge.log === 'function'
    ? (line) => bridge.log?.(line)
    : (line) => console.info(`[auto-approve-switch] ${line}`)
  diag(`client apply(): bridge=${bridge === null ? 'ABSENT (HTTP fallback)' : 'FOUND (in-process)'}; `
    + `location=${typeof location === 'object' ? String(location.origin) : 'n/a'}`)

  // 0. Prefer the in-process bridge when the Host module shares this realm.
  //    It needs no request at all, so a carrier that filters HTTP cannot make
  //    the switch unreadable or unwritable. HTTP stays as the fallback for
  //    plain web Hosts and remote pages.
  if (bridge !== null) {
    try {
      store.adoptSnapshot(bridge.get())
      ctx.effect(
        () => bridge.subscribe(() => store.adoptSnapshot(bridge.get())),
        'auto-approve-switch: direct bridge',
      )
      console.info('[auto-approve-switch] 使用进程内直连（不经过 HTTP）')
    }
    catch (error) {
      console.warn('[auto-approve-switch] 直连桥不可用，回退到 HTTP', error)
    }
  }
  // When the bridge is live, toggles go straight to the Host module.
  store.useBridge(
    bridge === null ? null : () => bridge.toggle(),
    bridge === null ? null : (enabled: boolean) => bridge.set(enabled),
  )

  // 1 + 2. Shortcut and sidebar control.
  //
  // Both wait for their service LAZILY with `ctx.inject([...], cb)`. Declaring
  // them in the plugin's `inject` would make the fiber wait (and the Web boot
  // treats a non-activating entry as fatal), while reading `ctx.slots` without
  // declaring it throws on a Cordis context proxy. Neither is acceptable, so
  // the shell services are awaited without gating activation — the same shape
  // `dsh-session-purge`'s client uses.
  //
  // This is also why the sidebar control once vanished silently: the read threw,
  // a `catch` swallowed it, and only a console warning remained. Every outcome
  // is now recorded through `diag()`, which reaches the plugin log file.
  // The two triggers must never coexist: the shortcut command and the
  // document-level fallback both toggle, so registering both makes one key
  // press flip the switch twice (which looks like "nothing happened").
  //
  // The previous version raced: a 1500 ms timer decided whether to install the
  // fallback, while `ctx.inject` resolves asynchronously — so a service that
  // arrived at 1600 ms produced both. Ownership is now explicit: whichever
  // registers first owns the trigger, and the other removes itself.
  let removeFallback: (() => void) | null = null
  let shortcutRegistered = false
  const stopFallback = (reason: string): void => {
    if (removeFallback === null) return
    removeFallback()
    removeFallback = null
    diag(`keyboard fallback removed (${reason})`)
  }
  const startFallback = (reason: string): void => {
    if (shortcutRegistered || removeFallback !== null) return
    removeFallback = installKeyboardFallback(store)
    diag(`keyboard fallback installed (${reason})`)
  }

  try {
    ctx.inject(['shortcuts'], (scope: ClientContext) => {
      shortcutRegistered = registerShortcut(scope, store)
      diag(`shortcut service: ${shortcutRegistered ? 'registered' : 'register() refused'}`)
      if (shortcutRegistered) stopFallback('shortcut service became available')
      else startFallback('shortcut service refused the command')
    })
  }
  catch (error) {
    diag(`shortcut service wait failed: ${String((error as Error)?.message ?? error)}`)
    startFallback('shortcut service unavailable')
  }

  try {
    ctx.inject(['slots'], (scope: ClientContext) => {
      try {
        scope.slots.inject(SLOT_KEY, () => scope.slots.register({
          name: SLOT_KEY,
          id: 'auto-approve-switch',
          order: 60,
          inject: () => ({ store, shortcutHint: shortcutHint() }),
        }, AutoApproveSwitchControl))
        diag(`sidebar control: registered into "${SLOT_KEY}"`)
      }
      catch (error) {
        diag(`sidebar control failed: ${String((error as Error)?.message ?? error)}`)
      }
    })
  }
  catch (error) {
    diag(`slots service wait failed: ${String((error as Error)?.message ?? error)}`)
  }

  // Give the shortcut service a grace period; if it never materialises, the
  // fallback keeps the feature usable. `startFallback` is idempotent and stays
  // out of the way once the real command owns the trigger.
  ctx.effect(() => {
    const timer = window.setTimeout(() => startFallback('shortcut service did not mount within 1.5s'), 1500)
    return () => {
      window.clearTimeout(timer)
      stopFallback('plugin disposed')
    }
  }, 'auto-approve-switch: keyboard fallback')

  // 3. Keep this page in sync with the Host (other windows, restored value).
  //    The first read is immediate so the sidebar shows the real state as soon
  //    as the plugin mounts; later reads are spaced out and slowed while the
  //    page is hidden. With the in-process bridge live, the Host pushes every
  //    change instead, so polling is skipped entirely.
  const bridgeLive = bridge !== null && store.getSnapshot().connected
  ctx.effect(() => {
    if (bridgeLive) return () => store.dispose()
    let timer: number | undefined
    let stopped = false
    const schedule = (): void => {
      if (stopped) return
      // While an intent is unconfirmed the loop runs fast so the Host
      // acknowledgement (and any replay) lands quickly; in sync it idles.
      const delay = store.hasUnconfirmedIntent
        ? store.pollDelay
        : document.visibilityState === 'hidden' ? HIDDEN_POLL_MS : POLL_MS
      timer = window.setTimeout(() => void tick(), delay)
    }
    const tick = async (): Promise<void> => {
      if (stopped) return
      await store.refresh(true)
      schedule()
    }
    const onFocus = (): void => {
      void store.refresh(false)
    }
    void tick()
    window.addEventListener('focus', onFocus)
    return () => {
      stopped = true
      window.removeEventListener('focus', onFocus)
      if (timer !== undefined) window.clearTimeout(timer)
      store.dispose()
    }
  }, 'auto-approve-switch: host sync')

  diag(`client ready: shortcut=${shortcutRegistered ? 'service' : 'keyboard fallback'}; ui=${typeof primitives?.Switch === 'function' ? 'Switch' : 'fallback button'}`)
}