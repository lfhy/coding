// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyImageBlob } from '../src/client/image-clipboard.ts'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

function clipboard() {
  const write = vi.fn(async () => {})
  vi.stubGlobal('ClipboardItem', class { constructor(readonly contents: Record<string, Blob>) {} })
  vi.stubGlobal('navigator', { clipboard: { write } })
  return write
}

describe('工作台图片复制', () => {
  it('PNG 直接写入剪贴板，缺少浏览器能力时明确失败', async () => {
    const write = clipboard()
    expect(await copyImageBlob(new Blob(['png'], { type: 'image/png' }))).toBe(true)
    expect(write).toHaveBeenCalledOnce()
    vi.stubGlobal('ClipboardItem', undefined)
    expect(await copyImageBlob(new Blob(['png'], { type: 'image/png' }))).toBe(false)
  })

  it('JPEG 转换成 PNG，支持 ImageBitmap 与旧浏览器的 Image 回退', async () => {
    const write = clipboard()
    const png = new Blob(['png'], { type: 'image/png' })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as never)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => { callback(png) })
    const close = vi.fn()
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 2, height: 2, close })))
    expect(await copyImageBlob(new Blob(['jpg'], { type: 'image/jpeg' }))).toBe(true)
    expect(close).toHaveBeenCalledOnce()

    vi.stubGlobal('createImageBitmap', undefined)
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:local', revokeObjectURL })
    vi.stubGlobal('Image', class {
      naturalWidth = 2
      naturalHeight = 2
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_value: string) { queueMicrotask(() => { this.onload?.() }) }
    })
    expect(await copyImageBlob(new Blob(['jpg'], { type: 'image/jpeg' }))).toBe(true)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:local')
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('浏览器解码失败不会报告复制成功', async () => {
    clipboard()
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('decode') }))
    expect(await copyImageBlob(new Blob(['broken'], { type: 'image/jpeg' }))).toBe(false)
  })
})
