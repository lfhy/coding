/** 首次使用时在同一个弹窗内配置渠道、模型与可启动的默认模型。 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-icons'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelsSettingsState, ModelsSettingsStore } from './store.ts'
import { onboardingReadiness } from './store.ts'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import { ModelsSection } from './ModelsSection.tsx'
import type { en } from './locales.ts'
import { OnboardingModal } from './OnboardingModal.tsx'
import styles from './DeepSeekOnboardingDialog.module.css'

/** 引导步骤从模型设置页共享的联接快照读取事实。 */
export interface DeepSeekOnboardingInjected {
  hooks: { models: SnapshotStore<ModelsSettingsState> }
  controller: ModelsSettingsStore
  api: Pick<IApiClient, 'settings' | 'credentials' | 'llm'>
  schema: SettingsSchemaOperations
  t: (key: keyof typeof en) => string
}

/** 引导槽拥有的完成回调与模型页注入项。 */
export type DeepSeekOnboardingDialogProps =
  PropsRuntime<'settings.onboarding'> & InjectFace<DeepSeekOnboardingInjected>

/**
 * 在渠道及模型目录具备可启动候选前保留引导；已有可用默认模型时直接完成。
 * @param props - 引导完成回调及模型设置页共享的联接能力。
 * @returns 同一容器中的设置与启动选择，或已完成时的空视图。
 */
export function DeepSeekOnboardingDialog(props: DeepSeekOnboardingDialogProps): ReactNode {
  const { complete, controller, useModels, api, schema, t } = props
  const state = useModels(snapshot => snapshot)
  const readiness = onboardingReadiness(state)
  const completed = useRef(false)
  const resolved = useRef(false)
  const [selection, setSelection] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | undefined>()
  const choices = state.onboardingModels
  const selected = choices.find(choice => `${choice.provider}\u0000${choice.model}` === selection)
  const canAddProvider = state.namespaces.has('llm-pi-ai') || state.rows.some(row =>
    row.entry.active && row.entry.settingsNs !== '' && state.namespaces.has(row.entry.settingsNs))
  const providerUnavailable = readiness.kind === 'needs-setup'
    && readiness.reason === 'no-provider' && !canAddProvider
  const isReady = readiness.kind === 'ready'

  useLayoutEffect(() => {
    if (isReady) return
    const appRoot = document.getElementById('root')
    if (appRoot === null) return
    const previous = appRoot.inert
    appRoot.inert = true
    return () => { appRoot.inert = previous }
  }, [isReady])

  useEffect(() => {
    if (state.status === 'idle') void controller.load()
  }, [controller, state.status])

  useEffect(() => {
    if (readiness.kind === 'ready' && !completed.current) {
      completed.current = true
      complete()
    }
  }, [complete, readiness.kind])

  // 首次联接未知时不弹出瞬态空壳；判定期间仍阻断工作台输入。
  if (readiness.kind !== 'loading') resolved.current = true
  if (readiness.kind === 'ready' || (readiness.kind === 'loading' && !resolved.current)) return null

  const start = (): void => {
    if (selected === undefined || saving || readiness.kind !== 'needs-selection') return
    setSaving(true)
    setSaveError(undefined)
    void controller.selectOnboardingModel({ provider: selected.provider, model: selected.model })
      .then((error) => { if (error !== undefined) setSaveError(error) })
      .finally(() => { setSaving(false) })
  }

  const diagnostics = (() => {
    switch (readiness.kind) {
      case 'loading': return t('onboardingLoading')
      case 'needs-selection': return t('onboardingSelectHint')
      case 'needs-setup':
        switch (readiness.reason) {
          case 'no-provider': return t(providerUnavailable ? 'onboardingProviderUnavailable' : 'onboardingNoProvider')
          case 'credential-missing': return t('onboardingCredentialMissing')
          case 'no-models': return t('onboardingNoModels')
        }
      case 'unavailable':
        switch (readiness.reason) {
          case 'load-failed': return t('onboardingLoadFailed')
          case 'credentials-unavailable': return t('onboardingCredentialsUnavailable')
          case 'settings-read-only': return t('onboardingReadOnly')
          case 'credential-read-only': return t('onboardingCredentialReadOnly')
          case 'catalog-unavailable': return t('onboardingCatalogFailed')
          case 'catalog-provider-failed': return t('onboardingProviderCatalogFailed')
        }
    }
  })()

  return (
    <OnboardingModal title={t('onboardingTitle')} focusTitle manageInert={false}>
      <div className={styles.layout}>
        <p className={styles.description}>{t('onboardingDescription')}</p>
        <div className={styles.workspace}>
          {state.hasLoaded
            ? <ModelsSection controller={controller} useSnapshot={useModels}
              api={api} schema={schema} t={t} hideHeader /> : null}
        </div>
        <div className={styles.footer}>
          <div className={styles.feedback}>
            <p className={readiness.kind === 'unavailable' || providerUnavailable ? styles.error : styles.hint}
              role={readiness.kind === 'unavailable' || providerUnavailable ? 'alert' : 'status'}>
              {diagnostics}{readiness.kind === 'unavailable' && readiness.detail !== undefined
                ? `：${readiness.detail}` : ''}
            </p>
            {state.onboardingModelFailures.length > 0 && readiness.kind === 'needs-selection'
              ? <p className={styles.error} role="alert">
                {t('onboardingSomeCatalogFailed')}：{state.onboardingModelFailures
                  .map(failure => `${failure.name} (${failure.id}): ${failure.message}`).join('; ')}
              </p> : null}
            {saveError === undefined ? null : <p className={styles.error} role="alert">{saveError}</p>}
            {readiness.kind === 'unavailable' || providerUnavailable || state.onboardingModelFailures.length > 0
              ? <button type="button" className={styles.retry}
                onClick={() => { setSaveError(undefined); void controller.retry() }}>{t('retry')}</button> : null}
          </div>
          <div className={styles.actions}>
            <label className={styles.modelField}>
              <span>{t('onboardingModel')}</span>
              <span className={styles.selectWrap}>
                <select className={styles.selectInput} value={selected === undefined ? '' : selection}
                  disabled={choices.length === 0 || saving || readiness.kind === 'loading'}
                  onChange={(event) => { setSelection(event.target.value); setSaveError(undefined) }}>
                  <option value="">{t('onboardingChooseModel')}</option>
                  {choices.map(choice => <option key={`${choice.provider}\u0000${choice.model}`}
                    value={`${choice.provider}\u0000${choice.model}`}>
                    {choice.providerName} · {choice.modelName} ({choice.model})
                  </option>)}
                </select>
                <IconChevronDownOutline14 size={14} className={styles.selectChevron} />
              </span>
            </label>
            <button type="button" className={styles.start}
              disabled={selected === undefined || saving || readiness.kind !== 'needs-selection'}
              onClick={start}>{saving ? t('onboardingSaving') : t('onboardingStart')}</button>
          </div>
        </div>
      </div>
    </OnboardingModal>
  )
}
