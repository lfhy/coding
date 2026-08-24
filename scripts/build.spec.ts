import { describe, expect, it } from 'vitest'
import { isDirectScriptEntry } from './build.ts'

describe('isDirectScriptEntry', () => {
  it('recognizes the file Node received as the ESM entrypoint', () => {
    expect(isDirectScriptEntry('file:///repo/scripts/build.ts', '/repo/scripts/build.ts')).toBe(true)
    expect(isDirectScriptEntry('file:///repo/scripts/build.ts', '/repo/scripts/other.ts')).toBe(false)
  })

  it('does not treat an imported module as an entrypoint without an invoked file', () => {
    expect(isDirectScriptEntry('file:///repo/scripts/build.ts', undefined)).toBe(false)
  })
})
