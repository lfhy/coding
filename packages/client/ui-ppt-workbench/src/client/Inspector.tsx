/** 属性面板：选中元素时给位置、尺寸、文字与配色；未选中时改页面与文稿属性。 */
import { useEffect, useState } from 'react'
import type { Translate } from 'coding-client-ui-slots'
import { IconTrashOutline16 } from 'coding-client-ui-icons'
import type { PptDeck, PptElement, PptPage, SlideTransition } from 'coding-ppt-model'
import type { PptWorkbenchKey } from './locales.ts'
import css from './Inspector.module.css'

/** 元素属性的提交载荷。 */
export interface ElementPatch {
  frame?: Partial<{ x: number; y: number; w: number; h: number }>
  text?: Partial<{
    content: string
    size: number
    color: string
    bold: boolean
    align: string
    valign: string
    font: string
  }>
  fill?: string
  color?: string
  width?: number
  source?: string
  fit?: 'cover' | 'contain'
  cells?: readonly (readonly { readonly content: string }[])[]
  animation?: 'none' | 'fade' | 'fly' | 'zoom' | 'wipe'
}

export interface InspectorProps {
  readonly deck: PptDeck
  readonly page: PptPage
  readonly element: PptElement | null
  readonly busy: boolean
  readonly t: Translate<PptWorkbenchKey>
  readonly onElement: (patch: ElementPatch) => void
  readonly onRemove: () => void
  readonly onDuplicate: () => void
  readonly onReorder: (to: 'front' | 'back' | 'forward' | 'backward') => void
  readonly onPage: (patch: { name?: string; background?: string | null; transition?: SlideTransition }) => void
  readonly onDeck: (patch: { title?: string; theme?: string; size?: '16:9' | '4:3' }) => void
}

function NumberField({
  label, value, min, max, disabled, onCommit,
}: {
  label: string
  value: number
  min: number
  max: number
  disabled: boolean
  onCommit: (value: number) => void
}) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => { setDraft(String(value)) }, [value])
  const commit = (): void => {
    const parsed = Number(draft)
    if (!Number.isFinite(parsed)) {
      setDraft(String(value))
      return
    }
    onCommit(Math.min(Math.max(parsed, min), max))
  }
  return (
    <label className={css.field}>
      <span>{label}</span>
      <input
        type="number"
        value={draft}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(event) => { setDraft(event.target.value) }}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === 'Enter') commit() }}
      />
    </label>
  )
}

function ColorField({
  label, value, disabled, onCommit,
}: {
  label: string
  value: string
  disabled: boolean
  onCommit: (value: string) => void
}) {
  return (
    <label className={css.field}>
      <span>{label}</span>
      <input
        type="color"
        value={value}
        disabled={disabled}
        onChange={(event) => { onCommit(event.target.value) }}
      />
    </label>
  )
}

function TextField({
  label, value, disabled, onCommit,
}: {
  label: string
  value: string
  disabled: boolean
  onCommit: (value: string) => void
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value) }, [value])
  return (
    <label className={css.field}>
      <span>{label}</span>
      <input
        type="text"
        value={draft}
        disabled={disabled}
        onChange={(event) => { setDraft(event.target.value) }}
        onBlur={() => { if (draft !== value) onCommit(draft) }}
        onKeyDown={(event) => { if (event.key === 'Enter' && draft !== value) onCommit(draft) }}
      />
    </label>
  )
}

/**
 * 表格单元格编辑：以制表符分列、换行分行的文本编辑整表内容。
 * @param props - 当前表格、忙碌状态、文案与提交回调。
 * @returns 文本域。
 */
function TableCellEditor({
  element, busy, t, onCommit,
}: {
  element: Extract<PptElement, { kind: 'table' }>
  busy: boolean
  t: Translate<PptWorkbenchKey>
  onCommit: (cells: readonly (readonly { readonly content: string }[])[]) => void
}) {
  const source = element.cells.map(row => row.map(cell => cell.content).join('\t')).join('\n')
  const [draft, setDraft] = useState(source)
  useEffect(() => { setDraft(source) }, [source])
  const commit = (): void => {
    if (draft === source) return
    const rows = draft.split('\n').map(line => line.split('\t'))
    const cells = Array.from({ length: element.rows }, (_, rowIndex) => (
      Array.from({ length: element.columns }, (_, columnIndex) => ({
        content: rows[rowIndex]?.[columnIndex] ?? '',
      }))
    ))
    onCommit(cells)
  }
  return (
    <label className={css.field}>
      <span>{t('cellsHint')}</span>
      <textarea
        className={css.cells}
        value={draft}
        disabled={busy}
        rows={Math.min(element.rows + 1, 8)}
        onChange={(event) => { setDraft(event.target.value) }}
        onBlur={commit}
      />
    </label>
  )
}

/**
 * 右侧属性面板。
 * @param props - 当前页、选中元素与提交回调。
 * @returns 属性表单。
 */
export function Inspector({
  deck, page, element, busy, t, onElement, onRemove, onDuplicate, onReorder, onPage, onDeck,
}: InspectorProps) {
  const background = page.background ?? '#000000'
  return (
    <aside className={css.panel}>
      <section className={css.group}>
        <h3 className={css.title}>{t('pageName')}</h3>
        <TextField label={t('pageName')} value={page.name} disabled={busy} onCommit={(name) => { onPage({ name }) }} />
        <ColorField label={t('background')} value={background} disabled={busy} onCommit={(color) => { onPage({ background: color }) }} />
        {page.background === null ? null : (
          <button type="button" className={css.link} disabled={busy} onClick={() => { onPage({ background: null }) }}>
            {t('themeLabel')}
          </button>
        )}
      </section>

      {element === null ? null : (
        <section className={css.group}>
          <h3 className={css.title}>{element.kind === 'text' ? t('text') : element.kind}</h3>
          <div className={css.grid}>
            <NumberField label={t('x')} value={element.x} min={-1000} max={4000} disabled={busy}
              onCommit={(x) => { onElement({ frame: { x } }) }} />
            <NumberField label={t('y')} value={element.y} min={-1000} max={4000} disabled={busy}
              onCommit={(y) => { onElement({ frame: { y } }) }} />
            <NumberField label={t('w')} value={element.w} min={0} max={4000} disabled={busy}
              onCommit={(w) => { onElement({ frame: { w } }) }} />
            <NumberField label={t('h')} value={element.h} min={0} max={4000} disabled={busy}
              onCommit={(h) => { onElement({ frame: { h } }) }} />
          </div>
          {element.kind === 'text' ? (
            <>
              <NumberField label={t('textSize')} value={element.text.size} min={6} max={400} disabled={busy}
                onCommit={(size) => { onElement({ text: { size } }) }} />
              <label className={css.check}>
                <input
                  type="checkbox"
                  checked={element.text.bold}
                  disabled={busy}
                  onChange={(event) => { onElement({ text: { bold: event.target.checked } }) }}
                />
                <span>{t('bold')}</span>
              </label>
              <label className={css.field}>
                <span>{t('align')}</span>
                <select
                  value={element.text.align}
                  disabled={busy}
                  onChange={(event) => { onElement({ text: { align: event.target.value } }) }}
                >
                  <option value="left">{t('alignLeft')}</option>
                  <option value="center">{t('alignCenter')}</option>
                  <option value="right">{t('alignRight')}</option>
                </select>
              </label>
              <ColorField label={t('color')} value={element.text.color} disabled={busy}
                onCommit={(color) => { onElement({ text: { color } }) }} />
            </>
          ) : null}
          {element.kind === 'rect' || element.kind === 'ellipse' ? (
            <ColorField label={t('fill')} value={element.fill} disabled={busy}
              onCommit={(fill) => { onElement({ fill }) }} />
          ) : null}
          {element.kind === 'table' ? (
            <TableCellEditor element={element} busy={busy} t={t} onCommit={(cells) => { onElement({ cells }) }} />
          ) : null}
          {element.kind === 'line' ? (
            <>
              <ColorField label={t('color')} value={element.color} disabled={busy}
                onCommit={(color) => { onElement({ color }) }} />
              <NumberField label={t('lineWidth')} value={element.width} min={1} max={40} disabled={busy}
                onCommit={(width) => { onElement({ width }) }} />
            </>
          ) : null}
          <label className={css.field}>
            <span>{t('animation')}</span>
            <select
              value={element.animation ?? 'none'}
              disabled={busy}
              onChange={(event) => { onElement({ animation: event.target.value as 'none' }) }}
            >
              <option value="none">{t('animationNone')}</option>
              <option value="fade">{t('animationFade')}</option>
              <option value="fly">{t('animationFly')}</option>
              <option value="zoom">{t('animationZoom')}</option>
              <option value="wipe">{t('animationWipe')}</option>
            </select>
          </label>
          <div className={css.row}>
            <button type="button" className={css.link} disabled={busy} onClick={onDuplicate}>{t('duplicate')}</button>
            <button type="button" className={css.link} disabled={busy} onClick={() => { onReorder('front') }}>{t('bringFront')}</button>
            <button type="button" className={css.link} disabled={busy} onClick={() => { onReorder('back') }}>{t('sendBack')}</button>
            <button type="button" className={css.link} disabled={busy} onClick={() => { onReorder('forward') }}>{t('forward')}</button>
            <button type="button" className={css.link} disabled={busy} onClick={() => { onReorder('backward') }}>{t('backward')}</button>
          </div>
          <button type="button" className={css.danger} disabled={busy} onClick={onRemove}>
            <IconTrashOutline16 size={14} />
            {t('deleteElement')}
          </button>
        </section>
      )}

      <section className={css.group}>
        <h3 className={css.title}>{t('title')}</h3>
        <TextField label={t('newDeckTitle')} value={deck.title} disabled={busy}
          onCommit={(title) => { onDeck({ title }) }} />
        <label className={css.field}>
          <span>{t('themeLabel')}</span>
          <select value={deck.theme} disabled={busy} onChange={(event) => { onDeck({ theme: event.target.value }) }}>
            <option value="ink">{t('themeInk')}</option>
            <option value="paper">{t('themePaper')}</option>
            <option value="ocean">{t('themeOcean')}</option>
            <option value="forest">{t('themeForest')}</option>
          </select>
        </label>
        <label className={css.field}>
          <span>{t('sizeLabel')}</span>
          <select
            value={deck.size}
            disabled={busy}
            onChange={(event) => {
              if (event.target.value === '16:9' || event.target.value === '4:3') onDeck({ size: event.target.value })
            }}
          >
            <option value="16:9">16:9</option>
            <option value="4:3">4:3</option>
          </select>
        </label>
      </section>
    </aside>
  )
}
