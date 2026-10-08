import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

/**
 * The provider-card seat is keyed on the settings namespace, so this component is
 * mounted inside *every* `llm-pi-ai` card — the official routes and any provider
 * the user declared by hand included. The important behaviours are therefore the
 * silent one (render nothing for a route this plugin did not write) and the
 * cross-seat handshake with the import panel.
 */
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const { createElement: h, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { ProviderCardExtras, importedTarget } = await import('../src/client/provider-card.ts')

const card = (extra = {}) => ({
  provider: 'ccswitch-gemini-3',
  displayName: 'CC Switch · Gemini · 已导入的 Gemini',
  settingsNs: 'llm-pi-ai',
  settingsPath: ['providers', 'ccswitch-gemini-3'],
  active: true,
  ...extra,
})

/** Render the badge the way the native card does: inside the card's own `li`. */
async function render(entry) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(h('li', { className: 'native-row-card' },
      h(ProviderCardExtras, { provider: entry, configured: true, keyConfigured: true })))
  })
  const host = container.querySelector('li')
  return {
    container,
    host,
    link: () => Array.from(container.querySelectorAll('button')).find(element => element.textContent.includes('定位到导入面板')),
    unmount: async () => { await act(async () => root.unmount()); container.remove() },
  }
}

test('reads the imported target out of a route path', () => {
  assert.equal(importedTarget(card()), 'ccswitch-gemini-3')
  assert.equal(importedTarget(card({ settingsPath: ['providers', 'my-own-route'] })), undefined)
  assert.equal(importedTarget(card({ settingsPath: ['routes', 'ccswitch-gemini-3'] })), undefined)
  assert.equal(importedTarget(card({ settingsPath: [] })), undefined)
  assert.equal(importedTarget(card({ settingsPath: ['providers'] })), undefined)
})

test('shows the badge only on an imported route', async () => {
  const imported = await render(card())
  assert.match(imported.container.textContent, /CC Switch/)
  assert.match(imported.container.textContent, /都在页面下方的导入面板里管理/)
  assert.equal(imported.container.querySelector('[data-dsh-ccswitch-card]').getAttribute('data-dsh-ccswitch-card'), 'ccswitch-gemini-3')
  assert.ok(imported.link())
  await imported.unmount()

  // An official or hand-declared pi-ai provider must get nothing at all — not an
  // empty wrapper that would add a stray gap to a card this plugin does not own.
  for (const entry of [
    card({ provider: 'deepseek-official', settingsPath: ['providers', 'deepseek-official'] }),
    card({ settingsPath: undefined }),
    card({ provider: 'deepseek-account', settingsNs: '', settingsPath: [] }),
  ]) {
    const untouched = await render(entry)
    assert.equal(untouched.host.childNodes.length, 0)
    await untouched.unmount()
  }
})

test('locates the panel and answers when the panel locates this card', async () => {
  const view = await render(card())

  const asked = []
  const hear = event => asked.push(event.detail)
  document.addEventListener('dsh-ccswitch-locate', hear)
  await act(async () => { view.link().click() })
  document.removeEventListener('dsh-ccswitch-locate', hear)
  // The card asks with its own native id and never reacts to its own request.
  assert.deepEqual(asked, [{ target: 'ccswitch-gemini-3', from: 'card' }])
  assert.match(view.container.textContent, /都在页面下方的导入面板里管理/)

  const call = detail => document.dispatchEvent(new dom.window.CustomEvent('dsh-ccswitch-locate', { detail }))
  await act(async () => { call({ target: 'ccswitch-other', from: 'panel' }) })
  assert.equal(view.host.classList.contains('dsh-ccswitch-flash'), false)
  assert.match(view.container.textContent, /都在页面下方的导入面板里管理/)

  // The card is the element that moves: the badge lives inside it.
  await act(async () => { call({ target: 'ccswitch-gemini-3', from: 'panel' }) })
  assert.ok(view.host.classList.contains('dsh-ccswitch-flash'))
  assert.match(view.container.textContent, /已在下方面板中定位/)

  await view.unmount()
})
