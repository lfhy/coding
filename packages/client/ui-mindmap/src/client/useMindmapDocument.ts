/** 当前编辑器实例的文档请求与轮询；不持有表单输入，也不向其他标签发布。 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { readMindmap, saveMindmap, type MindmapEdit, type MindmapResult, type MindmapSnapshot } from './wire.ts'

const POLL_MS = 4000

interface DocumentView {
  snapshot: MindmapSnapshot | null
  issue: 'missing' | 'failed' | null
}

type RequestKind = 'poll' | 'refresh' | 'save'
type DocumentActivity = Exclude<RequestKind, 'poll'> | null

/**
 * 管理单个已显示路径的读写。调用方在换路径或隐藏时卸载此实例。
 * @param path - 当前笔记相对路径。
 * @returns 最新快照、请求状态及可供用户触发的刷新与保存动作。
 */
export function useMindmapDocument(path: string) {
  const [view, setView] = useState<DocumentView>({ snapshot: null, issue: null })
  const [activity, setActivity] = useState<DocumentActivity>(null)
  const pending = useRef<{ kind: RequestKind; controller: AbortController } | null>(null)

  const start = useCallback((kind: RequestKind): AbortController | undefined => {
    if (pending.current !== null) {
      if (kind === 'poll' || pending.current.kind !== 'poll') return
      // 显式刷新或写入具有优先权；即使旧读取未响应取消，也不能发布。
      pending.current.controller.abort()
    }
    const controller = new AbortController()
    pending.current = { kind, controller }
    if (kind !== 'poll') setActivity(kind)
    return controller
  }, [])

  const finish = useCallback((kind: RequestKind, result: MindmapResult) => {
    pending.current = null
    if (kind !== 'poll') setActivity(null)
    setView((current) => {
      if (result.kind === 'ready') {
        if (current.snapshot?.revision === result.snapshot.revision) {
          return current.issue === null ? current : { snapshot: current.snapshot, issue: null }
        }
        return { snapshot: result.snapshot, issue: null }
      }
      if (result.kind === 'missing') return { snapshot: null, issue: 'missing' }
      if (kind !== 'save' && current.issue === null) return { ...current, issue: 'failed' }
      return current
    })
  }, [])

  const read = useCallback(async (kind: 'poll' | 'refresh') => {
    const controller = start(kind)
    if (controller === undefined) return
    const result = await readMindmap(path, controller.signal)
    if (controller.signal.aborted) return
    finish(kind, result)
    return result
  }, [finish, path, start])

  useEffect(() => {
    void read('poll')
    const timer = setInterval(() => { void read('poll') }, POLL_MS)
    return () => {
      clearInterval(timer)
      pending.current?.controller.abort()
      pending.current = null
    }
  }, [read])

  const save = async (snapshot: MindmapSnapshot, edit: MindmapEdit) => {
    const controller = start('save')
    if (controller === undefined) return
    const result = await saveMindmap(snapshot, edit, controller.signal)
    if (controller.signal.aborted) return
    finish('save', result)
    return result
  }

  return { ...view, activity, refresh: () => read('refresh'), save }
}
