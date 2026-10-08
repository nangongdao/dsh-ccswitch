import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import {
  enhanceModelMenu,
  filterModelGroups,
  installModelSearch,
  SEARCH_CONTROL_ATTRIBUTE,
} from '../src/client/search.ts'

function fixture() {
  const dom = new JSDOM(`<!doctype html><body>
    <div role="menu">
      <div class="groups">
        <section role="group">
          <div>Company Codex</div>
          <button role="menuitemradio" title="internal-codex-id"><span class="modelName">gpt-5.6-sol</span></button>
          <button role="menuitemradio" title="internal-mini-id"><span class="modelName">GPT-5 Mini</span></button>
        </section>
        <section role="group">
          <div>DeepSeek Provider</div>
          <button role="menuitemradio" title="deepseek-chat"><span class="modelName">deepseek-chat</span></button>
        </section>
      </div>
    </div>
  `, { pretendToBeVisual: true })
  const document = dom.window.document
  return {
    dom,
    document,
    menu: document.querySelector('[role="menu"]'),
    groups: document.querySelector('.groups'),
  }
}

test('filters case-insensitively by model name only and hides empty providers', () => {
  const { groups } = fixture()

  const result = filterModelGroups(groups, '  GPT-5.6-SOL  ')

  assert.deepEqual(result, { matchedModels: 1, totalModels: 3 })
  assert.equal(groups.children[0].hidden, false)
  assert.equal(groups.children[1].hidden, true)
  assert.equal(groups.querySelector('[title="internal-codex-id"]').hidden, false)
  assert.equal(groups.querySelector('[title="internal-mini-id"]').hidden, true)

  const providerOnly = filterModelGroups(groups, 'DeepSeek Provider')
  assert.equal(providerOnly.matchedModels, 0)
  assert.equal(Array.from(groups.children).every(group => group.hidden), true)
})

test('shows no-result state and Escape clears the query without closing the pane', () => {
  const { dom, menu, groups } = fixture()
  const controller = enhanceModelMenu(menu, groups)
  let bubbledEscape = 0
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape') bubbledEscape += 1
  })

  controller.input.value = 'does-not-exist'
  controller.input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  assert.equal(controller.noResults.hidden, false)
  assert.equal(Array.from(groups.children).every(group => group.hidden), true)

  const clearEvent = new dom.window.KeyboardEvent('keydown', {
    key: 'Escape', bubbles: true, cancelable: true,
  })
  controller.input.dispatchEvent(clearEvent)
  assert.equal(clearEvent.defaultPrevented, true)
  assert.equal(bubbledEscape, 0)
  assert.equal(controller.input.value, '')
  assert.equal(controller.noResults.hidden, true)
  assert.equal(Array.from(groups.children).every(group => !group.hidden), true)

  const backEvent = new dom.window.KeyboardEvent('keydown', {
    key: 'Escape', bubbles: true, cancelable: true,
  })
  controller.input.dispatchEvent(backEvent)
  assert.equal(backEvent.defaultPrevented, false)
  assert.equal(bubbledEscape, 1)
  controller.dispose()
})

test('ArrowDown focuses the first visible model', () => {
  const { dom, document, menu, groups } = fixture()
  const controller = enhanceModelMenu(menu, groups)
  controller.input.value = 'deepseek'
  controller.input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))

  controller.input.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
    key: 'ArrowDown', bubbles: true, cancelable: true,
  }))

  assert.equal(document.activeElement?.getAttribute('title'), 'deepseek-chat')
  controller.dispose()
})

test('polling applies a changed search value when no input event is delivered', async () => {
  const { menu, groups } = fixture()
  const controller = enhanceModelMenu(menu, groups)
  controller.input.value = 'deepseek-chat'

  await new Promise(resolve => setTimeout(resolve, 120))

  assert.equal(groups.querySelector('[title="internal-codex-id"]').getAttribute('data-dsh-ccswitch-model-filtered'), 'hidden')
  assert.equal(groups.querySelector('[title="deepseek-chat"]').getAttribute('data-dsh-ccswitch-model-filtered'), 'visible')
  controller.dispose()
  assert.equal(groups.querySelector('[title="internal-codex-id"]').hasAttribute('data-dsh-ccswitch-model-filtered'), false)
})

test('closing and reopening a model menu resets search', async () => {
  const first = fixture()
  const dispose = installModelSearch(first.document)
  await new Promise(resolve => setTimeout(resolve, 0))

  const firstInput = first.document.querySelector(`[${SEARCH_CONTROL_ATTRIBUTE}] input`)
  assert.ok(firstInput)
  firstInput.value = 'gpt'
  firstInput.dispatchEvent(new first.dom.window.Event('input', { bubbles: true }))
  first.menu.remove()
  await new Promise(resolve => setTimeout(resolve, 0))

  const next = first.document.createElement('div')
  next.innerHTML = `
    <div role="menu"><div class="groups"><section role="group">
      <button role="menuitemradio" title="deepseek-chat">deepseek-chat</button>
    </section></div></div>`
  first.document.body.append(next.firstElementChild)
  await new Promise(resolve => setTimeout(resolve, 0))

  const reopenedInput = first.document.querySelector(`[${SEARCH_CONTROL_ATTRIBUTE}] input`)
  assert.ok(reopenedInput)
  assert.equal(reopenedInput.value, '')
  assert.equal(first.document.querySelector('[title="deepseek-chat"]').hidden, false)
  dispose()
  assert.equal(first.document.querySelector(`[${SEARCH_CONTROL_ATTRIBUTE}]`), null)
})

/**
 * The DSH 0.2.0-rc.2 model pane: the MenuSurface is `role="group"` (pane
 * "model"), the model viewport is itself the `role="menu"` scroll container,
 * and the group sections are its direct children. DSH renders its own
 * `role="searchbox"` input when a provider lists more than four models.
 */
function modernFixture({ withNativeSearch = false } = {}) {
  const nativeSearch = withNativeSearch
    ? '<div class="searchRow"><input type="text" role="searchbox" aria-label="搜索模型" placeholder="搜索模型"></div>'
    : ''
  const dom = new JSDOM(`<!doctype html><body>
    <div role="group" aria-label="模型">
      ${nativeSearch}
      <div class="groups" role="menu" id="model-select-models">
        <section role="group" data-menu-group="">
          <div>Company Codex</div>
          <button role="menuitemradio" aria-checked="false" title="internal-codex-id"><span class="modelName">gpt-5.6-sol</span></button>
        </section>
        <section role="group" data-menu-group="">
          <div>DeepSeek Provider</div>
          <button role="menuitemradio" aria-checked="true" title="deepseek-chat"><span class="modelName">deepseek-chat</span></button>
        </section>
      </div>
    </div>
  `, { pretendToBeVisual: true })
  const document = dom.window.document
  return { dom, document, viewport: document.querySelector('.groups') }
}

test('attaches to the DSH 0.2.0-rc.2 model pane that renders no search box', () => {
  const { document, viewport } = modernFixture()
  const dispose = installModelSearch(document)

  const control = document.querySelector(`[${SEARCH_CONTROL_ATTRIBUTE}]`)
  assert.ok(control, 'the search control must attach to the current pane layout')
  assert.equal(control.nextElementSibling, viewport)

  const input = control.querySelector('input')
  input.value = 'deepseek'
  input.dispatchEvent(new document.defaultView.Event('input', { bubbles: true }))
  assert.equal(document.querySelector('[title="internal-codex-id"]').hidden, true)
  assert.equal(document.querySelector('[title="deepseek-chat"]').hidden, false)

  dispose()
  assert.equal(document.querySelector(`[${SEARCH_CONTROL_ATTRIBUTE}]`), null)
  assert.equal(document.querySelector('[title="internal-codex-id"]').hidden, false)
})

test('leaves the pane alone when DSH already renders its own search box', () => {
  const { document } = modernFixture({ withNativeSearch: true })
  const dispose = installModelSearch(document)

  assert.equal(
    document.querySelector(`[${SEARCH_CONTROL_ATTRIBUTE}]`),
    null,
    'a second search box must not be injected next to the native one',
  )
  dispose()
})

test('withdraws the injected search box once DSH renders its own', async () => {
  const { dom, document, viewport } = modernFixture()
  const dispose = installModelSearch(document)
  assert.ok(document.querySelector(`[${SEARCH_CONTROL_ATTRIBUTE}]`))

  // A provider that grows past DSH's four-model threshold makes DSH render its
  // own searchbox; the injected one must stand down instead of double-filtering.
  const native = document.createElement('div')
  native.className = 'searchRow'
  native.innerHTML = '<input type="text" role="searchbox" aria-label="搜索模型">'
  viewport.before(native)
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.equal(document.querySelector(`[${SEARCH_CONTROL_ATTRIBUTE}]`), null)
  dispose()
})

