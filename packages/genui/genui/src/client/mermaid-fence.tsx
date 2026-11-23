/**
 * Mermaid 围栏：宿主 Markdown 里的 ```mermaid 代码块定稿后由本插件接管，
 * 用 GenUI 的懒加载引擎渲染图表，并保留「预览／源码」切换。
 *
 * 与 `svg-fence` 同一职责：流式正文不能渲染（源码未写完），此时继续显示宿主
 * 代码块；引擎加载失败时由 `MermaidNode` 降级回源码，用户不会看到空白图表。
 * @module coding-genui/client/mermaid-fence
 */
import { useLayoutEffect, useRef, useState, type Key } from 'react'
import { CodeBlock } from 'coding-client-ui-primitives'
import { MermaidNode } from './blocks/advanced.tsx'
import { codeBlockLabels } from './primitive-labels.ts'
import { useT } from './i18n/index.ts'
import css from './GenuiBlock.module.css'

function MermaidFence({ raw }: { raw: string }) {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  const [settled, setSettled] = useState(false)
  const [source, setSource] = useState(false)
  // 定稿前不渲染图表：流式期间宿主代码块本身就是最好的占位，切换条也只
  // 在源码完整后出现。
  useLayoutEffect(() => {
    const node = ref.current
    /* v8 ignore next -- layout effect 一定在 ref 挂载后运行，这里的空值只是类型收窄。 */
    if (node === null) return
    const update = () => { setSettled(node.closest('[data-streaming]') === null) }
    update()
    const observer = new MutationObserver(update)
    for (let ancestor = node.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
      observer.observe(ancestor, { attributes: true, attributeFilter: ['data-streaming'] })
    }
    return () => { observer.disconnect() }
  })
  return (
    <div ref={ref} data-genui-mermaid-fence className={`${css.block} ${css.tabs}`}>
      {settled && <div role="group" aria-label={t('block.mermaidLabel')} className={css.tabBar}>
        <button type="button" className={`${css.tab} ${!source ? css.tabActive : ''}`} aria-pressed={!source} onClick={() => { setSource(false) }}>{t('block.mermaidPreview')}</button>
        <button type="button" className={`${css.tab} ${source ? css.tabActive : ''}`} aria-pressed={source} onClick={() => { setSource(true) }}>{t('block.mermaidSource')}</button>
      </div>}
      {!settled || source
        ? <CodeBlock {...codeBlockLabels()} code={raw} lang="mermaid" />
        : <MermaidNode node={{ type: 'mermaid', code: raw }} />}
    </div>
  )
}

/**
 * 为一块已定稿的 mermaid 围栏生成可挂载节点。
 * @param raw - 围栏正文（不含围栏标记）。
 * @param key - 宿主围栏序号派生的稳定 React key。
 * @returns 带「预览／源码」切换的图表节点。
 */
export function renderMermaidFence(raw: string, key: Key) {
  return <MermaidFence key={key} raw={raw} />
}
