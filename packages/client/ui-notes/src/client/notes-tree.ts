import type { NotesTreeEntry } from './wire.ts'

/** 幻灯片工程目录的后缀；与文件库的 `NOTE_DECK_SUFFIX` 一致，客户端只用它判断路径形态。 */
export const NOTE_DECK_SUFFIX = '.codingppt'
/** 思维导图文件后缀，与文件库的同名常量一致。 */
export const NOTE_MINDMAP_SUFFIX = '.codingmindmap'

/** 办公文件的笔记类型；磁盘后缀与文件库一致。 */
export type OfficeKind = 'word' | 'excel'
export const OFFICE_SUFFIXES = { word: '.codingword', excel: '.codingexcel' } as const

/** 办公结构化文档使用独立的编辑与导出入口。 */
export function isOfficeKind(kind: unknown): kind is OfficeKind {
  return kind === 'word' || kind === 'excel'
}

/** 判断目录树里的路径是否是幻灯片工程目录（`.codingppt`），而不是 Markdown 或普通目录。 */
export function isDeckPath(path: string): boolean {
  return path.toLowerCase().endsWith(NOTE_DECK_SUFFIX)
}

/** 按已核验的文档路径分流；目录树中的普通目录不可传入。 */
export function noteKindOf(path: string): 'note' | 'ppt' | 'mindmap' | OfficeKind {
  const filename = path.toLowerCase()
  if (filename.endsWith(OFFICE_SUFFIXES.word)) return 'word'
  if (filename.endsWith(OFFICE_SUFFIXES.excel)) return 'excel'
  return isDeckPath(path) ? 'ppt' : filename.endsWith(NOTE_MINDMAP_SUFFIX) ? 'mindmap' : 'note'
}

/** 文档类型在目录、标签和文档标题共享同一图标。 */
export const NOTE_ICONS = {
  note: 'notes', ppt: 'file-slides', mindmap: 'file-mindmap', word: 'file-word', excel: 'file-excel',
} as const

/** 去掉笔记类型的后缀，供目录与标签显示。 */
export function labelOf(name: string): string {
  return name.replace(/\.(md|markdown|codingppt|codingmindmap|codingword|codingexcel)$/iu, '')
}

/** 在目录树中查找指定相对路径的条目。 */
export function findEntry(entries: readonly NotesTreeEntry[], path: string): NotesTreeEntry | undefined {
  for (const entry of entries) {
    if (entry.path === path) return entry
    if (entry.kind === 'dir' && entry.children !== undefined) {
      const found = findEntry(entry.children, path)
      if (found !== undefined) return found
    }
  }
  return undefined
}

/** 删除目录节点时连同其子树一并从显示树移除。 */
export function removeTreeEntry(entries: readonly NotesTreeEntry[], path: string): NotesTreeEntry[] {
  return entries.filter(entry => entry.path !== path).map(entry =>
    entry.children !== undefined && path.startsWith(`${entry.path}/`)
      ? { ...entry, children: removeTreeEntry(entry.children, path) } : entry)
}

/**
 * 保留已确认创建的目录，供创建成功但目录刷新失败时继续选择；缺失的父级一并补齐。
 * @param entries - 当前显示的笔记树。
 * @param path - Host 确认创建的相对目录路径。
 * @param mtimeMs - 创建时间，下一次目录刷新后由 Host 的修改时间替换。
 * @returns 包含该目录的新树，不改变原有条目顺序。
 */
export function addTreeDirectory(entries: readonly NotesTreeEntry[], path: string, mtimeMs: number): NotesTreeEntry[] {
  const segments = path.split('/')
  const insert = (nodes: readonly NotesTreeEntry[], depth: number): NotesTreeEntry[] => {
    const currentPath = segments.slice(0, depth + 1).join('/')
    const existing = nodes.find(entry => entry.path === currentPath)
    const directory: NotesTreeEntry = existing?.kind === 'dir' ? existing : {
      name: currentPath.slice(currentPath.lastIndexOf('/') + 1), path: currentPath, kind: 'dir', mtimeMs, children: [],
    }
    const updated = depth === segments.length - 1 ? directory : {
      ...directory, children: insert(directory.children ?? [], depth + 1),
    }
    const index = nodes.findIndex(entry => entry.path === currentPath)
    const updatedNodes = nodes.filter(entry => entry.path !== currentPath)
    if (index < 0) updatedNodes.push(updated)
    else updatedNodes.splice(index, 0, updated)
    return updatedNodes
  }
  return insert(entries, 0)
}

/** 目录树中的一篇笔记；`parents` 是展开该行所需的各级目录。 */
export interface NoteFile {
  path: string
  mtimeMs: number
  parents: readonly string[]
}

/** 按目录树显示顺序收集非普通目录的文档路径。 */
export function filePaths(entries: readonly NotesTreeEntry[]): string[] {
  return entries.flatMap(entry => entry.kind === 'dir'
    ? entry.children === undefined ? [] : filePaths(entry.children)
    : [entry.path])
}

/** 供助手写入检测使用；收集 Markdown 及有笔记助手写入入口的结构化文档。 */
export function noteFiles(entries: readonly NotesTreeEntry[], parents: readonly string[] = []): NoteFile[] {
  const notes: NoteFile[] = []
  for (const entry of entries) {
    if (entry.kind === 'file' || entry.kind === 'mindmap' || isOfficeKind(entry.kind)) {
      notes.push({ path: entry.path, mtimeMs: entry.mtimeMs, parents })
    } else if (entry.children !== undefined) {
      notes.push(...noteFiles(entry.children, [...parents, entry.path]))
    }
  }
  return notes
}

/**
 * 找出本次轮询新增或修改过的一篇笔记。
 * @param notes - 本次目录树中的全部笔记。
 * @param seen - 上一次轮询记录的修改时间。
 * @returns 修改时间最新的变化项；没有变化时返回 undefined。
 */
export function latestWritten(notes: readonly NoteFile[], seen: ReadonlyMap<string, number>): NoteFile | undefined {
  let latest: NoteFile | undefined
  for (const note of notes) {
    // 结构化编辑器自行刷新正文，只有新文件参与欢迎页的自动打开。
    const previous = seen.get(note.path)
    if (previous === note.mtimeMs || previous !== undefined && noteKindOf(note.path) !== 'note') continue
    if (latest === undefined || note.mtimeMs > latest.mtimeMs) latest = note
  }
  return latest
}
