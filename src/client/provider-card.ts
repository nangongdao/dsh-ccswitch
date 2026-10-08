/**
 * The badge the plugin adds to every `llm-pi-ai` provider card.
 *
 * The seat is keyed on the settings namespace, not on the route, so one
 * registration receives every card of the family — including the official
 * DeepSeek routes and any pi-ai provider the user declared by hand. Everything
 * that is not an imported CC Switch route must therefore render nothing.
 */
import { createElement as h, useEffect, useRef, useState } from 'react'
import type { ProviderCardExtrasOwnerProps } from '@deepseek-ai/dsh-client-ui-settings-models/client'
import { CARD_ATTRIBUTE, LOCATE_EVENT, readLocate, requestLocate, reveal } from './locate.ts'

/**
 * Which namespace an imported route is written into. Kept in step with
 * `src/importer.ts`; the target id check below is the real filter, this only
 * keeps the badge off a namespace that cannot hold our routes.
 */
export const IMPORT_NAMESPACE = 'llm-pi-ai'
/** Every id this plugin writes starts here (see `importedProviderId`). */
const TARGET_PREFIX = 'ccswitch-'

/** The provider id an imported route was written as, or undefined for anything else. */
export function importedTarget(provider: Pick<ProviderCardExtrasOwnerProps['provider'], 'settingsPath'>): string | undefined {
  // `settingsPath` is typed as an array, but a runtime-registered route that was
  // never declared by hand is described with no path at all; never throw here.
  const path = provider.settingsPath
  if (!Array.isArray(path)) return undefined
  const [head, target] = path
  if (head !== 'providers' || typeof target !== 'string') return undefined
  return target.startsWith(TARGET_PREFIX) ? target : undefined
}

export function ProviderCardExtras({ provider }: ProviderCardExtrasOwnerProps) {
  const target = importedTarget(provider)
  const ref = useRef<HTMLDivElement | null>(null)
  const [here, setHere] = useState(false)

  useEffect(() => {
    if (target === undefined) return
    const listener = (event: Event) => {
      const detail = readLocate(event)
      if (detail === undefined || detail.from !== 'panel' || detail.target !== target) return
      const card = ref.current
      if (card === null) return
      setHere(true)
      // The badge sits inside the card; the card is what should move into view.
      reveal(card.closest('li') ?? card)
    }
    document.addEventListener(LOCATE_EVENT, listener)
    return () => document.removeEventListener(LOCATE_EVENT, listener)
  }, [target])

  if (target === undefined) return null

  return h('div', { ref, className: 'dsh-ccswitch-card', [CARD_ATTRIBUTE]: target },
    h('span', { className: 'dsh-ccswitch-card-badge' }, 'CC Switch'),
    h('span', { className: 'dsh-ccswitch-card-note' },
      here ? '已在下方面板中定位。' : '这条线路由 dsh-ccswitch 导入；模型、密钥与移除都在页面下方的导入面板里管理。'),
    h('button', {
      type: 'button', className: 'dsh-ccswitch-card-link',
      onClick: () => requestLocate(target, 'card'),
    }, '定位到导入面板'),
  )
}
