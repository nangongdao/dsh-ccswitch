import { createElement as h, useEffect, useState } from 'react'
import type { ImportOutcome, ImportRemote, ImportRow, ImportView } from '../import-contract.ts'

export interface ImportPanelProps { remote: ImportRemote }
const discoveryLabels: Record<ImportRow['discovery'], string> = {
  configured: '仅 CC Switch 配置模型', pending: '正在获取接口列表',
  remote: '接口已返回列表', failed: '接口获取失败，保留已有模型',
}
export function ImportPanel({ remote }: ImportPanelProps) {
  const [view, setView] = useState<ImportView>()
  const [selected, setSelected] = useState<string[]>([])
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const [outcomes, setOutcomes] = useState<ImportOutcome[]>([])
  const load = async () => {
    const answer = await remote.list()
    if (!answer.ok) throw new Error(answer.error.message)
    setView(answer.value)
    setSelected(current => current.filter(id => answer.value.rows.some(row => row.provider === id && row.eligible)))
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
  const run = async (action: 'reload' | 'refresh' | 'import') => {
    if (busy) return
    setBusy(true)
    setFailure('')
    try {
      if (action === 'reload') await load()
      else if (action === 'refresh') {
        const answer = await remote.refresh(selected)
        if (!answer.ok) throw new Error(answer.error.message)
        setView(answer.value)
      } else {
        const answer = await remote.importProviders(selected)
        if (!answer.ok) throw new Error(answer.error.message)
        setOutcomes(answer.value)
        await load()
      }
    } catch {
      setFailure('操作未完成，请重新读取后重试；源 API Key 与 DSH 写入权限须有效。')
    } finally { setBusy(false) }
  }
  const toggle = (provider: string) => setSelected(current => current.includes(provider) ? current.filter(id => id !== provider) : [...current, provider])
  const rows = view?.rows.filter(row => `${row.name} ${row.appType} ${row.provider}`.toLowerCase().includes(filter.trim().toLowerCase())) ?? []
  const button = (label: string, onClick: () => void, disabled = false) => h('button', { type: 'button', onClick, disabled: busy || disabled }, label)
  return h('section', { className: 'dsh-ccswitch-import', 'aria-label': 'CC Switch 原生导入' },
    h('h3', null, '从 CC Switch 导入'),
    h('p', null, '一次性导入 API Key 供应商及当前模型列表，之后在 DSH 原生卡片中编辑接口、密钥和模型；CC Switch 不会覆盖你的修改。'),
    h('p', null, 'OAuth/登录令牌和当前 DSH 尚不支持的协议继续使用动态连接。原有会话连接不会被删除或自动改选。'),
    view !== undefined && !view.available ? h('p', { role: 'alert' }, '请启用 DSH 的 llm-pi-ai 原生模型适配器后再导入。') : null,
    view !== undefined && !view.writable ? h('p', { role: 'alert' }, '当前 DSH 配置为只读，不能导入。') : null,
    h('div', { className: 'dsh-ccswitch-import-actions' },
      button('重新读取 CC Switch', () => void run('reload')),
      button('选择可导入项', () => setSelected(rows.filter(row => row.eligible).slice(0, 128).map(row => row.provider)), !rows.some(row => row.eligible)),
      button('获取所选模型列表', () => void run('refresh'), selected.length === 0),
      button(busy ? '处理中…' : `导入所选 (${selected.length})`, () => void run('import'), selected.length === 0),
    ),
    h('input', { type: 'search', placeholder: '筛选供应商名称 / Claude / Codex / Gemini', 'aria-label': '筛选 CC Switch 导入供应商', value: filter, onChange: event => setFilter(event.currentTarget.value) }),
    h('p', { className: 'dsh-ccswitch-import-note' }, '“接口获取失败”不是完整目录；可先刷新，导入后也能手动补充模型 ID。接口返回列表不保证每个模型都可通过该供应商协议调用。'),
    h('ul', { className: 'dsh-ccswitch-import-rows' }, rows.map(row => h('li', { key: row.provider },
      h('label', null,
        h('input', { type: 'checkbox', checked: selected.includes(row.provider), disabled: busy || !row.eligible, onChange: () => toggle(row.provider) }),
        h('span', null, `${row.name} · ${row.appType} · ${row.models} 个模型`),
      ),
      h('small', null, row.imported ? row.reason : `${discoveryLabels[row.discovery]}${row.reason ? `；${row.reason}` : ''}`),
    ))),
    view !== undefined && rows.length === 0 ? h('p', null, view.rows.length === 0 ? '未读取到 CC Switch 供应商，请检查数据库位置与供应商筛选。' : '没有匹配的供应商。') : null,
    failure ? h('p', { role: 'alert' }, failure) : null,
    outcomes.length > 0 ? h('ul', { role: 'status', 'aria-live': 'polite' }, outcomes.map(outcome => h('li', { key: outcome.provider }, `${view?.rows.find(row => row.provider === outcome.provider)?.name ?? outcome.provider}：${outcome.message}`))) : null,
  )
}
