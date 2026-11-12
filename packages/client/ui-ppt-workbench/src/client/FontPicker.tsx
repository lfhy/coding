/**
 * 字体选择器：按钮展开带预览的列表，每一项用该字体自身渲染示例字。
 *
 * 选项只来自宿主下发的「本机已安装字体」，再加上当前元素字体与默认字体——
 * 默认字体即使本机没装也留在首位，导入稿里的族名同样不会因为没装而消失。
 * 只负责选值，写入 `font` 由调用方提交。
 * @module coding-client-ui-ppt-workbench/client/FontPicker
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { IconChevronDownOutline14 } from 'coding-client-ui-icons'
import { DEFAULT_FONT_FAMILY, fontStack } from 'coding-ppt-model'
import css from './FontPicker.module.css'

/** 字体选择器属性。 */
export interface FontPickerProps {
  /** 元素上的字体族名；空串表示跟随默认字体。 */
  readonly value: string
  /** 本机已安装的字体族，由宿主读取；可能为空。 */
  readonly fonts: readonly string[]
  readonly disabled: boolean
  /** 控件的无障碍名称，例如「字体」。 */
  readonly label: string
  /** 默认字体在列表里的显示名，例如「HarmonyOS Sans SC（默认）」；由文案层给出。 */
  readonly defaultLabel: string
  readonly searchPlaceholder: string
  readonly emptyHint: string
  /** 选中一项时回调；值就是字体族名。 */
  readonly onChange: (font: string) => void
}

/** 预览用的示例字：汉字与西文各一截，让中英文观感同时可见。 */
const SAMPLE = '永和 Aa 123'

/**
 * 字体选择器。
 * @param props - 当前值、可选字体、文案与提交回调。
 * @returns 触发按钮与按需展开的预览列表。
 */
export function FontPicker({
  value, fonts, disabled, label, defaultLabel, searchPlaceholder, emptyHint, onChange,
}: FontPickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const trigger = useRef<HTMLButtonElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const popover = useRef<HTMLDivElement>(null)

  const current = value.trim() === '' ? DEFAULT_FONT_FAMILY : value
  const choices = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase()
    const families = [current, ...fonts.filter(name => name !== current)]
    return keyword === '' ? families : families.filter(name => name.toLocaleLowerCase().includes(keyword))
  }, [current, fonts, query])

  // 展开期间点击别处就收起；焦点留在触发按钮上，键盘用户不会迷路。
  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null
      if (target !== null && popover.current?.contains(target)) return
      if (target !== null && trigger.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => { document.removeEventListener('pointerdown', onPointerDown) }
  }, [open])

  const openList = (): void => {
    setQuery('')
    setActive(0)
    setOpen(true)
    // 展开后再聚焦搜索框：渲染完成前 ref 还是空的。
    queueMicrotask(() => { search.current?.focus() })
  }

  const commit = (font: string): void => {
    onChange(font)
    setOpen(false)
    trigger.current?.focus()
  }

  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive(index => Math.min(choices.length - 1, index + 1))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive(index => Math.max(0, index - 1))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const picked = choices[active]
      if (picked !== undefined) commit(picked)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
      trigger.current?.focus()
    }
  }

  return (
    <div className={css.root}>
      <span className={css.label}>{label}</span>
      <button
        ref={trigger}
        type="button"
        className={css.trigger}
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={disabled}
        data-testid="font-picker-trigger"
        onClick={() => { if (open) setOpen(false); else openList() }}
      >
        <span className={css.current} style={{ fontFamily: fontStack(value) }}>{current}</span>
        <IconChevronDownOutline14 className={css.caret} />
      </button>
      {open ? (
        <div ref={popover} className={css.popover}>
          <input
            ref={search}
            className={css.search}
            value={query}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            onChange={(event) => { setQuery(event.target.value); setActive(0) }}
            onKeyDown={onSearchKeyDown}
          />
          <div className={css.list} role="listbox" aria-label={label}>
            {choices.length === 0 ? <p className={css.empty}>{emptyHint}</p> : null}
            {choices.map((name, index) => (
              <button
                key={name}
                type="button"
                role="option"
                aria-selected={name === current}
                className={css.option}
                data-active={index === active ? 'true' : undefined}
                onMouseEnter={() => { setActive(index) }}
                onClick={() => { commit(name) }}
              >
                {/* 示例字与族名都用该字体本身渲染，选之前就能看出字形。 */}
                <span className={css.sample} style={{ fontFamily: fontStack(name) }}>{SAMPLE}</span>
                <span className={css.family} style={{ fontFamily: fontStack(name) }}>
                  {name === DEFAULT_FONT_FAMILY ? defaultLabel : name}
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}
