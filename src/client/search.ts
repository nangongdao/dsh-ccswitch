const MODEL_ITEM_SELECTOR = 'button[role="menuitemradio"][title]'
const MODEL_GROUP_SELECTOR = 'section[role="group"]'
const FILTER_ATTRIBUTE = 'data-dsh-ccswitch-model-filtered'

export const SEARCH_CONTROL_ATTRIBUTE = 'data-dsh-ccswitch-model-search'

export interface FilterResult {
  readonly matchedModels: number
  readonly totalModels: number
}

export interface SearchController {
  readonly groups: HTMLElement
  readonly input: HTMLInputElement
  readonly noResults: HTMLElement
  refresh(): void
  dispose(): void
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase()
}

function modelSearchText(model: HTMLButtonElement): string {
  const visibleName = model.querySelector<HTMLElement>('[class*="modelName"]')?.textContent?.trim() ?? ''
  const title = model.getAttribute('title') ?? ''
  const ariaLabel = model.getAttribute('aria-label') ?? ''
  return [visibleName, title, ariaLabel].filter(value => value.length > 0).join(' ')
}

function directGroups(container: HTMLElement): HTMLElement[] {
  return Array.from(container.children)
    .filter(child => child.matches(MODEL_GROUP_SELECTOR)) as HTMLElement[]
}

/** Filter one rendered model list by model title only. */
export function filterModelGroups(groups: HTMLElement, query: string): FilterResult {
  const needle = normalized(query)
  let matchedModels = 0
  let totalModels = 0

  for (const group of directGroups(groups)) {
    let groupMatches = 0
    const models = group.querySelectorAll<HTMLButtonElement>(MODEL_ITEM_SELECTOR)
    for (const model of models) {
      totalModels += 1
      const matches = normalized(modelSearchText(model)).includes(needle)
      model.hidden = !matches
      model.setAttribute(FILTER_ATTRIBUTE, matches ? 'visible' : 'hidden')
      if (matches) groupMatches += 1
    }
    group.hidden = groupMatches === 0
    group.setAttribute(FILTER_ATTRIBUTE, groupMatches > 0 ? 'visible' : 'hidden')
    matchedModels += groupMatches
  }

  return { matchedModels, totalModels }
}

function restoreModelGroups(groups: HTMLElement): void {
  for (const group of directGroups(groups)) {
    group.hidden = false
    group.removeAttribute(FILTER_ATTRIBUTE)
    for (const model of group.querySelectorAll<HTMLButtonElement>(MODEL_ITEM_SELECTOR)) {
      model.hidden = false
      model.removeAttribute(FILTER_ATTRIBUTE)
    }
  }
}

function visibleModels(groups: HTMLElement): HTMLButtonElement[] {
  return Array.from(groups.querySelectorAll<HTMLButtonElement>(MODEL_ITEM_SELECTOR))
    .filter(model => !model.hidden && !model.disabled && !model.closest<HTMLElement>(MODEL_GROUP_SELECTOR)?.hidden)
}

function findModelGroups(menu: HTMLElement): HTMLElement | null {
  // DSH 0.2.0-rc.2 makes the model viewport itself the `role="menu"` scroll
  // container, with the group sections as its direct children. Older releases
  // nested the sections one level deeper, under a dedicated container.
  if (directGroups(menu).some(group => group.querySelector(MODEL_ITEM_SELECTOR) !== null)) return menu
  const group = Array.from(menu.querySelectorAll<HTMLElement>(MODEL_GROUP_SELECTOR))
    .find(candidate => candidate.querySelector(MODEL_ITEM_SELECTOR) !== null)
  if (group === undefined) return null
  const container = group.parentElement
  return container !== null && container !== menu && menu.contains(container) ? container : null
}

/**
 * DSH 0.2.0-rc.2 renders its own model search (a `role="searchbox"` input in the
 * pane's search row) whenever a provider lists more than four models. Injecting
 * a second box would leave two filters fighting over the same `hidden` flags.
 */
function hasNativeSearch(menu: HTMLElement): boolean {
  const surface = menu.parentElement
  return surface !== null && surface.querySelector('input[role="searchbox"]') !== null
}

/** Add a search input to one currently rendered model pane. */
export function enhanceModelMenu(menu: HTMLElement, groups: HTMLElement): SearchController {
  const control = menu.ownerDocument.createElement('div')
  control.setAttribute(SEARCH_CONTROL_ATTRIBUTE, '')
  control.setAttribute('role', 'search')

  const input = menu.ownerDocument.createElement('input')
  input.type = 'search'
  input.placeholder = '搜索模型'
  input.setAttribute('aria-label', '按模型名称搜索')
  input.autocomplete = 'off'
  input.spellcheck = false

  const noResults = menu.ownerDocument.createElement('div')
  noResults.className = 'dsh-ccswitch-model-search-empty'
  noResults.textContent = '没有匹配的模型'
  noResults.setAttribute('role', 'status')
  noResults.hidden = true

  control.append(input, noResults)
  groups.before(control)

  const refresh = (): void => {
    if (!control.isConnected && groups.isConnected) groups.before(control)
    const result = filterModelGroups(groups, input.value)
    noResults.hidden = normalized(input.value).length === 0 || result.matchedModels > 0 || result.totalModels === 0
  }

  const onInput = (): void => { refresh() }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && normalized(input.value).length > 0) {
      event.preventDefault()
      event.stopPropagation()
      input.value = ''
      refresh()
      input.focus()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const models = visibleModels(groups)
      const target = event.key === 'ArrowDown' ? models[0] : models.at(-1)
      if (target !== undefined) {
        event.preventDefault()
        event.stopPropagation()
        target.focus()
      }
    }
  }

  input.addEventListener('input', onInput)
  input.addEventListener('change', onInput)
  input.addEventListener('search', onInput)
  input.addEventListener('keydown', onKeyDown)
  const view = menu.ownerDocument.defaultView
  const timer = view?.setInterval(refresh, 100)
  refresh()

  return {
    groups,
    input,
    noResults,
    refresh,
    dispose() {
      input.removeEventListener('input', onInput)
      input.removeEventListener('change', onInput)
      input.removeEventListener('search', onInput)
      input.removeEventListener('keydown', onKeyDown)
      if (timer !== undefined) view?.clearInterval(timer)
      restoreModelGroups(groups)
      control.remove()
    },
  }
}

/** Track model panes across menu open, close, reload, and provider updates. */
export function installModelSearch(root: Document = document): () => void {
  const controllers = new Map<HTMLElement, SearchController>()

  const sync = (): void => {
    for (const [menu, controller] of controllers) {
      // Drop the controller when the pane goes away or grows its own search
      // box: two filters over the same `hidden` flags would fight.
      const groups = menu.isConnected && !hasNativeSearch(menu) ? findModelGroups(menu) : null
      if (groups === controller.groups) {
        controller.refresh()
        continue
      }
      controller.dispose()
      controllers.delete(menu)
    }

    for (const menu of root.querySelectorAll<HTMLElement>('[role="menu"]')) {
      if (controllers.has(menu)) continue
      const groups = findModelGroups(menu)
      if (groups !== null && !hasNativeSearch(menu)) controllers.set(menu, enhanceModelMenu(menu, groups))
    }
  }

  const Observer = root.defaultView?.MutationObserver ?? globalThis.MutationObserver
  if (Observer === undefined) return () => undefined
  const observer = new Observer(sync)
  observer.observe(root.body ?? root.documentElement, { childList: true, subtree: true })
  sync()

  return () => {
    observer.disconnect()
    for (const controller of controllers.values()) controller.dispose()
    controllers.clear()
  }
}
