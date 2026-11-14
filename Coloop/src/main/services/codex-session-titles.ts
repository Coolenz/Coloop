import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AutoAgentSession, AutoAgentWorkSnapshot } from '../../shared/auto-agent-work'

/** Local display metadata only. Never read transcripts or infer names with a model. */
export class CodexSessionTitles {
  private titles = new Map<string, string>()
  private lastRead = -Infinity
  private pending?: Promise<void>
  constructor(
    private path = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'session_index.jsonl'),
    private now = Date.now,
  ) {}

  refresh(force = false): Promise<void> {
    if (this.pending) return this.pending
    if (!force && this.now() - this.lastRead < 5000) return Promise.resolve()
    this.lastRead = this.now()
    this.pending = this.read().finally(() => {
      this.pending = undefined
    })
    return this.pending
  }

  private async read() {
    try {
      const file = await open(this.path, 'r')
      try {
        const size = (await file.stat()).size
        if (size > 8 * 1024 * 1024) return
        const bytes = Buffer.alloc(size)
        const { bytesRead } = await file.read(bytes, 0, size, 0)
        const titles = new Map<string, string>()
        for (const line of bytes.subarray(0, bytesRead).toString('utf8').split('\n')) {
          if (!line.trim() || line.length > 8192) continue
          try {
            const row = JSON.parse(line)
            if (
              typeof row.id !== 'string' ||
              row.id.length > 160 ||
              typeof row.thread_name !== 'string'
            )
              continue
            const title = row.thread_name
              .replace(/[\u0000-\u001f\u007f]/g, ' ')
              .trim()
              .slice(0, 240)
            if (title) titles.set(row.id, title)
          } catch {
            /* A partially appended row must not hide other names. */
          }
        }
        this.titles = titles
      } finally {
        await file.close()
      }
    } catch {
      /* Missing local metadata does not block task execution. */
    }
  }

  session<T extends AutoAgentSession>(session: T): T {
    const title =
      session.source === 'chatgpt-desktop' ? this.titles.get(session.sessionId) : undefined
    return title ? { ...session, title } : session
  }

  snapshot(snapshot?: AutoAgentWorkSnapshot): AutoAgentWorkSnapshot | undefined {
    return (
      snapshot && {
        ...snapshot,
        sessions: snapshot.sessions.map((session) => this.session(session)),
        tasks: snapshot.tasks.map((task) => ({ ...task, session: this.session(task.session) })),
      }
    )
  }
}
