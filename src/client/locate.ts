/**
 * Cross-links the import panel and the native provider cards.
 *
 * The panel is a `settings.models.footer` entry and the card badge is a
 * `settings.models.provider-card` entry, so neither owns the other's React tree.
 * They talk over a document-level CustomEvent and find each other through a data
 * attribute: the native card exposes no provider identity of its own, so
 * matching on its text would break the moment a route is renamed.
 */
export const LOCATE_EVENT = 'dsh-ccswitch-locate'
export const ROW_ATTRIBUTE = 'data-dsh-ccswitch-row'
export const CARD_ATTRIBUTE = 'data-dsh-ccswitch-card'
export const FLASH_CLASS = 'dsh-ccswitch-flash'
/** Long enough to be seen while the scroll settles, short enough not to linger. */
const FLASH_MS = 1400

export interface LocateDetail {
  /**
   * The imported provider id (`ccswitch-<app>-<hash>`), the only id the panel and
   * a card both know: the card is dispatched under it, and the panel's row
   * carries it as a data attribute.
   */
  target: string
  /** Who asked: the other side is the one that moves. */
  from: 'panel' | 'card'
}

/** Ask the other side to bring this imported provider into view. */
export function requestLocate(target: string, from: LocateDetail['from']): void {
  const view = document.defaultView
  const Constructor = view === null ? CustomEvent : view.CustomEvent
  document.dispatchEvent(new Constructor<LocateDetail>(LOCATE_EVENT, { detail: { target, from } }))
}

/** Read a locate request, ignoring any event that is not shaped like one. */
export function readLocate(event: Event): LocateDetail | undefined {
  const detail = (event as CustomEvent<Partial<LocateDetail> | null>).detail
  if (detail === null || typeof detail !== 'object') return undefined
  if (typeof detail.target !== 'string' || detail.target === '') return undefined
  if (detail.from !== 'panel' && detail.from !== 'card') return undefined
  return { target: detail.target, from: detail.from }
}

/**
 * One attribute value, found without a CSS-escaped selector.
 *
 * Route ids come from the user's CC Switch database, so building a selector out
 * of one would need `CSS.escape` (absent in some engines) or a quoting rule that
 * silently breaks on the first quote in a name.
 */
export function findByAttribute(root: ParentNode, attribute: string, value: string): HTMLElement | undefined {
  for (const element of root.querySelectorAll<HTMLElement>(`[${attribute}]`)) {
    if (element.getAttribute(attribute) === value) return element
  }
  return undefined
}

/** Bring one element into view and flash it; a DOM without layout is not an error. */
export function reveal(element: Element | null | undefined): boolean {
  if (element === null || element === undefined) return false
  // jsdom (and anything else without layout) simply has no scrollIntoView.
  if (typeof element.scrollIntoView === 'function') element.scrollIntoView({ block: 'center', behavior: 'smooth' })
  element.classList.add(FLASH_CLASS)
  const view = element.ownerDocument.defaultView
  if (view === null) element.classList.remove(FLASH_CLASS)
  else view.setTimeout(() => element.classList.remove(FLASH_CLASS), FLASH_MS)
  return true
}
