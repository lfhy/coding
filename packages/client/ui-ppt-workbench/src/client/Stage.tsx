/**
 * 画布：等比铺满可用空间，承载选中、拖动与就地编辑。草稿只存在于本组件，
 * 提交时统一走控制器的一次编辑，因此不会为每个按键产生一次请求。
 * @module coding-ppt-workbench/client/Stage
 */

import { useEffect, useRef, useState } from 'react'
import type { Translate } from 'coding-client-ui-slots'
import { SLIDE_SIZES, type PptDeck, type PptPage } from 'coding-ppt-model'
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
  readonly mediaUrl: (source: string) => string
  /** 选中元素时按 Delete/Backspace 删除。 */
  readonly onDeleteSelected: () => void
  /** 选中元素时按 Cmd/Ctrl+D 复制。 */
  readonly onDuplicateSelected: () => void
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
  deck, page, selectedId, editingId, busy, t, onSelect, onBeginEdit, onEndEdit, onMove, onResize, mediaUrl,
  onDeleteSelected, onDuplicateSelected,
}: StageProps) {
  const host = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ width: 0, height: 0 })
  const [draft, setDraft] = useState('')

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

  return (
    <div
      ref={host}
      className={css.stage}
      data-busy={busy ? 'true' : undefined}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (selectedId === null || editingId !== null) return
        if (event.key === 'Delete' || event.key === 'Backspace') {
          event.preventDefault()
          onDeleteSelected()
        }
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd') {
          event.preventDefault()
          onDuplicateSelected()
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
          interaction={{ onSelect, onBeginEdit, onMove, onResize }}
          emptyHint={t('emptyPage')}
          mediaUrl={mediaUrl}
        />
      ) : null}
    </div>
  )
}
