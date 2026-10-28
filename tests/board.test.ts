import { generateKeyPairSync } from 'node:crypto'
import { Server, utils } from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BoardGateway, fingerprintOf } from '../src/main/infrastructure/board'

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { format: 'pem', type: 'pkcs1' },
  publicKeyEncoding: { format: 'pem', type: 'pkcs1' },
})
const key = utils.parseKey(privateKey)
if (key instanceof Error || Array.isArray(key)) throw new Error('Cannot generate SSH fixture')
const fingerprint = fingerprintOf(key.getPublicSSH())
const health = {
  hostname: 'fixture-board',
  chip: 'rk3588',
  memoryTotalMb: 16000,
  memoryAvailableMb: 14000,
  temperatureC: 40,
  uptimeSeconds: 100,
  qwenReady: true,
}
const cleanup: (() => void)[] = []
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose())
})

async function fixture() {
  let authentications = 0
  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    cleanup.push(() => client.end())
    client.on('error', () => {})
    client.on('authentication', (context) => {
      authentications++
      context.method === 'password' && context.password === 'test-password'
        ? context.accept()
        : context.reject()
    })
    client.on('ready', () =>
      client.on('session', (accept) => {
        const session = accept()
        session.on('exec', (accept) => {
          const stream = accept()
          stream.write(JSON.stringify(health))
          stream.exit(0)
          stream.end()
        })
      }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => server.close())
  const address = server.address()
  if (typeof address !== 'object' || !address) throw new Error('Missing port')
  return {
    config: { host: '127.0.0.1', port: address.port, username: 'cat', fingerprint },
    authentications: () => authentications,
  }
}
describe('SSH device identity and health transport', () => {
  it('validates the pinned host key before receiving board health', async () => {
    const { config } = await fixture()
    const gateway = new BoardGateway(vi.fn())
    cleanup.push(() => gateway.disconnect())
    const state = await gateway.connect(config, 'test-password')
    expect(state.status).toBe('connected')
    expect(state.hostname).toBe('fixture-board')
    expect(state.temperatureC).toBe(40)
    gateway.disconnect()
    expect(gateway.state.status).toBe('disconnected')
  })
  it('refuses a substituted host before transmitting the password', async () => {
    const { config, authentications } = await fixture()
    const gateway = new BoardGateway(vi.fn())
    cleanup.push(() => gateway.disconnect())
    await expect(
      gateway.connect({ ...config, fingerprint: 'A'.repeat(43) }, 'test-password'),
    ).rejects.toThrow('设备指纹不匹配')
    expect(authentications()).toBe(0)
    expect(gateway.state.status).toBe('error')
  })
  it('reports a transport failure when a disconnected board is queried', async () => {
    const gateway = new BoardGateway(vi.fn())
    await expect(gateway.refresh()).rejects.toThrow('请先')
  })
})
