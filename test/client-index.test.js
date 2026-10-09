import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

/**
 * What the client entry declares to the real DSH shell. Three faults lived here
 * and all three were silent in production, so they are locked down mechanically:
 *
 *  1. A parameter codec that is not `strict` makes the Client's `$mount`
 *     validator reject the whole contribution (`requireStrictInputs` ->
 *     `requireStrictCodec`), not just that one method.
 *  2. Registering the two slots *after* `await ctx.remote.$mount(...)` meant a
 *     mounting failure deleted the panel and the card badge from the UI with no
 *     visible trace at all.
 *  3. Reading the mounted namespace as `ctx.remote.ccswitch` throws under real
 *     cordis — `inject` names the top-level service, never a child of it — so a
 *     SUCCESSFUL mount still rejected the effect and left the panel dead. The
 *     fake context below models that trap, which the previous one did not.
 */
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.MutationObserver = dom.window.MutationObserver
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const { apply } = await import('../src/client/index.ts')
const { RESERVED_REMOTE_METHODS, importRemoteContribution } = await import('../src/import-contract.ts')

const METHODS = ['list', 'refresh', 'importProviders', 'resync', 'refreshKey', 'removeProviders']

function context(mount) {
  const labels = []
  const injected = []
  const registered = []
  const errors = []
  const disposers = []
  // What `ctx.provide` / `$mount` made available, readable without `inject`.
  const provided = new Map()
  const ctx = {
    effect(execute, label) {
      let dispose
      try {
        dispose = execute()
      } catch (error) {
        // A synchronous throw escapes `effect()` in cordis too.
        errors.push(error)
        throw error
      }
      labels.push(label)
      if (dispose !== null && typeof dispose === 'object' && typeof dispose.then === 'function') {
        // cordis *collects* the disposer an async effect resolves to — it never
        // calls it — and sends a rejection to `ctx.logger.error` instead. That
        // log line is the only trace a failed `$mount` leaves, so capture both.
        Promise.resolve(dispose).then(
          resolved => { if (typeof resolved === 'function') disposers.push(resolved) },
          error => { errors.push(error) },
        )
        return () => {}
      }
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => { if (typeof dispose === 'function') dispose() }
    },
    slots: {
      register(spec, component) { registered.push({ spec, component }); return () => {} },
      inject(name, callback) { injected.push({ name, callback }) },
    },
    // `ctx.reflect.get` is the inject-free read the plugin must use.
    reflect: { get(name) { return provided.get(name) } },
    // `ctx.remote` resolves because the plugin declares `inject: ['remote']`,
    // but a child namespace is NOT an injectable property: real cordis throws
    // here. Modelling that is what makes fault 3 reproducible in a test.
    remote: new Proxy({ $mount: mount }, {
      get(target, property, receiver) {
        if (typeof property === 'string' && Reflect.has(target, property)) {
          return Reflect.get(target, property, receiver)
        }
        throw new Error(`cannot get property "remote.${String(property)}" without inject`)
      },
    }),
  }
  return { ctx, labels, injected, registered, errors, disposers, provided }
}

/** Capture `console.error` so a regression's diagnostics do not pollute output. */
function captureErrors() {
  const logged = []
  const original = console.error
  console.error = (...args) => { logged.push(args.map(String).join(' ')) }
  return {
    logged,
    // Node prints its own `ExperimentalWarning` through this channel; only the
    // plugin's own diagnostics are under test.
    plugin: () => logged.filter(line => line.includes('[dsh-ccswitch]')),
    restore() { console.error = original },
  }
}

const mounted = {
  list: async () => ({ ok: true, value: { available: true, writable: true, rows: [] } }),
  refresh: async () => ({ ok: true, value: { available: true, writable: true, rows: [] } }),
  importProviders: async () => ({ ok: true, value: [] }),
  resync: async () => ({ ok: true, value: [] }),
  refreshKey: async () => ({ ok: true, value: [] }),
  removeProviders: async () => ({ ok: true, value: [] }),
}

test('no remote method is named like a member of the namespace service', () => {
  // `$mount` runs `assertMethodAvailable` per descriptor and refuses the WHOLE
  // contribution when a name collides with `RemoteNamespaceService.prototype`.
  // `remove` is that prototype's unwinding helper: naming the removal method
  // `remove` made the client mount fail, which silently emptied the panel.
  for (const { method } of importRemoteContribution.descriptors) {
    assert.ok(!RESERVED_REMOTE_METHODS.includes(method),
      `${method} collides with the Remote namespace service`)
  }
  assert.ok(!RESERVED_REMOTE_METHODS.includes('removeProviders'))
})

test('every remote parameter carries a strict codec the Host can actually decode', () => {
  const descriptors = importRemoteContribution.descriptors
  assert.deepEqual(descriptors.map(entry => entry.method), METHODS)
  for (const descriptor of descriptors) {
    // The Client only ever checks `mode`, but the Host decodes by calling
    // `codec.create().parse(value)` — so the factory has to be real too.
    for (const parameter of descriptor.parameters) {
      assert.equal(parameter.codec.mode, 'strict', `${descriptor.method}.${parameter.wire} must be strict`)
      assert.equal(typeof parameter.codec.create, 'function', `${descriptor.method}.${parameter.wire} needs create()`)
      const schema = parameter.codec.create()
      assert.deepEqual(schema.parse(['p-claude']), ['p-claude'])
      for (const invalid of [undefined, null, 'p-claude', ['p-claude', 7], {}]) {
        assert.throws(() => schema.parse(invalid), TypeError, `${descriptor.method}.${parameter.wire} accepted ${JSON.stringify(invalid)}`)
      }
    }
  }
  // `refresh` exercises the cancellable shape; `list` takes no argument at all.
  assert.deepEqual(descriptors[0].parameters, [])
  assert.deepEqual(descriptors[1].cancellation, { parameter: 'signal' })
})

test('registers both seats before mounting, so a failed mount cannot hide them', async () => {
  const failure = new Error('client api: generated Remote src:ccswitch#ccswitch/refresh field "providers" has no strict codec')
  const { ctx, injected, registered, errors } = context(async () => { throw failure })
  const capture = captureErrors()

  try {
    apply(ctx)

    // Synchronous, and before the Remote exists: this is the whole regression.
    assert.deepEqual(injected.map(entry => entry.name), ['settings.models.footer', 'settings.models.provider-card'])
    for (const { callback } of injected) callback()
    assert.deepEqual(registered.map(entry => [entry.spec.name, entry.spec.id ?? entry.spec.key]),
      [['settings.models.footer', 'dsh-ccswitch'], ['settings.models.provider-card', 'llm-pi-ai']])

    // The seats stay wired; their provider explains the failure instead of vanishing.
    const remote = registered[0].spec.inject().remote
    await assert.rejects(remote.list(), /远程接口没有挂载成功/)
    for (const name of METHODS.slice(1)) await assert.rejects(remote[name](['p-claude']), /远程接口没有挂载成功/)

    await new Promise(resolve => setTimeout(resolve, 0))
    // The effect now handles its own failure, so the reason reaches BOTH the
    // panel (thrown message) and the renderer console (what lands in a crash log).
    assert.deepEqual(errors, [])
    assert.equal(capture.plugin().length, 1, JSON.stringify(capture.logged))
    assert.match(capture.plugin()[0], /the Remote contribution was refused/)
    assert.match(capture.plugin()[0], /has no strict codec/)
    await assert.rejects(remote.list(), /has no strict codec/)
  } finally {
    capture.restore()
  }
})

test('adopts a namespace that a previous activation already mounted', async () => {
  // A live patch reload can activate this bundle again while the first
  // activation still owns the namespace. `$mount` then refuses the duplicate
  // with `already mounted`, but the installed namespace is alive and usable.
  const duplicate = new Error('client api: direct method ccswitch/list is already mounted')
  const { ctx, injected, registered, provided } = context(async () => { throw duplicate })
  const capture = captureErrors()

  try {
    provided.set('remote.ccswitch', mounted)
    apply(ctx)
    await new Promise(resolve => setTimeout(resolve, 0))

    for (const { callback } of injected) callback()
    const remote = registered[0].spec.inject().remote
    // The panel must work here: the earlier fault was exactly this situation.
    assert.equal((await remote.list()).ok, true)
    assert.equal((await remote.resync(['p-claude'])).ok, true)
    assert.deepEqual(capture.plugin(), [])
  } finally {
    capture.restore()
  }
})

test('hands the seats the live namespace once the contribution mounts', async () => {
  const { ctx, injected, registered, disposers, provided } = context(async () => {
    provided.set('remote.ccswitch', mounted)
    return async () => { provided.delete('remote.ccswitch') }
  })

  apply(ctx)
  await new Promise(resolve => setTimeout(resolve, 0))

  for (const { callback } of injected) callback()
  const remote = registered[0].spec.inject().remote
  const view = await remote.list()
  assert.equal(view.ok, true)
  assert.deepEqual(view.value.rows, [])
  assert.equal((await remote.resync(['p-claude'])).ok, true)

  // Unmounting the plugin takes the namespace back down with it, and the seats
  // fall back to the explanation rather than calling into a dead namespace.
  // (Three effects register disposers: styles, model search, and the mount.)
  assert.equal(disposers.length, 3)
  await disposers[2]()
  await assert.rejects(remote.list(), /远程接口没有挂载成功/)
})

test('reports a namespace that mounts but cannot be read back', async () => {
  // Guards the exact shape of fault 3: a successful `$mount` whose namespace is
  // not readable must be a visible, self-explaining failure — never a silent one.
  const { ctx, injected, registered } = context(async () => async () => {})
  const capture = captureErrors()

  try {
    apply(ctx)
    await new Promise(resolve => setTimeout(resolve, 0))

    for (const { callback } of injected) callback()
    const remote = registered[0].spec.inject().remote
    await assert.rejects(remote.list(), /远程接口没有挂载成功/)
    assert.equal(capture.plugin().length, 1)
    assert.match(capture.plugin()[0], /could not read it back/)
  } finally {
    capture.restore()
  }
})
