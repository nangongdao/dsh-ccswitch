import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { CcSwitchRepository } from '../src/database.ts'

/**
 * CC Switch's Claude Code form stores ordinary relay keys in
 * `ANTHROPIC_AUTH_TOKEN`, so that field name cannot mean "rotating OAuth
 * token". Only a token pi-ai would itself treat as an OAuth token
 * (`apiKey.includes('sk-ant-oat')`) may stay on the dynamic connection; a
 * static relay key must be `api-key` or the import panel offers nothing to
 * import and the user sees "可导入 0".
 */
test('classifies a Claude relay key as importable and a rotating OAuth token as dynamic', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ccswitch-auth-'))
  const dbPath = join(root, 'cc-switch.db')

  try {
    const db = new DatabaseSync(dbPath)
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
      VALUES (?, 'claude', ?, ?, '{}', NULL, ?)
    `)
    const rows = [
      // A third-party relay key typed into ANTHROPIC_AUTH_TOKEN: importable.
      ['relay', 'Relay', { env: { ANTHROPIC_AUTH_TOKEN: 'sk-relay-51-chars', ANTHROPIC_BASE_URL: 'https://relay.invalid' } }],
      // A real rotating Claude Code OAuth token: must stay dynamic.
      ['oauth', 'OAuth', { env: { ANTHROPIC_AUTH_TOKEN: 'sk-ant-oat01-rotating', ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } }],
      // The API-key field is importable as before.
      ['plain', 'Plain', { env: { ANTHROPIC_API_KEY: 'sk-ant-api03-static', ANTHROPIC_BASE_URL: 'https://plain.invalid' } }],
    ]
    rows.forEach(([id, name, settings], index) => insert.run(id, name, JSON.stringify(settings), index))
    db.close()

    const repository = new CcSwitchRepository({ dbPath, discoverModels: false, providerSelectors: ['*'] })
    assert.equal(repository.read(), true)
    const kinds = Object.fromEntries(repository.current.routes.map(route => [route.sourceId, route.authKind]))
    assert.deepEqual(kinds, { relay: 'api-key', oauth: 'claude-token', plain: 'api-key' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('opens a CC Switch database read-only and discovers a provider', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ccswitch-'))
  const dataDir = join(root, 'CC Switch Data')
  const dbPath = join(dataDir, 'cc-switch.db')
  mkdirSync(dataDir)

  try {
    const db = new DatabaseSync(dbPath)
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
    db.prepare(`
      INSERT INTO providers (id, app_type, name, settings_config, meta, provider_type, sort_index)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'example-provider',
      'codex',
      'Example Provider',
      JSON.stringify({ OPENAI_API_KEY: 'test-key', base_url: 'https://example.test/v1' }),
      '{}',
      null,
      0,
    )
    db.close()

    const repository = new CcSwitchRepository({
      dbPath,
      discoverModels: false,
      providerSelectors: ['*'],
    })
    assert.equal(repository.exists(), true)
    assert.equal(repository.read(), true)
    assert.deepEqual(repository.current.routes.map(route => ({
      provider: route.provider,
      name: route.name,
      baseURL: route.baseURL,
    })), [{
      provider: 'ccswitch/codex/example-provider',
      name: 'Example Provider',
      baseURL: 'https://example.test/v1',
    }])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
