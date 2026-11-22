/** 会话内换页只保留可保存的草稿，关闭窗口不在浏览器存储正文。 */
import { defineStore, type EngineStoreHandle } from 'coding-client-runtime/client'
import type { OfficeDraft } from './document-controller.ts'

type DraftState = { drafts: Record<string, OfficeDraft | undefined> }
type DraftActions = { retain(state: DraftState, key: string, draft: OfficeDraft | undefined): void }

/**
 * 声明编辑器注册使用的会话级草稿。
 * @returns 按当前路径和类型分隔的草稿状态与写入动作。
 */
export function createOfficeDraftStore(): EngineStoreHandle<DraftState, DraftActions> {
  return defineStore({
    init: (): DraftState => ({ drafts: {} }),
    actions: {
      retain: (state, key, draft) => {
        if (draft === undefined) state.drafts = Object.fromEntries(Object.entries(state.drafts).filter(([name]) => name !== key))
        else state.drafts[key] = draft
      },
    },
  })
}
