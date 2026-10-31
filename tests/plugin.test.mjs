/**
 * Tests for the host half (`src/index.ts` → `lib/index.js`).
 *
 * Run with `npm test` (node:test, no runner dependency). The suite exercises
 * the plugin through a minimal Cordis stand-in that reproduces the two
 * behaviours the plugin depends on:
 *
 *   - `ctx.on('tools/pre-execute', fn)` registers a waterfall listener; the
 *     registry calls it as `fn(exec, next)` and uses whatever it returns, or
 *     the seed `{ kind: 'allow' }` when it returned `undefined` after `next()`.
 *   - `ctx.effect(fn, label)` runs `fn()` immediately and keeps its returned
 *     disposer for teardown (same shape as the real cordis fiber).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import * as plugin from '../lib/index.js'

/* -------------------------------------------------------------------------- */
/* A minimal Cordis-compatible context                                        */
/* -------------------------------------------------------------------------- */

/**
 * Build a context that records listeners and effects.
 * @param {object} [options]
 * @param {object} [options.services] - services resolved by `ctx.inject`/`ctx.get`.
 */
function createContext({ services = {} } = {}) {
  /** @type {Array<(exec: any, next: () => Promise<any>) => any>} */
  const listeners = []
  /** @type {Array<() => void>} */
  const effects = []
  /** @type {Array<{ dispose: () => void }>} */
  const children = []

  const make = (extra = {}) => {
    const ctx = {
      effect(fn, _label) {
        const dispose = fn()
        const d = typeof dispose === 'function' ? dispose : () => {}
        effects.push(d)
        return d
      },
      inject(names, callback) {
        const resolved = {}
        let ready = true
        for (const name of names) {
          if (services[name] === undefined) ready = false
          resolved[name] = services[name]
        }
        const child = { disposed: false, dispose() { this.disposed = true } }
        children.push(child)
        if (ready) {
          const childCtx = make({ ...extra, ...resolved })
          childCtx.child = child
          childCtx.disposeSelf = () => child.dispose()
          callback(childCtx)
        }
        return child
      },
      on(event, fn) {
        assert.equal(event, 'tools/pre-execute')
        listeners.push(fn)
        return () => {
          const at = listeners.indexOf(fn)
          if (at !== -1) listeners.splice(at, 1)
        }
      },
      get(name) {
        return services[name]
      },
      ...extra,
    }
    return ctx
  }

  const ctx = make()
  return {
    ctx,
    listeners,
    /** Run the waterfall the way ToolRegistry.prepareExecution does. */
    async runWaterfall(exec, seed = { kind: 'allow' }) {
      const callNext = async (index = 0) => {
        const listener = listeners[index]
        if (listener === undefined) return seed
        const decision = await listener(exec, () => callNext(index + 1))
        // Returning nothing after `next()` means "no opinion" — the waterfall
        // keeps whatever the downstream chain produced.
        return decision === undefined ? seed : decision
      }
      return await callNext(0)
    },
    dispose() {
      for (const dispose of effects.reverse()) dispose()
    },
  }
}

/** A typical frozen execution object. */
function toolCall(name = 'bash') {
  return { name, arguments: { command: 'echo hi' }, callId: 'call-1', signal: new AbortController().signal }
}

/* -------------------------------------------------------------------------- */
/* Interceptor behaviour                                                      */
/* -------------------------------------------------------------------------- */

test('default state is ON and returns { kind: "allow" }', async () => {
  const harness = createContext()
  plugin.apply(harness.ctx, { persist: false })

  assert.equal(plugin.isAutoApproveEnabled, true)
  assert.deepEqual(await harness.runWaterfall(toolCall('bash')), { kind: 'allow' })
  harness.dispose()
})

test('OFF hands the call back with next() and contributes no decision', async () => {
  const harness = createContext()
  plugin.apply(harness.ctx, { persist: false })
  plugin.toggleAutoApprove('test')
  assert.equal(plugin.isAutoApproveEnabled, false)

  // The downstream listener decides; the plugin must not have claimed the call.
  let downstreamAsked = false
  harness.listeners.push(async () => {
    downstreamAsked = true
    return { kind: 'ask', reason: 'needs approval' }
  })
  const decision = await harness.runWaterfall(toolCall('write'))
  assert.equal(downstreamAsked, true)
  assert.deepEqual(decision, { kind: 'ask', reason: 'needs approval' })
  assert.equal(plugin.getStatus().stats.deferred, 1)
  harness.dispose()
})

test('OFF with no other listener falls through to the seed (native path)', async () => {
  const harness = createContext()
  plugin.apply(harness.ctx, { persist: false })
  plugin.setAutoApproveEnabled(false, 'test')
  const decision = await harness.runWaterfall(toolCall('bash'))
  // The registry seed is `{ kind: 'allow' }`; crucially the plugin returned
  // nothing of its own, which is what "hand back to DSH" means here.
  assert.deepEqual(decision, { kind: 'allow' })
  const status = plugin.getStatus()
  assert.equal(status.stats.deferred, 1)
  assert.equal(status.stats.allowed, 0)
  harness.dispose()
})

test('an upstream deny/ask runs before this plugin and is preserved', async () => {
  const harness = createContext()
  // Registered BEFORE the plugin: runs first in the waterfall.
  harness.listeners.push(async () => ({ kind: 'deny', reason: 'blocked by policy' }))
  plugin.apply(harness.ctx, { persist: false })
  assert.equal(plugin.isAutoApproveEnabled, true)
  const decision = await harness.runWaterfall(toolCall('rm'))
  assert.deepEqual(decision, { kind: 'deny', reason: 'blocked by policy' })
  // The plugin never saw the call at all.
  assert.equal(plugin.getStatus().stats.allowed, 0)
  harness.dispose()
})

test('while ON the plugin ends the waterfall (no prompt can be produced later)', async () => {
  // This is the intended meaning of auto-approval: with the switch ON, an
  // `ask` producer registered after this plugin is never reached.
  const harness = createContext()
  plugin.apply(harness.ctx, { persist: false })
  let asked = false
  harness.listeners.push(async () => {
    asked = true
    return { kind: 'ask', reason: 'prompt me' }
  })
  const decision = await harness.runWaterfall(toolCall('bash'))
  assert.deepEqual(decision, { kind: 'allow' })
  assert.equal(asked, false)

  // With the switch OFF the same producer is reached and its ask is used,
  // which is what makes the approval prompt appear again.
  plugin.setAutoApproveEnabled(false, 'test')
  const prompted = await harness.runWaterfall(toolCall('bash'))
  assert.equal(asked, true)
  assert.deepEqual(prompted, { kind: 'ask', reason: 'prompt me' })
  harness.dispose()
})

test('config.defaultEnabled false boots with the switch OFF', async () => {
  const harness = createContext()
  plugin.apply(harness.ctx, { persist: false, defaultEnabled: false })
  assert.equal(plugin.isAutoApproveEnabled, false)
  assert.equal(plugin.getStatus().label, plugin.LABELS.off)
  harness.dispose()
})

test('toggle flips, reports the right label, and bumps the revision', () => {
  const harness = createContext()
  plugin.apply(harness.ctx, { persist: false })
  const start = plugin.getStatus().revision
  const off = plugin.toggleAutoApprove('shortcut')
  assert.equal(off.enabled, false)
  assert.equal(off.label, '已恢复手动审批')
  assert.equal(off.revision, start + 1)
  const on = plugin.toggleAutoApprove('shortcut')
  assert.equal(on.label, '已开启自动放行')
  assert.equal(on.revision, start + 2)
  harness.dispose()
})

test('setAutoApproveEnabled is idempotent (no revision churn)', () => {
  const harness = createContext()
  plugin.apply(harness.ctx, { persist: false })
  const before = plugin.getStatus()
  const same = plugin.setAutoApproveEnabled(true, 'test')
  assert.equal(same.revision, before.revision)
  harness.dispose()
})

test('unloading removes the interceptor', async () => {
  const harness = createContext()
  plugin.apply(harness.ctx, { persist: true })
  assert.equal(harness.listeners.length, 1)
  harness.dispose()
  assert.equal(harness.listeners.length, 0)
})

/* -------------------------------------------------------------------------- */
/* HTTP routes                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Start a server backed by the plugin's routes, with a fake webServer.
 *
 * Connections are tracked and destroyed on close: `fetch` keeps sockets
 * pooled, and a keep-alive socket would otherwise hold the event loop open for
 * seconds after the last test (looks like a hang, not a failure).
 */
async function startHost() {
  const routes = new Map()
  const sockets = new Set()
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    const route = routes.get(url.pathname)
    if (route === undefined) {
      response.writeHead(404)
      response.end()
      return
    }
    route(request, response)
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const webServer = {
    port,
    getOrigin: () => `http://127.0.0.1:${String(port)}`,
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  }
  const close = () => {
    for (const socket of sockets) socket.destroy()
    server.close()
  }
  return { server, close, base: `http://127.0.0.1:${String(port)}`, webServer, routes }
}

test('GET /status and POST /toggle drive the global switch', async () => {
  const host = await startHost()
  const harness = createContext({ services: { webServer: host.webServer } })
  plugin.apply(harness.ctx, { persist: false })
  try {
    const status = await (await fetch(`${host.base}/auto-approve-switch/status`)).json()
    assert.equal(status.ok, true)
    assert.equal(typeof status.enabled, 'boolean')
    const first = status.enabled

    const toggled = await (await fetch(`${host.base}/auto-approve-switch/toggle`, { method: 'POST', body: '{}' })).json()
    assert.equal(toggled.enabled, !first)
    assert.equal(plugin.isAutoApproveEnabled, !first)
    assert.equal(toggled.label, !first ? plugin.LABELS.on : plugin.LABELS.off)

    const off = await (await fetch(`${host.base}/auto-approve-switch/toggle`, {
      method: 'POST',
      body: JSON.stringify({ enabled: false }),
    })).json()
    assert.equal(off.enabled, false)
    assert.equal(plugin.isAutoApproveEnabled, false)
  }
  finally {
    harness.dispose()
    host.close()
  }
})

test('PUT /state is idempotent and sets the requested value', async () => {
  const host = await startHost()
  const harness = createContext({ services: { webServer: host.webServer } })
  plugin.apply(harness.ctx, { persist: false })
  try {
    const set = async (enabled) => {
      const response = await fetch(`${host.base}/auto-approve-switch/state`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
      assert.equal(response.status, 200)
      return await response.json()
    }
    const off1 = await set(false)
    assert.equal(off1.enabled, false)
    const off2 = await set(false)
    // Re-sending is a no-op: same value, same revision (safe to retry).
    assert.equal(off2.enabled, false)
    assert.equal(off2.revision, off1.revision)
    const on = await set(true)
    assert.equal(on.enabled, true)
    assert.equal(plugin.isAutoApproveEnabled, true)
  }
  finally {
    harness.dispose()
    host.close()
  }
})

test('routes reject wrong methods and cross-origin mutations', async () => {
  const host = await startHost()
  const harness = createContext({ services: { webServer: host.webServer } })
  plugin.apply(harness.ctx, { persist: false })
  try {
    const wrongMethod = await fetch(`${host.base}/auto-approve-switch/toggle`)
    assert.equal(wrongMethod.status, 405)
    const wrongStateMethod = await fetch(`${host.base}/auto-approve-switch/state`, { method: 'DELETE' })
    assert.equal(wrongStateMethod.status, 405)

    const before = plugin.isAutoApproveEnabled
    const crossOrigin = await fetch(`${host.base}/auto-approve-switch/toggle`, {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
    })
    assert.equal(crossOrigin.status, 403)
    assert.equal(plugin.isAutoApproveEnabled, before)
  }
  finally {
    harness.dispose()
    host.close()
  }
})

test('routes are disposed with the plugin', async () => {
  const host = await startHost()
  const harness = createContext({ services: { webServer: host.webServer } })
  try {
    plugin.apply(harness.ctx, { persist: false })
    // status + state + toggle
    assert.deepEqual([...host.routes.keys()].sort(), [
      '/auto-approve-switch/state',
      '/auto-approve-switch/status',
      '/auto-approve-switch/toggle',
    ])
  }
  finally {
    harness.dispose()
    if (host.routes.size !== 0) {
      host.close()
      throw new Error(`routes survived unload: ${[...host.routes.keys()].join(', ')}`)
    }
    host.close()
  }
  assert.equal(host.routes.size, 0)
})

/* -------------------------------------------------------------------------- */
/* Manifest contract                                                          */
/* -------------------------------------------------------------------------- */

test('package manifest declares the bundle patch and a web client', async () => {
  const { readFile } = await import('node:fs/promises')
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.equal(pkg.exports['.'], './lib/index.js')
  assert.equal(pkg.main, 'lib/index.js')
  assert.equal(pkg.name, plugin.name)
})

test('the built client bundle is a factory-form module for this package', async () => {
  const { readFile } = await import('node:fs/promises')
  const code = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(code, /window\.__ModuleLoader__\.load\(/)
  assert.match(code, /id: "auto-approve-switch"/)
  // Platform seed modules must be required at runtime, never bundled.
  assert.match(code, /require\("@deepseek-ai\/dsh-client-ui-primitives"\)/)
  assert.match(code, /require\("react"\)/)
  // The required copy (requirement #4).
  assert.ok(code.includes('已开启自动放行'))
  assert.ok(code.includes('已恢复手动审批'))
  // The documented default binding.
  assert.match(code, /code: "KeyA", modifiers: \["primary", "alt"\]/)
})
test('a conflicting route does not take the interceptor down (optional feature)', async () => {
  const webCtx = {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    webServer: {
      getOrigin: () => 'http://127.0.0.1:1',
      register(route) {
        if (route.path.endsWith('/toggle')) throw new Error('webserver: duplicate exact route')
        return () => {}
      },
    },
  }
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    inject(_names, callback) {
      callback(webCtx)
    },
    on(event, fn) {
      // The plugin registers on two events now; keep them apart.
      if (event === 'tools/pre-execute') ctx.listener = fn
      return () => {}
    },
    get() {},
  }
  plugin.apply(ctx, { persist: false })
  assert.equal(typeof ctx.listener, 'function', 'the interceptor is still registered')
  assert.deepEqual(await ctx.listener(toolCall('bash'), async () => ({ kind: 'allow' })), { kind: 'allow' })
})

/* -------------------------------------------------------------------------- */
/* Resilience: a diagnostic must never fail the whole Loader row              */
/* -------------------------------------------------------------------------- */

test('apply() survives contexts whose optional lookups throw', async () => {
  // Regression: a boot-time `ctx.get('webServer')` inside the diagnostic line
  // once propagated out of apply(), failing the Loader row — the plugin then
  // looked "not installed" and wrote no log at all.
  const contexts = {
    'get throws': {
      effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
      inject: () => ({}),
      on: () => () => {},
      get: () => { throw new Error('service lookup exploded') },
    },
    'inject throws': {
      effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
      inject: () => { throw new Error('inject exploded') },
      on: () => () => {},
      get: () => undefined,
    },
  }
  for (const [label, ctx] of Object.entries(contexts)) {
    let listener
    const instrumented = {
      ...ctx,
      on: (event, fn) => {
        if (event === 'tools/pre-execute') listener = fn
        return () => {}
      },
    }
    assert.doesNotThrow(() => plugin.apply(instrumented, {}), `${label}: apply must not throw`)
    assert.equal(typeof listener, 'function', `${label}: interceptor still registered`)
    assert.deepEqual(await listener(toolCall('bash'), async () => ({ kind: 'allow' })), { kind: 'allow' })
  }
})

test('a broken persistence backend never disables the interceptor', async () => {
  const harness = createContext({ services: { storageDomain: { open: async () => { throw new Error('backend down') } } } })
  plugin.apply(harness.ctx, { persist: true })
  try {
    assert.equal(plugin.isAutoApproveEnabled, true)
    assert.deepEqual(await harness.runWaterfall(toolCall('bash')), { kind: 'allow' })
  }
  finally {
    harness.dispose()
  }
})

test('declares no service at all, so the row can never wait forever', () => {
  // Regression: `{ required: [...], optional: [...] }` made Cordis wait for
  // services literally named "required"/"optional" — `apply()` never ran and
  // the Web boot failed with `pending (waiting for service: optional)`.
  assert.ok(Array.isArray(plugin.inject), 'inject must be an array of names')
  assert.deepEqual([...plugin.inject], [])
})

/* -------------------------------------------------------------------------- */
/* Approval prompts (approval/request)                                        */
/* -------------------------------------------------------------------------- */

/**
 * Mirror `ApprovalService.decide`: a waterfall whose seed is `'unavailable'`.
 * @param harness - context from `createContext`.
 * @param request - approval request payload.
 */
async function askApproval(harness, request = { toolName: 'bash', reason: 'escalate sandbox to danger-full-access: need /etc' }) {
  // `createContext` records `tools/pre-execute`; approval listeners are kept
  // separately here so the two waterfalls cannot be confused.
  const listeners = harness.approvalListeners ?? []
  const callNext = async (index = 0) => {
    const listener = listeners[index]
    if (listener === undefined) return 'unavailable'
    const outcome = await listener(request, () => callNext(index + 1))
    return outcome === undefined ? await callNext(index + 1) : outcome
  }
  return await callNext(0)
}

test('ON answers approval/request with allowed-once, so no prompt appears', async () => {
  const harness = createContext({ services: { webServer: undefined } })
  harness.ctx.on = (event, fn) => {
    if (event === 'approval/request') {
      ;(harness.approvalListeners ??= []).push(fn)
    }
    return () => {}
  }
  plugin.apply(harness.ctx, { persist: false })
  try {
    assert.equal(plugin.isAutoApproveEnabled, true)
    // The real prompt source: bash escalates its sandbox from inside the tool
    // body, which never passes through tools/pre-execute.
    assert.equal(await askApproval(harness), 'allowed-once')
    assert.equal(plugin.getStatus().stats.approvals, 1)
  }
  finally {
    harness.dispose()
  }
})

test('OFF hands approval/request back to the human answerer', async () => {
  const harness = createContext({ services: { webServer: undefined } })
  harness.ctx.on = (event, fn) => {
    if (event === 'approval/request') {
      ;(harness.approvalListeners ??= []).push(fn)
    }
    return () => {}
  }
  plugin.apply(harness.ctx, { persist: false })
  try {
    plugin.setAutoApproveEnabled(false, 'test')
    assert.equal(await askApproval(harness), 'unavailable', 'falls through to the seed')
    assert.equal(plugin.getStatus().stats.approvalsDeferred, 1)
  }
  finally {
    harness.dispose()
  }
})
