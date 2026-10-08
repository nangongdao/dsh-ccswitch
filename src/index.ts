import type { Context } from '@deepseek-ai/cordis'
import { resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type { AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm'
// Loads the `ctx.fs` augmentation without importing a value.
import type {} from '@deepseek-ai/dsh-fs'
import { CcSwitchAdapter } from './adapter.ts'
import { resolveCredential } from './auth.ts'
import { CcSwitchRepository } from './database.ts'
import { discoverRouteModels } from './discovery.ts'
import { CcSwitchImporter, dynamicRoutes } from './importer.ts'
import { CcSwitchImportController } from './import-controller.ts'
import type { ImportRow } from './import-contract.ts'
import type { CcSwitchRoute } from './types.ts'
import type { SettingsForms } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-credentials'

export const name = 'dsh-ccswitch'
export const inject = ['llm']
const DISCOVERY_RETRY_MS = 30_000

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function apply(ctx: Context): void {
  const repository = new CcSwitchRepository()
  const adapter = new CcSwitchAdapter(
    repository,
    () => ctx.get('attachments'),
    (attachments, ref) => resolveImageAttachmentAccess(
      attachments,
      hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath),
      ref,
    ),
  )
  let registration: AdapterRegistrationHandle | undefined
  let registeredRoutes: readonly string[] = []
  let refreshing = false
  let lastDiscoveryAt = 0

  const syncRegistration = (force = false): void => {
    // A route DSH imported stops being offered by this adapter: the same route
    // twice in the model picker is worse than a missing one.
    const routes = dynamicRoutes(repository.current.routes, ctx.get('settings')).map(route => route.provider)
    if (routes.length === 0) {
      if (registration !== undefined && registeredRoutes.length > 0) {
        registration.replace([])
        registeredRoutes = []
      }
      return
    }
    if (registration === undefined) {
      registration = ctx.llm.registerAdapter([...routes], adapter)
    } else if (force || routes.join('\n') !== registeredRoutes.join('\n')) {
      // DSH 0.2 caches the browser catalog until adapters-updated. Replacing
      // the same ids also republishes changed provider/model metadata.
      registration.replace([...routes])
    }
    registeredRoutes = routes
  }

  const lifetime = new AbortController()
  const states = new Map<string, ImportRow['discovery']>()
  const inFlight = new Map<string, Promise<void>>()
  ctx.effect(() => () => lifetime.abort(), 'dsh-ccswitch: discovery lifetime')

  const refreshRoute = (route: CcSwitchRoute, signal = lifetime.signal): Promise<void> => {
    const previous = inFlight.get(route.provider)
    if (previous !== undefined) return previous
    const pending = (async () => {
      states.set(route.provider, 'pending')
      try {
        const credential = await resolveCredential(route, repository)
        const models = await discoverRouteModels(route, credential, AbortSignal.any([signal, lifetime.signal]))
        const current = repository.current.routes.find(candidate => candidate.provider === route.provider)
        if (!lifetime.signal.aborted && current?.fingerprint === route.fingerprint) {
          states.set(route.provider, 'remote')
          if (adapter.setDiscoveredModels(route.provider, models)) syncRegistration(true)
        }
      } catch {
        const current = repository.current.routes.find(candidate => candidate.provider === route.provider)
        if (!lifetime.signal.aborted && current?.fingerprint === route.fingerprint) {
          states.set(route.provider, 'failed')
          ctx.logger.debug(`dsh-ccswitch: model discovery unavailable for ${route.provider}; configured models retained`)
        }
      }
    })().finally(() => { inFlight.delete(route.provider) })
    inFlight.set(route.provider, pending)
    return pending
  }
  const discover = async (): Promise<void> => {
    if (!repository.config.discoverModels || refreshing || lifetime.signal.aborted) return
    refreshing = true
    const source = repository.current
    try {
      let cursor = 0
      await Promise.all(Array.from({ length: Math.min(4, source.routes.length) }, async () => {
        while (!lifetime.signal.aborted) {
          const route = source.routes[cursor++]
          if (route === undefined) break
          await refreshRoute(route)
        }
      }))
    } finally {
      refreshing = false
      lastDiscoveryAt = Date.now()
    }
  }

  // Optional native integration: the existing bridge still works in headless
  // profiles without settings or a writable credential provider.
  ctx.inject(['settings', 'credentials'], child => {
    const importer = new CcSwitchImporter({
      settings: child.settings,
      credentials: child.credentials,
      routes: () => repository.current.routes,
      models: route => adapter.modelsForRoute(route),
      discovery: provider => states.get(provider) ?? 'configured',
      credential: route => resolveCredential(route, repository),
      refresh: refreshRoute,
      // Importing or removing a native provider moves that route between DSH
      // and this adapter, so the published catalog has to be republished.
      changed: () => syncRegistration(true),
    })
    child.plugin(CcSwitchImportController, importer)
    // Settings may arrive after startup, when the first registration already
    // published routes DSH had imported in an earlier session.
    syncRegistration(true)
  })

  const poll = (): void => {
    try {
      if (!repository.exists()) return
      const changed = repository.read()
      if (changed) {
        adapter.clearDiscoveredModels()
        states.clear()
      }
      syncRegistration(changed)
      if (changed || Date.now() - lastDiscoveryAt >= DISCOVERY_RETRY_MS) void discover()
    } catch (error: unknown) {
      ctx.logger.warn(`dsh-ccswitch: CC Switch configuration read failed: ${describeError(error)}`)
    }
  }

  try {
    if (repository.exists()) {
      repository.read()
      syncRegistration()
      lastDiscoveryAt = 0
      void discover()
    } else {
      ctx.logger.info(`dsh-ccswitch: CC Switch database not found at ${repository.config.dbPath}`)
    }
  } catch (error: unknown) {
    ctx.logger.warn(`dsh-ccswitch: initial provider discovery failed: ${describeError(error)}`)
  }

  ctx.effect(function* () {
    const timer = setInterval(poll, repository.config.pollIntervalMs)
    yield () => clearInterval(timer)
  })
}
