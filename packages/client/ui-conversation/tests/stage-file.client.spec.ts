// @vitest-environment jsdom
/** 文件暂存的浏览器传输只接受已发布的工作区相对路径，不把错误体写入草稿。 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileStageError, stageConversationFile } from '../src/client/input/stage-file.ts'

afterEach(() => { vi.unstubAllGlobals() })

const file = (name: string, bytes: number): File => new File([new ArrayBuffer(bytes)], name, { type: 'application/octet-stream' })

function response(status: number, payload: unknown): Response {
  return { ok: status === 200, status, json: () => Promise.resolve(payload) } as Response
}

describe('stageConversationFile', () => {
  it('sends original bytes and encoded name, and accepts only a safe workspace path', async () => {
    const fetch = vi.fn(() => Promise.resolve(response(200, { path: '.dsh-uploads/abcd-演示 slides.pptx' })))
    vi.stubGlobal('fetch', fetch)
    const original = file('演示 slides.pptx', 3)
    expect(await stageConversationFile('session-1', original)).toBe('.dsh-uploads/abcd-演示 slides.pptx')
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
      .mockResolvedValueOnce(response(200, { path: '.dsh-uploads/a/../outside.pptx' }))
      .mockResolvedValueOnce(response(200, { path: '.dsh-uploads/x".pptx' }))
      .mockResolvedValueOnce(response(200, { path: '.dsh-uploads/ok.docx' }))
    vi.stubGlobal('fetch', fetch)
    const input = file('source.docx', 0)
    await expect(stageConversationFile('session', input)).rejects.toEqual(new FileStageError(409))
    for (let index = 0; index < 3; index++) {
      await expect(stageConversationFile('session', input)).rejects.toMatchObject({ status: 0 })
    }
    expect(await stageConversationFile('session', input)).toBe('.dsh-uploads/ok.docx')
  })
})
