import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { relayConfigurationSchema, type RelayConfiguration } from '../../shared/relay'
import type { SecretCodec } from './store'

export class RemoteRelayConfig {
  private configuration?: RelayConfiguration
  private file: string
  private loadError?: string
  constructor(
    directory: string,
    private codec: SecretCodec,
  ) {
    this.file = join(directory, 'mobile-server.json')
    if (existsSync(this.file)) {
      try {
        if (lstatSync(this.file).isSymbolicLink() || lstatSync(this.file).size > 32768)
          throw new Error('INVALID_CONFIG')
        const stored = JSON.parse(readFileSync(this.file, 'utf8'))
        this.configuration = relayConfigurationSchema.parse({
          version: 1,
          endpoint: stored.endpoint,
          token: codec.decrypt(stored.encryptedToken),
          accessKey: codec.decrypt(stored.encryptedAccessKey),
        })
      } catch {
        this.loadError = '手机服务器配置无法解密，请重新导入连接配置'
      }
    }
  }
  current() {
    if (this.loadError) throw new Error(this.loadError)
    return this.configuration ? { ...this.configuration } : undefined
  }
  endpoint() {
    return this.configuration?.endpoint
  }
  configured() {
    return !!this.configuration || !!this.loadError
  }
  error() {
    return this.loadError
  }
  import(raw: string) {
    let config: RelayConfiguration
    try {
      config = relayConfigurationSchema.parse(JSON.parse(raw))
    } catch {
      throw new Error('服务器连接文件无效，请选择服务器生成的 Coloop JSON 配置')
    }
    const data = JSON.stringify({
      version: 1,
      endpoint: config.endpoint,
      encryptedToken: this.codec.encrypt(config.token),
      encryptedAccessKey: this.codec.encrypt(config.accessKey),
    })
    const temporary = `${this.file}.${randomUUID()}.pending`
    writeFileSync(temporary, data, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    renameSync(temporary, this.file)
    this.configuration = config
    this.loadError = undefined
  }
}
