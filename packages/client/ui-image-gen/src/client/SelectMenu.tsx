/** 生成面板的单选下拉：复用客户端 Menu 控件，触发器沿用项目表单控件样式。 */
import { useState } from 'react'
import { IconChevronDownOutline14, Menu, type MenuEntry } from 'coding-client-ui-primitives'
import css from './SelectMenu.module.css'

/** 下拉框的一项显示值与稳定值。 */
export interface SelectMenuOption {
  id: string
  label: string
  /** 触发器空间不足时可使用更短的显示文本。 */
  displayLabel?: string
}
/** 受控下拉框参数。 */
export interface SelectMenuProps {
  label: string
  value: string
  options: readonly SelectMenuOption[]
  onChange: (value: string) => void
  disabled?: boolean
}
/**
 * 用共享 Menu 呈现选项，避免原生 select 弹出浏览器自己的样式。
 * @param props - 当前值、选项、可访问名称与变更回调。
 * @returns 与项目菜单一致的受控下拉框。
 */
export function SelectMenu({ label, value, options, onChange, disabled = false }: SelectMenuProps) {
  const [open, setOpen] = useState(false)
  const current = options.find(option => option.id === value)
  const items: readonly MenuEntry[] = options.map(option => ({ id: option.id, label: option.label }))
  return <span className={css.root}>
    <Menu
      open={open && !disabled}
      anchor={<button type="button" className={css.trigger} aria-label={label}
        aria-haspopup="menu" aria-expanded={open && !disabled} disabled={disabled}
        onClick={() => { setOpen(value => !value) }}>
        <span className={css.label}>{current?.displayLabel ?? current?.label ?? value}</span>
        <IconChevronDownOutline14 className={open ? css.chevronOpen : css.chevron} size={14} />
      </button>}
      items={items}
      selectedId={value}
      onSelect={(id) => {
        setOpen(false)
        if (id !== value) onChange(id)
      }}
      onClose={() => { setOpen(false) }}
      portal
      matchAnchorWidth
      keyboardNavigation
    />
  </span>
}
