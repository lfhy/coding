// @vitest-environment jsdom
/** 文件暂存的浏览器传输只接受已发布的本机绝对路径，不把错误体写入草稿。 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { displayStagedFiles, stagedFileMentions, stagedFileName } from '../src/client/contract/staged-file-mention.ts'
import { FileStageError, stageConversationFile } from '../src/client/input/stage-file.ts'

afterEach(() => { vi.unstubAllGlobals() })

const file = (name: string, bytes: number): File => new File([new ArrayBuffer(bytes)], name, { type: 'application/octet-stream' })

function response(status: number, payload: unknown): Response {
  return { ok: status === 200, status, json: () => Promise.resolve(payload) } as Response
}

describe('stageConversationFile', () => {
  it('sends original bytes and encoded name, and accepts a safe Home path', async () => {
    const fetch = vi.fn(() => Promise.resolve(response(200, { path: '/Users/demo/Coding Home/files/uploads/123e4567-e89b-42d3-a456-426614174000-演示 slides.pptx' })))
    vi.stubGlobal('fetch', fetch)
    const original = file('演示 slides.pptx', 3)
    expect(await stageConversationFile('session-1', original)).toBe('/Users/demo/Coding Home/files/uploads/123e4567-e89b-42d3-a456-426614174000-演示 slides.pptx')
    expect(fetch).toHaveBeenCalledWith('/open-in-app/attach', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-session-id': 'session-1',
        'x-file-name': encodeURIComponent(original.name),
      },
      body: original,
    })
  })

  it('rejects oversize before network and maps failed transport to a status', async () => {
    const fetch = vi.fn(() => Promise.reject(new Error('offline')))
    vi.stubGlobal('fetch', fetch)
    await expect(stageConversationFile('session', file('big.pptx', 32 * 1024 * 1024 + 1))).rejects.toMatchObject({ status: 413 })
    expect(fetch).not.toHaveBeenCalled()
    await expect(stageConversationFile('session', file('small.pptx', 2))).rejects.toMatchObject({ status: 0 })
  })

  it('preserves server status and rejects fabricated or escaped path responses', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(409, { message: 'internal path' }))
      .mockResolvedValueOnce(response(200, { path: '../outside.pptx' }))
      .mockResolvedValueOnce(response(200, { path: '/Users/demo/files/uploads/a/../outside.pptx' }))
      .mockResolvedValueOnce(response(200, { path: '/Users/demo/files/uploads/123e4567-e89b-42d3-a456-426614174000-x".pptx' }))
      .mockResolvedValueOnce(response(200, { path: 'C:/Users/demo/files/uploads/123e4567-e89b-42d3-a456-426614174000-ok.docx' }))
    vi.stubGlobal('fetch', fetch)
    const input = file('source.docx', 0)
    await expect(stageConversationFile('session', input)).rejects.toEqual(new FileStageError(409))
    for (let index = 0; index < 3; index++) {
      await expect(stageConversationFile('session', input)).rejects.toMatchObject({ status: 0 })
    }
    expect(await stageConversationFile('session', input)).toBe('C:/Users/demo/files/uploads/123e4567-e89b-42d3-a456-426614174000-ok.docx')
  })

  it.each([
    '.dsh-uploads/123e4567-e89b-42d3-a456-426614174000-old.docx',
    '/Users/demo/files/uploads/not-a-uuid.docx',
    '/Users/demo/files/uploads/123e4567-e89b-42d3-a456-426614174000-unsafe!.docx',
    '/Users/demo/files/uploads/123e4567-e89b-42d3-a456-426614174000-a..b.docx',
    '/Users/demo/../files/uploads/123e4567-e89b-42d3-a456-426614174000-file.docx',
    '/Users/demo/files/uploads/123e4567-e89b-42d3-a456-426614174000-file.docx\n',
    'C:\\Users\\demo\\files\\uploads\\123e4567-e89b-42d3-a456-426614174000-file.docx',
    '/Users/demo/files/other/123e4567-e89b-42d3-a456-426614174000-file.docx',
  ])('rejects an untrusted response path: %s', async (path) => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(response(200, { path }))))
    await expect(stageConversationFile('session', file('source.docx', 0))).rejects.toEqual(new FileStageError(0))
  })
})

describe('staged file mention projection', () => {
  it('keeps canonical offsets and paths while hiding the Home and UUID in previews', () => {
    const posix = '@"/Users/demo/Coding Home/files/uploads/123e4567-e89b-42d3-a456-426614174000-演示 slides.pptx"'
    const windows = '@C:/Users/demo/files/uploads/123e4567-e89b-42d3-a456-426614174000-notes.docx'
    const text = `读取 ${posix}，再比较 ${windows}。`
    expect(stagedFileMentions(text)).toEqual([
      { start: 3, end: 3 + posix.length, mention: posix, label: '演示 slides.pptx' },
      { start: text.indexOf(windows), end: text.indexOf(windows) + windows.length,
        mention: windows, label: 'notes.docx' },
    ])
    expect(displayStagedFiles(text)).toBe('读取 @演示 slides.pptx，再比较 @notes.docx。')
  })

  it('does not decorate legacy, relative, or fabricated local paths', () => {
    const mentions = [
      '@.dsh-uploads/123e4567-e89b-42d3-a456-426614174000-old.pptx',
      '@/tmp/notes.docx',
      '@/Users/demo/files/uploads/not-a-uuid-notes.docx',
      '@"/Users/demo/../files/uploads/123e4567-e89b-42d3-a456-426614174000-notes.docx"',
      '@"/Users/demo/files/uploads/123e4567-e89b-42d3-a456-426614174000-invalid\".docx"',
    ]
    for (const mention of mentions) expect(stagedFileName(mention)).toBeUndefined()
    expect(displayStagedFiles(mentions.join(' '))).toBe(mentions.join(' '))
  })
})
