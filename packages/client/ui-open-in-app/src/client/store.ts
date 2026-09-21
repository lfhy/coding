/** 文件工作台的 Session viewing store。 */

import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceFilesPayload } from './wire.ts'

/** 一个已打开文件标签；segments 原样来自 Host provider。 */
export interface WorkbenchFileTab {
  id: string
  name: string
  segments: string[]
}

/** 一层目录的读取状态。 */
export interface WorkbenchFileLevel {
  readonly phase: 'loading' | 'ready' | 'error'
  readonly segments: readonly string[]
  readonly listing: WorkspaceFilesPayload | undefined
}

type WorkbenchState = {
  tabs: WorkbenchFileTab[]
  activeId: string | null
  filesOpen: boolean
  filesQuery: string
  filesExpanded: readonly string[]
  filesLevels: Readonly<Record<string, WorkbenchFileLevel | undefined>>
}

interface OpenFileInput {
  readonly name: string
  readonly segments: readonly string[]
}

type WorkbenchActions = {
  openFile: (draft: WorkbenchState, file: OpenFileInput) => void
  activateFile: (draft: WorkbenchState, id: string) => void
  closeFile: (draft: WorkbenchState, id: string) => void
  toggleFiles: (draft: WorkbenchState) => void
  setFilesQuery: (draft: WorkbenchState, query: string) => void
  toggleFilesExpanded: (draft: WorkbenchState, key: string) => void
  setFilesLevel: (draft: WorkbenchState, segments: readonly string[], phase: 'loading' | 'error') => void
  setFilesListing: (draft: WorkbenchState, segments: readonly string[], listing: WorkspaceFilesPayload) => void
}

/**
 * 为 provider segment 链生成不解释分隔符的标签 identity。
 * @param segments - Host 返回的 segment 链。
 * @returns 可逆且不会混淆 Windows／POSIX 分隔符的 JSON identity。
 */
export function tabIdForSegments(segments: readonly string[]): string {
  return JSON.stringify(segments)
}

function retainLevel(
  level: WorkbenchFileLevel | undefined,
  segments: readonly string[],
  phase: 'loading' | 'error',
): WorkbenchFileLevel {
  return {
    phase,
    segments: [...segments],
    listing: level?.listing,
  }
}

/**
 * 创建每 Session 一份的文件工作台 viewing store。
 * @returns 由 slot renderer 实例化的 store handle。
 */
export function createWorkbenchStore(): EngineStoreHandle<WorkbenchState, WorkbenchActions> {
  return defineStore({
    init: (): WorkbenchState => ({
      tabs: [],
      activeId: null,
      filesOpen: true,
      filesQuery: '',
      filesExpanded: [],
      filesLevels: {},
    }),
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
      toggleFiles: (draft) => { draft.filesOpen = !draft.filesOpen },
      setFilesQuery: (draft, query) => { draft.filesQuery = query },
      toggleFilesExpanded: (draft, key) => {
        const next = new Set(draft.filesExpanded)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        draft.filesExpanded = [...next]
      },
      setFilesLevel: (draft, segments, phase) => {
        const key = tabIdForSegments(segments)
        draft.filesLevels = {
          ...draft.filesLevels,
          [key]: retainLevel(draft.filesLevels[key], segments, phase),
        }
      },
      setFilesListing: (draft, segments, listing) => {
        const key = tabIdForSegments(segments)
        draft.filesLevels = {
          ...draft.filesLevels,
          [key]: { phase: 'ready', segments: [...segments], listing },
        }
      },
    },
  })
}
