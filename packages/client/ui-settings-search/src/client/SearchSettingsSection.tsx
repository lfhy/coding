/** 搜索设置只保存非机密草稿；密钥文本停留在组件私有状态。 */
import { useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { DeepSeekSearchSettings, SearchSettingsFace } from './controller.ts'
import { DEFAULT_KEY_REF, validField } from './controller.ts'
import css from './SearchSettingsSection.module.css'

export type SearchSettingsSectionProps = PropsRuntime<'settings.section'>
  & PropsLocale<'settings.search'> & InjectFace<SearchSettingsFace>

/**
 * 呈现免费与官方搜索选择、提供方参数和独立密钥写入。
 * @param props - renderer 绑定的设置观察与提交回调。
 * @returns 搜索设置内容。
 */
export function SearchSettingsSection(props: SearchSettingsSectionProps) {
  const { t } = props
  const state = props.useSearchSettings(snapshot => snapshot)
  const [draft, setDraft] = useState<Partial<DeepSeekSearchSettings>>({})
  const [key, setKey] = useState('')
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])
  const { web, deepSeek, credential } = state
  const values = deepSeek.value
  const keyRefPending = draft.apiKeyEnv !== undefined
    && (draft.apiKeyEnv.trim() || DEFAULT_KEY_REF) !== (values?.apiKeyEnv ?? DEFAULT_KEY_REF)
  useEffect(() => { setKey('') }, [credential.ref])
  const valueOf = (field: keyof DeepSeekSearchSettings) => draft[field] ?? values?.[field] ?? ''
  const invalid = (field: keyof DeepSeekSearchSettings) => !validField(field, valueOf(field))
  const dirty = Object.keys(draft).length > 0
  const disabled = deepSeek.status !== 'ready' || !deepSeek.writable || state.saving

  const field = (name: keyof DeepSeekSearchSettings, label: string, hint: string, error: string) => (
    <div className={css.field}>
      <div className={css.fieldHeading}>
        <label htmlFor={`search-${name}`}>{label}</label>
        {Object.hasOwn(deepSeek.user ?? {}, name) || Object.hasOwn(draft, name)
          ? <button type="button" className={css.link} disabled={disabled} onClick={() => { setDraft(old => ({ ...old, [name]: '' })) }}>{t('reset')}</button>
          : null}
      </div>
      <input
        id={`search-${name}`} type="text" className={css.input} value={valueOf(name)}
        disabled={disabled} aria-invalid={invalid(name) || undefined}
        aria-describedby={`search-${name}-hint`}
        onChange={(event) => { setDraft(old => ({ ...old, [name]: event.target.value })) }}
      />
      <p id={`search-${name}-hint`} className={invalid(name) ? css.error : css.hint}>{invalid(name) ? error : hint}</p>
    </div>
  )

  return (
    <section className={css.section} aria-labelledby="search-heading">
      <h2 id="search-heading" className={css.title}>{t('title')}</h2>
      <p className={css.intro}>{t('intro')}</p>
      {web.status === 'unavailable' ? <p role="status">{t('unavailable')}</p> : null}
      {web.status === 'ready' ? (
        <fieldset className={css.sources} disabled={!web.writable || state.saving}>
          <legend className={css.subheading}>{t('provider')}</legend>
          <label className={css.source}>
            <input type="radio" name="search-provider" checked={web.value?.searchProvider === 'duckduckgo'} onChange={() => { void props.chooseProvider('duckduckgo') }} />
            <span><strong>{t('duckduckgo')}</strong><small>{t('duckduckgoHint')}</small></span>
          </label>
          <label className={css.source}>
            <input type="radio" name="search-provider" checked={web.value?.searchProvider === 'deepseek-official'} onChange={() => { void props.chooseProvider('deepseek-official') }} />
            <span><strong>{t('deepseek')}</strong><small>{t('deepseekHint')}</small></span>
          </label>
        </fieldset>
      ) : null}
      {deepSeek.status === 'ready' ? (
        <div className={css.configuration}>
          <h3 className={css.subheading}>{t('deepseek')}</h3>
          {field('baseURL', t('endpoint'), t('endpointHint'), t('invalidEndpoint'))}
          {field('model', t('model'), t('modelHint'), t('invalidModel'))}
          {field('apiKeyEnv', t('keyRef'), t('keyRefHint'), t('invalidRef'))}
          {!deepSeek.writable ? <p role="status" className={css.hint}>{t('readOnly')}</p> : null}
          <div className={css.actions}>
            <button type="button" disabled={!dirty || disabled || invalid('baseURL') || invalid('model') || invalid('apiKeyEnv')}
              onClick={() => {
                const fields = { baseURL: valueOf('baseURL'), model: valueOf('model'), apiKeyEnv: valueOf('apiKeyEnv') }
                void props.saveFields(fields).then((ok) => { if (ok && mounted.current) setDraft({}) })
              }}>
              {t(state.saving ? 'saving' : 'save')}
            </button>
          </div>
          {state.failed ? <p role="alert" className={css.error}>{t('failed')}</p> : null}
          <div className={css.secret}>
            <div className={css.fieldHeading}><label htmlFor="search-api-key">{t('apiKey')}</label></div>
            <p className={css.hint} role="status">{keyRefPending ? t('keyRefPending') : credential.status === 'loading' ? t('keyLoading') : credential.status === 'error' ? t('keyError') : credential.configured ? t('keySet') : t('keyMissing')}</p>
            <input id="search-api-key" className={css.input} type="password" autoComplete="off"
              value={key} disabled={keyRefPending || credential.status !== 'ready' || !credential.writable || state.keySaving}
              onChange={(event) => { setKey(event.target.value) }} aria-describedby="search-api-key-hint" />
            <p id="search-api-key-hint" className={css.hint}>{credential.status === 'ready' && !credential.writable ? t('keyReadOnly') : t('apiKeyHint')}</p>
            <div className={css.actions}>
              <button type="button" disabled={!key.trim() || keyRefPending || credential.status !== 'ready' || !credential.writable || state.keySaving}
                onClick={() => { void props.saveKey(key).then((ok) => { if (ok && mounted.current) setKey('') }) }}>
                {t(state.keySaving ? 'saving' : 'saveKey')}
              </button>
            </div>
            {state.keyFailed ? <p role="alert" className={css.error}>{t('keyFailed')}</p> : null}
          </div>
        </div>
      ) : null}
    </section>
  )
}
