import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { CcSwitchImporter } from './importer.ts'
import type { ImportOutcome, ImportView } from './import-contract.ts'

const initializers: Array<(this: CcSwitchImportController) => void> = []

export class CcSwitchImportController extends TypertRemoteService {
  constructor(ctx: Context, private readonly importer: CcSwitchImporter) {
    super(ctx, 'ccswitch')
    for (const initialize of initializers) initialize.call(this)
  }
  list(): Promise<ImportView> { return this.importer.list() }
  refresh(providers: unknown, signal: AbortSignal): Promise<ImportView> {
    return this.importer.refresh(providers, signal)
  }
  importProviders(providers: unknown, signal: AbortSignal): Promise<ImportOutcome[]> {
    return this.importer.importProviders(providers, signal)
  }
  resync(providers: unknown, signal: AbortSignal): Promise<ImportOutcome[]> {
    return this.importer.resync(providers, signal)
  }
  remove(providers: unknown, signal: AbortSignal): Promise<ImportOutcome[]> {
    return this.importer.remove(providers, signal)
  }
}

// Invoke the public standard decorator API explicitly, keeping source-mode
// tests usable with Node's type stripping (which cannot parse decorators).
for (const name of ['list', 'refresh', 'importProviders', 'resync', 'remove'] as const) {
  Remote<CcSwitchImportController, never[], unknown>(CcSwitchImportController.prototype[name], {
    kind: 'method', name, static: false, private: false,
    access: {
      has: (instance: CcSwitchImportController) => name in instance,
      get: (instance: CcSwitchImportController) => instance[name],
    },
    metadata: undefined,
    addInitializer: initializer => initializers.push(initializer),
  })
}
