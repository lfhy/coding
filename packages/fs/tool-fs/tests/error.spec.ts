/**
 * Unit tests for the model-facing error remediation: the remedy appended to
 * guarded-mutation failures, code preservation, and passthrough behavior.
 */

import { describe, expect, it } from 'vitest'
import { FsError } from 'coding-fs'
import { remediateFsError } from '../src/error.ts'

describe('remediateFsError', () => {
  it('appends the re-read remedy to FS_STALE_VERSION, preserving the code and chaining the cause', () => {
    const original = new FsError('cannot edit "x": file changed since it was read', 'FS_STALE_VERSION')
    const remedied = remediateFsError(original) as FsError
    expect(remedied).toBeInstanceOf(FsError)
    expect(remedied.message).toBe('cannot edit "x": file changed since it was read — re-read the file, then retry')
    expect(remedied.code).toBe('FS_STALE_VERSION')
    expect(remedied.cause).toBe(original)
  })

  it('appends the read remedy to FS_NOT_OBSERVED', () => {
    const remedied = remediateFsError(new FsError('edit requires reading "x" first', 'FS_NOT_OBSERVED')) as FsError
    expect(remedied.message).toBe('edit requires reading "x" first — read the file, then retry')
    expect(remedied.code).toBe('FS_NOT_OBSERVED')
  })

  it('appends the read remedy to a failed literal edit', () => {
    const remedied = remediateFsError(new FsError('old_string was not found in "x"', 'FS_EDIT_NOT_FOUND')) as FsError
    expect(remedied.message).toBe('old_string was not found in "x" — read the file first to confirm its current content, then retry')
    expect(remedied.code).toBe('FS_EDIT_NOT_FOUND')
  })

  it('leaves other FsError codes untouched', () => {
    const original = new FsError('too many matches', 'FS_AMBIGUOUS_EDIT')
    expect(remediateFsError(original)).toBe(original)
  })

  it('leaves non-FsError values untouched', () => {
    const original = new Error('boom')
    expect(remediateFsError(original)).toBe(original)
  })
})
