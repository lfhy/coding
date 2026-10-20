/** 会话标题生成模型设置独占普通分区内容，沿用模型分区的设置镜像与目录快照。 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import { IconChevronDownOutline14 } from 'coding-client-ui-icons'
import type { ModelsSectionInjected, ModelsSectionProps } from './ModelsSection.tsx'
import type { TitleModelMode } from './store.ts'
import { TITLE_MODEL_SETTINGS_NAMESPACE } from './store.ts'
import styles from './TitleSection.module.css'

/** 标题模型设置由 settings.section 注入，组件不直接读取 Cordis 上下文。 */
export type TitleSectionProps = ModelsSectionProps

/**
 * 显示标题生成模型模式与自定义模型选择。
 * @param props - 与模型分区共用的 store、schema 和翻译函数。
 * @returns 独立设置分区；注入尚未完成时不渲染。
 */
export function TitleSection(props: TitleSectionProps): ReactNode {
  const { controller, useSnapshot, schema, t } = props
  if (controller === undefined || useSnapshot === undefined || schema === undefined || t === undefined) return null
  return <Loaded controller={controller} useSnapshot={useSnapshot} schema={schema} t={t} />
}

function Loaded({ controller, useSnapshot, schema, t }: Pick<ModelsSectionInjected, 'controller' | 'schema' | 't'> & {
  useSnapshot: NonNullable<TitleSectionProps['useSnapshot']>
}): ReactNode {
  const state = useSnapshot(snapshot => snapshot)
  const [busy, setBusy] = useState(false)
  const [writeError, setWriteError] = useState<string | undefined>(undefined)
  // 尚未选定自定义模型时，模式先留在本地草稿里，直到用户挑出模型再一起写入。
  const [draftMode, setDraftMode] = useState<TitleModelMode | undefined>(undefined)

  if (state.status === 'idle') void controller.load()
  if (state.status === 'error') return <div className={styles.section}>
    <h1>{t('titleModelSection')}</h1>
    <p role="alert" className={styles.error}>{`${t('loadFailed')}: ${state.error ?? ''}`}</p>
    <button type="button" className={styles.retry} onClick={() => { void controller.retry() }}>{t('retry')}</button>
  </div>

  const namespace = state.namespaces.get(TITLE_MODEL_SETTINGS_NAMESPACE)
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

  return <section className={styles.section} aria-label={t('titleModelSection')}>
    <h1>{t('titleModelSection')}</h1>
    <p className={styles.description}>{t('titleModelDescription')}</p>
    {state.status === 'loading' ? <p role="status">{t('applying')}</p> : null}
    {namespace === undefined ? <p role="status">{t('titleModelUnavailable')}</p> : <>
      {!state.writable ? <p role="status">{t('readOnly')}</p> : null}
      <label className={styles.field}><span>{t('titleModelMode')}</span>
        <span className={styles.selectWrap}>
          <select className={`${styles.select} ${styles.selectInput}`} value={mode}
            disabled={!state.writable || busy || state.status === 'loading'}
            onChange={(event) => { chooseMode(event.target.value) }}>
            <option value="inherit">{t('titleModelInherit')}</option>
            <option value="custom">{t('titleModelCustom')}</option>
            <option value="off">{t('titleModelOff')}</option>
          </select>
          <span className={styles.chevron} aria-hidden="true"><IconChevronDownOutline14 size={14} /></span>
        </span>
      </label>
      {mode === 'custom' ? <label className={styles.field}><span>{t('titleModelRoute')}</span>
        <span className={styles.selectWrap}>
          <select className={`${styles.select} ${styles.selectInput}`} value={value}
            disabled={!state.writable || busy || state.status === 'loading'}
            onChange={(event) => { chooseModel(event.target.value) }}>
            <option value="">{t('titleModelUnset')}</option>
            {value !== '' && !known ? <option value={value}>{`${String(provider)}/${String(model)}`}</option> : null}
            {state.usableModels.map(choice => <option key={JSON.stringify([choice.provider, choice.model])}
              value={JSON.stringify([choice.provider, choice.model])}>{`${choice.providerName} / ${choice.modelName}`}</option>)}
          </select>
          <span className={styles.chevron} aria-hidden="true"><IconChevronDownOutline14 size={14} /></span>
        </span>
      </label> : null}
      {mode === 'custom' && state.usableModelsError === null && state.usableModels.length === 0
        ? <p role="status">{t('titleModelNoCandidates')}</p> : null}
      {state.usableModelsError !== null ? <>
        <p role="alert" className={styles.error}>{`${t('titleModelLoadFailed')}: ${state.usableModelsError}`}</p>
        <button type="button" className={styles.retry} disabled={state.status === 'loading'}
          onClick={() => { void controller.retry() }}>{t('retry')}</button>
      </> : null}
      {busy ? <p role="status">{t('applying')}</p> : null}
      {writeError === undefined ? null : <p role="alert" className={styles.error}>{writeError}</p>}
    </>}
  </section>
}
