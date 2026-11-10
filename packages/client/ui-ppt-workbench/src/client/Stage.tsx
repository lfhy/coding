/**
 * 画布：等比铺满可用空间，承载选中、拖动与就地编辑。草稿只存在于本组件，
 * 提交时统一走控制器的一次编辑，因此不会为每个按键产生一次请求。
 * @module coding-ppt-workbench/client/Stage
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Menu, type MenuEntry } from 'coding-client-ui-primitives'
import { Icon, IconCopyOutline16, IconTrashOutline16 } from 'coding-client-ui-icons'
import type { Translate } from 'coding-client-ui-slots'
import { SLIDE_SIZES, type PptDeck, type PptElementKind, type PptPage } from 'coding-ppt-model'
import type { PptWorkbenchKey } from './locales.ts'
import { SlideSurface, type ElementBox } from './SlideSurface.tsx'
import css from './Stage.module.css'

export interface StageProps {
  readonly deck: PptDeck
  readonly page: PptPage
  readonly selectedId: string | null
  readonly editingId: string | null
  readonly busy: boolean
  readonly t: Translate<PptWorkbenchKey>
  readonly onSelect: (id: string | null) => void
  readonly onBeginEdit: (id: string) => void
  readonly onEndEdit: (content: string | null) => void
  readonly onMove: (id: string, x: number, y: number) => void
  readonly onResize: (id: string, box: ElementBox) => void
  readonly onEditCell: (id: string, row: number, column: number, content: string) => void
  readonly mediaUrl: (source: string) => string
  readonly hasClipboard: boolean
  readonly onCopySelected: (id: string) => void
  readonly onCutSelected: (id: string) => void
  readonly onPaste: (at?: { x: number; y: number }) => void
  readonly onInsert: (kind: PptElementKind) => void
  readonly onChooseImage: (replaceId?: string) => void
  /** 选中元素时按 Delete/Backspace 删除。 */
  readonly onDeleteSelected: (id: string) => void
  /** 选中元素时按 Cmd/Ctrl+D 复制副本。 */
  readonly onDuplicateSelected: (id: string) => void
}

/**
 * 计算在容器内等比放大的画布宽度。
 * @param box - 可用宽高。
 * @param ratio - 画布的宽高比（基准像素）。
 * @returns 画布渲染宽度。
 */
export function fitWidth(box: { width: number; height: number }, ratio: number): number {
  const byWidth = box.width
  const byHeight = box.height * ratio
  return Math.max(0, Math.floor(Math.min(byWidth, byHeight)))
}

/**
 * 画布区域。
 * @param props - 当前页、选择状态与交互回调。
 * @returns 自适应宽度的画布。
 */
export function Stage({
  deck, page, selectedId, editingId, busy, t, onSelect, onBeginEdit, onEndEdit, onMove, onResize, onEditCell, mediaUrl,
  hasClipboard, onCopySelected, onCutSelected, onPaste, onInsert, onChooseImage,
  onDeleteSelected, onDuplicateSelected,
}: StageProps) {
  const host = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ width: 0, height: 0 })
  const [draft, setDraft] = useState('')
  const [context, setContext] = useState<{
    id: string | null
    kind: PptElementKind | null
    x: number
    y: number
    clientX: number
    clientY: number
  } | null>(null)
  const contextRef = useRef(context)
  contextRef.current = context
  const anchorRect = useCallback(() => {
    return context === null ? null : new DOMRect(context.clientX, context.clientY, 0, 0)
  }, [context])

  useEffect(() => { setContext(null) }, [page.id, deck.title])
  useEffect(() => { if (busy) setContext(null) }, [busy])

  useEffect(() => {
    const element = editingId === null ? undefined : page.elements.find(entry => entry.id === editingId)
    setDraft(element?.kind === 'text' ? element.text.content : '')
  }, [editingId, page])

  useEffect(() => {
    const node = host.current
    if (node === null) return undefined
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (rect === undefined) return
      setBox({ width: Math.max(rect.width, 0), height: Math.max(rect.height, 0) })
    })
    observer.observe(node)
    return () => { observer.disconnect() }
  }, [])

  const size = SLIDE_SIZES[deck.size]
  const width = fitWidth(box, size.width / size.height)
  const contextItems: MenuEntry[] = context === null ? [] : [
    ...context.id === null ? [] : [
      { id: 'cut', label: t('cut'), icon: <IconCopyOutline16 size={14} /> },
      { id: 'copy', label: t('copyElement'), icon: <IconCopyOutline16 size={14} /> },
    ],
    { id: 'paste', label: t('paste'), icon: <IconCopyOutline16 size={14} />, disabled: !hasClipboard },
    { type: 'separator', id: 'edit-separator' },
    ...context.kind === 'image' ? [{ id: 'replace', label: t('replaceImage'), icon: <Icon name="model-vision" size={14} /> }] : [],
    ...context.id === null ? [
      { id: 'text', label: t('addText') }, { id: 'rect', label: t('addRect') },
      { id: 'ellipse', label: t('addEllipse') }, { id: 'line', label: t('addLine') },
      { id: 'image', label: t('addImage') }, { id: 'table', label: t('addTable') },
      { id: 'chart', label: t('addChart') },
    ] : [],
    ...context.id !== null ? [{ id: 'delete', label: t('deleteElement'), icon: <IconTrashOutline16 size={14} />, danger: true }] : [],
  ]

  const selectContextAction = (action: string): void => {
    const target = contextRef.current
    setContext(null)
    if (target === null) return
    host.current?.focus({ preventScroll: true })
    if (action === 'copy' && target.id !== null) onCopySelected(target.id)
    else if (action === 'cut' && target.id !== null) onCutSelected(target.id)
    else if (action === 'paste') onPaste({ x: target.x, y: target.y })
    else if (action === 'replace') onChooseImage(target.id ?? undefined)
    else if (action === 'delete' && target.id !== null) onDeleteSelected(target.id)
    else if (action === 'image') onChooseImage()
    else if (action === 'text' || action === 'rect' || action === 'ellipse' || action === 'line'
      || action === 'table' || action === 'chart') onInsert(action)
  }

  return (
    <div
      ref={host}
      className={css.stage}
      data-busy={busy ? 'true' : undefined}
      tabIndex={-1}
      onPointerDown={(event) => {
        if (event.target === host.current) {
          setContext(null)
          host.current.focus({ preventScroll: true })
        }
      }}
      onKeyDown={(event) => {
        if (busy || editingId !== null || context !== null || event.target instanceof HTMLInputElement
          || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return
        const command = event.metaKey || event.ctrlKey
        const key = event.key.toLowerCase()
        if (command && key === 'v' && hasClipboard) {
          event.preventDefault()
          onPaste()
        } else if (selectedId !== null && command && key === 'c') {
          event.preventDefault()
          onCopySelected(selectedId)
        } else if (selectedId !== null && command && key === 'x') {
          event.preventDefault()
          onCutSelected(selectedId)
        } else if (selectedId !== null && command && key === 'd') {
          event.preventDefault()
          onDuplicateSelected(selectedId)
        } else if (selectedId !== null && !command && (event.key === 'Delete' || event.key === 'Backspace')) {
          event.preventDefault()
          onDeleteSelected(selectedId)
        }
      }}
    >
      {width > 0 ? (
        <SlideSurface
          deck={deck}
          page={page}
          width={width}
          selectedId={selectedId}
          editing={editingId === null ? null : {
            id: editingId,
            content: draft,
            onChange: setDraft,
            onCommit: () => { onEndEdit(draft) },
            onCancel: () => { onEndEdit(null) },
          }}
          interaction={{ onSelect, onBeginEdit, onMove, onResize, onEditCell,
            onFocusCanvas: () => { host.current?.focus({ preventScroll: true }) },
            onContextMenu: (id, at) => {
              if (busy || editingId !== null) return
              onSelect(id)
              host.current?.focus({ preventScroll: true })
              setContext({ ...at, id, kind: page.elements.find(element => element.id === id)?.kind ?? null })
            },
          }}
          emptyHint={t('emptyPage')}
          cellLabel={(row, column) => t('cellPosition', { row, column })}
          mediaUrl={mediaUrl}
        />
      ) : null}
      <Menu open={context !== null && !busy} anchor={null} portal compact keyboardNavigation
        getAnchorRect={anchorRect} items={contextItems} onSelect={selectContextAction}
        onClose={() => { setContext(null); host.current?.focus({ preventScroll: true }) }} />
    </div>
  )
}
