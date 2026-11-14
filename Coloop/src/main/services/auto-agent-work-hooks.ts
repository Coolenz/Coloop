import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { autoWorkNativeEvents } from './chatgpt-desktop-adapter'
import type { AutoAgentHookStatus } from '../../shared/auto-agent-work'

type Group = { hooks: Record<string, unknown>[] }
type Config = Record<string, unknown> & { hooks?: Record<string, unknown[]> }
interface Registry {
  version: 1
  entries: { event: string; group: Group }[]
}
export interface AutoWorkHookInstallOptions {
  workspace: string
  nodePath: string
  scriptPath: string
  connectionPath: string
}
const registryName = 'coloop-auto-work-hooks.json'
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const exact = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Installs only owned project hook definitions. Never edits trust records or global config. */
export class AutoAgentWorkHooks {
  private chain: Promise<unknown> = Promise.resolve()
  private observed = new Set<string>()
  markObserved(workspace: string) {
    this.observed.add(workspace.toLowerCase())
  }
  private run<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.chain.then(operation)
    this.chain = next.catch(() => {})
    return next
  }
  private async directory(workspace: string, create = false) {
    if (!isAbsolute(workspace)) throw new Error('HOOK_WORKSPACE_REQUIRED')
    const root = await realpath(workspace)
    const directory = join(root, '.codex')
    if (create) await mkdir(directory, { recursive: true })
    try {
      const stat = await lstat(directory)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('HOOK_CONFIG_LINK_REJECTED')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return { root, directory }
  }
  private async read(path: string): Promise<string | undefined> {
    try {
      const stat = await lstat(path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 262144)
        throw new Error('HOOK_CONFIG_INVALID')
      return await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }
  private config(text?: string): Config {
    const value = text === undefined ? {} : JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('HOOK_CONFIG_INVALID')
    if (
      value.hooks !== undefined &&
      (!value.hooks ||
        typeof value.hooks !== 'object' ||
        Array.isArray(value.hooks) ||
        Object.values(value.hooks).some((item) => !Array.isArray(item)))
    )
      throw new Error('HOOK_CONFIG_INVALID')
    return value
  }
  private registry(text?: string): Registry {
    if (!text) return { version: 1, entries: [] }
    const value = JSON.parse(text)
    if (
      value.version !== 1 ||
      !Array.isArray(value.entries) ||
      value.entries.length > 32 ||
      value.entries.some(
        (entry: { event?: string; group?: Group }) =>
          !autoWorkNativeEvents.includes(entry.event as (typeof autoWorkNativeEvents)[number]) ||
          !Array.isArray(entry.group?.hooks) ||
          entry.group.hooks.length !== 1 ||
          entry.group.hooks[0].type !== 'command' ||
          entry.group.hooks[0].statusMessage !== 'Coloop Auto Work' ||
          typeof entry.group.hooks[0].command !== 'string' ||
          !entry.group.hooks[0].command.includes('auto-agent-work-hook.mjs') ||
          !entry.group.hooks[0].command.includes('--connection'),
      )
    )
      throw new Error('HOOK_REGISTRY_INVALID')
    return value
  }
  private async replace(path: string, prior: string | undefined, text: string) {
    const pending = `${path}.${randomUUID()}.pending`
    try {
      await writeFile(pending, text, { flag: 'wx', mode: 0o600 })
      if ((await this.read(path)) !== prior) throw new Error('HOOK_CONFIG_CHANGED')
      await rename(pending, path)
    } finally {
      await unlink(pending).catch(() => {})
    }
  }
  async status(
    workspace: string,
  ): Promise<AutoAgentHookStatus & { workspace: string; desktopVerified: false; detail: string }> {
    const { root, directory } = await this.directory(workspace)
    const registry = this.registry(await this.read(join(directory, registryName)))
    const config = this.config(await this.read(join(directory, 'hooks.json')))
    const installed =
      registry.entries.length > 0 &&
      registry.entries.every((entry) =>
        config.hooks?.[entry.event]?.some((group) => exact(group, entry.group)),
      )
    return {
      workspace: root,
      installed,
      configPath: join(directory, 'hooks.json'),
      trust: installed
        ? this.observed.has(root.toLowerCase())
          ? ('observed' as const)
          : ('review_required' as const)
        : ('unknown' as const),
      desktopVerified: false as const,
      detail: installed
        ? '请在桌面 Settings > Hooks 审核；收到回调仅证明 Hook 运行，桌面续推仍需验收。'
        : '尚未安装项目 Hook。',
    }
  }
  install(options: AutoWorkHookInstallOptions) {
    return this.run(async () => {
      const { directory, root } = await this.directory(options.workspace, true)
      for (const path of [options.nodePath, options.scriptPath, options.connectionPath]) {
        if (!isAbsolute(path) || /[\r\n"`$]/.test(path))
          throw new Error('HOOK_COMMAND_PATH_INVALID')
        if (!(await lstat(path)).isFile()) throw new Error('HOOK_COMMAND_FILE_REQUIRED')
      }
      const quoted = (value: string) => `'${value.replaceAll("'", "''")}'`
      const command = `powershell.exe -NoLogo -NoProfile -NonInteractive -Command "& ${quoted(options.nodePath)} ${quoted(options.scriptPath)} '--connection' ${quoted(options.connectionPath)}"`
      const configPath = join(directory, 'hooks.json')
      const registryPath = join(directory, registryName)
      const before = await this.read(configPath)
      const priorRegistry = await this.read(registryPath)
      const config = this.config(before)
      const previous = this.registry(priorRegistry)
      config.hooks ??= {}
      for (const entry of previous.entries) {
        config.hooks[entry.event] = (config.hooks[entry.event] ?? []).filter(
          (group) => !exact(group, entry.group),
        )
      }
      const entries = autoWorkNativeEvents.map((event) => ({
        event,
        group: {
          hooks: [
            {
              type: 'command',
              command,
              commandWindows: command,
              timeout: event === 'SessionEnd' || event === 'Interrupt' ? 1 : 3,
              ...([
                'PostToolUse',
                'PreCompact',
                'PostCompact',
                'SubagentStart',
                'SubagentStop',
                'PostModelRequest',
              ].includes(event)
                ? { async: true }
                : {}),
              statusMessage: 'Coloop Auto Work',
            },
          ],
        },
      }))
      for (const entry of entries)
        config.hooks[entry.event] = [...(config.hooks[entry.event] ?? []), entry.group]
      // Retain both known definitions until config replacement succeeds. A concurrent edit must
      // not orphan the previous owned hooks or make a retry install a second copy.
      const recoveryEntries = [...previous.entries, ...entries].filter(
        (entry, index, all) =>
          all.findIndex(
            (other) => other.event === entry.event && exact(other.group, entry.group),
          ) === index,
      )
      await this.replace(
        registryPath,
        priorRegistry,
        JSON.stringify({ version: 1, entries: recoveryEntries }, null, 2) + '\n',
      )
      await this.replace(configPath, before, JSON.stringify(config, null, 2) + '\n')
      await this.replace(
        registryPath,
        JSON.stringify({ version: 1, entries: recoveryEntries }, null, 2) + '\n',
        JSON.stringify({ version: 1, entries }, null, 2) + '\n',
      )
      this.observed.delete(root.toLowerCase())
      return this.status(root)
    })
  }
  uninstall(workspace: string) {
    return this.run(async () => {
      const { root, directory } = await this.directory(workspace)
      const configPath = join(directory, 'hooks.json')
      const registryPath = join(directory, registryName)
      const registryText = await this.read(registryPath)
      const registry = this.registry(registryText)
      const before = await this.read(configPath)
      const config = this.config(before)
      for (const entry of registry.entries) {
        if (!config.hooks?.[entry.event]) continue
        config.hooks[entry.event] = config.hooks[entry.event].filter(
          (group) => !exact(group, entry.group),
        )
        if (!config.hooks[entry.event].length) delete config.hooks[entry.event]
      }
      if (registry.entries.length && before !== undefined)
        await this.replace(configPath, before, JSON.stringify(config, null, 2) + '\n')
      if (registryText !== undefined && (await this.read(registryPath)) === registryText)
        await unlink(registryPath)
      this.observed.delete(root.toLowerCase())
      return this.status(root)
    })
  }
  /** Hash for diagnostics only; it is not Codex's trust hash and never grants trust. */
  async definitionDigest(workspace: string) {
    const { directory } = await this.directory(workspace)
    const text = await this.read(join(directory, registryName))
    return text === undefined ? undefined : hash(text)
  }
}
