// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AttachmentId, type ImageAttachmentRef } from 'coding-attachment'
import type { RunningToolCall, ToolResultNode } from 'coding-client-runtime/client'
import { makeTranslate } from 'coding-client-test-runtime'
import { ImageToolRow } from '../src/client/ImageToolRow.tsx'
import { zh } from '../src/client/locales.ts'

type Props = ComponentProps<typeof ImageToolRow>
const t: Props['t'] = makeTranslate(zh)
const argsRaw = JSON.stringify({ prompt: '晨光中的湖泊' })

const running = (overrides: Partial<RunningToolCall> = {}): RunningToolCall => ({
  callId: 'image-call', name: 'generate_image', argsRaw, time: 1_000,
  turn: 1, step: 1, callView: null, subCalls: [], ...overrides,
})

const attachment = (id = 'a'): ImageAttachmentRef => ({
  attachmentId: AttachmentId(`sha256:${id.repeat(64)}`),
  mediaType: 'image/png', bytes: 68, width: 640, height: 320,
})

const image = (id = 'a') => ({ type: 'image' as const, attachment: attachment(id) })
const result = (overrides: Partial<ToolResultNode> = {}): ToolResultNode => ({
  kind: 'tool-result', seq: 3, time: 5_000, callTime: 1_000, callId: 'image-call',
  call: { name: 'generate_image', argsRaw }, content: [image()],
  isError: false, callView: null, resultView: null, subCalls: [], ...overrides,
})

function props(block: Props['block'], overrides: Partial<Props> = {}): Props {
  return {
    t, block, callId: 'image-call', toolName: 'generate_image', sessionId: 'image-session',
    openFile: vi.fn(), openInStudio: vi.fn(), loadImage: vi.fn(async () => 'blob:generated'),
    ...overrides,
  } as unknown as Props
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('对话图片工具', () => {
  it('逐次说明显示在等待和结果上方，且不遮挡图片或失败提示', async () => {
    const description = '绘制清晨的湖泊'
    const describedArgs = JSON.stringify({ prompt: '晨光中的湖泊', display_description: ` ${description} ` })
    const view = render(<ImageToolRow {...props(running({ argsRaw: describedArgs }))} />)
    expect(view.container.querySelector('[data-image-tool-row]')?.firstElementChild?.textContent).toBe(description)
    expect(screen.getByText('正在创建图像')).toBeTruthy()
    view.rerender(<ImageToolRow {...props(result({ call: { name: 'generate_image', argsRaw: describedArgs } }))} />)
    expect(screen.getByText(description)).toBeTruthy()
    expect(screen.getByText('已生成 1 张图片')).toBeTruthy()
    expect(await screen.findByRole('img')).toBeTruthy()
    view.rerender(<ImageToolRow {...props(result({
      call: { name: 'generate_image', argsRaw: describedArgs }, isError: true, content: [],
    }))} />)
    expect(screen.getByText(description)).toBeTruthy()
    expect(screen.getByText('图片生成失败')).toBeTruthy()
  })

  it('历史图片调用继续显示 display_description', () => {
    const argsRaw = JSON.stringify({ prompt: '晨光中的湖泊', display_description: '历史绘图说明' })
    render(<ImageToolRow {...props(running({ argsRaw }))} />)
    expect(screen.getByText('历史绘图说明')).toBeTruthy()
  })

  it('旧记录和不完整调用参数安全回退到已有状态', () => {
    const view = render(<ImageToolRow {...props(running({ argsRaw: '{"display_description":' }))} />)
    expect(screen.getByText('正在创建图像')).toBeTruthy()
    expect(view.container.textContent).not.toContain('display_description')
    view.rerender(<ImageToolRow {...props(result({ call: null, content: [] }))} />)
    expect(screen.getByText('工具未返回图片')).toBeTruthy()
    expect(view.container.textContent).not.toContain('image-call')
  })

  it('执行中提供忙碌状态和等待动效，不虚构百分比或提前显示结果', () => {
    vi.useFakeTimers()
    const loadImage = vi.fn(async () => 'blob:unexpected')
    const view = render(<ImageToolRow {...props(running(), { loadImage })} />)
    expect(screen.getByRole('status').textContent).toBe('正在创建图像')
    expect(view.container.querySelector('section[aria-busy="true"]')).toBeTruthy()
    act(() => { vi.advanceTimersByTime(5_000) })
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(view.container.textContent).not.toMatch(/\d+\s*%/u)
    expect(screen.queryByRole('img')).toBeNull()
    expect(loadImage).not.toHaveBeenCalled()
  })

  it('执行完成停止等待与计时，使用真实附件图片并可打开和关闭大图', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const loadImage = vi.fn(async () => 'blob:generated')
    const base = props(running(), { loadImage })
    const view = render(<ImageToolRow {...base} />)
    act(() => { vi.advanceTimersByTime(2_000) })
    await act(async () => { view.rerender(<ImageToolRow {...base} block={result()} />) })
    expect(screen.queryByRole('status', { name: '正在创建图像' })).toBeNull()
    expect(screen.queryByText('正在创建图像')).toBeNull()
    expect(view.container.querySelector('[aria-busy="true"]')).toBeNull()
    expect(loadImage).toHaveBeenCalledWith(attachment())
    const preview = screen.getByRole('img')
    expect(preview.getAttribute('src')).toBe('blob:generated')
    const contentAfterResult = view.container.textContent
    act(() => { vi.advanceTimersByTime(30_000) })
    expect(view.container.textContent).toBe(contentAfterResult)
    expect(vi.getTimerCount()).toBe(0)
    const opener = preview.closest('button')
    expect(opener).toBeTruthy()
    fireEvent.click(opener!)
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('img').getAttribute('src')).toBe('blob:generated')
    fireEvent.click(within(dialog).getByRole('button', { name: /关闭/u }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(opener!)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('下载、画图入口和调用详情同排放在图片下方，耗时不混入操作栏', async () => {
    const openInStudio = vi.fn()
    const inspect = vi.fn()
    render(<ImageToolRow {...props(result(), { openInStudio, inspect })} />)
    await screen.findByRole('img')
    const download = screen.getByRole('button', { name: '下载图片' })
    const actions = download.parentElement!
    expect(Array.from(actions.querySelectorAll('button'), button => button.textContent))
      .toEqual(['下载图片', '在画图中查看', '调用详情'])
    expect(actions.previousElementSibling).toBe(screen.getByRole('button', { name: '查看大图' }))
    expect(within(actions).queryByText('耗时 4.0 秒')).toBeNull()
    expect(screen.getByText('耗时 4.0 秒')).toBeTruthy()
    fireEvent.click(within(actions).getByRole('button', { name: '在画图中查看' }))
    expect(openInStudio).toHaveBeenCalledOnce()
    expect(openInStudio).toHaveBeenCalledWith(attachment().attachmentId)
    fireEvent.click(within(actions).getByRole('button', { name: '调用详情' }))
    expect(inspect).toHaveBeenCalledOnce()
  })

  it.each([
    { isError: true },
    { error: { name: 'AbortError', code: 'interrupted' } },
    { error: { name: 'AbortError', code: 'ABORTED' } },
    { error: { name: 'AbortError', code: 'ABORTED_BEFORE_DISPATCH' } },
  ])('失败或中断结果停止计时，且不将错误内容里的图片当作成功：%j', async (failure) => {
    vi.useFakeTimers()
    const loadImage = vi.fn(async () => 'blob:false-success')
    const base = props(running(), { loadImage })
    const view = render(<ImageToolRow {...base} />)
    await act(async () => { view.rerender(<ImageToolRow {...base} block={result(failure)} />) })
    expect(screen.queryByText('正在创建图像')).toBeNull()
    expect(view.container.querySelector('[aria-busy="true"]')).toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
    expect(loadImage).not.toHaveBeenCalled()
    expect(view.container.textContent).toMatch(/失败|中断|停止|取消/u)
    const settledText = view.container.textContent
    act(() => { vi.advanceTimersByTime(30_000) })
    expect(view.container.textContent).toBe(settledText)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('批量结果直接展示每张成功图片，并按请求数量说明部分失败', async () => {
    const loadImage = vi.fn(async (ref: ImageAttachmentRef) => `blob:${ref.attachmentId}`)
    const openInStudio = vi.fn()
    const block = result({
      call: { name: 'generate_images', argsRaw: JSON.stringify({ prompts: ['晨光', '夜景', '森林'] }) },
      content: [image('a'), { type: 'text', text: '2 images generated' }, image('b')],
    })
    render(<ImageToolRow {...props(block, { toolName: 'generate_images', loadImage, openInStudio, inspect: vi.fn() })} />)
    await waitFor(() => { expect(screen.getAllByRole('img')).toHaveLength(2) })
    expect(loadImage).toHaveBeenCalledWith(attachment('a'))
    expect(loadImage).toHaveBeenCalledWith(attachment('b'))
    expect(screen.getByText('1 张图片生成失败')).toBeTruthy()
    expect(screen.queryByText('正在创建图像')).toBeNull()
    const downloads = screen.getAllByRole('button', { name: '下载图片' })
    expect(downloads).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: '在画图中查看' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: '调用详情' })).toHaveLength(1)
    expect(within(downloads[1]!.parentElement!).getByRole('button', { name: '在画图中查看' })).toBeTruthy()
    expect(within(downloads[1]!.parentElement!).getByRole('button', { name: '调用详情' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '在画图中查看' }))
    expect(openInStudio).toHaveBeenCalledWith(attachment('b').attachmentId)
  })

  it.each([
    { content: [], call: { name: 'generate_image', argsRaw } },
    { content: [{ type: 'text' as const, text: '{"failures":[{"index":0,"error":"provider failed"}]}' }],
      call: { name: 'generate_images', argsRaw: JSON.stringify({ prompts: ['晨光'] }) } },
  ])('没有返回图片的终态不会显示成功：%j', (overrides) => {
    const view = render(<ImageToolRow {...props(result(overrides))} />)
    expect(screen.queryByText('正在创建图像')).toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
    expect(view.container.textContent).toMatch(/失败|未返回图片/u)
    expect(view.container.textContent).not.toMatch(/生成成功|图片已生成/u)
  })

  it('没有附件读取器时显示静态错误，不提供无法执行的重试', () => {
    const view = render(<ImageToolRow {...props(result(), { loadImage: undefined })} />)
    expect(screen.getByText('图片暂时无法显示')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /重试/u })).toBeNull()
    expect(screen.queryByText('正在创建图像')).toBeNull()
    expect(view.container.querySelector('[aria-busy="true"]')).toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('附件加载失败后允许重试，重试成功恢复真实缩略图', async () => {
    const loadImage = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce('blob:retried')
    const inspect = vi.fn()
    render(<ImageToolRow {...props(result(), { loadImage, inspect })} />)
    const retry = await screen.findByRole('button', { name: /重试/u })
    expect(screen.queryByText('正在创建图像')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '调用详情' }))
    expect(inspect).toHaveBeenCalledOnce()
    fireEvent.click(retry)
    await waitFor(() => { expect(screen.getByRole('img').getAttribute('src')).toBe('blob:retried') })
    expect(loadImage).toHaveBeenCalledTimes(2)
  })

  it('图片元素加载失败时移除坏图，重试重新读取附件', async () => {
    const loadImage = vi.fn()
      .mockResolvedValueOnce('blob:broken')
      .mockResolvedValueOnce('blob:recovered')
    render(<ImageToolRow {...props(result(), { loadImage })} />)
    fireEvent.error(await screen.findByRole('img'))
    expect(screen.queryByRole('img')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /重试/u }))
    await waitFor(() => { expect(screen.getByRole('img').getAttribute('src')).toBe('blob:recovered') })
    expect(loadImage).toHaveBeenCalledTimes(2)
  })

  it('附件切换后忽略旧请求迟到的结果，卸载后拒绝也不产生界面回写', async () => {
    const old = deferred<string>()
    const current = deferred<string>()
    const loadImage = vi.fn()
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(current.promise)
    const base = props(result(), { loadImage })
    const view = render(<ImageToolRow {...base} />)
    view.rerender(<ImageToolRow {...base} block={result({ content: [image('b')] })} />)
    await act(async () => { current.resolve('blob:current') })
    expect(screen.getByRole('img').getAttribute('src')).toBe('blob:current')
    await act(async () => { old.resolve('blob:stale') })
    expect(screen.getByRole('img').getAttribute('src')).toBe('blob:current')
    view.unmount()
    const late = deferred<string>()
    const another = render(<ImageToolRow {...props(result(), { loadImage: () => late.promise })} />)
    another.unmount()
    await act(async () => { late.reject(new Error('late failure')) })
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.queryByRole('button', { name: /重试/u })).toBeNull()
  })
})
