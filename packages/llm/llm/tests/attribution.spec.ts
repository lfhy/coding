import { createRequire } from 'node:module'
import { arch, platform, release } from 'node:os'
import { describe, expect, it } from 'vitest'
import { APP_IDENTITY, attributionHeaders, userAgent, userAgentOS } from 'coding-llm'
import type { AppIdentity } from 'coding-llm'

const manifest = createRequire(import.meta.url)('../package.json') as { version: string }

/** A white-label identity exercising every override hook. */
const forkIdentity: AppIdentity = {
  product: 'fork-agent',
  version: '9.9.9',
  url: 'https://example.com/fork-agent',
}

describe('APP_IDENTITY', () => {
  it('sources the version from the package manifest, never a hand-copied constant', () => {
    expect(APP_IDENTITY.version).toBe(manifest.version)
  })

  it('carries only static public product facts', () => {
    expect(APP_IDENTITY).toEqual({
      product: 'deepseek-harness',
      version: manifest.version,
      url: 'https://github.com/deepseek-ai/deepseek-harness',
    })
  })
})

describe('userAgent', () => {
  it('renders the Coding build and current host identity by default', () => {
    const value = userAgent()
    expect(value).toMatch(/^Coding\/\d{4}\.\d{4}\.[0-9a-f]{6} \([^;()]+;[^;()]+\)$/)
    expect(value).toContain(`;${arch()})`)
    if (platform() === 'darwin') expect(value).toContain('(MacOS ')
    else expect(value).toContain(`(${userAgentOS(platform(), release())};`)
  })

  it('keeps the macOS product version distinct from the Darwin kernel', () => {
    expect(userAgentOS('darwin', '26.0.0', '27.1.2')).toBe('MacOS 27')
    expect(() => userAgentOS('darwin', '26.0.0')).toThrow('macOS product version')
    expect(userAgentOS('linux', '6.10.1')).toBe('Linux 6.10.1')
    expect(userAgentOS('win32', '10.0.0')).toBe('Windows 10.0.0')
  })

  it('renders a custom identity', () => {
    expect(userAgent(forkIdentity)).toBe('fork-agent/9.9.9 (+https://example.com/fork-agent)')
  })
})

describe('attributionHeaders', () => {
  it('defaults to the provider-neutral baseline: User-Agent and nothing else', () => {
    expect(attributionHeaders()).toEqual({ 'user-agent': userAgent() })
  })

  it('maps a custom identity onto the User-Agent header only', () => {
    expect(attributionHeaders(forkIdentity)).toEqual({
      'user-agent': 'fork-agent/9.9.9 (+https://example.com/fork-agent)',
    })
  })
})
