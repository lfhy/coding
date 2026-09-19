/** 终端第一次显示时才挂载，随后在底栏收起期间保留同一实例。 */

import { useEffect, useState, type ReactNode } from 'react'
import { TerminalPanel, type TerminalPanelProps } from './TerminalPanel.tsx'

/**
 * 避免从未打开的底栏初始化 xterm，同时保留已激活终端的连接和滚屏。
 * @param props - 布局 owner 与 Host 终端 URL。
 * @returns 尚未启用时为空；启用后保持同一个终端组件。
 */
export function RetainedTerminalPanel(props: TerminalPanelProps): ReactNode {
  const [activated, setActivated] = useState(props.shown)
  useEffect(() => {
    if (props.shown) setActivated(true)
  }, [props.shown])
  return activated ? <TerminalPanel {...props} /> : null
}
