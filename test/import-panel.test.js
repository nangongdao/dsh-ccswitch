import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

/**
 * The import panel is the only part of the plugin the user actually clicks, and
 * it runs inside the real DSH settings page. Render it for real in jsdom so the
 * React tree, the `{ ok, value }` remote envelopes and the row markup are all
 * exercised together.
 */
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const { createElement: h, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { ImportPanel } = await import('../src/client/import-panel.ts')

const claude = {
  provider: 'p-claude', targetProvider: 'ccswitch-claude-1', name: '我的 Claude',
  appType: 'claude', protocol: 'anthropic-messages', models: 3,
  sample: ['claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-opus-4-1'],
  discovery: 'remote', imported: false, eligible: true, reason: '',
}
const oauth = {
  provider: 'p-codex', targetProvider: 'ccswitch-codex-2', name: '公司 Codex',
  appType: 'codex', protocol: 'openai-responses', models: 1,
  sample: ['gpt-5.1-codex'],
  discovery: 'configured', imported: false, eligible: false, reason: 'OAuth/登录令牌保持 CC Switch 动态连接，不复制短期令牌。',
}
const installed = {
  provider: 'p-gemini', targetProvider: 'ccswitch-gemini-3', name: '已导入的 Gemini',
  appType: 'gemini', protocol: 'google-generative-ai', models: 7,
  sample: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  discovery: 'remote', imported: true, credential: 'configured', eligible: false,
  reason: '已导入：模型里只保留这一份，CC Switch 的改动不会覆盖它。',
}
const view = (extra = {}) => ({ available: true, writable: true, rows: [claude, oauth, installed], ...extra })

async function render(remote) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(h(ImportPanel, { remote })) })
  return {
    container,
    click: async element => { await act(async () => { element.click() }) },
    type: async (input, value) => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
      await act(async () => {
        setter.call(input, value)
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      })
    },
    unmount: async () => { await act(async () => root.unmount()); container.remove() },
  }
}

function stub(overrides = {}) {
  const calls = []
  const ok = value => ({ ok: true, value })
  return {
    calls,
    remote: {
      list: async () => { calls.push(['list']); return ok(view()) },
      refresh: async providers => { calls.push(['refresh', providers]); return ok(view()) },
      importProviders: async providers => {
        calls.push(['import', providers])
        return ok([{ provider: 'p-claude', status: 'imported', message: '已导入 3 个模型；密钥已存入 DSH 凭据。' }])
      },
      resync: async providers => {
        calls.push(['resync', providers])
        return ok([{ provider: 'p-gemini', status: 'updated', message: '已同步 7 个模型；密钥与其他设置未改动。' }])
      },
      remove: async providers => {
        calls.push(['remove', providers])
        return ok([{ provider: 'p-gemini', status: 'removed', message: '已从 DSH 移除，并清理了该线路写入的密钥条目。' }])
      },
      ...overrides,
    },
  }
}

const groups = container => Array.from(container.querySelectorAll('.dsh-ccswitch-import-group'))
const groupRows = (container, index) => Array.from(groups(container)[index]?.querySelectorAll('li') ?? [])
const checkboxes = container => Array.from(container.querySelectorAll('input[type="checkbox"]'))
const button = (container, label) =>
  Array.from(container.querySelectorAll('button')).find(element => element.textContent.includes(label))
const count = container => container.querySelector('.dsh-ccswitch-import-count').textContent

test('groups routes into importable, already imported and dynamic connections', async () => {
  const { calls, remote } = stub()
  const panel = await render(remote)

  const section = panel.container.querySelector('section.dsh-ccswitch-import')
  assert.ok(section, 'the panel must render as a labelled settings section')
  assert.equal(section.getAttribute('aria-label'), 'CC Switch 线路导入')
  assert.match(panel.container.textContent, /不导入也能用/)
  assert.ok(button(panel.container, '重新载入线路'), 'the route list can be re-read without touching DSH state')

  // Importable: one selectable row.
  const importable = groupRows(panel.container, 0)
  assert.equal(importable.length, 1)
  assert.match(importable[0].textContent, /我的 Claude/)
  assert.match(importable[0].textContent, /Claude/)
  assert.match(importable[0].textContent, /3 个模型/)
  assert.match(importable[0].textContent, /模型：claude-sonnet-4-5、claude-haiku-4-5、claude-opus-4-1/)
  assert.doesNotMatch(importable[0].textContent, /共 3 个/, 'a complete sample needs no count')
  assert.match(importable[0].textContent, /模型列表来自供应商接口/)
  assert.equal(checkboxes(panel.container)[0].disabled, false)
  assert.equal(checkboxes(panel.container)[0].checked, false)

  // Already imported: has its key state and its own actions, no checkbox.
  const imported = groupRows(panel.container, 1)
  assert.equal(imported.length, 1)
  assert.match(imported[0].textContent, /已导入的 Gemini/)
  assert.match(imported[0].textContent, /只保留这一份/)
  assert.match(imported[0].textContent, /模型：gemini-2\.5-pro、gemini-2\.5-flash …（共 7 个）/)
  assert.ok(imported[0].querySelector('.dsh-ccswitch-import-dot'))
  assert.equal(imported[0].querySelector('input[type="checkbox"]'), null)
  assert.ok(button(imported[0], '更新模型'))
  assert.ok(button(imported[0], '移除'))

  // Dynamic connections stay collapsed, with the reason for each.
  const dynamic = panel.container.querySelector('details.dsh-ccswitch-import-dynamic')
  assert.match(dynamic.querySelector('summary').textContent, /保持 CC Switch 动态连接 1/)
  assert.match(dynamic.textContent, /公司 Codex/)
  assert.match(dynamic.textContent, /OAuth\/登录令牌保持 CC Switch 动态连接/)
  assert.match(dynamic.textContent, /模型：gpt-5\.1-codex/, 'a dynamic route still shows what it would offer')
  assert.equal(dynamic.querySelector('input[type="checkbox"]'), null)

  assert.match(count(panel.container), /可导入 1 · 已选 0/)
  assert.deepEqual(calls, [['list']])
  await panel.unmount()
})

test('selects all, then imports only the selected providers in chunks', async () => {
  const { calls, remote } = stub()
  const panel = await render(remote)

  assert.equal(button(panel.container, '导入所选').disabled, true)
  assert.equal(button(panel.container, '读取全部 (1)').disabled, false,
    'with nothing selected the read button covers every importable route')
  assert.match(button(panel.container, '导入所选').textContent, /导入所选 \(0\)/)

  await panel.click(button(panel.container, '读取全部 (1)'))
  assert.deepEqual(calls, [['list'], ['refresh', ['p-claude']]])
  calls.length = 0

  await panel.click(button(panel.container, '全选'))
  assert.match(count(panel.container), /已选 1/)
  assert.equal(checkboxes(panel.container)[0].checked, true)
  assert.equal(button(panel.container, '导入所选').disabled, false)
  await panel.click(button(panel.container, '导入所选'))

  assert.deepEqual(calls, [['import', ['p-claude']], ['list']])
  const feedback = panel.container.querySelector('.dsh-ccswitch-import-feedback')
  assert.match(feedback.querySelector('[role="status"]').textContent, /成功 1 · 跳过 0 · 失败 0/)
  assert.match(feedback.textContent, /我的 Claude：已导入 3 个模型/)
  await panel.unmount()
})

test('updates or removes an imported route, asking once before removing', async () => {
  const { calls, remote } = stub()
  const panel = await render(remote)
  const [row] = groupRows(panel.container, 1)

  await panel.click(button(row, '更新模型'))
  assert.deepEqual(calls, [['list'], ['resync', ['p-gemini']], ['list']])
  assert.match(panel.container.querySelector('.dsh-ccswitch-import-feedback').textContent, /已同步 7 个模型/)

  const { calls: second, remote: secondRemote } = stub()
  const removing = await render(secondRemote)
  const [target] = groupRows(removing.container, 1)
  await removing.click(button(target, '移除'))
  assert.deepEqual(second, [['list']], 'removing must confirm before it writes')
  assert.match(removing.container.textContent, /移除会删除这个 DSH 原生供应商/)
  await removing.click(button(removing.container, '确认移除'))
  assert.deepEqual(second, [['list'], ['remove', ['p-gemini']], ['list']])
  assert.match(removing.container.querySelector('.dsh-ccswitch-import-feedback').textContent, /已从 DSH 移除/)

  await panel.unmount()
  await removing.unmount()
})

test('filters rows and reports an empty result without losing the panel', async () => {
  const { remote } = stub()
  const panel = await render(remote)
  const filter = panel.container.querySelector('input[type="search"]')

  await panel.type(filter, 'codex')
  assert.match(count(panel.container), /可导入 0/)
  assert.match(panel.container.querySelector('details').textContent, /公司 Codex/)

  await panel.type(filter, 'claude-haiku-4-5')
  assert.match(count(panel.container), /可导入 1/, 'a model id is searchable before importing')
  assert.equal(groupRows(panel.container, 0).length, 1)

  await panel.type(filter, '不存在的线路')
  assert.equal(panel.container.querySelectorAll('.dsh-ccswitch-import-rows li').length, 0)
  assert.match(panel.container.textContent, /没有匹配的线路。/)
  assert.ok(panel.container.querySelector('section.dsh-ccswitch-import'))
  await panel.unmount()
})

test('a long catalog is sampled with its size so a thin list is explainable', async () => {
  const rows = [{ ...claude, models: 12 }]
  const { remote } = stub({ list: async () => ({ ok: true, value: view({ rows }) }) })
  const panel = await render(remote)
  assert.match(panel.container.textContent, /模型：claude-sonnet-4-5、claude-haiku-4-5、claude-opus-4-1 …（共 12 个）/)
  await panel.unmount()
})

test('drops a route from the selection once it is imported', async () => {
  let rows = [claude]
  const { remote } = stub({
    list: async () => ({ ok: true, value: view({ rows }) }),
    importProviders: async () => {
      rows = [{
        ...claude, imported: true, eligible: false, credential: 'configured',
        reason: '已导入：模型里只保留这一份，CC Switch 的改动不会覆盖它。',
      }]
      return { ok: true, value: [{ provider: 'p-claude', status: 'imported', message: '已导入 3 个模型；密钥已存入 DSH 凭据。' }] }
    },
  })
  const panel = await render(remote)
  await panel.click(button(panel.container, '全选'))
  assert.match(count(panel.container), /已选 1/)

  await panel.click(button(panel.container, '导入所选'))
  assert.match(count(panel.container), /已选 0/, 'a route that moved to 已导入 is no longer selectable')
  assert.match(count(panel.container), /已导入 1/)
  assert.equal(button(panel.container, '导入所选').disabled, true)
  assert.match(panel.container.querySelector('.dsh-ccswitch-import-feedback').textContent, /成功 1/)
  await panel.unmount()
})

test('keeps failed routes selected so a retry stays one click', async () => {
  const { remote } = stub({
    importProviders: async providers => ({
      ok: true,
      value: providers.map(provider => ({ provider, status: 'failed', message: '写入失败，请检查 DSH 写入权限。' })),
    }),
  })
  const panel = await render(remote)
  await panel.click(button(panel.container, '全选'))
  await panel.click(button(panel.container, '导入所选'))

  assert.match(count(panel.container), /已选 1/)
  assert.equal(button(panel.container, '导入所选').disabled, false)
  assert.match(panel.container.querySelector('.dsh-ccswitch-import-feedback').textContent, /失败 1/)
  await panel.unmount()
})

test('surfaces read-only, unavailable and failed reads instead of rendering a broken section', async () => {
  const readOnly = await render(stub({ list: async () => ({ ok: true, value: view({ writable: false }) }) }).remote)
  assert.match(readOnly.container.querySelector('[role="alert"]').textContent, /只读/)
  await readOnly.unmount()

  const missing = await render(stub({ list: async () => ({ ok: true, value: view({ available: false }) }) }).remote)
  assert.match(missing.container.querySelector('[role="alert"]').textContent, /llm-pi-ai/)
  await missing.unmount()

  const broken = await render(stub({ list: async () => ({ ok: false, error: { message: '服务不可用' } }) }).remote)
  assert.match(broken.container.querySelector('[role="alert"]').textContent, /服务不可用/)
  await broken.unmount()

  const rejected = await render(stub({ list: async () => { throw new Error('boom') } }).remote)
  assert.match(rejected.container.querySelector('[role="alert"]').textContent, /完整重启 DSH/)
  await rejected.unmount()
})

test('a missing key and an empty catalog are reported instead of hidden', async () => {
  const rows = [
    { ...installed, credential: 'missing' },
    { ...installed, provider: 'p-empty', targetProvider: 'ccswitch-gemini-empty', name: '空目录的 Gemini', models: 0, sample: [] },
    { ...claude, models: 0, discovery: 'failed', eligible: false, reason: '该线路还没有可用模型：请先「读取模型列表」，或检查接口地址与密钥。' },
  ]
  const { remote } = stub({ list: async () => ({ ok: true, value: view({ rows }) }) })
  const panel = await render(remote)

  assert.match(panel.container.textContent, /密钥条目不见了/)
  assert.match(panel.container.textContent, /当前没有任何模型/)
  assert.ok(groupRows(panel.container, 0)[0].querySelector('.dsh-ccswitch-import-dot.is-missing'))
  const dynamic = panel.container.querySelector('details.dsh-ccswitch-import-dynamic')
  assert.match(dynamic.textContent, /接口读取失败/)
  assert.match(dynamic.textContent, /还没有可用模型/)
  assert.doesNotMatch(panel.container.textContent, /undefined/)
  await panel.unmount()
})

test('a failed import keeps the panel usable and never echoes the upstream error', async () => {
  const { remote } = stub({
    importProviders: async () => ({ ok: false, error: { message: 'sk-secret upstream failure' } }),
  })
  const panel = await render(remote)

  await panel.click(button(panel.container, '全选'))
  await panel.click(button(panel.container, '导入所选'))

  const alert = panel.container.querySelector('[role="alert"]')
  assert.match(alert.textContent, /操作未完成/)
  assert.doesNotMatch(panel.container.textContent, /sk-secret/)
  assert.equal(button(panel.container, '导入所选').disabled, false)
  await panel.unmount()
})

test('reloads the route list on demand and never selects more than one batch', async () => {
  const { calls, remote } = stub()
  const panel = await render(remote)
  await panel.click(button(panel.container, '重新载入线路'))
  assert.deepEqual(calls, [['list'], ['list']])
  await panel.unmount()

  const many = Array.from({ length: 130 }, (_, index) => ({
    ...claude, provider: `p-${index}`, targetProvider: `ccswitch-claude-${index}`, name: `线路 ${index}`,
  }))
  const batch = await render(stub({ list: async () => ({ ok: true, value: view({ rows: many }) }) }).remote)
  assert.match(batch.container.textContent, /可导入 130/)
  await batch.click(button(batch.container, '全选'))
  assert.match(count(batch.container), /已选 128/)
  assert.equal(checkboxes(batch.container).filter(box => box.checked).length, 128)
  assert.match(batch.container.textContent, /一次最多导入 128 条/)
  await batch.unmount()
})
