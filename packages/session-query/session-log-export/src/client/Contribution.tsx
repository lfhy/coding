import type { ReactNode } from 'react'
import { SessionLogDownloadDialog, type SessionLogDownloadDialogProps } from './Dialog.tsx'

/**
 * 在会话页头的 utilities 座位挂载导出结果弹窗。页头不再提供下载按钮，浏览器侧的导出
 * 入口只有 `/export` 命令；该座位是本包唯一可用的会话级挂载点。
 * @param props - 会话运行时、下载控制器状态与本地化弹窗文案。
 * @returns 会话作用域的导出结果弹窗。
 */
export function SessionLogDownloadContribution(props: SessionLogDownloadDialogProps): ReactNode {
  return <SessionLogDownloadDialog {...props} />
}
