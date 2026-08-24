// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { DocumentTitle } from '../src/client/DocumentTitle.tsx'

afterEach(() => {
  cleanup()
  document.title = ''
  vi.unstubAllEnvs()
})

describe('DocumentTitle', () => {
  it('projects a durable title and restores the product title', () => {
    vi.stubEnv('DSH_CLIENT_TITLE', 'Coding')
    document.title = 'stale title'
    const mounted = render(<DocumentTitle />)
    expect(document.title).toBe('Coding')
    mounted.rerender(<DocumentTitle title="First title" />)
    expect(document.title).toBe('First title — Coding')
    mounted.rerender(<DocumentTitle title="Revised title" />)
    expect(document.title).toBe('Revised title — Coding')
    mounted.rerender(<DocumentTitle />)
    expect(document.title).toBe('Coding')
    mounted.unmount()
    expect(document.title).toBe('Coding')
  })

  it('uses the generic title when the build provides no title', () => {
    vi.stubEnv('DSH_CLIENT_TITLE', '')
    delete process.env.DSH_CLIENT_TITLE
    const mounted = render(<DocumentTitle title="First title" />)
    expect(document.title).toBe('First title — Coding')
    mounted.unmount()
    expect(document.title).toBe('Coding')
  })
})
