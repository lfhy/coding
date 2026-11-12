// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PptElement } from 'coding-ppt-model'
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
  pageIndex: 0, selectedId: null, editingId: null, hasClipboard: false, fonts: [], busy: false, notice: null, issues: null,
}

function mount(state: PptPanelState, shown = true, locale: typeof en = en) {
  const props = {
    sessionId: 'session-one',
    useTabInfo: () => ({ shown, tab: { id: 'ppt-1', params: {} } }),
    usePpt: (choose: (snapshot: PptPanelState) => unknown) => choose(state),
    useTemplateCatalog: (choose: (snapshot: unknown) => unknown) => choose({
      phase: 'ready', templates: [], details: {}, error: null,
      builtins: { phase: 'idle', deck: null, error: null },
      defaultTemplate: { phase: 'idle', deck: null, error: null },
    }),
    catalogActions: {
      loadTemplates: vi.fn(async () => {}), loadBuiltins: vi.fn(async () => {}), loadDefault: vi.fn(async () => {}),
      detailTemplate: vi.fn(async () => {}),
      templateMediaUrl: vi.fn(() => '/api/ppt/templates/media'),
      handoffPrompt: vi.fn(async () => {}),
      cancelHandoff: vi.fn(),
      focusPrompt: vi.fn(),
    },
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
    editCell: vi.fn(async () => {}),
    updatePage: vi.fn(async () => {}),
    updateDeck: vi.fn(async () => {}),
    duplicateElement: vi.fn(async () => {}),
    copyElement: vi.fn(),
    cutElement: vi.fn(async () => {}),
    pasteElement: vi.fn(async () => {}),
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

function deckWith(...elements: PptElement[]): PptSnapshotView {
  const source = deck()
  return { ...source, deck: { ...source.deck, pages: [
    { ...source.deck.pages[0]!, elements }, source.deck.pages[1]!,
  ] } }
}

function canvasElement(container: HTMLElement, id: string): HTMLElement {
  const matches = container.querySelectorAll<HTMLElement>(`[data-element-id="${id}"]`)
  const element = matches.item(matches.length - 1)
  if (element === null) throw new Error(`画布元素 ${id} 缺失`)
  return element
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
    fireEvent.click(screen.getByRole('button', { name: '模板管理' }))
    expect(screen.getByRole('dialog', { name: 'PPT 模板管理' })).toBeTruthy()
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

  it('更多菜单打开同一只读模板管理弹窗', () => {
    const panel = mount(ready, true, zh)
    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '模板管理' }))
    const dialog = screen.getByRole('dialog', { name: 'PPT 模板管理' })
    expect(within(dialog).getAllByRole('heading', { name: 'PPT 模板管理' })).toHaveLength(1)
    expect(screen.getByRole('button', { name: '导入 / 创建模板' })).toBeTruthy()
    expect(panel.props.catalogActions.loadTemplates).toHaveBeenCalledOnce()
  })

  it('空工程仍能打开模板目录并经对话交接提示词', async () => {
    const panel = mount({ ...ready, project: null }, true, zh)
    fireEvent.click(screen.getByRole('button', { name: '模板管理' }))
    expect(screen.getByRole('dialog', { name: 'PPT 模板管理' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '导入 / 创建模板' }))
    await waitFor(() => { expect(panel.props.catalogActions.handoffPrompt).toHaveBeenCalledOnce() })
    expect(screen.queryByRole('dialog', { name: 'PPT 模板管理' })).toBeNull()
    expect(panel.props.catalogActions.focusPrompt).toHaveBeenCalledOnce()
  })

  it('模板弹窗关闭时取消未完成交接，不在迟到成功后聚焦', async () => {
    let release!: () => void
    const waiting = new Promise<void>((resolve) => { release = resolve })
    const panel = mount({ ...ready, project: null }, true, zh)
    vi.mocked(panel.props.catalogActions.handoffPrompt).mockReturnValueOnce(waiting)
    fireEvent.click(screen.getByRole('button', { name: '模板管理' }))
    fireEvent.click(screen.getByRole('button', { name: '导入 / 创建模板' }))
    const id = vi.mocked(panel.props.catalogActions.handoffPrompt).mock.calls[0]?.[1]
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(panel.props.catalogActions.cancelHandoff).toHaveBeenCalledWith(id)
    await act(async () => { release(); await waiting })
    expect(panel.props.catalogActions.focusPrompt).not.toHaveBeenCalled()
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

  it('默认整稿的主题可以在属性面板中选中和提交', () => {
    const project = deck()
    const panel = mount({ ...ready, project: { ...project, deck: { ...project.deck, theme: 'inference' } } }, true, zh)
    fireEvent.click(screen.getByRole('button', { name: '属性' }))
    const theme = screen.getByRole('combobox', { name: '主题' }) as HTMLSelectElement
    expect(theme.value).toBe('inference')
    expect(screen.getByRole('option', { name: '简明汇报' })).toBeTruthy()
    fireEvent.change(theme, { target: { value: 'forest' } })
    expect(panel.props.updateDeck).toHaveBeenCalledWith({ theme: 'forest' })
    fireEvent.change(theme, { target: { value: 'inference' } })
    expect(panel.props.updateDeck).toHaveBeenCalledWith({ theme: 'inference' })
    expect(en.themeInference).toBe('Clear briefing')
  })

  it('字体选择器展开后按字体预览，并提交所选族名', () => {
    const project = deck()
    const panel = mount({
      ...ready, project, selectedId: 't1', fonts: ['黑体', 'Songti SC'],
    }, true, zh)
    fireEvent.click(screen.getByRole('button', { name: '属性' }))
    // 元素 font 为空表示跟随默认，按钮据此显示鸿蒙黑体；本机字体排在它后面。
    const trigger = screen.getByRole('combobox', { name: '字体' })
    expect(trigger.textContent).toContain('HarmonyOS Sans SC')
    fireEvent.click(trigger)
    const options = within(screen.getByRole('listbox', { name: '字体' })).getAllByRole('option')
    expect(options.map(option => option.textContent)).toEqual([
      '永和 Aa 123HarmonyOS Sans SC（默认）',
      '永和 Aa 123黑体',
      '永和 Aa 123Songti SC',
    ])
    // 每一项都用它自己的字体渲染示例字与族名，选之前就能看出字形。
    expect(options[2]?.querySelector('span')?.getAttribute('style')).toContain('Songti SC')
    fireEvent.click(options[2]!)
    expect(panel.props.updateElement).toHaveBeenCalledWith('t1', { text: { font: 'Songti SC' } })
    expect(screen.queryByRole('listbox', { name: '字体' })).toBeNull()
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

  it('画布右键命中元素与空白，提供剪贴、删除、插入和图片替换', () => {
    const image: PptElement = { id: 'img-1', kind: 'image', source: 'media/old.png', fit: 'contain',
      x: 120, y: 140, w: 400, h: 200 }
    const panel = mount({ ...ready, project: deckWith(image), hasClipboard: true }, true, zh)
    const item = canvasElement(panel.container, image.id)
    fireEvent.contextMenu(item, { clientX: 120, clientY: 140 })
    expect(panel.props.selectElement).toHaveBeenCalledWith('img-1')
    expect(screen.getByRole('menuitem', { name: '替换图片' })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: '复制' }))
    expect(panel.props.copyElement).toHaveBeenCalledWith('img-1')

    fireEvent.contextMenu(item, { clientX: 140, clientY: 150 })
    fireEvent.click(screen.getByRole('menuitem', { name: '粘贴' }))
    const pasteAt = vi.mocked(panel.props.pasteElement).mock.calls[0]?.[0]
    expect(typeof pasteAt?.x).toBe('number')
    expect(typeof pasteAt?.y).toBe('number')
    fireEvent.contextMenu(item)
    fireEvent.click(screen.getByRole('menuitem', { name: '剪切' }))
    expect(panel.props.cutElement).toHaveBeenCalledWith('img-1')
    fireEvent.contextMenu(item)
    fireEvent.click(screen.getByRole('menuitem', { name: '删除元素' }))
    expect(panel.props.removeElement).toHaveBeenCalledWith('img-1')

    const chooser = screen.getByLabelText('选择图片') as HTMLInputElement
    const choose = vi.spyOn(chooser, 'click')
    fireEvent.contextMenu(item)
    fireEvent.click(screen.getByRole('menuitem', { name: '替换图片' }))
    expect(choose).toHaveBeenCalledOnce()
    const replacement = new File(['image'], 'new.png', { type: 'image/png' })
    fireEvent.change(chooser, { target: { files: [replacement] } })
    expect(panel.props.insertImage).toHaveBeenCalledWith(replacement, 'img-1')

    const surface = panel.container.querySelectorAll<HTMLElement>('[class*="surface"]').item(2)
    expect(surface).toBeTruthy()
    fireEvent.contextMenu(surface, { clientX: 200, clientY: 200 })
    expect(screen.queryByRole('menuitem', { name: '剪切' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: '表格' }))
    expect(panel.props.addElement).toHaveBeenCalledWith('table')
  })

  it('右键覆盖在矩形上的截图文字可替换整块，普通文字不出现替换图片', () => {
    const rect: PptElement = { id: 'rect-1', kind: 'rect', x: 96, y: 188, w: 254, h: 143, fill: '#e8e5dc' }
    const hint: PptElement = { id: 'hint-1', kind: 'text', x: 96, y: 188, w: 254, h: 143,
      text: { content: '代码截图', size: 14, color: '#75736c', bold: false, align: 'center', valign: 'middle', font: '' } }
    const text: PptElement = { id: 'body-1', kind: 'text', x: 96, y: 350, w: 254, h: 40,
      text: { content: '普通正文', size: 20, color: '#333333', bold: false, align: 'left', valign: 'top', font: '' } }
    const panel = mount({ ...ready, project: deckWith(rect, hint, text) }, true, zh)
    fireEvent.contextMenu(canvasElement(panel.container, 'body-1'))
    expect(screen.queryByRole('menuitem', { name: '替换图片' })).toBeNull()
    fireEvent.contextMenu(canvasElement(panel.container, 'hint-1'))
    expect(screen.getByRole('menuitem', { name: '替换图片' })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: '替换图片' }))
    const replacement = new File(['image'], 'shot.png', { type: 'image/png' })
    fireEvent.change(screen.getByLabelText('选择图片'), { target: { files: [replacement] } })
    expect(panel.props.insertImage).toHaveBeenCalledWith(replacement, 'rect-1', 'hint-1')
    fireEvent.contextMenu(canvasElement(panel.container, 'rect-1'))
    fireEvent.click(screen.getByRole('menuitem', { name: '替换图片' }))
    fireEvent.change(screen.getByLabelText('选择图片'), { target: { files: [replacement] } })
    expect(panel.props.insertImage).toHaveBeenLastCalledWith(replacement, 'rect-1', 'hint-1')
  })

  it('画布表格单元格双击编辑，失焦提交，Escape 放弃，快捷键不误删', () => {
    const table: PptElement = { id: 'table-1', kind: 'table', x: 100, y: 100, w: 420, h: 200,
      rows: 2, columns: 2, columnWeights: [1, 1], header: true, headerFill: '#eeeeee', borderColor: '#333333',
      text: { size: 20, color: '#111111', bold: false, align: 'left', font: '' },
      cells: [[{ content: '项目' }, { content: '状态' }], [{ content: '原值' }, { content: '完成' }]],
    }
    const panel = mount({ ...ready, project: deckWith(table) }, true, zh)
    const item = canvasElement(panel.container, table.id)
    fireEvent.doubleClick(within(item).getByText('原值'))
    const editor = screen.getByRole('textbox', { name: '第2行，第1列' })
    fireEvent.change(editor, { target: { value: '新值' } })
    fireEvent.blur(editor)
    expect(panel.props.editCell).toHaveBeenCalledWith('table-1', 1, 0, '新值')
    fireEvent.doubleClick(within(item).getByText('原值'))
    fireEvent.change(screen.getByRole('textbox', { name: '第2行，第1列' }), { target: { value: '' } })
    fireEvent.keyDown(screen.getByRole('textbox', { name: '第2行，第1列' }), { key: 'Escape' })
    expect(panel.props.editCell).toHaveBeenCalledTimes(1)
  })

  it('画布快捷键只在非输入状态操作选中元素，缩略图不拦截右键', () => {
    const image: PptElement = { id: 'img-1', kind: 'image', source: 'media/old.png', fit: 'contain',
      x: 120, y: 140, w: 400, h: 200 }
    const panel = mount({ ...ready, project: deckWith(image), selectedId: image.id, hasClipboard: true }, true, zh)
    const item = canvasElement(panel.container, image.id)
    fireEvent.keyDown(item, { key: 'c', ctrlKey: true })
    fireEvent.keyDown(item, { key: 'x', ctrlKey: true })
    fireEvent.keyDown(item, { key: 'v', metaKey: true })
    fireEvent.keyDown(item, { key: 'd', metaKey: true })
    expect(panel.props.copyElement).toHaveBeenCalledWith(image.id)
    expect(panel.props.cutElement).toHaveBeenCalledWith(image.id)
    expect(panel.props.pasteElement).toHaveBeenCalledWith(undefined)
    expect(panel.props.duplicateElement).toHaveBeenCalledWith(image.id)
    fireEvent.keyDown(item, { key: 'Delete' })
    expect(panel.props.removeElement).toHaveBeenCalledWith(image.id)

    const thumbnail = panel.container.querySelectorAll<HTMLElement>('[data-element-id="img-1"]').item(0)
    const rightClick = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    expect(thumbnail.dispatchEvent(rightClick)).toBe(true)
    expect(screen.queryByRole('menu')).toBeNull()
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
