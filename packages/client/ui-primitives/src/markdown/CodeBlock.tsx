// 共享代码高亮：普通围栏带横幅与复制，文件预览使用无工具栏的纯源码模式。
// 未识别的语言回退为纯文本；颜色由主题的 --shiki-* 变量控制。

import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import clsx from 'clsx'
import { writeClipboard } from '../clipboard.ts'
import { grammarLoadCount, highlightToHtml, subscribeGrammarLoaded } from './highlight.ts'
import css from './CodeBlock.module.css'

export interface CodeBlockProps {
  /** 源文本；普通围栏展示时去掉末尾一个换行，纯源码模式原样保留。 */
  code: string
  /** 语法提示；未知语言回退为纯文本。 */
  lang?: string | undefined
  /** 调用方定位使用的容器样式。 */
  className?: string | undefined
  /** 复制按钮文案由调用方本地化。 */
  copyLabel?: string | undefined
  /** 复制成功后按钮的短时文案。 */
  copiedLabel?: string | undefined
  /** 仅显示源文本与高亮，不显示围栏横幅或复制按钮；保留文件末尾换行。 */
  bare?: boolean | undefined
}

/** 共享高亮表层；纯源码模式保留文件内容与所在预览区的滚动行为。 */
export function CodeBlock({ code, lang, className, copyLabel = '复制', copiedLabel = '复制成功', bare = false }: CodeBlockProps) {
  const displayed = bare || !code.endsWith('\n') ? code : code.slice(0, -1)
  // 延迟加载的语法完成后要从原文重新渲染；未知语言保持相同的纯文本结构。
  const loaded = useSyncExternalStore(subscribeGrammarLoaded, grammarLoadCount, grammarLoadCount)
  const html = useMemo(() => highlightToHtml(displayed, lang), [displayed, lang, loaded])
  const rootRef = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)

  const onCopy = useCallback(() => {
    if (copied) return
    /* v8 ignore next -- 高亮和回退均有 <pre>；展示内容只在 DOM 异常时回退。 */
    const text = rootRef.current?.querySelector('pre')?.textContent ?? displayed
    void writeClipboard(text).then((ok) => {
      if (!ok) return
      setCopied(true)
      window.setTimeout(() => { setCopied(false) }, 1000)
    })
  }, [copied, displayed])

  const body = html === undefined
    ? (
      <pre className={css.plain}><code>{displayed}</code></pre>
    )
    : (
  // 高亮器只把转义后的源文本写入静态 token 树，不透传用户 HTML。
      <div dangerouslySetInnerHTML={{ __html: html }} />
    )

  return (
    <div ref={rootRef} className={clsx(css.block, bare && css.bare, !bare && 'md-code-block', className)}>
      {!bare && <div className={css.bannerWrap}>
        <div className={css.banner}>
          <div className={css.infostring}>{lang ?? ''}</div>
          <div className={css.action}>
            <button type="button" className={css.copyButton} onClick={onCopy}>
              {copied ? copiedLabel : copyLabel}
            </button>
          </div>
        </div>
      </div>}
      {body}
    </div>
  )
}
