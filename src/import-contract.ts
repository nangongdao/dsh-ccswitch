import type {
  InvocationDescriptor, RemoteResult, TypertRemoteContribution, TypertSchema,
} from '@deepseek-ai/dsh-typert-protocol'

export interface ImportRow {
  provider: string
  targetProvider: string
  name: string
  appType: string
  protocol: string
  models: number
  /**
   * A few model ids to orient the user before importing ("why does this route
   * only have one model?"). Truncated on purpose: the full catalog is the
   * provider card's job once the route is imported.
   */
  sample?: string[]
  discovery: 'configured' | 'pending' | 'remote' | 'failed'
  imported: boolean
  /** Only meaningful for imported routes: whether the written key is still there. */
  credential?: 'configured' | 'missing'
  eligible: boolean
  reason: string
}
export interface ImportView {
  available: boolean
  writable: boolean
  rows: ImportRow[]
}
export interface ImportOutcome {
  provider: string
  status: 'imported' | 'updated' | 'removed' | 'skipped' | 'failed'
  message: string
}
export interface ImportRemote {
  list(): Promise<RemoteResult<ImportView>>
  refresh(providers: string[]): Promise<RemoteResult<ImportView>>
  importProviders(providers: string[]): Promise<RemoteResult<ImportOutcome[]>>
  resync(providers: string[]): Promise<RemoteResult<ImportOutcome[]>>
  refreshKey(providers: string[]): Promise<RemoteResult<ImportOutcome[]>>
  remove(providers: string[]): Promise<RemoteResult<ImportOutcome[]>>
}

// Public descriptors: the Host still validates every business input and
// projects every output. No secrets are part of this wire contract.
/**
 * Strict codec for the one business input this contract takes. The Client's
 * `$mount` validator (`requireStrictInputs` -> `requireStrictCodec`) rejects
 * every parameter whose codec is not strict with
 * `client api: generated Remote … has no strict codec`, and that rejection
 * happens before any namespace is installed. A non-strict parameter therefore
 * does not degrade one method — it aborts the whole contribution, and every
 * statement after `await ctx.remote.$mount(...)` never runs. The Host decodes
 * through `codec.create().parse(value)`, so the factory has to be real even
 * though the Client itself never calls it.
 */
const PROVIDERS_CODEC = {
  mode: 'strict' as const,
  typeSymbol: 'dsh-ccswitch#ProviderIds',
  create: (): TypertSchema<string[]> => ({
    parse: (value: unknown): string[] => {
      if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
        throw new TypeError('expected an array of CC Switch provider ids')
      }
      return value as string[]
    },
  }),
}
const descriptor = (method: string, parameters: string[], cancellable = false): InvocationDescriptor => ({
  id: `src:ccswitch#ccswitch/${method}`,
  service: 'ccswitch',
  namespace: 'ccswitch',
  method,
  invocation: { kind: 'direct' },
  parameters: parameters.map(name => ({ name, wire: name, source: 'json', codec: PROVIDERS_CODEC })),
  ...(cancellable ? { cancellation: { parameter: 'signal' as const } } : {}),
  result: { mode: 'src-json' },
})
export const importRemoteContribution: TypertRemoteContribution = {
  package: 'dsh-ccswitch',
  descriptors: [
    descriptor('list', []),
    descriptor('refresh', ['providers'], true),
    descriptor('importProviders', ['providers'], true),
    descriptor('resync', ['providers'], true),
    descriptor('refreshKey', ['providers'], true),
    descriptor('remove', ['providers'], true),
  ],
}
