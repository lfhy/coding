import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertNotePath, notesCreate, notesCreateDirectory, notesCwd, notesDelete, notesRead, notesRename, notesSave, notesTree, NoteConflictError } from '../src/client/wire.ts'

const treeBody = {
  children: [
    { name: 'a.md', kind: 'file', path: 'a.md', mtimeMs: 1000 },
    { name: 'dir', kind: 'dir', path: 'dir', mtimeMs: 900, children: [{ name: 'b.md', kind: 'file', path: 'dir/b.md', mtimeMs: 800 }] },
  ],
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => handler(String(input), init)))
}

function requestJson(init?: RequestInit): unknown {
  if (typeof init?.body !== 'string') throw new Error('预期请求包含 JSON 正文')
  return JSON.parse(init.body) as unknown
}

afterEach(() => { vi.unstubAllGlobals() })

describe('notes wire', () => {
  it('校验目录树并递归拒绝越界路径', async () => {
    stubFetch(() => Response.json(treeBody))
    const tree = await notesTree(new AbortController().signal)
    expect(tree).toEqual(treeBody.children)
    stubFetch(() => Response.json({ children: [{ name: 'x', kind: 'file', path: '../x.md', mtimeMs: 1 }] }))
    await expect(notesTree(new AbortController().signal)).rejects.toThrow('Invalid note path')
    stubFetch(() => Response.json({ children: [{ name: 'x', kind: 'link', path: 'x.md', mtimeMs: 1 }] }))
    await expect(notesTree(new AbortController().signal)).rejects.toThrow('Invalid notes tree entry')
    stubFetch(() => Response.json({ children: [{ name: '', kind: 'file', path: 'x.md', mtimeMs: 1 }] }))
    await expect(notesTree(new AbortController().signal)).rejects.toThrow('Invalid notes tree entry')
    stubFetch(() => Response.json({ children: 'not-an-array' }))
    await expect(notesTree(new AbortController().signal)).rejects.toThrow('Invalid notes tree payload')
  })

  it('读取笔记原文并拒绝格式错误的载荷', async () => {
    stubFetch(() => Response.json({ path: 'a.md', content: '# 标题', mtimeMs: 42 }))
    expect(await notesRead('a.md', new AbortController().signal)).toEqual({ path: 'a.md', content: '# 标题', mtimeMs: 42 })
    stubFetch(() => Response.json({ path: 'a.md', content: 7, mtimeMs: 42 }))
    await expect(notesRead('a.md', new AbortController().signal)).rejects.toThrow('Invalid note read payload')
    await expect(notesRead('/abs.md', new AbortController().signal)).rejects.toThrow('Invalid note path')
  })

  it('保存笔记；409 抛冲突，其他失败抛状态错误', async () => {
    stubFetch((_url, init) => init?.method === 'POST' ? Response.json({ path: 'a.md', mtimeMs: 500 }) : new Response('bad', { status: 405 }))
    expect(await notesSave('a.md', '内容', 1000)).toEqual({ path: 'a.md', mtimeMs: 500 })
    stubFetch(() => new Response('conflict', { status: 409 }))
    await expect(notesSave('a.md', '内容', 1000)).rejects.toThrow(NoteConflictError)
    stubFetch(() => new Response('boom', { status: 500 }))
    await expect(notesSave('a.md', '内容')).rejects.toThrow('notes save HTTP 500')
  })

  it('创建笔记并校验返回路径', async () => {
    stubFetch((_, init) => {
      expect(requestJson(init)).toEqual({ name: '想法', directory: '项目' })
      return Response.json({ path: '项目/想法.md' })
    })
    expect(await notesCreate('想法', '项目')).toEqual({ path: '项目/想法.md' })
    stubFetch(() => new Response('exists', { status: 409 }))
    await expect(notesCreate('a.md')).rejects.toThrow('notes create HTTP 409')
    stubFetch(() => Response.json({ path: 'ok.md' }))
    await expect(notesCreate('a/../../b.md')).resolves.toEqual({ path: 'ok.md' })
  })

  it('创建目录并校验返回路径', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('/api/notes/create-directory')
      expect(requestJson(init)).toEqual({ name: '项目', parent: '资料' })
      return Response.json({ path: '资料/项目' })
    })
    await expect(notesCreateDirectory('项目', '资料')).resolves.toEqual({ path: '资料/项目' })
  })

  it('重命名和删除使用受校验的路径载荷', async () => {
    stubFetch((url, init) => {
      if (url === '/api/notes/rename') {
        expect(init?.method).toBe('POST')
        expect(requestJson(init)).toEqual({ path: 'a.md', name: 'b.md' })
        return Response.json({ path: 'b.md' })
      }
      expect(url).toBe('/api/notes/delete')
      expect(init?.method).toBe('DELETE')
      expect(requestJson(init)).toEqual({ path: 'b.md' })
      return new Response(null, { status: 204 })
    })
    await expect(notesRename('a.md', 'b.md')).resolves.toEqual({ path: 'b.md' })
    await expect(notesDelete('b.md')).resolves.toBeUndefined()
    await expect(notesRename('../a.md', 'b.md')).rejects.toThrow('Invalid note path')
  })

  it('笔记根目录必须是绝对路径', async () => {
    stubFetch(() => Response.json({ path: '/home/u/.coding/files/notes' }))
    expect(await notesCwd(new AbortController().signal)).toBe('/home/u/.coding/files/notes')
    stubFetch(() => Response.json({ path: 'relative/notes' }))
    await expect(notesCwd(new AbortController().signal)).rejects.toThrow('Invalid notes cwd payload')
    stubFetch(() => new Response('down', { status: 500 }))
    await expect(notesCwd(new AbortController().signal)).rejects.toThrow('notes cwd HTTP 500')
  })

  it('路径校验拒绝非字符串、超长、绝对路径、盘符、空段与越级段', () => {
    expect(() => { assertNotePath('a/b.md') }).not.toThrow()
    expect(() => { assertNotePath(undefined as unknown as string) }).toThrow('Invalid note path')
    expect(() => { assertNotePath('x'.repeat(4097)) }).toThrow('Invalid note path')
    expect(() => { assertNotePath('/abs.md') }).toThrow('Invalid note path')
    expect(() => { assertNotePath('C:\\win.md') }).toThrow('Invalid note path')
    expect(() => { assertNotePath('a/../b.md') }).toThrow('Invalid note path')
    expect(() => { assertNotePath('a/./b.md') }).toThrow('Invalid note path')
    expect(() => { assertNotePath('a//b.md') }).toThrow('Invalid note path')
    expect(() => { assertNotePath('a/\u0001/b.md') }).toThrow('Invalid note path')
  })

  it('读取、保存、创建的数值与类型字段均做运行时校验', async () => {
    stubFetch(() => Response.json({ path: 'a.md', content: 'ok', mtimeMs: Number.NaN }))
    await expect(notesRead('a.md', new AbortController().signal)).rejects.toThrow('Invalid note read payload')
    stubFetch(() => new Response('boom', { status: 500 }))
    await expect(notesSave('a.md', 7 as unknown as string)).rejects.toThrow('Invalid note content')
    stubFetch(() => Response.json({ path: 'a.md', mtimeMs: Number.NaN }))
    await expect(notesSave('a.md', 'ok')).rejects.toThrow('Invalid note save payload')
    stubFetch(() => Response.json({}))
    await expect(notesCreate('x')).rejects.toThrow('Invalid note create payload')
  })
})
