/** 引用提交保留完整路径；Host 拒绝后引用仍在，只有成功提交才清除。 */
import { describe, expect, it, vi } from 'vitest'
import type { ClientContext } from 'coding-client-runtime/client'
import type { InputTriggerController, SubmitOutcome } from 'coding-client-ui-input-trigger/client'
import { SessionInputShell } from '../src/client/input/facade.ts'
import type { DraftAttachmentId } from '../src/client/input/contract.ts'

const mention = '@[Research](dsh-session:InNvdXJjZSI)'
const spacedMention = '@[Research notes](dsh-session:InNvdXJjZSI)'
const stagedMention = '@"/tmp/a(b)[c]{d}<e>,f/managed/uploads/123e4567-e89b-42d3-a456-426614174000-演示 slides.pptx"'
const commandImages = {
  serialize: () => Promise.resolve([]),
  release: () => {},
  unsupportedNotice: (token: string) => `${token.trim()} images-unsupported`,
}

function chip(shell: SessionInputShell): void {
  shell.setDraft('@res')
  const accepted = shell.insertReference({
    source: 'reference',
    ref: mention,
    label: 'Research',
    clipboardText: mention,
  }, {
    start: 0,
    end: 4,
    draftRev: shell.snapshot.draftRev,
  })
  expect(accepted).toBe(true)
}

describe('reference submission', () => {
  it('restores a staged file label after remount while preserving its saved path for sending', async () => {
    const mirror = vi.fn()
    const first = new SessionInputShell({ actx: {} as ClientContext, defaultSink: vi.fn(), commandImages })
    first.bindMirror(mirror)
    first.pasteBegin(`读取 ${stagedMention} 后继续`, { start: 0, end: 0 }, [{
      start: 3, end: 3 + stagedMention.length,
      reference: { source: 'reference', ref: stagedMention, label: '演示 slides.pptx',
        appearance: 'file', clipboardText: stagedMention },
    }])
    expect(first.snapshot.draft).toBe('读取 @演示 slides.pptx 后继续')
    expect(mirror).toHaveBeenLastCalledWith(`读取 ${stagedMention} 后继续`)

    const sink = vi.fn(() => Promise.resolve<SubmitOutcome>({ kind: 'success' }))
    const restored = new SessionInputShell({
      actx: {} as ClientContext, defaultSink: sink, commandImages,
      inputTriggers: () => ({
        track: vi.fn(), serializeReference: (_source: string, ref: string) => Promise.resolve(ref),
      }) as unknown as InputTriggerController,
    })
    restored.setDraft(mirror.mock.calls.at(-1)?.[0] as string)
    expect(restored.snapshot.draft).toBe('读取 @演示 slides.pptx 后继续')
    expect(restored.snapshot.occurrences[0]).toMatchObject({ ref: stagedMention, label: '演示 slides.pptx' })
    restored.submit()
    await vi.waitFor(() => { expect(sink).toHaveBeenCalledWith(
      `读取 ${stagedMention} 后继续`, [], 'queue', expect.any(AbortSignal),
    ) })
  })

  it('mirrors canonical reference text so a persisted draft remains resolvable after remount', async () => {
    const mirror = vi.fn()
    const first = new SessionInputShell({
      actx: {} as ClientContext,
      defaultSink: vi.fn(),
      commandImages,
    })
    first.bindMirror(mirror)
    first.setDraft('@res')
    expect(first.insertReference({
      source: 'reference',
      ref: spacedMention,
      label: 'Research notes',
      appearance: 'session',
      clipboardText: spacedMention,
    }, {
      start: 0,
      end: 4,
      draftRev: first.snapshot.draftRev,
    })).toBe(true)
    expect(first.snapshot.draft).toBe('@Research notes ')
    expect(mirror).toHaveBeenLastCalledWith(`${spacedMention} `)

    const sink = vi.fn(() => Promise.resolve<SubmitOutcome>({ kind: 'success' }))
    const restored = new SessionInputShell({
      actx: {} as ClientContext,
      defaultSink: sink,
      commandImages,
    })
    restored.setDraft(mirror.mock.calls.at(-1)?.[0] as string)
    restored.submit()
    await vi.waitFor(() => {
      expect(sink).toHaveBeenCalledWith(spacedMention, [], 'queue', expect.any(AbortSignal))
    })
  })

  it('retains the chip on Host failure and clears it only after a later accepted retry', async () => {
    const serializeReference = vi.fn(() => Promise.resolve(mention))
    const sink = vi.fn<(
      _text: string,
      _imageIds: readonly DraftAttachmentId[],
      _mode: 'queue' | 'steer',
      _signal: AbortSignal,
    ) => Promise<SubmitOutcome>>()
      .mockResolvedValueOnce({ kind: 'error', text: 'snapshot unavailable' })
      .mockResolvedValueOnce({ kind: 'success' })
    const inputTriggers = {
      serializeReference,
      track: vi.fn(),
    } as unknown as InputTriggerController
    const shell = new SessionInputShell({
      actx: {} as ClientContext,
      inputTriggers: () => inputTriggers,
      defaultSink: sink,
      commandImages,
    })
    chip(shell)
    expect(shell.snapshot).toMatchObject({
      draft: '@Research ',
      occurrences: [{ source: 'reference', ref: mention, label: 'Research', offset: 0, length: 9 }],
    })

    shell.submit('queue')
    expect(shell.snapshot.phase).toBe('submitting')
    await vi.waitFor(() => {
      expect(shell.snapshot.phase).toBe('plain')
    })
    expect(sink).toHaveBeenNthCalledWith(1, mention, [], 'queue', expect.any(AbortSignal))
    expect(shell.snapshot).toMatchObject({
      draft: '@Research ',
      occurrences: [{ source: 'reference', ref: mention, label: 'Research', offset: 0, length: 9 }],
    })
    expect(shell.notices.getSnapshot()).toMatchObject({
      level: 'error',
      text: 'snapshot unavailable',
    })

    shell.submit('queue')
    await vi.waitFor(() => {
      expect(shell.snapshot.draft).toBe('')
    })
    expect(sink).toHaveBeenNthCalledWith(2, mention, [], 'queue', expect.any(AbortSignal))
    expect(shell.snapshot.occurrences).toEqual([])
    expect(serializeReference).toHaveBeenCalledTimes(2)
  })

  it('blocks submission and retains the chip when its owner cannot serialize it', async () => {
    const sink = vi.fn()
    const inputTriggers = {
      serializeReference: () => Promise.reject(new Error('reference codec unavailable')),
      track: vi.fn(),
    } as unknown as InputTriggerController
    const shell = new SessionInputShell({
      actx: {} as ClientContext,
      inputTriggers: () => inputTriggers,
      defaultSink: sink,
      commandImages,
    })
    chip(shell)
    shell.submit()
    await vi.waitFor(() => {
      expect(shell.snapshot.phase).toBe('plain')
    })
    expect(sink).not.toHaveBeenCalled()
    expect(shell.snapshot.draft).toBe('@Research ')
    expect(shell.snapshot.occurrences).toHaveLength(1)
    expect(shell.notices.getSnapshot()).toMatchObject({
      level: 'error',
      text: 'reference codec unavailable',
    })
  })

  it('serializes the enter-time file occurrence while later draft edits remain pending', async () => {
    let resolveCodec!: (text: string) => void
    const codec = new Promise<string>((resolve) => { resolveCodec = resolve })
    const sink = vi.fn(() => Promise.resolve<SubmitOutcome>({ kind: 'success' }))
    const shell = new SessionInputShell({
      actx: {} as ClientContext, defaultSink: sink, commandImages,
      inputTriggers: () => ({ track: vi.fn(), serializeReference: () => codec }) as unknown as InputTriggerController,
    })
    shell.setDraft(`读取 ${stagedMention}`)
    shell.submit()
    shell.setDraft(`${shell.snapshot.draft} 后续补充`)
    resolveCodec(stagedMention)
    await vi.waitFor(() => { expect(sink).toHaveBeenCalledWith(
      `读取 ${stagedMention}`, [], 'queue', expect.any(AbortSignal),
    ) })
    expect(shell.snapshot.draft).toBe(' 后续补充')
  })

  it('serializes file paths in claimed command arguments and keeps the draft on codec failure', async () => {
    const submit = vi.fn(() => Promise.resolve<SubmitOutcome>({ kind: 'success' }))
    const serializeReference = vi.fn((_source: string, ref: string) => Promise.resolve(ref))
    const shell = new SessionInputShell({
      actx: {} as ClientContext, defaultSink: vi.fn(), commandImages,
      inputTriggers: () => ({ serializeReference, track: vi.fn() }) as unknown as InputTriggerController,
    })
    shell.setDraft('/run ')
    const claim = { token: '/run ', submit }
    expect(shell.beginCommand(claim, { start: 0, end: 5, draftRev: shell.snapshot.draftRev })).toBe(true)
    shell.pasteBegin(`处理 ${stagedMention}`, { start: 5, end: 5 }, [{
      start: 3, end: 3 + stagedMention.length,
      reference: { source: 'reference', ref: stagedMention, label: '演示 slides.pptx', clipboardText: stagedMention },
    }])
    expect(shell.snapshot.draft).toBe('/run 处理 @演示 slides.pptx')
    shell.submit()
    await vi.waitFor(() => { expect(submit).toHaveBeenCalledWith(`处理 ${stagedMention}`, expect.anything(), []) })
    expect(serializeReference).toHaveBeenCalledWith('reference', stagedMention, expect.any(AbortSignal))

    const failedSubmit = vi.fn()
    const failed = new SessionInputShell({
      actx: {} as ClientContext, defaultSink: vi.fn(), commandImages,
      inputTriggers: () => ({
        track: vi.fn(), serializeReference: () => Promise.reject(new Error('reference codec unavailable')),
      }) as unknown as InputTriggerController,
    })
    failed.setDraft(`/run ${stagedMention}`)
    expect(failed.beginCommand({ token: '/run ', submit: failedSubmit }, {
      start: 0, end: 5, draftRev: failed.snapshot.draftRev,
    })).toBe(true)
    failed.submit()
    await vi.waitFor(() => { expect(failed.notices.getSnapshot()?.text).toBe('reference codec unavailable') })
    expect(failed.snapshot.phase).toBe('claimed')
    expect(failedSubmit).not.toHaveBeenCalled()
    expect(failed.snapshot.draft).toBe('/run @演示 slides.pptx')
  })

  it('serializes file paths when Enter recognizes a command', async () => {
    const submit = vi.fn(() => Promise.resolve<SubmitOutcome>({ kind: 'success' }))
    const shell = new SessionInputShell({
      actx: {} as ClientContext, defaultSink: vi.fn(), commandImages,
      inputTriggers: () => ({
        track: vi.fn(), adjudicate: () => Promise.resolve({ claim: { token: '/run ', submit } }),
        serializeReference: (_source: string, ref: string) => Promise.resolve(ref),
      }) as unknown as InputTriggerController,
    })
    shell.setDraft(`/run ${stagedMention}`)
    expect(shell.snapshot.draft).toBe('/run @演示 slides.pptx')
    shell.submit()
    await vi.waitFor(() => { expect(submit).toHaveBeenCalledWith(stagedMention, expect.anything(), []) })
  })

  it('aborts Host-side preparation when the input shell is disposed', () => {
    let signal: AbortSignal | undefined
    const shell = new SessionInputShell({
      actx: {} as ClientContext,
      defaultSink: (_text, _imageIds, _mode, received) => {
        signal = received
        return new Promise<SubmitOutcome>(() => {})
      },
      commandImages,
    })
    shell.setDraft('send this')
    shell.submit()
    expect(signal?.aborted).toBe(false)
    shell.dispose()
    expect(signal?.aborted).toBe(true)
    expect(shell.snapshot.phase).toBe('plain')
    expect(shell.snapshot.draft).toBe('send this')
  })

  it('retains a rejected default message without duplicating its prompt error notice', async () => {
    const shell = new SessionInputShell({
      actx: {} as ClientContext,
      defaultSink: () => Promise.resolve({ kind: 'error' }),
      commandImages,
    })
    shell.setDraft('retry this')
    shell.submit()
    await vi.waitFor(() => {
      expect(shell.snapshot.phase).toBe('plain')
    })
    expect(shell.snapshot.draft).toBe('retry this')
    expect(shell.notices.getSnapshot()).toBeNull()
  })
})

describe('包内草稿交接', () => {
  it('迁移通用引用和图片，目标重新编号且提交使用目标来源，不携带旧命令闭包', async () => {
    const sourceSubmit = vi.fn()
    const release = vi.fn()
    const sink = vi.fn(() => Promise.resolve<SubmitOutcome>({ kind: 'success' }))
    const serializeReference = vi.fn((_source: string, ref: string) => Promise.resolve(ref))
    const source = new SessionInputShell({
      actx: {} as ClientContext, defaultSink: vi.fn(), commandImages: { ...commandImages, release },
    })
    const target = new SessionInputShell({
      actx: {} as ClientContext, defaultSink: sink, commandImages: { ...commandImages, release },
      inputTriggers: () => ({
        track: vi.fn(), serializeReference, adjudicate: () => Promise.resolve(undefined),
      }) as unknown as InputTriggerController,
    })
    chip(target)
    target.setDraft('目标旧草稿')
    source.setDraft(`/run ${stagedMention} 和 ${spacedMention}`)
    source.beginCommand({ token: '/run ', submit: sourceSubmit }, {
      start: 0, end: 5, draftRev: source.snapshot.draftRev,
    })
    const end = source.snapshot.draft.length
    source.pasteBegin(' custom', { start: end, end }, [{
      start: 1, end: 7,
      reference: { source: 'custom-source', ref: 'stable-ref', label: '领域引用', clipboardText: 'custom-code' },
    }])
    const image = 'transfer-image' as DraftAttachmentId
    source.addImages([image])
    const before = source.snapshot
    expect(source.moveDraftTo(target)).toBe(true)
    expect(source.snapshot).toMatchObject({ draft: '', imageIds: [], occurrences: [], phase: 'plain' })
    expect(target.snapshot).toMatchObject({
      draft: before.draft, imageIds: [image], phase: 'plain',
      occurrences: before.occurrences.map(({ occurrenceId: _occurrenceId, ...value }) => value),
    })
    expect(target.snapshot.occurrences[0]?.occurrenceId).not.toBe(before.occurrences[0]?.occurrenceId)
    expect(target.snapshot.paste).toBeUndefined()
    expect(target.snapshot.claim).toBeUndefined()
    expect(release).not.toHaveBeenCalled()
    target.submit()
    await vi.waitFor(() => { expect(sink).toHaveBeenCalledWith(
      `/run ${stagedMention} 和 ${spacedMention} stable-ref`, [image], 'queue', expect.any(AbortSignal),
    ) })
    expect(serializeReference).toHaveBeenCalledWith('custom-source', 'stable-ref', expect.any(AbortSignal))
    expect(sourceSubmit).not.toHaveBeenCalled()
  })

  it('镜像首次及重新绑定立即发布完整投影，后续无草稿变化不重复发布', () => {
    const shell = new SessionInputShell({ actx: {} as ClientContext, defaultSink: vi.fn(), commandImages })
    shell.setDraft(`读取 ${stagedMention}`)
    const first = vi.fn()
    const unbind = shell.bindMirror(first)
    expect(first).toHaveBeenCalledExactlyOnceWith(`读取 ${stagedMention}`)
    shell.addImages(['mirror-image' as DraftAttachmentId])
    expect(first).toHaveBeenCalledOnce()
    unbind()
    shell.setDraft('离开页面时更新')
    const next = vi.fn()
    shell.bindMirror(next)
    expect(next).toHaveBeenCalledExactlyOnceWith('离开页面时更新')
    shell.addImages([])
    expect(next).toHaveBeenCalledOnce()
  })

  it.each(['来源', '目标'] as const)('%s 空草稿不覆盖目标原有文字，但图片仍交接', (direction) => {
    const source = new SessionInputShell({ actx: {} as ClientContext, defaultSink: vi.fn(), commandImages })
    const target = new SessionInputShell({ actx: {} as ClientContext, defaultSink: vi.fn(), commandImages })
    if (direction === '目标') source.setDraft('来源文字')
    else target.setDraft('目标文字')
    source.addImages(['image' as DraftAttachmentId])
    expect(source.moveDraftTo(target)).toBe(true)
    expect(target.snapshot).toMatchObject({ draft: direction === '目标' ? '来源文字' : '目标文字', imageIds: ['image'] })
  })

  it.each(['来源', '目标'] as const)('%s 的提交锁包括纯图片请求，拒绝迁移且双方不变', async (direction) => {
    for (const phase of ['adjudicating', 'submitting', 'image-only'] as const) {
      let settle!: (outcome: SubmitOutcome) => void
      const busy = new SessionInputShell({
        actx: {} as ClientContext, commandImages,
        defaultSink: () => new Promise<SubmitOutcome>((resolve) => { settle = resolve }),
        ...(phase === 'adjudicating' ? {
          inputTriggers: () => ({ track: vi.fn(), adjudicate: () => new Promise(() => {}) }) as unknown as InputTriggerController,
        } : {}),
      })
      const idle = new SessionInputShell({ actx: {} as ClientContext, commandImages, defaultSink: vi.fn() })
      idle.setDraft('不能被改动')
      idle.addImages(['idle-image' as DraftAttachmentId])
      busy.addImages(['busy-image' as DraftAttachmentId])
      if (phase !== 'image-only') busy.setDraft(phase === 'adjudicating' ? '/pending' : '尚未提交完成')
      busy.submit()
      expect(busy.snapshot.phase).toBe(phase === 'image-only' ? 'plain' : phase)
      const beforeBusy = busy.snapshot
      const beforeIdle = idle.snapshot
      expect(direction === '来源' ? busy.moveDraftTo(idle) : idle.moveDraftTo(busy)).toBe(false)
      expect(busy.snapshot).toBe(beforeBusy)
      expect(idle.snapshot).toBe(beforeIdle)
      if (phase !== 'adjudicating') { settle({ kind: 'error' }); await Promise.resolve() }
      busy.dispose()
      idle.dispose()
    }
  })
})

describe('submit transaction hardening', () => {
  it('sends one image-only prompt per settlement, ignoring Enter during the round-trip', async () => {
    let settle!: (outcome: SubmitOutcome) => void
    const sink = vi.fn(() => new Promise<SubmitOutcome>((resolve) => { settle = resolve }))
    const shell = new SessionInputShell({
      actx: {} as ClientContext,
      defaultSink: sink,
      commandImages,
    })
    expect(shell.addImages(['img-1' as DraftAttachmentId])).toBe(true)
    shell.submit('queue')
    shell.submit('queue')
    expect(sink).toHaveBeenCalledTimes(1)
    settle({ kind: 'success' })
    await vi.waitFor(() => {
      expect(shell.snapshot.imageIds).toEqual([])
    })

    expect(shell.addImages(['img-2' as DraftAttachmentId])).toBe(true)
    shell.submit('queue')
    expect(sink).toHaveBeenCalledTimes(2)
  })

  it('retains an image-only rejection without duplicating its prompt error notice', async () => {
    const sink = vi.fn(() => Promise.resolve<SubmitOutcome>({ kind: 'error' }))
    const shell = new SessionInputShell({
      actx: {} as ClientContext,
      defaultSink: sink,
      commandImages,
    })
    const imageId = 'img-1' as DraftAttachmentId
    shell.addImages([imageId])
    shell.submit()
    await Promise.resolve()
    await Promise.resolve()
    expect(shell.snapshot.imageIds).toEqual([imageId])
    expect(shell.notices.getSnapshot()).toBeNull()
  })

  it('re-tracks at the caret when a continuing insert-text splice lands (directory descent)', () => {
    const track = vi.fn()
    const shell = new SessionInputShell({
      actx: {} as ClientContext,
      inputTriggers: () => ({ track } as unknown as InputTriggerController),
      defaultSink: vi.fn(),
      commandImages,
    })
    shell.setDraft('@sr')
    const applied = shell.insertText('@src/', { start: 0, end: 3, draftRev: shell.snapshot.draftRev }, true)
    expect(applied).toBe(true)
    expect(shell.snapshot.draft).toBe('@src/')
    expect(track).toHaveBeenCalledWith('@src/', 5, { tier: 'plain' }, shell.snapshot.draftRev)

    track.mockClear()
    shell.insertText(' plain ', { start: 0, end: 0, draftRev: shell.snapshot.draftRev })
    expect(track).not.toHaveBeenCalled()
  })
})
