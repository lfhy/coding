// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSyncExternalStore } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { SessionLogDownloadController } from '../src/client/controller.ts'
import { SessionLogDownloadContribution } from '../src/client/Contribution.tsx'
import type { SessionLogDownloadDialogProps } from '../src/client/Dialog.tsx'
import { en } from '../src/client/locales.ts'

const SID = 'session-export-contribution' as SessionId

function bindSessionExport(controller: SessionLogDownloadController) {
  return function useSessionLogDownload<T>(selector: (state: ReturnType<typeof controller.store.getSnapshot>) => T): T {
    return useSyncExternalStore(
      listener => controller.store.subscribe(listener),
      () => selector(controller.store.getSnapshot()),
    )
  }
}

function bench() {
  const controller = new SessionLogDownloadController(async () => new Response('zip'), vi.fn())
  const dismiss = vi.fn((sessionId: SessionId) => { controller.dismiss(sessionId) })
  const props = {
    sessionId: SID,
    useSessionLogDownload: bindSessionExport(controller),
    dismiss,
    t: (key: keyof typeof en): string => en[key],
  } as unknown as SessionLogDownloadDialogProps
  const view = render(<SessionLogDownloadContribution {...props} />)
  return { controller, dismiss, view }
}

afterEach(cleanup)

describe('Session export Header contribution', () => {
  it('renders no export control inside the Session Header', () => {
    const b = bench()
    expect(b.view.queryByRole('button', { name: 'Session log' })).toBeNull()
    expect(b.view.queryAllByRole('button')).toHaveLength(0)
    expect(b.view.container.textContent).toBe('')
  })

  it('shows the shared dialog for a controller-driven slash download', async () => {
    const b = bench()
    const download = b.controller.download(SID)
    expect(await b.view.findByRole('dialog', { name: 'Exporting Session' })).toBeTruthy()
    await download
    expect(await b.view.findByRole('dialog', { name: 'Session download started' })).toBeTruthy()
    const close = b.view.getAllByRole('button', { name: 'Close' })[0]
    if (close === undefined) throw new Error('Session export dialog has no close button')
    close.click()
    await waitFor(() => { expect(b.dismiss).toHaveBeenCalledWith(SID) })
  })
})
