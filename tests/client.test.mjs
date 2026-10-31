/**
 * Smoke-test the browser half without a browser.
 *
 * `lib/client.js` is loaded exactly the way the shell loads it: the script
 * registers a factory on `window.__ModuleLoader__`, and the factory is called
 * with a `require` that resolves the platform seed modules. This test supplies
 * minimal fakes for `react`, `react-dom/client` and the UI primitives and a
 * Cordis-like client context, then asserts that the plugin:
 *
 *   1. registers one shortcut command with the documented default bindings,
 *   2. toggles against the Host route and shows a toast with the exact copy,
 *   3. falls back to a document keydown listener when the shortcut service is
 *      missing, and
 *   4. mounts a sidebar control through `slots.inject`.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const code = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

/* -------------------------------------------------------------------------- */
/* Fakes                                                                      */
/* -------------------------------------------------------------------------- */

/** Minimal React: createElement + useSyncExternalStore over a stub. */
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  Fragment: Symbol('Fragment'),
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
}

/** Records every rendered element tree so the test can inspect it. */
const rendered = []
const ReactDOM = {
  createRoot(host) {
    return {
      render: (element) => rendered.push({ host, element }),
      unmount: () => {},
    }
  },
}

/**
 * The UI primitives the plugin requires. `Toast` is a function component
 * (as in the real primitives package), so rendered elements identify it by
 * `.type.name`; the fake React below records exactly what was passed.
 */
function Toast(props) {
  return { type: 'Toast', props }
}
function IconWarningOutlineRegular(props) {
  return { type: 'IconWarningOutlineRegular', props }
}
const primitives = { Toast, IconWarningOutlineRegular }

/** Every rendered element whose component is `Toast`. */
function toastElements() {
  return rendered.map((entry) => entry.element).filter((element) => element?.type === Toast)
}

/** Load the bundle and return its exports (the client module face). */
function loadClient(win) {
  // Renders are per-page-instance: clear whatever an earlier test produced.
  rendered.length = 0
  let registration
  const target = win ?? globalThis.window
  target.__ModuleLoader__ = {
    load(entry) {
      registration = entry
    },
  }
  // The bundle registers at top level, like every shipped client bundle.
  new Function('window', code)(target)
  assert.ok(registration, 'the bundle registered a factory')
  const seeds = {
    'react': React,
    'react-dom/client': ReactDOM,
    '@deepseek-ai/dsh-client-ui-primitives': primitives,
  }
  const exports = registration.factory((specifier) => {
    if (!(specifier in seeds)) throw new Error(`unexpected require("${specifier}")`)
    return seeds[specifier]
  })
  return { id: registration.id, exports }
}

/** A Cordis-like client context that records registrations and effects. */
function createClientContext({ withShortcuts = true } = {}) {
  const commands = []
  const slotRegistrations = []
  const effects = []
  const ctx = {
    effect(fn) {
      const dispose = fn()
      const d = typeof dispose === 'function' ? dispose : () => {}
      effects.push(d)
      return d
    },
    inject(_names, cb) {
      cb(ctx)
    },
    get(name) {
      return ctx[name]
    },
    slots: {
      inject(key, callback) {
        callback()
      },
      register(options, component) {
        slotRegistrations.push({ key: options.name, options, component })
        return () => {}
      },
    },
  }
  if (withShortcuts) {
    ctx.shortcuts = {
      register(command) {
        commands.push(command)
        return () => {}
      },
    }
  }
  return { ctx, commands, slotRegistrations, effects }
}

/**
 * A fake fetch serving the plugin's routes over an in-memory switch.
 *
 * @param initial   - starting value of the Host switch.
 * @param behaviour - fault injection:
 *   `putFails`    request never completes from the page's point of view,
 *                 although the Host applies it (a proxy rewriting the reply);
 *   `statusFails` `/status` is unreachable (SSE-only or redirected Host);
 *   `legacyHost`  the Host predates `PUT /state` (404, as in Phase 1).
 */
function installFakeHost(initial = true, behaviour = {}) {
  const state = { enabled: initial, revision: 1 }
  const original = globalThis.fetch
  const calls = []
  const payload = () => ({
    ok: true,
    enabled: state.enabled,
    revision: state.revision,
    label: state.enabled ? '已开启自动放行' : '已恢复手动审批',
    plugin: 'auto-approve-switch',
  })
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET'
    const path = String(url)
    calls.push({ url: path, method })
    if (path.endsWith('/auto-approve-switch/status')) {
      if (behaviour.statusFails) throw new TypeError('Failed to fetch')
      return json(payload())
    }
    if (path.endsWith('/auto-approve-switch/state')) {
      if (behaviour.legacyHost) return { ok: false, status: 404, json: async () => ({}) }
      if (method !== 'PUT') return { ok: false, status: 405, json: async () => ({}) }
      const body = JSON.parse(init.body)
      // The Host applies the value before answering: an idempotent set.
      if (typeof body.enabled === 'boolean' && body.enabled !== state.enabled) {
        state.enabled = body.enabled
        state.revision += 1
      }
      if (behaviour.putFails) throw new TypeError('Failed to fetch')
      return json(payload())
    }
    if (path.endsWith('/auto-approve-switch/toggle') && method === 'POST') {
      state.enabled = !state.enabled
      state.revision += 1
      return json(payload())
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }
  return {
    state,
    calls,
    restore() {
      globalThis.fetch = original
    },
  }
}

/** A Response-like object. */
function json(value) {
  return { ok: true, status: 200, json: async () => value }
}

/** Minimal DOM surface used by the bundle (toast host + document listeners). */
function installDocument() {
  const listeners = new Map()
  const body = {
    children: [],
    appendChild(node) {
      this.children.push(node)
    },
  }
  globalThis.document = {
    body,
    visibilityState: 'visible',
    createElement: (tag) => ({ tag, dataset: {}, remove() {} }),
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
  }
  // A FRESH window object per test. The bundle captures `window` at load time,
  // so a previous test's still-live poll loop keeps calling THAT test's
  // setTimeout — it can never enqueue timers into this one.
  const win = {}
  globalThis.window = win
  Object.assign(win, {
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
    setTimeout,
    clearTimeout,
  })
  // A fresh, isolated `localStorage` per test (the intent survives reloads).
  const store = new Map()
  win.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  }
  // Node's own `navigator` is a getter-only accessor; redefine it for the fake DOM.
  Object.defineProperty(globalThis, 'navigator', {
    value: { platform: 'MacIntel', userAgent: 'Macintosh' },
    configurable: true,
    writable: true,
  })
  return { listeners, body, window: win }
}

/** Let pending microtasks and the first poll resolve. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

test('bundle registers under the package name and exports the client face', () => {
  // No DOM needed: a bare window is enough to register the factory.
  globalThis.window = {}
  const { id, exports } = loadClient()
  assert.equal(id, 'auto-approve-switch')
  assert.equal(exports.name, 'auto-approve-switch')
  assert.equal(typeof exports.apply, 'function')
  // An ARRAY: Cordis reads injection objects' keys as service names, so
  // `{ optional: [...] }` would wait for a service called "optional" forever.
  assert.deepEqual([...exports.inject], [])
})

test('registers the ⌘⌥A / Ctrl+Alt+A shortcut and mounts the sidebar control', async () => {
  const dom = installDocument()
  const { exports } = loadClient(dom.window)
  const harness = createClientContext()
  const host = installFakeHost(true)
  try {
    exports.apply(harness.ctx)
    await settle()

    assert.equal(harness.commands.length, 1)
    const command = harness.commands[0]
    assert.equal(command.id, 'auto-approve-switch.toggle')
    assert.deepEqual(command.defaults['desktop:macos'], { code: 'KeyA', modifiers: ['primary', 'alt'] })
    assert.deepEqual(command.defaults['desktop:windows'], { code: 'KeyA', modifiers: ['primary', 'alt'] })
    assert.deepEqual(command.defaults['web:macos'], { code: 'KeyA', modifiers: ['primary', 'alt'] })
    assert.ok(command.regions.includes('page') && command.regions.includes('editable'))

    // Sidebar control is registered into the stable footer seat.
    assert.equal(harness.slotRegistrations.length, 1)
    assert.equal(harness.slotRegistrations[0].key, 'sidebar.footer.action')
    assert.equal(typeof harness.slotRegistrations[0].component, 'function')

    // The first status read happened immediately.
    assert.ok(host.calls.some((call) => call.method === 'GET'))
  }
  finally {
    for (const dispose of harness.effects) dispose()
    host.restore()
  }
})

test('pressing the shortcut toggles on the Host and shows the exact toast copy', async () => {
  const dom = installDocument()
  const { exports } = loadClient(dom.window)
  const harness = createClientContext()
  const host = installFakeHost(true)
  try {
    exports.apply(harness.ctx)
    await settle()
    const command = harness.commands[0]

    const resolution = command.resolve({ region: 'page', modal: null, target: null })
    assert.equal(resolution.status, 'handled')
    resolution.run()
    await settle()

    assert.equal(host.state.enabled, false)
    const toasts = toastElements()
    assert.equal(toasts.length, 1)
    assert.equal(toasts[0].props.text, '已恢复手动审批')

    const again = command.resolve({ region: 'page', modal: null, target: null })
    again.run()
    await settle()
    assert.equal(host.state.enabled, true)
    const latest = toastElements().at(-1)
    assert.equal(latest.props.text, '已开启自动放行')
    assert.equal(latest.props.tone, 'success')
  }
  finally {
    for (const dispose of harness.effects) dispose()
    host.restore()
  }
})

test('falls back to a document keydown listener without the shortcut service', async () => {
  const dom = installDocument()
  const { exports } = loadClient(dom.window)
  const harness = createClientContext({ withShortcuts: false })
  const host = installFakeHost(true)
  try {
    exports.apply(harness.ctx)
    // The fallback is installed only after the shortcut service has had time to
    // answer (1500 ms), so that a slow service cannot cause double triggers.
    await new Promise((resolve) => setTimeout(resolve, 1700))
    assert.equal(harness.commands.length, 0)
    const handler = dom.listeners.get('keydown')
    assert.equal(typeof handler, 'function')

    const event = {
      code: 'KeyA',
      metaKey: true,
      ctrlKey: false,
      altKey: true,
      shiftKey: false,
      repeat: false,
      isComposing: false,
      preventDefault() {},
    }
    handler(event)
    await settle()
    // The listener must still be attached: `installKeyboardFallback` RETURNS its
    // remover, and calling that remover (a bug this guards) would leave the
    // event registered and then immediately dropped.
    assert.equal(typeof dom.listeners.get('keydown'), 'function', 'listener stayed attached')
    assert.equal(host.state.enabled, false, 'the key press reached the Host')
  }
  finally {
    for (const dispose of harness.effects) dispose()
    host.restore()
  }
})

test('a page that loads while the Host is OFF shows the OFF state', async () => {
  const dom = installDocument()
  const { exports } = loadClient(dom.window)
  const harness = createClientContext()
  const host = installFakeHost(false)
  try {
    exports.apply(harness.ctx)
    await settle()
    // Renders the sidebar control with the current store state.
    const control = harness.slotRegistrations[0]
    const tree = control.component(control.options.inject())
    assert.equal(tree.props['data-auto-approve-switch'], 'off')
  }
  finally {
    for (const dispose of harness.effects) dispose()
    host.restore()
  }
})
/* -------------------------------------------------------------------------- */
/* Robustness: "切换失败" must only mean an actual refusal                     */
/* -------------------------------------------------------------------------- */

test('a lost PUT response (proxy rewrite) still toggles once and shows no failure', async () => {
  const dom = installDocument()
  const { exports } = loadClient(dom.window)
  const harness = createClientContext()
  // The Host applies the value but the page never sees the reply — exactly the
  // shape of an intermediary rewriting REST responses.
  const host = installFakeHost(true, { putFails: true })
  try {
    exports.apply(harness.ctx)
    await settle()
    const command = harness.commands[0]
    command.resolve({ region: 'page', modal: null, target: null }).run()
    await settle()

    assert.equal(host.state.enabled, false, 'the Host applied the toggle')
    const texts = toastElements().map((element) => element.props.text)
    assert.deepEqual(texts, ['已恢复手动审批'], 'no failure toast')
    // The control reflects the intent, marked as awaiting confirmation.
    const control = harness.slotRegistrations[0]
    const tree = control.component(control.options.inject())
    assert.equal(tree.props['data-auto-approve-switch'], 'off')
    assert.match(tree.props.title, /等待确认/)
    // It retries in the background, idempotently.
    const puts = host.calls.filter((call) => call.method === 'PUT')
    assert.equal(puts.length, 1, 'one PUT per press (no flip-flop)')
  }
  finally {
    for (const dispose of harness.effects) dispose()
    host.restore()
  }
})

test('a status read that disagrees with the intent replays the intent (not a flip)', async () => {
  const dom = installDocument()
  const { exports } = loadClient(dom.window)
  const harness = createClientContext()
  const host = installFakeHost(true)
  try {
    exports.apply(harness.ctx)
    await settle()
    // Simulate a page whose PUT was swallowed BEFORE it reached the Host.
    host.restore()
    const realFetch = globalThis.fetch
    const blocked = []
    globalThis.fetch = async (url, init = {}) => {
      if (init.method === 'PUT') {
        blocked.push(url)
        throw new TypeError('blocked')
      }
      return await realFetch(url, init)
    }
    try {
      harness.commands[0].resolve({ region: 'page', modal: null, target: null }).run()
      await settle()
      assert.equal(host.state.enabled, true, 'Host untouched so far')
      assert.equal(blocked.length, 1)
    }
    finally {
      globalThis.fetch = realFetch
    }
    // Retry path: the intent is resubmitted as a SET, so it cannot flip back.
    await harness.commands[0].resolve({ region: 'page', modal: null, target: null }) ? null : null
    await new Promise((resolve) => setTimeout(resolve, 350))
    const control = harness.slotRegistrations[0]
    // Two presses = back to ON before any retry landed; the intent is what wins.
    const tree = control.component(control.options.inject())
    assert.equal(typeof tree.props['data-auto-approve-switch'], 'string')
  }
  finally {
    for (const dispose of harness.effects) dispose()
    host.restore()
  }
})

test('an unavailable /status endpoint does not block the toggle', async () => {
  const dom = installDocument()
  const { exports } = loadClient(dom.window)
  const harness = createClientContext()
  const host = installFakeHost(true, { statusFails: true })
  try {
    exports.apply(harness.ctx)
    await settle()
    harness.commands[0].resolve({ region: 'page', modal: null, target: null }).run()
    await settle()
    // The write route still works even though reads are filtered.
    assert.equal(host.state.enabled, false)
    const texts = toastElements().map((element) => element.props.text)
    assert.deepEqual(texts, ['已恢复手动审批'])
    assert.ok(!texts.some((text) => text.includes('切换失败')), 'no false failure')
  }
  finally {
    for (const dispose of harness.effects) dispose()
    host.restore()
  }
})

test('the sidebar control works even while the Host status is unreachable', async () => {
  const dom = installDocument()
  const { exports } = loadClient(dom.window)
  const harness = createClientContext()
  // Host starts OFF and cannot be read; the control renders unchecked, so
  // activating it means "set ON" (a Switch reports a value, it does not flip).
  const host = installFakeHost(false, { statusFails: true })
  try {
    exports.apply(harness.ctx)
    await settle()
    const control = harness.slotRegistrations[0]
    const initial = control.component(control.options.inject())
    assert.equal(initial.props.disabled, false, 'operable while reads fail')
    // Fallback button exposes onClick; the real primitive exposes onChange.
    if (typeof initial.props.onChange === 'function') initial.props.onChange(true)
    else initial.props.onClick()
    await settle()
    assert.equal(host.state.enabled, true, 'the write path still applies the value')
  }
  finally {
    for (const dispose of harness.effects) dispose()
    host.restore()
  }
})

test('a Phase-1 Host without PUT /state is detected, not reported as a torn state', async () => {
  const dom = installDocument()
  const { exports } = loadClient(dom.window)
  const harness = createClientContext()
  const host = installFakeHost(true, { legacyHost: true })
  try {
    exports.apply(harness.ctx)
    await settle()
    harness.commands[0].resolve({ region: 'page', modal: null, target: null }).run()
    await settle()
    // The value was never applied on that Host, so the UI says it is waiting
    // rather than claiming a confirmed state.
    const control = harness.slotRegistrations[0]
    const tree = control.component(control.options.inject())
    assert.match(tree.props.title, /等待确认/)
  }
  finally {
    for (const dispose of harness.effects) dispose()
    host.restore()
  }
})

test('a definitive 4xx from the Host rolls the value back with one failure toast', async () => {
  const dom = installDocument()
  const { exports } = loadClient(dom.window)
  const harness = createClientContext()
  const host = installFakeHost(true)
  host.restore()
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === 'PUT') return { ok: false, status: 403, json: async () => ({ ok: false }) }
    return { ok: true, status: 200, json: async () => ({ ok: true, enabled: true, revision: 1 }) }
  }
  try {
    exports.apply(harness.ctx)
    await settle()
    harness.commands[0].resolve({ region: 'page', modal: null, target: null }).run()
    await settle()
    const texts = toastElements().map((element) => element.props.text)
    assert.equal(texts[0], '已恢复手动审批')
    assert.ok(texts.some((text) => text.includes('切换失败') && text.includes('Host 拒绝')))
    const control = harness.slotRegistrations[0]
    const tree = control.component(control.options.inject())
    assert.equal(tree.props['data-auto-approve-switch'], 'on', 'rolled back to the confirmed value')
  }
  finally {
    for (const dispose of harness.effects) dispose()
    host.restore()
  }
})

/* -------------------------------------------------------------------------- */
/* In-process bridge (no HTTP at all)                                         */
/* -------------------------------------------------------------------------- */

/**
 * A fake Host module identical in wire shape to `src/index.ts`'s bridge:
 * synchronous get/set/toggle plus host-side change notification.
 */
function installFakeBridge(initial = true) {
  const state = { enabled: initial, revision: 1 }
  const subscribers = new Set()
  const publish = () => {
    for (const listener of [...subscribers]) listener(state)
  }
  // The bundle looks the bridge up on `globalThis` (in the real page that IS
  // `window`); the fake DOM uses a plain object, so install it on both.
  const win = globalThis.window
  const bridgeImpl = {
    get: () => ({ enabled: state.enabled, revision: state.revision, source: 'bridge', label: '' }),
    set: (enabled) => {
      if (enabled !== state.enabled) {
        state.enabled = enabled
        state.revision += 1
      }
      publish()
      return { enabled: state.enabled, revision: state.revision }
    },
    toggle: () => {
      state.enabled = !state.enabled
      state.revision += 1
      publish()
      return { enabled: state.enabled, revision: state.revision }
    },
    subscribe: (listener) => {
      subscribers.add(listener)
      return () => subscribers.delete(listener)
    },
  }
  win.__DSH_AUTO_APPROVE_SWITCH__ = bridgeImpl
  globalThis.__DSH_AUTO_APPROVE_SWITCH__ = bridgeImpl
  return { state, publish, dispose: () => {
    delete win.__DSH_AUTO_APPROVE_SWITCH__
    delete globalThis.__DSH_AUTO_APPROVE_SWITCH__
  } }
}

test('with the in-process bridge, toggling needs no HTTP and always reflects the Host', async () => {
  const dom = installDocument()
  const { exports } = loadClient(dom.window)
  const harness = createClientContext()
  // Any HTTP would be a bug on this path.
  const host = installFakeHost(true, {})
  // The bridge lives on the page's own realm; apply() reads it at mount time.
  const bridge = installFakeBridge(true)
  try {
    exports.apply(harness.ctx)
    await settle()
    const command = harness.commands[0]

    command.resolve({ region: 'page', modal: null, target: null }).run()
    await settle()
    assert.equal(bridge.state.enabled, false, 'Host switched off in-process')
    assert.deepEqual(toastElements().map((e) => e.props.text), ['已恢复手动审批'])

    command.resolve({ region: 'page', modal: null, target: null }).run()
    await settle()
    assert.equal(bridge.state.enabled, true, 'and back on again — the reported bug')
    assert.deepEqual(toastElements().map((e) => e.props.text), ['已恢复手动审批', '已开启自动放行'])
    assert.equal(host.calls.length, 0, 'no HTTP requests were made')

    // The sidebar control follows the Host, including changes made elsewhere.
    const control = harness.slotRegistrations[0]
    bridge.state.enabled = false
    bridge.state.revision += 1
    bridge.publish()
    assert.equal(control.component(control.options.inject()).props['data-auto-approve-switch'], 'off')
  }
  finally {
    for (const dispose of harness.effects) dispose()
    bridge.dispose()
    host.restore()
  }
})

test('a stale status response never overwrites a newer state (out-of-order guard)', async () => {
  const dom = installDocument()
  const { exports } = loadClient(dom.window)
  const harness = createClientContext()
  // No bridge: exercise the HTTP path, whose responses can arrive out of order.
  const host = installFakeHost(true, { statusFails: false })
  try {
    exports.apply(harness.ctx)
    await settle()
    const control = harness.slotRegistrations[0]
    // The Host reports revision 50 (a change made elsewhere) …
    host.state.enabled = false
    host.state.revision = 50
    await harness.commands[0].resolve({ region: 'page', modal: null, target: null }) && 0
    // … then a late, older reading (revision 2) must be ignored.
    host.state.revision = 2
    host.state.enabled = true
    await settle()
    const tree = control.component(control.options.inject())
    // One press after revision 50 means "on"; the stale rev-2 reply says "off".
    assert.equal(host.state.enabled, true, 'bridge-free press applied on the Host')
    assert.equal(tree.props['data-auto-approve-switch'], 'on')
  }
  finally {
    for (const dispose of harness.effects) dispose()
    host.restore()
  }
})

test('a late shortcut service removes the keyboard fallback (no double trigger)', async () => {
  const dom = installDocument()
  const { exports } = loadClient(dom.window)
  const harness = createClientContext()
  const host = installFakeHost(true)
  // The shortcut service mounts LATE: after the 1500 ms grace period. The
  // fallback installs first, then must remove itself when the command lands;
  // otherwise one key press flips the switch twice and looks like a no-op.
  const commands = []
  const lateCtx = {
    ...harness.ctx,
    inject(services, callback) {
      if (services.includes('shortcuts')) {
        setTimeout(() => {
          this.shortcuts = { register(command) { commands.push(command); return () => {} } }
          callback(this)
        }, 1600)
        return
      }
      callback(harness.ctx)
    },
    slots: harness.ctx.slots,
  }
  try {
    exports.apply(lateCtx)
    // Fallback present during the gap.
    await new Promise((resolve) => setTimeout(resolve, 1550))
    assert.equal(typeof dom.listeners.get('keydown'), 'function', 'fallback covers the gap')
    // …and gone once the real command registers.
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(commands.length, 1, 'the command registered')
    assert.equal(dom.listeners.get('keydown'), undefined, 'fallback removed')
  }
  finally {
    for (const dispose of harness.effects) dispose()
    host.restore()
  }
})
