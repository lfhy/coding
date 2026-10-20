/** 通用设置中的会话标题生成模型行：模式三选一，自定义模式附带模型选择。 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import { IconChevronDownOutline14 } from 'coding-client-ui-icons'
import type { InjectFace, PropsLocale, PropsRuntime } from 'coding-client-ui-slots'
import type { ModelsSectionInjected } from './ModelsSection.tsx'
import type { TitleModelMode } from './store.ts'
import css from './TitleRow.module.css'

/** 标题模型行由 settings.general.item 注入，组件不直接读取 Cordis 上下文。 */
export type TitleRowProps = PropsRuntime<'settings.general.item'>
  & PropsLocale<'settings.models'> & Partial<InjectFace<ModelsSectionInjected>>

/**
 * 显示标题生成模型模式与自定义模型选择。
 * @param props - 与模型分区共用的 store、schema 和翻译函数。
 * @returns 通用设置行；注入尚未完成时不渲染。
 */
export function TitleRow(props: TitleRowProps): ReactNode {
  const { controller, useSnapshot, schema } = props
  // t 来自框架 locale 座位而非 inject face，单独判空以守注入未完成的分支。
  const t = props.t as TitleRowProps['t'] | undefined
  if (controller === undefined || useSnapshot === undefined || schema === undefined || t === undefined) return null
  return <Loaded controller={controller} useSnapshot={useSnapshot} schema={schema} t={t} />
}

function Loaded({ controller, useSnapshot, schema, t }: Required<Pick<ModelsSectionInjected, 'controller' | 'schema' | 't'>> & {
  useSnapshot: NonNullable<TitleRowProps['useSnapshot']>
}): ReactNode {
  const state = useSnapshot(snapshot => snapshot)
  const [busy, setBusy] = useState(false)
  const [writeError, setWriteError] = useState<string | undefined>(undefined)
  // 尚未选定自定义模型时，模式先留在本地草稿里，直到用户挑出模型再一起写入。
  const [draftMode, setDraftMode] = useState<TitleModelMode | undefined>(undefined)

  if (state.status === 'idle') void controller.load()
  if (state.status === 'error') return <div className={css.row}>
    <div className={css.rowText}>
      <div className={css.title}>{t('titleModelSection')}</div>
      <p role="alert" className={css.desc}>{`${t('loadFailed')}: ${state.error ?? ''}`}</p>
      <button type="button" className={css.retry} onClick={() => { void controller.retry() }}>{t('retry')}</button>
    </div>
  </div>

  const namespace = state.namespaces.get('session-title')
  const storedMode = namespace === undefined ? undefined : schema.getPath(namespace.value, ['mode'])
  const mode: TitleModelMode = draftMode
    ?? (storedMode === 'custom' || storedMode === 'off' ? storedMode : 'inherit')
  const provider = namespace === undefined ? undefined : schema.getPath(namespace.value, ['provider'])
  const model = namespace === undefined ? undefined : schema.getPath(namespace.value, ['model'])
  const route = typeof provider === 'string' && typeof model === 'string' ? { provider, model } : undefined
  const value = route === undefined ? '' : JSON.stringify([route.provider, route.model])
  const known = state.usableModels.some(choice => JSON.stringify([choice.provider, choice.model]) === value)

  const write = (next: TitleModelMode, target?: { provider: string; model: string }): void => {
    setBusy(true)
    setWriteError(undefined)
    void controller.setTitleModel(next, target)
      .then((error) => {
        if (error !== undefined) {
          setWriteError(error)
          return
        }
        setDraftMode(undefined)
      })
      .finally(() => { setBusy(false) })
  }

  const chooseMode = (next: string): void => {
    if (next === 'custom') {
      // 已有可用路由时直接落盘；没有就先展开模型选择，等用户挑出模型。
      if (route !== undefined) {
        write('custom', route)
        return
      }
      setDraftMode('custom')
      return
    }
    if (next !== 'inherit' && next !== 'off') return
    write(next)
  }

  const chooseModel = (next: string): void => {
    const choice = state.usableModels.find(item => JSON.stringify([item.provider, item.model]) === next)
    if (choice === undefined) return
    write('custom', { provider: choice.provider, model: choice.model })
  }

  const disabled = !state.writable || busy || state.status === 'loading'

  return <div className={css.row}>
    <div className={css.rowText}>
      <div className={css.title}>{t('titleModelSection')}</div>
      <div className={css.desc}>{t('titleModelDescription')}</div>
      {state.status === 'loading' ? <p role="status" className={css.desc}>{t('applying')}</p> : null}
      {state.usableModelsError !== null ? <>
        <p role="alert" className={css.desc}>{`${t('titleModelLoadFailed')}: ${state.usableModelsError}`}</p>
        <button type="button" className={css.retry} disabled={state.status === 'loading'}
          onClick={() => { void controller.retry() }}>{t('retry')}</button>
      </> : null}
      {writeError === undefined ? null : <p role="alert" className={css.desc}>{writeError}</p>}
    </div>
    {namespace === undefined
      ? <p role="status" className={css.unavailable}>{t('titleModelUnavailable')}</p> : (
        <div className={css.controls}>
          {!state.writable ? <p role="status" className={css.desc}>{t('readOnly')}</p> : null}
          <label className={css.field}>
            <span className={css.hiddenLabel}>{t('titleModelMode')}</span>
            <span className={css.selectWrap}>
              <select className={`${css.select} ${css.selectInput}`} value={mode} disabled={disabled}
                onChange={(event) => { chooseMode(event.target.value) }}>
                <option value="inherit">{t('titleModelInherit')}</option>
                <option value="custom">{t('titleModelCustom')}</option>
                <option value="off">{t('titleModelOff')}</option>
              </select>
              <span className={css.chevron} aria-hidden="true"><IconChevronDownOutline14 size={14} /></span>
            </span>
          </label>
          {mode === 'custom' ? <label className={css.field}>
            <span className={css.hiddenLabel}>{t('titleModelRoute')}</span>
            <span className={css.selectWrap}>
              <select className={`${css.select} ${css.selectInput}`} value={value} disabled={disabled}
                onChange={(event) => { chooseModel(event.target.value) }}>
                <option value="">{t('titleModelUnset')}</option>
                {value !== '' && !known ? <option value={value}>{`${String(provider)}/${String(model)}`}</option> : null}
                {state.usableModels.map(choice => <option key={JSON.stringify([choice.provider, choice.model])}
                  value={JSON.stringify([choice.provider, choice.model])}>{`${choice.providerName} / ${choice.modelName}`}</option>)}
              </select>
              <span className={css.chevron} aria-hidden="true"><IconChevronDownOutline14 size={14} /></span>
            </span>
          </label> : null}
          {mode === 'custom' && state.usableModelsError === null && state.usableModels.length === 0
            ? <p role="status" className={css.desc}>{t('titleModelNoCandidates')}</p> : null}
        </div>
      )}
  </div>
}
