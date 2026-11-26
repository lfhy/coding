import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, RefObject } from 'react'
import { MarkdownTextarea } from 'coding-client-ui-primitives'
import { edgeSelection, indentAtCaret, indentSelection } from './editor-keys.ts'
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
  onScroll?: (() => void) | undefined
}

/**
 * 保留原生选区与输入法；只在普通大小的笔记上叠加不参与编辑的行号和语法提示。
 * 源码视图按编辑器语义处理 Tab、Shift+Tab 与 Home／End。
 * @param props - 文本域引用、源码和由笔记页持有的编辑状态；`onScroll` 用于带动预览滚动。
 * @returns 共享文本域及与其滚动同步的呈现层。
 */
export function NotesSource({ editor, content, label, placeholder, onChange, onBlur, onScroll }: NotesSourceProps) {
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

  /**
   * 源码视图按编辑器语义处理 Tab 与 Home／End：Tab 缩进、Shift+Tab 退格，
   * Home／End 落在逻辑行首尾而不是跳到文首文末。其余按键（含 Cmd/Ctrl+Home 等
   * 整篇跳转、方向键、翻页）保持原生行为。
   */
  const onEditorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return
    const field = event.currentTarget
    const start = field.selectionStart
    const end = field.selectionEnd
    if (event.key === 'Tab' && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault()
      // 光标不停在选区上时 Tab 在光标处插一级缩进；有选区或按着 Shift 时按行走。
      if (start === end && !event.shiftKey) {
        const edit = indentAtCaret(field.value, start)
        field.setRangeText(edit.block, edit.from, edit.to, 'end')
        field.setSelectionRange(edit.selectionStart, edit.selectionEnd)
        onChange(edit.value)
        return
      }
      const edit = indentSelection(field.value, start, end, event.shiftKey)
      if (edit.value === field.value) return
      field.setRangeText(edit.block, edit.from, edit.to, 'end')
      field.setSelectionRange(edit.selectionStart, edit.selectionEnd)
      onChange(edit.value)
      return
    }
    if ((event.key !== 'Home' && event.key !== 'End') || event.altKey || event.ctrlKey || event.metaKey) return
    event.preventDefault()
    const edit = edgeSelection(field.value, start, end, field.selectionDirection,
      event.key === 'Home' ? 'start' : 'end', event.shiftKey)
    field.setSelectionRange(edit.selectionStart, edit.selectionEnd, edit.selectionDirection)
  }
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
        onKeyDown={onEditorKeyDown}
        onScroll={(event) => {
          if (mirror.current !== null) mirror.current.scrollTop = event.currentTarget.scrollTop
          onScroll?.()
        }}
        onChange={(event) => { onChange(event.target.value) }} onBlur={onBlur} />
    </div>
  )
}
