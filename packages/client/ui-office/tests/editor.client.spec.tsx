// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { OfficeEditor } from '../src/client/OfficeEditor.tsx'
import type { OfficeDraft } from '../src/client/document-controller.ts'
import type {} from '../src/client/index.ts'
import { zh } from '../src/client/locales.ts'
import type { OfficeDocument } from '../src/client/office-document.ts'
import { createOfficeEngine, type OfficeEngine } from '../src/client/univer-engine.ts'

vi.mock('../src/client/univer-engine.ts', () => ({ createOfficeEngine: vi.fn() }))

type Props = Parameters<typeof OfficeEditor>[0]
const WORD = '草稿.codingword'
const EXCEL = '工作簿.codingexcel'
const EMPTY_WORD = { kind: 'word', version: 2, snapshot: { body: { dataStream: '\r\n' } } } as const
const EMPTY_EXCEL = { kind: 'excel', version: 1, sheets: [{ id: 'first', name: '表一', cells: [] }] } as const
const EDITED = { kind: 'word', version: 2, snapshot: { body: { dataStream: '保留此修改\r\n' } } } as const
const request = vi.fn<typeof fetch>()
const open = vi.mocked(createOfficeEngine)
const snapshot = (path: string, document: OfficeDocument, revision = 'v1') => Response.json({ path, revision, document })

function makeProps(): Props {
  const drafts: Record<string, OfficeDraft | undefined> = {}
  return {
    path: WORD, kind: 'word', shown: true, sessionId: 'session' as Props['sessionId'],
    useSession: vi.fn(), useSessions: vi.fn(), useWorkspaces: vi.fn(), useProjection: vi.fn(), useInput: vi.fn(),
    inputActions: { setDraft: vi.fn(), addImages: vi.fn(() => false), removeImage: vi.fn(), pruneImages: vi.fn(), submit: vi.fn() },
    useStore: selector => selector({ drafts }),
    actions: { retain: (key, draft) => { drafts[key] = draft } },
    t: (key: string) => (zh as Partial<Record<string, string>>)[key] ?? key,
  }
}

function engine(document: OfficeDocument) {
  return {
    read: vi.fn(() => document), dispose: vi.fn(), isEditing: vi.fn(() => false),
    finishEditing: vi.fn(() => Promise.resolve(true)), format: vi.fn(() => Promise.resolve(true)),
    insertImage: vi.fn(() => Promise.resolve(true)),
  } satisfies OfficeEngine
}

const action = (name: string) => within(screen.getByRole('group', { name: '文档操作' })).getByRole('button', { name })

beforeEach(() => {
  request.mockReset()
  open.mockReset()
  vi.stubGlobal('fetch', request)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('隐藏或换类型中止旧初始化，释放迟到画布，不向旧文件发起写入', async () => {
  const late = Promise.withResolvers<OfficeEngine>()
  const word = engine(EMPTY_WORD)
  const excel = engine(EMPTY_EXCEL)
  open.mockReturnValueOnce(late.promise).mockResolvedValueOnce(excel)
  request.mockResolvedValueOnce(snapshot(WORD, EMPTY_WORD)).mockResolvedValueOnce(snapshot(EXCEL, EMPTY_EXCEL))
  const props = makeProps()
  const view = render(<OfficeEditor {...props} />)
  await act(async () => {})
  const wordMount = open.mock.calls[0]?.[0]
  expect(wordMount?.document).toEqual(EMPTY_WORD)
  await act(async () => { view.rerender(<OfficeEditor {...props} path={EXCEL} kind="excel" />) })
  expect(wordMount?.signal.aborted).toBe(true)
  expect(screen.queryByRole('region', { name: 'Word 正文' })).toBeNull()
  expect(screen.getByRole('region', { name: 'Excel 工作簿' })).toBeTruthy()
  await act(async () => { late.resolve(word) })
  expect(word.dispose).toHaveBeenCalledOnce()
  await act(async () => { view.rerender(<OfficeEditor {...props} path={EXCEL} kind="excel" shown={false} />) })
  expect(excel.dispose).toHaveBeenCalledOnce()
  expect(screen.queryByRole('region', { name: 'Excel 工作簿' })).toBeNull()
  expect(request).toHaveBeenCalledTimes(2)
})

it('关闭前保留已输入的快照；改名路径不承接该草稿', async () => {
  const renamed = '已改名.codingword'
  const word = engine(EMPTY_WORD)
  open.mockResolvedValueOnce(word).mockResolvedValueOnce(engine(EMPTY_WORD)).mockResolvedValueOnce(engine(EDITED))
  request.mockResolvedValueOnce(snapshot(WORD, EMPTY_WORD))
    .mockResolvedValueOnce(snapshot(renamed, EMPTY_WORD)).mockResolvedValueOnce(snapshot(WORD, EMPTY_WORD))
  const props = makeProps()
  const view = render(<OfficeEditor {...props} />)
  await act(async () => {})
  vi.mocked(word.read).mockReturnValue(EDITED)
  await act(async () => { view.rerender(<OfficeEditor {...props} path={renamed} />) })
  expect(open.mock.calls[1]?.[0].document).toEqual(EMPTY_WORD)
  await act(async () => { view.rerender(<OfficeEditor {...props} path={WORD} />) })
  expect(open.mock.calls[2]?.[0].document).toEqual(EDITED)
  expect(screen.getByText('未保存')).toBeTruthy()
  expect(request).toHaveBeenCalledTimes(3)
})

it('只在明确确认导出后保存并下载已获回执的版本', async () => {
  const word = engine(EMPTY_WORD)
  open.mockResolvedValueOnce(word)
  const mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  request.mockResolvedValueOnce(snapshot(WORD, EMPTY_WORD))
    .mockResolvedValueOnce(snapshot(WORD, EDITED, 'v2'))
    .mockResolvedValueOnce(new Response('文件', { headers: { 'Content-Type': mime, 'Content-Disposition': 'attachment' } }))
  const objectUrl = vi.fn(() => 'blob:office-file')
  const downloaded: string[] = []
  vi.stubGlobal('URL', class extends URL {
    static override createObjectURL = objectUrl
    static override revokeObjectURL = vi.fn()
  })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloaded.push(this.download) })
  render(<OfficeEditor {...makeProps()} />)
  await act(async () => {})
  vi.mocked(word.read).mockReturnValue(EDITED)
  fireEvent.click(action('导出'))
  expect(request).toHaveBeenCalledTimes(1)
  const dialog = screen.getByRole('dialog', { name: '导出 Word 文档' })
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '下载 Word 文档' })) })
  expect(word.finishEditing).toHaveBeenCalled()
  expect(request.mock.calls[1]?.[1]?.body).toEqual(JSON.stringify({ path: WORD, revision: 'v1', document: EDITED }))
  expect(request.mock.calls[2]?.[0]).toBe(`/api/notes/office/export?${new URLSearchParams({ path: WORD, revision: 'v2' })}`)
  expect(downloaded).toEqual(['草稿.docx'])
  expect(screen.getByText('已开始下载')).toBeTruthy()
})

it('格式工具栏按分区排列，图标按钮直接执行对应动作', async () => {
  const word = engine(EMPTY_WORD)
  open.mockResolvedValueOnce(word)
  request.mockResolvedValueOnce(snapshot(WORD, EMPTY_WORD))
  const props = makeProps()
  render(<OfficeEditor {...props} />)
  await act(async () => {})
  const bar = screen.getByRole('group', { name: '格式工具' })
  const inline = within(bar).getByRole('group', { name: '文字样式' })
  fireEvent.click(within(inline).getByRole('button', { name: '下划线' }))
  expect(word.format).toHaveBeenCalledWith({ key: 'underline' })
  const align = within(bar).getByRole('group', { name: '对齐' })
  expect(within(align).getAllByRole('button')).toHaveLength(4)
  fireEvent.click(within(align).getByRole('button', { name: '居中' }))
  expect(word.format).toHaveBeenCalledWith({ key: 'align', value: 'center' })
  expect(within(bar).getAllByRole('separator')).toHaveLength(5)
  const size = within(bar).getByRole('button', { name: '字号' })
  expect(size.getAttribute('aria-haspopup')).toBe('menu')
})

it('颜色按钮展开色板，点选预设色即应用，更多颜色进入自定义输入', async () => {
  const word = engine(EMPTY_WORD)
  open.mockResolvedValueOnce(word)
  request.mockResolvedValueOnce(snapshot(WORD, EMPTY_WORD))
  render(<OfficeEditor {...makeProps()} />)
  await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: '文字颜色' }))
  const palette = await screen.findByRole('group', { name: '文字颜色' })
  fireEvent.click(within(palette).getByRole('button', { name: '#c00000' }))
  expect(word.format).toHaveBeenCalledWith({ key: 'textColor', value: '#c00000' })
  fireEvent.click(screen.getByRole('button', { name: '文字颜色' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: '更多颜色…' }))
  const dialog = await screen.findByRole('dialog', { name: '文字颜色' })
  expect(within(dialog).getByRole('textbox')).toBeTruthy()
})
