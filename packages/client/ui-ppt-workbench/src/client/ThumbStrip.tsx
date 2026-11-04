/** 页缩略图竖条：选页、增删页与页序调整；缩略图复用画布的同一套渲染。 */
import type { Translate } from 'coding-client-ui-slots'
import {
  IconChevronDownOutline14, IconChevronUpOutline14, IconTrashOutline16,
} from 'coding-client-ui-icons'
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
  readonly onAdd: () => void
  readonly onRemove: (page: PptPage) => void
  readonly onMove: (page: PptPage, to: number) => void
}

const THUMB_WIDTH = 128

/**
 * 左侧页列表。
 * @param props - 页序、当前页与页操作。
 * @returns 可滚动的缩略图竖条。
 */
export function ThumbStrip({ deck, pageIndex, busy, t, onSelect, onAdd, onRemove, onMove }: ThumbStripProps) {
  return (
    <aside className={css.strip} aria-label={t('title')}>
      <ul className={css.list}>
        {deck.pages.map((page, index) => (
          <li key={page.id} className={css.item} data-active={index === pageIndex ? 'true' : undefined}>
            <button
              type="button"
              className={css.button}
              aria-label={page.name}
              aria-current={index === pageIndex ? 'true' : undefined}
              onClick={() => { onSelect(index) }}
            >
              <span className={css.number}>{index + 1}</span>
              <SlideSurface deck={deck} page={page} width={THUMB_WIDTH} />
            </button>
            <div className={css.row}>
              <button
                type="button"
                className={css.tiny}
                disabled={busy || index === 0}
                title={t('movePageUp')}
                onClick={() => { onMove(page, index - 1) }}
              >
                <IconChevronUpOutline14 size={12} />
              </button>
              <button
                type="button"
                className={css.tiny}
                disabled={busy || index === deck.pages.length - 1}
                title={t('movePageDown')}
                onClick={() => { onMove(page, index + 1) }}
              >
                <IconChevronDownOutline14 size={12} />
              </button>
              <button
                type="button"
                className={css.tiny}
                disabled={busy || deck.pages.length === 1}
                title={t('deletePage')}
                onClick={() => { onRemove(page) }}
              >
                <IconTrashOutline16 size={12} />
              </button>
            </div>
          </li>
        ))}
      </ul>
      <button type="button" className={css.add} disabled={busy} onClick={onAdd}>{t('addPage')}</button>
    </aside>
  )
}
