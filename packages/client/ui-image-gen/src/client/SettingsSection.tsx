/** 设置分区：字段草稿与凭据明文只属于此组件，离开分区即丢弃。 */
import { useEffect, useRef, useState } from 'react'
import { Button, Input } from 'coding-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from 'coding-client-ui-slots'
import type { ImageSettings, ImageSettingsFace } from './settings.ts'
import { DEFAULT_KEY_REF, localEndpoint, validEndpoint, validSizeTableShape } from './settings.ts'
import { NS } from './locales.ts'
import css from './SettingsSection.module.css'

/** 由设置槽位和控制器派生的表单 props。 */
export type SettingsSectionProps = PropsRuntime<'settings.section'> & PropsLocale<typeof NS> & InjectFace<ImageSettingsFace>

/**
 * 显示配置与密钥状态；配置缺失时保持字段可写，但禁止开启生成。
 * @param props - 命名空间快照与保存操作。
 * @returns 设置分区。
 */
export function SettingsSection({ useImageSettings, save, t }: SettingsSectionProps) {
  const { section, credential, saving, failed } = useImageSettings(snapshot => snapshot)
  const [draft, setDraft] = useState<Partial<ImageSettings>>({})
  const [key, setKey] = useState('')
  const [sizeText, setSizeText] = useState<string | null>(null)
  const keyVersion = useRef(0)
  const draftVersion = useRef(0)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])
  const value = section.value
  const endpoint = draft.endpoint ?? value?.endpoint ?? ''
  const model = draft.model ?? value?.model ?? ''
  const sizes = draft.sizes ?? value?.sizes ?? {}
  const sizeValue = sizeText ?? JSON.stringify(sizes, null, 2)
  let sizeInvalid = false
  try {
    const parsed: unknown = JSON.parse(sizeValue)
    sizeInvalid = !validSizeTableShape(parsed)
  } catch { sizeInvalid = true }
  const ref = draft.apiKeyRef ?? value?.apiKeyRef ?? DEFAULT_KEY_REF
  const refPending = ref !== credential.ref
  const noAuth = ref === ''
  const local = localEndpoint(endpoint)
  const blocked = section.status !== 'ready' || !section.writable || saving
  const endpointInvalid = endpoint !== '' && !validEndpoint(endpoint)
  const modelInvalid = draft.model !== undefined && model.trim() === ''
  const noAuthInvalid = noAuth && !!endpoint && !local
  const keyWritable = !noAuth && (refPending || credential.status === 'ready' && credential.writable)
  const hasChanges = Object.keys(draft).length > 0 || !!key.trim()
  const ready = !!endpoint && !!model && !endpointInvalid && !noAuthInvalid
    && (noAuth || !refPending && credential.status === 'ready' && credential.configured
      || keyWritable && !!key.trim())
  const update = (patch: Partial<ImageSettings>) => {
    draftVersion.current++
    setDraft(old => ({ ...old, enabled: old.enabled ?? value?.enabled ?? false, ...patch }))
  }
  const field = (id: 'endpoint' | 'model', label: string, text: string, invalid: boolean, error: string) => (
    <div className={css.field}>
      <label htmlFor={`image-gen-${id}`}>{label}</label>
      <Input id={`image-gen-${id}`} type="text" value={text} disabled={blocked}
        aria-invalid={invalid || undefined} aria-describedby={invalid ? `image-gen-${id}-error` : undefined}
        onChange={(event) => { update({ [id]: event.target.value }) }} />
      {invalid && <span id={`image-gen-${id}-error`} role="alert" className={css.error}>{error}</span>}
    </div>
  )

  return <section className={css.section} aria-labelledby="image-gen-settings-title">
    <h2 id="image-gen-settings-title" className={css.title}>{t('title')}</h2>
    <p className={css.intro}>{t('intro')}</p>
    <div className={css.protocolRow}>
      <div className={css.protocolText}>
        <span className={css.protocolLabel}>{t('protocolLabel')}</span>
        <span className={css.protocolHint}>{t('protocolHint')}</span>
      </div>
      <span className={css.protocolValue}>{t('protocolValue')}</span>
    </div>
    {section.status !== 'ready' ? <p role="status" className={css.hint}>{t('unavailable')}</p> : <>
      <label className={css.switch}>
        <input type="checkbox" checked={ready && (draft.enabled ?? value?.enabled ?? false)} disabled={blocked || !ready}
          onChange={(event) => { update({ enabled: event.target.checked }) }} />
        <span>{t('enabled')}</span>
      </label>
      {field('endpoint', t('endpoint'), endpoint, endpointInvalid, t('invalidEndpoint'))}
      {field('model', t('model'), model, modelInvalid, t('invalidModel'))}
      <details className={css.sizeDetails}>
        <summary>{t('sizeSettings')}</summary>
        <div className={css.field}>
          <label htmlFor="image-gen-max-references">{t('maxReferences')}</label>
          <select id="image-gen-max-references" value={draft.maxEditReferences ?? value?.maxEditReferences ?? 1}
            disabled={blocked} onChange={(event) => { update({ maxEditReferences: Number(event.target.value) }) }}>
            {[1, 2, 3, 4, 5].map(count => <option value={count} key={count}>{count}</option>)}
          </select>
          <p className={css.fieldHint}>{t('maxReferencesHint')}</p>
        </div>
        <div className={css.field}>
          <label htmlFor="image-gen-sizes">{t('sizeTable')}</label>
          <textarea id="image-gen-sizes" value={sizeValue} disabled={blocked} aria-invalid={sizeInvalid || undefined}
            aria-describedby="image-gen-sizes-hint" onChange={(event) => {
              const text = event.target.value
              setSizeText(text)
              try {
                const parsed: unknown = JSON.parse(text)
                if (validSizeTableShape(parsed)) update({ sizes: parsed })
              } catch { /* 保留输入草稿，直到 JSON 完整。 */ }
            }} />
          <p id="image-gen-sizes-hint" className={css.fieldHint}>{t('sizeTableHint')}</p>
          {sizeInvalid && <p role="alert" className={css.error}>{t('sizeTableInvalid')}</p>}
        </div>
      </details>
      {!noAuth && <div className={css.field}>
        <label htmlFor="image-gen-key">{t('key')}</label>
        <Input id="image-gen-key" type="password" autoComplete="off" value={key} placeholder={t('keyPlaceholder')}
          disabled={blocked || !keyWritable}
          onChange={(event) => { keyVersion.current++; setKey(event.target.value) }} />
        <p role="status" className={css.fieldHint}>{refPending ? t('keyRefPending') : credential.status === 'loading'
          ? t('keyLoading') : credential.status === 'error' ? t('keyError')
            : credential.configured ? t('keyReady') : t('keyMissing')}</p>
        <p className={css.fieldHint}>{!refPending && credential.status === 'ready' && !credential.writable
          ? t('keyReadOnly') : t('keyHint')}</p>
      </div>}
      <label className={css.switch}>
        <input type="checkbox" checked={noAuth} disabled={blocked || !local && !noAuth}
          onChange={(event) => {
            keyVersion.current++
            setKey('')
            update({ apiKeyRef: event.target.checked ? '' : value?.apiKeyRef || DEFAULT_KEY_REF })
          }} />
        <span>{t('noAuth')}</span>
      </label>
      {noAuth && <p role="status" className={css.hint}>{t('noKeyNeeded')}</p>}
      {noAuthInvalid && <p role="alert" className={css.error}>{t('noAuthLocalOnly')}</p>}
      {!ready
        && <p className={css.hint} role="status">{t('inactive')}</p>}
      {!section.writable && <p className={css.hint} role="status">{t('readOnly')}</p>}
      <div className={css.actions}>
        <Button variant="primary" size="sm" disabled={blocked || !hasChanges || endpointInvalid || modelInvalid || sizeInvalid
          || noAuthInvalid || !!key.trim() && !keyWritable} onClick={() => {
          const version = draftVersion.current
          const secretVersion = keyVersion.current
          void save(draft, key).then(({ ok, keySaved }) => {
            if (mounted.current) {
              if (keySaved && secretVersion === keyVersion.current) setKey('')
              if (ok && version === draftVersion.current) { setDraft({}); setSizeText(null) }
            }
          })
        }}>{t(saving ? 'saving' : 'save')}</Button>
      </div>
      {failed && <p role="alert" className={css.error}>{t('failed')}</p>}
    </>}
  </section>
}
