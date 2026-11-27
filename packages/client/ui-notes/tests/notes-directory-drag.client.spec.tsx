// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { createRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react'
import { NotesDirectory } from '../src/client/NotesDirectory.tsx'
import { zh } from '../src/client/locales.ts'
import type { NotesTreeEntry } from '../src/client/wire.ts'

const tree: NotesTreeEntry[] = [
  { name: 'a.md', kind: 'file', path: 'a.md', mtimeMs: 1 },
  { name: 'b.md', kind: 'file', path: 'b.md', mtimeMs: 2 },
  { name: 'c.md', kind: 'file', path: 'c.md', mtimeMs: 3 },
  { name: 'd', kind: 'dir', path: 'd', mtimeMs: 4, children: [{ name: 'x.md', kind: 'file', path: 'd/x.md', mtimeMs: 5 }] },
]

const translate = ((key: keyof typeof zh, params?: { name: string }) =>
  params === undefined ? zh[key] : zh[key].replace('{name}', params.name)) as unknown as ComponentProps<typeof NotesDirectory>['t']

function setup() {
  const onMove = vi.fn()
  const imports = {
    text: { accept: '.md', onFile: vi.fn() },
    slides: { accept: '.pptx', onFile: vi.fn() },
    mindmap: { accept: '.xmind', onFile: vi.fn() },
    word: { accept: '.docx', onFile: vi.fn() },
    excel: { accept: '.xlsx', onFile: vi.fn() },
  }
  function Harness() {
    const [query, setQuery] = useState('')
    return <NotesDirectory
      t={translate}
      tree={tree} expanded={new Set(['d'])} activePath={null} collapsed={false} width={280}
      creating={false} query={query} onQueryChange={setQuery} launcherRef={createRef<HTMLButtonElement>()}
      onToggleDir={vi.fn()} onSelectPath={vi.fn()} onMove={onMove} onCreate={vi.fn()} onEdit={vi.fn()} imports={imports} />
  }
  render(<Harness />)
  return { onMove }
}

function row(name: string): HTMLElement {
  const element = screen.getByTitle(name).closest('[role="listitem"]')
  if (!(element instanceof HTMLElement)) throw new Error('缺少目录行')
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 220, 40))
  return element
}

function transfer(setData = vi.fn()): DataTransfer {
  return { effectAllowed: 'none', dropEffect: 'none', setData } as unknown as DataTransfer
}

/** jsdom 的 drag 事件不带鼠标坐标，测试需显式补上真实浏览器会提供的 clientY。 */
function dragPointer(type: 'dragOver' | 'drop', target: HTMLElement, clientY: number, dataTransfer: DataTransfer): void {
  const event = createEvent[type](target, { dataTransfer })
  Object.defineProperty(event, 'clientY', { value: clientY })
  fireEvent(target, event)
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('NotesDirectory drag interactions', () => {
  it('拖到目录中部移入该目录，拖到行边缘按同级位置排序', () => {
    const { onMove } = setup()
    const setData = vi.fn()
    const dataTransfer = transfer(setData)
    fireEvent.dragStart(screen.getByTitle('a'), { dataTransfer })
    expect(dataTransfer.effectAllowed).toBe('move')
    expect(setData).toHaveBeenCalledWith('text/plain', 'a.md')

    const folder = row('d')
    dragPointer('dragOver', folder, 20, dataTransfer)
    expect(folder.getAttribute('data-drop-position')).toBe('inside')
    expect(dataTransfer.dropEffect).toBe('move')
    dragPointer('drop', folder, 20, dataTransfer)
    expect(onMove).toHaveBeenLastCalledWith('a.md', 'd', null)

    fireEvent.dragStart(screen.getByTitle('b'), { dataTransfer })
    const target = row('a')
    dragPointer('dragOver', target, 5, dataTransfer)
    expect(target.getAttribute('data-drop-position')).toBe('before')
    dragPointer('drop', target, 5, dataTransfer)
    expect(onMove).toHaveBeenLastCalledWith('b.md', '', 'a.md')

    fireEvent.dragStart(screen.getByTitle('a'), { dataTransfer })
    const afterTarget = row('b')
    dragPointer('dragOver', afterTarget, 35, dataTransfer)
    dragPointer('drop', afterTarget, 35, dataTransfer)
    expect(onMove).toHaveBeenLastCalledWith('a.md', '', 'c.md')
  })

  it('忽略拖到自身和把目录拖进自身后代', () => {
    const { onMove } = setup()
    const dataTransfer = transfer()
    fireEvent.dragStart(screen.getByTitle('a'), { dataTransfer })
    const self = row('a')
    dragPointer('dragOver', self, 20, dataTransfer)
    dragPointer('drop', self, 20, dataTransfer)

    fireEvent.dragStart(screen.getByTitle('d'), { dataTransfer })
    const child = row('x')
    dragPointer('dragOver', child, 20, dataTransfer)
    dragPointer('drop', child, 20, dataTransfer)
    expect(onMove).not.toHaveBeenCalled()
  })

  it('搜索和创建期间禁用拖拽，避免按过滤后的列表提交不完整顺序', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: '搜索笔记' }))
    fireEvent.change(screen.getByRole('textbox', { name: '搜索笔记' }), { target: { value: 'a' } })
    expect(screen.getByTitle('a').getAttribute('draggable')).toBe('false')
  })
})
