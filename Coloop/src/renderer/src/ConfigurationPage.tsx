import { useState } from 'react'
import { ArrowLeft, ChevronRight } from 'lucide-react'
import type { AppSnapshot, Settings } from '../../shared/contracts'
import { api, unwrap } from './api'
import { DevicePage, ModelsPage } from './Settings'
import { MobileRemotePanel } from './MobileRemotePanel'
import { CredentialsPage } from './CredentialsPage'
import { AutoAgentWorkPage } from './AutoAgentWorkPage'
import { CoordinatorPage } from './CoordinatorPage'
import { DesktopPage } from './DesktopPage'
import { ModelDebugPage } from './ModelDebugPage'
type BrowserSettings = {
  browser: 'edge' | 'chrome'
  connection?: 'existing' | 'managed'
  cdpUrl?: string
  profileDirectory?: string
  viewport: { width: number; height: number }
  locale: string
}

type Section =
  | 'overview'
  | 'rk'
  | 'mobile'
  | 'models'
  | 'debug'
  | 'execution'
  | 'browser'
  | 'agents'
  | 'coordinator'
  | 'credentials'
  | 'island'
  | 'startup'
  | 'desktop'
const names: Record<Section, string> = {
  overview: '配置',
  rk: 'RK 设备',
  mobile: '手机连接',
  models: '云端模型',
  debug: '模型运行与调试',
  execution: '工作目录与执行偏好',
  browser: '浏览器',
  agents: '外部 Agent 与自动推进',
  coordinator: 'Agent 接入与审批',
  credentials: '凭据与隐私',
  island: '灵动岛与提醒',
  startup: '启动与窗口行为',
  desktop: '电脑操作调试',
}
export function ConfigurationPage({
  snapshot,
  onSaved,
  notify,
  onDraft,
  diagnosticTask,
  onRecord,
}: {
  snapshot: AppSnapshot
  onSaved(settings: Settings): void
  notify(text: string, error?: boolean): void
  onDraft(text: string): void
  diagnosticTask?: string
  onRecord(id: string): void
}) {
  const [section, setSection] = useState<Section>(diagnosticTask ? 'debug' : 'overview')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [workspace, setWorkspace] = useState(snapshot.settings.taskWorkspace ?? '')
  const [browser, setBrowser] = useState<'edge' | 'chrome'>('edge')
  const [connection, setConnection] = useState<'existing' | 'managed'>('existing')
  const [browserInfo, setBrowserInfo] = useState('')
  const [browserSettings, setBrowserSettings] = useState<BrowserSettings>()
  const [prefs, setPrefs] = useState({
    islandEnabled: snapshot.settings.islandEnabled !== false,
    islandDetailedNotifications: snapshot.settings.islandDetailedNotifications !== false,
    islandAttention: snapshot.settings.islandAttention !== false,
    closeToTray: snapshot.settings.closeToTray !== false,
    startHidden: snapshot.settings.startHidden === true,
    launchOnLogin: snapshot.settings.launchOnLogin === true,
  })
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await work()
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const open = (next: Section) => {
    setSection(next)
    setError('')
    if (next === 'browser')
      void act(async () => {
        const result = (await unwrap(api.browserConfig({ operation: 'inspect' }))) as {
          settings: BrowserSettings
        }
        setBrowserInfo(JSON.stringify(result, null, 2))
        setBrowserSettings(result.settings)
        setBrowser(result.settings.browser)
        setConnection(result.settings.connection ?? 'existing')
      })
  }
  const link = (id: Section, summary?: string) => (
    <button className="configuration-link" key={id} onClick={() => open(id)}>
      <span>
        <strong>{names[id]}</strong>
        {summary && <small>{summary}</small>}
      </span>
      <ChevronRight size={18} />
    </button>
  )
  return (
    <div className="workspace-page configuration-page">
      {section !== 'overview' && (
        <button className="text-button page-back" onClick={() => open('overview')}>
          <ArrowLeft size={16} />
          返回配置
        </button>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {section === 'overview' && (
        <>
          <h1>配置</h1>
          <section className="configuration-section">
            <h2>连接</h2>
            {link(
              'rk',
              snapshot.device.status === 'connected'
                ? `${snapshot.device.hostname ?? 'RK'} · ${snapshot.device.qwenReady ? '服务就绪' : '服务未就绪'}`
                : '未连接',
            )}
            {link(
              'mobile',
              snapshot.mobile?.tunnel.status === 'online' ? '手机服务在线' : '手机服务未开启',
            )}
          </section>
          <section className="configuration-section">
            <h2>模型</h2>
            {link(
              'models',
              `${snapshot.settings.provider.model} · ${snapshot.settings.provider.hasKey ? '已配置' : '等待配置'}`,
            )}
            {link(
              'debug',
              `当前模式：${{ cloud: '云端执行', local: '本地执行', 'local-auto': '本地判断' }[snapshot.settings.executionMode ?? snapshot.settings.autoTaskRouting ?? 'cloud']}`,
            )}
          </section>
          <section className="configuration-section">
            <h2>任务与接入</h2>
            {link('execution', snapshot.settings.taskWorkspace)}
            {link('browser')}
            {link('agents')}
            {link('coordinator')}
            {link('desktop')}
          </section>
          <section className="configuration-section">
            <h2>应用</h2>
            {link('credentials')}
            {link('island', prefs.islandEnabled ? '已启用' : '已关闭')}
            {link('startup')}
          </section>
        </>
      )}
      {section === 'rk' && <DevicePage snapshot={snapshot} onSaved={onSaved} notify={notify} />}
      {section === 'models' && <ModelsPage snapshot={snapshot} onSaved={onSaved} notify={notify} />}
      {section === 'mobile' && (
        <>
          <h1>手机连接</h1>
          <MobileRemotePanel snapshot={snapshot} />
        </>
      )}
      {section === 'debug' && (
        <ModelDebugPage
          snapshot={snapshot}
          onDraft={onDraft}
          diagnosticTask={diagnosticTask}
          onRecord={onRecord}
        />
      )}
      {section === 'credentials' && <CredentialsPage snapshot={snapshot} />}
      {section === 'agents' && (
        <>
          <h1>外部 Agent 与自动推进</h1>
          <label className="setting-toggle">
            <input
              type="checkbox"
              checked={snapshot.autoAgentWork?.enabled ?? false}
              disabled={busy}
              onChange={(event) =>
                void act(() => unwrap(api.setAutoAgentEnabled(event.target.checked)))
              }
            />
            自动发现与推进任务
          </label>
          <AutoAgentWorkPage snapshot={snapshot} configure />
        </>
      )}
      {section === 'coordinator' && <CoordinatorPage snapshot={snapshot} />}
      {section === 'desktop' && <DesktopPage snapshot={snapshot} />}
      {section === 'execution' && (
        <>
          <h1>工作目录与执行偏好</h1>
          <section className="configuration-section debug-form">
            <label>
              默认工作目录
              <input value={workspace} onChange={(event) => setWorkspace(event.target.value)} />
            </label>
            <div className="form-actions">
              <button
                className="button"
                onClick={() =>
                  void act(async () => {
                    const selected = await unwrap(api.chooseTaskWorkspace())
                    if (selected) setWorkspace(selected)
                  })
                }
              >
                选择目录
              </button>
              <button
                className="button primary"
                disabled={busy || !workspace}
                onClick={() =>
                  void act(async () => {
                    onSaved(
                      await unwrap(
                        api.saveSettings({ ...snapshot.settings, taskWorkspace: workspace }),
                      ),
                    )
                    notify('工作目录已保存')
                  })
                }
              >
                保存设置
              </button>
            </div>
            <button className="configuration-link" onClick={() => open('debug')}>
              任务执行模式与失败接管
              <ChevronRight size={17} />
            </button>
          </section>
        </>
      )}
      {section === 'browser' && (
        <>
          <h1>浏览器</h1>
          <section className="configuration-section debug-form">
            <label>
              默认浏览器
              <select
                value={browser}
                onChange={(event) => setBrowser(event.target.value as 'edge' | 'chrome')}
              >
                <option value="edge">Microsoft Edge</option>
                <option value="chrome">Google Chrome</option>
              </select>
            </label>
            <label>
              连接方式
              <select
                value={connection}
                onChange={(event) => setConnection(event.target.value as 'existing' | 'managed')}
              >
                <option value="existing">当前用户会话</option>
                <option value="managed">独立托管会话</option>
              </select>
            </label>
            <button
              className="button primary"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const result = await unwrap(
                    api.browserConfig({
                      operation: 'configure',
                      settings: {
                        ...browserSettings,
                        browser,
                        connection,
                        viewport: browserSettings?.viewport ?? { width: 1440, height: 1000 },
                        locale: browserSettings?.locale ?? 'zh-CN',
                      },
                      remember: true,
                      source_quote: `以后默认使用 ${browser === 'edge' ? 'Edge' : 'Chrome'} 浏览器`,
                    }),
                  )
                  setBrowserInfo(JSON.stringify(result, null, 2))
                  notify('浏览器偏好已保存')
                })
              }
            >
              保存偏好
            </button>
            <details>
              <summary>连接详情</summary>
              <pre>{browserInfo || '正在读取'}</pre>
            </details>
          </section>
        </>
      )}
      {section === 'island' && (
        <>
          <h1>灵动岛与提醒</h1>
          <section className="configuration-section">
            <label className="setting-toggle">
              <input
                type="checkbox"
                checked={prefs.islandEnabled}
                onChange={(event) => setPrefs({ ...prefs, islandEnabled: event.target.checked })}
              />
              启用灵动岛
            </label>
            <label className="setting-toggle">
              <input
                type="checkbox"
                checked={prefs.islandAttention}
                onChange={(event) => setPrefs({ ...prefs, islandAttention: event.target.checked })}
              />
              有问题或选项等待处理时，突出提醒
            </label>
            <p className="muted">
              边缘把手和紧凑条显示待处理标记，并进行短暂强调。点击展开问题与选项。
            </p>
            <label className="setting-toggle">
              <input
                type="checkbox"
                checked={prefs.islandDetailedNotifications}
                onChange={(event) =>
                  setPrefs({ ...prefs, islandDetailedNotifications: event.target.checked })
                }
              />
              紧凑提示中预览任务与问题内容
            </label>
            <p className="muted">
              关闭内容预览后，紧凑条仅显示通用状态，展开详情后可查看任务与问题。
            </p>
            <button
              className="button primary"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  onSaved(
                    await unwrap(
                      api.updatePreferences({
                        islandEnabled: prefs.islandEnabled,
                        islandAttention: prefs.islandAttention,
                        islandDetailedNotifications: prefs.islandDetailedNotifications,
                      }),
                    ),
                  )
                  notify('灵动岛设置已保存')
                })
              }
            >
              保存设置
            </button>
          </section>
        </>
      )}
      {section === 'startup' && (
        <>
          <h1>启动与窗口行为</h1>
          <section className="configuration-section">
            {(
              [
                ['launchOnLogin', '登录 Windows 时启动'],
                ['startHidden', '启动时保持主窗口隐藏'],
                ['closeToTray', '关闭主窗口后驻留托盘'],
              ] as const
            ).map(([key, label]) => (
              <label className="setting-toggle" key={key}>
                <input
                  type="checkbox"
                  checked={prefs[key]}
                  onChange={(event) => setPrefs({ ...prefs, [key]: event.target.checked })}
                />
                {label}
              </label>
            ))}
            <button
              className="button primary"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  onSaved(
                    await unwrap(
                      api.updatePreferences({
                        launchOnLogin: prefs.launchOnLogin,
                        startHidden: prefs.startHidden,
                        closeToTray: prefs.closeToTray,
                      }),
                    ),
                  )
                  notify('窗口设置已保存')
                })
              }
            >
              保存设置
            </button>
          </section>
        </>
      )}
    </div>
  )
}
