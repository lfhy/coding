// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { ComponentProps } from 'react'
import type { ModelDirectoryState } from '../src/client/directory.ts'
import { ModelSelect } from '../src/client/ModelSelect.tsx'
import { en, zh } from '../src/client/locales.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'

// 测试翻译按包字典、公共字典、键名的实际顺序回退。
function translator(dictionary: Record<string, string>): ComponentProps<typeof ModelSelect>['t'] {
  return (key, params) => {
    const template = dictionary[key] ?? (commonZh as Record<string, string>)[key] ?? key
    return params === undefined
      ? template
      : template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
  }
}
const t = translator(zh)

const reasoning = {
  efforts: [
    { id: 'off', name: 'Off' },
    { id: 'high', name: 'High' },
    { id: 'max', name: 'Max', description: 'Largest budget' },
  ],
  defaultEffort: 'high',
}

function state(overrides: Partial<ModelDirectoryState> = {}): ModelDirectoryState {
  return {
    current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    routable: true,
    groups: [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning }],
    }],
    failures: [],
    status: 'ready',
    error: null,
    ...overrides,
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ModelSelect reasoning effort', () => {
  it('renders adapter metadata and submits the effort as part of the session selection', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state())
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.set(state({ current: selection }))
      return true
    })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    const trigger = screen.getByRole('button', {
      name: '选择模型，当前 DeepSeek-V4-Flash，推理等级 High',
    })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: 'DeepSeek' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['none', 'High', 'MaxLargest budget'])

    fireEvent.click(screen.getByRole('menuitemradio', { name: /Max/ }))
    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'max',
      })
      expect(trigger.getAttribute('aria-label')).toBe('选择模型，当前 DeepSeek-V4-Flash，推理等级 Max')
    })
  })

  it('labels the off effort as none while submitting the adapter wire value', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state())
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.set(state({ current: selection }))
      return true
    })
    render(<ModelSelect locked={false} available directory={directory} load={vi.fn()} select={select} t={t} />)

    fireEvent.click(screen.getByRole('button', { name: /选择模型，当前/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'DeepSeek' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'none' }))

    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({ provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'off' })
      expect(screen.getByRole('button', { name: '选择模型，当前 DeepSeek-V4-Flash，推理等级 none' })).toBeTruthy()
    })
  })

  it('offers provider default only when the adapter does not configure a model default', () => {
    const directory = createSnapshotStore(state({
      groups: [{
        id: 'provider',
        name: 'Provider',
        models: [{
          id: 'model',
          name: 'Model',
          reasoning: { efforts: [{ id: 'standard', name: 'Standard' }] },
        }],
      }],
      current: { provider: 'provider', model: 'model' },
    }))
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue(true)}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', {
      name: '选择模型，当前 Model，推理等级 Default',
    }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Provider' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['Default', 'Standard'])
  })

  it('prompts for a selection when the current model is no longer advertised', () => {
    const directory = createSnapshotStore(state({
      current: { provider: 'deepseek-official', model: 'removed-model' },
    }))
    const select = vi.fn().mockResolvedValue(true)
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    const trigger = screen.getByRole('button', { name: '选择模型' })
    expect(trigger.textContent).toContain('选择模型')
    fireEvent.click(trigger)
    expect(screen.queryByRole('menuitem', { name: /推理等级/ })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: 'DeepSeek' }))
    expect(screen.queryByText('removed-model')).toBeNull()
    expect(screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' })).toBeTruthy()
  })

  it('announces a rejected selection as a transient toast and keeps the in-menu strip for loads', async () => {
    const groups = [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
      ],
    }]
    const directory = createSnapshotStore<ModelDirectoryState>(state({ groups }))
    const select = vi.fn(async () => {
      directory.set(state({ groups, status: 'error', error: 'model-unavailable: session already contains images' }))
      return false
    })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', { name: /选择模型|当前/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'DeepSeek' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /DeepSeek-V4-Pro/ }))
    const toast = await screen.findByRole('alert')
    expect(toast.textContent).toContain('模型操作失败：model-unavailable: session already contains images')
    // 选择失败不触发目录加载重试入口。
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
  })

  it('updates the open composer channel label from a refreshed directory', () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state())
    render(<ModelSelect locked={false} available directory={directory} load={vi.fn()} select={vi.fn()} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: /选择模型，当前/ }))
    expect(screen.getByRole('menuitem', { name: 'DeepSeek' })).toBeTruthy()

    act(() => {
      directory.set(state({ groups: [{ ...state().groups[0]!, name: '团队渠道' }] }))
    })
    expect(screen.queryByRole('menuitem', { name: 'DeepSeek' })).toBeNull()
    expect(screen.getByRole('menuitem', { name: '团队渠道' }).getAttribute('aria-current')).toBe('true')
  })

  it('lists real channels first, scopes models to one channel, and supports back and focus', async () => {
    const directory = createSnapshotStore(state({
      groups: [
        { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning }] },
        { id: 'moonshot', name: 'Moonshot', models: [{ id: 'kimi', name: 'Kimi' }] },
      ],
    }))
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.set({ ...directory.getSnapshot(), current: selection })
      return true
    })
    render(<ModelSelect locked={false} available directory={directory} load={vi.fn()} select={select} t={t} />)

    const trigger = screen.getByRole('button', { name: /选择模型，当前/ })
    fireEvent.click(trigger)
    const selected = screen.getByRole('menuitem', { name: 'DeepSeek' })
    expect(selected.getAttribute('aria-current')).toBe('true')
    expect(selected.querySelector('svg')).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Moonshot' }).getAttribute('aria-current')).toBeNull()
    expect(screen.queryByRole('menuitemradio')).toBeNull()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Moonshot' }))
    expect(screen.getByRole('menuitemradio', { name: 'Kimi' })).toBeTruthy()
    expect(screen.queryByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /推理等级/ })).toBeNull()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.getByRole('menuitem', { name: 'DeepSeek' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'DeepSeek' })).toBe(document.activeElement)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Moonshot' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Kimi' }))
    await waitFor(() => { expect(select).toHaveBeenCalledWith({ provider: 'moonshot', model: 'kimi' }) })
    expect(trigger).toBe(document.activeElement)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it.each([
    { viewport: 375, anchorLeft: 180, anchorRight: 296 },
    { viewport: 480, anchorLeft: 282, anchorRight: 398 },
    { viewport: 1024, anchorLeft: 600, anchorRight: 720 },
  ])('keeps the whole channel menu inside the clipped conversation at $viewport px', ({ viewport, anchorLeft, anchorRight }) => {
    vi.stubGlobal('innerWidth', viewport)
    const directory = createSnapshotStore(state())
    render(<div data-test-clip style={{ overflow: 'hidden' }}>
      <ModelSelect locked={false} available directory={directory} load={vi.fn()} select={vi.fn()} t={t} />
    </div>)
    const trigger = screen.getByRole('button', { name: /选择模型，当前/ })
    const anchor = trigger.parentElement!
    const clip = anchor.parentElement!
    expect(getComputedStyle(clip).overflow).toBe('hidden')
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const left = this === anchor ? anchorLeft : this === clip ? 56 : 0
      const right = this === anchor ? anchorRight : this === clip ? viewport : 0
      return { left, right, width: right - left, top: 0, bottom: 0, height: 0 } as DOMRect
    })

    fireEvent.click(trigger)
    const menu = screen.getByRole('menu') as HTMLElement
    const left = anchorLeft + Number.parseFloat(menu.style.left)
    const right = left + Number.parseFloat(menu.style.width)
    expect(left).toBeGreaterThanOrEqual(68)
    expect(right).toBeLessThanOrEqual(viewport - 12)
    expect(Number.parseFloat(menu.style.width)).toBeLessThanOrEqual(260)
    const current = screen.getByRole('menuitem', { name: 'DeepSeek' })
    expect(current.getAttribute('aria-current')).toBe('true')
    expect(current.firstElementChild?.querySelector('svg')).toBeTruthy()
    expect(current.lastElementChild?.tagName.toLowerCase()).toBe('svg')
  })

  it('closes on outside click and restores trigger focus after nested Escape', () => {
    const directory = createSnapshotStore(state())
    render(<><button type="button">Outside</button><ModelSelect locked={false} available directory={directory} load={vi.fn()} select={vi.fn()} t={t} /></>)
    const trigger = screen.getByRole('button', { name: /选择模型，当前/ })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: 'DeepSeek' }))
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.getByRole('menuitem', { name: 'DeepSeek' })).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(trigger)
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Outside' }))
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('keeps catalog failures and retry visible at the channel level', () => {
    const directory = createSnapshotStore(state({
      failures: [{ id: 'broken', name: 'Broken', message: 'offline' }],
      error: 'catalog timeout',
      status: 'error',
    }))
    const load = vi.fn()
    render(<ModelSelect locked={false} available directory={directory} load={load} select={vi.fn()} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: /选择模型，当前/ }))
    expect(screen.getByRole('menuitem', { name: 'DeepSeek' })).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('catalog timeout')
    expect(screen.getByText('Broken 加载失败：offline')).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: '重试' })[0]!)
    expect(load).toHaveBeenCalledTimes(3)
  })

  it('relabels the open channel picker when the locale changes', () => {
    const directory = createSnapshotStore(state())
    const props = { locked: false, available: true, directory, load: vi.fn(), select: vi.fn(), t }
    const { rerender } = render(<ModelSelect {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /选择模型，当前/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'DeepSeek' }))
    rerender(<ModelSelect {...props} t={translator(en)} />)
    expect(screen.getByRole('menu', { name: 'Provider, model, and reasoning effort' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /Effort/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Select model, current/ })).toBeTruthy()
  })

  it('renders no Agent-bound control for an addressed subagent session', () => {
    const load = vi.fn()
    render(<ModelSelect
      locked={false}
      available={false}
      directory={createSnapshotStore(state())}
      load={load}
      select={vi.fn().mockResolvedValue(false)}
      t={t}
    />)

    expect(screen.queryByRole('button')).toBeNull()
    expect(load).not.toHaveBeenCalled()
  })
})
