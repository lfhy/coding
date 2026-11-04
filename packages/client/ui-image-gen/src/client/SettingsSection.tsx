/** 设置分区：字段草稿与凭据明文只属于此组件，离开分区即丢弃。 */
import { useEffect, useRef, useState } from 'react'
import { Button, Input } from 'coding-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from 'coding-client-ui-slots'
import type { ImageSettings, ImageSettingsFace } from './settings.ts'
import { DEFAULT_KEY_REF, validEndpoint, validKeyRef } from './settings.ts'
import { NS } from './locales.ts'
import css from './SettingsSection.module.css'

/** 由设置槽位和控制器派生的表单 props。 */
export type SettingsSectionProps = PropsRuntime<'settings.section'> & PropsLocale<typeof NS> & InjectFace<ImageSettingsFace>

/**
 * 显示配置与密钥状态；配置缺失时保持字段可写，但禁止开启生成。
 * @param props - 命名空间快照与保存操作。
 * @returns 设置分区。
 */
export function SettingsSection({ useImageSettings, save, saveKey, t }: SettingsSectionProps) {
  const { section, credential, saving, failed, keySaving, keyFailed } = useImageSettings(snapshot => snapshot)
  const [draft, setDraft] = useState<Partial<ImageSettings>>({})
  const [key, setKey] = useState('')
  const keyVersion = useRef(0)
  const draftVersion = useRef(0)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])
  const value = section.value
  const endpoint = draft.endpoint ?? value?.endpoint ?? ''
  const model = draft.model ?? value?.model ?? ''
  const ref = draft.apiKeyRef ?? value?.apiKeyRef ?? DEFAULT_KEY_REF
  const refPending = ref !== credential.ref
  const blocked = section.status !== 'ready' || !section.writable || saving
  const endpointInvalid = endpoint !== '' && !validEndpoint(endpoint)
  const modelInvalid = draft.model !== undefined && model.trim() === ''
  const refInvalid = ref !== '' && !validKeyRef(ref)
  const ready = !!endpoint && !!model && !endpointInvalid && !refInvalid && !refPending
    && (ref === '' || credential.status === 'ready' && credential.configured)
  const update = (patch: Partial<ImageSettings>) => {
    draftVersion.current++
    setDraft(old => ({ ...old, ...patch }))
  }
  const field = (id: 'endpoint' | 'model' | 'apiKeyRef', label: string, text: string, invalid: boolean, error: string) => (
    <div className={css.field}>
      <label htmlFor={`image-gen-${id}`}>{label}</label>
      <Input id={`image-gen-${id}`} type="text" value={text} disabled={blocked}
        aria-invalid={invalid || undefined} aria-describedby={invalid ? `image-gen-${id}-error` : undefined}
        onChange={(event) => { update({ [id]: event.target.value }) }} />
      {invalid && <span id={`image-gen-${id}-error`} role="alert" className={css.error}>{error}</span>}
    </div>
  )

  return <section className={css.section} aria-labelledby="image-gen-settings-title">
    <h2 id="image-gen-settings-title">{t('title')}</h2>
    <p className={css.hint}>{t('intro')}</p>
    {section.status !== 'ready' ? <p role="status" className={css.hint}>{t('unavailable')}</p> : <>
      <label className={css.switch}>
        <input type="checkbox" checked={ready && (draft.enabled ?? value?.enabled ?? false)} disabled={blocked || !ready}
          onChange={(event) => { update({ enabled: event.target.checked }) }} />
        <span>{t('enabled')}</span>
      </label>
      {field('endpoint', t('endpoint'), endpoint, endpointInvalid, t('invalidEndpoint'))}
      {field('model', t('model'), model, modelInvalid, t('invalidModel'))}
      {field('apiKeyRef', t('keyRef'), ref, refInvalid, t('invalidRef'))}
      {!ready
        && <p className={css.hint} role="status">{t('inactive')}</p>}
      {!section.writable && <p className={css.hint} role="status">{t('readOnly')}</p>}
      <div className={css.actions}>
        <Button variant="primary" size="sm" disabled={blocked || Object.keys(draft).length === 0
          || endpointInvalid || modelInvalid || refInvalid} onClick={() => {
          const version = draftVersion.current
          void save(draft).then((ok) => {
            if (ok && mounted.current && version === draftVersion.current) setDraft({})
          })
        }}>{t(saving ? 'saving' : 'save')}</Button>
      </div>
      {failed && <p role="alert" className={css.error}>{t('failed')}</p>}
      <div className={css.credential}>
        {ref === '' ? <p role="status" className={css.hint}>{t('noKeyNeeded')}</p> : <>
          <label htmlFor="image-gen-key">{t('key')}</label>
          <p role="status" className={css.hint}>{refPending ? t('keyRefPending') : credential.status === 'loading'
            ? t('keyLoading') : credential.status === 'error' ? t('keyError')
              : credential.configured ? t('keyReady') : t('keyMissing')}</p>
          <Input id="image-gen-key" type="password" autoComplete="off" value={key}
            disabled={refPending || credential.status !== 'ready' || !credential.writable || keySaving}
            onChange={(event) => { keyVersion.current++; setKey(event.target.value) }} />
          <p className={css.hint}>{credential.status === 'ready' && !credential.writable ? t('keyReadOnly') : t('keyHint')}</p>
          <div className={css.actions}>
            <Button variant="primary" size="sm" disabled={!key.trim() || refPending || credential.status !== 'ready'
            || !credential.writable || keySaving} onClick={() => {
              const version = keyVersion.current
              void saveKey(key).then((ok) => { if (ok && mounted.current && version === keyVersion.current) setKey('') })
            }}>{t(keySaving ? 'saving' : 'saveKey')}</Button>
          </div>
          {keyFailed && <p role="alert" className={css.error}>{t('failed')}</p>}
        </>}
      </div>
    </>}
  </section>
}
