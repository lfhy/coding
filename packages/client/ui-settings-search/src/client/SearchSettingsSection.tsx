/** 搜索设置只保存非机密草稿；密钥文本停留在组件私有状态。 */
import { useEffect, useRef, useState } from 'react'
import { IconChevronDownOutline14, Menu, OutboundSelect } from 'coding-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from 'coding-client-ui-slots'
import type { OutboundSettings, SearchProvider, SearchSettingsFace } from './controller.ts'
import { DEFAULT_KEY_REF, DEFAULT_TAVILY_KEY_REF, validField, validOutbound } from './controller.ts'
import css from './SearchSettingsSection.module.css'

export type SearchSettingsSectionProps = PropsRuntime<'settings.section'>
  & PropsLocale<'settings.search'> & InjectFace<SearchSettingsFace>

/** 设置页列出的搜索来源；徽标区分免费与需要密钥。 */
const PROVIDERS: readonly { id: SearchProvider; badge: 'free' | 'key' }[] = [
  { id: 'duckduckgo', badge: 'free' },
  { id: 'bing', badge: 'free' },
  { id: 'deepseek-official', badge: 'key' },
  { id: 'tavily', badge: 'key' },
]

/** 未保存草稿：文本字段与出站选择分开存，出站整体替换。 */
type Draft = { text: Record<string, string>; outbound?: OutboundSettings }

/**
 * 呈现四种搜索来源、各自参数、出站选择与独立密钥写入。
 * @param props - renderer 绑定的设置观察与提交回调。
 * @returns 搜索设置内容。
 */
export function SearchSettingsSection(props: SearchSettingsSectionProps) {
  const { t } = props
  const state = props.useSearchSettings(snapshot => snapshot)
  const [drafts, setDrafts] = useState<Partial<Record<SearchProvider, Draft>>>({})
  const [keyDraft, setKeyDraft] = useState({ owner: '', value: '' })
  const [menuOpen, setMenuOpen] = useState(false)
  const fieldVersion = useRef(0)
  const keyVersion = useRef(0)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])
  const { web, credential } = state
  const provider = web.value?.searchProvider ?? 'duckduckgo'
  const keyOwner = `${provider}:${credential.ref}`
  const key = keyDraft.owner === keyOwner ? keyDraft.value : ''
  const scope = provider === 'tavily'
    ? state.tavily
    : provider === 'deepseek-official' ? state.deepSeek : provider === 'bing' ? state.bing : state.duckDuckGo
  const values = scope.value as Record<string, unknown> | undefined
  const draft = drafts[provider] ?? { text: {} }
  const defaultRef = provider === 'tavily' ? DEFAULT_TAVILY_KEY_REF : DEFAULT_KEY_REF
  const keyRefPending = provider !== 'duckduckgo' && provider !== 'bing' && draft.text['apiKeyEnv'] !== undefined
    && (draft.text['apiKeyEnv'].trim() || defaultRef) !== ((values?.['apiKeyEnv'] as string | undefined) ?? defaultRef)
  useEffect(() => { keyVersion.current++; setKeyDraft({ owner: '', value: '' }) }, [provider, credential.ref])
  const valueOf = (field: string) => draft.text[field] ?? (typeof values?.[field] === 'string' ? values[field] : '')
  const outbound: OutboundSettings = draft.outbound
    ?? (typeof values?.['outbound'] === 'object' && values['outbound'] !== null
      ? values['outbound'] as OutboundSettings
      : { mode: 'direct' })
  const invalid = (field: 'baseURL' | 'model' | 'apiKeyEnv') => !validField(field, valueOf(field), provider)
  const outboundInvalid = !validOutbound(outbound)
  const dirty = Object.keys(draft.text).length > 0 || draft.outbound !== undefined
  const disabled = scope.status !== 'ready' || !scope.writable || state.saving

  const editField = (name: string, value: string): void => {
    fieldVersion.current++
    setDrafts((old) => {
      const previous = old[provider]
      const text = { ...previous?.text, [name]: value }
      return { ...old, [provider]: previous?.outbound === undefined ? { text } : { text, outbound: previous.outbound } }
    })
  }
  const editOutbound = (next: OutboundSettings): void => {
    fieldVersion.current++
    setDrafts(old => ({ ...old, [provider]: { text: { ...old[provider]?.text }, outbound: next } }))
  }
  const field = (name: 'baseURL' | 'model' | 'apiKeyEnv' | 'market', label: string, hint: string, error: string) => (
    <div className={css.field}>
      <div className={css.fieldHeading}>
        <label htmlFor={`search-${provider}-${name}`}>{label}</label>
        {Object.hasOwn(scope.user ?? {}, name) || Object.hasOwn(draft.text, name)
          ? <button type="button" className={css.link} disabled={disabled} onClick={() => { editField(name, '') }}>{t('reset')}</button>
          : null}
      </div>
      <input
        id={`search-${provider}-${name}`} type="text" className={css.input} value={valueOf(name)}
        disabled={disabled} aria-invalid={(name !== 'market' && invalid(name)) || undefined}
        aria-describedby={`search-${provider}-${name}-hint`}
        onChange={(event) => { editField(name, event.target.value) }}
      />
      <p id={`search-${provider}-${name}-hint`} className={name !== 'market' && invalid(name) ? css.error : css.hint}>
        {name !== 'market' && invalid(name) ? error : hint}
      </p>
    </div>
  )

  return (
    <section className={css.section} aria-labelledby="search-heading">
      <h2 id="search-heading" className={css.title}>{t('title')}</h2>
      <p className={css.intro}>{t('intro')}</p>
      {web.status === 'unavailable' ? <p role="status">{t('unavailable')}</p> : null}
      {web.status === 'ready' ? (
        <div className={css.selectorRow}>
          <div className={css.selectorText}>
            <div className={css.selectorTitle}>{t('provider')}</div>
            <div className={css.selectorDesc}>{t('providerHint')}</div>
          </div>
          {/* 与「Agent 预设」同一套切换方式：一个当前值胶囊配下拉菜单，而不是整列单选块。 */}
          <Menu
            open={menuOpen}
            onClose={() => { setMenuOpen(false) }}
            selectedId={provider}
            align="end"
            portal
            items={PROVIDERS.map(entry => ({
              id: entry.id,
              label: `${t(entry.id === 'deepseek-official' ? 'deepseek' : entry.id)} · ${t(entry.badge === 'free' ? 'badgeFree' : 'badgeKey')}`,
            }))}
            onSelect={(id) => {
              setMenuOpen(false)
              void props.chooseProvider(id as SearchProvider)
            }}
            anchor={(
              <button type="button" className={css.selector} aria-haspopup="menu" aria-expanded={menuOpen}
                disabled={!web.writable || state.saving} onClick={() => { setMenuOpen(!menuOpen) }}>
                {t(provider === 'deepseek-official' ? 'deepseek' : provider)}
                <IconChevronDownOutline14 className={css.chevron} />
              </button>
            )}
          />
        </div>
      ) : null}
      {web.status === 'ready' && scope.status === 'ready' ? (
        <div className={css.configuration}>
          <h3 className={css.subheading}>{t(provider === 'deepseek-official' ? 'deepseek' : provider)}</h3>
          {provider === 'deepseek-official' ? field('baseURL', t('endpoint'), t('endpointHint'), t('invalidEndpoint')) : null}
          {provider === 'tavily' ? field('baseURL', t('endpoint'), t('tavilyEndpointHint'), t('invalidEndpoint')) : null}
          {provider === 'deepseek-official' ? field('model', t('model'), t('modelHint'), t('invalidModel')) : null}
          {provider === 'bing' ? field('market', t('market'), t('marketHint'), '') : null}
          <div className={css.field}>
            <span className={css.fieldHeading}>{t('outbound')}</span>
            <OutboundSelect
              value={outbound}
              disabled={disabled}
              invalid={outboundInvalid}
              urlPlaceholder="http://proxy.example:8080"
              labels={{
                group: t('outbound'), direct: t('outboundDirect'),
                pool: t('outboundPool'), custom: t('outboundCustom'), url: t('outboundUrl'),
              }}
              onChange={editOutbound}
              onCustomUrlChange={(customUrl) => { editOutbound({ mode: 'custom', customUrl }) }}
            />
            <p className={outboundInvalid ? css.error : css.hint}>
              {outboundInvalid ? t('invalidProxy') : t('outboundHint')}
            </p>
          </div>
          {provider !== 'duckduckgo' && provider !== 'bing'
            ? field('apiKeyEnv', t('keyRef'), t(provider === 'tavily' ? 'tavilyKeyRefHint' : 'keyRefHint'), t('invalidRef'))
            : null}
          {!scope.writable ? <p role="status" className={css.hint}>{t('readOnly')}</p> : null}
          <div className={css.actions}>
            <button type="button" disabled={!dirty || disabled || outboundInvalid
              || (provider !== 'duckduckgo' && provider !== 'bing'
                && (invalid('baseURL') || invalid('apiKeyEnv') || (provider === 'deepseek-official' && invalid('model'))))}
            onClick={() => {
              const fields: Record<string, string | OutboundSettings> = { outbound }
              if (provider === 'bing') fields['market'] = valueOf('market')
              if (provider === 'tavily') Object.assign(fields, { baseURL: valueOf('baseURL'), apiKeyEnv: valueOf('apiKeyEnv') })
              if (provider === 'deepseek-official') {
                Object.assign(fields, { baseURL: valueOf('baseURL'), model: valueOf('model'), apiKeyEnv: valueOf('apiKeyEnv') })
              }
              const revision = fieldVersion.current
              void props.saveFields(provider, fields).then((ok) => {
                if (ok && mounted.current && fieldVersion.current === revision) {
                  setDrafts(old => ({ ...old, [provider]: { text: {} } }))
                }
              })
            }}>
              {t(state.saving ? 'saving' : 'save')}
            </button>
          </div>
          {state.failed ? <p role="alert" className={css.error}>{t('failed')}</p> : null}
          {provider !== 'duckduckgo' && provider !== 'bing' ? <div className={css.secret}>
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
