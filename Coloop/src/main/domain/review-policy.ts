import { realpath, stat, open } from 'node:fs/promises'
import { isAbsolute, relative, sep, extname, posix } from 'node:path'
import type { ReviewEvent } from '../../shared/coordinator'
import type { ManagedEvidence } from '../../shared/managed'

export type PolicyResult =
  | { decision: 'deny' | 'defer'; reasonCode: string }
  | {
      decision: 'candidate'
      prompt: string
      choiceIds?: string[]
      choiceKinds?: ('skip' | 'offline')[]
      readSummary?: { tool: string; files: number; extensions: string[] }
    }

// These checks deliberately prefer an unanswered request to a privacy leak.
const sensitivePath =
  /(?:^|[\\/])(?:\.env(?:\.[^\\/]*)?|\.ssh|\.aws|\.azure|\.git|\.npmrc|\.pypirc|\.netrc|AGENTS\.md|id_rsa|id_ed25519|authorized_keys|known_hosts)(?:[\\/]|$)|(?:secret|credential|password|passwd|private[_-]?key|api[_-]?key|access[_-]?token|cookies|keychain|login data)|(?:^|[\\/])config[\\/]board\.json$/i
const secretOrPii =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{8,}|\bBearer\s+[A-Za-z0-9._~+/-]{8,}|(?:api[_-]?key|password|passwd|access[_-]?token|secret)\s*[=:]\s*["']?[^\s"',;}{]{4,}|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|(?<!\d)1[3-9]\d{9}(?!\d)|(?<!\d)\d{17}[\dX](?!\d)/i
const dangerous =
  /\b(?:upload|exfiltrat\w*|curl|wget|invoke-webrequest|send-mailmessage|scp|sftp|ssh|rsync|publish|deploy|delete|remove|erase|format|wipe|sudo|chmod|chown|powershell|cmd\.exe|bash)\b|上传|外传|联网|发往|发送到|发布|部署|删除|清空|格式化|付款|支付|转账|凭据|密码|身份证|手机号|住址|通讯录|隐私数据|个人信息/i
const supportedExtensions = new Set([
  '.py',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.c',
  '.cpp',
  '.h',
  '.hpp',
  '.rs',
  '.go',
  '.java',
  '.css',
  '.html',
  '.md',
  '.json',
  '.toml',
  '.yaml',
  '.yml',
])

function containsSensitive(value: string) {
  return sensitivePath.test(value) || secretOrPii.test(value)
}

/** Metadata is authenticated separately; this routine never trusts a source's route claim. */
export function managedReadPolicy(value: ManagedEvidence): PolicyResult {
  const path = value.relativePath
  if (
    path.startsWith('/') ||
    /[\\:\x00-\x1f*?\[\]{}]/.test(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))
  )
    return { decision: 'deny', reasonCode: 'UNSAFE_MANAGED_PATH' }
  if (containsSensitive(path) || path.split('/').includes('node_modules'))
    return { decision: 'deny', reasonCode: 'SENSITIVE_PATH' }
  if (
    (!supportedExtensions.has(value.extension) && value.extension !== '.txt') ||
    posix.extname(path).toLowerCase() !== value.extension
  )
    return { decision: 'deny', reasonCode: 'UNSUPPORTED_MANAGED_FILE' }
  if (value.returnedBytes > value.bytes || value.truncated !== value.returnedBytes < value.bytes)
    return { decision: 'deny', reasonCode: 'INVALID_SNAPSHOT_BOUNDS' }
  return {
    decision: 'candidate',
    readSummary: { tool: 'coloop_read', files: 1, extensions: [value.extension] },
    prompt: `Managed offline read. Frozen source snapshot was scanned by the enrolled tool. Local RK route only; no cloud or memory writes. Output 1 to allow this snapshot once, 0 to deny, 2 to defer. File ${value.extension}; ${value.returnedBytes} bytes.`,
  }
}

function safeChoice(text: string): 'skip' | 'offline' | undefined {
  const normalized = text.trim().replace(/\s+/g, ' ')
  if (
    /^(?:取消本次操作并保持当前状态|跳过本次操作并保持当前状态|保持当前状态，不执行任何操作|Cancel this operation and keep the current state|Skip this operation without making changes)[。.!]?$/i.test(
      normalized,
    )
  )
    return 'skip'
  if (
    /^(?:仅在本地离线分析，不上传任何数据|只在本机离线处理，不向外部发送数据|Keep all processing offline on this device; do not upload any data)[。.!]?$/i.test(
      normalized,
    )
  )
    return 'offline'
  return undefined
}

export async function evaluateReviewPolicy(
  event: ReviewEvent,
  workspaceRoots: string[] = [],
): Promise<PolicyResult> {
  if (event.managed) return { decision: 'defer', reasonCode: 'MANAGED_AUTHORITY_REQUIRED' }
  if (!isAbsolute(event.workspace) || /[\x00-\x1f]/.test(event.workspace))
    return { decision: 'deny', reasonCode: 'INVALID_WORKSPACE' }
  if (containsSensitive(event.workspace))
    return { decision: 'deny', reasonCode: 'SENSITIVE_WORKSPACE' }
  let workspace: string
  try {
    workspace = await realpath(event.workspace)
    if (!(await stat(workspace)).isDirectory())
      return { decision: 'deny', reasonCode: 'INVALID_WORKSPACE' }
  } catch {
    return { decision: 'defer', reasonCode: 'WORKSPACE_UNAVAILABLE' }
  }
  let trusted = false
  for (const root of workspaceRoots) {
    try {
      if (!isAbsolute(root)) continue
      const resolved = await realpath(root)
      const inside = relative(resolved, workspace)
      if (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)) trusted = true
    } catch {
      /* An unavailable configured root never grants permission. */
    }
  }
  if (!trusted) return { decision: 'deny', reasonCode: 'UNTRUSTED_WORKSPACE' }
  if (event.kind === 'question') {
    if (!event.question || !event.choices || event.tool || event.patterns || event.command)
      return { decision: 'deny', reasonCode: 'INVALID_QUESTION' }
    if (secretOrPii.test(event.question) || sensitivePath.test(event.question))
      return { decision: 'deny', reasonCode: 'SENSITIVE_CONTENT' }
    if (new Set(event.choices.map((choice) => choice.id)).size !== event.choices.length)
      return { decision: 'deny', reasonCode: 'DUPLICATE_CHOICES' }
    const safe = event.choices.flatMap((choice) => {
      const text = [choice.label, choice.description].filter(Boolean).join(' ')
      const category = safeChoice(text)
      return category && !containsSensitive(text) ? [{ id: choice.id, category }] : []
    })
    if (!safe.length) return { decision: 'defer', reasonCode: 'NO_SAFE_CHOICE' }
    return {
      decision: 'candidate',
      choiceIds: safe.map((choice) => choice.id),
      choiceKinds: safe.map((choice) => choice.category),
      prompt: [
        '你是本地隐私审查助手。下面是经过规则筛选的选项类型，不包含原始文件或凭据。',
        '固定用户策略：offline 表示仅在本机离线分析且不上传数据，优先选择它；',
        '没有 offline 时选择 skip，skip 表示取消本次操作并保持状态。',
        '所有列表项都已通过本地安全规则。相同类别选择列表第一项；只有一个候选也选择其真实 ID。',
        '列表非空时按上述策略选一个 ID，不需要用户再次审批。只能复制列表中已有的 ID。',
        '只输出一个 JSON 对象，字段为 decision 和 choiceId，decision 值为 select。',
        '不要解释，不要 Markdown。只有无法按策略输出合法选择时才输出 {"decision":"defer"}。',
        JSON.stringify({ kind: 'question', choices: safe }),
      ].join('\n'),
    }
  }
  if (event.question || event.choices || event.command !== undefined)
    return { decision: 'deny', reasonCode: 'COMMAND_OR_MIXED_REQUEST' }
  if (!event.tool || !['read', 'glob', 'grep', 'list'].includes(event.tool))
    return { decision: 'deny', reasonCode: 'UNSUPPORTED_PERMISSION' }
  if (!event.patterns?.length) return { decision: 'deny', reasonCode: 'MISSING_PATHS' }
  const extensions = new Set<string>()
  for (const path of event.patterns) {
    if (!isAbsolute(path) || /[\x00-\x1f*?\[\]{}]/.test(path) || path.split(/[\\/]/).includes('..'))
      return { decision: 'deny', reasonCode: 'UNSAFE_PATH' }
    if (containsSensitive(path) || dangerous.test(path))
      return { decision: 'deny', reasonCode: 'SENSITIVE_PATH' }
    try {
      const resolved = await realpath(path)
      const inside = relative(workspace, resolved)
      if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside))
        return { decision: 'deny', reasonCode: 'OUTSIDE_WORKSPACE' }
      if (containsSensitive(resolved)) return { decision: 'deny', reasonCode: 'SENSITIVE_PATH' }
      const info = await stat(resolved)
      // Directory requests can recursively include .env or other unknown private files.
      if (!info.isFile() || !supportedExtensions.has(extname(resolved).toLowerCase()))
        return { decision: 'defer', reasonCode: 'UNBOUNDED_FILE_SCOPE' }
      if (info.size > 256 * 1024) return { decision: 'defer', reasonCode: 'CONTENT_SCAN_LIMIT' }
      const handle = await open(resolved, 'r')
      try {
        const before = await handle.stat()
        if (
          !before.isFile() ||
          before.dev !== info.dev ||
          before.ino !== info.ino ||
          before.mtimeMs !== info.mtimeMs ||
          before.size !== info.size
        )
          return { decision: 'defer', reasonCode: 'FILE_CHANGED' }
        const buffer = Buffer.alloc(256 * 1024 + 1)
        let bytes = 0
        while (bytes < buffer.length) {
          const result = await handle.read(buffer, bytes, buffer.length - bytes, bytes)
          if (!result.bytesRead) break
          bytes += result.bytesRead
        }
        const after = await handle.stat()
        if (bytes > 256 * 1024 || after.size > 256 * 1024)
          return { decision: 'defer', reasonCode: 'CONTENT_SCAN_LIMIT' }
        const current = await stat(resolved)
        if (
          after.mtimeMs !== before.mtimeMs ||
          after.size !== before.size ||
          current.dev !== before.dev ||
          current.ino !== before.ino ||
          current.mtimeMs !== before.mtimeMs ||
          current.size !== before.size ||
          (await realpath(path)) !== resolved
        )
          return { decision: 'defer', reasonCode: 'FILE_CHANGED' }
        const content = buffer.subarray(0, bytes)
        if (content.includes(0)) return { decision: 'deny', reasonCode: 'BINARY_CONTENT' }
        if (secretOrPii.test(content.toString('utf8')))
          return { decision: 'deny', reasonCode: 'SENSITIVE_CONTENT' }
      } finally {
        await handle.close()
      }
      extensions.add(extname(resolved).toLowerCase())
    } catch {
      return { decision: 'defer', reasonCode: 'PATH_UNAVAILABLE' }
    }
  }
  return {
    decision: 'candidate',
    readSummary: {
      tool: event.tool,
      files: event.patterns.length,
      extensions: [...extensions].sort(),
    },
    prompt: [
      '你是本地隐私审查助手。规则已验证请求只读取工作区中明确存在的普通源码文件，',
      '没有命令、通配、目录遍历、已检测到的凭据或个人信息；但扫描不能证明文件无隐私。',
      '你只能进一步拒绝、保留等待，或允许这一次只读请求。不可执行操作。',
      '严格只输出 {"decision":"allow"}、{"decision":"deny"} 或 {"decision":"defer"}。',
      JSON.stringify({
        kind: 'permission',
        tool: event.tool,
        fileCount: event.patterns.length,
        extensions: [...extensions].sort(),
        scope: 'exact_workspace_source_files',
      }),
    ].join('\n'),
  }
}
