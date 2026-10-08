import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import * as nativePath from 'node:path'

export interface PathOperations {
  dirname(path: string): string
  join(...paths: string[]): string
}

/** Minimal filesystem surface used to locate the CC Switch data directory. */
export interface PathProbe {
  /** True when the path exists and is a directory. */
  isDirectory(path: string): boolean
  /** File contents, or undefined when the file cannot be read. */
  readText(path: string): string | undefined
}

export interface CcSwitchPaths {
  readonly database: string
  readonly providerSelection: string
  readonly codexOAuthStore: string
  readonly codexAuth: string
  readonly geminiOAuthCredentials: string
}

/** Tauri application identifier of CC Switch, which is also its settings directory name. */
const CC_SWITCH_APP_ID = 'com.ccswitch.desktop'
const CC_SWITCH_APP_PATHS = 'app_paths.json'
const CC_SWITCH_DATABASE = 'cc-switch.db'
/** Key CC Switch writes when the user relocates its data directory. */
const CC_SWITCH_DATA_DIR_KEY = 'app_config_dir_override'

const nativeProbe: PathProbe = {
  isDirectory(path) {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  },
  readText(path) {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return undefined
    }
  },
}

/**
 * Per-user settings directories the host platform uses for a Tauri application
 * with CC Switch's identifier: Windows roaming app data, the XDG config home,
 * and the macOS application support directory. All three are probed because
 * only one of them exists on a real machine, which keeps this platform-neutral.
 */
function ccSwitchSettingsDirs(home: string, paths: PathOperations): string[] {
  return [
    paths.join(home, 'AppData', 'Roaming', CC_SWITCH_APP_ID),
    paths.join(home, '.config', CC_SWITCH_APP_ID),
    paths.join(home, 'Library', 'Application Support', CC_SWITCH_APP_ID),
  ]
}

function isAbsolute(path: string): boolean {
  return nativePath.win32.isAbsolute(path) || nativePath.posix.isAbsolute(path)
}

/**
 * Read `app_config_dir_override` from CC Switch's own `app_paths.json`.
 *
 * CC Switch relocates its entire data directory when the user picks a custom
 * folder, so the live `cc-switch.db` can sit far from `~/.cc-switch` while a
 * stale copy remains there. The override names a directory, and CC Switch
 * itself falls back to its default location when that directory is gone; this
 * mirrors both rules exactly rather than second-guessing a half-migrated state.
 */
function configuredDataDirectory(
  home: string,
  paths: PathOperations,
  probe: PathProbe,
): string | undefined {
  for (const directory of ccSwitchSettingsDirs(home, paths)) {
    const raw = probe.readText(paths.join(directory, CC_SWITCH_APP_PATHS))
    if (raw === undefined) continue
    let override: unknown
    try {
      override = (JSON.parse(raw.replace(/^\uFEFF/, '')) as Record<string, unknown>)[CC_SWITCH_DATA_DIR_KEY]
    } catch {
      continue
    }
    if (typeof override !== 'string') continue
    const candidate = override.trim()
    if (candidate.length === 0 || !isAbsolute(candidate)) continue
    if (probe.isDirectory(candidate)) return candidate
  }
  return undefined
}

/**
 * Resolve every user-level path with the host platform's path semantics.
 *
 * An explicit `database` always wins; otherwise the directory CC Switch records
 * in `app_paths.json` is used when it still exists, and `~/.cc-switch` is the
 * final fallback. The OAuth sidecar files follow whichever database directory wins.
 */
export function resolveCcSwitchPaths(
  home = homedir(),
  database: string | undefined = undefined,
  paths: PathOperations = nativePath,
  probe: PathProbe = nativeProbe,
): CcSwitchPaths {
  const resolvedDatabase = database ?? paths.join(
    configuredDataDirectory(home, paths, probe) ?? paths.join(home, '.cc-switch'),
    CC_SWITCH_DATABASE,
  )
  return {
    database: resolvedDatabase,
    providerSelection: paths.join(home, '.dsh', 'ccswitch-providers.json'),
    codexOAuthStore: paths.join(paths.dirname(resolvedDatabase), 'codex_oauth_auth.json'),
    codexAuth: paths.join(home, '.codex', 'auth.json'),
    geminiOAuthCredentials: paths.join(home, '.gemini', 'oauth_creds.json'),
  }
}
