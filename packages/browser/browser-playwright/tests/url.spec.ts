import { describe, expect, it } from 'vitest'
import { validateBrowserUrl } from '../src/url.ts'

describe('browser navigation URL', () => {
  it.each([
    'https://example.com/', 'http://unresolvable.invalid/', 'http://localhost/',
    'http://app.localhost/', 'http://device.local/', 'http://127.0.0.1/',
    'http://169.254.169.254/', 'http://10.0.0.1/', 'http://172.16.0.1/',
    'http://192.168.1.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/',
    'http://[fe80::1]/', 'http://[2001:db8::1]/', 'http://2130706433/',
    'http://0x7f000001/', 'http://0177.0.0.1/', 'HTTP://localhost:8080/path?x=1#part',
  ])('accepts HTTP(S) destination %s without DNS or address filtering', (raw) => {
    expect(validateBrowserUrl(raw)).toBeInstanceOf(URL)
  })

  it.each(['', '/relative', '//localhost/path', 'not a URL', 'http://',
    'http://[invalid]/', 'http://localhost:99999/', 'http:localhost', 'http:/localhost',
    'http:///localhost', 'http://\\localhost', ' http://localhost/'])
  ('rejects malformed or non-absolute URL %s', (raw) => {
    expect(() => validateBrowserUrl(raw)).toThrow(expect.objectContaining({ code: 'BROWSER_INVALID_URL' }))
  })

  it.each(['file:///etc/passwd', 'about:blank', 'data:text/plain,hi', 'ftp://localhost/',
    'ws://localhost/', 'http://user@example.com/', 'https://user:password@localhost/', 'http://@localhost/'])
  ('rejects unsupported protocols and credentials in %s', (raw) => {
    expect(() => validateBrowserUrl(raw)).toThrow(expect.objectContaining({ code: 'BROWSER_DENIED' }))
  })

  it('accepts the exact character limit and rejects an oversized URL', () => {
    const prefix = 'https://localhost/'
    expect(validateBrowserUrl(prefix + 'a'.repeat(4096 - prefix.length)).href).toHaveLength(4096)
    expect(() => validateBrowserUrl(prefix + 'a'.repeat(4097 - prefix.length)))
      .toThrow(expect.objectContaining({ code: 'BROWSER_FAILED' }))
  })
})
