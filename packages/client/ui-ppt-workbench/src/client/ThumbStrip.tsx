/** 页缩略图竖条：选页与拖拽排序；缩略图复用画布的同一套渲染。 */
import { useState } from 'react'
import type { Translate } from 'coding-client-ui-slots'
import { IconPanelLeftOutline16 } from 'coding-client-ui-icons'
import type { PptDeck, PptPage } from 'coding-ppt-model'
import type { PptWorkbenchKey } from './locales.ts'
import { SlideSurface } from './SlideSurface.tsx'
import css from './ThumbStrip.module.css'

export interface ThumbStripProps {
  readonly deck: PptDeck
  readonly pageIndex: number
  readonly busy: boolean
  readonly t: Translate<PptWorkbenchKey>
  readonly onSelect: (index: number) => void
  readonly onHide: () => void
  readonly onMove: (page: PptPage, to: number) => void
}

const THUMB_WIDTH = 88

/**
 * 左侧页列表。
 * @param props - 页序、当前页与页操作。
 * @returns 可滚动的缩略图竖条。
 */
export function ThumbStrip({ deck, pageIndex, busy, t, onSelect, onHide, onMove }: ThumbStripProps) {
  const [dragging, setDragging] = useState<string | null>(null)
  return (
    <aside className={css.strip} aria-label={t('title')}>
      <div className={css.header}>
        <span>{t('pages', { count: deck.pages.length })}</span>
        <button type="button" className={css.hide} aria-label={t('hideThumbs')}
          title={t('hideThumbs')} onClick={onHide}>
          <IconPanelLeftOutline16 size={16} />
        </button>
      </div>
      <ul className={css.list}>
        {deck.pages.map((page, index) => (
          <li
            key={page.id}
            className={css.item}
            data-active={index === pageIndex ? 'true' : undefined}
            data-dragging={dragging === page.id ? 'true' : undefined}
            draggable={!busy}
            onDragStart={(event) => {
              if (busy) { event.preventDefault(); return }
              setDragging(page.id)
            }}
            onDragEnd={() => { setDragging(null) }}
            onDragOver={(event) => { if (!busy) event.preventDefault() }}
            onDrop={(event) => {
              event.preventDefault()
              const from = deck.pages.findIndex(entry => entry.id === dragging)
              const source = deck.pages[from]
              setDragging(null)
              if (!busy && source !== undefined && from !== index) onMove(source, index)
            }}
          >
            <button
              type="button"
              className={css.button}
              aria-label={page.name}
              aria-current={index === pageIndex ? 'true' : undefined}
              onClick={() => { onSelect(index) }}
            >
              <span className={css.number}>{index + 1}</span>
              <span className={css.preview}><SlideSurface deck={deck} page={page} width={THUMB_WIDTH} /></span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  )
}
