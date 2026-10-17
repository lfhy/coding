/** 代理池分区组件：节点导入/列表/测试/删除与 Free 渠道出站选择，纯 props 呈现。 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { SnapshotStore } from 'coding-client-runtime/client'
import type { InjectFace } from 'coding-client-ui-slots'
import type { ProxyPoolStoreHandle, PoolSnapshot } from './store.ts'

/** 分区文案（apply 侧由 locale 绑定注入）。 */
export interface ProxyPoolSectionText {
  title: string
  outbound: string
  outboundDirect: string
  outboundPool: string
  outboundCustom: string
  customUrlLabel: string
  importLabel: string
  importPlaceholder: string
  importButton: string
  imported: (count: number) => string
  skipped: (count: number) => string
  nodes: string
  test: string
  remove: string
  alive: string
  dead: string
  latency: (ms: number) => string
  frontend: string
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
  const [customUrl, setCustomUrl] = useState('')
  const [summary, setSummary] = useState<string | null>(null)

  if (state.status === 'idle') void actions.load()
  if (state.status === 'error') {
    return <section aria-label={t.title}>
      <h1>{t.title}</h1>
      <p role="alert">{`${t.loadFailed}: ${state.error ?? ''}`}</p>
      <button type="button" onClick={() => { void actions.load() }}>{t.retry}</button>
    </section>
  }

  const onImport = (): void => {
    void actions.importLinks(importText).then((result) => {
      setSummary(`${t.imported(result.imported)} · ${t.skipped(result.skipped)}`)
      setImportText('')
    })
  }

  return <section aria-label={t.title}>
    <h1>{t.title}</h1>

    <fieldset>
      <legend>{t.outbound}</legend>
      <label>
        <input type="radio" name="proxy-outbound" checked={state.outbound.mode === 'direct'} onChange={() => { void actions.setOutbound({ mode: 'direct' }) }} />
        {t.outboundDirect}
      </label>
      <label>
        <input type="radio" name="proxy-outbound" checked={state.outbound.mode === 'pool'} onChange={() => { void actions.setOutbound({ mode: 'pool' }) }} />
        {t.outboundPool}
      </label>
      <label>
        <input type="radio" name="proxy-outbound" checked={state.outbound.mode === 'custom'} onChange={() => {
          void actions.setOutbound({ mode: 'custom', customUrl: customUrl || 'http://127.0.0.1:1' })
        }} />
        {t.outboundCustom}
        <input value={customUrl} placeholder="http://proxy.example:8080" aria-label={t.customUrlLabel} onChange={(event) => { setCustomUrl(event.target.value) }} />
      </label>
    </fieldset>

    {state.frontendURL.length > 0 ? <p>{t.frontend}: <code>{state.frontendURL}</code></p> : null}
    {state.error !== null ? <p role="alert">{state.error}</p> : null}

    <div>
      <h2>{t.nodes}</h2>
      <textarea
        value={importText}
        rows={4}
        placeholder={t.importPlaceholder}
        aria-label={t.importLabel}
        onChange={(event) => { setImportText(event.target.value) }}
      />
      <button type="button" disabled={importText.trim().length === 0} onClick={onImport}>{t.importButton}</button>
      {summary !== null ? <span>{summary}</span> : null}
      <ul>
        {state.nodes.map((node) => {
          const health = state.health.get(node.id)
          return <li key={node.id}>
            <span>{node.name}</span>
            <span>{`${node.protocol} ${node.address}:${node.port}`}</span>
            {health === undefined ? null : health.alive
              ? <span>{`${t.alive}${health.latencyMs === undefined ? '' : ` ${t.latency(health.latencyMs)}`}`}</span>
              : <span>{`${t.dead} ${health.failure ?? ''}`}</span>}
            <button type="button" onClick={() => { void actions.testNode(node.id) }}>{t.test}</button>
            <button type="button" onClick={() => { void actions.removeNode(node.id) }}>{t.remove}</button>
          </li>
        })}
      </ul>
    </div>
  </section>
}
