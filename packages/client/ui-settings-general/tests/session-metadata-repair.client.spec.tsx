// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SessionMetadataRepair } from '../src/client/SessionMetadataRepair.tsx'
import type { SessionMetadataRepairProps } from '../src/client/SessionMetadataRepair.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

const unusedHook = (() => { throw new Error('unused') }) as never
const kit = { useSessions: unusedHook, useWorkspaces: unusedHook }

function translation(dictionary: Record<string, string>): SessionMetadataRepairProps['t'] {
  return (key, params) => (dictionary[key] ?? key).replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params?.[name]
    return typeof value === 'string' || typeof value === 'number' ? String(value) : match
  })
}

const emptyReport = { total: 0, rebuilt: 0, skippedLive: 0, failures: [] }

describe('SessionMetadataRepair', () => {
  it('describes the limited repair and reports successful counts in Chinese', async () => {
    const rebuildMetadata = vi.fn().mockResolvedValue({ total: 8, rebuilt: 5, skippedLive: 3, failures: [] })
    render(<SessionMetadataRepair {...kit} rebuildMetadata={rebuildMetadata} t={translation(zh)} />)
    const button = screen.getByRole('button', { name: '修复会话元数据' })
    expect(document.getElementById(button.getAttribute('aria-describedby')!)?.textContent).toBe(zh['metadata.description'])
    expect(screen.getByText(/不修改原始日志，也不能修复日志内容损坏/)).toBeTruthy()
    expect(rebuildMetadata).not.toHaveBeenCalled()
    fireEvent.click(button)
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe('扫描完成：共 8 个，已重建 5 个，跳过已加载会话 3 个，失败 0 个。')
    })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(button.hasAttribute('disabled')).toBe(false)
  })

  it('shows loading without duplicate submission and then handles an empty scan', async () => {
    let finish!: (value: typeof emptyReport) => void
    const rebuildMetadata = vi.fn(() => new Promise<typeof emptyReport>((resolve) => { finish = resolve }))
    render(<SessionMetadataRepair {...kit} rebuildMetadata={rebuildMetadata} t={translation(en)} />)
    const button = screen.getByRole('button', { name: 'Repair session metadata' })
    act(() => {
      fireEvent.click(button)
      fireEvent.click(button)
    })
    expect(screen.getByRole('status').textContent).toBe('Rebuilding session metadata…')
    expect(button.hasAttribute('disabled')).toBe(true)
    fireEvent.click(button)
    expect(rebuildMetadata).toHaveBeenCalledOnce()
    await act(async () => { finish(emptyReport) })
    expect(screen.getByRole('status').textContent).toBe('Scan complete: 0 total, 0 rebuilt, 0 loaded sessions skipped, 0 failed.')
    expect(button.hasAttribute('disabled')).toBe(false)
  })

  it('lists every failed session and its reason alongside partial-success counts', async () => {
    const rebuildMetadata = vi.fn().mockResolvedValue({
      total: 4,
      rebuilt: 1,
      skippedLive: 1,
      failures: [
        { sessionId: 'damaged-log', message: 'Committed event sequence is invalid' },
        { sessionId: 'unreadable-log', message: 'Permission denied' },
      ],
    })
    render(<SessionMetadataRepair {...kit} rebuildMetadata={rebuildMetadata} t={translation(en)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Repair session metadata' }))
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('4 total, 1 rebuilt, 1 loaded sessions skipped, 2 failed')
    })
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('original logs are unchanged')
    expect(screen.getAllByRole('listitem').map(item => item.textContent)).toEqual([
      'damaged-log：Committed event sequence is invalid',
      'unreadable-log：Permission denied',
    ])
    expect(screen.getByRole('button', { name: 'Repair session metadata' }).hasAttribute('disabled')).toBe(false)
  })

  it.each([new Error('Host cache is read-only'), 'network unavailable'])('keeps the rejection reason visible and permits retry: %s', async (cause) => {
    const rebuildMetadata = vi.fn().mockRejectedValueOnce(cause).mockResolvedValueOnce(emptyReport)
    render(<SessionMetadataRepair {...kit} rebuildMetadata={rebuildMetadata} t={translation(en)} />)
    const button = screen.getByRole('button', { name: 'Repair session metadata' })
    fireEvent.click(button)
    const reason = cause instanceof Error ? cause.message : cause
    expect((await screen.findByRole('alert')).textContent).toBe(`Could not rebuild session metadata: ${reason}`)
    expect(button.hasAttribute('disabled')).toBe(false)
    fireEvent.click(button)
    expect(screen.queryByRole('alert')).toBeNull()
    await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('Scan complete') })
    expect(rebuildMetadata).toHaveBeenCalledTimes(2)
  })

  it.each(['resolve', 'reject'] as const)('aborts on unmount and ignores a late %s', async (settlement) => {
    let finish!: (value: typeof emptyReport) => void
    let fail!: (reason: Error) => void
    const rebuildMetadata = vi.fn((_signal: AbortSignal) => new Promise<typeof emptyReport>((resolve, reject) => {
      finish = resolve
      fail = reject
    }))
    const view = render(<SessionMetadataRepair {...kit} rebuildMetadata={rebuildMetadata} t={translation(en)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Repair session metadata' }))
    const signal = rebuildMetadata.mock.calls[0]![0]
    expect(signal.aborted).toBe(false)
    view.unmount()
    expect(signal.aborted).toBe(true)
    await act(async () => {
      if (settlement === 'resolve') finish(emptyReport)
      else fail(new Error('late failure'))
    })
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
