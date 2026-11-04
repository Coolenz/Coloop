import { describe, expect, it } from 'vitest'
import { allowedLoginUrl, credentialOrigin, focusProbe } from '../src/main/domain/credential-policy'
import { credentialCreateSchema, credentialRecordSchema } from '../src/shared/credentials'

describe('private credential boundaries', () => {
  it('binds a record to the canonical HTTPS origin including its port', () => {
    expect(credentialOrigin('https://example.com')).toBe('https://example.com')
    expect(allowedLoginUrl('https://example.com/login?return=home', 'https://example.com')).toBe(
      true,
    )
    for (const url of [
      'https://example.com.evil.test',
      'https://example.com:444',
      'http://example.com',
      'https://user:pass@example.com',
      'javascript:alert(1)',
      'file:///C:/secret',
    ])
      expect(allowedLoginUrl(url, 'https://example.com')).toBe(false)
    for (const site of [
      'https://example.com/',
      'https://example.com/login',
      'https://example.com:443',
      'https://example.com?token=test',
      'https://example.com.',
      'https://example.com#fragment',
    ])
      expect(() => credentialOrigin(site)).toThrow()
  })
  it('rejects metadata containing secrets and HID navigation in stored fields', () => {
    const input = { origin: 'https://example.com', username: '  name  ', password: ' A!z_\\" ' }
    expect(credentialCreateSchema.parse(input)).toEqual(input)
    for (const password of ['\n', 'x\ty', '中文', 'x'.repeat(65), ''])
      expect(credentialCreateSchema.safeParse({ ...input, password }).success).toBe(false)
    expect(
      credentialRecordSchema.safeParse({
        id: crypto.randomUUID(),
        origin: input.origin,
        createdAt: 1,
        password: 'must-not-be-returned',
      }).success,
    ).toBe(false)
  })
  it('focus validation never reads field contents', () => {
    const code = focusProbe('password', true)
    expect(code).not.toContain('.value')
    expect(code).toContain('HTMLInputElement')
    expect(code).toContain('document.hasFocus()')
  })
})
