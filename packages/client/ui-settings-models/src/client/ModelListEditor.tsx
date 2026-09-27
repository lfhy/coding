/**
 * 单个渠道的模型目录编辑与端点发现。发现请求使用表单当前的地址和未保存密钥，
 * 只返回待选候选；勾选、逐项或整组导入仅修改草稿，不隐式提交设置。
 * 端点不可发现时显示诊断，手工模型编辑仍可使用。
 */

import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { DiscoveredModelView, IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  IconChevronDownOutline14, IconPlusOutline16, IconRefreshOutline16, IconSearchOutline16,
  IconThinkOutline14, IconTrashOutline16,
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

/** Disclosure chevron; rotates to point down while its row is open. */
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
  // Rows carry an id and a name; capacities are the exception, so they stay
  // folded until asked for rather than crowding every row with four inputs.
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set())
  // Capacities are edited as text, so a field's keystrokes are held here rather
  // than re-derived from the parsed count on every change — that would rewrite
  // `1000` to `1K` mid-word. Unreadable text is kept past blur so the refusal
  // names a row the user can still see, which is why this is one entry PER
  // FIELD: a single buffer would be displaced by editing any other field, and
  // the abandoned one would render its stored NaN as the literal `NaN`.
  const [editing, setEditing] = useState<ReadonlyMap<string, string>>(new Map())

  /** Buffer key for one capacity field; the row half moves when rows do. */
  const bufferKey = (index: number, field: CapacityField): string => `${String(index)}:${field}`

  const editCapacity = (index: number, field: CapacityField, text: string): void => {
    setEditing(current => new Map(current).set(bufferKey(index, field), text))
    patch(index, { [field]: parseCapacity(text) })
  }

  /** What a capacity field shows: the buffer while typing, else the stored count. */
  const capacityText = (model: ModelDraft, index: number, field: CapacityField): string =>
    editing.get(bufferKey(index, field)) ?? capacitySpelling(numberOf(model, field))

  const effortsOf = (model: ModelDraft): readonly string[] =>
    Array.isArray(model['reasoningEfforts'])
      ? model['reasoningEfforts'] as string[]
      : model['reasoningEfforts'] === undefined ? props.inheritedReasoningEfforts ?? [] : []

  /** Drop one row's entries and shift the rows after it down, in one pass. */
  const reindexOnRemove = (
    current: ReadonlyMap<string, string>,
    index: number,
  ): Map<string, string> => {
    const next = new Map<string, string>()
    for (const [key, value] of current) {
      const at = Number(key.slice(0, key.indexOf(':')))
      if (at === index) continue
      // Only the row number moves; the field half of the key is untouched.
      next.set(at > index ? key.replace(/^\d+/, String(at - 1)) : key, value)
    }
    return next
  }

  const toggleExpanded = (index: number): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (!next.delete(index)) next.add(index)
      return next
    })
  }

  const patch = (index: number, next: Record<string, unknown>): void => {
    onChange(models.map((model, at) => {
      if (at !== index) return model
      // Rebuilt rather than spread over: an emptied optional field has to leave
      // the profile, not be stored as a value its schema would reject.
      // Spread first so a field this card does not edit survives; an emptied
      // optional field is then dropped rather than stored as a value its
      // schema would reject.
      const cleared = new Set(
        Object.entries(next).filter(([, value]) => value === undefined || value === '').map(([key]) => key),
      )
      return Object.fromEntries(
        Object.entries({ ...model, ...next }).filter(([key]) => !cleared.has(key)),
      )
    }))
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
          {props.overridden === undefined
            ? null
            : (
              <span className={styles['modelCatalogMeta']}>
                {props.overridden ? t('modelsCustomized') : t('modelsInherited')}
              </span>
            )}
        </div>
        {props.overridden === true && props.onReset !== undefined
          ? (
            <button
              type="button"
              className={styles['linkButton']}
              disabled={disabled}
              onClick={() => {
                setEditing(new Map())
                setExpanded(new Set())
                props.onReset?.()
              }}
            >
              {t('resetModels')}
            </button>
          )
          : null}
        <button
          type="button"
          ref={fetchButton}
          className={styles['linkButton']}
          disabled={disabled || busy || !askable || props.probeBlocked !== undefined}
          title={props.probeBlocked !== undefined
            ? t(props.probeBlocked)
            : askable ? undefined : t('fetchNeedsBaseUrl')}
          onClick={() => { void fetchModels() }}
        >
          <IconRefreshOutline16 size={16} />{busy ? t('fetching') : t('fetchModels')}
        </button>
      </div>
      {models.length === 0 ? <p className={styles['modelEmpty']}>{t('modelsEmpty')}</p> : null}
      {models.map((model, index) => (
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
            <div className={styles['modelCapabilities']}>
              {(['vision', 'reasoning'] as const).map((capability) => {
                const state = modelCapabilities(model, probe.settingsNs, props.inheritedReasoningEfforts)[capability]
                const label = capability === 'vision'
                  ? t(state === 'supported' ? 'visionSupport' : state === 'unsupported' ? 'visionUnsupported' : 'visionUnspecified')
                  : t(state === 'supported' ? 'reasoningSupport' : state === 'unsupported' ? 'reasoningUnsupported' : 'reasoningUnspecified')
                return <span key={capability} className={`${styles['capabilityBadge']} ${state === 'supported'
                  ? styles['capabilitySupported'] : state === 'unknown' ? styles['capabilityUnknown'] : ''}`}>
                  {capability === 'reasoning' && state === 'supported' ? <span aria-hidden="true"><IconThinkOutline14 size={14} /></span> : null}
                  {label}
                </span>
              })}
            </div>
            <button
              type="button"
              className={styles['iconButton']}
              aria-label={`${t('modelAdvanced')} ${index + 1}`}
              aria-expanded={expanded.has(index)}
              title={t('modelAdvanced')}
              onClick={() => { toggleExpanded(index) }}
            >
              <IconChevron open={expanded.has(index)} />
            </button>
            <button
              type="button"
              className={`${styles['iconButton']} ${styles['iconButtonDanger']}`}
              aria-label={`${t('removeModel')} ${index + 1}`}
              title={t('removeModel')}
              disabled={disabled}
              onClick={() => {
                onChange(models.filter((_model, at) => at !== index))
                // Both stores are keyed by position, so every row after this
                // one shifts down and would otherwise inherit its neighbour's
                // state — a different row's capacities popping open, or its
                // half-typed text appearing in another row's field.
                setExpanded((current) => {
                  const next = new Set<number>()
                  for (const at of current) {
                    if (at < index) next.add(at)
                    else if (at > index) next.add(at - 1)
                  }
                  return next
                })
                setEditing(current => reindexOnRemove(current, index))
              }}
            >
              <IconTrash />
            </button>
          </div>
          {expanded.has(index)
            ? (
              <div className={styles['modelAdvanced']}>
                <div className={styles['capabilityControls']}>
                  <label><input type="checkbox" checked={Array.isArray(model[probe.settingsNs === 'llm-deepseek' ? 'inputModalities' : 'input'])
                    && (model[probe.settingsNs === 'llm-deepseek' ? 'inputModalities' : 'input'] as string[]).includes('image')}
                  disabled={disabled} onChange={(event) => {
                    patch(index, { [probe.settingsNs === 'llm-deepseek' ? 'inputModalities' : 'input']:
                        event.target.checked ? ['text', 'image'] : ['text'] })
                  }} />{t('visionSupport')}</label>
                  <label><input type="checkbox" checked={probe.settingsNs === 'llm-deepseek'
                    ? effortsOf(model).some(level => level !== 'off')
                    : typeof model['reasoningEfforts'] === 'object' && model['reasoningEfforts'] !== null
                        && Object.keys(model['reasoningEfforts']).some(level => level !== 'off')}
                  disabled={disabled || props.reasoningDisabled === true} onChange={(event) => {
                    patch(index, { reasoningEfforts: event.target.checked
                      ? probe.settingsNs === 'llm-deepseek' ? ['off', 'low', 'high', 'max']
                        : { off: null, low: 'low', high: 'high', max: 'max' }
                      : probe.settingsNs === 'llm-deepseek' ? ['off'] : false })
                  }} />{t('reasoningSupport')}</label>
                  {(['off', 'low', 'high', 'max'] as const).map(level => (
                    <label key={level}><input type="checkbox"
                      disabled={disabled || props.reasoningDisabled === true && level !== 'off'
                        || level === 'off' && (probe.settingsNs === 'llm-deepseek'
                          ? effortsOf(model).length === 1 && effortsOf(model)[0] === 'off'
                          : model['reasoningEfforts'] === false)}
                      checked={probe.settingsNs === 'llm-deepseek'
                        ? effortsOf(model).includes(level)
                        : typeof model['reasoningEfforts'] === 'object' && model['reasoningEfforts'] !== null
                          ? level in model['reasoningEfforts'] : level === 'off'}
                      onChange={(event) => {
                        if (probe.settingsNs === 'llm-deepseek') {
                          const prior = effortsOf(model)
                          const next = event.target.checked ? [...prior, level] : prior.filter(value => value !== level)
                          patch(index, { reasoningEfforts: next.length === 0 ? ['off'] : next })
                        } else {
                          const prior = typeof model['reasoningEfforts'] === 'object' && model['reasoningEfforts'] !== null
                            ? model['reasoningEfforts'] as Record<string, string | null> : { off: null }
                          const next = { ...prior }
                          if (event.target.checked) next[level] = level === 'off' ? null : level
                          else Reflect.deleteProperty(next, level)
                          patch(index, { reasoningEfforts: Object.keys(next).every(key => key === 'off') ? false : next })
                        }
                      }} />{level === 'off' ? t('reasoningNone') : level}</label>
                  ))}
                </div>
                <label className={styles['modelField']}>
                  <span className={styles['modelFieldLabel']}>{t('modelContextWindow')}</span>
                  <input
                    className={styles['input']}
                    type="text"
                    inputMode="numeric"
                    value={capacityText(model, index, 'contextWindow')}
                    placeholder={CAPACITY_HINT.contextWindow}
                    aria-label={`${t('modelContextWindow')} ${index + 1}`}
                    disabled={disabled}
                    onChange={(event) => { editCapacity(index, 'contextWindow', event.target.value) }}
                  />
                </label>
                <label className={styles['modelField']}>
                  <span className={styles['modelFieldLabel']}>{t('modelMaxTokens')}</span>
                  <input
                    className={styles['input']}
                    type="text"
                    inputMode="numeric"
                    value={capacityText(model, index, 'maxTokens')}
                    placeholder={CAPACITY_HINT.maxTokens}
                    aria-label={`${t('modelMaxTokens')} ${index + 1}`}
                    disabled={disabled}
                    onChange={(event) => { editCapacity(index, 'maxTokens', event.target.value) }}
                  />
                </label>
              </div>
            )
            : null}
        </div>
      ))}
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
              <label className={styles['candidateLabel']}><input type="checkbox" disabled={known.has(candidate.id)}
                checked={picked.has(candidate.id)}
                onChange={() => { toggle(candidate.id) }} />
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
