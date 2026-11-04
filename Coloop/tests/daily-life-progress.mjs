import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

// File timestamps, polling IDs and new execution IDs do not prove task progress.
const metadata =
  /^(timestamp|collectedat|capturedat|computedat|savedat|startedat|finishedat|mtime|ctime|executionid|observationid|taskid|pid|hwnd)$/i
function stable(value) {
  if (typeof value === 'string') {
    try {
      return stable(JSON.parse(value))
    } catch {}
    return value
      .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, '<id>')
      .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)/g, '<capture-time>')
      .trim()
  }
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => !metadata.test(key.replace(/[_-]/g, '')))
        .map((key) => [key, stable(value[key])]),
    )
  return value
}
export function evidenceMarker(result) {
  if (result?.verified !== true || !result.evidence) return null
  const value = stable(result.evidence)
  if (!value || (typeof value === 'object' && Object.keys(value).length === 0)) return null
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export class ProgressMonitor {
  constructor(now, stallMs = 15 * 60 * 1000) {
    if (!Number.isFinite(stallMs) || stallMs <= 0) throw new Error('Invalid stall interval')
    this.stallMs = stallMs
    this.previousAt = now
    this.idleMs = 0
    this.waiting = false
    this.seen = new Set()
  }
  update(now, markers = [], waiting = false) {
    const fresh = [...new Set(markers.filter(Boolean))].filter((marker) => !this.seen.has(marker))
    for (const marker of fresh) this.seen.add(marker)
    if (fresh.length || (this.waiting && !waiting)) this.idleMs = 0
    else if (!waiting && !this.waiting) this.idleMs += Math.max(0, now - this.previousAt)
    this.previousAt = now
    this.waiting = waiting
    return {
      state: waiting ? 'waiting_user' : this.idleMs >= this.stallMs ? 'stalled' : 'running',
      idle_ms: this.idleMs,
      new_evidence: fresh.length,
    }
  }
}

export class ReceiptProgressReader {
  constructor(directory) {
    this.directory = directory
    this.cache = new Map()
  }
  async read() {
    const entries = await readdir(this.directory, { withFileTypes: true }).catch(() => [])
    const markers = []
    for (const entry of entries.filter((entry) => entry.isDirectory())) {
      const file = join(this.directory, entry.name, 'result.json')
      try {
        const info = await stat(file)
        const key = `${info.mtimeMs}:${info.size}`
        let cached = this.cache.get(file)
        if (cached?.key !== key) {
          cached = { key, marker: evidenceMarker(JSON.parse(await readFile(file, 'utf8'))) }
          this.cache.set(file, cached)
        }
        if (cached.marker) markers.push(cached.marker)
      } catch {} // Missing/locked/incomplete diagnostics are observed again next poll.
    }
    return markers
  }
}
