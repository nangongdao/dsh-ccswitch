import { createHash } from 'node:crypto'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { SettingsDescriptor, SettingsForms } from '@deepseek-ai/dsh-settings'
import { modelForRoute } from './provider.ts'
import type { CcSwitchCredential, CcSwitchModel, CcSwitchRoute } from './types.ts'
import type { ImportOutcome, ImportRow, ImportView } from './import-contract.ts'

const NS = 'llm-pi-ai'
const BUSY = '另一个导入操作正在进行，请稍后重试。'
const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key)
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
/**
 * Translate the pi-ai thinking level map into the native profile's
 * `reasoningEfforts`. The native schema rejects a `null` wire value on every
 * level except `off` (a null there means "supported, send nothing"), while the
 * dynamic pi-ai map uses null to pin a level as unsupported. A model left with
 * no level beyond `off` is declared non-reasoning instead of an empty map,
 * which the native schema also rejects.
 */
export function nativeReasoningEfforts(map: unknown): Record<string, string | null> | false {
  const levels = record(map)
  const efforts: Record<string, string | null> = {}
  for (const [level, wire] of Object.entries(levels)) {
    if (typeof wire === 'string' && wire.length > 0) efforts[level] = wire
    else if (wire === null && level === 'off') efforts.off = null
  }
  return Object.keys(efforts).some(level => level !== 'off') ? efforts : false
}
export function importedProviderId(route: Pick<CcSwitchRoute, 'provider' | 'appType'>): string {
  const hash = createHash('sha256').update(route.provider).digest('hex').slice(0, 24)
  return `ccswitch-${route.appType}-${hash}`
}
const appLabel = (appType: string): string => appType === 'claude' ? 'Claude' : appType === 'codex' ? 'Codex' : appType === 'gemini' ? 'Gemini' : appType
function profiles(view: SettingsDescriptor): Record<string, unknown> { return record(record(view.value).providers) }
/** Model ids held by a DSH provider profile — the real catalog once a route is imported. */
function profileModelIds(profile: unknown): string[] {
  const models = record(profile).models
  return Array.isArray(models)
    ? models.map(entry => typeof entry === 'string' ? entry : String(record(entry).id ?? '')).filter(id => id !== '')
    : []
}
function protocols(view: SettingsDescriptor): string[] {
  const serialized = record(view.schema)
  const refs = record(serialized.refs)
  const node = (value: unknown): Record<string, unknown> => typeof value === 'number' ? record(refs[String(value)]) : record(value)
  const root = serialized.uid === undefined ? serialized : node(serialized.uid)
  const dict = record(root.dict)
  const provider = node(node(dict.providers).inner)
  const api = node(record(provider.dict).api)
  return Array.isArray(api.list) ? api.list.map(value => node(value).value).filter((value): value is string => typeof value === 'string') : []
}
/** The provider ids DSH already owns because of an earlier import. */
function ownedProviders(settings: Pick<SettingsForms, 'describe'> | undefined): Set<string> {
  const view = settings?.describe({ redactSecrets: true }).find(row => row.ns === NS)
  return new Set(view === undefined ? [] : Object.keys(profiles(view)))
}
export function hasNativeImport(settings: Pick<SettingsForms, 'describe'> | undefined, route: CcSwitchRoute): boolean {
  return ownedProviders(settings).has(importedProviderId(route))
}
/**
 * The routes this plugin should still offer as dynamic providers. An imported
 * route is DSH's own provider now, so offering it here as well would list the
 * same route twice in the model picker with different model snapshots. Only an
 * API-key route can be imported, so this never hides an OAuth route.
 */
export function dynamicRoutes(
  routes: readonly CcSwitchRoute[],
  settings: Pick<SettingsForms, 'describe'> | undefined,
): CcSwitchRoute[] {
  const owned = ownedProviders(settings)
  return owned.size === 0 ? [...routes] : routes.filter(route => !owned.has(importedProviderId(route)))
}
/** The DSH-owned credential reference a route's imported provider stores in `apiKeyEnv`. */
function keyRefFor(target: string): ReturnType<typeof credentialRef> {
  return credentialRef(`${target.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`)
}
/**
 * A row plus the two facts the write path needs: whether the interface model
 * list may still be fetched, and whether the row can be written at all.
 */
interface Inspection { row: ImportRow; refreshable: boolean }
export interface ImportDependencies {
  settings: Pick<SettingsForms, 'describe' | 'mutate' | 'writable'>
  credentials: Pick<CredentialProvider, 'describe' | 'set' | 'resolve' | 'unset'>
  routes(): readonly CcSwitchRoute[]
  models(route: CcSwitchRoute): readonly CcSwitchModel[]
  discovery(provider: string): ImportRow['discovery']
  credential(route: CcSwitchRoute): Promise<CcSwitchCredential>
  refresh(route: CcSwitchRoute, signal: AbortSignal): Promise<void>
  changed(): void
}
export class CcSwitchImporter {
  private busy = false
  /**
   * What this plugin last wrote for each imported provider. It is what makes a
   * model that disappeared upstream distinguishable from one the user added by
   * hand, without storing anything extra in DSH settings. It is intentionally
   * per-process: after a restart nothing is dropped, only kept.
   */
  private readonly lastCatalog = new Map<string, Set<string>>()
  constructor(private readonly deps: ImportDependencies) {}
  private native(): SettingsDescriptor | undefined {
    return this.deps.settings.describe({ redactSecrets: true }).find(row => row.ns === NS)
  }
  private route(id: string): CcSwitchRoute | undefined {
    return this.deps.routes().find(candidate => candidate.provider === id)
  }
  /** Pure read: no await, no network. `importProviders` re-runs it after refreshing. */
  private inspect(route: CcSwitchRoute, native: SettingsDescriptor | undefined, supported: readonly string[]): Inspection {
    const targetProvider = importedProviderId(route)
    const owned = native === undefined ? undefined : profiles(native)[targetProvider]
    const imported = owned !== undefined
    const found = this.deps.models(route)
    // Once imported, DSH owns the catalog: report what DSH will actually offer,
    // not what CC Switch happens to list today.
    const ids = imported ? profileModelIds(owned) : found.map(model => model.id)
    const models = ids.length
    const writable = this.deps.settings.writable
    const dynamicOnly = route.authKind !== 'api-key'
    const unsupported = native !== undefined && !supported.includes(route.protocol)
    const refreshable = !imported && !dynamicOnly && native !== undefined && writable && !unsupported
    const reason = imported ? '已导入：模型里只保留这一份，CC Switch 的改动不会覆盖它。'
      : dynamicOnly ? 'OAuth/登录令牌保持 CC Switch 动态连接，不复制短期令牌。'
      : native === undefined ? '需要先在 DSH 中启用 llm-pi-ai 原生模型适配器。'
      : unsupported ? '当前 DSH 原生适配器不支持此协议，保持插件动态连接。'
      : !writable ? '当前 DSH 配置为只读，无法写入供应商。'
      : models === 0 ? '该线路还没有可用模型：请先「读取模型列表」，或检查接口地址与密钥。'
      : ''
    return {
      row: {
        provider: route.provider, targetProvider, name: route.name, appType: route.appType,
        protocol: route.protocol, models, sample: ids.slice(0, 3),
        discovery: this.deps.discovery(route.provider),
        imported, eligible: reason === '', reason,
      },
      refreshable,
    }
  }
  private inspections(): { available: boolean; writable: boolean; items: Inspection[] } {
    const native = this.native()
    const supported = native === undefined ? [] : protocols(native)
    return {
      available: native !== undefined,
      writable: this.deps.settings.writable,
      items: this.deps.routes().map(route => this.inspect(route, native, supported)),
    }
  }
  async list(): Promise<ImportView> {
    const { available, writable, items } = this.inspections()
    const rows: ImportRow[] = []
    for (const { row } of items) {
      if (row.imported) row.credential = await this.credentialState(row.targetProvider)
      rows.push(row)
    }
    return { available, writable, rows }
  }
  /**
   * Whether the key an imported provider writes is still present. A missing key
   * is the one failure a user cannot see from the provider card, so it is
   * reported instead of assumed.
   */
  private async credentialState(target: string): Promise<'configured' | 'missing'> {
    try {
      const state = await this.deps.credentials.describe(keyRefFor(target))
      return state.configured ? 'configured' : 'missing'
    } catch { return 'missing' }
  }
  private validate(providers: unknown): string[] {
    if (!Array.isArray(providers) || providers.length === 0 || providers.length > 128
      || providers.some(value => typeof value !== 'string' || value.length > 512)) {
      throw new Error('请选择 1–128 个 CC Switch 供应商。')
    }
    const ids = [...new Set(providers as string[])]
    const current = new Set(this.deps.routes().map(route => route.provider))
    if (ids.some(id => !current.has(id))) throw new Error('供应商已变化，请重新读取 CC Switch 后再操作。')
    return ids
  }
  /**
   * Fetch the interface model list for the given routes, four at a time. A
   * route's own failure is already recorded by the discovery layer, so it does
   * not abort the batch; cancellation does.
   */
  private async fetchModels(ids: readonly string[], signal: AbortSignal): Promise<void> {
    for (let offset = 0; offset < ids.length; offset += 4) {
      signal.throwIfAborted()
      await Promise.all(ids.slice(offset, offset + 4).map(async id => {
        const route = this.route(id)
        if (route === undefined) return
        try { await this.deps.refresh(route, signal) } catch { signal.throwIfAborted() }
      }))
    }
  }
  async refresh(providers: unknown, signal: AbortSignal): Promise<ImportView> {
    const ids = this.validate(providers)
    await this.fetchModels(ids, signal)
    return this.list()
  }
  async importProviders(providers: unknown, signal: AbortSignal): Promise<ImportOutcome[]> {
    const ids = this.validate(providers)
    if (this.busy) throw new Error(BUSY)
    this.busy = true
    try {
      // Importing may be the user's very first action: fetch the interface model
      // list for routes that only have a configured one, so a single click still
      // produces a full catalog.
      const items = this.inspections().items
      const stale = ids.filter(id => items.find(item => item.row.provider === id)?.refreshable === true
        && items.find(item => item.row.provider === id)?.row.discovery !== 'remote')
      if (stale.length > 0) await this.fetchModels(stale, signal)
      const outcomes: ImportOutcome[] = []
      for (const id of ids) {
        signal.throwIfAborted()
        const route = this.route(id)
        if (route === undefined) {
          outcomes.push({ provider: id, status: 'skipped', message: '供应商已移除，请重新读取。' })
          continue
        }
        const native = this.native()
        const { row } = this.inspect(route, native, native === undefined ? [] : protocols(native))
        if (!row.eligible) {
          outcomes.push({ provider: id, status: 'skipped', message: row.reason })
          continue
        }
        outcomes.push(await this.importOne(route, native, signal))
      }
      return outcomes
    } finally { this.busy = false }
  }
  private profileModels(route: CcSwitchRoute, models: readonly CcSwitchModel[]): Record<string, unknown>[] {
    return models.map(model => {
      const pi = modelForRoute({ ...route, models: [...models] }, model.id)
      return {
        id: model.id, name: model.name, contextWindow: model.contextWindow, maxTokens: model.maxTokens,
        input: pi?.input ?? ['text'], reasoningEfforts: nativeReasoningEfforts(pi?.thinkingLevelMap),
      }
    })
  }
  private profile(route: CcSwitchRoute, models: readonly CcSwitchModel[], ref: ReturnType<typeof credentialRef>): Record<string, unknown> {
    return {
      displayName: `CC Switch · ${appLabel(route.appType)} · ${route.name}`,
      api: route.protocol, baseURL: route.baseURL, apiKeyEnv: ref,
      models: this.profileModels(route, models),
    }
  }
  private async importOne(route: CcSwitchRoute, native: SettingsDescriptor | undefined, signal: AbortSignal): Promise<ImportOutcome> {
    const id = route.provider
    if (native === undefined || !this.deps.settings.writable) return { provider: id, status: 'skipped', message: '当前 DSH 无法写入原生供应商。' }
    const target = importedProviderId(route)
    if (own(profiles(native), target)) return { provider: id, status: 'skipped', message: '已导入，保留 DSH 现有配置；同步模型请用「更新模型」。' }
    const ref = keyRefFor(target)
    // Never overwrite a secret this import does not own.
    let state: { configured: boolean; writable: boolean }
    try { state = await this.deps.credentials.describe(ref) } catch {
      return { provider: id, status: 'failed', message: '无法读取 DSH 凭据存储，导入未开始。' }
    }
    if (state.configured) return { provider: id, status: 'skipped', message: '目标密钥条目已被占用，未做任何修改。' }
    if (!state.writable) return { provider: id, status: 'skipped', message: 'DSH 凭据存储为只读，无法写入密钥。' }
    const models = this.deps.models(route)
    if (models.length === 0) return { provider: id, status: 'skipped', message: '该线路还没有可用模型，未做任何修改。' }
    let token: string | undefined
    try { token = (await this.deps.credential(route)).token } catch { token = undefined }
    if (token === undefined || !/^[\x21-\x7E]+$/.test(token)) {
      return { provider: id, status: 'skipped', message: '没有读到可用的 API Key，请在 CC Switch 中确认该线路凭据。' }
    }
    let written: { ref: ReturnType<typeof credentialRef>; value: string } | undefined
    let committed = false
    try {
      signal.throwIfAborted()
      const current = this.route(id)
      if (current?.fingerprint !== route.fingerprint) return { provider: id, status: 'skipped', message: '线路在导入过程中发生变化，请重新读取后再试。' }
      await this.deps.credentials.set(ref, token)
      written = { ref, value: token }
      signal.throwIfAborted()
      // A revisioned path write: existing native providers and credentials never
      // cross this import's write set.
      await this.deps.settings.mutate(NS, [{ op: 'set', path: ['providers', target], value: this.profile(route, models, ref) }], native.revision)
      committed = true
      this.lastCatalog.set(target, new Set(models.map(model => model.id)))
      this.deps.changed()
      return { provider: id, status: 'imported', message: `已导入 ${models.length} 个模型；密钥已存入 DSH 凭据。` }
    } catch {
      // Never reflect credential or transport exceptions to the browser.
      if (written !== undefined && !committed) {
        try {
          const current = await this.deps.credentials.resolve(written.ref)
          if (current?.value === written.value) await this.deps.credentials.unset(written.ref)
        } catch {
          return { provider: id, status: 'failed', message: '导入未完成，且临时凭据未能清理；请检查 DSH 凭据存储后重试。' }
        }
      }
      return { provider: id, status: 'failed', message: '导入未完成：请检查源 API Key、DSH 写入权限或配置冲突，然后重试。' }
    }
  }
  async resync(providers: unknown, signal: AbortSignal): Promise<ImportOutcome[]> {
    const ids = this.validate(providers)
    if (this.busy) throw new Error(BUSY)
    this.busy = true
    try {
      // An explicit update always re-reads the interface list: stale models are
      // the whole reason the user clicked it.
      await this.fetchModels(ids, signal)
      const outcomes: ImportOutcome[] = []
      for (const id of ids) {
        signal.throwIfAborted()
        outcomes.push(await this.resyncOne(id, signal))
      }
      return outcomes
    } finally { this.busy = false }
  }
  private async resyncOne(id: string, signal: AbortSignal): Promise<ImportOutcome> {
    const route = this.route(id)
    if (route === undefined) return { provider: id, status: 'skipped', message: '供应商已移除，请重新读取。' }
    const native = this.native()
    if (native === undefined || !this.deps.settings.writable) return { provider: id, status: 'skipped', message: '当前 DSH 无法写入原生供应商。' }
    const target = importedProviderId(route)
    const existing = profiles(native)
    if (!own(existing, target)) return { provider: id, status: 'skipped', message: '尚未导入；请先导入该线路。' }
    const previous = record(existing[target])
    const models = this.deps.models(route)
    if (models.length === 0) return { provider: id, status: 'skipped', message: '接口没有返回模型，现有配置未改动。' }
    // Keep everything the user may have edited in the native card (headers,
    // compat, timeouts) and any model they added by hand. A model this plugin
    // wrote before and the interface no longer returns is the one thing dropped,
    // so a retired model does not linger and fail later.
    const written = this.lastCatalog.get(target)
    const kept = (Array.isArray(previous.models) ? previous.models : [])
      .map(record).filter(model => typeof model.id === 'string'
        && !models.some(candidate => candidate.id === model.id)
        && written?.has(model.id) !== true)
    const displayName = typeof previous.displayName === 'string' && !previous.displayName.startsWith('CC Switch · ')
      ? previous.displayName : `CC Switch · ${appLabel(route.appType)} · ${route.name}`
    const value = {
      ...previous,
      api: route.protocol, baseURL: route.baseURL, displayName,
      models: [...this.profileModels(route, models), ...kept],
    }
    try {
      signal.throwIfAborted()
      await this.deps.settings.mutate(NS, [{ op: 'set', path: ['providers', target], value }], native.revision)
      this.lastCatalog.set(target, new Set(models.map(model => model.id)))
      this.deps.changed()
      return {
        provider: id, status: 'updated',
        message: `已同步 ${models.length} 个模型${kept.length > 0 ? `，另有 ${kept.length} 个模型不在接口列表中，已原样保留` : ''}；密钥与其他设置未改动。`,
      }
    } catch {
      return { provider: id, status: 'failed', message: '更新未完成；现有配置仍可用，请稍后重试。' }
    }
  }
  async remove(providers: unknown, signal: AbortSignal): Promise<ImportOutcome[]> {
    const ids = this.validate(providers)
    if (this.busy) throw new Error(BUSY)
    this.busy = true
    try {
      const outcomes: ImportOutcome[] = []
      for (const id of ids) {
        signal.throwIfAborted()
        outcomes.push(await this.removeOne(id, signal))
      }
      return outcomes
    } finally { this.busy = false }
  }
  private async removeOne(id: string, signal: AbortSignal): Promise<ImportOutcome> {
    const route = this.route(id)
    if (route === undefined) return { provider: id, status: 'skipped', message: '供应商已移除，请重新读取。' }
    const native = this.native()
    if (native === undefined || !this.deps.settings.writable) return { provider: id, status: 'skipped', message: '当前 DSH 无法写入原生供应商。' }
    const target = importedProviderId(route)
    const existing = profiles(native)
    if (!own(existing, target)) return { provider: id, status: 'skipped', message: '尚未导入。' }
    const previous = record(existing[target])
    try {
      signal.throwIfAborted()
      await this.deps.settings.mutate(NS, [{ op: 'unset', path: ['providers', target] }], native.revision)
    } catch {
      return { provider: id, status: 'failed', message: '移除未完成；供应商仍在，请稍后重试。' }
    }
    // Provider first, credential second: an orphaned key is recoverable, while a
    // provider whose key vanished would silently break every request. Only the
    // reference this plugin derives is ever cleared: if the user repointed the
    // provider at their own key, that key is theirs to keep.
    const apiKeyEnv = typeof previous.apiKeyEnv === 'string' ? previous.apiKeyEnv : undefined
    const owned = String(keyRefFor(target))
    let failed = false
    try { await this.deps.credentials.unset(keyRefFor(target)) } catch { failed = true }
    const note = failed
      ? '；密钥条目未能自动清理，请在 DSH 凭据设置中手动删除。'
      : apiKeyEnv !== undefined && apiKeyEnv !== owned
        ? `；它改用密钥引用 ${apiKeyEnv}，那不是本插件写入的，已保留。`
        : apiKeyEnv === undefined ? '；它名下没有登记密钥条目。' : '，并清理了该线路写入的密钥条目。'
    this.deps.changed()
    return { provider: id, status: 'removed', message: `已从 DSH 移除${note}` }
  }
}
