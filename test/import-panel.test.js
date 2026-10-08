import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

/**
 * The native import panel is the only part of 0.3.0 the user actually clicks,
 * and it runs inside the DSH settings page. Render it for real in jsdom so the
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
  discovery: 'remote', imported: false, eligible: true, reason: '',
}
const oauth = {
  provider: 'p-codex', targetProvider: 'ccswitch-codex-2', name: '公司 Codex',
  appType: 'codex', protocol: 'openai-responses', models: 1,
  discovery: 'configured', imported: false, eligible: false, reason: 'OAuth 令牌仅在动态连接中使用',
}
const view = (extra = {}) => ({ available: true, writable: true, rows: [claude, oauth], ...extra })

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
  return {
    calls,
    remote: {
      list: async () => { calls.push(['list']); return { ok: true, value: view() } },
      refresh: async providers => { calls.push(['refresh', providers]); return { ok: true, value: view() } },
      importProviders: async providers => {
        calls.push(['import', providers])
        return { ok: true, value: [{ provider: 'p-claude', status: 'imported', message: '已导入为 DSH 原生供应商' }] }
      },
      ...overrides,
    },
  }
}

const checkbox = (container, index) => container.querySelectorAll('input[type="checkbox"]')[index]
const button = (container, label) =>
  Array.from(container.querySelectorAll('button')).find(element => element.textContent.includes(label))

test('renders every CC Switch route with its eligibility and discovery state', async () => {
  const { calls, remote } = stub()
  const panel = await render(remote)

  const section = panel.container.querySelector('section.dsh-ccswitch-import')
  assert.ok(section, 'the panel must render as a labelled settings section')
  assert.equal(section.getAttribute('aria-label'), 'CC Switch 原生导入')
  assert.match(panel.container.textContent, /一次性导入 API Key 供应商/)

  const rows = panel.container.querySelectorAll('.dsh-ccswitch-import-rows li')
  assert.equal(rows.length, 2)
  assert.match(rows[0].textContent, /我的 Claude · claude · 3 个模型/)
  assert.match(rows[0].textContent, /接口已返回列表/)
  assert.equal(checkbox(panel.container, 0).disabled, false)
  assert.equal(checkbox(panel.container, 0).checked, false)

  assert.match(rows[1].textContent, /公司 Codex · codex · 1 个模型/)
  assert.match(rows[1].textContent, /仅 CC Switch 配置模型；OAuth 令牌仅在动态连接中使用/)
  assert.equal(checkbox(panel.container, 1).disabled, true, 'OAuth routes must not be selectable')

  assert.deepEqual(calls, [['list']])
  await panel.unmount()
})

test('refreshes and imports only the selected providers', async () => {
  const { calls, remote } = stub()
  const panel = await render(remote)

  assert.match(button(panel.container, '导入所选').textContent, /导入所选 \(0\)/)
  assert.equal(button(panel.container, '导入所选').disabled, true)
  assert.equal(button(panel.container, '获取所选模型列表').disabled, true)

  await panel.click(button(panel.container, '选择可导入项'))
  assert.match(button(panel.container, '导入所选').textContent, /导入所选 \(1\)/)
  assert.equal(button(panel.container, '导入所选').disabled, false)
  assert.equal(checkbox(panel.container, 0).checked, true)
  assert.equal(checkbox(panel.container, 1).checked, false)

  await panel.click(button(panel.container, '获取所选模型列表'))
  await panel.click(button(panel.container, '导入所选'))
  assert.deepEqual(calls, [['list'], ['refresh', ['p-claude']], ['import', ['p-claude']], ['list']])

  const status = panel.container.querySelector('[role="status"]')
  assert.match(status.textContent, /我的 Claude：已导入为 DSH 原生供应商/)

  await panel.click(checkbox(panel.container, 0))
  assert.match(button(panel.container, '导入所选').textContent, /导入所选 \(0\)/)
  await panel.unmount()
})

test('filters rows and reports an empty result without losing the panel', async () => {
  const { remote } = stub()
  const panel = await render(remote)
  const filter = panel.container.querySelector('input[type="search"]')

  await panel.type(filter, 'codex')
  assert.equal(panel.container.querySelectorAll('.dsh-ccswitch-import-rows li').length, 1)
  assert.match(panel.container.querySelector('.dsh-ccswitch-import-rows li').textContent, /公司 Codex/)

  await panel.type(filter, '不存在的线路')
  assert.equal(panel.container.querySelectorAll('.dsh-ccswitch-import-rows li').length, 0)
  assert.match(panel.container.textContent, /没有匹配的供应商。/)
  assert.ok(panel.container.querySelector('section.dsh-ccswitch-import'))
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

test('a failed import keeps the panel usable and never echoes the upstream error', async () => {
  const { remote } = stub({
    importProviders: async () => ({ ok: false, error: { message: 'sk-secret upstream failure' } }),
  })
  const panel = await render(remote)

  await panel.click(button(panel.container, '选择可导入项'))
  await panel.click(button(panel.container, '导入所选'))

  const alert = panel.container.querySelector('[role="alert"]')
  assert.match(alert.textContent, /操作未完成/)
  assert.doesNotMatch(panel.container.textContent, /sk-secret/)
  assert.equal(button(panel.container, '导入所选').disabled, false)
  await panel.unmount()
})
