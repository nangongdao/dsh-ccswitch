import { installModelSearch } from './search.ts'
import { ImportPanel } from './import-panel.ts'
import { IMPORT_NAMESPACE, ProviderCardExtras } from './provider-card.ts'
import { importRemoteContribution } from '../import-contract.ts'
import type { ImportRemote } from '../import-contract.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'

const PACKAGE_ID = 'dsh-ccswitch'
/** The two seats this plugin fills, named so a rename cannot desync them. */
type SeatName = 'settings.models.footer' | 'settings.models.provider-card'

const styles = `
.dsh-ccswitch-import { display:flex; flex-direction:column; gap:12px; max-width:720px; margin-top:20px; padding-top:16px; border-top:.5px solid var(--dsw-alias-border-l2); color:var(--dsw-alias-label-primary); font-family:var(--dsw-font-family); font-size:14px; line-height:22px; }
.dsh-ccswitch-import-title-row { display:flex; align-items:center; gap:8px; }
.dsh-ccswitch-import-title { flex:1 1 auto; margin:0; font-size:16px; font-weight:500; line-height:24px; }
.dsh-ccswitch-import-status-block { display:flex; flex-direction:column; gap:6px; }
.dsh-ccswitch-import-intro { margin:0; color:var(--dsw-alias-label-tertiary); font-size:14px; line-height:22px; }
.dsh-ccswitch-import-notice { margin:0; font-size:12px; line-height:18px; }
.dsh-ccswitch-import-notice.is-warn { color:var(--dsw-alias-state-warn-label); }
.dsh-ccswitch-import-notice.is-error { color:var(--dsw-alias-state-error-primary); }
.dsh-ccswitch-import-toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
.dsh-ccswitch-import-count { flex:1 1 auto; min-width:120px; color:var(--dsw-alias-label-tertiary); font-size:12px; line-height:18px; }
.dsh-ccswitch-import-search { box-sizing:border-box; flex:1 1 240px; min-width:200px; height:36px; padding:0 10px; border:.5px solid var(--dsw-alias-border-l3); border-radius:var(--dsw-radius-md); outline:none; background:0 0; color:var(--dsw-alias-label-primary); font:inherit; font-size:14px; }
.dsh-ccswitch-import-search::placeholder { color:var(--dsw-alias-label-tertiary); }
.dsh-ccswitch-import-search:focus-visible { border-color:var(--dsw-alias-border-l4); box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary)); }
.dsh-ccswitch-import-button { box-sizing:border-box; display:inline-flex; flex:none; justify-content:center; align-items:center; gap:4px; height:36px; padding:0 14px; border:.5px solid var(--dsw-alias-border-l3); border-radius:var(--dsw-radius-md); background:0 0; color:var(--dsw-alias-label-primary); font:inherit; font-size:14px; line-height:22px; cursor:pointer; }
.dsh-ccswitch-import-button:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover-solid); }
.dsh-ccswitch-import-button.is-primary { border:none; background:var(--dsw-alias-button-primary-fill); color:var(--dsw-alias-label-primary-foreground); }
.dsh-ccswitch-import-button.is-primary:hover:not(:disabled) { background:var(--dsw-alias-button-primary-hover); }
.dsh-ccswitch-import-button.is-danger { border:none; color:var(--dsw-alias-state-error-primary); }
.dsh-ccswitch-import-button.is-danger:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover-danger); }
.dsh-ccswitch-import-button.is-link { height:28px; padding:0 10px; border:none; color:var(--dsw-alias-label-tertiary); font-size:12px; line-height:18px; }
.dsh-ccswitch-import-button:disabled { cursor:default; opacity:.4; }
.dsh-ccswitch-import-button:focus-visible, .dsh-ccswitch-import-dynamic-summary:focus-visible, .dsh-ccswitch-import-check:focus-within { box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary)); outline:none; }
.dsh-ccswitch-import-progress { position:relative; padding-left:14px; color:var(--dsw-alias-label-secondary); font-size:12px; line-height:18px; }
.dsh-ccswitch-import-progress:before { content:''; position:absolute; left:0; top:6px; width:6px; height:6px; border-radius:50%; background:var(--dsw-alias-state-business-primary); animation:dsh-ccswitch-import-pulse 1.1s ease-in-out infinite; }
@keyframes dsh-ccswitch-import-pulse { 0%, 100% { opacity:.25 } 50% { opacity:1 } }
.dsh-ccswitch-import-group { display:flex; flex-direction:column; gap:8px; }
.dsh-ccswitch-import-group-head { display:flex; flex-wrap:wrap; align-items:center; gap:4px 8px; }
.dsh-ccswitch-import-group-title { flex:1 1 auto; color:var(--dsw-alias-label-secondary); font-size:12px; font-weight:500; line-height:18px; }
.dsh-ccswitch-import-rows { display:flex; flex-direction:column; gap:8px; max-height:360px; margin:0; padding:0; list-style:none; overflow-y:auto; }
.dsh-ccswitch-import-card { display:flex; flex-direction:column; gap:8px; padding:12px 14px; border:.5px solid var(--dsw-alias-settings-card-stroke); border-radius:var(--dsw-radius-xl); background:var(--dsw-alias-settings-card-fill); }
.dsh-ccswitch-import-row-head { display:flex; align-items:center; gap:8px; min-width:0; }
.dsh-ccswitch-import-check { display:inline-flex; align-items:center; gap:8px; min-width:0; border-radius:var(--dsw-radius-sm); cursor:pointer; }
.dsh-ccswitch-import-check input { flex:none; width:16px; height:16px; margin:0; accent-color:var(--dsw-alias-state-business-primary); cursor:pointer; }
.dsh-ccswitch-import-name { min-width:0; overflow:hidden; font-size:14px; font-weight:500; line-height:22px; text-overflow:ellipsis; white-space:nowrap; }
.dsh-ccswitch-import-tag { flex:none; padding:1px 6px; border:.5px solid var(--dsw-alias-border-l3); border-radius:var(--dsw-radius-xs); color:var(--dsw-alias-label-secondary); font-size:11px; line-height:16px; }
.dsh-ccswitch-import-row-actions { display:inline-flex; align-items:center; gap:4px; margin-left:auto; }
.dsh-ccswitch-import-row-actions .dsh-ccswitch-import-button { height:28px; padding:0 10px; font-size:12px; line-height:18px; }
.dsh-ccswitch-import-status { display:flex; align-items:center; gap:6px; margin:0; color:var(--dsw-alias-label-tertiary); font-size:12px; line-height:18px; }
.dsh-ccswitch-import-status.is-warn { color:var(--dsw-alias-state-warn-label); }
.dsh-ccswitch-import-status.is-error { color:var(--dsw-alias-state-error-primary); }
.dsh-ccswitch-import-dot { flex:none; width:8px; height:8px; border-radius:50%; background:var(--dsw-alias-state-success-primary); }
.dsh-ccswitch-import-dot.is-missing { background:var(--dsw-alias-state-error-primary); }
.dsh-ccswitch-import-dynamic { display:flex; flex-direction:column; gap:8px; }
.dsh-ccswitch-import-dynamic-summary { display:flex; align-items:center; gap:6px; padding:2px 0; border-radius:var(--dsw-radius-sm); color:var(--dsw-alias-label-secondary); font-size:12px; line-height:18px; list-style:none; cursor:pointer; }
.dsh-ccswitch-import-dynamic-summary::-webkit-details-marker { display:none; }
.dsh-ccswitch-import-dynamic-summary:before { content:''; flex:none; width:5px; height:5px; border-bottom:1.5px solid currentColor; border-right:1.5px solid currentColor; transform:rotate(-45deg); transition:transform .15s ease; }
.dsh-ccswitch-import-dynamic[open] > .dsh-ccswitch-import-dynamic-summary:before { transform:rotate(45deg); }
.dsh-ccswitch-import-feedback { display:flex; flex-direction:column; gap:6px; }
.dsh-ccswitch-import-feedback-head { margin:0; color:var(--dsw-alias-label-secondary); font-size:12px; font-weight:500; line-height:18px; }
.dsh-ccswitch-import-feedback ul { display:flex; flex-direction:column; gap:4px; margin:0; padding:0; list-style:none; }
.dsh-ccswitch-import-feedback li { position:relative; padding-left:14px; color:var(--dsw-alias-label-secondary); font-size:12px; line-height:18px; }
.dsh-ccswitch-import-feedback li:before { content:''; position:absolute; left:0; top:6px; width:6px; height:6px; border-radius:50%; background:var(--dsw-alias-state-success-primary); }
.dsh-ccswitch-import-feedback li.is-warn:before { background:var(--dsw-alias-state-warn-label); }
.dsh-ccswitch-import-feedback li.is-error { color:var(--dsw-alias-state-error-primary); }
.dsh-ccswitch-import-feedback li.is-error:before { background:var(--dsw-alias-state-error-primary); }
.dsh-ccswitch-card { display:flex; align-items:center; flex-wrap:wrap; gap:6px 8px; }
.dsh-ccswitch-card-badge { flex:none; padding:1px 6px; border:.5px solid var(--dsw-alias-border-l3); border-radius:var(--dsw-radius-xs); color:var(--dsw-alias-label-secondary); font-size:11px; line-height:16px; }
.dsh-ccswitch-card-note { flex:1 1 200px; min-width:0; margin:0; color:var(--dsw-alias-label-tertiary); font-size:12px; line-height:18px; }
.dsh-ccswitch-card-link { flex:none; height:28px; padding:0 10px; border:none; border-radius:var(--dsw-radius-sm); background:0 0; color:var(--dsw-alias-label-tertiary); font:inherit; font-size:12px; line-height:18px; cursor:pointer; }
.dsh-ccswitch-card-link:hover { background:var(--dsw-alias-interactive-bg-hover-solid); color:var(--dsw-alias-label-primary); }
.dsh-ccswitch-card-link:focus-visible { box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary)); outline:none; }
.dsh-ccswitch-flash { animation:dsh-ccswitch-flash 1.4s ease-out 1; }
@keyframes dsh-ccswitch-flash { 0%, 100% { box-shadow:0 0 0 0 transparent } 15% { box-shadow:0 0 0 2px var(--dsw-alias-state-business-primary) } }
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
  slots: Pick<SlotCore, 'register'> & { inject(name: SeatName, callback: () => (() => void)): void }
  remote: TypertClientRemote & { ccswitch: ImportRemote }
}

export const inject: readonly string[] = ['slots', 'remote']

/**
 * What the panel and the badge receive when the Remote contribution could not
 * be mounted. Every method rejects with one explanation, and the panel already
 * renders a read failure as a notice — so a wiring fault degrades into a
 * visible message instead of taking the whole section down with it.
 */
const UNAVAILABLE = 'CC Switch 远程接口没有挂载成功，导入面板暂时不可用。请完全退出并重启 DSH 后重试；若仍然如此，请把这条消息与日志一起反馈。'
const unavailableRemote: ImportRemote = {
  list: async () => { throw new Error(UNAVAILABLE) },
  refresh: async () => { throw new Error(UNAVAILABLE) },
  importProviders: async () => { throw new Error(UNAVAILABLE) },
  resync: async () => { throw new Error(UNAVAILABLE) },
  refreshKey: async () => { throw new Error(UNAVAILABLE) },
  removeProviders: async () => { throw new Error(UNAVAILABLE) },
}

export function apply(ctx: ClientContext): void {
  const style = document.createElement('style')
  style.dataset.plugin = PACKAGE_ID
  style.textContent = styles
  document.head.append(style)

  ctx.effect(() => () => style.remove(), 'dsh-ccswitch: model search styles')
  ctx.effect(() => installModelSearch(), 'dsh-ccswitch: model name search')

  // The seats read this indirection instead of `ctx.remote.ccswitch` directly.
  // A slot's `inject` provider is evaluated on every render, so a stable object
  // that swaps its target keeps the seats working (and honest about why they
  // are empty) across a late or failed Remote mounting.
  let active: ImportRemote = unavailableRemote
  const remote: ImportRemote = {
    list: (...args) => active.list(...args),
    refresh: (...args) => active.refresh(...args),
    importProviders: (...args) => active.importProviders(...args),
    resync: (...args) => active.resync(...args),
    refreshKey: (...args) => active.refreshKey(...args),
    removeProviders: (...args) => active.removeProviders(...args),
  }
  const inject = () => ({ remote })

  // Registration happens BEFORE the Remote is mounted, and synchronously.
  // `ctx.slots.inject` only replays its callback when the seat is declared, so
  // calling it here is safe at any time; doing it after `await $mount` used to
  // mean that a single bad descriptor (or any other mounting failure) silently
  // removed both the panel and the card badge from the UI.
  ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
    name: 'settings.models.footer', id: PACKAGE_ID, order: 20, inject,
  }, ImportPanel))
  // One keyed registration covers every llm-pi-ai card: the seat dispatches on
  // the settings namespace, so the badge filters per provider itself.
  ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
    name: 'settings.models.provider-card', key: IMPORT_NAMESPACE, inject,
  }, ProviderCardExtras))

  ctx.effect(async () => {
    const disposeRemote = await ctx.remote.$mount(importRemoteContribution)
    active = ctx.remote.ccswitch
    return () => {
      active = unavailableRemote
      return disposeRemote()
    }
  }, 'dsh-ccswitch: native model import remote')
}
