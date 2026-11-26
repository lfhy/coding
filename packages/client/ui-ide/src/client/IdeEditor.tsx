/** IDE 文本编辑区：保留原生输入法选区，并提供行号、缩进与保存快捷键。 */
import { useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Button, MarkdownTextarea } from 'coding-client-ui-primitives'
import type { PropsLocale } from 'coding-client-ui-slots'
import type { IdeDocument } from './ide-store.ts'
import { NS } from './locales.ts'
import css from './IdeEditor.module.css'

const MAX_GUTTER_LINES = 5_000

interface IdeEditorProps {
  document: IdeDocument
  onChange: (content: string) => void
  onSave: () => void
  onReload: () => void
  onRetry: () => void
  t: PropsLocale<typeof NS>['t']
}

function languageLabel(name: string, t: PropsLocale<typeof NS>['t']): string {
  const dot = name.lastIndexOf('.')
  return dot < 0 || dot === name.length - 1 ? t('plainText') : name.slice(dot + 1).toUpperCase()
}

/** 活动文件的编辑与恢复区域；错误时保留草稿并提供明确下一步。 */
export function IdeEditor({ document, onChange, onSave, onReload, onRetry, t }: IdeEditorProps) {
  const field = useRef<HTMLTextAreaElement>(null)
  const gutter = useRef<HTMLDivElement>(null)
  const [cursor, setCursor] = useState({ line: 1, column: 1 })
  const lines = useMemo(() => document.content.split(/\r\n?|\n/u), [document.content])
  const mirrored = lines.length <= MAX_GUTTER_LINES
  const editable = document.status === 'ready'
  const tabId = `ide-tab-${encodeURIComponent(document.path)}`

  const updateCursor = (input: HTMLTextAreaElement): void => {
    const before = input.value.slice(0, input.selectionStart)
    const row = before.lastIndexOf('\n')
    setCursor({ line: before.split('\n').length, column: input.selectionStart - row })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      onSave()
      return
    }
    if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return
    event.preventDefault()
    const input = event.currentTarget
    const start = input.selectionStart
    const end = input.selectionEnd
    if (event.shiftKey && start === end) {
      const lineStart = input.value.lastIndexOf('\n', start - 1) + 1
      const leading = /^ {1,2}/u.exec(input.value.slice(lineStart))?.[0].length ?? 0
      if (leading === 0) return
      input.setRangeText('', lineStart, lineStart + leading, 'end')
      onChange(input.value)
      return
    }
    input.setRangeText('  ', start, end, 'end')
    onChange(input.value)
  }

  if (!editable) {
    const message = document.status === 'loading' ? t('loading')
      : document.status === 'unsupported' ? t(document.error === 'too-large' ? 'tooLarge' : 'unsupported')
        : t('loadError')
    return <section id="ide-editor-panel" className={css.state} role="tabpanel" aria-labelledby={tabId}>
      <p role={document.status === 'error' ? 'alert' : 'status'}>{message}</p>
      {document.status === 'error' && <Button size="sm" variant="outline" onClick={onRetry}>{t('retry')}</Button>}
    </section>
  }

  return <section id="ide-editor-panel" className={css.editorPanel} role="tabpanel" aria-labelledby={tabId}>
    {document.error !== undefined && <div className={css.recovery} role="alert">
      <span>{t(document.error === 'conflict' ? 'conflictKept' : 'draftKept')}</span>
      {document.error === 'conflict'
        ? <Button size="sm" variant="outline" onClick={onReload}>{t('reload')}</Button>
        : <Button size="sm" variant="outline" onClick={onRetry}>{t('retry')}</Button>}
    </div>}
    <div className={css.editorRoot}>
      {mirrored && <div ref={gutter} className={css.gutter} aria-hidden="true">
        {lines.map((_line, index) => <div key={index}>{index + 1}</div>)}
      </div>}
      <MarkdownTextarea ref={field} className={css.field} value={document.content} wrap="off"
        aria-label={t('editorLabel', { name: document.name })} onChange={(event) => { onChange(event.target.value) }}
        onKeyDown={onKeyDown} onSelect={(event) => { updateCursor(event.currentTarget) }}
        onClick={(event) => { updateCursor(event.currentTarget) }} onKeyUp={(event) => { updateCursor(event.currentTarget) }}
        onScroll={(event) => { if (gutter.current !== null) gutter.current.scrollTop = event.currentTarget.scrollTop }} />
    </div>
    <footer className={css.status}>
      <span>{t('lineColumn', { line: cursor.line, column: cursor.column })}</span>
      <span className={css.spacer} />
      <span>UTF-8</span>
      <span>{languageLabel(document.name, t)}</span>
    </footer>
  </section>
}
