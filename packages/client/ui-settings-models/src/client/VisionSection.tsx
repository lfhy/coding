/** 图片识别目标设置独占普通分区内容，沿用模型分区的设置镜像与目录快照。 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-icons'
import type { ModelsSectionInjected, ModelsSectionProps } from './ModelsSection.tsx'
import styles from './VisionSection.module.css'

/** 图片识别设置由 settings.section 注入，组件不直接读取 Cordis 上下文。 */
export type VisionSectionProps = ModelsSectionProps

/**
 * 显示图片识别目标及目录诊断。
 * @param props - 与模型分区共用的 store、schema 和翻译函数。
 * @returns 独立设置分区；注入尚未完成时不渲染。
 */
export function VisionSection(props: VisionSectionProps): ReactNode {
  const { controller, useSnapshot, schema, t } = props
  if (controller === undefined || useSnapshot === undefined || schema === undefined || t === undefined) return null
  return <Loaded controller={controller} useSnapshot={useSnapshot} schema={schema} t={t} />
}

function Loaded({ controller, useSnapshot, schema, t }: Pick<ModelsSectionInjected, 'controller' | 'schema' | 't'> & {
  useSnapshot: NonNullable<VisionSectionProps['useSnapshot']>
}): ReactNode {
  const state = useSnapshot(snapshot => snapshot)
  const [busy, setBusy] = useState(false)
  const [writeError, setWriteError] = useState<string | undefined>(undefined)

  if (state.status === 'idle') void controller.load()
  if (state.status === 'error') return <div className={styles.section}>
    <h1>{t('visionFallback')}</h1>
    <p role="alert" className={styles.error}>{`${t('loadFailed')}: ${state.error ?? ''}`}</p>
    <button type="button" className={styles.retry} onClick={() => { void controller.retry() }}>{t('retry')}</button>
  </div>

  const namespace = state.namespaces.get('vision-understanding')
  const provider = namespace === undefined ? undefined : schema.getPath(namespace.value, ['provider'])
  const model = namespace === undefined ? undefined : schema.getPath(namespace.value, ['model'])
  const value = typeof provider === 'string' && typeof model === 'string' ? JSON.stringify([provider, model]) : ''
  const known = state.visionModels.some(choice => JSON.stringify([choice.provider, choice.model]) === value)
  const choose = (next: string): void => {
    const choice = state.visionModels.find(item => JSON.stringify([item.provider, item.model]) === next)
    setBusy(true)
    setWriteError(undefined)
    void controller.setVisionTarget(choice === undefined ? undefined : { provider: choice.provider, model: choice.model })
      .then((error) => { setWriteError(error) })
      .finally(() => { setBusy(false) })
  }

  return <section className={styles.section} aria-label={t('visionTool')}>
    <h1>{t('visionFallback')}</h1>
    <h2>{t('visionTool')}</h2>
    <p className={styles.description}>{t('visionToolDescription')}</p>
    {state.status === 'loading' ? <p role="status">{t('applying')}</p> : null}
    {namespace === undefined ? <p role="status">{t('visionUnavailable')}</p> : <>
      {!state.writable ? <p role="status">{t('readOnly')}</p> : null}
      <label className={styles.field}><span>{t('visionRoute')}</span>
        <span className={styles.selectWrap}>
          <select className={`${styles.select} ${styles.selectInput}`} value={value}
            disabled={!state.writable || busy || state.status === 'loading'}
            onChange={(event) => { choose(event.target.value) }}>
            <option value="">{t('visionNotConfigured')}</option>
            {value !== '' && !known ? <option value={value}>{`${String(provider)}/${String(model)}`}</option> : null}
            {state.visionModels.map(choice => <option key={JSON.stringify([choice.provider, choice.model])}
              value={JSON.stringify([choice.provider, choice.model])}>{`${choice.providerName} / ${choice.modelName}`}</option>)}
          </select>
          <span className={styles.chevron} aria-hidden="true"><IconChevronDownOutline14 size={14} /></span>
        </span>
      </label>
      {state.visionModelsError === null && state.visionModels.length === 0
        ? <p role="status">{t('visionNoCandidates')}</p> : null}
      {state.visionModelsError !== null ? <>
        <p role="alert" className={styles.error}>{`${t('visionLoadFailed')}: ${state.visionModelsError}`}</p>
        <button type="button" className={styles.retry} disabled={state.status === 'loading'}
          onClick={() => { void controller.retry() }}>{t('retry')}</button>
      </> : null}
      {value !== '' && !known && state.visionModelsError === null ? <p role="status">{t('visionOldTarget')}</p> : null}
      {busy ? <p role="status">{t('applying')}</p> : null}
      {writeError === undefined ? null : <p role="alert" className={styles.error}>{writeError}</p>}
    </>}
  </section>
}
