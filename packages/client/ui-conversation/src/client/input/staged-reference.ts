/** 将已暂存文件的完整路径还原为输入框引用，规范文本仍用于复制和发送。 */
import type { ReferenceInsert } from 'coding-client-ui-input-trigger/client'
import type { PasteComponent } from './contract.ts'
import { stagedFileMentions } from '../contract/staged-file-mention.ts'

/**
 * 为粘贴或恢复的规范路径建立引用位置，普通文本和非暂存路径不受影响。
 * @param text - 粘贴或从会话存储恢复的文本。
 * @returns 与规范文本偏移对齐的引用片段。
 */
export function stagedPasteComponents(text: string): PasteComponent[] {
  return stagedFileMentions(text).map(({ start, end, mention, label }) => {
    const reference: ReferenceInsert = {
      source: 'reference', ref: mention, label, appearance: 'file', clipboardText: mention,
    }
    return { start, end, reference }
  })
}
