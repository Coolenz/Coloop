import { useEffect, useState } from 'react'
import { Copy, FileInput, LoaderCircle, QrCode, Smartphone, Unplug, X } from 'lucide-react'
import type { AppSnapshot } from '../../shared/contracts'
import type { MobilePairingView } from '../../shared/mobile'
import { api, unwrap } from './api'
import './mobile-remote.css'

export function MobileRemotePanel({ snapshot }: { snapshot: AppSnapshot }) {
  const mobile = snapshot.mobile
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [pairing, setPairing] = useState<MobilePairingView>()
  const [remaining, setRemaining] = useState(0)
  const online = mobile?.tunnel.status === 'online'
  useEffect(() => {
    if (!pairing) return
    const update = () => {
      const value = Math.max(0, Math.ceil((Date.parse(pairing.expiresAt) - Date.now()) / 1000))
      setRemaining(value)
      if (!value) setPairing(undefined)
    }
    update()
    const timer = setInterval(update, 1000)
    return () => clearInterval(timer)
  }, [pairing])
  useEffect(() => {
    if (!online) setPairing(undefined)
  }, [online])
  async function perform(action: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="mobile-remote" aria-label="安卓手机连接">
      <div className="section-bar mobile-remote-heading">
        <div>
          <h2>
            <Smartphone size={18} aria-hidden="true" />
            安卓手机连接
          </h2>
          <p>
            {mobile?.transport === 'relay'
              ? '通过自己的服务器，用手机查看和控制电脑会话。'
              : '导入自己的服务器配置，或使用 Cloudflare 临时连接。'}
          </p>
        </div>
        <span className="mobile-remote-status" role="status">
          {mobile?.tunnel.status === 'starting'
            ? '正在建立公网连接'
            : online
              ? '手机连接已开启'
              : '手机连接未开启'}
        </span>
      </div>
      <div className="mobile-remote-actions">
        <button
          className="button secondary"
          disabled={busy || online || mobile?.tunnel.status === 'starting'}
          onClick={() =>
            void perform(async () => {
              await unwrap(api.importMobileServer())
            })
          }
        >
          <FileInput size={15} aria-hidden="true" />
          {mobile?.configuredEndpoint ? '更换服务器配置' : '导入服务器配置'}
        </button>
        {online ? (
          <>
            <button
              className="button primary"
              disabled={busy}
              onClick={() =>
                void perform(async () => setPairing(await unwrap(api.createMobilePairing())))
              }
            >
              <QrCode size={15} aria-hidden="true" />
              配对安卓手机
            </button>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  await unwrap(api.disableMobile())
                  setPairing(undefined)
                })
              }
            >
              <Unplug size={15} aria-hidden="true" />
              关闭手机连接
            </button>
          </>
        ) : (
          <button
            className="button primary"
            disabled={busy || mobile?.tunnel.status === 'starting'}
            onClick={() =>
              void perform(async () => {
                await unwrap(api.enableMobile())
              })
            }
          >
            {busy ? (
              <LoaderCircle className="spin" size={15} aria-hidden="true" />
            ) : (
              <Smartphone size={15} aria-hidden="true" />
            )}
            {busy
              ? '正在连接…'
              : mobile?.transport === 'relay'
                ? '开启手机连接'
                : '开启 Cloudflare 临时连接'}
          </button>
        )}
      </div>
      {!online && mobile?.configuredEndpoint && (
        <p className="mobile-remote-address">
          服务器地址 <span>{mobile.configuredEndpoint}</span>
        </p>
      )}
      {(error || mobile?.tunnel.error || mobile?.gateway.error) && (
        <p className="mobile-remote-error" role="alert">
          {error || mobile?.tunnel.error || mobile?.gateway.error}
        </p>
      )}
      {online && (
        <p className="mobile-remote-address">
          当前地址 <span>{mobile?.tunnel.endpoint}</span>
          <button
            className="button secondary"
            aria-label="复制手机连接地址"
            onClick={() =>
              void perform(async () => {
                await unwrap(api.copyText(mobile?.tunnel.endpoint ?? ''))
              })
            }
          >
            <Copy size={14} aria-hidden="true" />
            复制
          </button>
        </p>
      )}
      {pairing && (
        <div className="mobile-pairing" aria-label="手机配对码">
          <img src={pairing.qrDataUrl} width="208" height="208" alt="Coloop 手机配对二维码" />
          <div>
            <div className="section-bar">
              <h3>在安卓 Coloop 中扫码</h3>
              <button
                className="icon-button"
                aria-label="关闭手机配对码"
                onClick={() => setPairing(undefined)}
              >
                <X size={17} />
              </button>
            </div>
            <p>
              打开手机应用，选择「配对电脑」。配对码仅用于这次连接，{Math.floor(remaining / 60)}:
              {String(remaining % 60).padStart(2, '0')} 后失效。
            </p>
            <button
              className="button secondary"
              onClick={() =>
                void perform(async () => {
                  await unwrap(api.copyText(pairing.uri))
                })
              }
            >
              <Copy size={14} aria-hidden="true" />
              复制配对链接
            </button>
            <p className="mobile-pairing-note">
              也可在手机应用中粘贴链接。请勿向其他人分享配对码。
            </p>
          </div>
        </div>
      )}
      {!!mobile?.gateway.devices.length && (
        <div className="mobile-remote-devices" aria-label="已配对手机">
          {mobile.gateway.devices.map((device) => (
            <div key={device.id}>
              <Smartphone size={17} aria-hidden="true" />
              <div>
                <strong>{device.name}</strong>
                <span>
                  最近连接 {new Date(device.lastSeenAt).toLocaleString('zh-CN', { hour12: false })}
                </span>
              </div>
              <button
                className="button secondary"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    await unwrap(api.revokeMobileDevice(device.id))
                  })
                }
              >
                解绑
              </button>
            </div>
          ))}
        </div>
      )}
      <p className="mobile-remote-note">
        控制数据在手机与电脑之间加密。
        {mobile?.transport === 'relay'
          ? '电脑主动连接自己的服务器，电脑端口无需对公网开放。'
          : 'Cloudflare 临时地址会在重新连接后改变，需要在手机中更新。'}
        电脑须保持开机且 Coloop 在运行。当前版本仅在手机应用前台刷新状态。
      </p>
    </section>
  )
}
