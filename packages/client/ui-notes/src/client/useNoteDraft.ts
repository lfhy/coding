import { useCallback, useEffect, useRef, useState } from 'react'
import type { NotesLocaleKey } from './locales.ts'
import { NoteConflictError, notesRead, notesSave } from './wire.ts'

const AUTOSAVE_DELAY_MS = 900

interface NoteDraft {
  path: string
  content: string
  savedContent: string
  mtimeMs: number
  status: 'idle' | 'saving' | 'conflict' | 'failed'
}

function changed(draft: NoteDraft | null): boolean {
  return draft !== null && draft.content !== draft.savedContent
}

/**
 * 管理当前笔记的编辑缓冲和修改时间基准；切换与轮询都不能替换尚未保存的正文。
 * @param notify - 由页面本地化和展示的请求失败提示。
 * @returns 当前缓冲与选中、编辑、保存、重载操作。
 */
export function useNoteDraft(notify: (key: NotesLocaleKey) => void) {
  const [draft, setDraft] = useState<NoteDraft | null>(null)
  const current = useRef<NoteDraft | null>(null)
  const writing = useRef<Promise<boolean> | null>(null)
  const reading = useRef<AbortController | null>(null)

  const update = useCallback((next: NoteDraft) => {
    current.current = next
    setDraft(next)
  }, [])

  const read = useCallback(async (path: string, signal: AbortSignal): Promise<NoteDraft> => {
    const { content, mtimeMs } = await notesRead(path, signal)
    return { path, mtimeMs, content, savedContent: content, status: 'idle' }
  }, [])

  const save = useCallback(async (): Promise<boolean> => {
    if (writing.current !== null) return writing.current
    const before = current.current
    if (before === null || !changed(before)) return true
    if (before.status === 'conflict') return false

    update({ ...before, status: 'saving' })
    const pending = notesSave(before.path, before.content, before.mtimeMs).then(({ mtimeMs }) => {
      // 只把本次写入的版本标为已保存；网络等待期间的新输入仍留在草稿中。
      const latest = current.current
      /* v8 ignore next -- 写入期间切换与轮询不能替换当前笔记。 */
      if (latest?.path === before.path) update({ ...latest, mtimeMs, savedContent: before.content, status: 'idle' })
      return true
    }, (error: unknown) => {
      const latest = current.current
      /* v8 ignore next -- 写入期间切换与轮询不能替换当前笔记。 */
      if (latest?.path === before.path) update({ ...latest, status: error instanceof NoteConflictError ? 'conflict' : 'failed' })
      return false
    }).finally(() => { writing.current = null })
    writing.current = pending
    return pending
  }, [update])

  const flush = useCallback(async (signal?: AbortSignal) => {
    while (!signal?.aborted && (writing.current !== null || changed(current.current))) {
      if (!(await save())) return false
    }
    return !signal?.aborted
  }, [save])

  const edit = useCallback((content: string) => {
    const before = current.current
    /* v8 ignore next -- 文本域仅在当前笔记已加载时可编辑。 */
    if (before === null) return
    const recovering = before.status === 'failed' || (before.status === 'conflict' && content === before.savedContent)
    update({ ...before, content, status: recovering ? 'idle' : before.status })
  }, [update])

  const dirty = changed(draft)
  const { content, status } = draft ?? {}
  useEffect(() => {
    if (!dirty || status !== 'idle') return
    const timer = window.setTimeout(() => { void save() }, AUTOSAVE_DELAY_MS)
    return () => { window.clearTimeout(timer) }
  }, [content, dirty, save, status])

  const select = useCallback(async (path: string) => {
    reading.current?.abort()
    if (path === current.current?.path) return
    const request = new AbortController()
    const { signal } = request
    reading.current = request
    try {
      if (!(await flush(signal))) return
      const next = await read(path, signal)
      if (await flush(signal) && !signal.aborted) update(next)
    } catch {
      if (!signal.aborted) notify('loadError')
    } finally {
      if (reading.current === request) reading.current = null
    }
  }, [flush, notify, read, update])

  const reload = useCallback(async () => {
    const before = current.current
    /* v8 ignore next -- 重新加载入口仅作用于已加载的笔记。 */
    if (before === null) return
    reading.current?.abort()
    const request = new AbortController()
    reading.current = request
    try {
      const next = await read(before.path, request.signal)
      if (!request.signal.aborted && current.current === before) update(next)
    } catch {
      if (!request.signal.aborted) notify('loadError')
    } finally {
      if (reading.current === request) reading.current = null
    }
  }, [notify, read, update])

  const refresh = useCallback(async (mtimeMs: number | undefined, signal: AbortSignal) => {
    const before = current.current
    if (before === null || writing.current !== null || changed(before) || mtimeMs === undefined || mtimeMs === before.mtimeMs) return
    const next = await read(before.path, signal)
    if (!signal.aborted && current.current === before) update(next)
  }, [read, update])

  useEffect(() => () => { reading.current?.abort() }, [])

  const getPath = useCallback(() => current.current?.path, [])

  const saveLabel: NotesLocaleKey | undefined = draft === null ? undefined
    : draft.status === 'idle' ? dirty ? 'unsaved' : 'saved'
      : draft.status === 'failed' ? 'saveError'
        : draft.status

  return { draft, saveLabel, select, edit, save, reload, refresh, getPath, flush }
}
