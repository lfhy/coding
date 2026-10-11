// @vitest-environment jsdom
/** 模型 UA 行在草稿校验、保存和恢复默认时的可见行为。 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { ModelUserAgentRowProps } from '../src/client/ModelUserAgentRow.tsx'
import { ModelUserAgentRow, validModelUserAgent } from '../src/client/ModelUserAgentRow.tsx'
import type { ModelUserAgentState } from '../src/client/model-user-agent.ts'
import { zh } from '../src/client/locales.ts'

const DEFAULT = 'deepseek-harness/1 (+https://example.com)'
afterEach(cleanup)

function setup(overrides: Partial<ModelUserAgentState> = {}) {
  const store = createSnapshotStore<ModelUserAgentState>({
    status: 'ready', value: DEFAULT, overridden: false, writable: true, saving: false, error: false,
    ...overrides,
  })
  const save = vi.fn(async (value: string) => {
    store.update((state) => { state.value = value || DEFAULT; state.overridden = value !== '' })
    return true
  })
  const props = { useUserAgent: bindSnapshotSelector(store), save, t: (key: keyof typeof zh) => zh[key] } as ModelUserAgentRowProps
  render(<ModelUserAgentRow {...props} />)
  return { store, save }
}

describe('model request User-Agent row', () => {
  it('rejects blank, control, Unicode and excessive header values', () => {
    expect(validModelUserAgent('agent/1.0')).toBe(true)
    for (const value of ['', '   ', 'agent\r\ninjected', '请求/1', 'a'.repeat(257)]) {
      expect(validModelUserAgent(value)).toBe(false)
    }
  })

  it('saves a valid UA and restores the inherited product default', async () => {
    const { save } = setup()
    const input = screen.getByRole('textbox', { name: zh.userAgentTitle }) as HTMLInputElement
    expect(input.value).toBe(DEFAULT)
    fireEvent.change(input, { target: { value: 'gateway-client/2' } })
    fireEvent.click(screen.getByRole('button', { name: zh.save }))
    await waitFor(() => { expect(save).toHaveBeenCalledWith('gateway-client/2') })
    await waitFor(() => { expect(input.value).toBe('gateway-client/2') })
    fireEvent.click(screen.getByRole('button', { name: zh.userAgentReset }))
    await waitFor(() => { expect(save).toHaveBeenCalledWith('') })
    await waitFor(() => { expect(input.value).toBe(DEFAULT) })
  })

  it('blocks an invalid draft and shows read-only or failed states', () => {
    const { store, save } = setup()
    const input = screen.getByRole('textbox', { name: zh.userAgentTitle })
    fireEvent.change(input, { target: { value: '   ' } })
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText(zh.userAgentInvalid)).toBeTruthy()
    expect(screen.getByRole('button', { name: zh.save }).hasAttribute('disabled')).toBe(true)
    expect(save).not.toHaveBeenCalled()
    act(() => { store.update((state) => { state.error = true; state.writable = false }) })
    expect(screen.getByRole('alert').textContent).toBe(zh.userAgentFailed)
    expect(screen.getByText(zh.readOnly)).toBeTruthy()
    expect(input.hasAttribute('disabled')).toBe(true)
  })

  it('retains the draft and reports a rejected settings write', async () => {
    const scope = {
      getSnapshot: () => ({ status: 'ready' as const, value: { userAgent: DEFAULT }, user: {}, writable: true }),
      subscribe: () => () => {},
      set: vi.fn(async () => {}),
      unset: vi.fn(async () => {}),
    }
    const { ModelUserAgentController } = await import('../src/client/model-user-agent.ts')
    const controller = new ModelUserAgentController(scope as never)
    expect(await controller.save('gateway/2')).toBe(false)
    expect(controller.store.getSnapshot().error).toBe(true)
    expect(scope.set).toHaveBeenCalledWith('userAgent', 'gateway/2')
  })

  it('hides controls if the host has no llm settings namespace', () => {
    setup({ status: 'unavailable' })
    expect(screen.getByRole('status').textContent).toBe(zh.userAgentUnavailable)
    expect(screen.queryByRole('textbox')).toBeNull()
  })
})
