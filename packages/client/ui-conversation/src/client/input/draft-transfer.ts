/** 包内草稿交接复用状态机的粘贴事务；引用重新编号，提交闭包仍归目标会话。 */
import type { SessionInputShell } from './facade.ts'

type DraftEndpoint = Pick<SessionInputShell,
  'snapshot' | 'addImages' | 'removeImage' | 'setDraft' | 'pasteBegin' | 'invalidatePaste'>

/**
 * 双方提交锁由 shell 先检查；目标接纳完成后才清理来源，不释放图片对象。
 * @param source - 本次选择仍拥有的来源输入。
 * @param target - 接纳草稿的目标输入。
 * @returns 目标是否接纳；拒绝时双方保持不变。
 */
export function transferDraft(source: DraftEndpoint, target: DraftEndpoint): boolean {
  const { draft, imageIds, occurrences } = source.snapshot
  if (!target.addImages(imageIds)) return false
  if (draft !== '') {
    target.pasteBegin(draft, { start: 0, end: target.snapshot.draft.length }, occurrences.map(occurrence => ({
      start: occurrence.offset,
      end: occurrence.offset + occurrence.length,
      reference: {
        source: occurrence.source,
        ref: occurrence.ref,
        label: occurrence.label,
        ...(occurrence.appearance === undefined ? {} : { appearance: occurrence.appearance }),
        clipboardText: occurrence.clipboardText,
      },
    })))
    target.invalidatePaste()
    source.setDraft('')
  }
  for (const id of imageIds) source.removeImage(id)
  return true
}
