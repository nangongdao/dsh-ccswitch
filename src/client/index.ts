import { installModelSearch } from './search.ts'
import { ImportPanel } from './import-panel.ts'
import { importRemoteContribution } from '../import-contract.ts'
import type { ImportRemote } from '../import-contract.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'

const PACKAGE_ID = 'dsh-ccswitch'

const styles = `
.dsh-ccswitch-import { display:flex; flex-direction:column; gap:10px; margin-top:16px; padding:16px; border:1px solid var(--dsw-alias-border-l2); border-radius:12px; color:var(--dsw-alias-label-primary); font-size:13px; }
.dsh-ccswitch-import h3, .dsh-ccswitch-import p { margin:0; }
.dsh-ccswitch-import-actions { display:flex; flex-wrap:wrap; gap:8px; }
.dsh-ccswitch-import button { cursor:pointer; padding:7px 10px; border:1px solid var(--dsw-alias-border-l2); border-radius:6px; background:transparent; color:inherit; font:inherit; }
.dsh-ccswitch-import button:disabled { cursor:default; opacity:.5; }
.dsh-ccswitch-import input[type="search"] { width:100%; box-sizing:border-box; padding:8px; border:1px solid var(--dsw-alias-border-l2); border-radius:6px; background:transparent; color:inherit; }
.dsh-ccswitch-import-rows { max-height:360px; overflow:auto; display:flex; flex-direction:column; gap:10px; list-style:none; margin:0; padding:0; }
.dsh-ccswitch-import-rows li { display:flex; flex-direction:column; gap:4px; }
.dsh-ccswitch-import-rows label { display:flex; align-items:center; gap:8px; }
.dsh-ccswitch-import small, .dsh-ccswitch-import-note { color:var(--dsw-alias-label-tertiary); }
.dsh-ccswitch-import [role="alert"] { color:var(--dsw-alias-state-error-primary); }
[data-dsh-ccswitch-model-search] {
  flex: 0 0 auto;
  padding: 4px 4px 6px;
}

[data-dsh-ccswitch-model-filtered="hidden"] {
  display: none !important;
}

[data-dsh-ccswitch-model-search] input[type="search"] {
  box-sizing: border-box;
  width: 100%;
  height: 32px;
  padding: 0 9px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  outline: none;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family);
  font-size: 13px;
  font-weight: 400;
  line-height: 20px;
  letter-spacing: 0;
}

[data-dsh-ccswitch-model-search] input[type="search"]::placeholder {
  color: var(--dsw-alias-label-tertiary);
}

[data-dsh-ccswitch-model-search] input[type="search"]:focus-visible {
  border-color: var(--dsw-alias-border-l4);
  box-shadow: 0 0 0 2px var(--dsw-alias-border-l2);
}

.dsh-ccswitch-model-search-empty {
  padding: 10px 6px 4px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
  font-weight: 400;
  line-height: 20px;
  letter-spacing: 0;
}
`

type ClientContext = Pick<Context, 'effect'> & {
  slots: Pick<SlotCore, 'register'> & { inject(name: 'settings.models.footer', callback: () => (() => void)): void }
  remote: TypertClientRemote & { ccswitch: ImportRemote }
}

export const inject: readonly string[] = ['slots', 'remote']

export function apply(ctx: ClientContext): void {
  const style = document.createElement('style')
  style.dataset.plugin = PACKAGE_ID
  style.textContent = styles
  document.head.append(style)

  ctx.effect(() => () => style.remove(), 'dsh-ccswitch: model search styles')
  ctx.effect(() => installModelSearch(), 'dsh-ccswitch: model name search')
  ctx.effect(async () => {
    const disposeRemote = await ctx.remote.$mount(importRemoteContribution)
    ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
      name: 'settings.models.footer', id: PACKAGE_ID, order: 20,
      inject: () => ({ remote: ctx.remote.ccswitch }),
    }, ImportPanel))
    return disposeRemote
  }, 'dsh-ccswitch: native model import')
}
