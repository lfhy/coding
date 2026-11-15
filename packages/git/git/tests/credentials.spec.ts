import { describe, expect, it } from 'vitest'
import { decodeGitCredential, encodeGitCredential, gitCredentialRef, gitRemoteIdentity } from '../src/index.ts'

describe('gitCredentialRef', () => {
  it('derives a shell-identifier reference from the remote host', () => {
    expect(gitCredentialRef('github.com')).toBe('GIT_CREDENTIAL_GITHUB_COM')
    expect(gitCredentialRef('ghe.example.com:8443')).toBe('GIT_CREDENTIAL_GHE_EXAMPLE_COM_8443')
  })
})

describe('encodeGitCredential / decodeGitCredential', () => {
  it('round-trips one host and its credentials', () => {
    const value = encodeGitCredential('github.com', { username: 'alice', password: 'token', remember: true })
    expect(decodeGitCredential('github.com', value)).toEqual({ username: 'alice', password: 'token' })
  })

  it('refuses a value that belongs to another host', () => {
    const value = encodeGitCredential('github.com', { username: 'alice', password: 'token' })
    expect(decodeGitCredential('gitlab.com', value)).toBeUndefined()
  })

  it('refuses malformed or incomplete values instead of returning partial credentials', () => {
    expect(decodeGitCredential('github.com', 'not json')).toBeUndefined()
    expect(decodeGitCredential('github.com', 'null')).toBeUndefined()
    expect(decodeGitCredential('github.com', JSON.stringify({ host: 'github.com', username: 'alice' }))).toBeUndefined()
    expect(decodeGitCredential('github.com', JSON.stringify({ host: 'github.com', username: '', password: 'token' }))).toBeUndefined()
    expect(decodeGitCredential('github.com', JSON.stringify({ host: 'github.com', username: 'alice', password: '' }))).toBeUndefined()
  })
})

describe('gitRemoteIdentity', () => {
  it('accepts a plain HTTPS remote and reports its authority', () => {
    expect(gitRemoteIdentity('https://github.com/acme/demo.git')).toEqual({
      host: 'github.com', display: 'https://github.com',
    })
  })

  it('refuses non-HTTPS remotes and URLs that embed user information', () => {
    expect(gitRemoteIdentity('http://github.com/acme/demo.git')).toBeUndefined()
    expect(gitRemoteIdentity('git@github.com:acme/demo.git')).toBeUndefined()
    expect(gitRemoteIdentity('https://alice:secret@github.com/acme/demo.git')).toBeUndefined()
    expect(gitRemoteIdentity('not a url')).toBeUndefined()
  })
})
