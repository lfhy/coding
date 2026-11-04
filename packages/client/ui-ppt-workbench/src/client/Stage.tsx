/**
 * 画布：等比铺满可用空间，承载选中、拖动与就地编辑。草稿只存在于本组件，
 * 提交时统一走控制器的一次编辑，因此不会为每个按键产生一次请求。
 * @module coding-ppt-workbench/client/Stage
 */

import { useEffect, useRef, useState } from 'react'
import type { Translate } from 'coding-client-ui-slots'
import { SLIDE_SIZES, type PptDeck, type PptPage } from 'coding-ppt-model'
import type { PptWorkbenchKey } from './locales.ts'
import { SlideSurface } from './SlideSurface.tsx'
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
}

const MIN_WIDTH = 240

/**
 * 计算在容器内等比放大的画布宽度。
 * @param box - 可用宽高。
 * @param ratio - 画布的宽高比（基准像素）。
 * @returns 画布渲染宽度。
 */
export function fitWidth(box: { width: number; height: number }, ratio: number): number {
  const byWidth = box.width
  const byHeight = box.height * ratio
  return Math.max(MIN_WIDTH, Math.round(Math.min(byWidth, byHeight)))
}

/**
 * 画布区域。
 * @param props - 当前页、选择状态与交互回调。
 * @returns 自适应宽度的画布。
 */
export function Stage({
  deck, page, selectedId, editingId, busy, t, onSelect, onBeginEdit, onEndEdit, onMove,
}: StageProps) {
  const host = useRef<HTMLDivElement>(null)
  // 观察器报告之前先按一个常见宽度铺一次，避免首帧空白。
  const [box, setBox] = useState({ width: 960, height: 560 })
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
      setBox({ width: Math.max(rect.width - 32, MIN_WIDTH), height: Math.max(rect.height - 32, 120) })
    })
    observer.observe(node)
    return () => { observer.disconnect() }
  }, [])

  const size = SLIDE_SIZES[deck.size]
  const width = fitWidth(box, size.width / size.height)

  return (
    <div ref={host} className={css.stage} data-busy={busy ? 'true' : undefined}>
      {(
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
          interaction={{ onSelect, onBeginEdit, onMove }}
          emptyHint={t('emptyPage')}
        />
      )}
      <p className={css.hint}>{t('selectHint')}</p>
    </div>
  )
}
