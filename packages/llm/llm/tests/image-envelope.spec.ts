import { describe, expect, it } from 'vitest'
import { imageEnvelopeText, isImageEnvelope } from '../src/index.ts'

describe('image envelope', () => {
  it('renders the path, media type, and intrinsic metadata in one envelope', () => {
    expect(imageEnvelopeText({ path: '/home/demo/.coding/files/uploads/1-image.png', mediaType: 'image/png', width: 2, height: 3, bytes: 7 }))
      .toBe('<path>/home/demo/.coding/files/uploads/1-image.png</path>\n<type>image</type>\n<content>\nimage/png image, 2x3 px, 7 bytes\n</content>')
  })

  it('escapes characters that would break the envelope tags', () => {
    const text = imageEnvelopeText({ path: '/tmp/a&b<c>.png', mediaType: 'image/png', width: 1, height: 1, bytes: 1 })
    expect(text).toContain('<path>/tmp/a&amp;b&lt;c&gt;.png</path>')
    expect(isImageEnvelope(text)).toBe(true)
  })

  it('recognizes only a whole envelope, so user text of the same shape stays prose', () => {
    const envelope = imageEnvelopeText({ path: '/tmp/a.png', mediaType: 'image/png', width: 1, height: 1, bytes: 1 })
    expect(isImageEnvelope(envelope)).toBe(true)
    expect(isImageEnvelope('<path>/tmp/a.png</path>')).toBe(false)
    expect(isImageEnvelope(`${envelope}\n再解释一下`)).toBe(false)
  })
})
