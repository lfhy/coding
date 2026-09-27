/** 首次配置步骤共享的阻断式弹窗外壳。 */

import { useEffect, useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './OnboardingModal.module.css'

const ignoreImplicitDismiss = (): void => {}

/**
 * 默认阻断工作台；步骤已持有门禁时只管理弹窗焦点。
 * @param props.title - 可见且可访问的弹窗标题。
 * @param props.focusTitle - 当前步骤没有默认字段时将焦点放到标题。
 * @param props.manageInert - 步骤自行持有门禁时可关闭弹窗内的重复管理。
 * @param props.children - 步骤拥有的内容和操作。
 * @returns 挂载到 body 的模态框。
 */
export function OnboardingModal({
  title, focusTitle = false, manageInert = true, children,
}: {
  title: string
  focusTitle?: boolean
  manageInert?: boolean
  children: ReactNode
}): ReactNode {
  const titleRef = useRef<HTMLHeadingElement | null>(null)
  const previousFocus = useRef<HTMLElement | null>(null)

  useLayoutEffect(() => {
    if (!manageInert) return
    const appRoot = document.getElementById('root')
    if (appRoot === null) return
    const previous = appRoot.inert
    appRoot.inert = true
    return () => { appRoot.inert = previous }
  }, [manageInert])

  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    return () => {
      if (previousFocus.current?.isConnected) previousFocus.current.focus()
    }
  }, [])

  useEffect(() => {
    if (focusTitle) titleRef.current?.focus()
  }, [focusTitle])

  return (
    <Modal
      open
      title={title}
      onClose={ignoreImplicitDismiss}
      headless
      className={css.dialog as string}
    >
      <div className={css.content}>
        <h2 ref={titleRef} className={css.title} tabIndex={focusTitle ? -1 : undefined}>{title}</h2>
        <div className={css.body}>{children}</div>
      </div>
    </Modal>
  )
}
