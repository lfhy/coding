/** 笔记只提供能保存到原生文档的格式操作；排布参照桌面办公软件的分区工具栏。 */
import { useEffect, useId, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { Button, Icon, IconChevronDownOutline14, Input, Menu, Modal, Tooltip, type IconName } from 'coding-client-ui-primitives'
import type { PropsLocale } from 'coding-client-ui-slots'
import type { OfficeKind, ParagraphAlign, ParagraphStyle } from './office-document.ts'
import type { OfficeFormat } from './univer-engine.ts'
import type { NS, OfficeLocaleKey } from './locales.ts'
import css from './OfficeEditor.module.css'

type Translate = PropsLocale<typeof NS>['t']
type ColorKey = 'textColor' | 'background'
type Choice = { id: string; label: string; action: OfficeFormat }

const HISTORY = [['undo', 'undo'], ['redo', 'redo']] as const satisfies readonly (readonly [OfficeLocaleKey, IconName])[]
const INLINE = [
  ['bold', 'format-bold'], ['italic', 'format-italic'], ['underline', 'format-underline'], ['strike', 'format-strike'],
] as const satisfies readonly (readonly [OfficeLocaleKey, IconName])[]
const STYLES: readonly ParagraphStyle[] = ['normal', 'title', 'heading1', 'heading2', 'heading3']
const ALIGNS = [
  ['left', 'format-align-left'], ['center', 'format-align-center'],
  ['right', 'format-align-right'], ['justify', 'format-align-justify'],
] as const satisfies readonly (readonly [ParagraphAlign, IconName])[]
const FONT_SIZES = [10, 11, 12, 14, 16, 18, 24, 32, 48]
const NUMBER_FORMATS = [
  ['general', 'General'], ['decimal', '0.00'], ['percentage', '0.00%'], ['date', 'yyyy-mm-dd'],
] as const
// 常用色板：灰阶与高饱和主色，和桌面办公软件的默认色板一致。
const PALETTE = ['#000000', '#262626', '#595959', '#8c8c8c', '#d9d9d9', '#ffffff',
  '#c00000', '#e36c09', '#f1c232', '#76923c', '#38761d', '#0b8a8f', '#1f6fc5', '#3f51b5', '#7b4fa6', '#c0398f']

/**
 * 从共享菜单或按钮调用当前选区的格式动作。
 * 工具栏按桌面办公软件的习惯分区：历史｜行内样式｜段落样式｜对齐｜字号｜颜色（Excel 为数字格式｜颜色｜合并）。
 * @param props - 文档类型、就绪状态、词典与格式动作回调。
 * @returns 分区的格式工具栏。
 */
export function FormatToolbar({ kind, disabled, t, format }: {
  kind: OfficeKind
  disabled: boolean
  t: Translate
  format: (action: OfficeFormat) => void
}) {
  useKeepCanvasFocus()
  const [open, setOpen] = useState('')
  const [color, setColor] = useState<{ key: ColorKey; value: string; invalid: boolean } | null>(null)
  const baseId = useId()
  const run = (action: OfficeFormat) => { setOpen(''); format(action) }
  const toggle = (key: string) => { setOpen(open === key ? '' : key) }
  const styleChoices: Choice[] = STYLES.map(value => ({ id: value, label: t(value), action: { key: 'style', value } }))
  const fontChoices: Choice[] = FONT_SIZES.map(value => ({ id: `${value}`, label: `${value}`, action: { key: 'fontSize', value } }))
  const numberChoices: Choice[] = NUMBER_FORMATS.map(([id, value]) => ({ id, label: t(id), action: { key: 'numberFormat', value } }))
  const mergeChoices: Choice[] = (['merge', 'unmerge'] as const).map(key => ({ id: key, label: t(key), action: { key } }))
  const pickFrom = (choices: readonly Choice[]) => (id: string) => {
    const chosen = choices.find(item => item.id === id)?.action
    if (chosen !== undefined) run(chosen)
  }

  return <div className={css.formatting} role="group" aria-label={t('formatting')}>
    <div className={css.toolGroup} role="group" aria-label={t('history')}>
      {HISTORY.map(([key, icon]) => <ToolButton key={key} label={t(key)} disabled={disabled} onRun={() => { run({ key }) }}>
        <Icon name={icon} /></ToolButton>)}
    </div>
    <Separator />
    <div className={css.toolGroup} role="group" aria-label={t('inlineStyles')}>
      {INLINE.map(([key, icon]) => <ToolButton key={key} label={t(key)} disabled={disabled} onRun={() => { run({ key }) }}>
        <Icon name={icon} /></ToolButton>)}
    </div>
    <Separator />
    {kind === 'word' ? <>
      <Picker label={t('style')} open={open === 'style'} disabled={disabled} onToggle={() => { toggle('style') }}
        items={styleChoices} onClose={() => { setOpen('') }} onSelect={pickFrom(styleChoices)} />
      <Separator />
      <div className={css.toolGroup} role="group" aria-label={t('align')}>
        {ALIGNS.map(([value, icon]) => <ToolButton key={value} label={t(value)} disabled={disabled} onRun={() => { run({ key: 'align', value }) }}>
          <Icon name={icon} /></ToolButton>)}
      </div>
      <Separator />
      <Picker label={t('fontSize')} icon="format-font-size" open={open === 'fontSize'} disabled={disabled}
        onToggle={() => { toggle('fontSize') }} items={fontChoices} onClose={() => { setOpen('') }} onSelect={pickFrom(fontChoices)} />
      <ColorPicker label={t('textColor')} icon="format-text-color" open={open === 'textColor'} disabled={disabled}
        onToggle={() => { toggle('textColor') }} onClose={() => { setOpen('') }}
        onSelect={(value) => { run({ key: 'textColor', value }) }} onCustom={() => { setColor({ key: 'textColor', value: '', invalid: false }) }} t={t} />
    </> : <>
      <Picker label={t('numberFormat')} open={open === 'numberFormat'} disabled={disabled} onToggle={() => { toggle('numberFormat') }}
        items={numberChoices} onClose={() => { setOpen('') }} onSelect={pickFrom(numberChoices)} />
      <Separator />
      <ColorPicker label={t('textColor')} icon="format-text-color" open={open === 'textColor'} disabled={disabled}
        onToggle={() => { toggle('textColor') }} onClose={() => { setOpen('') }}
        onSelect={(value) => { run({ key: 'textColor', value }) }} onCustom={() => { setColor({ key: 'textColor', value: '', invalid: false }) }} t={t} />
      <ColorPicker label={t('background')} icon="format-fill-color" open={open === 'background'} disabled={disabled}
        onToggle={() => { toggle('background') }} onClose={() => { setOpen('') }}
        onSelect={(value) => { run({ key: 'background', value }) }} onCustom={() => { setColor({ key: 'background', value: '', invalid: false }) }} t={t} />
      <Separator />
      <div className={css.toolGroup} role="group" aria-label={t('merge')}>
        {mergeChoices.map(({ id, label, action }) => <ToolButton key={id} label={label} disabled={disabled} onRun={() => { run(action) }}>
          <Icon name="format-merge" /></ToolButton>)}
      </div>
    </>}
    {color !== null && <Modal open trapFocus title={t(color.key)} closeLabel={t('close')} onClose={() => { setColor(null) }}
      footer={<Button type="submit" form={`${baseId}-color`} variant="primary">{t('apply')}</Button>}>
      <form id={`${baseId}-color`} className={css.colorForm} onSubmit={(event) => {
        event.preventDefault()
        const value = color.value.trim()
        if (!/^#[a-f0-9]{6}$/i.test(value)) {
          setColor({ ...color, invalid: true })
          return
        }
        format({ key: color.key, value })
        setColor(null)
      }}>
        <label htmlFor={`${baseId}-color-value`}>{t('colorField')}</label>
        <Input id={`${baseId}-color-value`} value={color.value} placeholder="#336699" autoFocus
          aria-invalid={color.invalid} aria-describedby={color.invalid ? `${baseId}-color-error` : undefined}
          onChange={(event) => { setColor({ ...color, value: event.target.value, invalid: false }) }} />
        {color.invalid && <p role="alert" id={`${baseId}-color-error`} className={css.error}>{t('invalidColor')}</p>}
      </form>
    </Modal>}
  </div>
}

/** 分区之间的竖线；无障碍名称由相邻分组的组名提供。 */
function Separator() {
  return <span className={css.toolSeparator} role="separator" aria-orientation="vertical" />
}

/** 本工具栏浮层的标记；portal 到 body 后仍能据此识别归属。 */
const OWNED_MENU = 'data-office-format-menu'

/**
 * 本工具栏浮层（下拉列表、色板）的 portal 容器。它挂在 body 下并带标记，
 * 捕获阶段的「保持画布焦点」逻辑据此识别自己的浮层，不影响其它菜单。
 */
function useFormatPortal(): Element {
  const portal = useMemo(() => {
    const node = document.createElement('div')
    node.setAttribute(OWNED_MENU, '')
    return node
  }, [])
  useEffect(() => {
    document.body.append(portal)
    return () => { portal.remove() }
  }, [portal])
  return portal
}

/**
 * 列表里的行、色块和图标按钮都会抢走画布焦点，选区随之失效。
 * 工具栏存活期间在捕获阶段拦下自己浮层的按下事件（只阻止夺焦，不阻止点击），选区保留到命令执行。
 */
function useKeepCanvasFocus(): void {
  useEffect(() => {
    const keep = (event: MouseEvent) => {
      const target = event.target
      if (target instanceof Element && target.closest(`[${OWNED_MENU}]`) !== null) event.preventDefault()
    }
    document.addEventListener('mousedown', keep, true)
    return () => { document.removeEventListener('mousedown', keep, true) }
  }, [])
}

/** 带悬停说明的方形图标按钮；按下时不抢走画布焦点。 */
function ToolButton({ label, disabled, onRun, children }: {
  label: string
  disabled: boolean
  onRun: () => void
  children: ReactNode
}) {
  return <Tooltip label={label} side="bottom">
    <Button size="sm" variant="ghost" className={css.tool} icon={children} disabled={disabled} aria-label={label}
      onMouseDown={(event) => { event.preventDefault() }} onClick={onRun} />
  </Tooltip>
}

/** 触发一个下拉列表的按钮；列表显示当前分组的名称。 */
function Picker({ label, icon, open, disabled, onToggle, items, onClose, onSelect }: {
  label: string
  icon?: IconName
  open: boolean
  disabled: boolean
  onToggle: () => void
  items: readonly Choice[]
  onClose: () => void
  onSelect: (id: string) => void
}) {
  const portal = useFormatPortal()
  return <Menu open={open && !disabled} portal portalContainer={portal} matchAnchorWidth keyboardNavigation
    anchor={<Button size="sm" variant="ghost" className={css.picker} aria-haspopup="menu" aria-expanded={open && !disabled}
      icon={icon === undefined ? undefined : <Icon name={icon} />} disabled={disabled} aria-label={label}
      onMouseDown={(event) => { event.preventDefault() }} onClick={onToggle}>
      {label}<IconChevronDownOutline14 className={css.pickerArrow} />
    </Button>}
    items={items.map(({ id, label: text }) => ({ id, label: text }))} onClose={onClose} onSelect={onSelect} />
}

/** 色板浮层：常用色一排点选，底部进入自定义十六进制输入。 */
function ColorPicker({ label, icon, open, disabled, onToggle, onClose, onSelect, onCustom, t }: {
  label: string
  icon: IconName
  open: boolean
  disabled: boolean
  onToggle: () => void
  onClose: () => void
  onSelect: (value: string) => void
  onCustom: () => void
  t: Translate
}) {
  const portal = useFormatPortal()
  return <Menu open={open && !disabled} portal portalContainer={portal} onClose={onClose} onSelect={() => { onCustom() }}
    anchor={<Button size="sm" variant="ghost" className={css.picker} aria-haspopup="menu" aria-expanded={open && !disabled}
      disabled={disabled} aria-label={label} onMouseDown={(event) => { event.preventDefault() }} onClick={onToggle}>
      <Icon name={icon} /><IconChevronDownOutline14 className={css.pickerArrow} />
    </Button>}
    items={[{ id: 'custom', label: t('customColor') }]}
    header={<div role="group" aria-label={label} className={css.palette}>
      {PALETTE.map(value => <button key={value} type="button" className={css.swatch} style={{ '--swatch': value } as CSSProperties}
        aria-label={value} title={value} onClick={() => { onClose(); onSelect(value) }} />)}
    </div>} />
}
