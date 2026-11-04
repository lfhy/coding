/** 属性面板：选中元素时给位置、尺寸、文字与配色；未选中时改页面与文稿属性。 */
import { useEffect, useState } from 'react'
import type { Translate } from 'coding-client-ui-slots'
import { IconTrashOutline16 } from 'coding-client-ui-icons'
import type { PptDeck, PptElement, PptPage } from 'coding-ppt-model'
import type { PptWorkbenchKey } from './locales.ts'
import css from './Inspector.module.css'

/** 元素属性的提交载荷。 */
export interface ElementPatch {
  frame?: Partial<{ x: number; y: number; w: number; h: number }>
  text?: Partial<{ content: string; size: number; color: string; bold: boolean; align: string; valign: string }>
  fill?: string
  color?: string
  width?: number
}

export interface InspectorProps {
  readonly deck: PptDeck
  readonly page: PptPage
  readonly element: PptElement | null
  readonly busy: boolean
  readonly t: Translate<PptWorkbenchKey>
  readonly onElement: (patch: ElementPatch) => void
  readonly onRemove: () => void
  readonly onPage: (patch: { name?: string; background?: string | null }) => void
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
 * 右侧属性面板。
 * @param props - 当前页、选中元素与提交回调。
 * @returns 属性表单。
 */
export function Inspector({ deck, page, element, busy, t, onElement, onRemove, onPage, onDeck }: InspectorProps) {
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
          {element.kind === 'line' ? (
            <>
              <ColorField label={t('color')} value={element.color} disabled={busy}
                onCommit={(color) => { onElement({ color }) }} />
              <NumberField label={t('lineWidth')} value={element.width} min={1} max={40} disabled={busy}
                onCommit={(width) => { onElement({ width }) }} />
            </>
          ) : null}
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
