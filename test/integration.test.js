import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import * as plugin from '../src/index.ts'

const settle = () => new Promise(resolve => setImmediate(resolve))

function createDatabase(path, count = 3) {
  const db = new DatabaseSync(path)
  try {
    db.exec(`
      CREATE TABLE providers (
        id TEXT PRIMARY KEY,
        app_type TEXT NOT NULL,
        name TEXT NOT NULL,
        settings_config TEXT NOT NULL,
        meta TEXT NOT NULL,
        provider_type TEXT,
        sort_index INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE provider_endpoints (
        id INTEGER PRIMARY KEY,
        provider_id TEXT NOT NULL,
        app_type TEXT NOT NULL,
        url TEXT NOT NULL
      );
    `)
    const insert = db.prepare(`
      INSERT INTO providers (id, app_type, name, settings_config, meta, provider_type, sort_index)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    for (let i = 0; i < count; i++) {
      const app = ['claude', 'codex', 'gemini'][i % 3]
      // No credentials: discovery must stop before HTTP or OAuth sidecar access.
      insert.run(`synthetic-${i}`, app, `Synthetic ${i}`,
        JSON.stringify({ base_url: 'https://example.invalid/v1' }), '{}', null, i)
    }
  } finally {
    db.close()
  }
}

async function fixture(t, { exists = true, count = 3 } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-ccswitch-integration-')))
  assert.ok(isAbsolute(root))
  const dbPath = join(root, 'cc-switch.db')
  const names = ['DSH_CCSWITCH_DB', 'DSH_CCSWITCH_PROVIDERS', 'DSH_CCSWITCH_PROVIDERS_FILE', 'DSH_CCSWITCH_CODEX_REASONING']
  const saved = new Map(names.map(name => [name, process.env[name]]))
  process.env.DSH_CCSWITCH_DB = dbPath
  process.env.DSH_CCSWITCH_PROVIDERS = '*'
  process.env.DSH_CCSWITCH_PROVIDERS_FILE = join(root, 'unused-selection.json')
  process.env.DSH_CCSWITCH_CODEX_REASONING = 'minimal'
  if (exists) createDatabase(dbPath, count)
  const ctx = new Context()
  const fibers = []
  let httpCalls = 0
  t.mock.method(globalThis, 'fetch', () => {
    httpCalls++
    throw new Error('integration fixture forbids provider HTTP')
  })
  t.after(async () => {
    try {
      for (const fiber of fibers.slice().reverse()) await fiber.dispose()
      await settle()
      assert.equal(httpCalls, 0, 'catalog tests must not issue provider HTTP')
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      // Only remove the exact absolute directory created by this fixture.
      assert.equal(realpathSync(root), root)
      rmSync(root, { recursive: true, force: true })
    }
  })
  const service = ctx.plugin(LlmRuntime)
  fibers.push(service)
  await service
  const start = async () => {
    const fiber = ctx.plugin(plugin)
    fibers.push(fiber)
    await fiber
    await settle()
    return fiber
  }
  const mutate = callback => {
    const db = new DatabaseSync(dbPath)
    try { callback(db) } finally { db.close() }
  }
  return { ctx, service, start, mutate, dbPath, fibers }
}

// Process environment is shared; keep these fixtures serial within this file.
test('real Cordis and LlmRuntime integration', { concurrency: false }, async t => {
  await t.test('publishes every provider and validates every model in an 81-route SQLite fixture', async t => {
    const { ctx, start } = await fixture(t, { count: 81 })
    const owner = await start()
    const providers = ctx.llm.listProviders()
    assert.equal(owner.state, 2)
    assert.equal(providers.length, 81)
    for (const provider of providers) {
      const [, app, id] = provider.id.split('/')
      const label = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' }[app]
      assert.equal(provider.name, `CC Switch · ${label} · Synthetic ${id.split('-')[1]}`)
    }
    const catalogs = await Promise.all(providers.map(provider => ctx.llm.listModels(provider.id)))
    assert.equal(catalogs.filter(models => models.length > 0).length, 81)
    assert.equal(catalogs.flat().length, 81)
    for (const models of catalogs) {
      assert.deepEqual(models[0].inputModalities, ['text', 'image'])
      const info = await ctx.llm.resolveModelInfo(models[0].provider, models[0].id)
      assert.equal(info.id, models[0].id)
      assert.equal(info.context.contextWindow, 262144)
    }
    assert.deepEqual(owner.getEffects().map(effect => effect.label).sort(), ['anonymous', 'llm.registerAdapter()'])
    await settle()
    assert.equal(ctx.llm.listProviders().length, 81)
  })

  await t.test('restart retains the catalog and disposal releases registration and interval', async t => {
    const { ctx, start } = await fixture(t)
    const owner = await start()
    await owner.restart()
    assert.equal(ctx.llm.listProviders().length, 3)
    assert.deepEqual(owner.getEffects().map(effect => effect.label).sort(), ['anonymous', 'llm.registerAdapter()'])
    await owner.dispose()
    await settle()
    assert.equal(ctx.llm.listProviders().length, 0)
    assert.ok(ctx.llm, 'plugin disposal must not dispose its injected service')
    assert.deepEqual(owner.getEffects(), [])
  })

  await t.test('a database arriving after startup registers on polling and remains fiber-owned', async t => {
    t.mock.timers.enable({ apis: ['setInterval'] })
    const { ctx, start, dbPath } = await fixture(t, { exists: false })
    const owner = await start()
    assert.equal(ctx.llm.listProviders().length, 0)
    createDatabase(dbPath)
    t.mock.timers.tick(2000)
    await settle()
    assert.equal(ctx.llm.listProviders().length, 3)
    assert.deepEqual(owner.getEffects().map(effect => effect.label).sort(), ['anonymous', 'llm.registerAdapter()'])
    for (const provider of ctx.llm.listProviders()) assert.equal((await ctx.llm.listModels(provider.id)).length, 1)
    await owner.dispose()
    await settle()
    t.mock.timers.tick(4000)
    await settle()
    assert.equal(ctx.llm.listProviders().length, 0, 'disposed polling must not resurrect providers')
  })

  await t.test('polling notifies catalog consumers for same-route model and provider-name changes but not no-ops', async t => {
    t.mock.timers.enable({ apis: ['setInterval'] })
    const { ctx, start, mutate } = await fixture(t)
    let events = 0
    ctx.on('llm/adapters-updated', () => { events++ })
    await start()
    assert.equal(events, 1, 'initial registration announces catalog availability')
    const assertNoOpPoll = async () => {
      const before = events
      t.mock.timers.tick(2000)
      await settle()
      assert.equal(events, before, 'unchanged DB polling must not invalidate picker catalog')
    }
    await assertNoOpPoll()
    const provider = 'ccswitch/claude/synthetic-0'
    let before = events
    mutate(db => db.prepare('UPDATE providers SET settings_config = ? WHERE id = ?')
      .run(JSON.stringify({ base_url: 'https://example.invalid/v1', model: 'synthetic-updated-model' }), 'synthetic-0'))
    t.mock.timers.tick(2000)
    await settle()
    assert.equal(events, before + 1, 'same route IDs with a changed model must notify picker consumers')
    assert.equal((await ctx.llm.listModels(provider))[0].id, 'synthetic-updated-model')
    await assertNoOpPoll()
    before = events
    mutate(db => db.prepare('UPDATE providers SET name = ? WHERE id = ?').run('Renamed Synthetic', 'synthetic-0'))
    t.mock.timers.tick(2000)
    await settle()
    assert.equal(events, before + 1, 'same route IDs with a changed provider name must notify picker consumers')
    assert.equal(ctx.llm.listProviders().find(info => info.id === provider).name, 'CC Switch · Claude · Renamed Synthetic')
    await assertNoOpPoll()
    mutate(db => db.prepare('DELETE FROM providers WHERE id != ?').run('synthetic-0'))
    t.mock.timers.tick(2000)
    await settle()
    assert.deepEqual(ctx.llm.listProviders().map(info => info.id), [provider])
    await assert.rejects(ctx.llm.listModels('ccswitch/codex/synthetic-1'), error => error.code === 'NO_ADAPTER')
    mutate(db => db.exec('DELETE FROM providers'))
    t.mock.timers.tick(2000)
    await settle()
    assert.equal(ctx.llm.listProviders().length, 0)
    mutate(db => db.prepare(`INSERT INTO providers (id, app_type, name, settings_config, meta)
      VALUES (?, ?, ?, ?, ?)`).run('restored', 'codex', 'Restored',
      JSON.stringify({ base_url: 'https://example.invalid/v1' }), '{}'))
    t.mock.timers.tick(2000)
    await settle()
    assert.deepEqual(ctx.llm.listProviders().map(info => info.id), ['ccswitch/codex/restored'])
    assert.equal((await ctx.llm.listModels('ccswitch/codex/restored'))[0].id, 'gpt-5.5')
  })
})
