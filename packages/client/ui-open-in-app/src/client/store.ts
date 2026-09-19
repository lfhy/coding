/** 文件标签的 Session viewing store。 */

import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

/** 一个已打开文件标签；segments 原样来自 Host provider。 */
export interface WorkbenchFileTab {
  id: string
  name: string
  segments: string[]
}

interface WorkbenchState {
  tabs: WorkbenchFileTab[]
  activeId: string | null
}

interface OpenFileInput {
  readonly name: string
  readonly segments: readonly string[]
}

type WorkbenchActions = {
  openFile: (draft: WorkbenchState, file: OpenFileInput) => void
  activateFile: (draft: WorkbenchState, id: string) => void
  closeFile: (draft: WorkbenchState, id: string) => void
}

/**
 * 为 provider segment 链生成不解释分隔符的标签 identity。
 * @param segments - Host 返回的 segment 链。
 * @returns 可逆且不会混淆 Windows／POSIX 分隔符的 JSON identity。
 */
export function tabIdForSegments(segments: readonly string[]): string {
  return JSON.stringify(segments)
}

/**
 * 创建每 Session 一份的文件标签 viewing store。
 * @returns 由 slot renderer 实例化的 store handle。
 */
export function createWorkbenchStore(): EngineStoreHandle<WorkbenchState, WorkbenchActions> {
  return defineStore({
    init: (): WorkbenchState => ({ tabs: [], activeId: null }),
    actions: {
      openFile: (draft, file) => {
        const id = tabIdForSegments(file.segments)
        if (!draft.tabs.some(tab => tab.id === id)) {
          draft.tabs.push({ id, name: file.name, segments: [...file.segments] })
        }
        draft.activeId = id
      },
      activateFile: (draft, id) => {
        if (draft.tabs.some(tab => tab.id === id)) draft.activeId = id
      },
      closeFile: (draft, id) => {
        const index = draft.tabs.findIndex(tab => tab.id === id)
        if (index < 0) return
        draft.tabs.splice(index, 1)
        if (draft.activeId !== id) return
        draft.activeId = draft.tabs[index]?.id ?? draft.tabs[index - 1]?.id ?? null
      },
    },
  })
}
