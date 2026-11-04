import { randomBytes } from 'node:crypto'

type Projection = { question: string; facts: string[] }
type Rule = { pattern: RegExp; secret: boolean }

// This is a conservative set of known forms, not a general semantic DLP classifier.
const rules: Rule[] = [
  {
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/gi,
    secret: true,
  },
  {
    pattern:
      /\b(?:proxy-authorization|authorization)["']?[ \t]*[:=][ \t]*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]+)/gi,
    secret: true,
  },
  { pattern: /\bBearer[ \t]+[A-Za-z0-9._~+/=-]+/gi, secret: true },
  { pattern: /\b(?:set-cookie|cookie)[ \t]*[:=][ \t]*[^\r\n]+/gi, secret: true },
  {
    pattern:
      /(?:\b(?:password|passwd|pwd|key|api[_ -]?key|access[_ -]?key|secret[_ -]?key|private[_ -]?key|access[_ -]?token|refresh[_ -]?token|auth[_ -]?token|session[_ -]?(?:token|id)|token|secret|cookie|set[_ -]?cookie|authorization|client[_ -]?secret)\b|密码|口令|密钥|令牌)["']?\s*(?:[:=：]|\bis\b|是|为)\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;；<>}\]\r\n]+)/gi,
    secret: true,
  },
  {
    pattern:
      /\b(?:sk-[A-Za-z0-9_-]{8,}|AKIA[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{15,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g,
    secret: true,
  },
  { pattern: /\b(?:https?|sftp|ftp|ssh):\/\/[^\s<>"'`]*:[^\s<>"'`]*@[^\s<>"'`]+/gi, secret: true },
  { pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, secret: false },
  { pattern: /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g, secret: false },
  { pattern: /(?<!\d)(?:\d{17}[\dXx]|\d{15})(?!\d)/g, secret: false },
  { pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, secret: false },
  { pattern: /\b(?:https?|sftp|ftp|ssh):\/\/[^\s<>"'`]+/gi, secret: false },
  { pattern: /(["'])(?:[A-Z]:[\\/]|\\\\)[^"'\r\n]+\1/gi, secret: false },
  {
    pattern: /\b[A-Z]:[\\/][^\s<>"'`|,;；，。！？()[\]{}]+|\\\\[^\s<>"'`|,;；，。！？()[\]{}]+/gi,
    secret: false,
  },
  {
    pattern:
      /(?<![\p{L}\p{N}_:/])\/(?:[\p{L}\p{N}_.~-]+\/)+[^\s<>"'`|,;；，。！？()[\]{}]*|(?<![\p{L}\p{N}_:/])\/(?:home|root|Users|mnt|tmp|var|etc|opt|srv|data|private|workspace|workspaces|usr|run|dev|media|Volumes|bin|sbin)(?![\p{L}\p{N}_.~-])|(?<![\p{L}\p{N}_:/])\/[\p{L}\p{N}_~-]+\.[\p{L}\p{N}_.~-]+/gu,
    secret: false,
  },
]

const tokenPattern = /\[LOCAL_[a-f0-9]{24}_\d+\]/g
const reservedPattern = /\[\s*LOCAL_|\[REMOVED_SECRET\]/i
const markerPattern = /<\s*\/?\s*(?:private|secret)\b/i
const removedSecret = '[REMOVED_SECRET]'

function fail(code: string): never {
  throw new Error(`PRIVACY_${code}`)
}

function variants(value: string): string[] {
  const bytes = Buffer.from(value, 'utf8')
  let encoded: string
  try {
    encoded = encodeURIComponent(value)
  } catch {
    return fail('INVALID_TEXT')
  }
  return [...new Set([value, encoded, bytes.toString('base64'), bytes.toString('base64url')])]
}

function hasRule(text: string, secretsOnly = false): boolean {
  return rules.some(({ pattern, secret }) => {
    if (secretsOnly && !secret) return false
    pattern.lastIndex = 0
    return pattern.test(text)
  })
}

/** Per-task substitutions stay in memory. dispose() drops references; JS cannot promise physical erasure. */
export class PrivacyVault {
  private prompt: string
  private context: string
  private namespace = randomBytes(12).toString('hex')
  private substitutions = new Map<string, string>()
  private tokens = new Map<string, string>()
  private secretValues = new Set<string>()
  private revokedTokens = new Set<string>()
  private disposed = false
  private nextToken = 0

  constructor(prompt: string, context: string) {
    if (typeof prompt !== 'string' || typeof context !== 'string') fail('INVALID_INPUT')
    if (reservedPattern.test(prompt) || reservedPattern.test(context)) fail('RESERVED_INPUT')
    this.prompt = prompt
    this.context = context
    this.checkMarkers(prompt)
    this.checkMarkers(context)
    // Establish the protected-value set even when callers check/restore before asking for masked input.
    this.maskInput()
  }

  maskInput(): { prompt: string; context: string } {
    this.alive()
    // Reapply the current map: semantic privateValues can be added after the first pass.
    const prompt = this.maskText(this.prompt)
    const context = this.maskText(this.context)
    return { prompt: this.replaceKnown(prompt), context: this.replaceKnown(context) }
  }

  protectProjection(projection: Projection, privateValues: string[]): Projection {
    this.alive()
    if (
      !projection ||
      typeof projection.question !== 'string' ||
      !Array.isArray(projection.facts) ||
      !projection.facts.every((fact) => typeof fact === 'string') ||
      !Array.isArray(privateValues) ||
      privateValues.length > 128
    )
      fail('INVALID_PROJECTION')
    const masked = this.maskInput()
    const sources = [this.prompt, this.context, masked.prompt, masked.context]
    // Validate the entire proposal before mutating its map; the model cannot invent source values.
    for (const value of privateValues) {
      if (
        typeof value !== 'string' ||
        !value.trim() ||
        value.length > 4096 ||
        !sources.some((source) => source.includes(value))
      )
        fail('UNGROUNDED_PRIVATE_VALUE')
      this.validateTokens(value)
      if (value.includes(removedSecret) || markerPattern.test(value)) fail('INVALID_PRIVATE_VALUE')
    }
    for (const value of privateValues) {
      if (this.tokens.has(value)) continue
      const original = value.replace(tokenPattern, (token) => this.tokens.get(token)!)
      const replacement = this.remember(original, hasRule(original, true))
      this.substitutions.set(value, replacement)
    }
    const result = {
      question: this.maskText(projection.question),
      facts: projection.facts.map((fact) => this.maskText(fact)),
    }
    result.question = this.replaceKnown(result.question)
    result.facts = result.facts.map((fact) => this.replaceKnown(fact))
    this.assertSafe(result)
    return result
  }

  assertSafe(value: unknown): void {
    this.alive()
    const seen = new Set<object>()
    const visit = (item: unknown, depth: number): void => {
      if (depth > 32) fail('INVALID_VALUE')
      if (typeof item === 'string') {
        this.validateTokens(item)
        const visible = this.withoutTokens(item).normalize('NFKC')
        if (markerPattern.test(visible) || hasRule(visible) || this.containsKnown(visible))
          fail('UNSAFE_EGRESS')
      } else if (item && typeof item === 'object') {
        if (seen.has(item)) fail('INVALID_VALUE')
        seen.add(item)
        if (Array.isArray(item)) item.forEach((entry) => visit(entry, depth + 1))
        else {
          if (
            Object.getPrototypeOf(item) !== Object.prototype &&
            Object.getPrototypeOf(item) !== null
          )
            fail('INVALID_VALUE')
          for (const [key, entry] of Object.entries(item)) {
            visit(key, depth + 1)
            visit(entry, depth + 1)
          }
        }
        seen.delete(item)
      } else if (
        item === null ||
        typeof item === 'boolean' ||
        (typeof item === 'number' && Number.isFinite(item))
      ) {
        if (item !== null && (hasRule(String(item)) || this.containsKnown(String(item))))
          fail('UNSAFE_EGRESS')
      } else fail('INVALID_VALUE')
    }
    visit(value, 0)
  }

  restore(text: string): string {
    this.alive()
    if (typeof text !== 'string') fail('INVALID_VALUE')
    this.validateTokens(text)
    const visible = this.withoutTokens(text)
    if (hasRule(visible, true) || this.containsKnown(visible, true)) fail('SECRET_IN_RESULT')
    const restored = text.replace(tokenPattern, (token) => this.tokens.get(token)!)
    if (
      hasRule(restored.replaceAll(removedSecret, ''), true) ||
      this.containsKnown(restored.replaceAll(removedSecret, ''), true)
    )
      fail('SECRET_IN_RESULT')
    return restored
  }

  dispose(): void {
    this.prompt = ''
    this.context = ''
    this.namespace = ''
    this.substitutions.clear()
    this.tokens.clear()
    this.secretValues.clear()
    this.revokedTokens.clear()
    this.disposed = true
  }

  private alive(): void {
    if (this.disposed) fail('DISPOSED')
  }

  private checkMarkers(text: string): void {
    let open: string | undefined
    let cursor = 0
    const pattern = /<\/?(?:private|secret)>/gi
    for (const match of text.matchAll(pattern)) {
      if (markerPattern.test(text.slice(cursor, match.index))) fail('INVALID_MARKER')
      const tag = match[0].toLowerCase()
      if (!tag.startsWith('</')) {
        if (open) fail('INVALID_MARKER')
        open = tag.slice(1, -1)
      } else {
        if (open !== tag.slice(2, -1)) fail('INVALID_MARKER')
        open = undefined
      }
      cursor = match.index! + match[0].length
    }
    if (open || markerPattern.test(text.slice(cursor))) fail('INVALID_MARKER')
  }

  private remember(value: string, secret: boolean): string {
    if (!value) return removedSecret
    if (secret || this.containsKnown(value, true)) {
      this.secretValues.add(value)
      this.substitutions.set(value, removedSecret)
      for (const [token, original] of this.tokens) {
        if (this.containsKnown(original, true)) {
          this.tokens.delete(token)
          this.revokedTokens.add(token)
          for (const [alias, replacement] of this.substitutions)
            if (replacement === token) this.substitutions.set(alias, removedSecret)
        }
      }
      return removedSecret
    }
    const previous = this.substitutions.get(value)
    if (previous) return previous
    const token = `[LOCAL_${this.namespace}_${++this.nextToken}]`
    this.tokens.set(token, value)
    this.substitutions.set(value, token)
    return token
  }

  private maskText(text: string): string {
    this.validateTokens(text)
    this.checkMarkers(text)
    // Secrets are discovered before identity spans, so a containing URL/private block cannot restore them.
    for (const { pattern, secret } of rules) {
      if (!secret) continue
      pattern.lastIndex = 0
      for (const match of text.matchAll(pattern)) this.rememberSecret(match[0])
    }
    let masked = text.replace(
      /<(private|secret)>([\s\S]*?)<\/\1>/gi,
      (_whole, kind: string, content: string) =>
        this.remember(content, kind.toLowerCase() === 'secret' || hasRule(content, true)),
    )
    masked = this.replaceKnown(masked)
    for (const { pattern, secret } of rules) {
      pattern.lastIndex = 0
      masked = this.outsideTokens(masked, (part) =>
        part.replace(pattern, (match) => this.remember(match, secret)),
      )
    }
    return this.replaceKnown(masked)
  }

  private rememberSecret(value: string): void {
    this.remember(value, true)
    let password = /^[a-z]+:\/\/[^:/@\s]*:([^@\s]+)@/i.exec(value)?.[1]
    try {
      // WHATWG URL handles empty usernames and escaped/embedded userinfo separators.
      if (/^[a-z]+:\/\//i.test(value)) password = new URL(value).password || password
    } catch {
      /* A malformed URL is still removed; preserve any extracted raw credential. */
    }
    if (password) {
      this.remember(password, true)
      try {
        this.remember(decodeURIComponent(password), true)
      } catch {
        /* Keep the raw encoded credential. */
      }
    }
    const bearer = /^Bearer\s+(.+)$/i.exec(value)
    if (bearer) this.remember(bearer[1], true)
    const assignment = /(?:[:=：]|\bis\b|是|为)\s*(.*)$/i.exec(value)
    if (assignment) {
      const body = assignment[1].trim().replace(/^["']|["']$/g, '')
      if (body) this.remember(body, true)
      if (/^(?:proxy-authorization|authorization)\b/i.test(value)) {
        const scheme = /^([A-Za-z][\w-]*)[ \t]+(.+)$/.exec(body)
        if (scheme) {
          const payload = scheme[2].trim()
          this.remember(payload, true)
          if (scheme[1].toLowerCase() === 'basic' && /^[A-Za-z0-9+/]+={0,2}$/.test(payload)) {
            const bytes = Buffer.from(payload, 'base64')
            const decoded = bytes.toString('utf8')
            if (
              bytes.toString('base64').replace(/=+$/, '') === payload.replace(/=+$/, '') &&
              Buffer.from(decoded, 'utf8').equals(bytes)
            ) {
              this.remember(decoded, true)
              const separator = decoded.indexOf(':')
              if (separator >= 0) this.remember(decoded.slice(separator + 1), true)
            }
          }
        }
      }
      if (/^(?:set-cookie|cookie)\b/i.test(value)) {
        for (const cookie of body.split(';')) {
          const split = cookie.indexOf('=')
          if (/^(?:path|domain|expires|max-age|samesite)$/i.test(cookie.slice(0, split).trim()))
            continue
          if (split >= 0 && cookie.slice(split + 1).trim())
            this.remember(cookie.slice(split + 1).trim(), true)
        }
      }
    }
  }

  private outsideTokens(text: string, transform: (part: string) => string): string {
    return text
      .split(/(\[LOCAL_[a-f0-9]{24}_\d+\]|\[REMOVED_SECRET\])/g)
      .map((part) => (this.tokens.has(part) || part === removedSecret ? part : transform(part)))
      .join('')
  }

  private replaceKnown(text: string): string {
    for (const token of this.revokedTokens) text = text.replaceAll(token, removedSecret)
    const entries = [...this.substitutions.keys(), ...this.tokens.keys(), removedSecret].sort(
      (a, b) => b.length - a.length,
    )
    // Existing tokens are atomic alternatives. Longer masked-source aliases may contain whole tokens;
    // short source strings never match inside them, and inserted tokens are not scanned again.
    const pattern = new RegExp(
      entries.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
      'g',
    )
    return text.replace(pattern, (match) => this.substitutions.get(match) ?? match)
  }

  private validateTokens(text: string): void {
    let remainder = text.replace(tokenPattern, (token) => {
      if (!this.tokens.has(token)) fail('UNKNOWN_TOKEN')
      return ''
    })
    remainder = remainder.replaceAll(removedSecret, '')
    if (/\[\s*LOCAL_/i.test(remainder)) fail('UNKNOWN_TOKEN')
  }

  private withoutTokens(text: string): string {
    return text.replace(tokenPattern, '').replaceAll(removedSecret, '')
  }

  private containsKnown(text: string, secretsOnly = false): boolean {
    const normalize = (value: string) =>
      value.normalize('NFKC').replace(/%[0-9a-f]{2}/gi, (hex) => hex.toUpperCase())
    const haystack = normalize(text)
    const values = secretsOnly ? this.secretValues : this.substitutions.keys()
    for (const value of values) {
      for (const variant of variants(value)) {
        if (variant && haystack.includes(normalize(variant))) return true
      }
    }
    return false
  }
}
