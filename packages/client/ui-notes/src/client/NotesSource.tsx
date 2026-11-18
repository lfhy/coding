import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { MarkdownTextarea } from 'coding-client-ui-primitives'
import css from './NotesSource.module.css'

const MIRROR_CHAR_LIMIT = 32_768
const MIRROR_LINE_LIMIT = 1_000

interface NotesSourceProps {
  editor: RefObject<HTMLTextAreaElement>
  content: string
  label: string
  placeholder: string
  onChange: (text: string) => void
  onBlur: () => void
}

/**
 * 保留原生选区与输入法；只在普通大小的笔记上叠加不参与编辑的行号和语法提示。
 * @param props - 文本域引用、源码和由笔记页持有的编辑状态。
 * @returns 共享文本域及与其滚动同步的呈现层。
 */
export function NotesSource({ editor, content, label, placeholder, onChange, onBlur }: NotesSourceProps) {
  const mirror = useRef<HTMLDivElement>(null)
  const [composing, setComposing] = useState(false)
  const lines = useMemo(() => {
    if (content.length > MIRROR_CHAR_LIMIT) return null
    const result = content.split(/\r\n?|\n/u)
    return result.length <= MIRROR_LINE_LIMIT ? result : null
  }, [content])
  const mirrored = lines !== null

  const syncMirror = () => {
    const field = editor.current
    const renderLayer = mirror.current
    if (field === null || renderLayer === null) return
    renderLayer.style.width = `${field.clientWidth}px`
    renderLayer.scrollTop = field.scrollTop
  }
  useLayoutEffect(syncMirror)
  useLayoutEffect(() => {
    const field = editor.current
    if (field === null || !mirrored) return
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(syncMirror)
    observer.observe(field)
    return () => { observer.disconnect() }
  }, [editor, mirrored])

  return (
    <div className={css.root} data-mirrored={mirrored || undefined} data-composing={composing || undefined}>
      {lines !== null && (
        <div ref={mirror} className={css.mirror} aria-hidden="true">
          {lines.map((line, index) => (
            <div key={index} className={css.line} data-line={index + 1}
              data-heading={/^ {0,3}#{1,6}(?:\s|$)/u.test(line) || undefined}>{line || '\u00a0'}</div>
          ))}
        </div>
      )}
      <MarkdownTextarea ref={editor} className={css.field} value={content} aria-label={label} placeholder={placeholder}
        onCompositionStart={() => { setComposing(true) }} onCompositionEnd={() => { setComposing(false) }}
        onScroll={(event) => { if (mirror.current !== null) mirror.current.scrollTop = event.currentTarget.scrollTop }}
        onChange={(event) => { onChange(event.target.value) }} onBlur={onBlur} />
    </div>
  )
}
