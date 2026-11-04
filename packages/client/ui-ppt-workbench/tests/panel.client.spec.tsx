// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PptWorkbench, type PptWorkbenchProps } from '../src/client/PptWorkbench.tsx'
import type { PptPanelState } from '../src/client/controller.ts'
import { en } from '../src/client/locales.ts'
import type { PptSnapshotView } from '../src/client/wire.ts'

// jsdom 没有 ResizeObserver：画布只在观察到尺寸后才渲染，因此这里立刻回调一个固定视口。
class FixedResizeObserver {
  constructor(private readonly callback: (entries: { contentRect: { width: number; height: number } }[]) => void) {}
  observe(): void {
    this.callback([{ contentRect: { width: 900, height: 520 } }])
  }
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= FixedResizeObserver as unknown as typeof ResizeObserver

afterEach(() => { cleanup() })

function deck(): PptSnapshotView {
  return {
    dir: 'ppt/demo',
    title: '季度汇报',
    revision: 3,
    pages: 2,
    canUndo: true,
    canRedo: false,
    deck: {
      format: 1,
      title: '季度汇报',
      size: '16:9',
      theme: 'ink',
      pages: [
        {
          id: 'p1', name: '封面', background: null, transition: 'none',
          elements: [{
            id: 't1', kind: 'text', x: 96, y: 260, w: 1088, h: 120,
            text: { content: '季度汇报', size: 64, color: '#f5f7fa', bold: true, align: 'left', valign: 'middle', font: '' },
          }],
        },
        { id: 'p2', name: '结论', background: null, transition: 'none', elements: [] },
      ],
    },
  }
}

const ready: PptPanelState = {
  phase: 'ready', root: '/workspace', projects: [], project: deck(),
  pageIndex: 0, selectedId: null, editingId: null, busy: false, notice: null, issues: null,
}

function mount(state: PptPanelState, shown = true) {
  const props = {
    sessionId: 'session-one',
    useTabInfo: () => ({ shown, tab: { id: 'ppt-1', params: {} } }),
    usePpt: (choose: (snapshot: PptPanelState) => unknown) => choose(state),
    show: vi.fn(),
    refresh: vi.fn(),
    open: vi.fn(async () => {}),
    create: vi.fn(async () => {}),
    undo: vi.fn(async () => {}),
    redo: vi.fn(async () => {}),
    exportDeck: vi.fn(async () => {}),
    selectPage: vi.fn(),
    selectElement: vi.fn(),
    setEditing: vi.fn(),
    addPage: vi.fn(async () => {}),
    removePage: vi.fn(async () => {}),
    movePage: vi.fn(async () => {}),
    addElement: vi.fn(async () => {}),
    removeElement: vi.fn(async () => {}),
    updateElement: vi.fn(async () => {}),
    updatePage: vi.fn(async () => {}),
    updateDeck: vi.fn(async () => {}),
    t: (key: keyof typeof en, params?: Record<string, unknown>) =>
      en[key].replace(/\{(\w+)\}/gu, (match, name: string) => (name in (params ?? {}) ? String(params?.[name]) : match)),
  } as unknown as PptWorkbenchProps
  return { ...render(<PptWorkbench {...props} />), props }
}

describe('PPT 工作台面板', () => {
  it('显示标题、版本与页缩略图，并呈现保存状态', () => {
    mount(ready)
    expect(screen.getAllByText('季度汇报').length).toBeGreaterThan(0)
    expect(screen.getByText('v3')).toBeTruthy()
    expect(screen.getAllByLabelText(/封面|结论/u)).toHaveLength(2)
    expect(screen.getByText('Saved as v3')).toBeTruthy()
  })

  it('没有工程时给出现有工程入口与新建表单', () => {
    const panel = mount({
      ...ready,
      project: null,
      projects: [{ dir: 'ppt/demo', title: '季度汇报', pages: 2, revision: 3 }],
    })
    fireEvent.click(screen.getByText('季度汇报'))
    expect(panel.props.open).toHaveBeenCalledWith('ppt/demo')

    const input = screen.getByLabelText('Deck title') as HTMLInputElement
    fireEvent.change(input, { target: { value: '新稿子' } })
    fireEvent.submit(input.closest('form') as HTMLFormElement)
    expect(panel.props.create).toHaveBeenCalledWith('新稿子')
  })

  it('撤销按钮跟随历史状态，导出一次性提交', () => {
    const panel = mount(ready)
    const undo = screen.getByTitle('Undo') as HTMLButtonElement
    const redo = screen.getByTitle('Redo') as HTMLButtonElement
    expect(undo.disabled).toBe(false)
    expect(redo.disabled).toBe(true)
    fireEvent.click(undo)
    expect(panel.props.undo).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByText('Export .pptx'))
    expect(panel.props.exportDeck).toHaveBeenCalledTimes(1)
  })

  it('切换页时上报页码，双击文字进入就地编辑', () => {
    const panel = mount(ready)
    fireEvent.click(screen.getAllByLabelText(/封面|结论/u)[1] as HTMLElement)
    expect(panel.props.selectPage).toHaveBeenCalledWith(1)

    // 缩略图与画布都渲染同一个元素；画布的那个在最后。
    const text = panel.container.querySelectorAll('[data-element-id="t1"]').item(1) as HTMLElement
    fireEvent.doubleClick(text)
    expect(panel.props.setEditing).toHaveBeenCalledWith('t1')
  })

  it('冲突提示属于警告级别并说明当前版本', () => {
    mount({ ...ready, notice: { tone: 'conflict', revision: 4 } })
    const status = screen.getByText(/changed elsewhere/u)
    expect(status.textContent).toContain('v4')
  })

  it('面板隐藏时停止轮询', () => {
    const panel = mount(ready, false)
    expect(panel.props.show).not.toHaveBeenCalled()
  })
})
