// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PptWorkbench, type PptWorkbenchProps } from '../src/client/PptWorkbench.tsx'
import type { PptPanelState } from '../src/client/controller.ts'
import { en, zh } from '../src/client/locales.ts'
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

function mount(state: PptPanelState, shown = true, locale: typeof en = en) {
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
    duplicateElement: vi.fn(async () => {}),
    reorderElement: vi.fn(async () => {}),
    insertImage: vi.fn(async () => {}),
    checkDeck: vi.fn(async () => {}),
    preview: vi.fn(async () => {}),
    mediaUrl: vi.fn(() => '/media/example.png'),
    t: (key: keyof typeof en, params?: Record<string, unknown>) =>
      locale[key].replace(/\{(\w+)\}/gu, (match, name: string) => (name in (params ?? {}) ? String(params?.[name]) : match)),
  } as unknown as PptWorkbenchProps
  return { ...render(<PptWorkbench {...props} />), props }
}

describe('PPT 工作台面板', () => {
  it('显示标题、版本与页缩略图，并呈现保存状态', () => {
    mount(ready)
    expect(screen.getAllByText('季度汇报').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/v3/u).length).toBeGreaterThan(0)
    expect(screen.getAllByLabelText(/封面|结论/u)).toHaveLength(2)
    expect(screen.getByText('Saved as v3')).toBeTruthy()
  })

  it('没有演示文稿时仅显示工作台空态，不显示编辑动作与状态栏', () => {
    const panel = mount({ ...ready, project: null }, true, zh)
    expect(screen.getByText('PPT 工作台')).toBeTruthy()
    expect(screen.getByText('还没有打开的演示文稿。')).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: '演示文稿标题' })).toBeNull()
    expect(screen.queryByRole('button', { name: '新建演示文稿' })).toBeNull()
    for (const action of ['撤销', '重做', '质检', '预览', '重新读取', '导出 .pptx']) {
      expect(screen.queryByRole('button', { name: action })).toBeNull()
    }
    expect(screen.queryByRole('contentinfo')).toBeNull()
    expect(screen.queryByText('就绪')).toBeNull()
    expect(panel.props.create).not.toHaveBeenCalled()
  })

  it('尚未打开工程但已有工程可选时，保留打开入口', () => {
    const panel = mount({
      ...ready,
      project: null,
      projects: [{ dir: 'ppt/demo', title: '季度汇报', pages: 2, revision: 3 }],
    }, true, zh)
    fireEvent.click(screen.getByRole('button', { name: /季度汇报/u }))
    expect(panel.props.open).toHaveBeenCalledWith('ppt/demo')
    for (const action of ['撤销', '重做', '质检', '预览', '重新读取', '导出 .pptx']) {
      expect(screen.queryByRole('button', { name: action })).toBeNull()
    }
    expect(screen.queryByRole('contentinfo')).toBeNull()
    expect(screen.queryByText('就绪')).toBeNull()
  })

  it('加载与读取错误保持诊断和重试入口', () => {
    const loading = mount({ ...ready, phase: 'loading', project: null }, true, zh)
    expect(screen.getByText('正在打开工作台…')).toBeTruthy()
    expect(screen.queryByText('还没有打开的演示文稿。')).toBeNull()
    loading.unmount()

    const failed = mount({
      ...ready, phase: 'error', project: null,
      notice: { tone: 'error', reason: '网络离线' },
    }, true, zh)
    expect(screen.getByText('工作台暂时不可用')).toBeTruthy()
    expect(screen.getByText(/网络离线/u)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(failed.props.refresh).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('还没有打开的演示文稿。')).toBeNull()
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

  it('缩略图可收起再展开，选页操作仍可用', () => {
    const panel = mount(ready, true, zh)
    const rail = screen.getByRole('complementary', { name: 'PPT 工作台' })
    expect(within(rail).getByRole('button', { name: '封面' })).toBeTruthy()
    fireEvent.click(within(rail).getByRole('button', { name: '收起缩略图' }))
    expect(screen.queryByRole('complementary', { name: 'PPT 工作台' })).toBeNull()
    expect(screen.queryByRole('button', { name: '封面' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '展开缩略图' }))
    fireEvent.click(within(screen.getByRole('complementary', { name: 'PPT 工作台' })).getByRole('button', { name: '结论' }))
    expect(panel.props.selectPage).toHaveBeenCalledWith(1)
  })

  it('拖动缩略图移动的是拖源页，忙碌时不会提交排序', () => {
    const project = deck()
    const threePageProject: PptSnapshotView = {
      ...project, pages: 3,
      deck: {
        ...project.deck,
        pages: [...project.deck.pages, { id: 'p3', name: '附录', background: null, transition: 'none', elements: [] }],
      },
    }
    const panel = mount({ ...ready, project: threePageProject }, true, zh)
    const pages = within(screen.getByRole('complementary', { name: 'PPT 工作台' })).getAllByRole('listitem')
    fireEvent.dragStart(pages[0] as HTMLElement)
    fireEvent.dragOver(pages[2] as HTMLElement)
    fireEvent.drop(pages[2] as HTMLElement)
    expect(panel.props.movePage).toHaveBeenNthCalledWith(1, 'p1', 2)
    fireEvent.dragStart(pages[0] as HTMLElement)
    fireEvent.dragOver(pages[1] as HTMLElement)
    fireEvent.drop(pages[1] as HTMLElement)
    expect(panel.props.movePage).toHaveBeenNthCalledWith(2, 'p1', 1)
    panel.unmount()

    const busy = mount({ ...ready, project: threePageProject, busy: true }, true, zh)
    const busyPages = within(screen.getByRole('complementary', { name: 'PPT 工作台' })).getAllByRole('listitem')
    fireEvent.dragStart(busyPages[0] as HTMLElement)
    fireEvent.drop(busyPages[2] as HTMLElement)
    expect(busy.props.movePage).not.toHaveBeenCalled()
  })

  it('顶部菜单保留新增页面版式与元素插入操作', () => {
    const panel = mount(ready, true, zh)
    fireEvent.click(screen.getByRole('button', { name: '新增页面' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '要点页' }))
    expect(panel.props.addPage).toHaveBeenCalledWith('bullets')

    fireEvent.click(screen.getByRole('button', { name: '插入' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '文本框' }))
    expect(panel.props.addElement).toHaveBeenCalledWith('text')
    fireEvent.click(screen.getByRole('button', { name: '插入' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '表格' }))
    expect(panel.props.addElement).toHaveBeenCalledWith('table')

    const chooser = screen.getByLabelText('选择图片') as HTMLInputElement
    const choose = vi.spyOn(chooser, 'click')
    fireEvent.click(screen.getByRole('button', { name: '插入' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '图片' }))
    expect(choose).toHaveBeenCalledTimes(1)
    const image = new File(['image'], 'example.png', { type: 'image/png' })
    fireEvent.change(chooser, { target: { files: [image] } })
    expect(panel.props.insertImage).toHaveBeenCalledWith(image)
  })

  it('顶部页面菜单保留页序与删除动作，更多菜单可重新读取', () => {
    const panel = mount({ ...ready, pageIndex: 1 }, true, zh)
    fireEvent.click(screen.getByRole('button', { name: '页面' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '上移' }))
    expect(panel.props.movePage).toHaveBeenCalledWith('p2', 0)
    fireEvent.click(screen.getByRole('button', { name: '页面' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '删除当前页' }))
    expect(panel.props.removePage).toHaveBeenCalledWith('p2')
    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '重新读取' }))
    expect(panel.props.refresh).toHaveBeenCalledTimes(1)
    panel.unmount()

    const first = mount(ready, true, zh)
    fireEvent.click(screen.getByRole('button', { name: '页面' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '下移' }))
    expect(first.props.movePage).toHaveBeenCalledWith('p1', 1)
  })

  it('属性按需打开、关闭与 Escape 收起，编辑动作仍提交', () => {
    const panel = mount({ ...ready, selectedId: 't1' }, true, zh)
    expect(screen.queryByRole('dialog', { name: '属性' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '属性' }))
    expect(screen.getByRole('dialog', { name: '属性' })).toBeTruthy()
    const size = screen.getByRole('spinbutton', { name: '字号' })
    fireEvent.change(size, { target: { value: '48' } })
    fireEvent.blur(size)
    expect(panel.props.updateElement).toHaveBeenCalledWith('t1', { text: { size: 48 } })
    fireEvent.click(screen.getByRole('button', { name: '关闭属性' }))
    expect(screen.queryByRole('dialog', { name: '属性' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '属性' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '属性' })).toBeNull()
  })

  it('从属性切到插入菜单后 Escape 不留下悬浮操作层', () => {
    mount(ready, true, zh)
    fireEvent.click(screen.getByRole('button', { name: '属性' }))
    expect(screen.getByRole('dialog', { name: '属性' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '插入' }))
    expect(screen.queryByRole('dialog', { name: '属性' })).toBeNull()
    expect(screen.getByRole('menuitem', { name: '文本框' })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.queryByRole('dialog', { name: '属性' })).toBeNull()
    expect(screen.getByRole('button', { name: '插入' }).getAttribute('aria-expanded')).toBe('false')
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
