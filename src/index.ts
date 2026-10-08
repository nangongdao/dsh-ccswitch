import type { Context } from '@deepseek-ai/cordis'
import { resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type { AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm'
// Loads the `ctx.fs` augmentation without importing a value.
import type {} from '@deepseek-ai/dsh-fs'
import { CcSwitchAdapter } from './adapter.ts'
import { resolveCredential } from './auth.ts'
import { CcSwitchRepository } from './database.ts'
import { discoverRouteModels } from './discovery.ts'

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

  const syncRegistration = (): void => {
    const routes = repository.current.routes.map(route => route.provider)
    if (routes.length === 0) {
      if (registration !== undefined && registeredRoutes.length > 0) {
        registration.replace([])
        registeredRoutes = []
      }
      return
    }
    if (registration === undefined) {
      registration = ctx.llm.registerAdapter([...routes], adapter)
    } else if (routes.join('\n') !== registeredRoutes.join('\n')) {
      registration.replace([...routes])
    }
    registeredRoutes = routes
  }

  const discover = async (): Promise<void> => {
    if (!repository.config.discoverModels || refreshing) return
    refreshing = true
    const source = repository.current
    try {
      for (const route of source.routes) {
        try {
          const credential = await resolveCredential(route, repository)
          const models = await discoverRouteModels(route, credential)
          const current = repository.current.routes.find(candidate => candidate.provider === route.provider)
          if (current?.fingerprint === route.fingerprint) adapter.setDiscoveredModels(route.provider, models)
        } catch (error: unknown) {
          // Discovery is advisory. The configured/default model remains
          // available when an endpoint is private, offline, or OAuth-expired.
          ctx.logger.debug(`dsh-ccswitch: model discovery skipped for ${route.provider}: ${describeError(error)}`)
        }
      }
    } finally {
      refreshing = false
      lastDiscoveryAt = Date.now()
    }
  }

  const poll = (): void => {
    try {
      if (!repository.exists()) return
      const changed = repository.read()
      if (changed) adapter.clearDiscoveredModels()
      syncRegistration()
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
