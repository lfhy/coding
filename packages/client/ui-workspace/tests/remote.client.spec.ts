import { describe, expect, it } from 'vitest'
import { RemoteHostUrlError, remoteHostUrl } from '../src/client/remote.ts'

describe('remoteHostUrl', () => {
  it('normalizes an http(s) Host address', () => {
    expect(remoteHostUrl(' https://host.example.com/workspaces ')).toBe('https://host.example.com/workspaces')
  })

  it.each([
    ['', 'empty'],
    ['host.example.com', 'missing-protocol'],
    ['http:host.example.com', 'missing-protocol'],
    ['https://', 'missing-protocol'],
    ['ssh://host.example.com', 'unsupported-protocol'],
    ['https://user:secret@host.example.com', 'credentials'],
  ] as const)('rejects unsafe or incomplete input %j', (input, code) => {
    expect(() => remoteHostUrl(input)).toThrow(RemoteHostUrlError)
    try {
      remoteHostUrl(input)
    } catch (error) {
      expect(error).toMatchObject({ code })
    }
  })
})
