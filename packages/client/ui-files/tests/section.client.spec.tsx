// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FilesSection, type FilesSectionInjected, type FilesSectionProps } from '../src/client/FilesSection.tsx'
import { zh } from '../src/client/locales.ts'
import type { ManagedFilesPage } from '../src/client/wire.ts'

afterEach(cleanup)

const first = {
  id: 'a', kind: 'upload' as const, name: 'a very long document name.txt', relativePath: 'uploads/a.txt',
  mediaType: 'text/plain', bytes: 1024, createdAt: '2026-11-09T08:00:00.000Z',
}
const second = {
  ...first, id: 'b', kind: 'generated-image' as const, name: 'image.png',
  relativePath: 'images/image.png', bytes: 2097152,
}

function view(list: FilesSectionInjected['list']) {
  return render(<FilesSection {...({ list, t: (key: keyof typeof zh) => zh[key] } as FilesSectionProps)} />)
}

describe('FilesSection', () => {
  it('打开分区才读取第一页，呈现名称、类型、大小、时间和下一页', async () => {
    const list = vi.fn(async (offset: number, _limit: number, _signal: AbortSignal): Promise<ManagedFilesPage> => offset === 0
      ? { items: [first], total: 2, nextOffset: 1 }
      : { items: [second], total: 2 })
    expect(list).not.toHaveBeenCalled()
    view(list)
    expect(screen.getByRole('status').textContent).toContain('正在读取')
    expect(await screen.findByText(first.name)).toBeTruthy()
    expect(screen.getByText('上传文件')).toBeTruthy()
    expect(screen.getByText('1 KB')).toBeTruthy()
    expect(screen.getByText('2个文件')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }))
    expect(await screen.findByText(second.name)).toBeTruthy()
    expect(screen.getByText('生成图片')).toBeTruthy()
    expect(screen.getByText('2 MB')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '加载更多' })).toBeNull()
    expect(list.mock.calls.map(call => call[0])).toEqual([0, 1])
    expect(list.mock.calls.every(call => call[1] === 50)).toBe(true)
  })

  it('空目录和失败重试均提供可见状态', async () => {
    const list = vi.fn<FilesSectionInjected['list']>().mockRejectedValueOnce(new Error('private path'))
      .mockResolvedValueOnce({ items: [], total: 0 })
    view(list)
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '无法读取文件列表。重试')
    expect(screen.queryByText('private path')).toBeNull()
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: '重试' }))
    expect(await screen.findByText('还没有保存的文件。')).toBeTruthy()
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('翻页失败保留已经读取的条目，并可从原游标重试', async () => {
    const list = vi.fn<FilesSectionInjected['list']>().mockResolvedValueOnce({ items: [first], total: 2, nextOffset: 1 })
      .mockRejectedValueOnce(new Error('failed'))
      .mockResolvedValueOnce({ items: [second], total: 2 })
    view(list)
    fireEvent.click(await screen.findByRole('button', { name: '加载更多' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText(first.name)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText(second.name)).toBeTruthy()
    expect(list.mock.calls.map(call => call[0])).toEqual([0, 1, 1])
  })

  it('分页期间新增文件时从第一页重读，最终不遗漏或重复文件', async () => {
    const newest = { ...first, id: 'c', name: 'newest.txt', relativePath: 'uploads/newest.txt' }
    const list = vi.fn<FilesSectionInjected['list']>()
      .mockResolvedValueOnce({ items: [first], total: 2, nextOffset: 1 })
      .mockResolvedValueOnce({ items: [first], total: 3, nextOffset: 2 })
      .mockResolvedValueOnce({ items: [newest], total: 3, nextOffset: 1 })
      .mockResolvedValueOnce({ items: [first, first], total: 3, nextOffset: 2 })
      .mockResolvedValueOnce({ items: [second], total: 3 })
    view(list)
    fireEvent.click(await screen.findByRole('button', { name: '加载更多' }))
    expect(await screen.findByText(newest.name)).toBeTruthy()
    expect(screen.queryByText(first.name)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }))
    expect(await screen.findByText(first.name)).toBeTruthy()
    expect(screen.getAllByText(first.name)).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }))
    expect(await screen.findByText(second.name)).toBeTruthy()
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
    expect(list.mock.calls.map(call => call[0])).toEqual([0, 1, 0, 1, 2])
  })

  it('卸载时取消正在读取的请求', () => {
    const list = vi.fn((_offset: number, _limit: number, _signal: AbortSignal) => new Promise<ManagedFilesPage>(() => {}))
    const mounted = view(list)
    const signal = list.mock.calls[0]?.[2] as AbortSignal
    expect(signal.aborted).toBe(false)
    mounted.unmount()
    expect(signal.aborted).toBe(true)
  })

  it('无进展的下一页游标显示可重试错误', async () => {
    view(async () => ({ items: [first], total: 2, nextOffset: 0 }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByText(first.name)).toBeNull()
  })
})
