/** 搜索设置只保存非机密草稿；密钥文本停留在组件私有状态。 */
import { useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SearchProvider, SearchSettingsFace } from './controller.ts'
import { DEFAULT_KEY_REF, DEFAULT_TAVILY_KEY_REF, validField } from './controller.ts'
import css from './SearchSettingsSection.module.css'

export type SearchSettingsSectionProps = PropsRuntime<'settings.section'>
  & PropsLocale<'settings.search'> & InjectFace<SearchSettingsFace>

/**
 * 呈现三种搜索来源、各自参数和独立密钥写入。
 * @param props - renderer 绑定的设置观察与提交回调。
 * @returns 搜索设置内容。
 */
export function SearchSettingsSection(props: SearchSettingsSectionProps) {
  const { t } = props
  const state = props.useSearchSettings(snapshot => snapshot)
  const [drafts, setDrafts] = useState<Record<SearchProvider, Record<string, string>>>(() => ({
    duckduckgo: {}, 'deepseek-official': {}, tavily: {},
  }))
  const [keyDraft, setKeyDraft] = useState({ owner: '', value: '' })
  const fieldVersion = useRef<Record<SearchProvider, number>>({ duckduckgo: 0, 'deepseek-official': 0, tavily: 0 })
  const keyVersion = useRef(0)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])
  const { web, credential } = state
  const provider = web.value?.searchProvider ?? 'duckduckgo'
  const keyOwner = `${provider}:${credential.ref}`
  const key = keyDraft.owner === keyOwner ? keyDraft.value : ''
  const scope = provider === 'tavily' ? state.tavily : provider === 'deepseek-official' ? state.deepSeek : state.duckDuckGo
  const values = scope.value as Record<string, string | undefined> | undefined
  const draft = drafts[provider]
  const defaultRef = provider === 'tavily' ? DEFAULT_TAVILY_KEY_REF : DEFAULT_KEY_REF
  const keyRefPending = provider !== 'duckduckgo' && draft.apiKeyEnv !== undefined
    && (draft.apiKeyEnv.trim() || defaultRef) !== (values?.apiKeyEnv ?? defaultRef)
  useEffect(() => { keyVersion.current++; setKeyDraft({ owner: '', value: '' }) }, [provider, credential.ref])
  const valueOf = (field: 'baseURL' | 'proxyURL' | 'model' | 'apiKeyEnv') => draft[field] ?? values?.[field] ?? ''
  const invalid = (field: 'baseURL' | 'proxyURL' | 'model' | 'apiKeyEnv') => !validField(field, valueOf(field), provider)
  const dirty = Object.keys(draft).length > 0
  const disabled = scope.status !== 'ready' || !scope.writable || state.saving

  const editField = (name: string, value: string) => {
    fieldVersion.current[provider]++
    setDrafts(old => ({ ...old, [provider]: { ...old[provider], [name]: value } }))
  }
  const field = (name: 'baseURL' | 'proxyURL' | 'model' | 'apiKeyEnv', label: string, hint: string, error: string) => (
    <div className={css.field}>
      <div className={css.fieldHeading}>
        <label htmlFor={`search-${provider}-${name}`}>{label}</label>
        {Object.hasOwn(scope.user ?? {}, name) || Object.hasOwn(draft, name)
          ? <button type="button" className={css.link} disabled={disabled} onClick={() => { editField(name, '') }}>{t('reset')}</button>
          : null}
      </div>
      <input
        id={`search-${provider}-${name}`} type="text" className={css.input} value={valueOf(name)}
        disabled={disabled} aria-invalid={invalid(name) || undefined}
        aria-describedby={`search-${provider}-${name}-hint`}
        onChange={(event) => { editField(name, event.target.value) }}
      />
      <p id={`search-${provider}-${name}-hint`} className={invalid(name) ? css.error : css.hint}>{invalid(name) ? error : hint}</p>
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
          <label className={css.source}>
            <input type="radio" name="search-provider" checked={web.value?.searchProvider === 'tavily'} onChange={() => { void props.chooseProvider('tavily') }} />
            <span><strong>{t('tavily')}</strong><small>{t('tavilyHint')}</small></span>
          </label>
        </fieldset>
      ) : null}
      {web.status === 'ready' && scope.status === 'ready' ? (
        <div className={css.configuration}>
          <h3 className={css.subheading}>{t(provider === 'tavily' ? 'tavily' : provider === 'deepseek-official' ? 'deepseek' : 'duckduckgo')}</h3>
          {provider !== 'duckduckgo' ? field('baseURL', t('endpoint'), t(provider === 'tavily' ? 'tavilyEndpointHint' : 'endpointHint'), t('invalidEndpoint')) : null}
          {provider === 'deepseek-official' ? field('model', t('model'), t('modelHint'), t('invalidModel')) : null}
          {field('proxyURL', t('proxy'), t('proxyHint'), t('invalidProxy'))}
          {provider !== 'duckduckgo' ? field('apiKeyEnv', t('keyRef'), t(provider === 'tavily' ? 'tavilyKeyRefHint' : 'keyRefHint'), t('invalidRef')) : null}
          {!scope.writable ? <p role="status" className={css.hint}>{t('readOnly')}</p> : null}
          <div className={css.actions}>
            <button type="button" disabled={!dirty || disabled || invalid('proxyURL') || (provider !== 'duckduckgo' && (invalid('baseURL') || invalid('apiKeyEnv'))) || (provider === 'deepseek-official' && invalid('model'))}
              onClick={() => {
                const fields = provider === 'duckduckgo' ? { proxyURL: valueOf('proxyURL') }
                  : provider === 'tavily' ? { baseURL: valueOf('baseURL'), proxyURL: valueOf('proxyURL'), apiKeyEnv: valueOf('apiKeyEnv') }
                    : { baseURL: valueOf('baseURL'), proxyURL: valueOf('proxyURL'), model: valueOf('model'), apiKeyEnv: valueOf('apiKeyEnv') }
                const revision = fieldVersion.current[provider]
                void props.saveFields(provider, fields).then((ok) => {
                  if (ok && mounted.current && fieldVersion.current[provider] === revision) {
                    setDrafts(old => ({ ...old, [provider]: {} }))
                  }
                })
              }}>
              {t(state.saving ? 'saving' : 'save')}
            </button>
          </div>
          {state.failed ? <p role="alert" className={css.error}>{t('failed')}</p> : null}
          {provider !== 'duckduckgo' ? <div className={css.secret}>
            <div className={css.fieldHeading}><label htmlFor="search-api-key">{t('apiKey')}</label></div>
            <p className={css.hint} role="status">{keyRefPending ? t('keyRefPending') : credential.status === 'loading' ? t('keyLoading') : credential.status === 'error' ? t('keyError') : credential.configured ? t('keySet') : t(provider === 'tavily' ? 'tavilyKeyMissing' : 'keyMissing')}</p>
            <input id="search-api-key" className={css.input} type="password" autoComplete="off"
              value={key} disabled={keyRefPending || credential.status !== 'ready' || !credential.writable || state.keySaving}
              onChange={(event) => { keyVersion.current++; setKeyDraft({ owner: keyOwner, value: event.target.value }) }} aria-describedby="search-api-key-hint" />
            <p id="search-api-key-hint" className={css.hint}>{credential.status === 'ready' && !credential.writable ? t('keyReadOnly') : t('apiKeyHint')}</p>
            <div className={css.actions}>
              <button type="button" disabled={!key.trim() || keyRefPending || credential.status !== 'ready' || !credential.writable || state.keySaving}
                onClick={() => {
                  const revision = keyVersion.current
                  void props.saveKey(key).then((ok) => { if (ok && mounted.current && keyVersion.current === revision) setKeyDraft({ owner: '', value: '' }) })
                }}>
                {t(state.keySaving ? 'saving' : 'saveKey')}
              </button>
            </div>
            {state.keyFailed ? <p role="alert" className={css.error}>{t('keyFailed')}</p> : null}
          </div> : null}
        </div>
      ) : null}
    </section>
  )
}
