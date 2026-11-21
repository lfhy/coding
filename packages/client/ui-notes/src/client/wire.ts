/** 笔记域的浏览器侧 wire 类型；响应只含相对笔记根目录的路径，绝对路径不进浏览器。 */

/** 笔记目录树节点；`path` 相对笔记根目录，`children` 仅普通目录携带。 */
export interface NotesTreeEntry {
  name: string
  /** `deck` 是 `.codingppt` 幻灯片工程目录：一行幻灯片条目，不可展开。 */
  kind: 'dir' | 'file' | 'deck'
  path: string
  mtimeMs: number
  children?: NotesTreeEntry[]
}

/** 单篇笔记的原文与修改时间；保存冲突检测的基准时间由此取得。 */
export interface NotesReadResult {
  path: string
  content: string
  mtimeMs: number
}

/** 保存时笔记在读后被外部修改；编辑端应重新加载而不是被覆盖。 */
export class NoteConflictError extends Error {
  constructor() { super('笔记已被外部修改') }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 拒绝绝对路径与越级段；客户端提交的笔记路径必须落在笔记根目录内。 */
export function assertNotePath(path: string): void {
  if (typeof path !== 'string' || path.length === 0 || path.length > 4096
    || /^[\\/]/.test(path) || /^[a-zA-Z]:/.test(path) || path.includes('\0')
    || /[\u0001-\u001f\u007f]/u.test(path)
    || path.split(/[\\/]/).some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('Invalid note path')
  }
}

/** 在网络边界校验目录树节点，防止 Host 或中间层注入越界路径。 */
function parseTreeEntry(value: unknown): NotesTreeEntry {
  if (!isObject(value) || (value.kind !== 'dir' && value.kind !== 'file' && value.kind !== 'deck')
    || !nonemptyString(value.name) || !nonemptyString(value.path)
    || typeof value.mtimeMs !== 'number' || !Number.isFinite(value.mtimeMs)
    || (value.children !== undefined && !Array.isArray(value.children))) {
    throw new Error('Invalid notes tree entry')
  }
  assertNotePath(value.path)
  return {
    name: value.name,
    kind: value.kind,
    path: value.path,
    mtimeMs: value.mtimeMs,
    ...(value.children === undefined ? {} : { children: value.children.map(parseTreeEntry) }),
  }
}

function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * 读取笔记根目录的目录树。
 * @param signal - 取消请求的中断信号。
 * @returns 校验后的根级条目数组。
 */
export async function notesTree(signal: AbortSignal): Promise<NotesTreeEntry[]> {
  const response = await fetch('/api/notes/tree', { method: 'GET', signal })
  if (!response.ok) throw new Error(`notes tree HTTP ${response.status}`)
  const body = (await response.json()) as unknown
  if (!isObject(body) || !Array.isArray(body.children)) throw new Error('Invalid notes tree payload')
  return body.children.map(parseTreeEntry)
}

/**
 * 读取一篇笔记的原文与修改时间。
 * @param path - 相对笔记根目录的斜杠路径。
 * @param signal - 取消请求的中断信号。
 * @returns 校验后的原文与修改时间。
 */
export async function notesRead(path: string, signal: AbortSignal): Promise<NotesReadResult> {
  assertNotePath(path)
  const response = await fetch(`/api/notes/read?path=${encodeURIComponent(path)}`, { method: 'GET', signal })
  if (!response.ok) throw new Error(`notes read HTTP ${response.status}`)
  const body = (await response.json()) as unknown
  if (!isObject(body) || !nonemptyString(body.path) || typeof body.content !== 'string'
    || typeof body.mtimeMs !== 'number' || !Number.isFinite(body.mtimeMs)) {
    throw new Error('Invalid note read payload')
  }
  assertNotePath(body.path)
  return { path: body.path, content: body.content, mtimeMs: body.mtimeMs }
}

/**
 * 保存笔记原文；传入读到的修改时间做冲突检测。
 * @param path - 相对笔记根目录的斜杠路径。
 * @param content - 笔记全文。
 * @param baseMtimeMs - 读取时的修改时间；外部已修改时抛出 {@link NoteConflictError}。
 * @returns 写入后的修改时间。
 */
export async function notesSave(path: string, content: string, baseMtimeMs?: number): Promise<{ path: string; mtimeMs: number }> {
  assertNotePath(path)
  if (typeof content !== 'string') throw new Error('Invalid note content')
  const response = await fetch('/api/notes/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, content, ...(baseMtimeMs === undefined ? {} : { baseMtimeMs }) }),
  })
  if (response.status === 409) throw new NoteConflictError()
  if (!response.ok) throw new Error(`notes save HTTP ${response.status}`)
  const body = (await response.json()) as unknown
  if (!isObject(body) || !nonemptyString(body.path) || typeof body.mtimeMs !== 'number' || !Number.isFinite(body.mtimeMs)) {
    throw new Error('Invalid note save payload')
  }
  assertNotePath(body.path)
  return { path: body.path, mtimeMs: body.mtimeMs }
}

/**
 * 在当前笔记目录创建一篇笔记。
 * @param name - 笔记名称；Host 会净化并补 Markdown 扩展名。
 * @param directory - 相对笔记根目录的父目录，空字符串表示根目录。
 * @param content - 导入时的初始原文；省略时创建空笔记。
 * @returns 新建笔记的相对路径。
 */
export async function notesCreate(name: string, directory = '', content?: string): Promise<{ path: string }> {
  const response = await fetch('/api/notes/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name,
      ...(directory === '' ? {} : { directory }),
      ...(content === undefined ? {} : { content }),
    }),
  })
  if (!response.ok) throw new Error(`notes create HTTP ${response.status}`)
  const body = (await response.json()) as unknown
  if (!isObject(body) || !nonemptyString(body.path)) throw new Error('Invalid note create payload')
  assertNotePath(body.path)
  return { path: body.path }
}

/** 幻灯片工程目录名的大小写后缀；与文件库的 `NOTE_DECK_SUFFIX` 一致。 */
const NOTE_DECK_SUFFIX = '.codingppt'

/** 幻灯片请求共用的会话、名称与目标目录校验。 */
function assertSlideRequest(sessionId: string, name: string, directory: string): void {
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 128
    || /[\u0000-\u001f\u007f]/u.test(sessionId)) {
    throw new Error('Invalid notes session')
  }
  if (typeof name !== 'string' || name.trim() === '' || name.length > 1024 || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new Error('Invalid note name')
  }
  if (directory !== '') assertNotePath(directory)
}

/** 校验幻灯片响应：必须是笔记根目录内的 `.codingppt` 路径。 */
function parseSlideDir(body: unknown): { path: string } {
  if (!isObject(body) || body.ok !== true || !nonemptyString(body.dir)) throw new Error('Invalid note slide payload')
  assertNotePath(body.dir)
  if (!body.dir.toLowerCase().endsWith(NOTE_DECK_SUFFIX)) throw new Error('Invalid note slide payload')
  return { path: body.dir }
}

/**
 * 在笔记目录新建一份幻灯片工程目录（`{name}.codingppt`）。
 *
 * PPT 宿主生成默认整稿并直接写入该目录，这个目录就是该幻灯片的工作目录；
 * 本函数只提交名称与目标目录，再把响应收敛成相对笔记根目录的路径。
 *
 * @param sessionId - 当前笔记会话；其工作目录必须已指向笔记根目录。
 * @param name - 用户输入的演示文稿名称，Host 会净化并补 `.codingppt` 后缀。
 * @param directory - 相对笔记根目录的父目录，空字符串表示根目录。
 * @returns 新建幻灯片工程目录的相对路径。
 */
export async function notesCreateSlide(sessionId: string, name: string, directory = ''): Promise<{ path: string }> {
  assertSlideRequest(sessionId, name, directory)
  const response = await fetch('/api/ppt/notes/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, name, ...(directory === '' ? {} : { directory }) }),
  })
  if (!response.ok) throw new Error(`notes slide create HTTP ${response.status}`)
  return parseSlideDir(await response.json())
}

/**
 * 把本机 `.pptx` 导入成笔记目录里的幻灯片工程目录。
 *
 * 文件按原始字节上传，不经过 base64 或 JSON：整稿常有几十 MiB，编码会放大请求体并撞上
 * JSON 长度上限。Host 只保留模型能表达的页面结构，导入完成后源文件与本笔记无关。
 *
 * @param sessionId - 当前笔记会话；其工作目录必须已指向笔记根目录。
 * @param name - 新建幻灯片的名称；调用方通常取所选文件名。
 * @param directory - 相对笔记根目录的父目录，空字符串表示根目录。
 * @param file - 用户在文件选择器里选中的 `.pptx`。
 * @returns 新建幻灯片工程目录的相对路径。
 */
export async function notesImportSlide(sessionId: string, name: string, directory: string, file: File): Promise<{ path: string }> {
  assertSlideRequest(sessionId, name, directory)
  if (file.size === 0) throw new Error('Empty slide file')
  const query = new URLSearchParams({ sessionId, name })
  if (directory !== '') query.set('directory', directory)
  const response = await fetch(`/api/ppt/notes/import?${query.toString()}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: file,
  })
  if (!response.ok) throw new Error(`notes slide import HTTP ${response.status}`)
  return parseSlideDir(await response.json())
}

/** 在笔记目录下新建子目录，返回相对笔记根目录的路径。 */
export async function notesCreateDirectory(name: string, parent = ''): Promise<{ path: string }> {
  const response = await fetch('/api/notes/create-directory', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, ...(parent === '' ? {} : { parent }) }),
  })
  if (!response.ok) throw new Error(`notes create directory HTTP ${response.status}`)
  const body = (await response.json()) as unknown
  if (!isObject(body) || !nonemptyString(body.path)) throw new Error('Invalid note directory payload')
  assertNotePath(body.path)
  return { path: body.path }
}

/** 重命名笔记或目录，返回更新后的相对路径。 */
export async function notesRename(path: string, name: string): Promise<{ path: string }> {
  assertNotePath(path)
  if (typeof name !== 'string' || name.trim() === '' || /[\\/\u0000-\u001f\u007f]/u.test(name)) {
    throw new Error('Invalid note name')
  }
  const response = await fetch('/api/notes/rename', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, name }),
  })
  if (!response.ok) throw new Error(`notes rename HTTP ${response.status}`)
  const body = (await response.json()) as unknown
  if (!isObject(body) || !nonemptyString(body.path)) throw new Error('Invalid note rename payload')
  assertNotePath(body.path)
  return { path: body.path }
}

/**
 * 删除笔记或整个目录；调用方须先取得用户确认。
 * @param path - 相对笔记根目录的斜杠路径。
 * @returns Host 完成删除后兑现；请求失败时拒绝。
 */
export async function notesDelete(path: string): Promise<void> {
  assertNotePath(path)
  const response = await fetch('/api/notes/delete', {
    method: 'DELETE', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  })
  if (!response.ok) throw new Error(`notes delete HTTP ${response.status}`)
}

/**
 * 读取笔记根目录的绝对路径，供会话工作目录使用。
 * @param signal - 取消请求的中断信号。
 * @returns 笔记根目录的绝对路径。
 */
export async function notesCwd(signal: AbortSignal): Promise<string> {
  const response = await fetch('/api/notes/cwd', { method: 'GET', signal })
  if (!response.ok) throw new Error(`notes cwd HTTP ${response.status}`)
  const body = (await response.json()) as unknown
  if (!isObject(body) || !nonemptyString(body.path) || !/^[\\/]/.test(body.path)) {
    throw new Error('Invalid notes cwd payload')
  }
  return body.path
}
