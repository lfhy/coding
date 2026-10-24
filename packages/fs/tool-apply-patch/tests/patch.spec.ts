import { describe, expect, it } from 'vitest'
import { applyPatchHunks, parsePatch } from '../src/patch.ts'

describe('Codex patch parser', () => {
  it('parses Add File and Update File sections', () => {
    const parsed = parsePatch('*** Begin Patch\n*** Add File: new.txt\n+hello\n*** Update File: old.txt\n@@ heading\n-old\n+new\n*** End Patch')
    expect(parsed.files).toEqual([
      { kind: 'add', path: 'new.txt', content: 'hello\n' },
      {
        kind: 'update', path: 'old.txt', hunks: [{ context: 'heading', oldLines: ['old'], newLines: ['new'] }],
      },
    ])
  })

  it('rejects malformed envelopes and empty hunks', () => {
    expect(() => parsePatch('*** Add File: x\n+text')).toThrow('must start')
    expect(() => parsePatch('*** Begin Patch\n*** Update File: x\n*** End Patch')).toThrow('no hunk')
  })

  it('applies context hunks in order and preserves a trailing newline', () => {
    const parsed = parsePatch('*** Begin Patch\n*** Update File: file.txt\n@@ second\n-two\n+TWO\n@@ third\n-four\n+FOUR\n*** End Patch')
    const file = parsed.files[0]
    if (file?.kind !== 'update') throw new Error('expected update')
    expect(applyPatchHunks('file.txt', 'one\nsecond\ntwo\nthird\nfour\n', file.hunks))
      .toBe('one\nsecond\nTWO\nthird\nFOUR\n')
  })

  it('rejects a hunk that does not match the current file', () => {
    const file = parsePatch('*** Begin Patch\n*** Update File: file.txt\n@@\n-missing\n+new\n*** End Patch').files[0]
    if (file?.kind !== 'update') throw new Error('expected update')
    expect(() => applyPatchHunks('file.txt', 'actual\n', file.hunks)).toThrow('does not match')
  })
})
