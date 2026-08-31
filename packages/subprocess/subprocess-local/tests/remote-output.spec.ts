import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { RemoteOutputReader } from '../src/remote-output.ts'

describe('RemoteOutputReader', () => {
  it('retains a byte-exact tail while preserving whole-stream offsets', () => {
    const reader = new RemoteOutputReader(3)
    reader.push(Buffer.from('abcd'))

    expect(reader.readFrom(0)).toEqual({ text: 'bcd', nextOffset: 4, lossy: true })
    expect(reader.readFrom(2)).toEqual({ text: 'cd', nextOffset: 4, lossy: false })

    reader.push(Buffer.from('ef'))
    expect(reader.readFrom(4)).toEqual({ text: 'ef', nextOffset: 6, lossy: false })
    expect(reader.readFrom(3)).toEqual({ text: 'def', nextOffset: 6, lossy: false })
  })

  it('preserves an agent-reported absolute offset after remote retention dropped a prefix', () => {
    const reader = new RemoteOutputReader(8)
    reader.pushRemote(Buffer.from('cdef'), 6, true)

    expect(reader.readFrom(0)).toEqual({ text: 'cdef', nextOffset: 6, lossy: true })
    expect(reader.readFrom(2)).toEqual({ text: 'cdef', nextOffset: 6, lossy: false })

    reader.pushRemote(Buffer.from('gh'), 8, false)
    expect(reader.readFrom(6)).toEqual({ text: 'gh', nextOffset: 8, lossy: false })
  })

  it('marks an unreported absolute gap lossy instead of renumbering it', () => {
    const reader = new RemoteOutputReader(16)
    reader.push(Buffer.from('ab'))
    reader.pushRemote(Buffer.from('ef'), 6, false)

    expect(reader.readFrom(0)).toEqual({ text: 'abef', nextOffset: 6, lossy: true })
    expect(reader.readFrom(4)).toEqual({ text: 'ef', nextOffset: 6, lossy: false })
  })
})
