import type { Client, ClientChannel } from 'ssh2'

/** Payload goes to stdin, never shell arguments, task history, model requests or stderr. */
export function credentialRequest(
  client: Client,
  body: Record<string, unknown>,
  allowed?: () => Promise<boolean>,
  target: 'vault' | 'memory' = 'vault',
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let stream: ClientChannel | undefined
    let output = '',
      settled = false,
      pulsing = false
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let pending: unknown
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearInterval(heartbeat)
      client.removeListener('close', disconnected)
      stream?.close()
      if (error) reject(error)
      else resolve(pending)
    }
    const disconnected = () =>
      finish(new Error('凭据连接已中断；若开始填入，请检查页面，勿自动重试'))
    const timeout = setTimeout(
      () => finish(new Error('凭据操作超时；填入结果可能不完整，请检查页面')),
      15_000,
    )
    client.once('close', disconnected)
    client.exec(
      target === 'memory'
        ? '/usr/bin/python3 -I /usr/local/lib/rk-credential-vault/credential_memory_client.py'
        : '/usr/bin/python3 -I /usr/local/lib/rk-credential-vault/credential_client.py',
      (error, channel) => {
        if (error) return finish(new Error('RK 私密凭据服务未就绪'))
        stream = channel
        if (settled) {
          stream.close()
          return
        }
        stream.setEncoding('utf8')
        stream.stderr.resume() // Never echo remote exception text to the UI or logs.
        stream.on('error', disconnected)
        stream.on('data', (chunk: string) => {
          output += chunk
          if (output.length > (target === 'memory' ? 524288 : 32768))
            return finish(new Error('记忆服务回包无效'))
          while (output.includes('\n')) {
            const end = output.indexOf('\n')
            const line = output.slice(0, end)
            output = output.slice(end + 1)
            let result: { ok?: boolean; state?: string; value?: unknown; error?: string }
            try {
              result = JSON.parse(line)
            } catch {
              return finish(new Error('凭据服务回包无效'))
            }
            if (result.ok !== true) {
              const messages: Record<string, string> = {
                REQUEST_ALREADY_USED: '这次填入已使用，不能重复执行',
                TARGET_MISMATCH: '记录与登录网站不匹配，已阻止填入',
                INPUT_OUTCOME_UNKNOWN: '填入已中止，结果可能不完整；请检查页面，勿自动重试',
                UNSUPPORTED_TEXT: '账号和密码需为 1–64 个英文、数字或键盘符号，不含换行或制表符',
                VAULT_FULL: '凭据库已达 100 条，请先删除不再使用的记录',
                MEMORY_UNAVAILABLE: '统一记忆服务不可用、正忙或请求被拒绝，请检查 RK 后刷新',
              }
              return finish(
                new Error(messages[result.error ?? ''] ?? 'RK 私密凭据服务未就绪或请求被拒绝'),
              )
            }
            if (result.state === 'awaiting_focus') {
              const pulse = async () => {
                if (pulsing || settled) return
                pulsing = true
                try {
                  if (!allowed || !(await allowed())) {
                    clearInterval(heartbeat)
                    stream?.end()
                  } else if (!settled)
                    stream?.write(JSON.stringify({ continue: body.requestId }) + '\n')
                } catch {
                  clearInterval(heartbeat)
                  stream?.end()
                } finally {
                  pulsing = false
                }
              }
              if (heartbeat) return finish(new Error('凭据服务回包无效'))
              heartbeat = setInterval(() => void pulse(), 65)
              void pulse()
            } else {
              pending = result.value
              finish()
            }
          }
        })
        stream.once('close', () => {
          if (!settled) disconnected()
        })
        stream.write(JSON.stringify(body) + '\n')
        if (!allowed) stream.end()
      },
    )
  })
}
