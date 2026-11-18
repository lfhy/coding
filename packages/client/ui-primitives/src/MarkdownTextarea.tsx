import { forwardRef } from 'react'
import type { TextareaHTMLAttributes } from 'react'
import clsx from 'clsx'
import css from './MarkdownTextarea.module.css'

/**
 * 填满编辑区的 Markdown 源文本框，只持有控件样式，不处理内容、快捷键或保存。
 * @param props - 原生文本域属性；调用方提供可访问名称和内容。
 * @param ref - 原生文本域引用，供调用方设置焦点和选区。
 * @returns 由主题控制排版与焦点反馈的文本域。
 */
export const MarkdownTextarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function MarkdownTextarea({ className, spellCheck = false, ...props }, ref) {
    return <textarea ref={ref} className={clsx(css.editor, className)} spellCheck={spellCheck} {...props} />
  },
)
