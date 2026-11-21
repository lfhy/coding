/** 模型设置窗口只编辑一行草稿；取消不改变目录或已存设置。 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Menu, Modal } from 'coding-client-ui-primitives'
import { Icon, IconChevronDownOutline14 } from 'coding-client-ui-icons'
import { defaultReasoning, formatCapacity, modelText, parseCapacity, withModelFields } from './model-editor-helpers.ts'
import type { ModelDraft } from './model-editor-helpers.ts'
import type { ModelListEditorProps } from './ModelListEditor.tsx'
import { ProtocolPicker, protocolName } from './ProtocolPicker.tsx'
import styles from './ModelsSection.module.css'

type CapacityField = 'contextWindow' | 'maxTokens'
type ModelSettingsView = Pick<ModelListEditorProps,
  't' | 'disabled' | 'modelSchema' | 'capacityHints' | 'inheritedReasoningEfforts' | 'reasoningDisabled'
  | 'protocols' | 'channelProtocol' | 'deploymentModelProtocols' | 'presets' | 'presetsError' | 'presetDisabled'>

interface ModelSettingsDialogProps {
  row: ModelDraft
  index: number
  view: ModelSettingsView
  canEditPreset: boolean
  initialPreset: string | undefined
  onClose: () => void
  onSave: (fields: ModelDraft | undefined, preset: string | undefined) => void
}

/**
 * 编辑单行可见字段，保留未展示的配置和两层请求格式继承。
 * @param props - 模型行、渠道能力和提交草稿的回调。
 * @returns 模型设置窗口。
 */
export function ModelSettingsDialog(props: ModelSettingsDialogProps): ReactNode {
  const { row, index, view, initialPreset, canEditPreset, onClose, onSave } = props
  const { disabled, modelSchema, t } = view
  const [model, setModel] = useState(() => ({ ...row }))
  const [dirty, setDirty] = useState(false)
  const [presetDraft, setPresetDraft] = useState(initialPreset)
  const [capacityDraft, setCapacityDraft] = useState<Partial<Record<CapacityField, string>>>({})
  const [levelsOpen, setLevelsOpen] = useState(false)
  const [rememberedReasoning, setRememberedReasoning] = useState<unknown>(undefined)
  const modalBodyRef = useRef<HTMLDivElement>(null)
  const firstFieldRef = useRef<HTMLButtonElement>(null)
  const reasoningToggleRef = useRef<HTMLButtonElement>(null)
  const levelsTriggerRef = useRef<HTMLButtonElement>(null)
  const protocolTriggerRef = useRef<HTMLButtonElement>(null)
  const arrayEfforts = modelSchema.reasoningShape === 'array'
  const visionField = modelSchema.modalityKey
  const input = visionField === undefined ? undefined : model[visionField]
  const visionOn = Array.isArray(input) && input.includes('image')
  const declared = model['reasoningEfforts']
  const levels = arrayEfforts ? Array.isArray(declared) ? declared as string[]
    : declared === undefined ? view.inheritedReasoningEfforts ?? [] : []
    : typeof declared === 'object' && declared !== null && !Array.isArray(declared) ? Object.keys(declared) : []
  const reasoningOn = levels.some(level => level !== 'off')
  const selectedLevels = levels.length === 0 ? ['off'] : levels
  const deploymentApi = view.deploymentModelProtocols?.get(modelText(row, 'id'))
  const inheritedApi = deploymentApi ?? view.channelProtocol
  const inheritedLabel = t(deploymentApi === undefined ? 'modelApiInherit' : 'channelApiInherit')

  const patchDraft = (fields: ModelDraft): void => {
    setDirty(true)
    setModel(current => withModelFields(current, fields))
  }
  const invalidCapacity = (field: CapacityField): boolean => {
    const value = model[field]
    return typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)
  }
  const editCapacity = (field: CapacityField, input: string): void => {
    setCapacityDraft(current => ({ ...current, [field]: input }))
    patchDraft({ [field]: parseCapacity(input) })
  }
  // 保留输入期间的原文，避免把正在键入的 1000 改写为 1K。
  const capacityText = (draft: ModelDraft, field: CapacityField): string => {
    const value = draft[field]
    return capacityDraft[field] ?? (typeof value === 'number' ? formatCapacity(value) : '')
  }
  const invalid = invalidCapacity('contextWindow') || invalidCapacity('maxTokens')
  const saveSettings = (): void => {
    if (disabled || invalid) return
    onSave(dirty ? {
      ...visionField === undefined ? {} : { [visionField]: model[visionField] },
      ...modelSchema.reasoningShape === 'none' ? {} : { reasoningEfforts: declared },
      ...(view.protocols?.length ?? 0) === 0 ? {} : { api: model['api'] },
      contextWindow: model['contextWindow'],
      maxTokens: model['maxTokens'],
    } : undefined, presetDraft)
  }

  useEffect(() => {
    const first = firstFieldRef.current ?? reasoningToggleRef.current
    if (first?.disabled === false) first.focus({ preventScroll: true })
    else modalBodyRef.current?.focus({ preventScroll: true })
  }, [])
  useEffect(() => {
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || protocolTriggerRef.current?.getAttribute('aria-expanded') === 'true') return
      // 内层菜单先于窗口关闭，避免 Escape 透传到后方设置。
      event.preventDefault()
      event.stopImmediatePropagation()
      if (levelsOpen) {
        setLevelsOpen(false)
        levelsTriggerRef.current?.focus({ preventScroll: true })
      } else onClose()
    }
    document.addEventListener('keydown', escape, true)
    return () => { document.removeEventListener('keydown', escape, true) }
  }, [levelsOpen, onClose])

  return <Modal open trapFocus onClose={onClose}
    title={t('modelAdvanced')} ariaLabel={`${t('modelAdvanced')} ${index + 1}`}
    closeLabel={t('close')}
    className={styles['modelSettingsDialog'] ?? ''}
    contentClassName={styles['modelSettingsContent'] ?? ''}
    footer={<>
      <Button variant="outline" onClick={onClose}>{t('cancel')}</Button>
      <Button variant="primary" disabled={disabled || invalid} onClick={saveSettings}>{t('save')}</Button>
    </>}>
    <div ref={modalBodyRef} tabIndex={-1} className={styles['modelAdvancedFields']}>
      <div className={styles['capabilityControls']}>
        {visionField === undefined ? null : (
          <button type="button" ref={firstFieldRef} className={styles['capabilityToggle']}
            aria-label={t('visionSupport')} aria-pressed={visionOn} disabled={disabled}
            onClick={() => { patchDraft({ [visionField]: visionOn ? ['text'] : ['text', 'image'] }) }}>
            <Icon name="model-vision" size={16} /><span>{t('visionSupport')}</span>
          </button>
        )}
        {modelSchema.reasoningShape !== 'none' && <button type="button" ref={reasoningToggleRef} className={styles['capabilityToggle']}
          aria-label={t('reasoningSupport')} aria-pressed={reasoningOn}
          disabled={disabled || view.reasoningDisabled === true}
          onClick={() => {
            if (!reasoningOn) {
              const restored = arrayEfforts
                ? Array.isArray(rememberedReasoning) && rememberedReasoning.some(level => level !== 'off')
                  ? rememberedReasoning : defaultReasoning(modelSchema, false)
                : typeof rememberedReasoning === 'object' && rememberedReasoning !== null
                    && !Array.isArray(rememberedReasoning)
                    && Object.keys(rememberedReasoning).some(level => level !== 'off')
                  ? rememberedReasoning : defaultReasoning(modelSchema, false)
              patchDraft({ reasoningEfforts: restored })
            } else {
              setRememberedReasoning(arrayEfforts ? levels : declared)
              setLevelsOpen(false)
              patchDraft({ reasoningEfforts: arrayEfforts ? ['off'] : false })
            }
          }}>
          <Icon name="model-reasoning" size={16} /><span>{t('reasoningSupport')}</span>
        </button>}
      </div>
      {reasoningOn && <div className={styles['reasoningField']}>
        <span className={styles['modelFieldLabel']}>{t('reasoningLevels')}</span>
        <Menu portal open={levelsOpen} compact multiSelect matchAnchorWidth highlightSelected keyboardNavigation
          portalContainer={levelsTriggerRef.current?.closest('[role="dialog"]') ?? null}
          className={styles['reasoningDropdown'] ?? ''}
          selectedIds={selectedLevels}
          items={modelSchema.reasoningLevels
            .map(level => ({ id: level, label: level === 'off' ? t('reasoningNone') : level }))}
          onClose={() => { setLevelsOpen(false) }}
          onSelect={(level) => {
            if (arrayEfforts) {
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
            disabled={disabled || view.reasoningDisabled === true}
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
      {view.protocols !== undefined && view.protocols.length > 0 ? (
        <div className={styles['modelField']}>
          <span className={styles['modelFieldLabel']}>{t('modelApi')}</span>
          <ProtocolPicker label={t('modelApi')} protocols={view.protocols}
            unsetLabel={inheritedApi === undefined ? inheritedLabel : `${inheritedLabel} (${protocolName(inheritedApi)})`}
            triggerRef={protocolTriggerRef} value={modelText(model, 'api') || undefined} disabled={disabled}
            onChange={(api) => { patchDraft({ api }) }} />
        </div>
      ) : null}
      {canEditPreset ? (
        <div className={styles['modelField']}>
          <label className={styles['modelField']}>
            <span className={styles['modelFieldLabel']}>{t('modelDefaultPreset')}</span>
            <select className={`${styles['input']} ${styles['selectInput']}`}
              aria-label={t('modelDefaultPreset')} value={presetDraft ?? ''}
              disabled={disabled || view.presetDisabled === true}
              onChange={(event) => { setPresetDraft(event.target.value || undefined) }}>
              <option value="">{t('modelPresetInherit')}</option>
              {presetDraft !== undefined && !view.presets?.some(preset => preset.id === presetDraft)
                ? <option value={presetDraft}>{`${presetDraft} (${t(view.presetsError === undefined || view.presetsError === null
                  ? 'modelPresetUnavailable' : 'modelPresetUnverified')})`}</option> : null}
              {view.presets?.map(preset => <option key={preset.id} value={preset.id}
                disabled={preset.broken !== undefined && preset.id !== presetDraft}>
                {preset.name ?? preset.id}{preset.broken === undefined ? '' : ` (${t('modelPresetUnavailable')})`}
              </option>)}
            </select>
          </label>
          {view.presetsError !== undefined && view.presetsError !== null
            ? <p className={styles['modelFieldError']} role="alert">{`${t('modelPresetListFailed')}: ${view.presetsError}`}</p>
            : null}
        </div>
      ) : null}
      <label className={styles['modelField']}>
        <span className={styles['modelFieldLabel']}>{t('modelContextWindow')}</span>
        <input
          className={styles['input']}
          type="text"
          inputMode="numeric"
          value={capacityText(model, 'contextWindow')}
          placeholder={view.capacityHints?.contextWindow}
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
          placeholder={view.capacityHints?.maxTokens}
          aria-label={`${t('modelMaxTokens')} ${index + 1}`}
          aria-invalid={invalidCapacity('maxTokens')}
          disabled={disabled}
          onChange={(event) => { editCapacity('maxTokens', event.target.value) }}
        />
        {invalidCapacity('maxTokens') && <span className={styles['modelFieldError']} role="alert">
          {t('modelMaxTokensInvalid')}
        </span>}
      </label>
    </div>
  </Modal>
}
