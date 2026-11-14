// Keep the credential out of the persisted Cordis profile. The native MCP
// client owns discovery, dispatch and lifecycle of the official server.
export const name = 'coloop-playwright'
export const inject = ['tools']
export async function apply(ctx, config) {
  const response = await fetch(process.env.COLOOP_HARNESS_BRIDGE + '/browser-credentials', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.COLOOP_HARNESS_BRIDGE_TOKEN}` },
  })
  if (!response.ok) throw new Error('PLAYWRIGHT_EXTENSION_CREDENTIAL_UNAVAILABLE')
  const { token } = await response.json()
  const { apply: nativeMcp } = await import(process.env.COLOOP_HARNESS_MCP_MODULE)
  return nativeMcp(ctx, {
    ...config,
    env: { ...config.env, ...(token ? { PLAYWRIGHT_MCP_EXTENSION_TOKEN: token } : {}) },
  })
}
