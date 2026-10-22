/** 代理池分区组件：出站选择、订阅导入与节点状态表，纯 props 呈现（样式走项目 token）。 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button, IconWarningOutline16, Modal, Tooltip } from 'coding-client-ui-primitives'
import type { SnapshotStore } from 'coding-client-runtime/client'
import type { InjectFace } from 'coding-client-ui-slots'
import type { ProxyPoolStoreHandle, PoolSnapshot } from './store.ts'
import styles from './ProxyPoolSection.module.css'

/** 分区文案（apply 侧由 locale 绑定注入）。 */
export interface ProxyPoolSectionText {
  title: string
  intro: string
  poolOutbound: string
  poolOutboundDirect: string
  poolOutboundPool: string
  poolOutboundCustom: string
  poolCustomUrl: string
  poolApplyCustomUrl: string
  poolOutboundHint: string
  importLabel: string
  importTitle: string
  importPlaceholder: string
  importButton: string
  cancel: string
  refreshFeed: string
  refreshed: (summary: { admitted: number; evicted: number }) => string
  imported: (count: number) => string
  skipped: (count: number) => string
  nodes: string
  nodeName: string
  nodeAddress: string
  nodeStatus: string
  nodeActions: string
  test: string
  remove: string
  alive: string
  dead: string
  unknown: string
  latency: (ms: number) => string
  frontend: string
  emptyNodes: string
  loadFailed: string
  retry: string
}

/** 分区注入面：store 动作、快照源与文案（hooks 槽位由 renderer 绑定为 useSnapshot）。 */
export interface ProxyPoolSectionInjected {
  /** 分区 store 的动作面（不含 store 本体）。 */
  actions: Omit<ProxyPoolStoreHandle, 'store'>
  /** 快照源；经 InjectFace 绑定为 `useSnapshot` 选择器。 */
  hooks: { snapshot: SnapshotStore<PoolSnapshot> }
  /** 分区文案。 */
  t: ProxyPoolSectionText
}

/** slot outlet 展开注入面后的 props（本分区不持有 owner/store 声明）。 */
export type ProxyPoolSectionProps = Partial<InjectFace<ProxyPoolSectionInjected>>

/**
 * 渲染代理池分区；注入未完成时返回 null。
 * @param props - 注入面（store 动作、useSnapshot 选择器、文案）。
 * @returns 分区内容。
 */
export function ProxyPoolSection(props: ProxyPoolSectionProps): ReactNode {
  const { actions, useSnapshot, t } = props
  if (actions === undefined || useSnapshot === undefined || t === undefined) return null
  return <Loaded actions={actions} state={useSnapshot(snapshot => snapshot)} t={t} />
}

/** 已注入态：本地只保留输入草稿等组件私有状态。 */
function Loaded({ actions, state, t }: {
  actions: ProxyPoolSectionInjected['actions']
  state: PoolSnapshot
  t: ProxyPoolSectionText
}): ReactNode {
  const [importText, setImportText] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [customUrl, setCustomUrl] = useState(state.outbound.mode === 'custom' ? state.outbound.customUrl ?? '' : '')
  const [summary, setSummary] = useState<string | null>(null)

  if (state.status === 'idle') void actions.load()
  if (state.status === 'error') {
    return <section className={styles['poolSection']} aria-label={t.title}>
      <h1 className={styles['title']}>{t.title}</h1>
      <p role="alert" className={styles['error']}>{`${t.loadFailed}: ${state.error ?? ''}`}</p>
      <div>
        <button type="button" className={styles['secondaryButton']} onClick={() => { void actions.load() }}>{t.retry}</button>
      </div>
    </section>
  }

  const outbound = state.outbound.mode
  const applyCustom = (): void => {
    void actions.setOutbound({ mode: 'custom', customUrl: customUrl || 'http://127.0.0.1:1' })
  }
  const closeImport = (): void => {
    setImportOpen(false)
    setImportText('')
  }
  const onImport = (): void => {
    void actions.importLinks(importText).then((result) => {
      setSummary(`${t.imported(result.imported)} · ${t.skipped(result.skipped)}`)
      closeImport()
    })
  }

  return <section className={styles['poolSection']} aria-label={t.title}>
    <h1 className={styles['title']}>{t.title}</h1>
    <p className={styles['intro']}>{t.intro}</p>
    {state.error !== null ? <p role="alert" className={styles['error']}>{state.error}</p> : null}

    <div className={styles['outboundCard']}>
      <h2 className={styles['cardTitle']}>{t.poolOutbound}</h2>
      <div className={styles['segmented']} role="group" aria-label={t.poolOutbound}>
        <button type="button" className={styles['segment']} aria-pressed={outbound === 'direct'}
          onClick={() => { void actions.setOutbound({ mode: 'direct' }) }}>{t.poolOutboundDirect}</button>
        <button type="button" className={styles['segment']} aria-pressed={outbound === 'pool'}
          onClick={() => { void actions.setOutbound({ mode: 'pool' }) }}>{t.poolOutboundPool}</button>
        <button type="button" className={styles['segment']} aria-pressed={outbound === 'custom'}
          onClick={applyCustom}>{t.poolOutboundCustom}</button>
      </div>
      {outbound === 'custom' ? (
        <div className={styles['customUrlRow']}>
          <input className={styles['input']} value={customUrl} placeholder="http://proxy.example:8080"
            aria-label={t.poolCustomUrl} onChange={(event) => { setCustomUrl(event.target.value) }} />
          <button type="button" className={styles['primaryButton']} onClick={applyCustom}>{t.poolApplyCustomUrl}</button>
        </div>
      ) : null}
      <p className={styles['intro']}>{t.poolOutboundHint}</p>
      {outbound === 'pool' && state.frontendURL.length > 0 ? (
        <p className={styles['frontend']}>{t.frontend}: <code className={styles['frontendCode']}>{state.frontendURL}</code></p>
      ) : null}
    </div>

    <div className={styles['nodesCard']}>
      <div className={styles['cardHeading']}>
        <h2 className={styles['cardTitle']}>{t.nodes}</h2>
        <div className={styles['headingActions']}>
          <Button variant="outline" size="sm" onClick={() => { setImportOpen(true) }}>{t.importButton}</Button>
          <Button variant="outline" size="sm"
            onClick={() => { void actions.refresh().then((r) => { setSummary(t.refreshed(r)) }) }}>
            {t.refreshFeed}
          </Button>
        </div>
      </div>
      {summary !== null ? <p role="status" className={styles['summary']}>{summary}</p> : null}
      {state.nodes.length === 0 ? <p className={styles['empty']}>{t.emptyNodes}</p> : (
        <div className={styles['tableScroller']} tabIndex={0} role="region" aria-label={t.nodes}>
          <table className={styles['nodeTable']}>
            <thead>
              <tr>
                <th scope="col">{t.nodeName}</th>
                <th scope="col">{t.nodeAddress}</th>
                <th scope="col">{t.nodeStatus}</th>
                <th scope="col">{t.nodeActions}</th>
              </tr>
            </thead>
            <tbody>
              {state.nodes.map((node) => {
                const health = state.health.get(node.id)
                const status = health === undefined ? t.unknown : health.alive ? t.alive : t.dead
                return <tr key={node.id}>
                  <td className={styles['nodeName']}>{node.name}</td>
                  <td className={styles['nodeAddress']}>{`${node.protocol} ${node.address}:${node.port}`}</td>
                  <td>
                    <span className={styles['statusBadge']}>
                      <span className={styles['statusDot']} data-alive={health === undefined ? undefined : String(health.alive)} />
                      {status}
                      {health?.alive === true && health.latencyMs !== undefined ? (
                        <span className={styles['latency']}>{t.latency(health.latencyMs)}</span>
                      ) : null}
                    </span>
                    {health?.alive === false && health.failure !== undefined ? (
                      <Tooltip label={health.failure} side="top" maxWidth={360}>
                        <span className={styles['failureIndicator']} role="img" aria-label={health.failure}>
                          <IconWarningOutline16 size={14} />
                        </span>
                      </Tooltip>
                    ) : null}
                  </td>
                  <td>
                    <span className={styles['rowActions']}>
                      <Button variant="outline" size="sm" onClick={() => { void actions.testNode(node.id) }}>{t.test}</Button>
                      <Button variant="outline" size="sm" onClick={() => { void actions.removeNode(node.id) }}>{t.remove}</Button>
                    </span>
                  </td>
                </tr>
              })}
            </tbody>
          </table>
        </div>
      )}
      <Modal open={importOpen} trapFocus onClose={closeImport} title={t.importTitle} closeLabel={t.cancel}
        className={styles['importDialog'] as string}
        footer={<><Button variant="outline" autoFocus onClick={closeImport}>{t.cancel}</Button>
          <Button variant="primary" disabled={importText.trim().length === 0} onClick={onImport}>{t.importButton}</Button></>}>
        <textarea className={styles['textarea']} value={importText} placeholder={t.importPlaceholder}
          aria-label={t.importLabel} onChange={(event) => { setImportText(event.target.value) }} />
      </Modal>
    </div>
  </section>
}
