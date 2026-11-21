/** 渠道和模型共用的上游格式菜单；空值保留调用层的继承规则。 */

import { useId, useRef, useState, type ReactNode, type RefObject } from 'react'
import { IconChevronDownOutline14 } from 'coding-client-ui-icons'
import { Menu } from 'coding-client-ui-primitives'
import styles from './ModelsSection.module.css'

const formatNames: Readonly<Record<string, string>> = {
  'openai-completions': 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages',
}

/**
 * @param protocol - 上游协议标识。
 * @returns 产品界面展示的协议名称。
 */
export function protocolName(protocol: string): string {
  return formatNames[protocol] ?? protocol
}

interface ProtocolPickerProps {
  label: string
  unsetLabel: string
  protocols: readonly string[]
  value: string | undefined
  disabled: boolean
  onChange: (protocol: string | undefined) => void
  triggerRef?: RefObject<HTMLButtonElement>
}

/**
 * 包装共享菜单，选中或按 Escape 后把焦点交回触发按钮。
 * @param props - 协议列表、继承显示和变更回调。
 * @returns 可用鼠标或键盘打开的字段控件。
 */
export function ProtocolPicker({ label, unsetLabel, protocols, value, disabled, onChange, triggerRef }: ProtocolPickerProps): ReactNode {
  const ownTrigger = useRef<HTMLButtonElement>(null)
  const trigger = triggerRef ?? ownTrigger
  const valueId = useId()
  const [open, setOpen] = useState(false)
  const text = value === undefined ? unsetLabel : protocolName(value)
  const closeAndFocus = (): void => {
    setOpen(false)
    trigger.current?.focus({ preventScroll: true })
  }
  return (
    <span className={styles['protocolMenu']} onKeyDown={(event) => {
      if (event.key !== 'Escape' || !open) return
      event.preventDefault()
      event.stopPropagation()
      closeAndFocus()
    }}>
      <Menu open={open && !disabled} portal portalContainer={trigger.current?.closest('[role="dialog"]') ?? null}
        compact matchAnchorWidth highlightSelected keyboardNavigation
        items={[{ id: '', label: unsetLabel }, ...protocols.map(id => ({ id, label: protocolName(id) }))]}
        selectedId={value ?? ''}
        onSelect={(id) => {
          const next = id || undefined
          if (next !== value) onChange(next)
          closeAndFocus()
        }}
        onClose={() => { setOpen(false) }}
        anchor={<button ref={trigger} type="button" className={`${styles['input']} ${styles['protocolTrigger']}`}
          aria-label={label} aria-describedby={valueId} aria-haspopup="menu" aria-expanded={open && !disabled} disabled={disabled}
          onClick={() => { setOpen(current => !current) }}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
            event.preventDefault()
            setOpen(true)
          }}>
          <span id={valueId} title={text}>{text}</span><IconChevronDownOutline14 size={14} />
        </button>}
      />
    </span>
  )
}
