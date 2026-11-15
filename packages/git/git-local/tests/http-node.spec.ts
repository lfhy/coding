import { describe, expect, it } from 'vitest'
import { bypassedByNoProxy, proxyFromEnv } from '../src/http-node.ts'

/** 在隔离的进程环境里跑一次读取，避免用例之间互相污染 `*_PROXY`。 */
function withEnv<T>(vars: Record<string, string | undefined>, run: () => T): T {
  const names = [
    'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy',
  ]
  const previous = new Map(names.map(name => [name, process.env[name]]))
  // 直接赋值 undefined 会被 process.env 转成字符串 "undefined"，必须先真正移除键。
  for (const name of names) Reflect.deleteProperty(process.env, name)
  for (const [name, value] of Object.entries(vars)) {
    if (value !== undefined) process.env[name] = value
  }
  try {
    return run()
  } finally {
    for (const name of names) {
      const value = previous.get(name)
      if (value === undefined) Reflect.deleteProperty(process.env, name)
      else process.env[name] = value
    }
  }
}

describe('proxyFromEnv', () => {
  it('prefers the protocol-specific variable and falls back to ALL_PROXY', () => {
    withEnv({ HTTPS_PROXY: 'http://proxy.https:8080', ALL_PROXY: 'socks5://proxy.all:1080' }, () => {
      expect(proxyFromEnv('https:')).toBe('http://proxy.https:8080')
      expect(proxyFromEnv('http:')).toBe('socks5://proxy.all:1080')
    })
  })

  it('accepts lowercase spellings and ignores blank values', () => {
    withEnv({ https_proxy: 'http://lower:3128', HTTP_PROXY: '   ' }, () => {
      expect(proxyFromEnv('https:')).toBe('http://lower:3128')
      expect(proxyFromEnv('http:')).toBeUndefined()
    })
  })

  it('returns undefined when nothing is configured', () => {
    withEnv({}, () => { expect(proxyFromEnv('https:')).toBeUndefined() })
  })
})

describe('bypassedByNoProxy', () => {
  it('matches exact hosts, dotted suffixes, and the wildcard', () => {
    expect(bypassedByNoProxy('github.com', 'github.com')).toBe(true)
    expect(bypassedByNoProxy('ghe.github.com', '.github.com')).toBe(true)
    expect(bypassedByNoProxy('ghe.github.com', 'github.com')).toBe(true)
    expect(bypassedByNoProxy('github.com', '*')).toBe(true)
  })

  it('ignores ports in the entry and keeps unrelated hosts proxied', () => {
    expect(bypassedByNoProxy('127.0.0.1', '127.0.0.1:8080')).toBe(true)
    expect(bypassedByNoProxy('gitlab.com', 'github.com')).toBe(false)
    expect(bypassedByNoProxy('notgithub.com', 'github.com')).toBe(false)
  })

  it('treats an absent or empty list as no exclusion', () => {
    expect(bypassedByNoProxy('github.com', undefined)).toBe(false)
    expect(bypassedByNoProxy('github.com', ' , ')).toBe(false)
  })
})
