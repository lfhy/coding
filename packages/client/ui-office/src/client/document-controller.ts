/** 单个可见笔记的读写事务；存档副本和可视编辑器各自拥有自己的生命周期。 */
import type { OfficeDocument, OfficeSnapshot } from './office-document.ts'
import type { OfficeDownload, OfficeIo, OfficeResult } from './wire.ts'

const AUTO_SAVE_MS = 750

/** 页内切换所保留的草稿，只能用原文档的修订号提交。 */
export interface OfficeDraft {
  readonly revision: string
  readonly document: OfficeDocument
}

/** 当前画布的初始内容；仅采纳另一份快照时重建画布。 */
export interface OfficeSeed {
  readonly id: number
  readonly document: OfficeDocument
}

/** 控件和读写回执共用的一份保存状态。 */
export type OfficeStatus = 'loading' | 'loadFailed' | 'saved' | 'dirty' | 'saving' | 'saveFailed' | 'missing' | 'conflict' | 'unsupported'

/** 组件渲染的状态；不含不可信的响应诊断。 */
export interface OfficeView {
  readonly seed: OfficeSeed | null
  readonly status: OfficeStatus
  readonly conflict: boolean
}

type Result = 'ready' | 'missing' | 'conflict' | 'failed' | 'unsupported' | 'cancelled'

interface DocumentOptions {
  readonly io: OfficeIo
  readonly initial: OfficeDraft | undefined
  readonly publish: (view: OfficeView) => void
  readonly retain: (draft: OfficeDraft | undefined) => void
  /** 单元格尚在编辑时，不能用轮询读到的内容重建画布。 */
  readonly isEditing: () => boolean
}

/**
 * 创建与编辑区挂载一一对应的读写事务；未完成的写入从不转移到另一个路径。
 * @param options - 已固定到单个路径的请求、草稿及呈现回调。
 * @returns 读写、冲突确认及卸载入口。
 */
export function createOfficeDocumentController({ io, initial, publish, retain, isEditing }: DocumentOptions) {
  let alive = true
  let draft = initial
  let revision = initial?.revision
  let reviewed: OfficeSnapshot | undefined
  let conflict = false
  let unsupported = false
  let seed: OfficeSeed | null = initial === undefined ? null : { id: 0, document: initial.document }
  let reading: AbortController | undefined
  let writing: { abort: AbortController; result: Promise<Result> } | undefined
  let exporting: AbortController | undefined
  let autoSave: ReturnType<typeof setTimeout> | undefined

  const status = (key: OfficeStatus) => {
    if (alive) publish({ seed, status: unsupported ? 'unsupported' : key, conflict })
  }
  const stopRead = () => {
    reading?.abort()
    reading = undefined
  }
  const stopAutoSave = () => {
    clearTimeout(autoSave)
    autoSave = undefined
  }
  const setDraft = (next: OfficeDraft | undefined) => {
    draft = next
    retain(next)
  }
  const accept = (snapshot: OfficeSnapshot) => {
    revision = snapshot.revision
    reviewed = undefined
    conflict = false
    unsupported = false
    if (draft !== undefined) setDraft(undefined)
    seed = { id: (seed?.id ?? 0) + 1, document: snapshot.document }
    status('saved')
  }

  const read = async (mode: 'open' | 'poll' | 'review'): Promise<Result> => {
    if (!alive) return 'cancelled'
    if (mode === 'poll' && (reading !== undefined || writing !== undefined || exporting !== undefined
      || draft !== undefined || unsupported || isEditing())) return 'cancelled'
    stopRead()
    const operation = new AbortController()
    reading = operation
    const result = await io.read(operation.signal)
    if (operation.signal.aborted) return 'cancelled'
    reading = undefined
    if (mode === 'review') {
      reviewed = result.kind === 'ready' ? result.value : undefined
      return result.kind
    }
    if (mode === 'poll' && (draft !== undefined || unsupported || isEditing())) return 'cancelled'
    if (result.kind !== 'ready') {
      if (result.kind === 'missing') status('missing')
      else if (mode === 'open') status(draft === undefined ? 'loadFailed' : 'saveFailed')
      return result.kind
    }
    if (draft !== undefined) {
      // 请求的响应可能在切页后被取消，但相同内容已被 Host 提交。
      if (sameDocument(draft.document, result.value.document) && !unsupported) accept(result.value)
      else {
        conflict = draft.revision !== result.value.revision
        status(conflict ? 'conflict' : 'dirty')
      }
    } else if (seed === null || revision !== result.value.revision) accept(result.value)
    else status('saved')
    return 'ready'
  }

  const schedule = () => {
    stopAutoSave()
    if (!alive || draft === undefined || conflict || unsupported) return
    autoSave = setTimeout(() => { void save() }, AUTO_SAVE_MS)
  }

  const write = (target: string): Promise<Result> => {
    const submitted = draft
    if (submitted === undefined) return Promise.resolve('ready')
    stopRead()
    stopAutoSave()
    const abort = new AbortController()
    status('saving')
    const result = io.save(target, submitted.document, abort.signal).then((response): Result => {
      if (abort.signal.aborted) return 'cancelled'
      writing = undefined
      if (response.kind === 'ready') {
        revision = response.value.revision
        conflict = false
        reviewed = undefined
        if (draft === submitted) {
          setDraft(undefined)
          status('saved')
        } else if (draft !== undefined) {
          setDraft({ revision, document: draft.document })
          status('dirty')
          schedule()
        }
      } else if (response.kind === 'conflict') {
        conflict = true
        reviewed = undefined
        status('conflict')
      } else if (response.kind === 'unsupported') {
        // Host 还校验公式等业务约束；只冻结确实被拒绝的那份输入。
        unsupported = draft === submitted
        status(unsupported ? 'unsupported' : 'dirty')
        schedule()
      } else status(response.kind === 'missing' ? 'missing' : 'saveFailed')
      return response.kind
    })
    writing = { abort, result }
    return result
  }

  const save = (): Promise<Result> => {
    if (!alive) return Promise.resolve('cancelled')
    if (unsupported) return Promise.resolve('unsupported')
    if (conflict) return Promise.resolve('conflict')
    if (writing !== undefined) return writing.result
    if (revision === undefined) return Promise.resolve('failed')
    return write(revision)
  }

  return {
    /** 打开文档；先保留内存草稿，读到远端版本后才决定是否冲突。 */
    open: () => {
      status(seed === null ? 'loading' : 'dirty')
      return read('open')
    },
    /** 空闲时刷新；旧请求和新输入不能触发画布替换。 */
    poll: () => read('poll'),
    /** 记录已提交到画布的内容；null 表示画布存在当前无法保存的修改。 */
    edit(document: OfficeDocument | null): void {
      if (!alive || revision === undefined) return
      stopRead()
      if (document === null) {
        stopAutoSave()
        unsupported = true
        status('unsupported')
        return
      }
      unsupported = false
      setDraft({ revision, document })
      status(conflict ? 'conflict' : writing === undefined ? 'dirty' : 'saving')
      schedule()
    },
    /** 等待当前写入；没有草稿时不会发送 POST。 */
    save,
    /** 读取要呈现、丢弃或确认替换的确切版本，不恢复自动保存。 */
    review: () => conflict && writing === undefined ? read('review') : Promise.resolve<Result>('cancelled'),
    /** 用户确认放弃草稿后加载已核对的版本。 */
    useLatest(): boolean {
      if (!alive || !conflict || reviewed === undefined || writing !== undefined) return false
      accept(reviewed)
      return true
    },
    /** 只有用户明确确认才按已核对版本替换；再次冲突时仍需重新确认。 */
    replaceLatest(): Promise<Result> {
      if (!alive || !conflict || reviewed === undefined || unsupported || writing !== undefined) return Promise.resolve('cancelled')
      return write(reviewed.revision)
    },
    /** 等待所有已提交到画布的编辑落盘，再导出同一版本；不自动重试冲突。 */
    async export(): Promise<OfficeResult<OfficeDownload> | { kind: 'unsupported' | 'cancelled' }> {
      if (!alive || exporting !== undefined) return { kind: 'cancelled' }
      const operation = new AbortController()
      exporting = operation
      try {
        let result: Result
        do {
          result = await save()
          if (result !== 'ready') return { kind: result }
        } while (draft !== undefined)
        if (cancelled(operation)) return { kind: 'cancelled' }
        if (revision === undefined) return { kind: 'failed' }
        stopRead()
        const exported = await io.export(revision, operation.signal)
        return cancelled(operation) ? { kind: 'cancelled' } : exported
      } finally {
        exporting = undefined
      }
    },
    /** 结束轮询、自动保存和回执发布；Host 已完成的写入不会被撤销。 */
    dispose(): void {
      alive = false
      stopRead()
      stopAutoSave()
      writing?.abort.abort()
      exporting?.abort()
    },
  }
}

function cancelled(operation: AbortController): boolean {
  return operation.signal.aborted
}

/**
 * 比较包括字段值在内的完整内容，忽略 JSON 对象的键顺序。
 * @param a - 首份文档。
 * @param b - 次份文档。
 * @returns 两份文档是否表达相同序列及字段值。
 */
export function sameDocument(a: OfficeDocument, b: OfficeDocument): boolean {
  const canonical = (document: OfficeDocument): string => JSON.stringify(document, (_key, value: unknown) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
  })
  return a === b || canonical(a) === canonical(b)
}
