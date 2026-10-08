import { createElement as h, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { ImportOutcome, ImportRemote, ImportRow, ImportView } from '../import-contract.ts'

export interface ImportPanelProps { remote: ImportRemote }

const APP_LABEL: Record<string, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' }
const DISCOVERY: Record<ImportRow['discovery'], string> = {
  configured: '模型列表来自 CC Switch 配置',
  pending: '正在读取接口模型列表…',
  remote: '模型列表来自供应商接口',
  failed: '接口读取失败，沿用已知模型',
}
/** One request per chunk keeps a long import responsive and gives real progress. */
const CHUNK = 5
const MAX_SELECTION = 128
/** Selection key for a group-wide confirmation, which has no single provider. */
const BATCH = '*'
const VERB: Record<'import' | 'update' | 'key' | 'remove', string> = {
  import: '正在导入', update: '正在更新模型', key: '正在写回密钥', remove: '正在移除',
}
type Phase = '' | 'reload' | 'refresh' | 'import' | 'update' | 'key' | 'remove'
/** One outcome, kept per provider so its own row can explain what happened. */
interface Feedback {
  key: string
  name: string
  tone: 'success' | 'warn' | 'error'
  /** The importer's message, shown on the row it came from. */
  message: string
  /** The same message prefixed with the route name, for the summary list. */
  text: string
}

const toneOf = (status: ImportOutcome['status']): Feedback['tone'] =>
  status === 'skipped' ? 'warn' : status === 'failed' ? 'error' : 'success'

export function ImportPanel({ remote }: ImportPanelProps) {
  const [view, setView] = useState<ImportView>()
  const [selected, setSelected] = useState<string[]>([])
  const [marked, setMarked] = useState<string[]>([])
  const [filter, setFilter] = useState('')
  const [phase, setPhase] = useState<Phase>('')
  const [failure, setFailure] = useState('')
  const [feedback, setFeedback] = useState<Feedback[]>([])
  const [progress, setProgress] = useState<string>('')
  const [confirming, setConfirming] = useState('')

  const reload = async (): Promise<ImportView> => {
    const answer = await remote.list()
    if (!answer.ok) throw new Error(answer.error.message)
    setView(answer.value)
    setSelected(current => current.filter(id => answer.value.rows.some(row => row.provider === id && row.eligible)))
    setMarked(current => current.filter(id => answer.value.rows.some(row => row.provider === id && row.imported)))
    return answer.value
  }
  useEffect(() => {
    let active = true
    void remote.list().then(answer => {
      if (!active) return
      if (answer.ok) setView(answer.value)
      else setFailure(answer.error.message)
    }).catch(() => { if (active) setFailure('无法读取 CC Switch 导入服务，请确认插件已启用并完整重启 DSH。') })
    return () => { active = false }
  }, [remote])

  const report = (outcomes: readonly ImportOutcome[], rows: readonly ImportRow[]) => {
    setFeedback(outcomes.map(outcome => {
      const name = rows.find(row => row.provider === outcome.provider)?.name ?? '该线路'
      return { key: outcome.provider, name, tone: toneOf(outcome.status), message: outcome.message, text: `${name}：${outcome.message}` }
    }))
  }
  const guard = async (next: Phase, action: () => Promise<void>) => {
    if (phase !== '') return
    setPhase(next)
    setFailure('')
    try { await action() } catch {
      setFailure('操作未完成。请重新读取后重试；源 API Key 与 DSH 写入权限须有效。')
    } finally { setPhase(''); setProgress('') }
  }
  const refreshSelected = (targets: readonly string[]) => guard('refresh', async () => {
    setFeedback([])
    const answer = await remote.refresh([...targets])
    if (!answer.ok) throw new Error(answer.error.message)
    setView(answer.value)
  })
  /** Re-read the route list itself, for a CC Switch route added since page load. */
  const reloadRoutes = () => guard('reload', async () => { setFeedback([]); await reload() })
  const importSelected = () => guard('import', async () => {
    setFeedback([])
    const targets = [...chosen]
    const outcomes: ImportOutcome[] = []
    // The importer re-reads the interface model list for each chunk before it
    // writes, so importing never needs a separate refresh step first.
    for (let offset = 0; offset < targets.length; offset += CHUNK) {
      const chunk = targets.slice(offset, offset + CHUNK)
      setProgress(`${VERB.import} ${Math.min(offset + chunk.length, targets.length)}/${targets.length}…`)
      let refused = ''
      try {
        const answer = await remote.importProviders(chunk)
        if (answer.ok) outcomes.push(...answer.value)
        else refused = '导入请求未完成，这一批没有写入。'
      } catch { refused = '导入请求未完成，这一批没有写入。' }
      if (refused !== '') {
        for (const provider of chunk) outcomes.push({ provider, status: 'failed', message: refused })
        break
      }
    }
    // Reload even after a mid-way refusal: the chunks that did land must stop
    // looking importable, and the ones that failed stay selected for a retry.
    const fresh = await reload()
    report(outcomes, fresh.rows)
    const failed = new Set(outcomes.filter(outcome => outcome.status === 'failed').map(outcome => outcome.provider))
    setSelected(current => current.filter(id => failed.has(id)))
  })
  /**
   * One action over one or many imported routes. A batch is the reason this
   * exists: rotating a key in CC Switch should not mean twenty confirmations,
   * and a partial failure must leave the routes that did not go through marked
   * so the next click is a retry rather than a re-selection.
   */
  const runTargets = (kind: 'update' | 'key' | 'remove', targets: readonly string[]) => guard(kind, async () => {
    if (targets.length === 0) return
    setFeedback([])
    setConfirming('')
    const outcomes: ImportOutcome[] = []
    for (let offset = 0; offset < targets.length; offset += CHUNK) {
      const chunk = targets.slice(offset, offset + CHUNK)
      setProgress(`${VERB[kind]} ${Math.min(offset + chunk.length, targets.length)}/${targets.length}…`)
      let refused = ''
      try {
        const answer = kind === 'update' ? await remote.resync(chunk)
          : kind === 'key' ? await remote.refreshKey(chunk)
          : await remote.remove(chunk)
        if (answer.ok) outcomes.push(...answer.value)
        else refused = '这次操作没有完成，未做改动。'
      } catch { refused = '这次操作没有完成，未做改动。' }
      if (refused !== '') {
        for (const provider of chunk) outcomes.push({ provider, status: 'failed', message: refused })
        break
      }
    }
    const fresh = await reload()
    report(outcomes, fresh.rows)
    const failed = new Set(outcomes.filter(outcome => outcome.status === 'failed').map(outcome => outcome.provider))
    setMarked(current => current.filter(id => failed.has(id)))
  })
  const runOne = (provider: string, kind: 'update' | 'key' | 'remove') => runTargets(kind, [provider])
  const toggle = (provider: string) => setSelected(current => {
    const live = current.filter(id => importableIds.includes(id))
    if (live.includes(provider)) return live.filter(id => id !== provider)
    return live.length >= MAX_SELECTION ? live : [...live, provider]
  })

  const rows = view?.rows.filter(row => `${row.name} ${row.appType} ${row.provider} ${row.protocol} ${(row.sample ?? []).join(' ')}`.toLowerCase().includes(filter.trim().toLowerCase())) ?? []
  const importable = rows.filter(row => row.eligible)
  const imported = rows.filter(row => row.imported)
  const dynamic = rows.filter(row => !row.eligible && !row.imported)
  // A route that got imported (or whose catalog emptied) must drop out of the
  // selection, or the count and the import button would describe rows that are
  // no longer selectable. The unfiltered list is the reference, so filtering
  // the list never silently drops a selection.
  const importableIds = (view?.rows ?? []).filter(row => row.eligible && !row.imported).map(row => row.provider)
  const importedIds = (view?.rows ?? []).filter(row => row.imported).map(row => row.provider)
  const chosen = selected.filter(id => importableIds.includes(id))
  const markedLive = marked.filter(id => importedIds.includes(id))
  const allChosen = importable.length > 0 && importable.every(entry => chosen.includes(entry.provider))
  const allMarked = imported.length > 0 && imported.every(entry => markedLive.includes(entry.provider))
  const busy = phase !== ''
  // With nothing selected the read button refreshes every importable route, so
  // the common "just tell me all the models" want is one click, not a select-all.
  const refreshTargets = chosen.length > 0 ? chosen : importable.slice(0, MAX_SELECTION).map(entry => entry.provider)
  const refreshLabel = phase === 'refresh' ? '读取中…'
    : chosen.length > 0 ? `读取所选 (${chosen.length})`
    : importable.length > 0 ? `读取全部 (${refreshTargets.length})` : '读取模型列表'
  const button = (label: string, onClick: () => void, options: { disabled?: boolean; primary?: boolean; danger?: boolean; link?: boolean } = {}) =>
    h('button', {
      type: 'button',
      className: `dsh-ccswitch-import-button${options.primary ? ' is-primary' : ''}${options.danger ? ' is-danger' : ''}${options.link ? ' is-link' : ''}`,
      disabled: busy || options.disabled === true,
      onClick,
    }, label)
  const tag = (text: string, key?: string) => h('span', { key, className: 'dsh-ccswitch-import-tag' }, text)
  /** A destructive action asks once: the row shows what it will do, then confirms. */
  const armed = (kind: 'key' | 'remove', provider: string) => confirming === `${kind}:${provider}`
  const status = (text: string, tone: 'muted' | 'success' | 'warn' | 'error' = 'muted') =>
    h('p', { className: `dsh-ccswitch-import-status is-${tone}` }, text)
  /** Why this route is not importable, plus what the interface did last time. */
  const dynamicNote = (entry: ImportRow): string => {
    const base = entry.reason === '' ? '继续由插件动态连接。' : entry.reason
    return entry.discovery === 'failed' ? `${base}（接口读取失败，沿用已知模型）`
      : entry.discovery === 'pending' ? `${base}（正在读取接口模型列表…）`
      : base
  }
  const row = (key: string, head: ReactNode[], body: ReactNode[]) =>
    h('li', { key, className: 'dsh-ccswitch-import-card' }, h('div', { className: 'dsh-ccswitch-import-row-head' }, ...head), ...body)

  /** A one-line peek at the catalog so "only one model?" is answerable without importing. */
  const sample = (entry: ImportRow): ReactNode => {
    const ids = entry.sample ?? []
    if (ids.length === 0) return null
    const more = entry.models > ids.length ? ` …（共 ${entry.models} 个）` : ''
    return status(`模型：${ids.join('、')}${more}`)
  }
  /** What this exact route's last action produced, on the route itself. */
  const note = (provider: string): ReactNode => {
    const item = feedback.find(entry => entry.key === provider)
    return item === undefined ? null : status(item.message, item.tone)
  }

  const importableRow = (entry: ImportRow) => row(entry.provider, [
    h('label', { className: 'dsh-ccswitch-import-check', key: 'check' },
      h('input', { type: 'checkbox', checked: chosen.includes(entry.provider), disabled: busy, onChange: () => toggle(entry.provider) }),
      h('span', { className: 'dsh-ccswitch-import-name' }, entry.name),
    ),
    tag(APP_LABEL[entry.appType] ?? entry.appType, 'app'),
    tag(`${entry.models} 个模型`, 'models'),
  ], [
    sample(entry),
    status(`${DISCOVERY[entry.discovery]}${entry.discovery === 'failed' ? '；可在导入后手动补充模型 ID' : ''}`, entry.discovery === 'failed' ? 'warn' : 'muted'),
    // A refused chunk keeps its routes selected for a retry; the reason has to be
    // readable on the route itself, not only in the summary at the bottom.
    note(entry.provider),
  ])

  const importedRow = (entry: ImportRow) => row(entry.provider, [
    h('label', { className: 'dsh-ccswitch-import-check', key: 'check' },
      h('input', {
        type: 'checkbox', checked: markedLive.includes(entry.provider), disabled: busy,
        'aria-label': `选择 ${entry.name} 以批量操作`,
        onChange: () => setMarked(current => current.filter(id => importedIds.includes(id)).includes(entry.provider)
          ? current.filter(id => id !== entry.provider)
          : [...current.filter(id => importedIds.includes(id)), entry.provider]),
      }),
      h('span', { className: 'dsh-ccswitch-import-name' }, entry.name),
    ),
    tag(APP_LABEL[entry.appType] ?? entry.appType, 'app'),
    tag(`${entry.models} 个模型`, 'models'),
    h('span', { className: 'dsh-ccswitch-import-row-actions', key: 'actions' },
      button(phase === 'update' ? '更新中…' : '更新模型', () => void runOne(entry.provider, 'update')),
      armed('key', entry.provider)
        ? button('确认换密钥', () => void runOne(entry.provider, 'key'), { link: true })
        : button('更新密钥', () => setConfirming(`key:${entry.provider}`), { link: true }),
      armed('remove', entry.provider)
        ? button('确认移除', () => void runOne(entry.provider, 'remove'), { danger: true })
        : button('移除', () => setConfirming(`remove:${entry.provider}`), { danger: true }),
    ),
  ], [
    sample(entry),
    h('p', { className: 'dsh-ccswitch-import-status', key: 'state' },
      h('span', { className: `dsh-ccswitch-import-dot${entry.credential === 'missing' ? ' is-missing' : ''}` }),
      entry.credential === 'missing'
        ? '已导入，但密钥条目不见了；移除后重新导入可恢复，或点「更新密钥」写回 CC Switch 里的当前密钥。'
        : entry.models === 0
          ? '已导入，但这个供应商当前没有任何模型；可以在上方卡片里添加模型 ID。'
          : '已导入：模型里只保留这一份，CC Switch 的改动不会覆盖它。'),
    note(entry.provider),
    status(armed('remove', entry.provider)
      ? '移除会删除这个 DSH 原生供应商，并同时删除该线路写入的密钥条目。'
      : armed('key', entry.provider)
        ? '会用 CC Switch 里这条线路当前的 API Key 覆盖 DSH 里保存的那一份；模型与其他设置不动。'
        : '“更新模型”重新读取接口模型列表，保留你手动添加的模型与现有密钥；“更新密钥”在 CC Switch 里换过密钥后使用。'),
  ])

  return h('section', { className: 'dsh-ccswitch-import', 'aria-label': 'CC Switch 线路导入' },
    h('div', { className: 'dsh-ccswitch-import-title-row' },
      h('h3', { className: 'dsh-ccswitch-import-title' }, '从 CC Switch 导入线路'),
      button(phase === 'reload' ? '读取中…' : '重新载入线路', () => void reloadRoutes(), { link: true }),
    ),
    h('p', { className: 'dsh-ccswitch-import-intro' },
      '不导入也能用：所有 CC Switch 线路已经在模型选择器里以「CC Switch ·」分组出现。导入只是把某条线路固定成 DSH 原生供应商，便于改显示名、单独调参或手动增删模型；导入后它的密钥写入 DSH 凭据存储，模型列表里只保留这一份，并出现在本页上方的供应商卡片里。'),
    view !== undefined && !view.available ? h('p', { className: 'dsh-ccswitch-import-notice is-warn', role: 'alert' }, '需要先在 DSH 设置中启用 llm-pi-ai 原生模型适配器，才能导入线路。') : null,
    view !== undefined && view.available && !view.writable ? h('p', { className: 'dsh-ccswitch-import-notice is-warn', role: 'alert' }, '当前 DSH 配置是只读的，无法写入供应商。') : null,
    failure ? h('p', { className: 'dsh-ccswitch-import-notice is-error', role: 'alert' }, failure) : null,
    h('div', { className: 'dsh-ccswitch-import-toolbar' },
      h('input', {
        type: 'search', className: 'dsh-ccswitch-import-search',
        placeholder: '筛选：线路名 / Claude / Codex / Gemini / 协议 / 模型 ID',
        'aria-label': '筛选 CC Switch 线路', value: filter,
        onChange: event => setFilter(event.currentTarget.value),
      }),
      h('span', { className: 'dsh-ccswitch-import-count' },
        `可导入 ${importable.length} · 已选 ${chosen.length}${imported.length > 0 ? ` · 已导入 ${imported.length}${markedLive.length > 0 ? `（选中 ${markedLive.length}）` : ''}` : ''}`),
      button(refreshLabel, () => void refreshSelected(refreshTargets), { disabled: refreshTargets.length === 0 }),
      button(phase === 'import' ? '导入中…' : `导入所选 (${chosen.length})`, () => void importSelected(), { primary: true, disabled: chosen.length === 0 }),
    ),
    chosen.length >= MAX_SELECTION && importable.length > MAX_SELECTION
      ? h('p', { className: 'dsh-ccswitch-import-notice is-warn' }, `一次最多导入 ${MAX_SELECTION} 条，已选中前 ${MAX_SELECTION} 条；其余请分批导入。`) : null,
    progress ? h('div', { className: 'dsh-ccswitch-import-progress', role: 'status', 'aria-live': 'polite' }, progress) : null,
    importable.length > 0 ? h('div', { className: 'dsh-ccswitch-import-group' },
      h('div', { className: 'dsh-ccswitch-import-group-head' },
        h('span', { className: 'dsh-ccswitch-import-group-title' }, `可导入 ${importable.length}`),
        button(allChosen ? '取消全选' : '全选', () => setSelected(
          allChosen ? [] : importable.slice(0, MAX_SELECTION).map(entry => entry.provider),
        ), { link: true }),
      ),
      h('ul', { className: 'dsh-ccswitch-import-rows' }, importable.map(importableRow)),
    ) : null,
    imported.length > 0 ? h('div', { className: 'dsh-ccswitch-import-group' },
      h('div', { className: 'dsh-ccswitch-import-group-head' },
        h('span', { className: 'dsh-ccswitch-import-group-title' }, `已导入 ${imported.length}`),
        button(allMarked ? '取消全选' : '全选', () => setMarked(allMarked ? [] : imported.map(entry => entry.provider)), { link: true }),
        h('span', { className: 'dsh-ccswitch-import-row-actions' },
          // The count is always shown once something is marked: the group button
          // and the per-row buttons would otherwise read exactly the same.
          button(markedLive.length > 0 ? `更新模型 (${markedLive.length})` : '更新模型', () => void runTargets('update', markedLive), { disabled: markedLive.length === 0 }),
          armed('key', BATCH)
            ? button(`确认换密钥 (${markedLive.length})`, () => void runTargets('key', markedLive), { link: true })
            : button(markedLive.length > 0 ? `更新密钥 (${markedLive.length})` : '更新密钥', () => setConfirming(`key:${BATCH}`), { link: true, disabled: markedLive.length === 0 }),
          armed('remove', BATCH)
            ? button(`确认移除 (${markedLive.length})`, () => void runTargets('remove', markedLive), { danger: true })
            : button(markedLive.length > 0 ? `移除 (${markedLive.length})` : '移除', () => setConfirming(`remove:${BATCH}`), { danger: true, disabled: markedLive.length === 0 }),
        ),
      ),
      armed('remove', BATCH)
        ? h('p', { className: 'dsh-ccswitch-import-notice is-warn', role: 'alert' },
          `确认移除会删除这 ${markedLive.length} 个 DSH 原生供应商，并同时删除它们写入的密钥条目。`)
        : armed('key', BATCH)
          ? h('p', { className: 'dsh-ccswitch-import-notice is-warn', role: 'alert' },
            `确认换密钥会用 CC Switch 里这些线路当前的 API Key 覆盖 DSH 里保存的那一份；模型与其他设置不动。`)
          : h('p', { className: 'dsh-ccswitch-import-status' },
            '勾选后可以一次「更新模型」「更新密钥」或「移除」多条；只有没做成的会保持勾选，方便直接重试。'),
      h('ul', { className: 'dsh-ccswitch-import-rows' }, imported.map(importedRow)),
    ) : null,
    dynamic.length > 0 ? h('details', { className: 'dsh-ccswitch-import-dynamic' },
      h('summary', { className: 'dsh-ccswitch-import-dynamic-summary' }, `保持 CC Switch 动态连接 ${dynamic.length}`),
      h('ul', { className: 'dsh-ccswitch-import-rows' }, dynamic.map(entry => row(entry.provider, [
        h('span', { className: 'dsh-ccswitch-import-name', key: 'name' }, entry.name),
        tag(APP_LABEL[entry.appType] ?? entry.appType, 'app'),
        tag(`${entry.models} 个模型`, 'models'),
      ], [status(dynamicNote(entry)), sample(entry)]))),
    ) : null,
    view !== undefined && rows.length === 0 ? h('div', { className: 'dsh-ccswitch-import-status-block' },
      view.rows.length === 0
        ? status('没有读到 CC Switch 线路：请确认 CC Switch 里已有可用线路，并且本机能找到它的配置文件。')
        : status('没有匹配的线路。'),
      view.rows.length === 0
        ? status('如果你在配置里写了 include，或设置了 DSH_CCSWITCH_PROVIDERS，只有被选中的线路会出现在这里。')
        : null) : null,
    feedback.length > 0 ? h('div', { className: 'dsh-ccswitch-import-feedback' },
      h('p', { className: 'dsh-ccswitch-import-feedback-head', role: 'status', 'aria-live': 'polite' },
        `最近一次操作：成功 ${feedback.filter(item => item.tone === 'success').length} · 跳过 ${feedback.filter(item => item.tone === 'warn').length} · 失败 ${feedback.filter(item => item.tone === 'error').length}`),
      h('ul', null, feedback.map(item => h('li', { key: item.key, className: `is-${item.tone}` }, item.text))),
    ) : null,
  )
}
