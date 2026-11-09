// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { installAssembledBootEnv, mountAssembledApp } from './assembled-boot.ts'

installAssembledBootEnv()

it('loads the Files settings section from the built plugin roster only after navigation', async () => {
  const fetchFiles = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (target !== '/api/files/list?offset=0&limit=50') {
      throw new Error(`Unexpected assembled-app fetch: ${target}`)
    }
    return new Response(JSON.stringify({ items: [], total: 0 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fetchFiles)
  mountAssembledApp()

  fireEvent.click(await screen.findByRole('button', { name: 'Settings' }, { timeout: 10_000 }))
  const settings = await screen.findByRole('main', { name: 'Settings' })
  const filesNav = await within(settings).findByRole('button', { name: 'Files' })
  expect(fetchFiles).not.toHaveBeenCalled()
  expect(within(settings).queryByRole('heading', { name: 'Files' })).toBeNull()

  fireEvent.click(filesNav)
  await within(settings).findByRole('heading', { name: 'Files' })
  await within(settings).findByText('No files have been saved yet.')
  await waitFor(() => { expect(fetchFiles).toHaveBeenCalledTimes(1) })
  const [url, options] = fetchFiles.mock.calls[0] ?? []
  expect(url).toBe('/api/files/list?offset=0&limit=50')
  expect(options?.method).toBe('GET')
  expect(options?.signal).toBeInstanceOf(AbortSignal)
  expect(document.head.querySelector('style[data-plugin="coding-client-ui-files"]')).not.toBeNull()
})
