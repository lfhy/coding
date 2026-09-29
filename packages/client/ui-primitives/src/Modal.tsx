// Modal: controlled full-viewport dialog (create-workspace and similar).
// The overlay portals to this document's body so ancestor stacking contexts
// cannot leave sticky page controls above the mask. This is still an in-page
// WebUI dialog; it never creates or targets another browser/native window.

import { useEffect, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-icons'
import css from './Modal.module.css'

/**
 * 在当前文档中渲染居中的遮罩对话框。
 * @param props.open - 是否显示。
 * @param props.onClose - Escape 或遮罩点击时的关闭请求。
 * @param props.title - 可见标题；默认也作为对话框的无障碍名称。
 * @param props.ariaLabel - 可选的独立无障碍名称，用于同名的多行编辑窗口。
 * @param props.closeLabel - 关闭按钮的本地化名称。
 * @param props.description - 标题下方的可选说明。
 * @param props.children - 表单内容。
 * @param props.footer - 取消与提交等操作。
 * @param props.contentClassName - 可滚动内容区的可选类名。
 * @param props.headless - 只复用遮罩、窗口和 Escape 行为，由调用方绘制窗口内部。
 * @param props.trapFocus - 阻止 Tab 离开当前对话框；嵌套设置窗口等阻断交互时启用。
 * @returns 关闭时为 null，打开时为文档内的遮罩与对话框。
 */
export function Modal({
  open, onClose, title, ariaLabel, closeLabel = 'Close', description, children, footer, className, contentClassName,
  headless = false, trapFocus = false,
}: {
  open: boolean
  onClose: () => void
  title: string
  ariaLabel?: string
  closeLabel?: string
  description?: string
  children?: ReactNode
  footer?: ReactNode
  className?: string
  contentClassName?: string
  headless?: boolean
  trapFocus?: boolean
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const onDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!trapFocus || event.key !== 'Tab' || event.defaultPrevented) return
    const dialog = dialogRef.current
    if (dialog === null) return
    const focusable = [...dialog.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    )].filter(node => getComputedStyle(node).visibility !== 'hidden')
    const first = focusable[0]
    const last = focusable.at(-1)
    if (first === undefined || last === undefined) return
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus({ preventScroll: true })
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus({ preventScroll: true })
    }
  }
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [open, onClose])

  if (!open) return null

  return createPortal((
    <div className={css.root} role="presentation">
      <div className={css.mask} aria-hidden="true" onClick={onClose} />
      <div
        ref={dialogRef}
        className={clsx(css.dialog, className)}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel ?? title}
        onKeyDown={onDialogKeyDown}
      >
        {headless
          ? children
          : (
            <>
              <div className={clsx(css.content, contentClassName)}>
                <div className={css.header}>
                  <h2 className={css.title}>{title}</h2>
                  <button type="button" className={css.close} aria-label={closeLabel} onClick={onClose}>
                    <IconCloseOutline16 size={14} />
                  </button>
                </div>
                {description !== undefined && description !== '' && (
                  <p className={css.description}>{description}</p>
                )}
                {children !== undefined && <div className={css.body}>{children}</div>}
              </div>
              {footer !== undefined && <div className={css.footer}>{footer}</div>}
            </>
          )}
      </div>
    </div>
  ), document.body)
}
