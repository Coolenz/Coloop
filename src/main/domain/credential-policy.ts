export function credentialOrigin(value: string): string {
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hostname.endsWith('.') ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      value !== url.origin
    )
      throw new Error()
    return url.origin
  } catch {
    throw new Error('请填写完整的 HTTPS 网站源，不含路径、参数或账号，例如 https://example.com')
  }
}

export function allowedLoginUrl(value: string, origin: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.origin === origin && !url.username && !url.password
  } catch {
    return false
  }
}

/** Never reads an input's value; the reference lives in an isolated JS world. */
export function focusProbe(field: 'username' | 'password', initial: boolean): string {
  return `(() => {
    const e = document.activeElement;
    const types = ${JSON.stringify(field === 'password' ? ['password'] : ['text', 'email', 'tel'])};
    const valid = e instanceof HTMLInputElement && types.includes(e.type) &&
      !e.disabled && !e.readOnly && e.getClientRects().length > 0 && document.hasFocus();
    ${initial ? 'globalThis.__coloopPrivateField = valid ? e : null;' : ''}
    return valid && globalThis.__coloopPrivateField === e;
  })()`
}
