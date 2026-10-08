import assert from 'node:assert/strict'
import { posix, win32 } from 'node:path'
import test from 'node:test'
import { resolveCcSwitchPaths } from '../src/paths.ts'

/** Builds a probe over an in-memory tree: `dirs` are directories, `files` are file contents. */
function probeFor(dirs, files) {
  return {
    isDirectory: path => dirs.includes(path),
    readText: path => files[path],
  }
}

const EMPTY = probeFor([], {})

test('resolves macOS and Linux paths with POSIX separators', () => {
  assert.deepEqual(
    resolveCcSwitchPaths('/home/example', '/home/example/.cc-switch/cc-switch.db', posix, EMPTY),
    {
      database: '/home/example/.cc-switch/cc-switch.db',
      providerSelection: '/home/example/.dsh/ccswitch-providers.json',
      codexOAuthStore: '/home/example/.cc-switch/codex_oauth_auth.json',
      codexAuth: '/home/example/.codex/auth.json',
      geminiOAuthCredentials: '/home/example/.gemini/oauth_creds.json',
    },
  )
})

test('resolves Windows drive paths with win32 separators', () => {
  assert.deepEqual(
    resolveCcSwitchPaths('C:\\Users\\Example', undefined, win32, EMPTY),
    {
      database: 'C:\\Users\\Example\\.cc-switch\\cc-switch.db',
      providerSelection: 'C:\\Users\\Example\\.dsh\\ccswitch-providers.json',
      codexOAuthStore: 'C:\\Users\\Example\\.cc-switch\\codex_oauth_auth.json',
      codexAuth: 'C:\\Users\\Example\\.codex\\auth.json',
      geminiOAuthCredentials: 'C:\\Users\\Example\\.gemini\\oauth_creds.json',
    },
  )

  assert.deepEqual(
    resolveCcSwitchPaths('C:\\Users\\Example', 'D:\\CC Switch Data\\cc-switch.db', win32, EMPTY),
    {
      database: 'D:\\CC Switch Data\\cc-switch.db',
      providerSelection: 'C:\\Users\\Example\\.dsh\\ccswitch-providers.json',
      codexOAuthStore: 'D:\\CC Switch Data\\codex_oauth_auth.json',
      codexAuth: 'C:\\Users\\Example\\.codex\\auth.json',
      geminiOAuthCredentials: 'C:\\Users\\Example\\.gemini\\oauth_creds.json',
    },
  )
})

test('follows the data directory CC Switch records in app_paths.json', () => {
  const settings = 'C:\\Users\\Example\\AppData\\Roaming\\com.ccswitch.desktop'
  const probe = probeFor(
    ['D:\\.cc-switch'],
    { [settings + '\\app_paths.json']: '{"app_config_dir_override":"D:\\\\.cc-switch"}' },
  )

  assert.deepEqual(
    resolveCcSwitchPaths('C:\\Users\\Example', undefined, win32, probe),
    {
      database: 'D:\\.cc-switch\\cc-switch.db',
      providerSelection: 'C:\\Users\\Example\\.dsh\\ccswitch-providers.json',
      codexOAuthStore: 'D:\\.cc-switch\\codex_oauth_auth.json',
      codexAuth: 'C:\\Users\\Example\\.codex\\auth.json',
      geminiOAuthCredentials: 'C:\\Users\\Example\\.gemini\\oauth_creds.json',
    },
  )
})

test('honours a relocated data directory on POSIX hosts', () => {
  const settings = '/home/example/.config/com.ccswitch.desktop'
  const probe = probeFor(
    ['/mnt/cc-switch'],
    { [settings + '/app_paths.json']: '{"app_config_dir_override":"/mnt/cc-switch"}' },
  )

  const paths = resolveCcSwitchPaths('/home/example', undefined, posix, probe)
  assert.equal(paths.database, '/mnt/cc-switch/cc-switch.db')
  assert.equal(paths.codexOAuthStore, '/mnt/cc-switch/codex_oauth_auth.json')
})

test('reads the macOS application support location', () => {
  const settings = '/Users/example/Library/Application Support/com.ccswitch.desktop'
  const probe = probeFor(
    ['/Volumes/Data/cc-switch'],
    { [settings + '/app_paths.json']: '{"app_config_dir_override":"/Volumes/Data/cc-switch"}' },
  )

  assert.equal(
    resolveCcSwitchPaths('/Users/example', undefined, posix, probe).database,
    '/Volumes/Data/cc-switch/cc-switch.db',
  )
})

test('tolerates a UTF-8 BOM in app_paths.json', () => {
  const settings = 'C:\\Users\\Example\\AppData\\Roaming\\com.ccswitch.desktop'
  const probe = probeFor(
    ['D:\\cc-switch'],
    { [settings + '\\app_paths.json']: '\uFEFF{"app_config_dir_override":"D:\\\\cc-switch"}' },
  )

  assert.equal(
    resolveCcSwitchPaths('C:\\Users\\Example', undefined, win32, probe).database,
    'D:\\cc-switch\\cc-switch.db',
  )
})

test('falls back to the default directory when the override is gone or unusable', () => {
  const settings = 'C:\\Users\\Example\\AppData\\Roaming\\com.ccswitch.desktop'
  const expected = 'C:\\Users\\Example\\.cc-switch\\cc-switch.db'
  const cases = {
    'missing directory': '{"app_config_dir_override":"D:\\\\.cc-switch"}',
    'empty value': '{"app_config_dir_override":"   "}',
    'relative value': '{"app_config_dir_override":".\\\\.cc-switch"}',
    'non-string value': '{"app_config_dir_override":42}',
    'absent key': '{"something_else":"D:\\\\cc-switch"}',
    'malformed json': '{"app_config_dir_override":',
  }
  for (const [label, contents] of Object.entries(cases)) {
    const probe = probeFor([], { [settings + '\\app_paths.json']: contents })
    assert.equal(
      resolveCcSwitchPaths('C:\\Users\\Example', undefined, win32, probe).database,
      expected,
      label,
    )
  }
})

test('falls back when app_paths.json is absent or unreadable', () => {
  assert.equal(
    resolveCcSwitchPaths('C:\\Users\\Example', undefined, win32, EMPTY).database,
    'C:\\Users\\Example\\.cc-switch\\cc-switch.db',
  )

  const unreadable = probeFor([], {})
  unreadable.readText = () => undefined
  assert.equal(
    resolveCcSwitchPaths('C:\\Users\\Example', undefined, win32, unreadable).database,
    'C:\\Users\\Example\\.cc-switch\\cc-switch.db',
  )
})

test('an explicit database overrides app_paths.json entirely', () => {
  const settings = 'C:\\Users\\Example\\AppData\\Roaming\\com.ccswitch.desktop'
  let probed = false
  const probe = {
    isDirectory: () => { probed = true; return true },
    readText: () => { probed = true; return '{"app_config_dir_override":"D:\\\\.cc-switch"}' },
  }

  const paths = resolveCcSwitchPaths('C:\\Users\\Example', 'E:\\explicit\\cc-switch.db', win32, probe)
  assert.equal(paths.database, 'E:\\explicit\\cc-switch.db')
  assert.equal(paths.codexOAuthStore, 'E:\\explicit\\codex_oauth_auth.json')
  assert.equal(probed, false, 'explicit database must not consult the CC Switch settings file')
})
