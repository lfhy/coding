// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { ModelListEditor, modelCapabilities, modelFamily } from '../src/client/ModelListEditor.tsx'
import type { ModelDraft } from '../src/client/ModelListEditor.tsx'
import { validateDeepSeekModels } from '../src/client/DeepSeekModelsEditor.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

function mount(settingsNs = 'llm-pi-ai', reasoningDisabled = false) {
  const onChange = vi.fn()
  const discoverModels = vi.fn(async () => ({ result: { ok: true, value: { models: [
    { id: 'agnes-2.5-flash' }, { id: 'agnes-2.5-pro' }, { id: 'ag-1.0' },
  ] } } }))
  render(<ModelListEditor models={[]} onChange={onChange} probe={{ settingsNs, provider: 'test' }}
    api={{ llm: { discoverModels } } as never} t={key => en[key]} disabled={false}
    reasoningDisabled={reasoningDisabled} providerName="HaiChat" />)
  return { onChange, discoverModels }
}

function mountStateful(initial: ModelDraft[] = []) {
  const discoverModels = vi.fn(async () => ({ result: { ok: true, value: { models: [
    { id: 'agnes-2.5-flash' }, { id: 'agnes-2.5-pro' }, { id: 'ag-1.0' },
  ] } } }))
  const onChange = vi.fn()
  function Fixture() {
    const [models, setModels] = useState<ModelDraft[]>(initial)
    return <ModelListEditor models={models} onChange={(next) => { onChange(next); setModels(next) }}
      probe={{ settingsNs: 'llm-pi-ai', provider: 'test' }} api={{ llm: { discoverModels } } as never}
      t={key => en[key]} disabled={false} providerName="HaiChat" />
  }
  render(<Fixture />)
  return { onChange }
}

describe('channel model catalog', () => {
  it('does not describe an inherited provider catalog as an empty model directory', () => {
    render(<ModelListEditor models={[]} overridden={false} onChange={vi.fn()}
      probe={{ settingsNs: 'llm-pi-ai', provider: 'test' }} api={{ llm: {} } as never}
      t={key => en[key]} disabled={false} />)
    expect(screen.getByText(en.modelsInherited)).toBeTruthy()
    expect(screen.queryByText(en.modelsEmpty)).toBeNull()
  })

  it('shows row-level vision and reasoning facts without opening capacities or guessing absent metadata', () => {
    expect(modelCapabilities({ id: 'known', input: ['text', 'image'], reasoningEfforts: { off: null, high: 'high' } }, 'llm-pi-ai'))
      .toEqual({ vision: 'supported', reasoning: 'supported' })
    expect(modelCapabilities({ id: 'missing' }, 'llm-pi-ai')).toEqual({ vision: 'unknown', reasoning: 'unknown' })
    expect(modelCapabilities({ id: 'inherited' }, 'llm-deepseek', ['off', 'high']))
      .toEqual({ vision: 'unknown', reasoning: 'supported' })
    const onChange = vi.fn()
    render(<ModelListEditor models={[
      { id: 'known', input: ['text', 'image'], reasoningEfforts: { off: null, high: 'high' } },
      { id: 'missing' },
      { id: 'unsupported', input: ['text'], reasoningEfforts: false },
    ]} onChange={onChange} probe={{ settingsNs: 'llm-pi-ai', provider: 'test' }}
    api={{ llm: {} } as never} t={key => en[key]} disabled={false} />)
    const table = screen.getAllByRole('region', { name: en.models }).find(node => node.hasAttribute('tabindex'))
    expect(table).toBeDefined()
    expect(table?.getAttribute('tabindex')).toBe('0')
    expect(table?.textContent).toContain(en.modelVisionColumn)
    expect(table?.textContent).toContain(en.modelReasoningColumn)
    for (const label of [
      en.visionSupport, en.reasoningSupport, en.visionUnspecified, en.reasoningUnspecified,
      en.visionUnsupported, en.reasoningUnsupported,
    ]) {
      const status = screen.getByRole('img', { name: label })
      expect(status.getAttribute('title')).toBe(label)
    }
    expect(screen.getByRole('img', { name: en.visionUnspecified }).textContent).toContain('?')
    expect(screen.getByRole('img', { name: en.reasoningUnsupported }).textContent).toContain('×')
    expect(screen.queryByRole('checkbox')).toBeNull()
    const settings = screen.getByRole('button', { name: `${en.modelAdvanced} 1` })
    expect(settings.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(settings)
    expect(settings.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('region', { name: `${en.modelAdvanced} 1` }).id)
      .toBe(settings.getAttribute('aria-controls'))
  })

  it('groups by version family without inferring capabilities from IDs', () => {
    expect(modelFamily('agnes-2.5-flash')).toBe('agnes-2.5')
    expect(modelFamily('ag-1.0')).toBe('ag-1.0')
  })

  it('searches discovered IDs, imports a family, and declares explicit default capabilities', async () => {
    const { onChange } = mount()
    fireEvent.click(screen.getByRole('button', { name: en.fetchModels }))
    const dialog = await screen.findByRole('dialog', { name: `HaiChat ${en.models}` })
    fireEvent.change(screen.getByRole('textbox', { name: en.searchModels }), { target: { value: 'agnes' } })
    expect(dialog.textContent).not.toContain('ag-1.0')
    fireEvent.click(screen.getByRole('button', { name: `${en.addFamily} agnes-2.5` }))
    expect(onChange).toHaveBeenCalledWith([
      { id: 'agnes-2.5-flash', input: ['text', 'image'], reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' } },
      { id: 'agnes-2.5-pro', input: ['text', 'image'], reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' } },
    ])
    expect(dialog.querySelectorAll('[role="tab"]')).toHaveLength(0)
  })

  it('uses DeepSeek model capability fields and does not fetch until requested', async () => {
    const { onChange, discoverModels } = mount('llm-deepseek')
    expect(discoverModels).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    expect(onChange).toHaveBeenCalledWith([{ id: '', inputModalities: ['text', 'image'], reasoningEfforts: ['off', 'low', 'high', 'max'] }])
    fireEvent.click(screen.getByRole('button', { name: en.fetchModels }))
    await waitFor(() => { expect(discoverModels).toHaveBeenCalledTimes(1) })
  })

  it('limits new DeepSeek models to off when channel thinking is disabled', async () => {
    const { onChange } = mount('llm-deepseek', true)
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    expect(onChange).toHaveBeenCalledWith([{ id: '', inputModalities: ['text', 'image'], reasoningEfforts: ['off'] }])
    fireEvent.click(screen.getByRole('button', { name: en.fetchModels }))
    await screen.findByRole('dialog', { name: `HaiChat ${en.models}` })
    fireEvent.click(screen.getByRole('button', { name: `${en.addModel} ag-1.0` }))
    expect(onChange).toHaveBeenCalledWith([{ id: 'ag-1.0', inputModalities: ['text', 'image'], reasoningEfforts: ['off'] }])
  })

  it('starts unselected and imports only candidates visible when Select all is clicked', async () => {
    const { onChange } = mountStateful()
    fireEvent.click(screen.getByRole('button', { name: en.fetchModels }))
    const dialog = await screen.findByRole('dialog', { name: `HaiChat ${en.models}` })
    expect(screen.getAllByRole<HTMLInputElement>('checkbox').map(box => box.checked)).toEqual([false, false, false])
    expect(screen.getByRole('button', { name: en.fetchAdopt }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: en.fetchSelectAll }))
    fireEvent.change(screen.getByRole('textbox', { name: en.searchModels }), { target: { value: 'flash' } })
    expect(screen.getByRole('button', { name: en.fetchAdopt }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: en.fetchSelectAll }))
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'agnes-2.5-flash' }).checked).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: en.fetchAdopt }))
    expect(dialog.isConnected).toBe(false)
    expect(onChange).toHaveBeenLastCalledWith([
      { id: 'agnes-2.5-flash', input: ['text', 'image'], reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' } },
    ])
  })

  it('marks a directly imported item and family as added, without re-importing them through Add selected', async () => {
    const { onChange } = mountStateful()
    fireEvent.click(screen.getByRole('button', { name: en.fetchModels }))
    await screen.findByRole('dialog', { name: `HaiChat ${en.models}` })
    fireEvent.click(screen.getByRole('checkbox', { name: 'agnes-2.5-flash' }))
    fireEvent.click(screen.getByRole('button', { name: `${en.addModel} agnes-2.5-flash` }))
    expect(screen.getByRole('button', { name: `${en.addedModel} agnes-2.5-flash` }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: en.fetchAdopt }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: `${en.addFamily} agnes-2.5` }))
    expect(screen.getByRole('button', { name: `${en.familyAdded} agnes-2.5` }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: `${en.addedModel} agnes-2.5-pro` }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: 'ag-1.0' }))
    fireEvent.click(screen.getByRole('button', { name: en.fetchAdopt }))
    expect(onChange).toHaveBeenLastCalledWith([
      { id: 'agnes-2.5-flash', input: ['text', 'image'], reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' } },
      { id: 'agnes-2.5-pro', input: ['text', 'image'], reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' } },
      { id: 'ag-1.0', input: ['text', 'image'], reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' } },
    ])
  })

  it.each(['item', 'family', 'selected'] as const)(
    'preserves two unfinished model drafts when importing a discovered %s', async (mode) => {
      const { onChange } = mountStateful()
      fireEvent.click(screen.getByRole('button', { name: en.addModel }))
      fireEvent.click(screen.getByRole('button', { name: en.addModel }))
      fireEvent.change(screen.getByRole('textbox', { name: `${en.modelName} 1` }), { target: { value: 'first draft' } })
      fireEvent.change(screen.getByRole('textbox', { name: `${en.modelName} 2` }), { target: { value: 'second draft' } })
      fireEvent.click(screen.getByRole('button', { name: en.fetchModels }))
      await screen.findByRole('dialog', { name: `HaiChat ${en.models}` })

      if (mode === 'item') {
        fireEvent.click(screen.getByRole('button', { name: `${en.addModel} ag-1.0` }))
      } else if (mode === 'family') {
        fireEvent.click(screen.getByRole('button', { name: `${en.addFamily} agnes-2.5` }))
      } else {
        fireEvent.click(screen.getByRole('checkbox', { name: 'ag-1.0' }))
        fireEvent.click(screen.getByRole('button', { name: en.fetchAdopt }))
      }

      const added = mode === 'family' ? ['agnes-2.5-flash', 'agnes-2.5-pro'] : ['ag-1.0']
      expect(onChange).toHaveBeenLastCalledWith([
        { id: '', name: 'first draft', input: ['text', 'image'], reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' } },
        { id: '', name: 'second draft', input: ['text', 'image'], reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' } },
        ...added.map(id => ({ id, input: ['text', 'image'], reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' } })),
      ])
    },
  )

  it('does not replace an existing model when a discovered family includes the same ID', async () => {
    const { onChange } = mountStateful([{ id: 'agnes-2.5-flash', contextWindow: 111 }])
    fireEvent.click(screen.getByRole('button', { name: en.fetchModels }))
    await screen.findByRole('dialog', { name: `HaiChat ${en.models}` })
    expect(screen.getByRole('button', { name: `${en.addedModel} agnes-2.5-flash` }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: `${en.addFamily} agnes-2.5` }))
    expect(onChange).toHaveBeenLastCalledWith([
      { id: 'agnes-2.5-flash', contextWindow: 111 },
      { id: 'agnes-2.5-pro', input: ['text', 'image'], reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' } },
    ])
  })

  it('focuses search on opening and returns focus to fetch when closing', async () => {
    mount()
    const fetch = screen.getByRole('button', { name: en.fetchModels })
    fireEvent.click(fetch)
    const search = await screen.findByRole('textbox', { name: en.searchModels })
    expect(document.activeElement).toBe(search)
    fireEvent.click(screen.getByRole('button', { name: en.close }))
    expect(document.activeElement).toBe(fetch)
  })

  it('keeps model editing available without a reset control or a customized marker', () => {
    const onReset = vi.fn()
    const onChange = vi.fn()
    function Fixture() {
      const [models, setModels] = useState<ModelDraft[]>([{ id: 'same', contextWindow: 2_000 }])
      return <ModelListEditor models={models} overridden={true} onChange={(next) => { onChange(next); setModels(next) }}
        onReset={onReset}
        probe={{ settingsNs: 'llm-pi-ai', provider: 'test' }} api={{ llm: {} } as never}
        t={key => en[key]} disabled={false} />
    }
    render(<Fixture />)
    expect(screen.queryByRole('button', { name: en.resetModels })).toBeNull()
    expect(screen.queryByText(en.modelsCustomized)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: `${en.modelAdvanced} 1` }))
    fireEvent.change(screen.getByRole('textbox', { name: `${en.modelId} 1` }), { target: { value: 'edited' } })
    expect(onChange).toHaveBeenLastCalledWith([{ id: 'edited', contextWindow: 2_000 }])
    fireEvent.change(screen.getByRole('textbox', { name: `${en.modelContextWindow} 1` }), { target: { value: 'garbage' } })
    fireEvent.click(screen.getByRole('button', { name: `${en.modelAdvanced} 1` }))
    fireEvent.click(screen.getByRole('button', { name: `${en.modelAdvanced} 1` }))
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: `${en.modelContextWindow} 1` }).value).toBe('garbage')
    expect(onReset).not.toHaveBeenCalled()
  })

  it('rejects DeepSeek false and empty levels before a settings write', () => {
    expect(validateDeepSeekModels([{ id: 'x', reasoningEfforts: false }], 'deepseek')?.key).toBe('modelReasoningInvalid')
    expect(validateDeepSeekModels([{ id: 'x', reasoningEfforts: [] }], 'deepseek')?.key).toBe('modelReasoningInvalid')
    expect(validateDeepSeekModels([{ id: 'x', reasoningEfforts: ['off'] }], 'deepseek')).toBeUndefined()
    expect(validateDeepSeekModels([{ id: 'x', reasoningEfforts: false }], 'pi-ai')).toBeUndefined()
  })

  it('converts the DeepSeek reasoning switch to off-only without losing inherited default support', () => {
    const onChange = vi.fn()
    render(<ModelListEditor models={[{ id: 'inherited' }]} onChange={onChange}
      inheritedReasoningEfforts={['off', 'low', 'high', 'max']}
      probe={{ settingsNs: 'llm-deepseek', provider: 'deepseek-official' }} api={{ llm: {} } as never}
      t={key => en[key]} disabled={false} />)
    fireEvent.click(screen.getByRole('button', { name: `${en.modelAdvanced} 1` }))
    const reasoning = screen.getByRole<HTMLInputElement>('checkbox', { name: en.reasoningSupport })
    expect(reasoning.checked).toBe(true)
    fireEvent.click(reasoning)
    expect(onChange).toHaveBeenCalledWith([{ id: 'inherited', reasoningEfforts: ['off'] }])
  })
})
