import type { InvocationDescriptor, RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'

export interface ImportRow {
  provider: string
  targetProvider: string
  name: string
  appType: string
  protocol: string
  models: number
  discovery: 'configured' | 'pending' | 'remote' | 'failed'
  imported: boolean
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
  status: 'imported' | 'skipped' | 'failed'
  message: string
}
export interface ImportRemote {
  list(): Promise<RemoteResult<ImportView>>
  refresh(providers: string[]): Promise<RemoteResult<ImportView>>
  importProviders(providers: string[]): Promise<RemoteResult<ImportOutcome[]>>
}

// Public SRC-mode descriptors: the Host still validates every business input
// and projects every output. No secrets are part of this wire contract.
const descriptor = (method: string, parameters: string[], cancellable = false): InvocationDescriptor => ({
  id: `src:ccswitch#ccswitch/${method}`,
  service: 'ccswitch',
  namespace: 'ccswitch',
  method,
  invocation: { kind: 'direct' },
  parameters: parameters.map(name => ({ name, wire: name, source: 'json', codec: { mode: 'src-json' } })),
  ...(cancellable ? { cancellation: { parameter: 'signal' as const } } : {}),
  result: { mode: 'src-json' },
})
export const importRemoteContribution: TypertRemoteContribution = {
  package: 'dsh-ccswitch',
  descriptors: [descriptor('list', []), descriptor('refresh', ['providers'], true), descriptor('importProviders', ['providers'], true)],
}
