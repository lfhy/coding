/** 电脑操作设置分区：开关、后端、应用授权与交互策略；草稿只属于本组件，保存时才写回。 */
import { useEffect, useRef, useState } from 'react'
import { Button, Input, Pill, StateDot } from 'coding-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from 'coding-client-ui-slots'
import {
  DEFAULT_SETTINGS, collectChanges, numberValue, numericTextOf, validArtifactRoot, validBundleId, validGrants,
  type ComputerPermissionState, type ComputerUseGrant, type ComputerUseSettings, type ComputerUseSettingsFace,
  type NumericField, type NumericText,
} from './settings.ts'
import type { ComputerUseSettingsKey } from './locales.ts'
import css from './ComputerUseSection.module.css'

/** 由设置槽位与控制器派生的分区属性。 */
export type ComputerUseSectionProps = PropsRuntime<'settings.section'>
  & PropsLocale<'settings.computer-use'> & InjectFace<ComputerUseSettingsFace>

/** 数值字段的编辑单位：两个有效期按秒展示，动作超时按毫秒。 */
const NUMERIC_FIELDS: readonly { field: NumericField; key: ComputerUseSettingsKey; hint: ComputerUseSettingsKey }[] = [
  { field: 'observationTtlMs', key: 'observationTtl', hint: 'observationTtlHint' },
  { field: 'confirmationTtlMs', key: 'confirmationTtl', hint: 'confirmationTtlHint' },
  { field: 'actionTimeoutMs', key: 'actionTimeout', hint: 'actionTimeoutHint' },
]

/** 权限取值到界面文案与状态点的映射。 */
const PERMISSION_VIEW: Record<ComputerPermissionState, { label: ComputerUseSettingsKey; state: 'done' | 'warning' | 'error' }> = {
  granted: { label: 'permGranted', state: 'done' },
  denied: { label: 'permDenied', state: 'error' },
  'not-determined': { label: 'permNotDetermined', state: 'warning' },
  unavailable: { label: 'permUnavailable', state: 'warning' },
}

/**
 * 呈现电脑操作的开关、后端与授权；`dsh-computer-use` 技能与执行工具随后由宿主决定。
 * @param props - 命名空间快照与保存操作。
 * @returns 设置分区内容。
 */
export function ComputerUseSection({
  useComputerUseSettings, useComputerUseAccess, save, check, recheckOnFocus, openPermissionSettings, requestPermission, t,
}: ComputerUseSectionProps) {
  const { section, saving, failed } = useComputerUseSettings(snapshot => snapshot)
  const access = useComputerUseAccess(snapshot => snapshot)
  const accessValue = access.value
  const [permissionFailure, setPermissionFailure] = useState<'accessRequestFailed' | 'accessOpenFailed'>()
  const [draft, setDraft] = useState<ComputerUseSettings | undefined>(undefined)
  const [numberText, setNumberText] = useState<NumericText | undefined>(undefined)
  const [newGrant, setNewGrant] = useState('')
  const mounted = useRef(true)
  const saved = section.value ?? DEFAULT_SETTINGS
  const refreshEnabled = section.status === 'ready' && saved.enabled && !saving
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => {
    if (section.status !== 'ready') return
    const recheck = (): void => { void recheckOnFocus() }
    window.addEventListener('focus', recheck)
    return () => { window.removeEventListener('focus', recheck) }
  }, [recheckOnFocus, section.status])
  useEffect(() => {
    if (refreshEnabled) void check()
  }, [check, refreshEnabled])

  const model = draft ?? saved
  const numbers = numberText ?? numericTextOf(saved)
  const blocked = section.status !== 'ready' || !section.writable || saving
  const driverSelected = model.provider === 'cua-driver'
  const interaction = model.interaction
  const permissionAction = (result: Promise<boolean>, message: 'accessRequestFailed' | 'accessOpenFailed'): void => {
    void result.then((ok) => { if (mounted.current) setPermissionFailure(ok ? undefined : message) })
  }
  const update = (patch: Partial<ComputerUseSettings>): void => {
    setDraft(current => ({ ...(current ?? saved), ...patch }))
  }
  const updateInteraction = (patch: Partial<ComputerUseSettings['interaction']>): void => {
    update({ interaction: { ...interaction, ...patch } })
  }

  const grantsValid = validGrants(model.grants)
  const artifactRootValid = validArtifactRoot(model.artifactRoot)
  const numericInvalid = (field: NumericField): boolean => numberValue(field, numbers[field]) === undefined
  const changes = collectChanges(saved, model, numbers)
  const ready = changes !== undefined
  const dirty = draft !== undefined || numberText !== undefined

  const commit = (): void => {
    // 保存按钮在草稿不合法或不可写时已禁用，这里的判定是防并发状态漂移的兜底。
    /* v8 ignore next -- 按钮禁用后无法触发提交；保留判定以防状态在两次渲染之间变化 */
    if (changes === undefined || blocked) return
    if (Object.keys(changes).length === 0) {
      setDraft(undefined)
      setNumberText(undefined)
      return
    }
    void save(changes).then((ok) => {
      if (mounted.current && ok) {
        setDraft(undefined)
        setNumberText(undefined)
      }
    })
  }

  const replaceGrant = (index: number, patch: Partial<ComputerUseGrant>): void => {
    update({ grants: model.grants.map((grant, position) => position === index ? { ...grant, ...patch } : grant) })
  }
  const removeGrant = (index: number): void => {
    update({ grants: model.grants.filter((_, position) => position !== index) })
  }
  /** 一条按应用授权的编辑行：标识只读展示，读取与控制各一个开关。 */
  const grantRow = (grant: ComputerUseGrant, index: number) => (
    <li key={`${grant.bundleId}-${String(index)}`} className={css.grantRow}>
      <span className={css.grantId} title={grant.bundleId}>{grant.bundleId}</span>
      <label className={css.grantToggle}>
        <input type="checkbox" checked={grant.read} disabled={blocked || grant.control}
          onChange={(event) => { replaceGrant(index, { read: event.target.checked }) }} />
        <span>{t('grantRead')}</span>
      </label>
      <label className={css.grantToggle}>
        <input type="checkbox" checked={grant.control} disabled={blocked}
          onChange={(event) => { replaceGrant(index, { control: event.target.checked, read: event.target.checked || grant.read }) }} />
        <span>{t('grantControl')}</span>
      </label>
      <Button size="sm" variant="ghost" disabled={blocked} onClick={() => { removeGrant(index) }}>
        {t('grantRemove')}
      </Button>
    </li>
  )

  const addGrant = (): void => {
    const bundleId = newGrant.trim()
    /* v8 ignore next -- 添加按钮在标识不合法或重复时已禁用，这里只防两帧之间的状态漂移 */
    if (!validBundleId(bundleId) || model.grants.some(grant => grant.bundleId === bundleId)) return
    update({ grants: [...model.grants, { bundleId, read: true, control: false }] })
    setNewGrant('')
  }

  return (
    <section className={css.section} aria-labelledby="computer-use-settings-title">
      <h2 id="computer-use-settings-title" className={css.title}>{t('title')}</h2>
      <p className={css.intro}>{t('intro')}</p>
      {section.status === 'loading' && <p className={css.hint} role="status">{t('loading')}</p>}
      {section.status === 'unavailable' && <p className={css.hint} role="status">{t('unavailable')}</p>}
      {section.status === 'ready' && <>
        <div className={css.statusRow}>
          <div className={css.statusText}>
            <span className={css.statusLabel}>{t('statusLabel')}</span>
            <span className={css.statusHint}>{t(saved.enabled ? 'statusOnHint' : 'statusOffHint')}</span>
          </div>
          <span className={css.statusValue}>{t(saved.enabled ? 'statusOn' : 'statusOff')}</span>
        </div>

        <label className={css.switch}>
          <input type="checkbox" checked={model.enabled} disabled={blocked}
            onChange={(event) => { update({ enabled: event.target.checked }) }} />
          <span>{t('enable')}</span>
        </label>
        <p className={css.switchHint}>{t('enableHint')}</p>

        <h3 className={css.groupTitle}>{t('accessTitle')}</h3>
        <p className={css.groupHint}>{t('accessHint')}</p>
        {access.status === 'loading' && <p className={css.hint} role="status">{t('accessLoading')}</p>}
        {access.status === 'error' && <p className={css.error} role="alert">{t('accessFailed')}</p>}
        {accessValue !== undefined && <>
          <ul className={css.permList} aria-label={t('accessTitle')}>
            {(['accessibility', 'screenRecording'] as const).map((key) => {
              const permission = PERMISSION_VIEW[accessValue[key]]
              const kind = key === 'accessibility' ? 'accessibility' as const : 'screen-recording' as const
              return (
                <li key={key} className={css.permRow}>
                  <span className={css.permName}>{t(key === 'accessibility' ? 'permAccessibility' : 'permScreenRecording')}</span>
                  <span className={css.permState}>
                    <StateDot state={permission.state} />
                    <span>{t(permission.label)}</span>
                  </span>
                  {accessValue[key] === 'granted'
                    ? null
                    : <Button size="sm" variant="outline" disabled={access.checking}
                      onClick={() => { permissionAction(requestPermission(kind), 'accessRequestFailed') }}>{t('accessRequest')}</Button>}
                </li>
              )
            })}
            <li className={css.permRow}>
              <span className={css.permName}>{t('permComponent')}</span>
              <span className={css.permState}>
                {accessValue.ready
                  ? <Pill>{t('permComponentReady', { version: accessValue.helperVersion ?? '—' })}</Pill>
                  : <span>{t('permComponentNotReady')}</span>}
              </span>
            </li>
          </ul>
          {accessValue.lastError !== undefined && <p className={css.error} role="alert">
            {t(accessValue.ready ? 'accessSettingsFailed' : 'accessProbeFailed')}
          </p>}
          <p className={css.fieldHint}>{t('accessRequestHint')}</p>
        </>}
        <div className={css.accessActions}>
          <Button size="sm" variant="outline" disabled={access.checking}
            onClick={() => { void check() }}>
            {t(access.checking ? 'accessChecking' : 'accessCheck')}
          </Button>
          <Button size="sm" variant="ghost" disabled={access.checking}
            onClick={() => { permissionAction(openPermissionSettings('accessibility'), 'accessOpenFailed') }}>
            {t('accessOpenAccessibility')}
          </Button>
          <Button size="sm" variant="ghost" disabled={access.checking}
            onClick={() => { permissionAction(openPermissionSettings('screen-recording'), 'accessOpenFailed') }}>
            {t('accessOpenScreen')}
          </Button>
        </div>
        {permissionFailure !== undefined && <p className={css.error} role="alert">{t(permissionFailure)}</p>}

        <h3 className={css.groupTitle}>{t('runtimeTitle')}</h3>
        <p className={css.groupHint}>{t('runtimeHint')}</p>
        <div className={css.choices} role="radiogroup" aria-label={t('runtimeTitle')}>
          {(['native', 'cua-driver'] as const).map(provider => (
            <button key={provider} type="button" role="radio" aria-checked={model.provider === provider}
              className={model.provider === provider ? `${css.choice} ${css.choiceActive}` : css.choice}
              disabled={blocked}
              onClick={() => {
                update({
                  provider,
                  // 驱动后端没有独立光标：切换时同步收窄，避免保存被宿主拒绝。
                  interaction: provider === 'cua-driver'
                    ? { ...interaction, cursorVisualization: 'hidden' }
                    : interaction,
                })
              }}>
              <span className={css.choiceLabel}>{t(provider === 'native' ? 'providerNative' : 'providerDriver')}</span>
              <span className={css.choiceHint}>{t(provider === 'native' ? 'providerNativeHint' : 'providerDriverHint')}</span>
            </button>
          ))}
        </div>
        {driverSelected && <div className={css.field}>
          <label htmlFor="computer-use-driver-bin">{t('driverBin')}</label>
          <Input id="computer-use-driver-bin" type="text" value={model.cuaDriver.bin ?? ''} disabled={blocked}
            placeholder="/usr/local/bin/cua-driver"
            onChange={(event) => { update({ cuaDriver: { ...model.cuaDriver, bin: event.target.value } }) }} />
          <p className={css.fieldHint}>{t('driverBinHint')}</p>
        </div>}

        <h3 className={css.groupTitle}>{t('permissionTitle')}</h3>
        <p className={css.groupHint}>{t('permissionHint')}</p>
        <label className={css.switch}>
          <input type="checkbox" checked={model.allowAllApps} disabled={blocked}
            onChange={(event) => { update({ allowAllApps: event.target.checked }) }} />
          <span>{t('allowAllApps')}</span>
        </label>
        <p className={css.switchHint}>{t('allowAllAppsHint')}</p>
        <h4 className={css.subTitle}>{t('grantsTitle')}</h4>
        {model.grants.length === 0
          ? <p className={css.hint}>{t('grantsEmpty')}</p>
          : <ul className={css.grantList} aria-label={t('grantsTitle')}>{model.grants.map(grantRow)}</ul>}
        <div className={css.addRow}>
          <Input id="computer-use-grant" type="text" value={newGrant} disabled={blocked}
            placeholder={t('grantPlaceholder')} aria-label={t('grantBundleId')}
            onChange={(event) => { setNewGrant(event.target.value) }} />
          <Button size="sm" variant="outline"
            disabled={blocked || !validBundleId(newGrant) || model.grants.some(grant => grant.bundleId === newGrant.trim())}
            onClick={addGrant}>{t('grantAdd')}</Button>
        </div>
        {!grantsValid && <p className={css.error} role="alert">{t('invalidGrant')}</p>}

        <h3 className={css.groupTitle}>{t('interactionTitle')}</h3>
        <p className={css.groupHint}>{t('interactionHint')}</p>
        <label className={css.switch}>
          <input type="checkbox" checked={interaction.focusPolicy === 'activate'} disabled={blocked}
            onChange={(event) => { updateInteraction({ focusPolicy: event.target.checked ? 'activate' : 'preserve' }) }} />
          <span>{t('focusPolicy')}</span>
        </label>
        <p className={css.switchHint}>{t('focusPolicyHint')}</p>
        <label className={css.switch}>
          <input type="checkbox" checked={interaction.keyboardPolicy === 'activate'} disabled={blocked}
            onChange={(event) => { updateInteraction({ keyboardPolicy: event.target.checked ? 'activate' : 'preserve' }) }} />
          <span>{t('keyboardPolicy')}</span>
        </label>
        <p className={css.switchHint}>{t('keyboardPolicyHint')}</p>
        <label className={css.switch}>
          <input type="checkbox" checked={interaction.pointerInputPolicy === 'deny'} disabled={blocked}
            onChange={(event) => { updateInteraction({ pointerInputPolicy: event.target.checked ? 'deny' : 'targeted' }) }} />
          <span>{t('denyPointer')}</span>
        </label>
        <p className={css.switchHint}>{t('denyPointerHint')}</p>
        <label className={css.switch}>
          <input type="checkbox" checked={interaction.cursorVisualization === 'visible'} disabled={blocked || driverSelected}
            onChange={(event) => { updateInteraction({ cursorVisualization: event.target.checked ? 'visible' : 'hidden' }) }} />
          <span>{t('cursorVisible')}</span>
        </label>
        <p className={css.switchHint}>{t(driverSelected ? 'cursorDriverHint' : 'cursorVisibleHint')}</p>

        <h3 className={css.groupTitle}>{t('advancedTitle')}</h3>
        {NUMERIC_FIELDS.map(({ field, key, hint }) => {
          const invalid = numericInvalid(field)
          return (
            <div className={css.field} key={field}>
              <label htmlFor={`computer-use-${field}`}>{t(key)}</label>
              <Input id={`computer-use-${field}`} type="text" inputMode="numeric" value={numbers[field]} disabled={blocked}
                aria-invalid={invalid || undefined}
                onChange={(event) => { setNumberText({ ...numbers, [field]: event.target.value }) }} />
              <p className={invalid ? css.error : css.fieldHint} role={invalid ? 'alert' : 'status'}>
                {invalid ? t(field === 'observationTtlMs' ? 'invalidSeconds' : field === 'confirmationTtlMs' ? 'invalidConfirmation' : 'invalidTimeout') : t(hint)}
              </p>
            </div>
          )
        })}
        <div className={css.field}>
          <label htmlFor="computer-use-artifact-root">{t('artifactRoot')}</label>
          <Input id="computer-use-artifact-root" type="text" value={model.artifactRoot} disabled={blocked}
            aria-invalid={!artifactRootValid || undefined}
            onChange={(event) => { update({ artifactRoot: event.target.value }) }} />
          <p className={artifactRootValid ? css.fieldHint : css.error} role={artifactRootValid ? 'status' : 'alert'}>
            {artifactRootValid ? t('artifactRootHint') : t('invalidArtifactRoot')}
          </p>
        </div>

        <h3 className={css.groupTitle}>{t('osPermissionTitle')}</h3>
        <p className={css.groupHint}>{t('osPermissionHint')}</p>

        {!section.writable && <p className={css.hint} role="status">{t('readOnly')}</p>}
        <div className={css.actions}>
          <Button size="sm" variant="ghost" disabled={!dirty || saving} onClick={() => {
            setDraft(undefined)
            setNumberText(undefined)
            setNewGrant('')
          }}>{t('discard')}</Button>
          <Button size="sm" variant="primary" disabled={blocked || !dirty || !ready || saving} onClick={commit}>
            {t(saving ? 'saving' : 'save')}
          </Button>
        </div>
        {failed && <p className={css.error} role="alert">{t('failed')}</p>}
      </>}
    </section>
  )
}
