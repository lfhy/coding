/**
 * 单个渠道的模型目录编辑与端点发现。发现请求使用表单当前的地址和未保存密钥，
 * 只返回待选候选；勾选、逐项或整组导入仅修改草稿，不隐式提交设置。
 * 端点不可发现时显示诊断，手工模型编辑仍可使用。
 */

import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { DiscoveredModelView, IApiClient } from 'coding-api-remotes/client'
import { Button, Modal } from 'coding-client-ui-primitives'
import {
  IconCheckOutline14, IconChevronDownOutline14, IconCloseOutline16, IconPlusOutline16, IconRefreshOutline16,
  IconQuestionOutline14, IconSearchOutline16, IconTrashOutline16,
} from 'coding-client-ui-icons'
import { defaultReasoning, modelText as textOf, withModelFields } from './model-editor-helpers.ts'
import type { ModelDraft as ModelDraftRecord } from './model-editor-helpers.ts'
import type { ModelEditorSchema } from './model-editor-schema.ts'
import { ModelSettingsDialog } from './ModelSettingsDialog.tsx'
import { messageOf } from './store.ts'
import type { ModelPresetOption } from './store.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** 开放草稿会保留编辑器未展示的模型字段。 */
export type ModelDraft = ModelDraftRecord
type Capability = 'supported' | 'unsupported' | 'unknown'

/**
 * 一行声明的推理能力：档位列表里有非 off 项就是支持，显式声明无档位就是不支持，
 * 没有该字段的行仍显示为未指定。
 */
function reasoningCapability(
  model: ModelDraft,
  schema: ModelEditorSchema,
  inheritedReasoningEfforts: readonly string[] | undefined,
): Capability {
  const declared = model['reasoningEfforts']
  if (schema.reasoningShape === 'none') return 'unknown'
  if (schema.reasoningShape === 'array') {
    return Array.isArray(declared)
      ? declared.some(level => level !== 'off') ? 'supported' : 'unsupported'
      : declared === false ? 'unsupported' : inheritedReasoningEfforts === undefined
        ? 'unknown'
        : inheritedReasoningEfforts.some(level => level !== 'off') ? 'supported' : 'unsupported'
  }
  return declared === false
    ? 'unsupported'
    : typeof declared === 'object' && declared !== null && !Array.isArray(declared)
      ? Object.keys(declared).some(level => level !== 'off') ? 'supported' : 'unsupported'
      : 'unknown'
}

/** 只投影显式声明或已知渠道继承的模型能力；缺失的 pi-ai catalog 元数据不等于不支持。 */
export function modelCapabilities(
  model: ModelDraft,
  schema: ModelEditorSchema,
  inheritedReasoningEfforts?: readonly string[],
): { vision: Capability; reasoning: Capability } {
  const input = schema.modalityKey === undefined ? undefined : model[schema.modalityKey]
  const vision: Capability = Array.isArray(input) && input.length > 0
    ? input.includes('image') ? 'supported' : 'unsupported'
    : 'unknown'
  return { vision, reasoning: reasoningCapability(model, schema, inheritedReasoningEfforts) }
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
  /** 由所属 settings schema 声明的模型字段。 */
  modelSchema: ModelEditorSchema
  /** 空容量字段显示的渠道默认上限。 */
  capacityHints?: { contextWindow: string; maxTokens: string }
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
  /** 模型字段的 schema 声明的可选协议。 */
  protocols?: readonly string[]
  /** 空的模型协议选择继承这条渠道的协议。 */
  channelProtocol?: string | undefined
  /** 已安装目录中由部署层为单模型固定的协议，优先于渠道协议。 */
  deploymentModelProtocols?: ReadonlyMap<string, string>
  /** 当前可选模式，来自 Host 的模式名单。 */
  presets?: readonly ModelPresetOption[]
  /** 名单读取失败时保留当前模式及继承选项，并展示诊断。 */
  presetsError?: string | null | undefined
  /** 模型到模式的当前设置及尚未提交的渠道草稿。 */
  presetForModel?: (model: string) => string | undefined
  /** 仅把本行模式选择纳入渠道草稿，不提交设置。 */
  onPresetChange?: (model: string, preset: string | undefined) => void
  /** 模式设置分节不可用时禁止选择。 */
  presetDisabled?: boolean
  /** 适配器 catalog 行使用 modelOverrides，不能在本列表改动模型身份或整份目录。 */
  catalogOnly?: boolean
  /** 模型身份改变时，外层迁移尚未提交的模式映射。 */
  onModelIdChange?: (index: number, oldId: string, newId: string, duplicate: boolean) => void
  /** 删除模型时，外层清除对应的模式映射。 */
  onModelRemove?: (index: number, id: string) => void
}

/** 模型设置按钮展开时旋转箭头，指向悬浮表单。 */
function IconChevron({ open }: { open: boolean }): ReactNode {
  return <IconChevronDownOutline14 size={14} className={open ? styles['expandedChevron'] : undefined} />
}

/** Removal glyph for one model row. */
function IconTrash(): ReactNode {
  return <IconTrashOutline16 size={14} />
}

/** 发现服务不返回能力；用可编辑的默认值填入草稿，不作远端能力断言。 */
function adopt(candidate: DiscoveredModelView, schema: ModelEditorSchema, disabled: boolean): ModelDraft {
  const reasoning = defaultReasoning(schema, disabled)
  return {
    id: candidate.id,
    ...candidate.name === undefined ? {} : { name: candidate.name },
    ...candidate.contextWindow === undefined ? {} : { contextWindow: candidate.contextWindow },
    ...candidate.maxTokens === undefined ? {} : { maxTokens: candidate.maxTokens },
    ...schema.modalityKey === undefined ? {} : { [schema.modalityKey]: ['text', 'image'] },
    ...reasoning === undefined ? {} : { reasoningEfforts: reasoning },
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
  const { models, onChange, probe, api, t, disabled, modelSchema } = props
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [candidates, setCandidates] = useState<readonly DiscoveredModelView[] | undefined>(undefined)
  const [candidateQuery, setCandidateQuery] = useState('')
  const fetchButton = useRef<HTMLButtonElement>(null)
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  // 同时只编辑一行；草稿留在独立窗口中，不进入模型目录表格的布局。
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const anchorRef = useRef<HTMLButtonElement | null>(null)
  const openedModel = activeIndex === null ? undefined : models[activeIndex]

  const closeSettings = (): void => {
    setActiveIndex(null)
    if (anchorRef.current?.isConnected === true) anchorRef.current.focus({ preventScroll: true })
  }

  const openSettings = (index: number, anchor: HTMLButtonElement): void => {
    if (index === activeIndex) {
      closeSettings()
      return
    }
    anchorRef.current = anchor
    setActiveIndex(index)
  }

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
      next.push(adopt(candidate, modelSchema, props.reasoningDisabled === true))
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
          {props.overridden === false || (props.overridden === true && props.onReset !== undefined)
            ? (
              <span className={styles['modelCatalogMeta']}>
                {t(props.overridden ? 'modelsCustomized' : 'modelsInherited')}
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
      {props.overridden === true && props.onReset !== undefined && (
        <Button variant="ghost" size="sm" disabled={disabled} onClick={() => {
          closeSettings()
          props.onReset?.()
        }}>{t('resetModels')}</Button>
      )}
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
                disabled={disabled || props.catalogOnly === true}
                onChange={(event) => {
                  const next = event.target.value
                  props.onModelIdChange?.(index, textOf(model, 'id'), next,
                    models.some((other, at) => at !== index && textOf(other, 'id') === next))
                  patch(index, { id: next })
                }}
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
                const state = modelCapabilities(model, modelSchema, props.inheritedReasoningEfforts)[capability]
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
                aria-expanded={activeIndex === index}
                title={t('modelAdvanced')}
                ref={activeIndex === index ? anchorRef : undefined}
                onClick={(event) => {
                  if (activeIndex === index) closeSettings()
                  else openSettings(index, event.currentTarget)
                }}
              >
                <IconChevron open={activeIndex === index} />
              </button>
              <button
                type="button"
                className={`${styles['iconButton']} ${styles['iconButtonDanger']}`}
                aria-label={`${t('removeModel')} ${index + 1}`}
                title={t('removeModel')}
                disabled={disabled || props.catalogOnly === true}
                onClick={() => {
                  props.onModelRemove?.(index, textOf(model, 'id'))
                  onChange(models.filter((_model, at) => at !== index))
                  // 删除当前行时关闭表单；删去前面的行则跟随原有模型前移。
                  setActiveIndex(current => current === null || current === index
                    ? null : current > index ? current - 1 : current)
                }}
              >
                <IconTrash />
              </button>
            </div>
          </div>
        ))}</div>
      </div> : null}
      {openedModel !== undefined && activeIndex !== null && <ModelSettingsDialog
        key={activeIndex} row={openedModel} index={activeIndex} view={props}
        canEditPreset={props.presetForModel !== undefined}
        initialPreset={props.presetForModel?.(textOf(openedModel, 'id'))}
        onClose={closeSettings}
        onSave={(fields, preset) => {
          if (fields !== undefined) patch(activeIndex, fields)
          const id = textOf(openedModel, 'id')
          if (id.length > 0 && preset !== props.presetForModel?.(id)) props.onPresetChange?.(id, preset)
          closeSettings()
        }} />}
      <button
        type="button"
        className={styles['addModelButton']}
        disabled={disabled || props.catalogOnly === true}
        onClick={() => { onChange([...models, adopt({ id: '' }, modelSchema, props.reasoningDisabled === true)]) }}
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
        contentClassName={styles['fetchContent'] as string}
        footer={(
          <>
            <Button variant="outline" onClick={closePicker}>{t('cancel')}</Button>
            <Button variant="primary" disabled={!selectable.some(candidate => picked.has(candidate.id))}
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
          <span className={styles['candidateTotal']} role="status" aria-live="polite">
            {filteredCandidates.length}/{activeCandidates.length} {t('models')}
          </span>
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
