// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MindmapEditor } from '../src/client/MindmapEditor.tsx'
import { en, zh } from '../src/client/locales.ts'

type EditorProps = Parameters<typeof MindmapEditor>[0]
type WireNode = { id: string; text: string; children: WireNode[] }
const PATH = '项目/重点 & 方向.codingmindmap'
const OTHER = '另一个.codingmindmap'
const http = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()

const node = (id: string, text: string, ...children: WireNode[]): WireNode => ({ id, text, children })
const snapshot = (revision: string, root: WireNode, path = PATH) => ({ path, revision, document: { version: 1, root } })
const response = (revision: string, root: WireNode, path = PATH) => Response.json(snapshot(revision, root, path))
const issue = (status: number) => Response.json({ error: '/private/debug.json' }, { status })
const leafA = node('a', '甲')
const leafB = node('b', '乙')
const main = node('r', '计划', leafA, leafB)

function translator(dict: Readonly<Partial<Record<string, string>>>): EditorProps['t'] {
  return (key, params) => (dict[key] ?? key).replace('{name}', typeof params?.name === 'string' ? params.name : '')
}

const props: EditorProps = {
  path: PATH, shown: true, sessionId: 'notes-session' as EditorProps['sessionId'],
  useSession: vi.fn(), useSessions: vi.fn(), useWorkspaces: vi.fn(), useProjection: vi.fn(), useInput: vi.fn(),
  inputActions: { setDraft: vi.fn(), addImages: vi.fn(() => false), removeImage: vi.fn(), pruneImages: vi.fn(), submit: vi.fn() },
  t: translator(zh),
}

function dialog(name: string) {
  return within(screen.getByRole('dialog', { name }))
}

function canvas() {
  return within(screen.getByRole('region', { name: '思维导图画布' }))
}

function topic(name: string) {
  return canvas().getByRole('button', { name })
}

function action(name: string) {
  return within(screen.getByRole('group', { name: '思维导图操作' })).getByRole<HTMLButtonElement>('button', { name })
}

function sent(index: number): unknown {
  const body = http.mock.calls[index]?.[1]?.body
  if (typeof body !== 'string') throw new TypeError('编辑没有发送 JSON')
  return JSON.parse(body) as unknown
}

async function mount(initial = props) {
  const rendered = render(<MindmapEditor {...initial} />)
  await act(async () => { await Promise.resolve() })
  return rendered
}

async function press(target: Element) {
  await act(async () => { fireEvent.click(target) })
}

async function tick() {
  await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
}

beforeEach(() => {
  http.mockReset()
  vi.stubGlobal('fetch', http)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('笔记中的思维导图编辑', () => {
  it('保留分支层级，用方向键选节点，并只提交确认的添加、重命名和删除', async () => {
    const existing = node('e', '已有节点')
    const original = node('r', '计划', node('a', '甲', existing), leafB)
    const rootWithNew = node('r', '计划', node('a', '甲', existing, node('n', '新节点')), leafB)
    const rootAfterRename = node('r', '计划', node('a', '甲', existing, node('n', '方案')), leafB)
    http.mockResolvedValueOnce(response('v1', original))
      .mockResolvedValueOnce(response('v2', rootWithNew)).mockResolvedValueOnce(response('v3', rootAfterRename))
      .mockResolvedValueOnce(response('v4', original))
    await mount()
    expect(http.mock.calls[0]?.[0]).toBe('/api/notes/mindmap/read?path=%E9%A1%B9%E7%9B%AE%2F%E9%87%8D%E7%82%B9+%26+%E6%96%B9%E5%90%91.codingmindmap')
    expect(canvas().getAllByRole('list')).toHaveLength(3)
    expect(topic('计划').getAttribute('aria-pressed')).toBe('true')
    expect(action('更多分支操作').disabled).toBe(true)
    topic('计划').focus()
    fireEvent.keyDown(topic('计划'), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(topic('甲'))
    expect(topic('甲').getAttribute('aria-pressed')).toBe('true')
    fireEvent.keyDown(topic('甲'), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(topic('已有节点'))
    fireEvent.keyDown(topic('已有节点'), { key: 'End' })
    expect(document.activeElement).toBe(topic('乙'))
    fireEvent.keyDown(topic('乙'), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(topic('乙'))
    fireEvent.keyDown(topic('乙'), { key: 'Home' })
    expect(document.activeElement).toBe(topic('计划'))
    fireEvent.keyDown(topic('计划'), { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(topic('计划'))
    fireEvent.keyDown(topic('计划'), { key: 'Tab' })
    fireEvent.keyDown(topic('计划'), { key: 'ArrowRight' })
    fireEvent.keyDown(topic('甲'), { key: 'ArrowDown' })
    fireEvent.keyDown(topic('已有节点'), { key: 'ArrowUp' })
    expect(document.activeElement).toBe(topic('甲'))

    fireEvent.click(action('添加子节点'))
    const add = dialog('添加子节点')
    const field = add.getByRole('textbox', { name: '节点文字' })
    expect(document.activeElement).toBe(field)
    fireEvent.change(field, { target: { value: '新节点' } })
    await press(add.getByRole('button', { name: '添加子节点' }))
    expect(http.mock.calls[1]).toMatchObject(['/api/notes/mindmap/edit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
    }])
    expect(sent(1)).toEqual({ path: PATH, revision: 'v1', edits: [{ op: 'add', parentId: 'a', text: '新节点' }] })
    expect(topic('新节点').getAttribute('aria-pressed')).toBe('true')
    expect(document.activeElement).toBe(action('添加子节点'))
    expect(screen.getByRole('alert').textContent).toBe('思维导图已保存')

    fireEvent.click(action('编辑文字'))
    const rename = dialog('编辑文字')
    const renameField = rename.getByRole<HTMLInputElement>('textbox', { name: '节点文字' })
    expect(renameField.value).toBe('新节点')
    fireEvent.change(renameField, { target: { value: '方案' } })
    await press(rename.getByRole('button', { name: '保存' }))
    expect(sent(2)).toEqual({ path: PATH, revision: 'v2', edits: [{ op: 'rename', id: 'n', text: '方案' }] })
    expect(topic('方案')).toBeTruthy()

    fireEvent.click(action('更多分支操作'))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(action('更多分支操作'))
    fireEvent.click(action('更多分支操作'))
    fireEvent.click(screen.getByRole('menuitem', { name: '删除分支' }))
    const remove = dialog('删除分支')
    expect(remove.getByText('要删除「方案」及其下的所有节点吗？此操作无法撤销。')).toBeTruthy()
    expect(document.activeElement).toBe(remove.getByRole('button', { name: '取消' }))
    expect(http).toHaveBeenCalledTimes(3)
    await press(remove.getByRole('button', { name: '删除分支' }))
    expect(sent(3)).toEqual({ path: PATH, revision: 'v3', edits: [{ op: 'delete', id: 'n' }] })
    expect(canvas().queryByRole('button', { name: '方案' })).toBeNull()
    expect(topic('甲').getAttribute('aria-pressed')).toBe('true')
  })

  it('移动分支时只列出合法的新上级，同级移位采用移除来源后的下标', async () => {
    const source = node('a', '甲', node('n', '甲的孩子'))
    const arranged = node('r', '计划', leafB, source)
    const moved = node('r', '计划', node('b', '乙', source))
    http.mockResolvedValueOnce(response('v1', node('r', '计划', source, leafB)))
      .mockResolvedValueOnce(response('v2', arranged)).mockResolvedValueOnce(response('v3', moved))
    await mount()
    fireEvent.click(topic('甲'))
    fireEvent.click(action('更多分支操作'))
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: '向前移一位' }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('menuitem', { name: '向后移一位' }))
    await press(dialog('向后移一位').getByRole('button', { name: '保存' }))
    expect(sent(1)).toEqual({ path: PATH, revision: 'v1', edits: [{ op: 'move', id: 'a', parentId: 'r', index: 1 }] })
    expect(canvas().getAllByRole('button').map(button => button.textContent)).toEqual(['计划', '乙', '甲', '甲的孩子'])

    fireEvent.click(action('更多分支操作'))
    fireEvent.click(screen.getByRole('menuitem', { name: '移动分支' }))
    const move = dialog('移动分支')
    const picker = move.getByRole('button', { name: '上级节点' })
    fireEvent.click(picker)
    expect(move.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['计划 › 乙'])
    fireEvent.click(picker)
    expect(move.queryByRole('menuitem')).toBeNull()
    fireEvent.click(picker)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(move.queryByRole('menuitem')).toBeNull()
    expect(document.activeElement).toBe(picker)
    fireEvent.click(picker)
    fireEvent.click(move.getByRole('menuitem', { name: '计划 › 乙' }))
    await press(move.getByRole('button', { name: '保存' }))
    expect(sent(2)).toEqual({ path: PATH, revision: 'v2', edits: [{ op: 'move', id: 'a', parentId: 'b' }] })
    expect(within(topic('乙').closest('li')!).getByRole('button', { name: '甲的孩子' })).toBeTruthy()
  })

  it('移动目标被外部删除后，刷新才能重新选择上级并保存', async () => {
    vi.useFakeTimers()
    const third = node('c', '丙')
    const latest = node('r', '计划', leafA, third)
    http.mockResolvedValueOnce(response('v1', node('r', '计划', leafA, leafB, third)))
      .mockResolvedValueOnce(response('v2', latest)).mockResolvedValueOnce(response('v2', latest))
      .mockResolvedValueOnce(response('v3', node('r', '计划', node('c', '丙', leafA))))
    await mount()
    fireEvent.click(topic('甲'))
    fireEvent.click(action('更多分支操作'))
    fireEvent.click(screen.getByRole('menuitem', { name: '移动分支' }))
    const move = dialog('移动分支')
    const picker = move.getByRole('button', { name: '上级节点' })
    const save = move.getByRole<HTMLButtonElement>('button', { name: '保存' })
    fireEvent.click(picker)
    fireEvent.click(move.getByRole('menuitem', { name: '计划 › 乙' }))
    expect(save.disabled).toBe(false)

    await tick()
    expect(picker.getAttribute('aria-describedby')).toBe(move.getByRole('alert').id)
    expect(save.disabled).toBe(true)
    await press(move.getByRole('button', { name: '刷新导图' }))
    expect(save.disabled).toBe(true)
    fireEvent.click(picker)
    expect(move.queryByRole('menuitem', { name: '计划 › 乙' })).toBeNull()
    fireEvent.click(move.getByRole('menuitem', { name: '计划 › 丙' }))
    expect(save.disabled).toBe(false)
    await press(save)
    expect(sent(3)).toEqual({ path: PATH, revision: 'v2', edits: [{ op: 'move', id: 'a', parentId: 'c' }] })
  })

  it('409 后显式刷新并保留输入；重新提交使用新版本而不是自动重放', async () => {
    const conflict = Promise.withResolvers<Response>()
    const latest = Promise.withResolvers<Response>()
    http.mockResolvedValueOnce(response('v1', main)).mockReturnValueOnce(conflict.promise).mockResolvedValueOnce(issue(503))
      .mockReturnValueOnce(latest.promise)
      .mockResolvedValueOnce(response('v3', node('r', '我的新名称', leafA, leafB)))
    await mount()
    fireEvent.click(action('编辑文字'))
    const rename = dialog('编辑文字')
    const field = rename.getByRole<HTMLInputElement>('textbox', { name: '节点文字' })
    const save = rename.getByRole<HTMLButtonElement>('button', { name: '保存' })
    fireEvent.change(field, { target: { value: '我的新名称' } })
    save.focus()
    fireEvent.click(save)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBeTruthy()
    await act(async () => { conflict.resolve(issue(409)) })
    expect(sent(1)).toEqual({ path: PATH, revision: 'v1', edits: [{ op: 'rename', id: 'r', text: '我的新名称' }] })
    expect(rename.getByRole('alert').textContent).toContain('输入会保留')
    expect(field.value).toBe('我的新名称')
    expect(save.disabled).toBe(true)

    const reload = rename.getByRole('button', { name: '刷新导图' })
    expect(document.activeElement).toBe(reload)
    fireEvent.submit(field.closest('form')!)
    expect(http).toHaveBeenCalledTimes(2)
    await press(reload)
    expect(rename.getByRole('alert').textContent).toBe('无法取得最新内容，请再试一次。')
    fireEvent.click(reload)
    expect(rename.getByRole<HTMLButtonElement>('button', { name: '正在刷新…' }).disabled).toBe(true)
    await act(async () => { latest.resolve(response('v2', node('r', '外部更新', leafA, leafB))) })
    expect(http).toHaveBeenCalledTimes(4)
    expect(rename.getByText('当前文字：「外部更新」')).toBeTruthy()
    expect(field.value).toBe('我的新名称')
    expect(save.disabled).toBe(false)
    expect(document.activeElement).toBe(save)
    await press(save)
    expect(sent(4)).toEqual({ path: PATH, revision: 'v2', edits: [{ op: 'rename', id: 'r', text: '我的新名称' }] })
    expect(topic('我的新名称')).toBeTruthy()
  })

  it('轮询更新画布但不覆盖输入；刷新后发现原节点消失则不允许提交', async () => {
    vi.useFakeTimers()
    const latest = node('r', '助手更新', leafB)
    http.mockResolvedValueOnce(response('v1', main)).mockResolvedValueOnce(response('v2', latest))
      .mockResolvedValueOnce(response('v2', latest))
    await mount()
    fireEvent.click(topic('甲'))
    fireEvent.click(action('编辑文字'))
    const rename = dialog('编辑文字')
    const field = rename.getByRole<HTMLInputElement>('textbox', { name: '节点文字' })
    fireEvent.change(field, { target: { value: '继续写' } })
    await tick()
    expect(topic('助手更新')).toBeTruthy()
    expect(field.value).toBe('继续写')
    expect(rename.getByRole('alert').textContent).toContain('已在别处更新')

    await press(rename.getByRole('button', { name: '刷新导图' }))
    expect(rename.getByRole('alert').textContent).toContain('重新选择')
    expect(field.value).toBe('继续写')
    expect(rename.getByRole<HTMLButtonElement>('button', { name: '保存' }).disabled).toBe(true)
    expect(http).toHaveBeenCalledTimes(3)
    fireEvent.click(rename.getByRole('button', { name: '取消' }))
    expect(document.activeElement).toBe(action('编辑文字'))
  })

  it('保存期间不再轮询，且忽略已取消读取的迟到结果', async () => {
    vi.useFakeTimers()
    const lateRead = Promise.withResolvers<Response>()
    const save = Promise.withResolvers<Response>()
    http.mockResolvedValueOnce(response('v1', main)).mockReturnValueOnce(lateRead.promise).mockReturnValueOnce(save.promise)
    await mount()
    await tick()
    fireEvent.click(action('编辑文字'))
    const rename = dialog('编辑文字')
    const field = rename.getByRole('textbox', { name: '节点文字' })
    fireEvent.change(field, { target: { value: '保存结果' } })
    fireEvent.click(rename.getByRole('button', { name: '保存' }))
    fireEvent.submit(field.closest('form')!)
    expect(http.mock.calls[1]?.[1]?.signal?.aborted).toBe(true)
    await tick()
    expect(http).toHaveBeenCalledTimes(3)
    expect(rename.getByRole<HTMLButtonElement>('button', { name: '正在保存…' }).disabled).toBe(true)
    await act(async () => { save.resolve(response('v2', node('r', '保存结果'))) })
    await act(async () => { lateRead.resolve(response('v1', main)) })
    expect(topic('保存结果')).toBeTruthy()
    expect(canvas().queryByRole('button', { name: '计划' })).toBeNull()
  })

  it('换路径再回到原路径时不接纳旧读取；隐藏后不继续轮询', async () => {
    vi.useFakeTimers()
    const first = Promise.withResolvers<Response>()
    http.mockReturnValueOnce(first.promise).mockResolvedValueOnce(response('v1', node('z', '另一张图'), OTHER))
      .mockResolvedValueOnce(response('v2', node('r', '重新打开')))
    const view = await mount()
    expect(screen.getByRole('status').textContent).toBe('正在打开思维导图…')
    await act(async () => { view.rerender(<MindmapEditor {...props} path={OTHER} />) })
    expect(topic('另一张图')).toBeTruthy()
    await act(async () => { view.rerender(<MindmapEditor {...props} />) })
    expect(http.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    await act(async () => { first.resolve(response('v1', main)) })
    expect(topic('重新打开')).toBeTruthy()
    view.rerender(<MindmapEditor {...props} shown={false} />)
    expect(screen.queryByRole('region')).toBeNull()
    await tick()
    expect(http).toHaveBeenCalledTimes(3)
  })

  it('隐藏再打开同一路径时不回显前一个实例的保存结果', async () => {
    const firstSave = Promise.withResolvers<Response>()
    http.mockResolvedValueOnce(response('v1', main)).mockReturnValueOnce(firstSave.promise)
      .mockResolvedValueOnce(response('v3', node('r', '最新的图')))
    const view = await mount()
    fireEvent.click(action('编辑文字'))
    const rename = dialog('编辑文字')
    fireEvent.change(rename.getByRole('textbox', { name: '节点文字' }), { target: { value: '旧实例保存' } })
    fireEvent.click(rename.getByRole('button', { name: '保存' }))
    view.rerender(<MindmapEditor {...props} shown={false} />)
    expect(http.mock.calls[1]?.[1]?.signal?.aborted).toBe(true)
    expect(screen.queryByRole('dialog')).toBeNull()
    await act(async () => { view.rerender(<MindmapEditor {...props} />) })
    await act(async () => { firstSave.resolve(response('v2', node('r', '旧实例保存'))) })
    expect(topic('最新的图')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('保存失败保留输入；已移走的文件不再显示旧画布', async () => {
    http.mockResolvedValueOnce(response('v1', main)).mockResolvedValueOnce(issue(503)).mockResolvedValueOnce(issue(404))
    await mount()
    fireEvent.click(action('编辑文字'))
    const rename = dialog('编辑文字')
    const field = rename.getByRole<HTMLInputElement>('textbox', { name: '节点文字' })
    fireEvent.change(field, { target: { value: '继续尝试' } })
    await press(rename.getByRole('button', { name: '保存' }))
    expect(rename.getByRole('alert').textContent).toBe('无法保存更改，请检查内容后重试。')
    expect(field.value).toBe('继续尝试')
    await press(rename.getByRole('button', { name: '保存' }))
    expect(rename.getByRole('alert').textContent).toBe('这张思维导图已被删除或移走。')
    expect(screen.queryByRole('region')).toBeNull()
    expect(screen.queryByText('/private/debug.json')).toBeNull()
    fireEvent.click(rename.getByRole('button', { name: '取消' }))
    expect(document.activeElement).toBe(action('刷新导图'))
  })

  it('英语文案处理打不开的文件，刷新后为未命名节点提供可访问名称', async () => {
    http.mockResolvedValueOnce(issue(500)).mockResolvedValueOnce(response('v1', node('r', '')))
    await mount({ ...props, t: translator(en) })
    expect(screen.getByRole('alert').textContent).toBe('Could not open the mind map. Refresh to try again.')
    await press(screen.getByRole('button', { name: 'Refresh mind map' }))
    expect(screen.getByRole('button', { name: 'Untitled node' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Edit text' }))
    expect(dialog('Edit text').getByText('Current text: “Untitled node”')).toBeTruthy()
  })

  it('画布自行滚动以显示选中节点，外部删除该节点后恢复键盘焦点', async () => {
    vi.useFakeTimers()
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.textContent === '甲' ? new DOMRect(130, 150, 28, 28) : new DOMRect(0, 0, 28, 28)
    })
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(100)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(100)
    http.mockResolvedValueOnce(response('v1', main)).mockResolvedValueOnce(response('v2', node('r', '计划', leafB)))
    await mount()
    const viewport = screen.getByRole('region', { name: '思维导图画布' })
    topic('计划').focus()
    topic('计划').blur()
    topic('计划').focus()
    fireEvent.keyDown(topic('计划'), { key: 'ArrowRight' })
    expect(viewport.scrollLeft).toBeGreaterThan(0)
    expect(viewport.scrollTop).toBeGreaterThan(0)
    await tick()
    expect(document.activeElement).toBe(topic('计划'))
    expect(topic('计划').getAttribute('aria-pressed')).toBe('true')
  })

  it('轮询失败保留上次的地图；同版本读成功后移除重试状态', async () => {
    vi.useFakeTimers()
    http.mockResolvedValueOnce(response('v1', main)).mockResolvedValueOnce(issue(503)).mockResolvedValueOnce(response('v1', main))
    await mount()
    await tick()
    expect(topic('计划')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('暂时无法取得最新内容，正在重试。')
    await tick()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('删除根下的整个分支后，结果仅提示一次并返回可用的工具按钮', async () => {
    vi.useFakeTimers()
    const rootOnly = node('r', '计划')
    http.mockResolvedValueOnce(response('v1', node('r', '计划', node('a', '甲', leafB))))
      .mockResolvedValueOnce(response('v2', rootOnly)).mockResolvedValueOnce(response('v2', rootOnly))
    await mount()
    fireEvent.click(topic('甲'))
    fireEvent.click(action('更多分支操作'))
    fireEvent.click(screen.getByRole('menuitem', { name: '删除分支' }))
    await press(dialog('删除分支').getByRole('button', { name: '删除分支' }))
    expect(canvas().queryByRole('button', { name: '乙' })).toBeNull()
    expect(document.activeElement).toBe(action('添加子节点'))
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    await tick()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('冲突刷新发现文件已删除时停止提交并聚焦取消，未确认的输入仍然可见', async () => {
    const missing = Promise.withResolvers<Response>()
    http.mockResolvedValueOnce(response('v1', main)).mockResolvedValueOnce(issue(409)).mockReturnValueOnce(missing.promise)
    await mount()
    fireEvent.click(action('编辑文字'))
    const rename = dialog('编辑文字')
    const field = rename.getByRole<HTMLInputElement>('textbox', { name: '节点文字' })
    fireEvent.change(field, { target: { value: '尚未保存' } })
    await press(rename.getByRole('button', { name: '保存' }))
    const reload = rename.getByRole('button', { name: '刷新导图' })
    reload.focus()
    fireEvent.click(reload)
    await act(async () => { missing.resolve(issue(404)) })
    expect(rename.getByRole('alert').textContent).toContain('已被删除或移走')
    expect(field.value).toBe('尚未保存')
    expect(document.activeElement).toBe(rename.getByRole('button', { name: '取消' }))
  })
})
