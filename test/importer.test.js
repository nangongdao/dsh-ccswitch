import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import * as pi from '@deepseek-ai/dsh-llm-pi-ai'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway'
import { CcSwitchImporter, importedProviderId, nativeReasoningEfforts } from '../src/importer.ts'
import { CcSwitchImportController } from '../src/import-controller.ts'
import { importRemoteContribution } from '../src/import-contract.ts'

const model = { id: 'gpt-5.6-sol', name: 'Synthetic GPT', contextWindow: 128000, maxTokens: 8192 }
function route(overrides = {}) {
  return { provider: 'ccswitch/codex/source-a', sourceId: 'source-a', appType: 'codex',
    name: 'Synthetic source', baseURL: 'https://example.invalid/v1', protocol: 'openai-responses',
    defaultModel: model.id, models: [model], authKind: 'api-key', fingerprint: 'one', ...overrides }
}
function fixture(overrides = {}) {
  let revision = 0
  const providers = { preserved: { displayName: 'Existing', api: 'openai-completions', baseURL: 'https://existing.invalid/v1', models: [{ ...model, id: 'existing' }] } }
  const keys = new Map()
  const writes = []
  const routes = overrides.routes ?? [route()]
  let credentialReads = 0
  const native = () => ({ ns: 'llm-pi-ai', revision, schema: pi.Config.toJSON(), value: { providers }, applies: 'live', autoGenerate: false })
  const deps = {
    settings: { writable: true, describe: () => [native()], mutate: async (ns, ops, expected) => {
      assert.equal(ns, 'llm-pi-ai')
      assert.equal(expected, revision)
      if (overrides.rejectWrite) throw new Error('synthetic-secret-must-not-leak')
      for (const op of ops) {
        assert.deepEqual(op.path.slice(0, 1), ['providers'])
        assert.equal(op.op, 'set')
        const next = { ...providers, [op.path[1]]: op.value }
        // Validate against the actual current DSH native adapter schema.
        pi.Config({ providers: next })
        providers[op.path[1]] = structuredClone(op.value)
        writes.push(op)
      }
      revision++
    } },
    credentials: {
      describe: async ref => ({ configured: keys.has(ref), writable: true }),
      set: async (ref, value) => { assert.ok(!keys.has(ref)); keys.set(ref, value) },
      resolve: async ref => keys.has(ref) ? { value: keys.get(ref), source: 'synthetic-store' } : undefined,
      unset: async ref => { keys.delete(ref) },
    },
    routes: () => routes, models: source => source.models,
    discovery: () => 'configured', credential: async () => { credentialReads++; return { token: 'synthetic-key-never-output' } },
    refresh: async () => {}, changed: () => {},
  }
  const importer = new CcSwitchImporter(deps)
  return { importer, deps, providers, keys, writes, routes, native, credentialReads: () => credentialReads }
}
const signal = () => new AbortController().signal

test('native import stores only a key reference, preserves native providers, and never repeats', async () => {
  const f = fixture()
  const old = structuredClone(f.providers.preserved)
  assert.equal(f.importer.list().rows[0].eligible, true)
  assert.equal(JSON.stringify(f.importer.list()).includes('synthetic-key'), false)
  const outcomes = await f.importer.importProviders([f.routes[0].provider], signal())
  assert.equal(outcomes[0].status, 'imported')
  const target = importedProviderId(f.routes[0])
  const profile = f.providers[target]
  assert.equal(profile.api, 'openai-responses')
  assert.equal(profile.baseURL, f.routes[0].baseURL)
  assert.equal(profile.models[0].id, model.id)
  assert.equal(f.keys.get(profile.apiKeyEnv), 'synthetic-key-never-output')
  assert.equal(JSON.stringify(f.providers).includes('synthetic-key'), false)
  assert.deepEqual(f.providers.preserved, old)
  profile.displayName = 'User changed in DSH'
  profile.models = [{ ...profile.models[0], id: 'user-added' }]
  f.routes[0] = route({ name: 'Changed in CC', fingerprint: 'two' })
  assert.equal((await f.importer.importProviders([f.routes[0].provider], signal()))[0].status, 'skipped')
  assert.equal(profile.displayName, 'User changed in DSH')
  assert.equal(profile.models[0].id, 'user-added')
  assert.equal(f.credentialReads(), 1)
  assert.equal(f.writes.length, 1)
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
  assert.ok(f.importer.list().rows.every(row => !row.eligible))
  const result = await f.importer.importProviders(f.routes.map(route => route.provider), signal())
  assert.ok(result.every(outcome => outcome.status === 'skipped'))
  assert.equal(f.credentialReads(), 0)
  assert.equal(f.keys.size, 0)
})

test('failed profile commit cleans up the new key and does not leak errors', async () => {
  const f = fixture({ rejectWrite: true })
  const result = await f.importer.importProviders([f.routes[0].provider], signal())
  assert.equal(result[0].status, 'failed')
  assert.equal(f.keys.size, 0)
  assert.equal(f.writes.length, 0)
  assert.equal(JSON.stringify(result).includes('synthetic-secret'), false)
})

test('occupied credentials and read-only settings are never overwritten', async () => {
  const f = fixture()
  const ref = `${importedProviderId(f.routes[0]).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
  f.keys.set(ref, 'existing-secret')
  assert.equal((await f.importer.importProviders([f.routes[0].provider], signal()))[0].status, 'failed')
  assert.equal(f.keys.get(ref), 'existing-secret')
  assert.equal(f.credentialReads(), 0)
  f.deps.settings.writable = false
  assert.equal((await f.importer.importProviders([f.routes[0].provider], signal()))[0].status, 'skipped')
})

test('remote inputs reject arbitrary ids, empty batches and unbounded batches', async () => {
  const f = fixture()
  for (const input of [undefined, [], ['not-a-route'], Array(129).fill(f.routes[0].provider), [1], ['x'.repeat(513)]]) {
    await assert.rejects(f.importer.importProviders(input, signal()))
  }
  assert.equal(f.credentialReads(), 0)
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
  await controller.dispose()
  await assert.rejects(ctx.typertGateway.invoke({ namespace: 'ccswitch', method: 'list', args: {} }))
})
