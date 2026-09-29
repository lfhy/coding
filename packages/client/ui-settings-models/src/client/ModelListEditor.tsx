/**
 * 单个渠道的模型目录编辑与端点发现。发现请求使用表单当前的地址和未保存密钥，
 * 只返回待选候选；勾选、逐项或整组导入仅修改草稿，不隐式提交设置。
 * 端点不可发现时显示诊断，手工模型编辑仍可使用。
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { DiscoveredModelView, IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import { Button, Menu, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  Icon, IconCheckOutline14, IconChevronDownOutline14, IconCloseOutline16, IconPlusOutline16, IconRefreshOutline16,
  IconQuestionOutline14, IconSearchOutline16, IconTrashOutline16,
} from '@deepseek-ai/dsh-client-ui-icons'
import { formatCapacity, parseCapacity } from './DeepSeekModelsEditor.tsx'
import type { DeepSeekModelDraft } from './DeepSeekModelsEditor.tsx'
import { messageOf } from './store.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/**
 * One configured model row. Structurally open, exactly like the DeepSeek
 * catalog editor's rows: a profile field this card does not edit — one a future
 * schema adds, or one hand-written in `settings.yaml` — has to survive being
 * edited here rather than being dropped by a rebuild.
 */
export type ModelDraft = DeepSeekModelDraft

type Capability = 'supported' | 'unsupported' | 'unknown'

/** 只投影显式声明或已知渠道继承的模型能力；缺失的 pi-ai catalog 元数据不等于不支持。 */
export function modelCapabilities(
  model: ModelDraft,
  settingsNs: string,
  inheritedReasoningEfforts?: readonly string[],
): { vision: Capability; reasoning: Capability } {
  const input = model[settingsNs === 'llm-deepseek' ? 'inputModalities' : 'input']
  const vision: Capability = Array.isArray(input) && input.length > 0
    ? input.includes('image') ? 'supported' : 'unsupported'
    : 'unknown'
  const declared = model['reasoningEfforts']
  const reasoning: Capability = settingsNs === 'llm-deepseek'
    ? Array.isArray(declared)
      ? declared.some(level => level !== 'off') ? 'supported' : 'unsupported'
      : inheritedReasoningEfforts === undefined
        ? 'unknown'
        : inheritedReasoningEfforts.some(level => level !== 'off') ? 'supported' : 'unsupported'
    : declared === false
      ? 'unsupported'
      : typeof declared === 'object' && declared !== null && !Array.isArray(declared)
        ? Object.keys(declared).some(level => level !== 'off') ? 'supported' : 'unsupported'
        : 'unknown'
  return { vision, reasoning }
}

/** A row's text field, or the empty string when unset or not a string. */
function textOf(model: ModelDraft, key: string): string {
  const value = model[key]
  return typeof value === 'string' ? value : ''
}

/** A row's numeric field, or `undefined` when unset or not a number. */
function numberOf(model: ModelDraft, key: string): number | undefined {
  const value = model[key]
  return typeof value === 'number' ? value : undefined
}

/** 局部草稿只替换表单能编辑的字段，保留目录行里未展示的提供方扩展字段。 */
function withModelFields(model: ModelDraft, next: Record<string, unknown>): ModelDraft {
  const cleared = new Set(Object.entries(next)
    .filter(([, value]) => value === undefined || value === '').map(([key]) => key))
  return Object.fromEntries(Object.entries({ ...model, ...next }).filter(([key]) => !cleared.has(key)))
}

/** What an interrogation needs, taken from the live form. */
export interface ProbeTarget {
  /** Settings namespace whose adapter family answers. */
  settingsNs: string
  /**
   * Route being edited, when the card edits one. An adapter that already
   * describes it answers from its own registry, so such a card can ask without
   * an endpoint at all.
   */
  provider?: string
  /** Endpoint as the form currently shows it. */
  baseURL?: string
  /** Wire protocol the form names, when it names one. */
  api?: string
  /** Key typed into the form and not yet stored, when there is one. */
  apiKey?: string
}

/** Props of {@link ModelListEditor}. */
export interface ModelListEditorProps {
  /** The rows as currently drafted. */
  models: readonly ModelDraft[]
  /** Whether the user layer currently owns the whole array; absent on a create. */
  overridden?: boolean
  /** Replace the drafted rows. */
  onChange: (models: ModelDraft[]) => void
  /** Remove the user-owned array and return to inheritance; absent on a create. */
  onReset?: () => void
  /** Endpoint facts for the fetch action. */
  probe: ProbeTarget
  /**
   * Copy key naming why the fetch action is unavailable, or `undefined` when
   * it is. The card owns this because the key it would send is judged there:
   * asking with a key the form has already refused spends a round trip to be
   * told what the field already says.
   */
  probeBlocked?: keyof typeof en | undefined
  /** Wire face the fetch action calls. */
  api: Pick<IApiClient, 'llm'>
  /** Section copy. */
  t: (key: keyof typeof en) => string
  /** Disable every control (read-only deployment or a pending write). */
  disabled: boolean
  /** 渠道名称用作发现弹窗标题。 */
  providerName?: string
  /** DeepSeek 缺省模型继承渠道 thinking 策略，不把字段缺席显示成无推理能力。 */
  inheritedReasoningEfforts?: readonly string[]
  /** 渠道级 thinking=disabled 时不能启用非 off 档位。 */
  reasoningDisabled?: boolean
}

/** 模型设置按钮展开时旋转箭头，指向悬浮表单。 */
function IconChevron({ open }: { open: boolean }): ReactNode {
  return <IconChevronDownOutline14 size={14} className={open ? styles['expandedChevron'] : undefined} />
}

/** Removal glyph for one model row. */
function IconTrash(): ReactNode {
  return <IconTrashOutline16 size={14} />
}

/** The two token counts edited as K/M-suffixed text behind a row's disclosure. */
type CapacityField = 'contextWindow' | 'maxTokens'

/**
 * What an empty capacity field is worth, shown as its placeholder so a row left
 * blank does not read as a model with no capacity at all.
 *
 * The magnitudes are the adapter's own route-level fallbacks (`llm-pi-ai`'s
 * `defaultContextWindow` and `defaultMaxTokens`), spelled the way a person
 * would say them. They are a hint, not a mirror: this page counts `K` as 1000,
 * so typing `256K` stores 256000 while leaving the field blank keeps the
 * adapter's 262144. A deployment that overrides those defaults is not
 * reflected here — nothing on this page can read them.
 */
const CAPACITY_HINT: Readonly<Record<CapacityField, string>> = {
  contextWindow: '256K',
  maxTokens: '32K',
}

/** 只提供各适配器接受的档位；pi-ai 的映射值仍保留在模型草稿中。 */
const DEEPSEEK_REASONING_LEVELS = ['off', 'low', 'high', 'max'] as const
const PI_AI_REASONING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * Spell a stored count for a field that may be unset. The spelling itself is
 * {@link formatCapacity}, shared with the DeepSeek catalog editor so both
 * surfaces read and write one K/M vocabulary.
 * @param value - stored capacity, or `undefined` for an unset field.
 * @returns the field text, empty when unset.
 */
function capacitySpelling(value: number | undefined): string {
  return value === undefined ? '' : formatCapacity(value)
}

/** Adopt a candidate, keeping whatever capacities the provider disclosed. */
function adopt(candidate: DiscoveredModelView, namespace: string, reasoningDisabled: boolean): ModelDraft {
  return {
    id: candidate.id,
    ...candidate.name === undefined ? {} : { name: candidate.name },
    ...candidate.contextWindow === undefined ? {} : { contextWindow: candidate.contextWindow },
    ...candidate.maxTokens === undefined ? {} : { maxTokens: candidate.maxTokens },
    ...namespace === 'llm-deepseek'
      ? { inputModalities: ['text', 'image'], reasoningEfforts: reasoningDisabled ? ['off'] : ['off', 'low', 'high', 'max'] }
      : { input: ['text', 'image'], reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' } },
  }
}

/** 以版本前缀归组，只用于目录排版，不据此推断能力。 */
export function modelFamily(id: string): string {
  return /^(.*?-\d+(?:\.\d+)?)(?:-|$)/u.exec(id)?.[1] ?? id.split('-')[0] ?? id
}

/**
 * Render the model list with its fetch action.
 * @param props - the drafted rows, probe target, wire face, and copy.
 * @returns the model-list editor.
 */
export function ModelListEditor(props: ModelListEditorProps): ReactNode {
  const { models, onChange, probe, api, t, disabled } = props
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [candidates, setCandidates] = useState<readonly DiscoveredModelView[] | undefined>(undefined)
  const [candidateQuery, setCandidateQuery] = useState('')
  const fetchButton = useRef<HTMLButtonElement>(null)
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  // 同时只编辑一行；草稿留在独立窗口中，不进入模型目录表格的布局。
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const anchorRef = useRef<HTMLButtonElement | null>(null)
  const modalBodyRef = useRef<HTMLDivElement>(null)
  const firstFieldRef = useRef<HTMLButtonElement>(null)
  const reasoningToggleRef = useRef<HTMLButtonElement>(null)
  const openedIndex = activeIndex !== null && activeIndex < models.length ? activeIndex : null
  const [levelsOpen, setLevelsOpen] = useState(false)
  const [draft, setDraft] = useState<ModelDraft | null>(null)
  const [draftDirty, setDraftDirty] = useState(false)
  const [capacityDraft, setCapacityDraft] = useState<Partial<Record<CapacityField, string>>>({})
  const [rememberedReasoning, setRememberedReasoning] = useState<unknown>(undefined)
  const levelsTriggerRef = useRef<HTMLButtonElement>(null)
  const invalidCapacity = (field: CapacityField): boolean => {
    const value = draft === null ? undefined : numberOf(draft, field)
    return value !== undefined && (!Number.isSafeInteger(value) || value <= 0)
  }
  const editCapacity = (field: CapacityField, text: string): void => {
    setDraftDirty(true)
    setCapacityDraft(current => ({ ...current, [field]: text }))
    setDraft(current => current === null ? null : withModelFields(current, { [field]: parseCapacity(text) }))
  }

  /** 输入期间保持原文，避免把正在键入的 1000 中途改写为 1K。 */
  const capacityText = (model: ModelDraft, field: CapacityField): string =>
    capacityDraft[field] ?? capacitySpelling(numberOf(model, field))

  const effortsOf = (model: ModelDraft): readonly string[] =>
    Array.isArray(model['reasoningEfforts'])
      ? model['reasoningEfforts'] as string[]
      : model['reasoningEfforts'] === undefined ? props.inheritedReasoningEfforts ?? [] : []

  const closeSettings = (): void => {
    setLevelsOpen(false)
    setActiveIndex(null)
    setDraft(null)
    setDraftDirty(false)
    setCapacityDraft({})
    setRememberedReasoning(undefined)
    if (anchorRef.current?.isConnected === true) anchorRef.current.focus({ preventScroll: true })
  }

  const openSettings = (index: number, anchor: HTMLButtonElement): void => {
    const model = models[index]
    if (model === undefined) return
    anchorRef.current = anchor
    setLevelsOpen(false)
    setCapacityDraft({})
    setDraftDirty(false)
    setRememberedReasoning(undefined)
    setDraft({ ...model })
    setActiveIndex(index)
  }

  const saveSettings = (): void => {
    if (openedIndex === null || draft === null || disabled
      || invalidCapacity('contextWindow') || invalidCapacity('maxTokens')) return
    if (draftDirty) {
      // 行 ID／名称仍可在窗口打开期间编辑；提交只覆盖模型设置窗口拥有的字段。
      const inputKey = probe.settingsNs === 'llm-deepseek' ? 'inputModalities' : 'input'
      const fields = { [inputKey]: draft[inputKey], reasoningEfforts: draft['reasoningEfforts'],
        contextWindow: draft['contextWindow'], maxTokens: draft['maxTokens'] }
      onChange(models.map((model, index) => index === openedIndex ? withModelFields(model, fields) : model))
    }
    closeSettings()
  }

  const patchDraft = (next: Record<string, unknown>): void => {
    setDraftDirty(true)
    setDraft(current => current === null ? null : withModelFields(current, next))
  }

  useEffect(() => {
    if (openedIndex === null) return
    if (firstFieldRef.current?.disabled === false) firstFieldRef.current.focus({ preventScroll: true })
    else modalBodyRef.current?.focus({ preventScroll: true })
  }, [openedIndex])

  useEffect(() => {
    if (openedIndex === null) return
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // 内层菜单或窗口先消费 Escape，不能再关闭后方的设置窗口。
      event.preventDefault()
      event.stopImmediatePropagation()
      if (levelsOpen) {
        setLevelsOpen(false)
        levelsTriggerRef.current?.focus({ preventScroll: true })
        return
      }
      closeSettings()
    }
    document.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('keydown', escape, true)
    }
  }, [openedIndex, levelsOpen])

  const patch = (index: number, next: Record<string, unknown>): void => {
    onChange(models.map((model, at) => at === index ? withModelFields(model, next) : model))
  }

  const fetchModels = async (): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    try {
      const response = await api.llm.discoverModels({
        settingsNs: probe.settingsNs,
        ...probe.provider === undefined ? {} : { provider: probe.provider },
        ...probe.baseURL === undefined || probe.baseURL.length === 0 ? {} : { baseURL: probe.baseURL },
        ...probe.api === undefined ? {} : { api: probe.api },
        ...probe.apiKey === undefined ? {} : { apiKey: probe.apiKey },
      })
      if (!response.result.ok) {
        setFailure(response.result.error.message)
        return
      }
      const found = response.result.value.models
      if (found.length === 0) {
        setFailure(t('fetchEmpty'))
        return
      }
      setCandidates(found)
      setCandidateQuery('')
      setPicked(new Set())
    } catch (error) {
      // The transport rejected rather than answering; without this the button
      // would stay busy with nothing shown.
      setFailure(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  const closePicker = (): void => {
    setCandidates(undefined)
    setPicked(new Set())
    setCandidateQuery('')
    fetchButton.current?.focus()
  }

  /** 保留已有草稿行及顺序，只按非空模型 ID 跳过已添加的候选。 */
  const appendCandidates = (items: readonly DiscoveredModelView[]): void => {
    const knownIds = new Set(models.map(model => textOf(model, 'id')).filter(id => id.length > 0))
    const next = [...models]
    for (const candidate of items) {
      if (knownIds.has(candidate.id)) continue
      knownIds.add(candidate.id)
      next.push(adopt(candidate, probe.settingsNs, props.reasoningDisabled === true))
    }
    onChange(next)
  }

  const adoptPicked = (): void => {
    /* v8 ignore next -- the dialog only renders with candidates loaded */
    if (candidates === undefined) return
    appendCandidates(filteredCandidates.filter(candidate => picked.has(candidate.id)))
    closePicker()
  }

  const toggle = (id: string): void => {
    setPicked((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }

  const activeCandidates = candidates ?? []
  const known = new Set(models.map(model => textOf(model, 'id')))
  const filteredCandidates = activeCandidates.filter(candidate =>
    `${candidate.id} ${candidate.name ?? ''}`.toLocaleLowerCase().includes(candidateQuery.toLocaleLowerCase()))
  const selectable = filteredCandidates.filter(candidate => !known.has(candidate.id))
  const allCandidatesPicked = selectable.length > 0 && selectable.every(candidate => picked.has(candidate.id))

  const toggleAllCandidates = (): void => {
    setPicked((current) => {
      const next = new Set(current)
      for (const candidate of selectable) {
        if (allCandidatesPicked) next.delete(candidate.id)
        else next.add(candidate.id)
      }
      return next
    })
  }

  const families = new Map<string, DiscoveredModelView[]>()
  for (const candidate of filteredCandidates) {
    const family = modelFamily(candidate.id)
    families.set(family, [...(families.get(family) ?? []), candidate])
  }
  const adoptGroup = (group: readonly DiscoveredModelView[]): void => {
    appendCandidates(group)
    setPicked(current => new Set([...current].filter(id => !group.some(candidate => candidate.id === id))))
  }

  // A route the adapter already describes answers without an endpoint; only a
  // draft with neither has nothing to ask about.
  const askable = probe.provider !== undefined || (probe.baseURL !== undefined && probe.baseURL.length > 0)
  return (
    <section className={styles['modelCatalog']} aria-label={t('models')}>
      <div className={styles['modelListHead']}>
        <div className={styles['modelCatalogHeading']}>
          <span className={styles['modelCatalogTitle']}>{t('models')}</span>
          {props.overridden === false
            ? (
              <span className={styles['modelCatalogMeta']}>
                {t('modelsInherited')}
              </span>
            ) : null}
        </div>
        <button
          type="button"
          ref={fetchButton}
          className={styles['fetchAction']}
          disabled={disabled || busy || !askable || props.probeBlocked !== undefined}
          title={props.probeBlocked !== undefined
            ? t(props.probeBlocked)
            : askable ? undefined : t('fetchNeedsBaseUrl')}
          onClick={() => { void fetchModels() }}
        >
          <IconRefreshOutline16 size={16} />{busy ? t('fetching') : t('fetchModels')}
        </button>
      </div>
      {models.length === 0 && props.overridden !== false
        ? <p className={styles['modelEmpty']}>{t('modelsEmpty')}</p> : null}
      {models.length > 0 ? <div className={styles['modelTableScroller']} role="region"
        aria-label={t('models')} tabIndex={0}>
        <div className={styles['modelTableHead']} aria-hidden="true">
          <span>{t('modelId')}</span>
          <span>{t('modelName')}</span>
          <span title={t('visionSupport')}>{t('modelVisionColumn')}</span>
          <span title={t('reasoningSupport')}>{t('modelReasoningColumn')}</span>
        </div>
        <div className={styles['modelList']}>{models.map((model, index) => (
          <div key={index} className={styles['modelEntry']}>
            <div className={styles['modelRow']}>
              <input
                className={styles['input']}
                type="text"
                value={textOf(model, 'id')}
                placeholder={t('modelId')}
                aria-label={`${t('modelId')} ${index + 1}`}
                disabled={disabled}
                onChange={(event) => { patch(index, { id: event.target.value }) }}
              />
              <input
                className={styles['input']}
                type="text"
                value={textOf(model, 'name')}
                placeholder={t('modelName')}
                aria-label={`${t('modelName')} ${index + 1}`}
                disabled={disabled}
                onChange={(event) => { patch(index, { name: event.target.value === '' ? undefined : event.target.value }) }}
              />
              {(['vision', 'reasoning'] as const).map((capability) => {
                const state = modelCapabilities(model, probe.settingsNs, props.inheritedReasoningEfforts)[capability]
                const label = capability === 'vision'
                  ? t(state === 'supported' ? 'visionSupport' : state === 'unsupported' ? 'visionUnsupported' : 'visionUnspecified')
                  : t(state === 'supported' ? 'reasoningSupport' : state === 'unsupported' ? 'reasoningUnsupported' : 'reasoningUnspecified')
                return <span key={capability} role="img" aria-label={label} title={label}
                  className={`${styles['capabilityBadge']} ${state === 'supported'
                    ? styles['capabilitySupported'] : state === 'unknown' ? styles['capabilityUnknown'] : styles['capabilityUnsupported']}`}>
                  <span aria-hidden="true">{state === 'supported' ? <IconCheckOutline14 size={14} />
                    : state === 'unsupported' ? <IconCloseOutline16 size={14} /> : <IconQuestionOutline14 size={14} />}</span>
                  <span className={styles['hiddenLabel']}>{label}</span>
                </span>
              })}
              <button
                type="button"
                className={styles['iconButton']}
                aria-label={`${t('modelAdvanced')} ${index + 1}`}
                aria-haspopup="dialog"
                aria-expanded={openedIndex === index}
                title={t('modelAdvanced')}
                ref={openedIndex === index ? anchorRef : undefined}
                onClick={(event) => {
                  if (openedIndex === index) closeSettings()
                  else openSettings(index, event.currentTarget)
                }}
              >
                <IconChevron open={openedIndex === index} />
              </button>
              <button
                type="button"
                className={`${styles['iconButton']} ${styles['iconButtonDanger']}`}
                aria-label={`${t('removeModel')} ${index + 1}`}
                title={t('removeModel')}
                disabled={disabled}
                onClick={() => {
                  onChange(models.filter((_model, at) => at !== index))
                  // 删除当前行时关闭表单；删去前面的行则跟随原有模型前移。
                  setActiveIndex(current => current === null || current === index
                    ? null : current > index ? current - 1 : current)
                  if (openedIndex === index) {
                    setDraft(null)
                    setLevelsOpen(false)
                  }
                }}
              >
                <IconTrash />
              </button>
            </div>
          </div>
        ))}</div>
      </div> : null}
      {openedIndex !== null && <Modal open trapFocus onClose={closeSettings}
        title={t('modelAdvanced')} ariaLabel={`${t('modelAdvanced')} ${openedIndex + 1}`}
        closeLabel={t('close')}
        className={styles['modelSettingsDialog'] ?? ''}
        contentClassName={styles['modelSettingsContent'] ?? ''}
        footer={<>
          <Button variant="outline" onClick={closeSettings}>{t('cancel')}</Button>
          <Button variant="primary"
            disabled={disabled || invalidCapacity('contextWindow') || invalidCapacity('maxTokens')}
            onClick={saveSettings}>{t('save')}</Button>
        </>}>
        <div ref={modalBodyRef} tabIndex={-1} className={styles['modelAdvancedFields']}>
          {(() => {
            const index = openedIndex
            const model = draft
            if (model === null) return null
            const deepseek = probe.settingsNs === 'llm-deepseek'
            const declared = model['reasoningEfforts']
            const reasoningOn = deepseek ? effortsOf(model).some(level => level !== 'off')
              : typeof declared === 'object' && declared !== null && !Array.isArray(declared)
                  && Object.keys(declared).some(level => level !== 'off')
            const selectedLevels = deepseek ? effortsOf(model)
              : typeof declared === 'object' && declared !== null && !Array.isArray(declared)
                ? Object.keys(declared) : ['off']
            const visionOn = Array.isArray(model[deepseek ? 'inputModalities' : 'input'])
                && (model[deepseek ? 'inputModalities' : 'input'] as string[]).includes('image')
            return <>
              <div className={styles['capabilityControls']}>
                <button type="button" ref={firstFieldRef} className={styles['capabilityToggle']}
                  aria-label={t('visionSupport')} aria-pressed={visionOn} disabled={disabled}
                  onClick={() => { patchDraft({ [deepseek ? 'inputModalities' : 'input']:
                      visionOn ? ['text'] : ['text', 'image'] }) }}>
                  <Icon name="model-vision" size={16} /><span>{t('visionSupport')}</span>
                </button>
                <button type="button" ref={reasoningToggleRef} className={styles['capabilityToggle']}
                  aria-label={t('reasoningSupport')} aria-pressed={reasoningOn}
                  disabled={disabled || props.reasoningDisabled === true}
                  onClick={() => {
                    if (!reasoningOn) {
                      const restored = deepseek
                        ? Array.isArray(rememberedReasoning) && rememberedReasoning.some(level => level !== 'off')
                          ? rememberedReasoning : ['off', 'low', 'high', 'max']
                        : typeof rememberedReasoning === 'object' && rememberedReasoning !== null
                            && !Array.isArray(rememberedReasoning)
                            && Object.keys(rememberedReasoning).some(level => level !== 'off')
                          ? rememberedReasoning : { off: null, low: 'low', high: 'high', max: 'max' }
                      patchDraft({ reasoningEfforts: restored })
                    } else {
                      setRememberedReasoning(deepseek ? effortsOf(model) : declared)
                      setLevelsOpen(false)
                      patchDraft({ reasoningEfforts: deepseek ? ['off'] : false })
                    }
                  }}>
                  <Icon name="model-reasoning" size={16} /><span>{t('reasoningSupport')}</span>
                </button>
              </div>
              {reasoningOn && <div className={styles['reasoningField']}>
                <span className={styles['modelFieldLabel']}>{t('reasoningLevels')}</span>
                <Menu portal open={levelsOpen} compact multiSelect matchAnchorWidth highlightSelected keyboardNavigation
                  portalContainer={levelsTriggerRef.current?.closest('[role="dialog"]') ?? null}
                  className={styles['reasoningDropdown'] ?? ''}
                  selectedIds={selectedLevels}
                  items={(deepseek ? DEEPSEEK_REASONING_LEVELS : PI_AI_REASONING_LEVELS)
                    .map(level => ({ id: level, label: level === 'off' ? t('reasoningNone') : level }))}
                  onClose={() => { setLevelsOpen(false) }}
                  onSelect={(level) => {
                    if (deepseek) {
                      const next = selectedLevels.includes(level)
                        ? selectedLevels.filter(value => value !== level) : [...selectedLevels, level]
                      if (next.every(value => value === 'off')) {
                        setLevelsOpen(false)
                        reasoningToggleRef.current?.focus({ preventScroll: true })
                      }
                      patchDraft({ reasoningEfforts: next.length === 0 ? ['off'] : next })
                    } else {
                      const prior = typeof declared === 'object' && declared !== null && !Array.isArray(declared)
                        ? declared as Record<string, string | null> : { off: null }
                      const next = { ...prior }
                      if (level in next) Reflect.deleteProperty(next, level)
                      else next[level] = level === 'off' ? null : level
                      const offOnly = Object.keys(next).every(value => value === 'off')
                      if (offOnly) {
                        setLevelsOpen(false)
                        reasoningToggleRef.current?.focus({ preventScroll: true })
                      }
                      patchDraft({ reasoningEfforts: offOnly ? false : next })
                    }
                  }}
                  anchor={<button type="button" ref={levelsTriggerRef} className={styles['reasoningTrigger']}
                    aria-label={`${t('reasoningLevels')}: ${selectedLevels.map(level => level === 'off'
                      ? t('reasoningNone') : level).join(', ')}`}
                    aria-haspopup="menu" aria-expanded={levelsOpen}
                    disabled={disabled || props.reasoningDisabled === true}
                    onKeyDown={(event) => {
                      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                        event.preventDefault()
                        setLevelsOpen(true)
                      }
                    }}
                    onClick={() => { setLevelsOpen(current => !current) }}>
                    <span className={styles['reasoningSelection']} aria-hidden="true">
                      {selectedLevels.map(level => <span key={level} className={styles['reasoningChip']}>
                        {level === 'off' ? t('reasoningNone') : level}
                      </span>)}
                    </span>
                    <IconChevronDownOutline14 size={14} />
                  </button>}
                />
              </div>}
              <label className={styles['modelField']}>
                <span className={styles['modelFieldLabel']}>{t('modelContextWindow')}</span>
                <input
                  className={styles['input']}
                  type="text"
                  inputMode="numeric"
                  value={capacityText(model, 'contextWindow')}
                  placeholder={CAPACITY_HINT.contextWindow}
                  aria-label={`${t('modelContextWindow')} ${index + 1}`}
                  aria-invalid={invalidCapacity('contextWindow')}
                  disabled={disabled}
                  onChange={(event) => { editCapacity('contextWindow', event.target.value) }}
                />
                {invalidCapacity('contextWindow') && <span className={styles['modelFieldError']} role="alert">
                  {t('modelContextInvalid')}
                </span>}
              </label>
              <label className={styles['modelField']}>
                <span className={styles['modelFieldLabel']}>{t('modelMaxTokens')}</span>
                <input
                  className={styles['input']}
                  type="text"
                  inputMode="numeric"
                  value={capacityText(model, 'maxTokens')}
                  placeholder={CAPACITY_HINT.maxTokens}
                  aria-label={`${t('modelMaxTokens')} ${index + 1}`}
                  aria-invalid={invalidCapacity('maxTokens')}
                  disabled={disabled}
                  onChange={(event) => { editCapacity('maxTokens', event.target.value) }}
                />
                {invalidCapacity('maxTokens') && <span className={styles['modelFieldError']} role="alert">
                  {t('modelMaxTokensInvalid')}
                </span>}
              </label>
            </>
          })()}
        </div>
      </Modal>}
      <button
        type="button"
        className={styles['addModelButton']}
        disabled={disabled}
        onClick={() => { onChange([...models, adopt({ id: '' }, probe.settingsNs, props.reasoningDisabled === true)]) }}
      >
        <IconPlusOutline16 size={16} />{t('addModel')}
      </button>
      {failure !== undefined ? <p className={styles['error']}>{failure}</p> : null}
      <Modal
        trapFocus
        open={candidates !== undefined}
        onClose={closePicker}
        title={props.providerName === undefined ? t('fetchTitle') : `${props.providerName} ${t('models')}`}
        closeLabel={t('close')}
        description={t('fetchDescription')}
        className={styles['fetchDialog'] as string}
        footer={(
          <>
            <Button variant="outline" onClick={closePicker}>{t('cancel')}</Button>
            <Button variant="outline" disabled={!selectable.some(candidate => picked.has(candidate.id))}
              onClick={adoptPicked}>{t('fetchAdopt')}</Button>
          </>
        )}
      >
        <div className={styles['candidateToolbar']}>
          <label className={styles['candidateSearch']}><IconSearchOutline16 size={18} />
            <input autoFocus value={candidateQuery} onChange={(event) => {
              setCandidateQuery(event.target.value)
              setPicked(new Set())
            }}
            placeholder={t('searchModels')} aria-label={t('searchModels')} /></label>
        </div>
        <div className={styles['candidateActions']}>
          <Button variant="ghost" size="sm" disabled={selectable.length === 0} onClick={toggleAllCandidates}>
            {t(allCandidatesPicked ? 'fetchDeselectAll' : 'fetchSelectAll')}
          </Button>
        </div>
        <ul className={styles['candidateList']}>
          {[...families].map(([family, group]) => <li key={family} className={styles['candidateGroup']}>
            <div className={styles['candidateGroupHead']}><span>{family}</span><span className={styles['candidateCount']}>{group.length}</span>
              <button type="button" disabled={group.every(candidate => known.has(candidate.id))}
                aria-label={`${t(group.every(candidate => known.has(candidate.id)) ? 'familyAdded' : 'addFamily')} ${family}`}
                onClick={() => { adoptGroup(group) }}>
                {group.every(candidate => known.has(candidate.id)) ? t('addedShort') : <IconPlusOutline16 size={18} />}</button></div>
            {group.map(candidate => <div key={candidate.id} className={styles['candidate']}>
              <label className={styles['candidateLabel']}><input className={styles['modelCheckboxInput']} type="checkbox"
                disabled={known.has(candidate.id)}
                checked={picked.has(candidate.id)}
                onChange={() => { toggle(candidate.id) }} />
              <span className={styles['modelCheckboxBox']} aria-hidden="true"><IconCheckOutline14 size={12} /></span>
              <span className={styles['candidateAvatar']} aria-hidden="true">{candidate.id.slice(0, 1).toLocaleUpperCase()}</span>
              <span className={styles['candidateId']}>{candidate.id}</span></label>
              <button type="button" className={styles['candidateAdd']} disabled={known.has(candidate.id)}
                aria-label={`${t(known.has(candidate.id) ? 'addedModel' : 'addModel')} ${candidate.id}`}
                onClick={() => { adoptGroup([candidate]) }}>
                {known.has(candidate.id) ? t('addedShort') : <IconPlusOutline16 size={18} />}</button>
            </div>)}
          </li>)}
        </ul>
      </Modal>
    </section>
  )
}
