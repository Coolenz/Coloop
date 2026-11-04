import type { RemoteGatewaySnapshot } from './remote'

export interface MobileConnectionSnapshot {
  transport?: 'cloudflare' | 'relay'
  configuredEndpoint?: string
  gateway: RemoteGatewaySnapshot
  tunnel: {
    status: 'stopped' | 'starting' | 'online' | 'error'
    endpoint?: string
    error?: string
  }
}

/** Returned only after an explicit pairing action; never included in AppSnapshot. */
export interface MobilePairingView {
  uri: string
  qrDataUrl: string
  endpoint: string
  expiresAt: string
}
