// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

function openModels(modelName = 'DeepSeek-V4-Flash'): HTMLElement {
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: new RegExp(modelName) }))
  return screen.getByRole('dialog')
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ModelSelect reasoning effort', () => {
  it('opens compact effort controls, submits discrete adapter values, and resets to model default', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state())
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.set(state({ current: {
        ...selection,
        reasoningEffort: selection.reasoningEffort ?? reasoning.defaultEffort,
      } }))
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
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('High')
    expect(within(dialog).getByRole('button', { name: /DeepSeek-V4-Flash/ })).toBeTruthy()
    const slider = within(dialog).getByRole('slider') as HTMLInputElement
    expect(slider.min).toBe('0')
    expect(slider.max).toBe('2')
    expect(slider.step).toBe('1')
    expect(slider.getAttribute('aria-valuetext')).toBe('High')
    expect(dialog.textContent).toContain('none')
    expect(dialog.textContent).toContain('Max')

    fireEvent.change(slider, { target: { value: '2' } })
    expect(select).not.toHaveBeenCalled()
    fireEvent.pointerUp(slider)
    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'max',
      })
      expect(trigger.getAttribute('aria-label')).toBe('选择模型，当前 DeepSeek-V4-Flash，推理等级 Max')
      expect(slider.getAttribute('aria-valuetext')).toBe('Max')
      expect(screen.getByText('Largest budget')).toBeTruthy()
      expect(slider.getAttribute('aria-describedby')).toBe(screen.getByText('Largest budget').id)
    })
    expect(select).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: /重置|默认/ }))
    await waitFor(() => {
      expect(select).toHaveBeenLastCalledWith({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
      expect(slider.getAttribute('aria-valuetext')).toBe('High')
    })
    expect(select).toHaveBeenCalledTimes(2)
  })

  it('labels the off effort as none while submitting the adapter wire value', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state())
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.set(state({ current: selection }))
      return true
    })
    render(<ModelSelect locked={false} available directory={directory} load={vi.fn()} select={select} t={t} />)

    fireEvent.click(screen.getByRole('button', { name: /选择模型，当前/ }))
    const slider = screen.getByRole('slider')
    fireEvent.change(slider, { target: { value: '0' } })
    fireEvent.keyUp(slider, { key: 'ArrowLeft' })

    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({ provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'off' })
      expect(screen.getByRole('button', { name: '选择模型，当前 DeepSeek-V4-Flash，推理等级 none' })).toBeTruthy()
      expect(screen.getByRole('slider').getAttribute('aria-valuetext')).toBe('none')
    })
  })

  it('offers a real Default slider stop before an arbitrary adapter subset when no model default exists', async () => {
    const directory = createSnapshotStore(state({
      groups: [{
        id: 'provider',
        name: 'Provider',
        models: [{
          id: 'model',
          name: 'Model',
          reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'max', name: 'Max' }] },
        }],
      }],
      current: { provider: 'provider', model: 'model' },
    }))
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.set({ ...directory.getSnapshot(), current: selection })
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

    fireEvent.click(screen.getByRole('button', {
      name: '选择模型，当前 Model，推理等级 Default',
    }))
    const slider = screen.getByRole('slider') as HTMLInputElement
    expect(slider.min).toBe('0')
    expect(slider.max).toBe('2')
    expect(slider.value).toBe('0')
    expect(slider.getAttribute('aria-valuetext')).toBe('Default')
    expect(screen.getByRole('dialog').textContent).toContain('Default')
    expect(screen.getByRole('dialog').textContent).toContain('none')
    expect(screen.getByRole('dialog').textContent).not.toContain('High')
    fireEvent.change(slider, { target: { value: '1' } })
    fireEvent.keyUp(slider, { key: 'ArrowRight' })
    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({ provider: 'provider', model: 'model', reasoningEffort: 'off' })
      expect(slider.getAttribute('aria-valuetext')).toBe('none')
    })
    expect(select).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: /重置|默认/ }))
    await waitFor(() => {
      expect(select).toHaveBeenLastCalledWith({ provider: 'provider', model: 'model' })
      expect(screen.getByRole('button', { name: /选择模型，当前 Model，推理等级 Default/ })).toBeTruthy()
      expect(slider.value).toBe('0')
    })
    expect(select).toHaveBeenCalledTimes(2)
  })

  it('opens the model browser directly without published reasoning metadata', () => {
    const directory = createSnapshotStore(state({
      groups: [{ id: 'provider', name: 'Provider', models: [{ id: 'plain', name: 'Plain' }] }],
      current: { provider: 'provider', model: 'plain' },
    }))
    render(<ModelSelect locked={false} available directory={directory} load={vi.fn()} select={vi.fn()} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: /选择模型，当前 Plain/ }))
    expect(screen.queryByRole('slider')).toBeNull()
    expect(screen.getByRole('dialog', { name: '选择模型' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Plain' }).getAttribute('aria-current')).toBe('true')
  })

  it('opens the model browser directly when the sole published effort is already effective', () => {
    const directory = createSnapshotStore(state({
      groups: [{ id: 'provider', name: 'Provider', models: [{ id: 'one', name: 'One', reasoning: {
        efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high',
      } }] }],
      current: { provider: 'provider', model: 'one' },
    }))
    render(<ModelSelect locked={false} available directory={directory} load={vi.fn()} select={vi.fn()} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: /选择模型，当前 One，推理等级 High/ }))
    expect(screen.getByRole('dialog', { name: '选择模型' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'One' }).getAttribute('aria-current')).toBe('true')
    expect(screen.queryByRole('slider')).toBeNull()
  })

  it('keeps a one-stop correction accessible when the saved effort is unsupported', async () => {
    const directory = createSnapshotStore(state({
      groups: [{ id: 'provider', name: 'Provider', models: [{ id: 'one', name: 'One', reasoning: {
        efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high',
      } }] }],
      current: { provider: 'provider', model: 'one', reasoningEffort: 'legacy' },
    }))
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.set({ ...directory.getSnapshot(), current: selection })
      return true
    })
    render(<ModelSelect locked={false} available directory={directory} load={vi.fn()} select={select} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: /选择模型，当前 One，推理等级 legacy/ }))
    expect(screen.getByRole('dialog', { name: '推理等级与当前模型' }).textContent).toContain('legacy')
    fireEvent.click(screen.getByRole('button', { name: 'High' }))
    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({ provider: 'provider', model: 'one', reasoningEffort: 'high' })
      expect(screen.getByRole('button', { name: /选择模型，当前 One，推理等级 High/ })).toBeTruthy()
    })
  })

  it('shows an unsupported saved effort without inventing an adapter slider stop', () => {
    const directory = createSnapshotStore(state({
      current: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'legacy' },
    }))
    render(<ModelSelect locked={false} available directory={directory} load={vi.fn()} select={vi.fn()} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: /推理等级 legacy/ }))
    expect(screen.getByRole('dialog').textContent).toContain('legacy')
    expect(screen.getByRole('slider').getAttribute('max')).toBe('2')
    expect(screen.getByRole('slider').getAttribute('aria-valuetext')).toBe('legacy')
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
    expect(screen.queryByRole('slider')).toBeNull()
    expect(screen.queryByText('removed-model')).toBeNull()
    expect(screen.getByRole('button', { name: 'DeepSeek-V4-Flash' })).toBeTruthy()
  })

  it('retains effort when selecting the current route and applies defaults on a new route', async () => {
    const directory = createSnapshotStore(state({
      current: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'off' },
      groups: [
        { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning }] },
        { id: 'moonshot', name: 'Moonshot', models: [{ id: 'kimi', name: 'Kimi', reasoning: {
          efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low',
        } }] },
      ],
    }))
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.set({ ...directory.getSnapshot(), current: selection })
      return true
    })
    render(<ModelSelect locked={false} available directory={directory} load={vi.fn()} select={select} t={t} />)
    const trigger = screen.getByRole('button', { name: /选择模型，当前/ })
    fireEvent.click(trigger)
    openModels()
    fireEvent.click(screen.getByRole('button', { name: 'DeepSeek-V4-Flash' }))
    expect(select).not.toHaveBeenCalled()
    expect(trigger.getAttribute('aria-label')).toContain('none')
    fireEvent.click(trigger)
    openModels()
    fireEvent.click(screen.getByRole('button', { name: 'Moonshot' }))
    fireEvent.click(screen.getByRole('button', { name: 'Kimi' }))
    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({ provider: 'moonshot', model: 'kimi', reasoningEffort: 'low' })
      expect(trigger.getAttribute('aria-label')).toContain('Kimi，推理等级 Low')
      expect(trigger).toBe(document.activeElement)
    })
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
    openModels()
    fireEvent.click(screen.getByRole('button', { name: 'DeepSeek-V4-Pro' }))
    const toast = await screen.findByRole('alert')
    expect(toast.textContent).toContain('模型操作失败：model-unavailable: session already contains images')
    // 选择失败不触发目录加载重试入口。
    expect(screen.queryByRole('button', { name: /重试|重新加载/ })).toBeNull()
  })

  it('renders side-by-side provider and searchable model choices, resetting search on provider switch', () => {
    const directory = createSnapshotStore(state({ groups: [
      { id: 'deepseek-official', name: 'DeepSeek', models: [
        { id: 'flash', name: 'Flash' }, { id: 'pro', name: 'Pro' },
        { id: 'internal-alpha', name: 'Private Preview' },
      ] },
      { id: 'moonshot', name: 'Moonshot', models: [{ id: 'kimi', name: 'Kimi' }] },
    ], current: { provider: 'deepseek-official', model: 'flash' } }))
    render(<ModelSelect locked={false} available directory={directory} load={vi.fn()} select={vi.fn()} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: /选择模型，当前 Flash/ }))
    expect(screen.getByRole('dialog', { name: '选择模型' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'DeepSeek' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Flash' }).getAttribute('aria-current')).toBe('true')
    expect(screen.getByRole('button', { name: 'Pro' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Kimi' })).toBeNull()
    const search = screen.getByRole('searchbox', { name: '搜索模型' }) as HTMLInputElement
    fireEvent.change(search, { target: { value: 'internal-alpha' } })
    expect(screen.getByRole('button', { name: 'Private Preview' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Pro' })).toBeNull()
    fireEvent.change(search, { target: { value: 'pr' } })
    expect(screen.getByRole('button', { name: 'Pro' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Flash' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Moonshot' }))
    expect(search.value).toBe('')
    expect(screen.getByRole('button', { name: 'Kimi' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Pro' })).toBeNull()
    fireEvent.change(search, { target: { value: 'missing' } })
    expect(screen.getByRole('dialog').textContent).toContain('没有')
    act(() => {
      directory.set({ ...directory.getSnapshot(), groups: [
        directory.getSnapshot().groups[0]!, { ...directory.getSnapshot().groups[1]!, name: '团队渠道' },
      ] })
    })
    expect(screen.getByRole('button', { name: '团队渠道' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByRole('button', { name: 'Moonshot' })).toBeNull()
  })

  it.each([
    { viewport: 375, anchorLeft: 180, anchorRight: 296 },
    { viewport: 480, anchorLeft: 282, anchorRight: 398 },
    { viewport: 1024, anchorLeft: 600, anchorRight: 720 },
  ])('fits both compact and split dialogs in a clipped conversation at $viewport px', ({ viewport, anchorLeft, anchorRight }) => {
    vi.stubGlobal('innerWidth', viewport)
    const directory = createSnapshotStore(state())
    render(<div style={{ overflow: 'hidden' }}>
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

    const checkPlacement = (maxWidth: number): void => {
      const dialog = screen.getByRole('dialog') as HTMLElement
      const left = anchorLeft + Number.parseFloat(dialog.style.left)
      const width = Number.parseFloat(dialog.style.width)
      expect(left).toBeGreaterThanOrEqual(68)
      expect(left + width).toBeLessThanOrEqual(viewport - 12)
      expect(width).toBeLessThanOrEqual(maxWidth)
    }
    fireEvent.click(trigger)
    checkPlacement(300)
    openModels()
    checkPlacement(600)
    expect(screen.getByRole('button', { name: 'DeepSeek' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'DeepSeek-V4-Flash' })).toBeTruthy()
  })

  it('returns from the model pane, restores focus on Escape, and closes on outside click', async () => {
    const directory = createSnapshotStore(state())
    render(<><button type="button">Outside</button><ModelSelect locked={false} available directory={directory} load={vi.fn()} select={vi.fn()} t={t} /></>)
    const trigger = screen.getByRole('button', { name: /选择模型，当前/ })
    fireEvent.click(trigger)
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: /DeepSeek-V4-Flash/ })).toBe(document.activeElement)
    openModels()
    expect(screen.getByRole('searchbox', { name: '搜索模型' })).toBe(document.activeElement)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.getByRole('slider')).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await waitFor(() => { expect(trigger).toBe(document.activeElement) })
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(trigger)
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Outside' }))
    expect(screen.queryByRole('dialog')).toBeNull()
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
    openModels()
    expect(screen.getByRole('button', { name: 'DeepSeek' })).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('catalog timeout')
    expect(screen.getByText('Broken 加载失败：offline')).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: /重试|重新加载/ })[0]!)
    expect(load).toHaveBeenCalledTimes(3)
  })

  it('relabels the open channel picker when the locale changes', () => {
    const directory = createSnapshotStore(state())
    const props = { locked: false, available: true, directory, load: vi.fn(), select: vi.fn(), t }
    const { rerender } = render(<ModelSelect {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /选择模型，当前/ }))
    rerender(<ModelSelect {...props} t={translator(en)} />)
    expect(screen.getByRole('dialog', { name: /effort/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Select model, current/ })).toBeTruthy()
    openModels()
    expect(screen.getByRole('dialog', { name: /model/i })).toBeTruthy()
    expect(screen.getByRole('searchbox')).toBeTruthy()
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
