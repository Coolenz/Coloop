import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  Database,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react'
import type { AppSnapshot } from '../../shared/contracts'
import type { MemoryBrowseResult, MemoryEntry, MemorySave } from '../../shared/memory'
import { api, unwrap } from './api'
import './credentials.css'
import './memory.css'

type Editor =
  { type: 'ordinary'; entry?: Extract<MemoryEntry, { category: 'ordinary' }> } | { type: 'private' }
const kinds = { fact: '事实', preference: '偏好', procedure: '操作方法', task: '任务进度' }

export function MemoryPage({ snapshot }: { snapshot: AppSnapshot }) {
  const [ready, setReady] = useState(false),
    [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false)
  const [data, setData] = useState<MemoryBrowseResult>()
  const [queryInput, setQueryInput] = useState(''),
    [query, setQuery] = useState('')
  const [category, setCategory] = useState<'all' | 'ordinary' | 'private'>('all')
  const [offset, setOffset] = useState(0),
    [editor, setEditor] = useState<Editor>()
  const [deleting, setDeleting] = useState<string>(),
    [error, setError] = useState(''),
    [message, setMessage] = useState('')
  const generation = useRef(0),
    connected = snapshot.device.status === 'connected'
  const disabled =
    !ready ||
    !connected ||
    busy ||
    !!snapshot.credentials?.loginOpen ||
    !!snapshot.credentials?.editorOpen
  async function refresh() {
    const id = ++generation.current
    setLoading(true)
    try {
      const result = await unwrap(api.browseMemories({ query, category, offset, limit: 25 }))
      if (id === generation.current && offset > 0 && result.items.length === 0) {
        setOffset(0)
        return
      }
      if (id === generation.current) {
        setData(result)
        setError('')
      }
    } catch (e) {
      if (id === generation.current) {
        setData(undefined)
        setError((e as Error).message)
      }
    } finally {
      if (id === generation.current) setLoading(false)
    }
  }
  useEffect(() => {
    let alive = true
    void unwrap(api.protectCredentials(true))
      .then(() => {
        if (alive) setReady(true)
      })
      .catch((e) => {
        if (alive) setError(e.message)
      })
    return () => {
      alive = false
      generation.current++
      void api.protectCredentials(false)
    }
  }, [])
  useEffect(() => {
    if (ready && connected) void refresh()
    else setData(undefined)
  }, [ready, connected, query, category, offset])
  useEffect(
    () =>
      api.onMemorySaved((indexed) => {
        setMessage(
          indexed
            ? '私密记忆已保存，统一目录已同步。'
            : '凭据已保存；统一目录暂不可用，请刷新核对，勿重复保存。',
        )
        setEditor(undefined)
        if (offset) setOffset(0)
        else if (ready && connected) void refresh()
      }),
    [ready, connected, query, category, offset],
  )
  async function action(work: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await work()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!editor || editor.type === 'private') return
    const form = event.currentTarget,
      values = new FormData(form),
      current = editor
    const text = String(values.get('value') ?? ''),
      key = String(values.get('key') ?? '')
    const kind = String(values.get('kind') ?? 'fact') as MemorySave['kind']
    const tags = String(values.get('tags') ?? '')
      .split(/[,，\n]/)
      .map((tag) => tag.trim())
      .filter(Boolean)
    const summary = String(values.get('summary') ?? '')
    await action(async () => {
      if (current.entry) {
        await unwrap(api.reviseMemory({ id: current.entry.id, value: text, tags, summary }))
        setMessage('普通记忆已更新，历史版本保留。')
      } else {
        await unwrap(api.saveMemory({ key, value: text, kind, tags, summary }))
        setMessage('普通记忆已保存，可参与后续召回。')
      }
      setEditor(undefined)
      if (offset) setOffset(0)
      else await refresh()
    })
  }
  async function remove(entry: MemoryEntry) {
    await action(async () => {
      await unwrap(
        api.removeMemory(
          entry.category === 'private'
            ? { category: 'private', recordId: entry.recordId }
            : { category: 'ordinary', id: entry.id },
        ),
      )
      setDeleting(undefined)
      setMessage('记忆已删除。')
      if (offset) setOffset(0)
      else await refresh()
    })
  }
  return (
    <div className="page-content memory-content">
      <div className="page-title-row">
        <div>
          <h1>记忆</h1>
          <p>在同一目录中查找、管理普通记忆与私密记忆。</p>
        </div>
        <span className="badge">
          <ShieldCheck size={14} />
          {ready ? '记忆管理中 · 截图与 OCR 已暂停' : '正在准备保护'}
        </span>
      </div>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="memory-message" role="status">
          {message}
        </p>
      )}
      {!connected && (
        <p className="inline-warning">
          请先在「设备管理」连接 RK，再返回记忆页面。查看和管理记忆不需要启动模型。
        </p>
      )}
      {snapshot.credentials?.editorOpen && (
        <section className="memory-private-notice" aria-label="私密填写窗口状态">
          <div>
            <h2>私密填写窗口已打开</h2>
            <p>请在私密填写窗口保存账号密码，关闭后可继续管理记忆。</p>
          </div>
          <button
            className="button"
            onClick={() =>
              void action(async () => {
                await unwrap(api.closePrivateMemoryEditor())
              })
            }
          >
            关闭私密填写窗口
          </button>
        </section>
      )}
      {snapshot.credentials?.loginOpen && (
        <p className="inline-warning">
          私密登录窗口已打开。完成登录并关闭该窗口后，可继续管理记忆。
        </p>
      )}
      {data && !data.private_memory.available && (
        <p className="inline-warning">
          私密记忆提供方暂不可用。当前仅显示可用记录，旧的私密引用不会被继续使用。
        </p>
      )}
      <div className="memory-controls">
        <form
          className="memory-search"
          onSubmit={(event) => {
            event.preventDefault()
            setOffset(0)
            setQuery(queryInput)
            if (query === queryInput && offset === 0) void refresh()
          }}
        >
          <Search size={16} />
          <input
            aria-label="搜索记忆"
            value={queryInput}
            onChange={(e) => setQueryInput(e.target.value)}
            placeholder="搜索偏好、事实、网站或记录编号"
            maxLength={1000}
            disabled={!ready || !connected}
          />
          <button className="button" disabled={disabled || loading} type="submit">
            搜索
          </button>
        </form>
        <button
          className="button primary"
          disabled={disabled}
          onClick={() => setEditor({ type: category === 'private' ? 'private' : 'ordinary' })}
        >
          <Plus size={15} />
          新建记忆
        </button>
      </div>
      {editor && (
        <section className="panel settings-panel memory-editor" aria-label="记忆编辑器">
          <div className="section-bar">
            <div>
              <h2>{editor.type === 'ordinary' && editor.entry ? '修改普通记忆' : '新建记忆'}</h2>
              <p className="muted">普通内容参与召回；账号密码请使用私密记忆。</p>
            </div>
            <button
              className="icon-button"
              aria-label="关闭记忆编辑器"
              disabled={busy}
              onClick={() => setEditor(undefined)}
            >
              <X size={17} />
            </button>
          </div>
          <form
            key={editor.type + (editor.type === 'ordinary' ? (editor.entry?.id ?? 'new') : '')}
            onSubmit={(event) => void save(event)}
            autoComplete="off"
          >
            <fieldset disabled={disabled}>
              <div className="form-grid">
                <label className="span-two">
                  记忆类型
                  <select
                    aria-label="记忆类型"
                    value={editor.type}
                    disabled={editor.type === 'ordinary' && !!editor.entry}
                    onChange={(e) => setEditor({ type: e.target.value as 'ordinary' | 'private' })}
                  >
                    <option value="ordinary">普通记忆</option>
                    <option value="private">私密凭据</option>
                  </select>
                </label>
                {editor.type === 'ordinary' ? (
                  <>
                    <label>
                      记忆名称
                      <input
                        aria-label="记忆名称"
                        name="key"
                        defaultValue={editor.entry?.key ?? ''}
                        readOnly={!!editor.entry}
                        required={!editor.entry}
                        maxLength={128}
                        placeholder={editor.entry ? '自动提取的记忆' : '例如：默认保存目录'}
                      />
                    </label>
                    <label>
                      内容类别
                      <select
                        aria-label="内容类别"
                        name="kind"
                        defaultValue={editor.entry?.kind ?? 'fact'}
                        disabled={!!editor.entry}
                      >
                        {Object.entries(kinds).map(([value, label]) => (
                          <option value={value} key={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="span-two">
                      标签
                      <input
                        aria-label="记忆标签"
                        name="tags"
                        defaultValue={editor.entry?.tags?.join(', ') ?? ''}
                        placeholder="例如 app:notepad, workflow:outline"
                        maxLength={520}
                      />
                      <small>用逗号分隔，最多 8 个标签，每个最多 64 字。</small>
                    </label>
                    <label className="span-two">
                      目录摘要
                      <input
                        aria-label="记忆目录摘要"
                        name="summary"
                        defaultValue={editor.entry?.summary ?? ''}
                        maxLength={160}
                        placeholder="一句话说明这条记忆何时有用"
                      />
                    </label>
                    <label className="span-two">
                      记忆内容
                      <textarea
                        aria-label="记忆内容"
                        name="value"
                        required
                        maxLength={1000}
                        defaultValue={editor.entry?.text ?? ''}
                        rows={4}
                      />
                      <small>
                        请勿在普通记忆里填写账号密码。编辑后保留原版本，修改内容标为未核实。
                      </small>
                    </label>
                  </>
                ) : (
                  <p className="span-two muted">
                    账号密码在独立的私密填写窗口中输入，记忆目录仅显示网站与记录编号。
                  </p>
                )}
              </div>
              <div className="credential-form-footer">
                <span className="muted">
                  {editor.type === 'private'
                    ? '此处只保存私密引用。'
                    : '内容保存在 RK 的 Mem0 记忆系统。'}
                </span>
                {editor.type === 'private' ? (
                  <button
                    type="button"
                    className="button primary"
                    onClick={() =>
                      void action(async () => {
                        await unwrap(api.openPrivateMemoryEditor())
                      })
                    }
                  >
                    打开私密填写窗口
                  </button>
                ) : (
                  <button type="submit" className="button primary">
                    {busy && <LoaderCircle size={15} className="spin" />}保存记忆
                  </button>
                )}
              </div>
            </fieldset>
          </form>
        </section>
      )}
      <section className="memory-directory" aria-label="统一记忆目录">
        <div className="memory-list-heading">
          <div className="memory-filters" role="tablist" aria-label="记忆分类">
            {(
              [
                ['all', '全部'],
                ['ordinary', '普通记忆'],
                ['private', '私密记忆'],
              ] as const
            ).map(([value, label]) => (
              <button
                role="tab"
                aria-selected={category === value}
                key={value}
                className={category === value ? 'selected' : ''}
                disabled={busy}
                onClick={() => {
                  setCategory(value)
                  setOffset(0)
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <button className="button" disabled={disabled || loading} onClick={() => void refresh()}>
            <RefreshCw size={14} />
            刷新
          </button>
        </div>
        {loading && (
          <p className="memory-loading" role="status">
            <LoaderCircle size={15} className="spin" />
            正在读取统一记忆目录…
          </p>
        )}
        {!loading && !data?.items.length && (
          <div className="credential-empty">
            <Database size={24} />
            <h3>
              {!connected ? '连接 RK 后查看记忆' : query ? '当前查询没有结果' : '这里还没有记忆'}
            </h3>
            <p>
              {query
                ? '尝试调整关键词或切换记忆分类。'
                : '普通记忆和私密引用都会出现在同一目录中。'}
            </p>
          </div>
        )}
        <ul className="memory-list">
          {data?.items.map((entry) => (
            <li key={entry.id} data-memory-category={entry.category}>
              <div className="memory-item-icon">
                {entry.category === 'private' ? <LockKeyhole size={19} /> : <Database size={19} />}
              </div>
              <div className="memory-item-copy">
                <div className="memory-item-title">
                  <strong>
                    {entry.category === 'private' ? entry.origin : entry.key || '自动提取的记忆'}
                  </strong>
                  <span className="quiet-tag">
                    {entry.category === 'private' ? '私密记忆' : kinds[entry.kind]}
                  </span>
                </div>
                {entry.category === 'private' ? (
                  <>
                    <p>账号密码正文受保护，由 Coloop 本地执行器按授权使用。</p>
                    <code>{entry.locator}</code>
                  </>
                ) : (
                  <>
                    {entry.summary && <p>{entry.summary}</p>}
                    {!!entry.tags?.length && <p aria-label="记忆标签">{entry.tags.join(' · ')}</p>}
                    <p className="memory-body">{entry.text}</p>
                    <small>
                      {entry.verified ? '已核实' : '未核实'}
                      {entry.expiresAt
                        ? ` · 有效期至 ${new Date(entry.expiresAt * 1000).toLocaleDateString('zh-CN')}`
                        : ''}
                    </small>
                  </>
                )}
              </div>
              <div className="memory-item-actions">
                {deleting === entry.id ? (
                  <>
                    <span>删除此记忆？</span>
                    <button
                      className="button"
                      disabled={busy}
                      onClick={() => setDeleting(undefined)}
                    >
                      取消
                    </button>
                    <button
                      className="button"
                      disabled={disabled}
                      onClick={() => void remove(entry)}
                    >
                      确认删除
                    </button>
                  </>
                ) : (
                  <>
                    {entry.category === 'private' ? (
                      <button
                        className="button"
                        disabled={disabled}
                        onClick={() =>
                          void action(async () => {
                            await unwrap(api.openPrivateMemory(entry.recordId))
                          })
                        }
                      >
                        <KeyRound size={14} />
                        本地使用
                      </button>
                    ) : (
                      <button
                        className="button"
                        disabled={disabled}
                        onClick={() => setEditor({ type: 'ordinary', entry })}
                      >
                        <Pencil size={14} />
                        编辑
                      </button>
                    )}
                    <button
                      className="icon-button"
                      aria-label={`删除记忆 ${entry.id}`}
                      disabled={disabled}
                      onClick={() => setDeleting(entry.id)}
                    >
                      <Trash2 size={16} />
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
        {data && data.total > 0 && (
          <div className="memory-pagination">
            <span>
              显示 {offset + 1}–{Math.min(offset + data.limit, data.total)} 条，共 {data.total} 条
              {data.mode === 'semantic' ? '语义候选' : '记忆'}
            </span>
            <div>
              <button
                className="button"
                disabled={disabled || loading || offset === 0}
                onClick={() => setOffset(Math.max(0, offset - 25))}
              >
                上一页
              </button>
              <button
                className="button"
                disabled={disabled || loading || offset + data.limit >= data.total}
                onClick={() => setOffset(offset + 25)}
              >
                下一页
              </button>
            </div>
          </div>
        )}
      </section>
      <p className="muted credential-footnote">
        普通记忆与私密引用共用 Mem0 索引。私密正文不进入普通召回或云端；私密登录窗口仍限定同源
        HTTPS，输入后需自行检查并提交。
      </p>
    </div>
  )
}
