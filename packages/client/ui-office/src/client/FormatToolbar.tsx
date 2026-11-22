/** 笔记只提供能保存到原生文档的格式操作。 */
import { useState } from 'react'
import { Button, Icon, IconChevronDownOutline14, Input, Menu, Modal, type IconName } from 'coding-client-ui-primitives'
import type { PropsLocale } from 'coding-client-ui-slots'
import type { OfficeKind, ParagraphAlign, ParagraphStyle } from './office-document.ts'
import type { OfficeFormat } from './univer-engine.ts'
import type { NS, OfficeLocaleKey } from './locales.ts'
import css from './OfficeEditor.module.css'

type Translate = PropsLocale<typeof NS>['t']
type ColorKey = 'textColor' | 'background'
type Entry = { id: string; label: string; action?: OfficeFormat; color?: ColorKey }

const INLINE = [
  ['undo', 'undo'], ['redo', 'redo'], ['bold', 'format-bold'], ['italic', 'format-italic'],
  ['underline', null], ['strike', null],
] as const satisfies readonly (readonly [OfficeLocaleKey, IconName | null])[]
const STYLES: readonly ParagraphStyle[] = ['normal', 'title', 'heading1', 'heading2', 'heading3']
const ALIGNS: readonly ParagraphAlign[] = ['left', 'center', 'right', 'justify']
const NUMBER_FORMATS = [
  ['general', 'General'], ['decimal', '0.00'], ['percentage', '0.00%'], ['date', 'yyyy-mm-dd'],
] as const

/** 从共享菜单或按钮调用当前选区的格式动作。 */
export function FormatToolbar({ kind, disabled, t, format }: {
  kind: OfficeKind
  disabled: boolean
  t: Translate
  format: (action: OfficeFormat) => void
}) {
  const [open, setOpen] = useState('')
  const [color, setColor] = useState<{ key: ColorKey; value: string; invalid: boolean } | null>(null)
  const colorActions: Entry[] = [
    { id: 'textColor', label: t('textColor'), color: 'textColor' },
    ...(kind === 'excel' ? [{ id: 'background', label: t('background'), color: 'background' as const }] : []),
  ]
  const groups: readonly (readonly [OfficeLocaleKey, readonly Entry[]])[] = kind === 'word'
    ? [
      ['style', STYLES.map(value => ({ id: value, label: t(value), action: { key: 'style', value } }))],
      ['align', ALIGNS.map(value => ({ id: value, label: t(value), action: { key: 'align', value } }))],
      ['fontSize', [10, 11, 12, 14, 16, 18, 24, 32, 48].map(value => ({
        id: `${value}`, label: `${value} pt`, action: { key: 'fontSize', value },
      }))],
      ['textColor', colorActions],
    ]
    : [
      ['numberFormat', NUMBER_FORMATS.map(([id, value]) => ({ id, label: t(id), action: { key: 'numberFormat', value } }))],
      ['textColor', colorActions],
      ['merge', (['merge', 'unmerge'] as const).map(key => ({ id: key, label: t(key), action: { key } }))],
    ]
  return <div className={css.formatting} role="group" aria-label={t('formatting')}>
    {INLINE.map(([key, icon]) => <Button key={key} size="sm" variant="toolbar" aria-label={t(key)} title={t(key)}
      icon={icon === null ? undefined : <Icon name={icon} />} disabled={disabled}
      onMouseDown={(event) => { event.preventDefault() }} onClick={() => { format({ key }) }}>
      {icon === null && t(key)}
    </Button>)}
    {groups.map(([key, items]) => <Menu key={key} open={open === key && !disabled} portal keyboardNavigation
      anchor={<Button size="sm" variant="toolbar" icon={<IconChevronDownOutline14 />} disabled={disabled}
        aria-haspopup="menu" aria-expanded={open === key && !disabled} onMouseDown={(event) => { event.preventDefault() }}
        onClick={() => { setOpen(open === key ? '' : key) }}>{t(key)}</Button>}
      items={items.map(({ id, label }) => ({ id, label }))} onClose={() => { setOpen('') }} onSelect={(id) => {
        setOpen('')
        const entry = items.find(item => item.id === id)
        if (entry?.action !== undefined) format(entry.action)
        if (entry?.color !== undefined) setColor({ key: entry.color, value: '', invalid: false })
      }} />)}
    {color !== null && <Modal open trapFocus title={t(color.key)} closeLabel={t('close')} onClose={() => { setColor(null) }}
      footer={<Button type="submit" form="note-office-color" variant="primary">{t('apply')}</Button>}>
      <form id="note-office-color" className={css.colorForm} onSubmit={(event) => {
        event.preventDefault()
        const value = color.value.trim()
        if (!/^#[a-f0-9]{6}$/i.test(value)) {
          setColor({ ...color, invalid: true })
          return
        }
        format({ key: color.key, value })
        setColor(null)
      }}>
        <label htmlFor="note-office-color-value">{t('colorField')}</label>
        <Input id="note-office-color-value" value={color.value} placeholder="#336699" autoFocus
          aria-invalid={color.invalid} aria-describedby={color.invalid ? 'note-office-color-error' : undefined}
          onChange={(event) => { setColor({ ...color, value: event.target.value, invalid: false }) }} />
        {color.invalid && <p role="alert" id="note-office-color-error" className={css.error}>{t('invalidColor')}</p>}
      </form>
    </Modal>}
  </div>
}
