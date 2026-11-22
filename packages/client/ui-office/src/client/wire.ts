/** 笔记文档仅通过同源 Host 读写与导出；诊断正文不会离开传输层。 */
import { isOfficeDocument, isOfficeSnapshot, type OfficeDocument, type OfficeKind, type OfficeSnapshot } from './office-document.ts'

const FORMAT = {
  word: { native: '.codingword', extension: '.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  excel: { native: '.codingexcel', extension: '.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
} as const
const MAX_NATIVE_BYTES = 8 * 1024 * 1024

type OfficeFailure = 'missing' | 'conflict' | 'failed' | 'unsupported'

/** 按界面可恢复的原因分类；不传回错误正文。 */
export type OfficeResult<T> = { kind: 'ready'; value: T } | { kind: OfficeFailure }

/** 下载的名称由已绑定的笔记路径决定，正文由 Host 生成。 */
export interface OfficeDownload {
  readonly filename: string
  readonly blob: Blob
}

/** 读、写与导出始终绑定到创建时的路径和正文类型。 */
export interface OfficeIo {
  read(signal: AbortSignal): Promise<OfficeResult<OfficeSnapshot>>
  save(revision: string, document: OfficeDocument, signal: AbortSignal): Promise<OfficeResult<OfficeSnapshot>>
  export(revision: string, signal: AbortSignal): Promise<OfficeResult<OfficeDownload>>
}

/**
 * 绑定一个文档的 HTTP 请求；所有更新都使用 Host 回执的修订号。
 * @param path - 笔记页传入的相对路径。
 * @param kind - 笔记页声明的正文类型。
 * @param request - 浏览器的同源请求函数，可用替身验证协议。
 * @returns 不可改写目标路径的读、写与导出操作。
 */
export function createOfficeIo(path: string, kind: OfficeKind, request: typeof fetch = fetch): OfficeIo {
  const format = FORMAT[kind]
  const basename = path.slice(path.lastIndexOf('/') + 1)
  const validPath = basename.toLowerCase().endsWith(format.native) && basename.length > format.native.length
  const filename = basename.slice(0, -format.native.length) + format.extension
  const run = async <T>(
    operation: string, init: RequestInit, read: (response: Response) => Promise<OfficeResult<T>>,
  ): Promise<OfficeResult<T>> => {
    if (!validPath || init.signal?.aborted === true) return { kind: 'failed' }
    try {
      const response = await request(`/api/notes/office/${operation}`, {
        ...init, cache: 'no-store', credentials: 'same-origin', redirect: 'error',
      })
      if (response.status === 404) return { kind: 'missing' }
      if (response.status === 409) return { kind: 'conflict' }
      if (response.status === 400 && operation === 'save') return { kind: 'unsupported' }
      if (!response.ok) return { kind: 'failed' }
      return await read(response)
    } catch {
      return { kind: 'failed' }
    }
  }
  const snapshot = async (response: Response): Promise<OfficeResult<OfficeSnapshot>> => {
    const body: unknown = await response.json()
    return isOfficeSnapshot(body, path, kind) ? { kind: 'ready', value: body } : { kind: 'failed' }
  }
  return {
    read: signal => run(`read?${new URLSearchParams({ path })}`, { signal }, snapshot),
    save: async (revision, document, signal) => {
      if (revision.length === 0 || !isOfficeDocument(document, kind)) return { kind: 'failed' }
      if (new TextEncoder().encode(JSON.stringify(document)).byteLength > MAX_NATIVE_BYTES) return { kind: 'unsupported' }
      return run('save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, revision, document }), signal,
      }, snapshot)
    },
    export: (revision, signal) => run(`export?${new URLSearchParams({ path, revision })}`, { signal }, async (response) => {
      const disposition = response.headers.get('Content-Disposition')
      const mime = response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase()
      if (!/^attachment\s*(?:;|$)/i.test(disposition ?? '') || (mime !== format.mime && mime !== 'application/octet-stream')) {
        return { kind: 'failed' }
      }
      const blob = await response.blob()
      return blob.size === 0 ? { kind: 'failed' } : { kind: 'ready', value: { blob, filename } }
    }),
  }
}

/**
 * 把已确认的附件交给浏览器下载，不打开新页面。
 * @param download - 来自当前文档导出请求的附件。
 */
export function downloadOffice({ filename, blob }: OfficeDownload): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.append(anchor)
  try {
    anchor.click()
  } finally {
    anchor.remove()
    setTimeout(() => { URL.revokeObjectURL(url) }, 1_000)
  }
}
