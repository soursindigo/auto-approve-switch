/**
 * Activation tests against the REAL Cordis runtime.
 *
 * These exist because a unit test with a hand-written fake context cannot see
 * the one thing that broke the desktop app twice: how Cordis INTERPRETS a
 * plugin's `inject` declaration. `Inject.resolve` treats an object's keys as
 * service names, so `{ required: [...], optional: [...] }` declares services
 * named `required` and `optional`; they never exist, the fiber waits forever,
 * `apply()` never runs, and the Web boot fails with
 *
 *   web boot: 1 entry did not activate
 *   auto-approve-switch: pending (waiting for service: optional)
 *
 * Cordis is resolved from the installed application bundle. When that bundle is
 * not present (a plain checkout, CI), the suite skips instead of failing.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

/**
 * Cordis is a devDependency pinned to the version the shipped app bundles
 * (4.0.5), so these tests exercise the same injection semantics the Loader
 * does. When it is not installed (a bare checkout), the suite skips.
 */
const CORDIS_MANIFEST = new URL('../node_modules/@deepseek-ai/cordis/package.json', import.meta.url)

/** Load Cordis, or `null` when it is not installed. */
async function loadCordis() {
  try {
    const require = createRequire(CORDIS_MANIFEST)
    return await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href)
  }
  catch {
    return null
  }
}

const cordis = await loadCordis()
const skip = cordis === null ? '@deepseek-ai/cordis is not installed (run npm install)' : false

/** Import a built module by URL, bypassing this package's exports map. */
async function load(relative) {
  return await import(new URL(relative, import.meta.url).href)
}

/**
 * Mount a plugin the way the Loader does and report whether it activated.
 * @param ctx - context to mount into.
 * @param plugin - module with `name`, `inject`, `apply`.
 * @param config - row config.
 */
async function mount(ctx, plugin, config = {}) {
  let applied = false
  const fiber = ctx.plugin({
    name: plugin.name,
    inject: plugin.inject,
    apply(inner) {
      applied = true
      plugin.apply(inner, config)
    },
  })
  // Activation is asynchronous; a pending fiber never calls apply().
  await new Promise((resolve) => setTimeout(resolve, 50))
  return { fiber, applied }
}

test('host: inject is an array of service names (Cordis reads object keys as names)', { skip }, async () => {
  const { Inject } = cordis
  const host = await load('../lib/index.js')

  assert.ok(Array.isArray(host.inject), `host inject must be an array, got ${JSON.stringify(host.inject)}`)
  assert.deepEqual(Object.keys(Inject.resolve(host.inject)), [], 'host must not wait for any service')

  // The exact historical failure, asserted as a shape rule.
  assert.deepEqual(Object.keys(Inject.resolve({ required: ['tools'], optional: [] })), ['required', 'optional'])
  assert.deepEqual(Object.keys(Inject.resolve({ optional: ['slots'] })), ['optional'])
})

test('host: activates in Cordis and intercepts tools/pre-execute', { skip }, async () => {
  const { Context } = cordis
  const host = await load('../lib/index.js')
  const app = new Context()
  try {
    const { applied } = await mount(app, host, { persist: false })
    assert.equal(applied, true, 'apply() ran, so the row is not pending')

    const seed = { kind: 'allow' }
    const on = await app.waterfall('tools/pre-execute', { name: 'bash' }, () => Promise.resolve(seed))
    assert.deepEqual(on, { kind: 'allow' })

    host.setAutoApproveEnabled(false, 'test')
    let reachedSeed = false
    const off = await app.waterfall('tools/pre-execute', { name: 'bash' }, () => {
      reachedSeed = true
      return Promise.resolve(seed)
    })
    assert.equal(reachedSeed, true, 'OFF hands the call back with next()')
    assert.deepEqual(off, seed)
  }
  finally {
    host.setAutoApproveEnabled(true, 'test-reset')
  }
})

test('host: mounts as the WHOLE module namespace the way the Loader does', { skip }, async () => {
  const { Context } = cordis
  const host = await load('../lib/index.js')
  const app = new Context()

  // The Loader hands Cordis the package's module namespace, so every export
  // becomes plugin metadata. Exporting `Config` as a plain descriptor object
  // made Cordis call `Config.validate(...)`, throw, and mark the fiber FAILED
  // (state 3) — apply() never ran, and because a failed non-required row is only
  // a startup warning, the app booted fine while the plugin did nothing.
  assert.equal('Config' in host, false, 'must not export a non-schema Config')

  let applied = false
  const fiber = app.plugin({
    ...host,
    apply(inner) {
      applied = true
      host.apply(inner, {})
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(applied, true, `fiber did not activate (state ${String(fiber.state)})`)
})

test('host: optional services may be absent without holding the fiber', { skip }, async () => {
  const { Context } = cordis
  const host = await load('../lib/index.js')
  const app = new Context() // no webServer, no storageDomain
  const { applied } = await mount(app, host, { persist: true })
  assert.equal(applied, true)
})

test('client: inject is an array and activates with the shell services present', { skip }, async () => {
  const { Context } = cordis

  // A browser bundle registers on `window.__ModuleLoader__` at module load, so
  // the DOM surface must exist before the import.
  const registrations = []
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
    __ModuleLoader__: {
      load(registration) {
        globalThis.window.__registration = registration
      },
    },
  }
  globalThis.document = {
    body: { appendChild() {} },
    visibilityState: 'visible',
    createElement: () => ({ dataset: {}, remove() {} }),
    addEventListener() {},
    removeEventListener() {},
  }
  await import(new URL('../lib/client.js', import.meta.url).href)
  const registration = globalThis.window.__registration
  assert.ok(registration, 'the bundle registered a factory')
  assert.equal(registration.id, 'auto-approve-switch')

  const seeds = {
    'react': { createElement: () => null, useSyncExternalStore: (_s, get) => get() },
    'react-dom/client': { createRoot: () => ({ render() {}, unmount() {} }) },
    '@deepseek-ai/dsh-client-ui-primitives': {
      Toast: function Toast() { return null },
      IconWarningOutlineRegular: function Icon() { return null },
    },
  }
  const client = registration.factory((specifier) => seeds[specifier])
  assert.ok(Array.isArray(client.inject), `client inject must be an array, got ${JSON.stringify(client.inject)}`)

  // 1) With NO shell service at all the fiber must still activate: the Web boot
  //    treats a non-activating entry as a fatal application error.
  const bare = new Context()
  let bareApplied = false
  bare.plugin({
    name: client.name,
    inject: client.inject,
    apply(inner) { bareApplied = true; client.apply(inner) },
  })
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(bareApplied, true, 'client activates even with no shell services')

  // 2) With the shell services present, the shortcut command is registered.
  const app = new Context()
  app.provide('slots', {
    inject(_key, callback) { callback() },
    register(options) { registrations.push(options); return () => {} },
  })
  app.provide('shortcuts', {
    register(command) { registrations.push(command); return () => {} },
  })

  let applied = false
  app.plugin({
    name: client.name,
    inject: client.inject,
    apply(inner) {
      applied = true
      client.apply(inner)
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(applied, true, 'client apply() ran (fiber not pending)')
  assert.ok(
    registrations.some((row) => row.id === 'auto-approve-switch.toggle'),
    'the toggle command was registered with the shortcut service',
  )
})
