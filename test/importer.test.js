import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import * as pi from '@deepseek-ai/dsh-llm-pi-ai'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway'
import { CcSwitchImporter, dynamicRoutes, hasNativeImport, importedProviderId, nativeReasoningEfforts } from '../src/importer.ts'
import { CcSwitchImportController } from '../src/import-controller.ts'
import { importRemoteContribution } from '../src/import-contract.ts'

const model = { id: 'gpt-5.6-sol', name: 'Synthetic GPT', contextWindow: 128000, maxTokens: 8192 }
function route(overrides = {}) {
  return { provider: 'ccswitch/codex/source-a', sourceId: 'source-a', appType: 'codex',
    name: 'Synthetic source', baseURL: 'https://example.invalid/v1', protocol: 'openai-responses',
    defaultModel: model.id, models: [model], authKind: 'api-key', fingerprint: 'one', ...overrides }
}
const keyRefOf = source => `${importedProviderId(source).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
function fixture(overrides = {}) {
  let revision = 0
  const providers = { preserved: { displayName: 'Existing', api: 'openai-completions', baseURL: 'https://existing.invalid/v1', models: [{ ...model, id: 'existing' }] } }
  const keys = new Map()
  const ops = []
  const routes = overrides.routes ?? [route()]
  let credentialReads = 0
  let refreshes = 0
  let describeActive = 0
  let describePeak = 0
  const native = () => ({ ns: 'llm-pi-ai', revision, schema: pi.Config.toJSON(), value: { providers }, applies: 'live', autoGenerate: false })
  const deps = {
    settings: { writable: true, describe: () => [native()], mutate: async (ns, batch, expected) => {
      assert.equal(ns, 'llm-pi-ai')
      assert.equal(expected, revision)
      if (overrides.rejectWrite) throw new Error('synthetic-secret-must-not-leak')
      for (const op of batch) {
        assert.deepEqual(op.path.slice(0, 1), ['providers'])
        if (op.op === 'set') {
          // Validate against the actual current DSH native adapter schema.
          pi.Config({ providers: { ...providers, [op.path[1]]: op.value } })
          providers[op.path[1]] = structuredClone(op.value)
        } else {
          assert.equal(op.op, 'unset')
          delete providers[op.path[1]]
        }
        ops.push(structuredClone(op))
      }
      revision++
    } },
    credentials: {
      describe: async ref => {
        describeActive += 1
        describePeak = Math.max(describePeak, describeActive)
        try {
          if (overrides.describeDelay) await new Promise(resolve => setTimeout(resolve, overrides.describeDelay))
          return { configured: keys.has(ref), writable: true }
        } finally { describeActive -= 1 }
      },
      set: async (ref, value) => {
        // Importing must never overwrite an occupied reference; replacing a key
        // on an already imported provider legitimately writes over its own.
        assert.ok(!keys.has(ref) || overrides.allowOverwrite === true)
        keys.set(ref, value)
      },
      resolve: async ref => keys.has(ref) ? { value: keys.get(ref), source: 'synthetic-store' } : undefined,
      unset: async ref => { keys.delete(ref) },
    },
    routes: () => routes, models: source => source.models,
    discovery: overrides.discovery ?? (() => 'configured'),
    credential: async () => { credentialReads++; return { token: 'synthetic-key-never-output' } },
    refresh: async source => { refreshes++; if (overrides.refresh) await overrides.refresh(source) },
    changed: () => {},
  }
  const importer = new CcSwitchImporter(deps)
  return { importer, deps, providers, keys, ops, routes, native,
    credentialReads: () => credentialReads, refreshes: () => refreshes, describePeak: () => describePeak }
}
const signal = () => new AbortController().signal

test('native import stores only a key reference, preserves native providers, and never repeats', async () => {
  const f = fixture()
  const old = structuredClone(f.providers.preserved)
  const initial = await f.importer.list()
  assert.equal(initial.rows[0].eligible, true)
  assert.equal(initial.rows[0].imported, false)
  assert.equal(JSON.stringify(initial).includes('synthetic-key'), false)
  const outcomes = await f.importer.importProviders([f.routes[0].provider], signal())
  assert.equal(outcomes[0].status, 'imported')
  const target = importedProviderId(f.routes[0])
  const profile = f.providers[target]
  assert.equal(profile.api, 'openai-responses')
  assert.equal(profile.baseURL, f.routes[0].baseURL)
  assert.equal(profile.displayName, 'CC Switch · Codex · Synthetic source')
  assert.equal(profile.models[0].id, model.id)
  assert.equal(f.keys.get(profile.apiKeyEnv), 'synthetic-key-never-output')
  assert.equal(JSON.stringify(f.providers).includes('synthetic-key'), false)
  assert.deepEqual(f.providers.preserved, old)
  // The panel must be able to say whether the written key is still there.
  const imported = (await f.importer.list()).rows[0]
  assert.equal(imported.imported, true)
  assert.equal(imported.credential, 'configured')
  assert.equal(imported.eligible, false)
  assert.match(imported.reason, /已导入/)
  // The row must report what DSH owns now, not what CC Switch lists.
  assert.equal(imported.models, 1)
  assert.deepEqual(imported.sample, [model.id])
  f.keys.clear()
  assert.equal((await f.importer.list()).rows[0].credential, 'missing')
  f.keys.set(profile.apiKeyEnv, 'synthetic-key-never-output')
  profile.displayName = 'User changed in DSH'
  profile.models = [{ ...profile.models[0], id: 'user-added' }]
  f.routes[0] = route({ name: 'Changed in CC', fingerprint: 'two' })
  assert.equal((await f.importer.importProviders([f.routes[0].provider], signal()))[0].status, 'skipped')
  assert.equal(profile.displayName, 'User changed in DSH')
  assert.equal(profile.models[0].id, 'user-added')
  const handEdited = (await f.importer.list()).rows[0]
  assert.deepEqual(handEdited.sample, ['user-added'], 'hand-added models are what the user sees after import')
  assert.equal(f.credentialReads(), 1)
  assert.equal(f.ops.length, 1)
  // Importing fetches a missing interface catalog for the user, and does not
  // refetch for the skipped second call.
  assert.equal(f.refreshes(), 1)
})

test('imported profiles are serviceable through the real DSH native adapter', async t => {
  const f = fixture()
  await f.importer.importProviders([f.routes[0].provider], signal())
  const ctx = new Context()
  const llm = ctx.plugin(LlmRuntime)
  await llm
  const adapter = ctx.plugin(pi, { providers: f.providers })
  await adapter
  t.after(async () => { await adapter.dispose(); await llm.dispose() })
  const target = importedProviderId(f.routes[0])
  const directory = ctx.llm.listConfigurableProviders().find(entry => entry.provider === target)
  assert.equal(directory.settingsNs, 'llm-pi-ai')
  assert.deepEqual(directory.settingsPath, ['providers', target])
  const resolved = await ctx.llm.resolveModelInfo(target, model.id)
  assert.equal(resolved.id, model.id)
  assert.deepEqual(resolved.context, { contextWindow: 128000 })
  assert.ok(resolved.reasoning.efforts.some(effort => effort.id === 'high'))
})

test('translates the pi-ai thinking map into valid native reasoning efforts', () => {
  // The dynamic map pins unsupported levels to null; the native profile rejects
  // a null wire value everywhere except `off`, and rejects an empty map too.
  assert.equal(nativeReasoningEfforts(undefined), false)
  assert.equal(nativeReasoningEfforts({ off: null }), false)
  assert.equal(nativeReasoningEfforts({ off: null, xhigh: null, max: null }), false)
  assert.equal(nativeReasoningEfforts({ low: '' }), false)
  assert.deepEqual(nativeReasoningEfforts({ off: null, low: 'low', xhigh: null, max: null }), { off: null, low: 'low' })
  assert.deepEqual(nativeReasoningEfforts({ off: 'none', high: 'high' }), { off: 'none', high: 'high' })
})

test('OAuth and unsupported native protocols are skipped without reading their credentials', async () => {
  const f = fixture({ routes: [route({ authKind: 'codex-oauth' }), route({ provider: 'ccswitch/gemini/g', appType: 'gemini', protocol: 'google-generative-ai' })] })
  const rows = (await f.importer.list()).rows
  assert.ok(rows.every(row => !row.eligible))
  assert.match(rows[0].reason, /OAuth/)
  assert.match(rows[1].reason, /不支持此协议/)
  const result = await f.importer.importProviders(f.routes.map(route => route.provider), signal())
  assert.ok(result.every(outcome => outcome.status === 'skipped'))
  assert.equal(f.credentialReads(), 0)
  assert.equal(f.refreshes(), 0)
  assert.equal(f.keys.size, 0)
})

test('a route with no known model is refreshed before it is imported', async () => {
  const f = fixture({ routes: [route({ models: [] })], refresh: async () => { f.routes[0] = route({ fingerprint: 'two' }) } })
  const rows = (await f.importer.list()).rows
  assert.equal(rows[0].eligible, false)
  assert.match(rows[0].reason, /还没有可用模型/)
  assert.deepEqual(rows[0].sample, [], 'an empty catalog has nothing to sample')
  const outcomes = await f.importer.importProviders([f.routes[0].provider], signal())
  assert.equal(outcomes[0].status, 'imported')
  assert.equal(f.refreshes(), 1)
  assert.match(outcomes[0].message, /接口模型列表读取失败/, 'a fallback catalog is reported, not hidden')
  assert.equal(f.providers[importedProviderId(f.routes[0])].models.length, 1)
})

test('every row samples at most three model ids for orientation', async () => {
  const many = ['one', 'two', 'three', 'four'].map(id => ({ ...model, id }))
  const f = fixture({ routes: [route({ models: many })] })
  const [row] = (await f.importer.list()).rows
  assert.equal(row.models, 4)
  assert.deepEqual(row.sample, ['one', 'two', 'three'])
})

test('an already fetched catalog is not fetched again on import', async () => {
  const f = fixture({ discovery: () => 'remote' })
  assert.equal((await f.importer.importProviders([f.routes[0].provider], signal()))[0].status, 'imported')
  assert.equal(f.refreshes(), 0)
})

test('updating a route refetches its catalog, keeps hand-added models and the key', async () => {
  let discovery = 'configured'
  const f = fixture({ discovery: () => discovery })
  await f.importer.importProviders([f.routes[0].provider], signal())
  const target = importedProviderId(f.routes[0])
  const profile = f.providers[target]
  profile.displayName = '我的 Codex'
  profile.headers = { 'x-user': 'yes' }
  profile.models = [...profile.models, { id: 'hand-added', name: 'Hand', contextWindow: 1000, maxTokens: 100 }]
  const ref = profile.apiKeyEnv
  const secret = f.keys.get(ref)
  f.routes[0] = route({ fingerprint: 'two', models: [{ ...model, id: 'gpt-5.7-sol' }] })
  discovery = 'remote'
  const outcomes = await f.importer.resync([f.routes[0].provider], signal())
  assert.equal(outcomes[0].status, 'updated')
  assert.match(outcomes[0].message, /已同步 1 个模型/)
  assert.match(outcomes[0].message, /另有 1 个模型不在接口列表中/)
  assert.equal(f.refreshes(), 2, 'an explicit update always re-reads the interface')
  const next = f.providers[target]
  assert.equal(next.displayName, '我的 Codex')
  assert.deepEqual(next.headers, { 'x-user': 'yes' })
  assert.deepEqual(next.models.map(entry => entry.id), ['gpt-5.7-sol', 'hand-added'])
  assert.equal(next.apiKeyEnv, ref)
  assert.equal(f.keys.get(ref), secret)
  assert.equal(f.providers.preserved.displayName, 'Existing')
})

test('a failed interface read never retires the models this plugin wrote', async () => {
  let discovery = 'remote'
  const f = fixture({ discovery: () => discovery })
  await f.importer.importProviders([f.routes[0].provider], signal())
  const target = importedProviderId(f.routes[0])
  assert.deepEqual(f.providers[target].models.map(entry => entry.id), [model.id])
  // The interface goes away and the CC Switch config now names a different model:
  // the old catalog would look retired, but nothing was actually confirmed.
  discovery = 'failed'
  f.routes[0] = route({ fingerprint: 'two', models: [{ ...model, id: 'other' }] })
  const offline = await f.importer.resync([f.routes[0].provider], signal())
  assert.equal(offline[0].status, 'updated')
  assert.match(offline[0].message, /没有删除任何模型/)
  assert.deepEqual(f.providers[target].models.map(entry => entry.id), ['other', model.id],
    'an unconfirmed listing must not drop anything')
  // Once the interface answers again, a model it no longer lists is dropped.
  discovery = 'remote'
  f.routes[0] = route({ fingerprint: 'three', models: [{ ...model, id: 'new-model' }] })
  const online = await f.importer.resync([f.routes[0].provider], signal())
  assert.equal(online[0].status, 'updated')
  assert.match(online[0].message, /已同步 1 个模型/)
  assert.deepEqual(f.providers[target].models.map(entry => entry.id), ['new-model'])
})

test('imported key lookups run in bounded batches and keep the row order', async () => {
  const sources = Array.from({ length: 20 }, (_, index) => route({
    provider: `ccswitch/codex/source-${index}`, sourceId: `source-${index}`, name: `Source ${index}`,
  }))
  const f = fixture({ routes: sources, describeDelay: 5 })
  for (const source of sources) {
    f.providers[importedProviderId(source)] = {
      displayName: 'CC Switch · Codex · imported', api: 'openai-responses',
      baseURL: 'https://example.invalid/v1', models: [{ ...model }], apiKeyEnv: keyRefOf(source),
    }
  }
  f.keys.set(keyRefOf(sources[0]), 'synthetic-key')
  const view = await f.importer.list()
  assert.equal(view.rows.length, 20)
  assert.deepEqual(view.rows.map(row => row.provider), sources.map(source => source.provider))
  assert.equal(view.rows[0].credential, 'configured')
  assert.equal(view.rows[1].credential, 'missing')
  assert.ok(f.describePeak() > 1, 'a serial loop would never overlap')
  assert.ok(f.describePeak() <= 8, `bounded concurrency, saw ${f.describePeak()}`)
})

test('updating or removing something that was never imported is a skipped no-op', async () => {
  const f = fixture()
  const other = 'ccswitch/claude/other'
  f.routes.push(route({ provider: other, appType: 'claude', name: 'Other', protocol: 'anthropic-messages' }))
  const updated = await f.importer.resync([other], signal())
  assert.equal(updated[0].status, 'skipped')
  assert.match(updated[0].message, /尚未导入/)
  const removed = await f.importer.remove([other], signal())
  assert.equal(removed[0].status, 'skipped')
  assert.equal(f.ops.length, 0)
  assert.equal(f.keys.size, 0)
})

test('removing an import deletes the provider and then its key', async () => {
  const f = fixture()
  await f.importer.importProviders([f.routes[0].provider], signal())
  const target = importedProviderId(f.routes[0])
  const ref = f.providers[target].apiKeyEnv
  const outcomes = await f.importer.remove([f.routes[0].provider], signal())
  assert.equal(outcomes[0].status, 'removed')
  assert.match(outcomes[0].message, /已从 DSH 移除/)
  assert.equal(target in f.providers, false)
  assert.equal(f.keys.has(ref), false)
  assert.deepEqual(f.ops.at(-1), { op: 'unset', path: ['providers', target] })
  assert.equal(JSON.stringify(outcomes).includes('synthetic-key'), false)
  // Idempotent: the provider is gone, so a second removal reports a skip.
  assert.equal((await f.importer.remove([f.routes[0].provider], signal()))[0].status, 'skipped')
  assert.equal(f.providers.preserved.displayName, 'Existing')
})

test('removing an import keeps a key that the user repointed the provider at', async () => {
  const f = fixture()
  await f.importer.importProviders([f.routes[0].provider], signal())
  const target = importedProviderId(f.routes[0])
  const mine = f.providers[target].apiKeyEnv
  f.providers[target] = { ...f.providers[target], apiKeyEnv: 'MY_OWN_KEY' }
  f.keys.set('MY_OWN_KEY', 'user-owned-secret')

  const outcomes = await f.importer.remove([f.routes[0].provider], signal())

  assert.equal(outcomes[0].status, 'removed')
  assert.match(outcomes[0].message, /那不是本插件写入的，已保留/)
  assert.equal(target in f.providers, false)
  assert.equal(f.keys.get('MY_OWN_KEY'), 'user-owned-secret')
  assert.equal(f.keys.has(mine), false, 'the reference this plugin wrote is still cleaned up')
})

test('replacing a key writes the current CC Switch token over the stored one', async () => {
  const f = fixture({ allowOverwrite: true })
  await f.importer.importProviders([f.routes[0].provider], signal())
  const target = importedProviderId(f.routes[0])
  const ref = f.providers[target].apiKeyEnv
  assert.equal(f.keys.get(ref), 'synthetic-key-never-output')
  // CC Switch rotated the key: the next credential read returns the new value.
  f.deps.credential = async () => ({ token: 'rotated-key-never-output' })

  const outcomes = await f.importer.refreshKey([f.routes[0].provider], signal())

  assert.equal(outcomes[0].status, 'updated')
  assert.match(outcomes[0].message, /覆盖该供应商的密钥条目/)
  assert.equal(f.keys.get(ref), 'rotated-key-never-output')
  assert.equal(JSON.stringify(outcomes).includes('rotated-key'), false, 'a key is never echoed back')
  assert.deepEqual(f.providers[target].models.map(entry => entry.id), [model.id], 'the catalog is untouched')
  assert.equal(f.ops.length, 1, 'replacing a key writes no settings')
})

test('replacing a key refuses every case where the plugin does not own it', async () => {
  const f = fixture({ allowOverwrite: true })
  await f.importer.importProviders([f.routes[0].provider], signal())
  const target = importedProviderId(f.routes[0])
  const mine = f.providers[target].apiKeyEnv
  f.providers[target] = { ...f.providers[target], apiKeyEnv: 'MY_OWN_KEY' }
  f.keys.set('MY_OWN_KEY', 'user-owned-secret')
  const repointed = await f.importer.refreshKey([f.routes[0].provider], signal())
  assert.equal(repointed[0].status, 'skipped')
  assert.match(repointed[0].message, /MY_OWN_KEY/)
  assert.equal(f.keys.get('MY_OWN_KEY'), 'user-owned-secret')

  f.providers[target] = { ...f.providers[target], apiKeyEnv: mine }
  f.deps.credentials.describe = async () => ({ configured: true, writable: false })
  const readonly = await f.importer.refreshKey([f.routes[0].provider], signal())
  assert.equal(readonly[0].status, 'skipped')
  assert.match(readonly[0].message, /只读来源/)

  f.deps.credentials.describe = async () => ({ configured: true, writable: true })
  f.deps.credential = async () => { throw new Error('synthetic-secret-must-not-leak') }
  const unreadable = await f.importer.refreshKey([f.routes[0].provider], signal())
  assert.equal(unreadable[0].status, 'skipped')
  assert.match(unreadable[0].message, /没有读到可用的 API Key/)
  assert.equal(JSON.stringify(unreadable).includes('synthetic-secret'), false)

  const other = 'ccswitch/claude/other'
  f.routes.push(route({ provider: other, appType: 'claude', name: 'Other', protocol: 'anthropic-messages' }))
  assert.match((await f.importer.refreshKey([other], signal()))[0].message, /尚未导入/)
})

test('a second write operation is rejected while one is running', async () => {
  let open
  const blocked = new Promise(resolve => { open = resolve })
  const f = fixture({ refresh: async () => { await blocked } })
  const first = f.importer.importProviders([f.routes[0].provider], signal())
  await assert.rejects(f.importer.remove([f.routes[0].provider], signal()), /正在进行/)
  await assert.rejects(f.importer.resync([f.routes[0].provider], signal()), /正在进行/)
  await assert.rejects(f.importer.refreshKey([f.routes[0].provider], signal()), /正在进行/)
  open()
  assert.equal((await first)[0].status, 'imported')
})

test('failed profile commit cleans up the new key and does not leak errors', async () => {
  const f = fixture({ rejectWrite: true })
  const result = await f.importer.importProviders([f.routes[0].provider], signal())
  assert.equal(result[0].status, 'failed')
  assert.equal(f.keys.size, 0)
  assert.equal(f.ops.length, 0)
  assert.equal(JSON.stringify(result).includes('synthetic-secret'), false)
})

test('a read-only DSH leaves an existing import untouched', async () => {
  const f = fixture()
  await f.importer.importProviders([f.routes[0].provider], signal())
  const target = importedProviderId(f.routes[0])
  const before = structuredClone(f.providers[target])
  f.deps.settings.writable = false
  assert.equal((await f.importer.resync([f.routes[0].provider], signal()))[0].status, 'skipped')
  assert.equal((await f.importer.remove([f.routes[0].provider], signal()))[0].status, 'skipped')
  f.deps.settings.writable = true
  assert.deepEqual(f.providers[target], before)
})

test('occupied credentials and read-only settings are never overwritten', async () => {
  const f = fixture()
  const ref = keyRefOf(f.routes[0])
  f.keys.set(ref, 'existing-secret')
  const occupied = await f.importer.importProviders([f.routes[0].provider], signal())
  assert.equal(occupied[0].status, 'skipped')
  assert.match(occupied[0].message, /已被占用/)
  assert.equal(f.keys.get(ref), 'existing-secret')
  assert.equal(f.credentialReads(), 0)
  f.deps.settings.writable = false
  assert.equal((await f.importer.importProviders([f.routes[0].provider], signal()))[0].status, 'skipped')
})

test('remote inputs reject arbitrary ids, empty batches and unbounded batches', async () => {
  const f = fixture()
  for (const input of [undefined, [], ['not-a-route'], Array(129).fill(f.routes[0].provider), [1], ['x'.repeat(513)]]) {
    await assert.rejects(f.importer.importProviders(input, signal()))
    await assert.rejects(f.importer.resync(input, signal()))
    await assert.rejects(f.importer.remove(input, signal()))
    await assert.rejects(f.importer.refresh(input, signal()))
  }
  assert.equal(f.credentialReads(), 0)
  assert.equal(f.ops.length, 0)
})

test('public SRC remote markers work through the real Gateway and dispose cleanly', async t => {
  const f = fixture()
  const ctx = new Context()
  const registry = ctx.plugin(TypertRegistry)
  await registry
  const gateway = ctx.plugin(TypertGatewayService)
  await gateway
  const controller = ctx.plugin(CcSwitchImportController, f.importer)
  await controller
  t.after(async () => { await controller.dispose(); await gateway.dispose(); await registry.dispose() })
  // The client contribution registers on the public registry; no compiler or
  // hidden descriptor symbols are needed for these JSON-only remote methods.
  const unmount = ctx.typert.remotes.register(importRemoteContribution)
  t.after(unmount)
  const view = await ctx.typertGateway.invoke({ namespace: 'ccswitch', method: 'list', args: {} })
  assert.equal(view.rows.length, 1)
  const result = await ctx.typertGateway.invoke({ namespace: 'ccswitch', method: 'importProviders', args: { providers: [f.routes[0].provider] } })
  assert.equal(result[0].status, 'imported')
  assert.equal(JSON.stringify({ view, result }).includes('synthetic-key'), false)
  f.routes[0] = route({ fingerprint: 'two', models: [{ ...model, id: 'gpt-5.7-sol' }] })
  const updated = await ctx.typertGateway.invoke({ namespace: 'ccswitch', method: 'resync', args: { providers: [f.routes[0].provider] } })
  assert.equal(updated[0].status, 'updated')
  const removed = await ctx.typertGateway.invoke({ namespace: 'ccswitch', method: 'remove', args: { providers: [f.routes[0].provider] } })
  assert.equal(removed[0].status, 'removed')
  assert.equal(importedProviderId(f.routes[0]) in f.providers, false)
  await controller.dispose()
  await assert.rejects(ctx.typertGateway.invoke({ namespace: 'ccswitch', method: 'list', args: {} }))
})

test('handing a route to DSH removes it from the dynamic adapter and gives it back on removal', async () => {
  const f = fixture()
  const settings = { describe: () => [f.native()] }
  const providers = () => dynamicRoutes(f.routes, settings).map(entry => entry.provider)
  assert.deepEqual(providers(), [f.routes[0].provider])
  assert.equal(hasNativeImport(settings, f.routes[0]), false)
  await f.importer.importProviders([f.routes[0].provider], signal())
  assert.equal(hasNativeImport(settings, f.routes[0]), true)
  assert.deepEqual(providers(), [], 'an imported route is DSH-owned, so the adapter must not offer it again')
  assert.deepEqual(dynamicRoutes(f.routes, undefined).map(entry => entry.provider), [f.routes[0].provider],
    'a profile without the settings service keeps every route dynamic')
  await f.importer.remove([f.routes[0].provider], signal())
  assert.deepEqual(providers(), [f.routes[0].provider], 'removing the import returns the route to the adapter')
})
