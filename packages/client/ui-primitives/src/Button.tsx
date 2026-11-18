import { forwardRef } from 'react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import clsx from 'clsx'
import css from './Button.module.css'

/** 按钮的主题呈现，各变体使用对应的语义填充令牌。 */
export type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'toolbar'

/**
 * 渲染共享按钮，保留原生属性和供弹层恢复焦点的引用。
 * @param props - 视觉变体、尺寸、前导图标和原生按钮属性。
 * @param ref - 按钮节点的引用。
 * @returns 主题化的原生按钮。
 */
export const Button = forwardRef<HTMLButtonElement, {
  variant?: ButtonVariant
  size?: 'md' | 'sm'
  icon?: ReactNode
  className?: string | undefined
  children?: ReactNode
} & ButtonHTMLAttributes<HTMLButtonElement>>(
  function Button({ variant = 'ghost', size = 'md', icon, className, children, ...rest }, ref) {
    return (
      <button ref={ref} type="button" className={clsx(css.button, css[variant], css[size], className)} {...rest}>
        {icon != null && <span className={css.icon}>{icon}</span>}
        {children}
      </button>
    )
  },
)
