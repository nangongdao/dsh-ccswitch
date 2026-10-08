import { createHash } from 'node:crypto'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { SettingsDescriptor, SettingsForms } from '@deepseek-ai/dsh-settings'
import { modelForRoute } from './provider.ts'
import type { CcSwitchCredential, CcSwitchModel, CcSwitchRoute } from './types.ts'
import type { ImportOutcome, ImportRow, ImportView } from './import-contract.ts'

const NS = 'llm-pi-ai'
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
function profiles(view: SettingsDescriptor): Record<string, unknown> { return record(record(view.value).providers) }
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
export function hasNativeImport(settings: Pick<SettingsForms, 'describe'> | undefined, route: CcSwitchRoute): boolean {
  const view = settings?.describe({ redactSecrets: true }).find(row => row.ns === NS)
  return view !== undefined && own(profiles(view), importedProviderId(route))
}
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
  constructor(private readonly deps: ImportDependencies) {}
  private native(): SettingsDescriptor | undefined {
    return this.deps.settings.describe({ redactSecrets: true }).find(row => row.ns === NS)
  }
  list(): ImportView {
    const native = this.native()
    const supported = native === undefined ? [] : protocols(native)
    return {
      available: native !== undefined,
      writable: this.deps.settings.writable,
      rows: this.deps.routes().map(route => {
        const targetProvider = importedProviderId(route)
        const imported = native !== undefined && own(profiles(native), targetProvider)
        const reason = imported ? '已导入，由 DSH 独立管理；不会自动覆盖。'
          : route.authKind !== 'api-key' ? 'OAuth/登录令牌保持 CC Switch 动态连接，不复制短期令牌。'
          : native === undefined ? '需要启用 DSH 的 llm-pi-ai 原生模型适配器。'
          : !supported.includes(route.protocol) ? '当前 DSH 原生适配器不支持此协议，保持插件动态连接。'
          : !this.deps.settings.writable ? '当前 DSH 配置为只读。' : ''
        return {
          provider: route.provider, targetProvider, name: route.name, appType: route.appType,
          protocol: route.protocol, models: this.deps.models(route).length,
          discovery: this.deps.discovery(route.provider), imported,
          eligible: reason === '', reason,
        }
      }),
    }
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
  async refresh(providers: unknown, signal: AbortSignal): Promise<ImportView> {
    const ids = this.validate(providers)
    // Refresh is advisory and independent from the persistent import operation.
    for (let offset = 0; offset < ids.length; offset += 4) {
      signal.throwIfAborted()
      await Promise.all(ids.slice(offset, offset + 4).map(async id => {
        const route = this.deps.routes().find(candidate => candidate.provider === id)
        if (route !== undefined) await this.deps.refresh(route, signal)
      }))
    }
    return this.list()
  }
  async importProviders(providers: unknown, signal: AbortSignal): Promise<ImportOutcome[]> {
    const ids = this.validate(providers)
    if (this.busy) throw new Error('导入正在进行，请稍后重试。')
    this.busy = true
    const outcomes: ImportOutcome[] = []
    try {
      for (const id of ids) {
        signal.throwIfAborted()
        const row = this.list().rows.find(candidate => candidate.provider === id)
        if (row === undefined || !row.eligible) {
          outcomes.push({ provider: id, status: 'skipped', message: row?.reason ?? '供应商已移除。' })
          continue
        }
        outcomes.push(await this.importOne(id, signal))
      }
      return outcomes
    } finally { this.busy = false }
  }
  private async importOne(id: string, signal: AbortSignal): Promise<ImportOutcome> {
    let writtenKey: { ref: ReturnType<typeof credentialRef>; value: string } | undefined
    let profileCommitted = false
    try {
      const route = this.deps.routes().find(candidate => candidate.provider === id)
      if (route === undefined) throw new Error('source changed')
      const native = this.native()
      if (native === undefined || !this.deps.settings.writable) throw new Error('settings unavailable')
      const target = importedProviderId(route)
      if (own(profiles(native), target)) return { provider: id, status: 'skipped', message: '已导入，保留 DSH 现有配置。' }
      const ref = credentialRef(`${target.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`)
      // Never overwrite an unrelated, shadowed, or previously imported secret.
      const state = await this.deps.credentials.describe(ref)
      if (state.configured || !state.writable) throw new Error('credential occupied or read-only')
      const credential = await this.deps.credential(route)
      const token = credential.token
      if (token === undefined || !/^[\x21-\x7E]+$/.test(token)) throw new Error('invalid credential')
      const models = this.deps.models(route)
      const profile = {
        displayName: `CC Switch · ${route.appType === 'claude' ? 'Claude' : route.appType === 'codex' ? 'Codex' : 'Gemini'} · ${route.name}`,
        api: route.protocol, baseURL: route.baseURL, apiKeyEnv: ref,
        models: models.map(model => {
          const pi = modelForRoute({ ...route, models }, model.id)
          return {
            id: model.id, name: model.name, contextWindow: model.contextWindow, maxTokens: model.maxTokens,
            input: pi?.input ?? ['text'], reasoningEfforts: nativeReasoningEfforts(pi?.thinkingLevelMap),
          }
        }),
      }
      signal.throwIfAborted()
      const current = this.deps.routes().find(candidate => candidate.provider === id)
      if (current?.fingerprint !== route.fingerprint) throw new Error('source changed')
      await this.deps.credentials.set(ref, token)
      writtenKey = { ref, value: token }
      // Use a revisioned path write, not a wholesale replacement. Existing native
      // providers and credentials never cross this import's write set.
      signal.throwIfAborted()
      await this.deps.settings.mutate(NS, [{ op: 'set', path: ['providers', target], value: profile }], native.revision)
      profileCommitted = true
      this.deps.changed()
      return { provider: id, status: 'imported', message: `已导入 ${models.length} 个模型；后续在上方原生供应商卡片中编辑。` }
    } catch {
      // Do not reflect credential/HTTP exceptions to the browser or logs.
      if (writtenKey !== undefined && !profileCommitted) {
        try {
          const current = await this.deps.credentials.resolve(writtenKey.ref)
          if (current?.value === writtenKey.value) await this.deps.credentials.unset(writtenKey.ref)
        } catch {
          return { provider: id, status: 'failed', message: '导入未完成，清理临时凭据失败；请检查 DSH 凭据存储后重试。' }
        }
      }
      return { provider: id, status: 'failed', message: '导入未完成：请检查源 API Key、DSH 写入权限或配置冲突，然后刷新重试。' }
    }
  }
}
