/** 笔记目录拖拽后的保存、路径重映射与刷新；失败时以 Host 最新目录为准。 */
import { useCallback } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { NotesLocaleKey } from './locales.ts'
import type { NotesPageProps } from './NotesPage.tsx'
import { notesMove, type NotesTreeEntry } from './wire.ts'

interface NoteMoveOptions {
  creatingRequest: MutableRefObject<AbortController | null>
  setCreating: Dispatch<SetStateAction<boolean>>
  setExpanded: Dispatch<SetStateAction<ReadonlySet<string>>>
  flush: (signal?: AbortSignal) => Promise<boolean>
  renamePath: (from: string, to: string) => void
  actions: NotesPageProps['actions']
  refreshTree: () => Promise<NotesTreeEntry[]>
  treeRevision: MutableRefObject<number>
  seenNotes: MutableRefObject<Map<string, number>>
  notify: (key: NotesLocaleKey) => void
}

/**
 * 执行一次拖拽移动或排序；活动 Markdown 先保存，成功后同步标签、草稿和展开目录。
 * @param options - 页面持有的写入互斥、草稿保存、浏览 store 与目录刷新动作。
 * @returns 可交给目录组件的异步移动动作。
 */
export function useNoteMove({
  creatingRequest, setCreating, setExpanded, flush, renamePath, actions, refreshTree, treeRevision, seenNotes, notify,
}: NoteMoveOptions) {
  return useCallback(async (path: string, directory: string, before: string | null): Promise<void> => {
    if (creatingRequest.current !== null) return
    const request = new AbortController()
    creatingRequest.current = request
    setCreating(true)
    const remap = (from: string, to: string, candidate: string): string | undefined =>
      candidate === from ? to : candidate.startsWith(`${from}/`) ? `${to}${candidate.slice(from.length)}` : undefined
    try {
      if (!await flush(request.signal)) {
        request.signal.throwIfAborted()
        notify('saveError')
        return
      }
      request.signal.throwIfAborted()
      const { path: moved } = await notesMove(path, directory, before)
      request.signal.throwIfAborted()
      treeRevision.current += 1
      renamePath(path, moved)
      actions.moveTabs(path, moved)
      const seen = new Map<string, number>()
      for (const [candidate, mtimeMs] of seenNotes.current) {
        const next = remap(path, moved, candidate)
        if (next === undefined) seen.set(candidate, mtimeMs)
        else seen.set(next, mtimeMs)
      }
      seenNotes.current = seen
      setExpanded((previous) => {
        const next = new Set<string>()
        for (const candidate of previous) next.add(remap(path, moved, candidate) ?? candidate)
        for (let slash = directory.indexOf('/'); slash !== -1; slash = directory.indexOf('/', slash + 1)) {
          next.add(directory.slice(0, slash))
        }
        if (directory !== '') next.add(directory)
        return next
      })
      try {
        await refreshTree()
      } catch {
        request.signal.throwIfAborted()
        notify('treeError')
      }
    } catch {
      if (request.signal.aborted) return
      // Host 可能在顺序清单写入阶段才失败；刷新后再提示，避免界面保留已经移动的旧路径。
      await refreshTree().catch(() => undefined)
      notify('moveError')
    } finally {
      creatingRequest.current = null
      if (!request.signal.aborted) setCreating(false)
    }
  }, [creatingRequest, setCreating, setExpanded, flush, renamePath, actions, refreshTree, treeRevision, seenNotes, notify])
}
