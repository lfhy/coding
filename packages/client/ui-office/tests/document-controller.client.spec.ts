import { afterEach, expect, it, vi } from 'vitest'
import { createOfficeDocumentController, type OfficeDraft, type OfficeView } from '../src/client/document-controller.ts'
import type { OfficeSnapshot, WordDocument } from '../src/client/office-document.ts'
import type { OfficeIo, OfficeResult } from '../src/client/wire.ts'

const path = '这是文件.codingword'
const word = (text: string): WordDocument => ({ version: 1, kind: 'word', paragraphs: [{ style: 'normal', runs: [{ text }] }] })
const snapshot = (revision: string, text: string): OfficeResult<OfficeSnapshot> => ({
  kind: 'ready', value: { path, revision, document: word(text) },
})
const download = { filename: '这是文件.docx', blob: new Blob(['example export']) }

function setup(initial?: OfficeDraft) {
  const read = vi.fn<OfficeIo['read']>().mockResolvedValue(snapshot('v1', '原版'))
  const save = vi.fn<OfficeIo['save']>().mockResolvedValue(snapshot('v2', '编辑'))
  const exportFile = vi.fn<OfficeIo['export']>().mockResolvedValue({ kind: 'ready', value: download })
  const publish = vi.fn<(view: OfficeView) => void>()
  const retain = vi.fn<(draft: OfficeDraft | undefined) => void>()
  const isEditing = vi.fn(() => false)
  const controller = createOfficeDocumentController({ io: { read, save, export: exportFile }, initial, publish, retain, isEditing })
  return { controller, read, save, exportFile, publish, retain, isEditing }
}

afterEach(() => { vi.useRealTimers() })

it('自动保存冲突时保留原稿，重复冲突不会自动换修订号重试', async () => {
  vi.useFakeTimers()
  const { controller, read, save, publish, retain } = setup()
  save.mockResolvedValue({ kind: 'conflict' })
  await controller.open()
  controller.edit(word('第一份输入'))
  await vi.advanceTimersByTimeAsync(850)
  expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'conflict' }))
  controller.edit(word('冲突后继续编辑'))
  await vi.advanceTimersByTimeAsync(3_000)
  expect(save).toHaveBeenCalledTimes(1)
  expect(retain).toHaveBeenLastCalledWith({ revision: 'v1', document: word('冲突后继续编辑') })
  read.mockResolvedValue(snapshot('v3', '另一份内容'))
  await expect(controller.review()).resolves.toBe('ready')
  await expect(controller.save()).resolves.toBe('conflict')
  await expect(controller.replaceLatest()).resolves.toBe('conflict')
  expect(save).toHaveBeenLastCalledWith('v3', word('冲突后继续编辑'), expect.any(AbortSignal))
  await expect(controller.replaceLatest()).resolves.toBe('cancelled')
  expect(save).toHaveBeenCalledTimes(2)
  controller.dispose()
})

it('导出会等待正在保存的版本和期间提交到画布的新修改', async () => {
  const { controller, save, exportFile } = setup()
  const first = Promise.withResolvers<OfficeResult<OfficeSnapshot>>()
  save.mockReturnValueOnce(first.promise).mockResolvedValueOnce(snapshot('v3', '最终编辑'))
  await controller.open()
  controller.edit(word('编辑'))
  const saving = controller.save()
  const exporting = controller.export()
  controller.edit(word('最终编辑'))
  expect(exportFile).not.toHaveBeenCalled()
  first.resolve(snapshot('v2', '编辑'))
  await expect(saving).resolves.toBe('ready')
  await expect(exporting).resolves.toEqual({ kind: 'ready', value: download })
  expect(save.mock.calls.map(([revision, document]) => [revision, document])).toEqual([
    ['v1', word('编辑')], ['v2', word('最终编辑')],
  ])
  expect(exportFile).toHaveBeenCalledExactlyOnceWith('v3', expect.any(AbortSignal))
  controller.dispose()
})

it('只采纳可见空闲版本，且关掉后取消正在等待的请求', async () => {
  const { controller, read, publish, isEditing } = setup()
  await controller.open()
  isEditing.mockReturnValue(true)
  await expect(controller.poll()).resolves.toBe('cancelled')
  expect(read).toHaveBeenCalledTimes(1)
  isEditing.mockReturnValue(false)
  const after = Promise.withResolvers<OfficeResult<OfficeSnapshot>>()
  read.mockReturnValueOnce(after.promise)
  const poll = controller.poll()
  controller.edit(word('不能被轮询覆盖'))
  after.resolve(snapshot('v2', '助手改动'))
  await expect(poll).resolves.toBe('cancelled')
  expect(publish.mock.lastCall?.[0]).toMatchObject({ seed: { document: word('原版') }, status: 'dirty', conflict: false })
  controller.dispose()
  expect(read.mock.calls[1]?.[0].aborted).toBe(true)
})

it('恢复草稿但不在打开同名路径时自动重交；可明确丢弃冲突草稿', async () => {
  vi.useFakeTimers()
  const { controller, read, save, retain, publish } = setup({ revision: 'v1', document: word('回到草稿') })
  await controller.open()
  await vi.advanceTimersByTimeAsync(3_000)
  expect(save).not.toHaveBeenCalled()
  expect(publish.mock.lastCall?.[0]).toMatchObject({ seed: { document: word('回到草稿') }, status: 'dirty', conflict: false })
  save.mockResolvedValueOnce({ kind: 'conflict' })
  await expect(controller.save()).resolves.toBe('conflict')
  read.mockResolvedValueOnce(snapshot('v2', '远端'))
  await expect(controller.review()).resolves.toBe('ready')
  expect(controller.useLatest()).toBe(true)
  expect(retain).toHaveBeenLastCalledWith(undefined)
  expect(publish.mock.lastCall?.[0]).toMatchObject({ seed: { document: word('远端') }, status: 'saved', conflict: false })
  controller.dispose()
})
