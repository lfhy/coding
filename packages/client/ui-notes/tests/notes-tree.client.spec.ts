import { describe, expect, it } from 'vitest'
import type { NotesTreeEntry } from '../src/client/wire.ts'
import { addTreeDirectory, filePaths, isDeckPath, labelOf, latestWritten, noteFiles, removeTreeEntry } from '../src/client/notes-tree.ts'

const leaf = (name: string, path: string, mtimeMs = 1): NotesTreeEntry => ({ name, path, kind: 'file', mtimeMs })
const deck = (name: string, path: string, mtimeMs = 3): NotesTreeEntry => ({ name, path, kind: 'deck', mtimeMs })
const folder = (name: string, path: string, children?: NotesTreeEntry[]): NotesTreeEntry => ({
  name, path, kind: 'dir', mtimeMs: 1, ...(children === undefined ? {} : { children }),
})

describe('notes tree helpers', () => {
  it('只从目标目录递归移除条目，保留无 children 目录和其他分支', () => {
    const original = [
      folder('Archive', 'Archive', [folder('Deep', 'Archive/Deep', [leaf('old.md', 'Archive/Deep/old.md')]), leaf('keep.md', 'Archive/keep.md')]),
      folder('Empty', 'Empty'),
      leaf('root.md', 'root.md'),
    ]
    const changed = removeTreeEntry(original, 'Archive/Deep/old.md')
    expect(changed[0]?.children?.[0]?.children).toEqual([])
    expect(changed[0]?.children?.[1]?.path).toBe('Archive/keep.md')
    expect(changed[1]).toBe(original[1])
    expect(changed[2]).toBe(original[2])
    expect(original[0]?.children?.[0]?.children).toHaveLength(1)
  })

  it('刷新失败时补齐缺失父目录，保留现有子项与手工顺序', () => {
    const original = [folder('Z', 'Z'), folder('Archive', 'Archive', [leaf('old.md', 'Archive/old.md')])]
    const withChild = addTreeDirectory(original, 'Archive/New', 50)
    expect(withChild.map(entry => entry.name)).toEqual(['Z', 'Archive'])
    expect(withChild[1]?.children?.map(entry => entry.name)).toEqual(['old.md', 'New'])
    expect(withChild[1]?.children?.[1]).toEqual({ ...folder('New', 'Archive/New', []), mtimeMs: 50 })
    expect(original[1]?.children).toHaveLength(1)

    const fromChildless = addTreeDirectory(original, 'Z/Child', 60)
    expect(fromChildless[0]?.children?.[0]?.path).toBe('Z/Child')
    expect(addTreeDirectory([], 'Missing/Deep', 70)).toEqual([
      { name: 'Missing', path: 'Missing', kind: 'dir', mtimeMs: 70, children: [
        { name: 'Deep', path: 'Missing/Deep', kind: 'dir', mtimeMs: 70, children: [] },
      ] },
    ])
  })

  it('按树顺序收集文件并跳过未加载子项的目录', () => {
    expect(filePaths([
      folder('Empty', 'Empty'), folder('Archive', 'Archive', [leaf('a.md', 'Archive/a.md')]), leaf('root.md', 'root.md'),
    ])).toEqual(['Archive/a.md', 'root.md'])
  })

  it('把幻灯片工程目录当可打开条目，但不参与助手写入检测', () => {
    const entries = [
      deck('演示.codingppt', '演示.codingppt'),
      folder('Archive', 'Archive', [leaf('a.md', 'Archive/a.md')]),
      leaf('root.md', 'root.md'),
    ]
    expect(filePaths(entries)).toEqual(['演示.codingppt', 'Archive/a.md', 'root.md'])
    expect(noteFiles(entries).map(note => note.path)).toEqual(['Archive/a.md', 'root.md'])
    expect(labelOf('演示.codingppt')).toBe('演示')
    expect(labelOf('root.markdown')).toBe('root')
    expect(isDeckPath('演示.codingppt')).toBe(true)
    expect(isDeckPath('演示.CODINGPPT')).toBe(true)
    expect(isDeckPath('演示.pptx')).toBe(false)
  })

  it('只选择变化的最新笔记，时间相等保留先遇到的笔记', () => {
    const notes = [
      { path: 'same.md', mtimeMs: 10, parents: [] },
      { path: 'new.md', mtimeMs: 20, parents: [] },
      { path: 'older.md', mtimeMs: 15, parents: [] },
      { path: 'tie.md', mtimeMs: 20, parents: [] },
    ]
    expect(latestWritten(notes, new Map([['same.md', 10]]))).toBe(notes[1])
    expect(latestWritten(notes, new Map(notes.map(note => [note.path, note.mtimeMs])))).toBeUndefined()
  })
})
