/**
 * Untrusted assistant-Markdown renderer over the direct mdast pipeline:
 * `parse.ts` grammars, the incremental streaming parser, and `render.tsx`.
 * While a message streams, all but the trailing two blocks freeze as cached
 * React elements and only the source tail behind them re-parses per chunk,
 * so per-chunk work tracks the tail size instead of the whole reply. Frozen
 * blocks keep their source-offset keys when they cross the freeze boundary,
 * so React reconciles instead of remounting. Known deviation while
 * streaming: a reference-style link or footnote whose definition sits on the
 * other side of the freeze boundary renders literally until the settled
 * full parse self-heals it.
 */

import { memo, useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import { IncrementalMarkdownParser } from './incremental.ts'
import { parseGfm, parseGfmWithMath } from './parse.ts'
import {
  collectReferenceTargets, createReferenceTargets, renderBlocks, renderFootnoteSection,
  wrapBlockChildren,
} from './render.tsx'
import type { MarkdownCodeLabels, MarkdownFileMentions, MarkdownOpenUrl, MarkdownRenderContext, ReferenceTargets } from './render.tsx'
import 'katex/dist/katex.min.css'
import css from './MarkdownText.module.css'

export type { MarkdownCodeLabels, MarkdownFileMentions } from './render.tsx'

/** 完整解析已定稿文本，解析引用并附加脚注。 */
function renderSettled(
  text: string,
  codeLabels: MarkdownCodeLabels | undefined,
  fileMentions: MarkdownFileMentions | undefined,
  openUrl: MarkdownOpenUrl,
): ReactNode[] {
  const root = parseGfmWithMath(text)
  const targets = createReferenceTargets()
  collectReferenceTargets(root.children, targets)
  const context: MarkdownRenderContext = {
    streaming: false,
    codeLabels,
    fileMentions,
    openUrl,
    targets,
    footnoteOrder: [],
    footnoteCounts: new Map(),
  }
  const blocks = wrapBlockChildren(
    renderBlocks(root.children.map((node, index) => ({ node, key: index })), context),
    false,
  )
  const section = renderFootnoteSection(context)
  return section === null ? blocks : [...blocks, '\n', section]
}

/**
 * Streaming render state for one growing message: the incremental parser,
 * the frozen blocks' cached elements, and the reference/footnote state their
 * rendering consumed (footnote numbering assigned to frozen references is
 * final, so the tail continues from a copy of it each frame).
 */
class StreamingRenderer {
  private readonly parser = new IncrementalMarkdownParser(parseGfm)
  private generation = -1
  private frozenCount = 0
  private frozenElements: ReactNode[] = []
  private frozenTargets: ReferenceTargets = createReferenceTargets()
  private frozenFootnoteOrder: string[] = []
  private frozenFootnoteCounts = new Map<string, number>()
  private lastText: string | null = null
  private lastRendered: ReactNode[] = []

  /** @param codeLabels - 围栏复制文案会固化在缓存元素中；变更时持有方重建渲染器。 */
  constructor(
    private readonly codeLabels: MarkdownCodeLabels | undefined,
    private readonly openUrl: MarkdownOpenUrl,
  ) {}

  /**
   * Render the current accumulated text. Idempotent per text value, so React
   * may re-execute the calling render freely.
   * @param text - The full accumulated markdown source.
   * @returns Frozen elements, re-rendered tail, and the footnote section.
   */
  render(text: string): ReactNode[] {
    if (text === this.lastText) return this.lastRendered
    const { frozen, tail, generation } = this.parser.update(text)
    if (generation !== this.generation) {
      this.generation = generation
      this.frozenCount = 0
      this.frozenElements = []
      this.frozenTargets = createReferenceTargets()
      this.frozenFootnoteOrder = []
      this.frozenFootnoteCounts = new Map()
    }
    const newlyFrozen = frozen.slice(this.frozenCount)
    collectReferenceTargets(newlyFrozen.map(block => block.node), this.frozenTargets)
    // Targets visible this frame: everything frozen so far plus the current
    // tail parse — a newly frozen block's references resolved against the
    // same parse tree its definitions came from.
    const frameTargets: ReferenceTargets = {
      definitions: new Map(this.frozenTargets.definitions),
      footnotes: new Map(this.frozenTargets.footnotes),
    }
    collectReferenceTargets(tail.map(block => block.node), frameTargets)
    if (newlyFrozen.length > 0) {
      const frozenContext: MarkdownRenderContext = {
        streaming: true,
        codeLabels: this.codeLabels,
        fileMentions: undefined,
        openUrl: this.openUrl,
        targets: frameTargets,
        footnoteOrder: this.frozenFootnoteOrder,
        footnoteCounts: this.frozenFootnoteCounts,
      }
      // Separator newlines are cached alongside the elements so the
      // assembled children match the settled pipeline's block wrapping.
      const batch = [...this.frozenElements]
      for (const element of renderBlocks(newlyFrozen, frozenContext)) {
        if (batch.length > 0) batch.push('\n')
        batch.push(element)
      }
      this.frozenElements = batch
      this.frozenCount = frozen.length
    }
    const tailContext: MarkdownRenderContext = {
      streaming: true,
      codeLabels: this.codeLabels,
      fileMentions: undefined,
      openUrl: this.openUrl,
      targets: frameTargets,
      footnoteOrder: [...this.frozenFootnoteOrder],
      footnoteCounts: new Map(this.frozenFootnoteCounts),
    }
    const children = [...this.frozenElements]
    for (const element of renderBlocks(tail, tailContext)) {
      if (children.length > 0) children.push('\n')
      children.push(element)
    }
    const section = renderFootnoteSection(tailContext)
    if (section !== null) children.push('\n', section)
    this.lastText = text
    this.lastRendered = children
    return this.lastRendered
  }
}

/**
 * 将不受信任的 assistant Markdown 渲染为语义化 React 元素。
 * @param props - `text` 是会话投影保留的源码；`streaming` 增量解析分片，围栏高亮和 TeX 排版留待定稿。
 * `codeLabels` 向围栏代码块提供本地化复制文案，须保持引用稳定，否则会重建流式缓存。
 * `fileMentions` 只在定稿时解析真实文件，因为流式冻结元素不能固化可能过期的文件入口。
 * `onOpenUrl` 仅拦截 HTTP(S) 链接未经修饰的主键激活（含 Enter），冻结链接在激活时读取最新回调。
 * @returns GFM 与 KaTeX 文档；原始 HTML、相对链接和危险协议不可交互，绝对 HTTP(S) 图片可显示。
 */
export const MarkdownText = memo(function MarkdownText({ text, streaming = false, codeLabels, fileMentions, onOpenUrl }: {
  text: string
  streaming?: boolean
  codeLabels?: MarkdownCodeLabels | undefined
  fileMentions?: MarkdownFileMentions | undefined
  onOpenUrl?: ((href: string) => void) | undefined
}) {
  const streamRef = useRef<StreamingRenderer | null>(null)
  const streamLabelsRef = useRef<MarkdownCodeLabels | undefined>(codeLabels)
  const onOpenUrlRef = useRef(onOpenUrl)
  useLayoutEffect(() => { onOpenUrlRef.current = onOpenUrl }, [onOpenUrl])
  const openUrl = useCallback<MarkdownOpenUrl>((href, event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const callback = onOpenUrlRef.current
    if (callback === undefined) return
    event.preventDefault()
    callback(href)
  }, [])
  const children = useMemo(() => {
    if (!streaming) {
      streamRef.current = null
      return renderSettled(text, codeLabels, fileMentions, openUrl)
    }
    if (streamRef.current === null || streamLabelsRef.current !== codeLabels) {
      streamRef.current = new StreamingRenderer(codeLabels, openUrl)
      streamLabelsRef.current = codeLabels
    }
    return streamRef.current.render(text)
  }, [text, streaming, codeLabels, fileMentions, openUrl])
  return <div className={css.markdown}>{children}</div>
})
