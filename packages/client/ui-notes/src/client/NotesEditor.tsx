import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Icon, IconChecklistOutline14, IconCodeOutline16, IconLinkOutline16, MarkdownText } from 'coding-client-ui-primitives'
import type { NotesLocaleKey } from './locales.ts'
import { NotesSource } from './NotesSource.tsx'
import { insertTable } from './markdown-table.ts'
import type { TableTemplate } from './markdown-table.ts'
import { createScrollFollower } from './preview-scroll.ts'
import type { ScrollSide } from './preview-scroll.ts'
import css from './NotesPage.module.css'

/** 为并排的两个正文区域各留出约 320px；助手与目录的占用计入测量。 */
const SPLIT_MIN_WIDTH = 640
const VIEWS = ['edit', 'split', 'preview'] as const
type View = typeof VIEWS[number]
const LINE_PREFIX = { heading: '## ', bullets: '- ', list: '- [ ] ', quote: '> ' } as const
type Format = keyof typeof LINE_PREFIX | 'bold' | 'italic' | 'inlineCode' | 'link' | 'table'

/** 工具栏插入的表格模板列数与数据行数；表头占位文字按语言生成。 */
const TABLE_COLUMNS = 3
const TABLE_ROWS = 2

const FORMATS: readonly [Format, ReactNode][] = [
  ['heading', <Icon name="format-heading" />], ['bold', <Icon name="format-bold" />],
  ['italic', <Icon name="format-italic" />], ['inlineCode', <IconCodeOutline16 />],
  ['link', <IconLinkOutline16 />], ['quote', <Icon name="format-quote" />],
  ['bullets', <Icon name="format-list" />], ['list', <IconChecklistOutline14 />],
  ['table', <Icon name="format-table" />],
]

interface NotesEditorProps {
  content: string
  onChange: (content: string) => void
  onBlur: () => void
  t: (key: NotesLocaleKey) => string
}

/**
 * 渲染共享标题下的视图切换、Markdown 格式工具与原文／预览正文。
 * @param props - 正文、编辑动作和本地化文案；调用方负责持久化。
 * @returns 根据中央正文实际宽度选择可用视图的编辑区。
 */
export function NotesEditor({ content, onChange, onBlur, t }: NotesEditorProps) {
  const viewId = useId()
  const workspace = useRef<HTMLDivElement>(null)
  const source = useRef<HTMLTextAreaElement>(null)
  const preview = useRef<HTMLElement>(null)
  const follower = useRef(createScrollFollower())
  const [canSplit, setCanSplit] = useState(true)
  const [view, setView] = useState<View>('split')
  const activeView = !canSplit && view === 'split' ? 'edit' : view

  // 并排时源码与预览互相带动：按两侧可滚动余量等比换算，写入引发的回声由 follower 丢弃。
  const followScroll = (side: ScrollSide) => {
    // 单栏视图下另一侧是隐藏的，没有可对齐的位置。
    if (activeView !== 'split') return
    const editor = source.current
    const pane = preview.current
    /* v8 ignore if -- scroll 只可能来自已挂载并可见的这一侧，两侧引用必然就绪。 */
    if (editor === null || pane === null) return
    const write = follower.current.follow(side, { source: editor, preview: pane })
    if (write === null) return
    if (write.side === 'source') editor.scrollTop = write.offset
    else pane.scrollTop = write.offset
  }

  useLayoutEffect(() => {
    const element = workspace.current
    /* v8 ignore next -- 布局 effect 只会在正文节点挂载后执行。 */
    if (element === null) return
    const measure = (width: number) => {
      const wide = width >= SPLIT_MIN_WIDTH
      const splitButton = element.querySelector('[data-view-option="split"]')
      if (!wide && (splitButton === document.activeElement
        || splitButton?.getAttribute('aria-pressed') === 'true' && preview.current?.contains(document.activeElement))) {
        element.querySelector<HTMLButtonElement>('[data-view-option="edit"]')?.focus({ preventScroll: true })
      }
      setCanSplit(wide)
    }
    if (typeof ResizeObserver === 'undefined') return
    measure(element.getBoundingClientRect().width)
    const observer = new ResizeObserver(([entry]) => {
      /* v8 ignore next -- 回调只观察一个元素，通知至少包含该元素的条目。 */
      if (entry !== undefined) measure(entry.contentRect.width)
    })
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [])

  const applyFormat = (kind: Format) => {
    const editor = source.current
    /* v8 ignore next -- 工具仅在原文可见时挂载，使用同一编辑器的当前选区。 */
    if (editor === null) return
    const { value, selectionStart, selectionEnd } = editor
    const text = value.slice(selectionStart, selectionEnd)
    if (kind === 'table') {
      const [first, ...rest] = Array.from({ length: TABLE_COLUMNS },
        (_, index) => t('tableColumn').replace('{index}', String(index + 1)))
      const template: TableTemplate = { headers: [first ?? '', ...rest], rows: TABLE_ROWS }
      const edit = insertTable(value, selectionStart, template)
      editor.setRangeText(edit.block, edit.from, edit.to, 'end')
      editor.setSelectionRange(edit.selectionStart, edit.selectionEnd)
    } else if (kind === 'bold' || kind === 'italic') {
      const token = kind === 'bold' ? '**' : '*'
      editor.setRangeText(token + text + token, selectionStart, selectionEnd, 'select')
      editor.setSelectionRange(selectionStart + token.length, selectionEnd + token.length)
    } else if (kind === 'link') {
      editor.setRangeText(`[${text}]()`, selectionStart, selectionEnd, 'select')
      const caret = text === '' ? selectionStart + 1 : selectionEnd + 3
      editor.setSelectionRange(caret, caret)
    } else if (kind === 'inlineCode') {
      let longestRun = 0
      for (const match of text.matchAll(/`+/gu)) longestRun = Math.max(longestRun, match[0].length)
      const fence = '`'.repeat(longestRun + 1)
      const pad = /^`|`$|^ .+ $/su.test(text) ? ' ' : ''
      const prefix = fence + pad
      editor.setRangeText(prefix + text + pad + fence, selectionStart, selectionEnd, 'select')
      editor.setSelectionRange(selectionStart + prefix.length, selectionEnd + prefix.length)
    } else {
      const start = selectionStart === 0 ? 0 : value.lastIndexOf('\n', selectionStart - 1) + 1
      const prefix = LINE_PREFIX[kind]
      const lines = value.slice(start, selectionEnd).replace(/(^|\n)(?!$)/gu, `$1${prefix}`) || prefix
      editor.setRangeText(lines, start, selectionEnd, 'select')
      editor.setSelectionRange(selectionStart + prefix.length, start + lines.length)
    }
    onChange(editor.value)
    editor.focus({ preventScroll: true })
  }

  return (
    <div ref={workspace} className={css.workspace}>
      <div className={css.toolbar}>
        {activeView !== 'preview' && (
          <div className={css.formats} role="group" aria-label={t('format')}>
            {FORMATS.map(([format, icon]) => (
              <Button key={format} size="sm" className={css.iconButton} icon={icon}
                aria-label={t(format)} title={t(format)}
                onPointerDown={(event) => { if (event.pointerType === 'mouse') event.preventDefault() }}
                onClick={() => { applyFormat(format) }} />
            ))}
          </div>
        )}
        <div className={css.views} role="group" aria-label={t('view')}>
          {VIEWS.filter(mode => mode !== 'split' || canSplit).map(mode => (
            <Button key={mode} size="sm" className={css.viewButton}
              data-view-option={mode}
              aria-controls={viewId} aria-pressed={mode === activeView} onClick={() => { setView(mode) }}>
              {t(mode)}
            </Button>
          ))}
        </div>
      </div>
      <div id={viewId} className={css.panes} data-view={activeView}>
        <div className={css.source} hidden={activeView === 'preview'}>
          <NotesSource editor={source} content={content} label={t('source')} placeholder={t('placeholder')}
            onChange={onChange} onBlur={onBlur} onScroll={() => { followScroll('source') }} />
        </div>
        <section ref={preview} className={css.preview} aria-label={t('preview')} hidden={activeView === 'edit'} tabIndex={0}
          onScroll={() => { followScroll('preview') }}>
          <div className={css.previewBody}>
            <MarkdownText text={content} codeLabels={{ copyLabel: t('copy'), copiedLabel: t('copied') }}
              onOpenUrl={(href) => { window.open(href, '_blank', 'noopener,noreferrer') }} />
          </div>
        </section>
      </div>
    </div>
  )
}
