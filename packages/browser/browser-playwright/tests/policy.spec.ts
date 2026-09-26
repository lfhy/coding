import { describe, expect, it } from 'vitest'
import { resolveRequestUrl, validateAllowedOrigins, validateRequestUrl } from '../src/policy.ts'

describe('browser network policy', () => {
  const defaultOrigins = validateAllowedOrigins([])

  it.each([
    'file:///etc/passwd', 'about:blank', 'http://user:password@example.com/',
    'http://localhost/', 'http://127.0.0.1/', 'http://169.254.169.254/',
    'http://10.0.0.1/', 'http://172.16.0.1/', 'http://192.168.1.1/',
    'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[fe80::1]/',
    'http://[2002:c0a8:0101::1]/',
    'http://[2001::1]/', 'http://[2001:0000::1]/',
    'http://[2001:2::1]/', 'http://[2001:10::1]/', 'http://[2001:db8::1]/',
    'http://[3fff::1]/',
  ])('rejects unsafe URL %s by default', async (url) => {
    await expect(validateRequestUrl(url, defaultOrigins)).rejects.toMatchObject({
      name: 'BrowserUseError',
    })
  })

  it('pins a validated DNS answer without asking a connector to resolve the hostname again', async () => {
    const resolve = async () => [{ address: '8.8.8.8' }, { address: '1.1.1.1' }]
    await expect(resolveRequestUrl('https://example.com/', defaultOrigins, resolve))
      .resolves.toMatchObject({ address: '8.8.8.8' })
    await expect(resolveRequestUrl('https://example.com/', defaultOrigins,
      async () => [{ address: '8.8.8.8' }, { address: '127.0.0.1' }]))
      .rejects.toMatchObject({ code: 'BROWSER_DENIED' })
  })

  it('allows only an explicit exact origin and still rejects credentials', async () => {
    const origins = validateAllowedOrigins(['http://127.0.0.1:8080'])
    await expect(validateRequestUrl('http://127.0.0.1:8080/path', origins)).resolves.toBeInstanceOf(URL)
    await expect(validateRequestUrl('http://127.0.0.1:8081/path', origins)).rejects.toMatchObject({ code: 'BROWSER_DENIED' })
    await expect(validateRequestUrl('http://user@127.0.0.1:8080/path', origins)).rejects.toMatchObject({ code: 'BROWSER_DENIED' })
    expect(() => validateAllowedOrigins(['http://127.0.0.1:8080/path'])).toThrow(/invalid allowed origin/)
  })
})
