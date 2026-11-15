/**
 * 浏览式挑选的占位者（包内实现；`./client` 只暴露 Loader 需要的导出）。
 * 同包测试通过这个模块直接驱动它。
 */
import { createElement } from 'react'
import type { ReactElement } from 'react'
import type { DirectoryListing } from 'coding-client-runtime/client'
import type { Translate } from 'coding-client-locale/client'
// 仅类型：目录流程洞的 owner 契约。
import type { DirectoryFlowOwnerProps } from 'coding-client-ui-workspace/client'
import { DirectoryBrowser } from './DirectoryBrowser.tsx'

/** 注入面：对话框驱动的浏览调用与文案（在 apply 的闭包里绑定）。 */
export interface BrowseFlowInjected {
  /** 列举一层目录（省略路径即 Host 主目录）；signal 中断被取代的扫描。 */
  listDirectory: (path?: string, signal?: AbortSignal) => Promise<DirectoryListing>
  /** 在已存在的父目录下新建一个子目录。 */
  createDirectory: (path: string, name: string) => Promise<string>
  /** 在同一父目录下改名（目录或文件），返回新的绝对路径。 */
  renameEntry: (path: string, nextName: string) => Promise<string>
  /** 删除条目（文件，或连同内容的目录）。破坏性：先由拟态框确认。 */
  removeEntry: (path: string) => Promise<void>
  /** 本地化对话框文案（本包自己的命名空间）。 */
  t: Translate
}

/**
 * 流程占位者：把洞位的 owner 会话适配到浏览器对话框——确认的目录就是挑选结果，
 * 关闭就是取消。浏览失败（不可读目标、创建冲突、被拒的改名与删除）都留在对话框
 * 自己的提示区，因此这个占位者从不驱动 owner 的 `onError` 分支。
 * @param props - owner 会话加上注入的浏览面。
 * @returns 对话框元素（关闭时不渲染）。
 */
export function BrowseDirectoryFlow(props: DirectoryFlowOwnerProps & BrowseFlowInjected): ReactElement {
  return createElement(DirectoryBrowser, {
    open: props.open,
    busy: props.busy,
    listDirectory: props.listDirectory,
    createDirectory: props.createDirectory,
    renameEntry: props.renameEntry,
    removeEntry: props.removeEntry,
    t: props.t,
    onOpen: props.onPicked,
    onClose: props.onCancel,
  })
}
