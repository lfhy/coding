import type { NotesTreeEntry } from './wire.ts'

/** 去掉 Markdown 扩展名的文件名，供目录与标签显示。 */
export function labelOf(name: string): string {
  return name.replace(/\.(md|markdown|pptx)$/iu, '')
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
 * @returns 包含该目录的新树，不改变原有条目。
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
    return [...nodes.filter(entry => entry.path !== currentPath), updated].sort((a, b) => a.name.localeCompare(b.name))
  }
  return insert(entries, 0)
}

/** 目录树中的一篇笔记；`parents` 是展开该行所需的各级目录。 */
export interface NoteFile {
  path: string
  mtimeMs: number
  parents: readonly string[]
}

/** 按目录树显示顺序收集可打开的 Markdown 和 PPTX 路径。 */
export function filePaths(entries: readonly NotesTreeEntry[]): string[] {
  return entries.flatMap(entry => entry.kind === 'file' ? [entry.path]
    : entry.children === undefined ? [] : filePaths(entry.children))
}

/** 按目录树显示顺序扁平化所有 Markdown 文件，供助手写入检测使用。 */
export function noteFiles(entries: readonly NotesTreeEntry[], parents: readonly string[] = []): NoteFile[] {
  const notes: NoteFile[] = []
  for (const entry of entries) {
    if (entry.kind === 'file' && !/\.pptx$/iu.test(entry.path)) {
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
    if (seen.get(note.path) === note.mtimeMs) continue
    if (latest === undefined || note.mtimeMs > latest.mtimeMs) latest = note
  }
  return latest
}
