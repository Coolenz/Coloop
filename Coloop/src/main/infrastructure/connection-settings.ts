import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { BoardConfig } from '../../shared/contracts'
import type { SecretCodec } from './store'

const schema = z
  .object({
    version: z.literal(1),
    enabled: z.boolean(),
    mobileEnabled: z.boolean(),
    mobileSelected: z.boolean(),
    binding: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    encryptedPassword: z.string().min(1).max(32768).optional(),
  })
  .strict()
export class ConnectionSettings {
  private value: z.infer<typeof schema> = {
    version: 1,
    enabled: true,
    mobileEnabled: true,
    mobileSelected: false,
  }
  private damaged = false
  constructor(
    private directory: string,
    private codec: SecretCodec,
  ) {
    if (existsSync(this.path())) {
      try {
        const raw = readFileSync(this.path(), 'utf8')
        if (raw.length > 40000) throw new Error('INVALID_CONNECTION_SETTINGS')
        this.value = schema.parse(JSON.parse(raw))
        // Disconnect pauses this run only. Migrate older persisted pauses so
        // launching the desktop always reconnects an already paired RK.
        this.value.enabled = true
      } catch {
        this.damaged = true
      }
    }
  }
  private path() {
    return join(this.directory, 'auto-connection.json')
  }
  private binding(config: BoardConfig) {
    return createHash('sha256')
      .update(
        JSON.stringify([
          config.host,
          config.port,
          config.username,
          config.fingerprint.replace(/^SHA256:/, ''),
        ]),
      )
      .digest('hex')
  }
  get enabled() {
    return !this.damaged && this.value.enabled
  }
  get mobileEnabled() {
    return !this.damaged && this.value.mobileEnabled
  }
  get mobileSelected() {
    return this.value.mobileSelected
  }
  hasCredential(config: BoardConfig) {
    return (
      !this.damaged && this.value.binding === this.binding(config) && !!this.value.encryptedPassword
    )
  }
  password(config: BoardConfig) {
    if (!this.hasCredential(config)) return undefined
    try {
      return this.codec.decrypt(this.value.encryptedPassword!)
    } catch {
      throw new Error('自动连接凭据无法解密，请在设备管理重新连接一次')
    }
  }
  remember(config: BoardConfig, password: string) {
    this.value = {
      ...this.value,
      enabled: true,
      binding: this.binding(config),
      encryptedPassword: this.codec.encrypt(password),
    }
    this.damaged = false
    this.save()
  }
  setEnabled(enabled: boolean) {
    this.value.enabled = enabled
  }
  setMobile(enabled: boolean) {
    this.value.mobileEnabled = enabled
    this.value.mobileSelected = true
    this.save()
  }
  private save() {
    if (this.damaged) throw new Error('自动连接配置损坏，请重新连接 RK 后保存')
    mkdirSync(this.directory, { recursive: true })
    const temporary = this.path() + '.tmp'
    writeFileSync(temporary, JSON.stringify({ ...this.value, enabled: true }), {
      mode: 0o600,
      flush: true,
    })
    renameSync(temporary, this.path())
  }
}
