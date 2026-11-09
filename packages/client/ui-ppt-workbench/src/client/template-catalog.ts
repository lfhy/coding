/** 模板目录的只读 HTTP 边界；设置与工作台共用同一份浏览快照。 */
import { createSnapshotStore } from 'coding-client-runtime/client'
import { isRecord, parseDeck, type PptDeck } from 'coding-ppt-model'
import type { Branded } from 'coding-brand'
import { errorOf } from './wire.ts'

/** Host 模板仓库的 UUID 身份，不能与页面、工程或会话 id 混用。 */
export type PptTemplateId = Branded<'PptTemplateId'>

const TEMPLATE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

/** 宿主提供的整稿模板摘要。 */
export interface TemplateSummary {
  readonly id: PptTemplateId
  readonly name: string
  readonly pages: number
  readonly createdAt: number
  readonly sourceName: string | null
  readonly dropped: readonly string[]
}

/** 详情多携带可绘制的幻灯片内容。 */
export interface TemplateDetail extends TemplateSummary {
  readonly deck: PptDeck
}

/** 远端目录和按需读取的详情；操作只读，不包含编辑草稿。 */
export interface TemplateCatalogState {
  readonly phase: 'idle' | 'loading' | 'ready' | 'error'
  readonly templates: readonly TemplateSummary[]
  readonly details: Readonly<Record<string, TemplateDetail>>
  readonly error: string | null
  readonly builtins: {
    readonly phase: 'idle' | 'loading' | 'ready' | 'error'
    readonly deck: PptDeck | null
    readonly error: string | null
  }
  readonly defaultTemplate: {
    readonly phase: 'idle' | 'loading' | 'ready' | 'error'
    readonly deck: PptDeck | null
    readonly error: string | null
  }
}

/** 页面 id 由 Host 版式生成器决定，客户端只校验并绑定现有文案。 */
export const BUILTIN_LAYOUTS = [
  { id: 'title', key: 'templateTitle' },
  { id: 'section', key: 'templateSection' },
  { id: 'bullets', key: 'templateBullets' },
  { id: 'two-column', key: 'templateTwoColumn' },
  { id: 'data', key: 'templateData' },
  { id: 'chart', key: 'templateChart' },
  { id: 'quote', key: 'templateQuote' },
] as const

/** 保证预览严格对应七种已内置版式，不把坏响应当成空目录。 */
export function parseBuiltinLayouts(value: unknown): PptDeck | null {
  try {
    const deck = parseDeck(value)
    if (deck.size !== '16:9' || deck.theme !== 'paper' || deck.pages.length !== BUILTIN_LAYOUTS.length
      || deck.pages.some((page, index) => page.id !== BUILTIN_LAYOUTS[index]?.id || page.elements.length === 0)) return null
    return deck
  } catch { return null }
}

/** 默认整稿必须是可编辑的六页宽屏设计，不与个人模板仓库共用身份。 */
export function parseDefaultTemplate(value: unknown): PptDeck | null {
  try {
    const deck = parseDeck(value)
    if (deck.size !== '16:9' || deck.theme !== 'inference' || deck.pages.length !== 6
      || deck.pages.some(page => page.elements.length === 0)) return null
    return deck
  } catch { return null }
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

/** 不接纳部分坏行，以免错误目录被误展示成空库。 */
export function parseTemplateSummary(value: unknown): TemplateSummary | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !TEMPLATE_ID.test(value.id)
    || typeof value.name !== 'string' || value.name.trim() === '' || value.name.length > 200
    || !Number.isSafeInteger(value.pages) || (value.pages as number) < 1
    || !Number.isSafeInteger(value.createdAt) || (value.createdAt as number) < 0
    || !(value.sourceName === null || typeof value.sourceName === 'string'
      && value.sourceName.trim() !== '' && value.sourceName.length <= 200)
    || !Array.isArray(value.dropped) || value.dropped.length > 100
    || !value.dropped.every(item => typeof item === 'string' && item.trim() !== '' && item.length <= 200)) return null
  return {
    id: value.id as PptTemplateId, name: value.name, pages: value.pages as number,
    createdAt: value.createdAt as number, sourceName: value.sourceName, dropped: value.dropped,
  }
}

/** 详情的 deck 必须能被工作台现有的绘制模型解析。 */
export function parseTemplateDetail(value: unknown): TemplateDetail | null {
  const summary = parseTemplateSummary(value)
  if (summary === null || !isRecord(value)) return null
  try { return { ...summary, deck: parseDeck(value.deck) } } catch { return null }
}

const INITIAL: TemplateCatalogState = {
  phase: 'idle', templates: [], details: {}, error: null,
  builtins: { phase: 'idle', deck: null, error: null },
  defaultTemplate: { phase: 'idle', deck: null, error: null },
}

/** 在一次插件生命周期内共享目录，并合并同一详情的并发读取。 */
export class TemplateCatalogController {
  readonly view = createSnapshotStore<TemplateCatalogState>(INITIAL)
  private disposed = false
  private readonly aborters = new Set<AbortController>()
  private listRequest: Promise<void> | null = null
  private builtinsRequest: Promise<void> | null = null
  private defaultRequest: Promise<void> | null = null
  private readonly detailRequests = new Map<PptTemplateId, Promise<void>>()

  constructor(private readonly fetcher: Fetcher = (input, init) => fetch(input, init)) {}

  dispose(): void {
    this.disposed = true
    for (const aborter of this.aborters) aborter.abort()
    this.aborters.clear()
  }

  private patch(mutator: (draft: { -readonly [K in keyof TemplateCatalogState]: TemplateCatalogState[K] }) => void): void {
    if (!this.disposed) this.view.update(mutator)
  }

  private async request(path: string): Promise<Record<string, unknown>> {
    if (this.disposed) throw new Error('Template catalog closed')
    const aborter = new AbortController()
    this.aborters.add(aborter)
    try {
      const response = await this.fetcher(`/api/ppt/templates${path}`, { signal: aborter.signal })
      const payload: unknown = await response.json().catch(() => null)
      if (!response.ok) throw new Error(errorOf(payload, response.statusText))
      if (!isRecord(payload) || payload.ok !== true) throw new Error('Invalid template response')
      return payload
    } finally { this.aborters.delete(aborter) }
  }

  /** 重新读取目录；同一时刻只发一个 GET。 */
  load(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.listRequest !== null) return this.listRequest
    this.patch((draft) => { draft.phase = 'loading'; draft.error = null })
    const task = (async () => {
      try {
        const payload = await this.request('')
        if (!Array.isArray(payload.templates)) throw new Error('Invalid template list')
        const templates = payload.templates.map(parseTemplateSummary)
        if (templates.some(item => item === null)) throw new Error('Invalid template list')
        this.patch((draft) => { draft.phase = 'ready'; draft.templates = templates as TemplateSummary[]; draft.error = null })
      } catch (error) {
        this.patch((draft) => {
          draft.phase = 'error'
          draft.error = error instanceof Error ? error.message : String(error)
        })
      }
    })().finally(() => { this.listRequest = null })
    this.listRequest = task
    return task
  }

  /** 单独读取内置单页版式；个人模板目录失败不影响这七页。 */
  loadBuiltins(): Promise<void> {
    if (this.disposed || this.view.getSnapshot().builtins.phase === 'ready') return Promise.resolve()
    if (this.builtinsRequest !== null) return this.builtinsRequest
    this.patch((draft) => { draft.builtins = { ...draft.builtins, phase: 'loading', error: null } })
    const task = (async () => {
      try {
        const payload = await this.request('/builtins')
        const deck = parseBuiltinLayouts(payload.deck)
        if (deck === null) throw new Error('Invalid built-in layouts')
        this.patch((draft) => { draft.builtins = { phase: 'ready', deck, error: null } })
      } catch (error) {
        this.patch((draft) => {
          draft.builtins = {
            ...draft.builtins, phase: 'error',
            error: error instanceof Error ? error.message : String(error),
          }
        })
      }
    })().finally(() => { this.builtinsRequest = null })
    this.builtinsRequest = task
    return task
  }

  /** 默认整稿独立读取；并发调用合并，失败后可重试，成功后复用当前预览。 */
  loadDefault(): Promise<void> {
    if (this.disposed || this.view.getSnapshot().defaultTemplate.phase === 'ready') return Promise.resolve()
    if (this.defaultRequest !== null) return this.defaultRequest
    this.patch((draft) => { draft.defaultTemplate = { phase: 'loading', deck: null, error: null } })
    const task = (async () => {
      try {
        const payload = await this.request('/default')
        const deck = parseDefaultTemplate(payload.deck)
        if (deck === null) throw new Error('Invalid default template')
        this.patch((draft) => { draft.defaultTemplate = { phase: 'ready', deck, error: null } })
      } catch {
        this.patch((draft) => { draft.defaultTemplate = { phase: 'error', deck: null, error: 'unavailable' } })
      }
    })().finally(() => { this.defaultRequest = null })
    this.defaultRequest = task
    return task
  }

  /** 只在选中模板时取第一页预览所需的详情。 */
  detail(id: PptTemplateId): Promise<void> {
    if (this.disposed || this.view.getSnapshot().details[id] !== undefined) return Promise.resolve()
    const pending = this.detailRequests.get(id)
    if (pending !== undefined) return pending
    const task = (async () => {
      try {
        const payload = await this.request(`/detail?${new URLSearchParams({ id })}`)
        const detail = parseTemplateDetail(payload.template)
        if (detail === null || detail.id !== id) throw new Error('Invalid template detail')
        this.patch((draft) => { draft.details = { ...draft.details, [id]: detail }; draft.error = null })
      } catch (error) {
        this.patch((draft) => { draft.error = error instanceof Error ? error.message : String(error) })
      }
    })().finally(() => { this.detailRequests.delete(id) })
    this.detailRequests.set(id, task)
    return task
  }

  /** URL 仅指向当前 Host，路径交由 Host 的模板媒体准入再次校验。 */
  mediaUrl(id: PptTemplateId, path: string): string {
    return `/api/ppt/templates/media?${new URLSearchParams({ id, path })}`
  }
}
