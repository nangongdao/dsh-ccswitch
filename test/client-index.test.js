import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

/**
 * What the client entry declares to the real DSH shell. Two faults lived here
 * and both were silent in production, so they are locked down mechanically:
 *
 *  1. A parameter codec that is not `strict` makes the Client's `$mount`
 *     validator reject the whole contribution (`requireStrictInputs` ->
 *     `requireStrictCodec`), not just that one method.
 *  2. Registering the two slots *after* `await ctx.remote.$mount(...)` meant a
 *     mounting failure deleted the panel and the card badge from the UI with no
 *     visible trace at all.
 */
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.MutationObserver = dom.window.MutationObserver
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const { apply } = await import('../src/client/index.ts')
const { importRemoteContribution } = await import('../src/import-contract.ts')

const METHODS = ['list', 'refresh', 'importProviders', 'resync', 'refreshKey', 'remove']

function context(mount) {
  const labels = []
  const injected = []
  const registered = []
  const errors = []
  const disposers = []
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
    remote: { $mount: mount, ccswitch: undefined },
  }
  return { ctx, labels, injected, registered, errors, disposers }
}

const mounted = {
  list: async () => ({ ok: true, value: { available: true, writable: true, rows: [] } }),
  refresh: async () => ({ ok: true, value: { available: true, writable: true, rows: [] } }),
  importProviders: async () => ({ ok: true, value: [] }),
  resync: async () => ({ ok: true, value: [] }),
  refreshKey: async () => ({ ok: true, value: [] }),
  remove: async () => ({ ok: true, value: [] }),
}

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

  // cordis routes the rejected mount to `ctx.logger.error` (what this fake
  // captures): the failure is reported, not swallowed.
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(errors, [failure])
})

test('hands the seats the live namespace once the contribution mounts', async () => {
  const { ctx, injected, registered, disposers } = context(async () => {
    ctx.remote.ccswitch = mounted
    return async () => { ctx.remote.ccswitch = undefined }
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
