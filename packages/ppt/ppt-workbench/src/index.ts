/**
 * PPT 创作模式的宿主能力：演示文稿工程服务（`pptProjects`）与右侧工作台的数据通道。
 *
 * 职责边界：本包拥有工程目录布局、版本与撤销历史、.pptx 导出，以及「模型打开的工程」
 * 与「右侧工作台当前工程」之间的会话级交接。模型可见的工具在 `coding-tool-ppt`，面板在
 * `./client`，两者都只经这里的方法读写，不复制存储逻辑。
 * @module coding-ppt-workbench
 */

import { readFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from 'coding-home-paths'
import { remoteWorkspacePath } from 'coding-subprocess'
import type {} from 'coding-host-webserver'
import type {} from 'coding-session'
import type { SessionId } from 'coding-session/types'
import { checkDeck, type PptCheckResult } from './check.ts'
import { buildPdf } from './export/pdf.ts'
import { buildPptx } from './export/pptx.ts'
import { collectFonts, systemFontDirs, type SkippedFont } from './fonts.ts'
import { importPptx, PPT_IMPORT_MAX_BYTES } from './import.ts'
import { renderPages, type PageCapture, type RenderedPage } from './render.ts'
import { parseDeck, PptModelError, type SlideSizeId, type ThemeId } from 'coding-ppt-model'
import { installRoutes } from './routes.ts'
import { publishProject, readWorkspaceFile, readWorkspaceMedia } from './template-project.ts'
import { PptTemplateStore, type PptTemplateDetail, type PptTemplateSummary } from './template-store.ts'
import {
  createProject, editProject, listProjects, loadProject, readProjectMedia, redoProject,
  resolveProjectDir, suggestProjectDir, undoProject, writeExport, writeProjectMedia,
  PptStoreError, type PptProjectSummary, type PptSnapshot,
} from './store.ts'

export type * from './store.ts'
export type * from 'coding-ppt-model'
export type * from './ops.ts'
export { PptModelError } from 'coding-ppt-model'
export { PptStoreError } from './store.ts'
export type { PptTemplateDetail, PptTemplateId, PptTemplateSummary } from './template-store.ts'

/** 本机模板仓库路径；远程 marker 工作区不通过此设置转为本机工程。 */
export interface Config {
  /** 模板仓库的绝对路径；默认使用 Harness home 下的 `ppt-templates`。 */
  templatesDir?: string
}

/** 模型要求面板打开某个工程的那一次请求；`at` 让面板只处理一次。 */
export interface PptOpenRequest {
  /** 相对工作区的工程目录。 */
  readonly dir: string
  readonly at: number
}

/** 面板一次轮询拿到的完整视图。 */
export interface PptWorkbenchState {
  readonly projects: readonly PptProjectSummary[]
  readonly active: PptSnapshot | null
  readonly openRequest: PptOpenRequest | null
  /** 当前会话的工作区目录；面板据此提示「先选择工作区」。 */
  readonly root: string
}

/** 导出结果。 */
export interface PptExportResult {
  /** 绝对路径，供面板展示与系统打开器使用。 */
  readonly path: string
  readonly bytes: number
  readonly revision: number
  /** 实际嵌入的字体族；`subset` 表示写的是子集而不是整字体。 */
  readonly fonts: readonly { readonly family: string; readonly readonly: boolean; readonly subset: boolean }[]
  /** 因许可或找不到文件而跳过的字体。 */
  readonly skippedFonts: readonly SkippedFont[]
}

declare module '@deepseek-ai/cordis' {
  interface Context { pptProjects: PptProjects }
}

/** 会话级工程服务；写入由存储层按工程串行化，路由层负责转换错误码。 */
export default class PptProjects extends Service {
  static inject = ['sessions', 'webServer', 'connection']
  static Config: z<Config> = z.object({
    templatesDir: z.string(),
  })

  /** 每个会话当前打开的工程目录（绝对路径）。 */
  private readonly active = new Map<string, string>()
  /** 模型最近一次要求面板打开工程的时间戳。 */
  private readonly openRequests = new Map<string, PptOpenRequest>()

  /** 导出时要扫描的字体目录；默认取平台字体目录。 */
  private fontDirs: readonly string[] = systemFontDirs()
  private readonly templates: PptTemplateStore

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'pptProjects')
    if (config.templatesDir !== undefined && !isAbsolute(config.templatesDir)) {
      throw new PptStoreError('bad-request', 'templatesDir 必须是绝对路径')
    }
    this.templates = new PptTemplateStore(config.templatesDir ?? join(resolveDshHome(), 'ppt-templates'))
    installRoutes(ctx, this)
    ctx.effect(() => () => {
      this.active.clear()
      this.openRequests.clear()
    }, 'pptWorkbench: session pointers')
  }

  /**
   * 会话的工作区目录。
   * @param sessionId - 会话身份。
   * @returns 绝对工作目录。
   * @throws PptModelError - 会话不存在或没有工作目录时。
   */
  rootOf(sessionId: string): string {
    const session = this.ctx.sessions.get(sessionId as SessionId)
    if (session === undefined) throw new PptModelError('会话不存在或已关闭')
    const cwd = session.header.cwd
    if (cwd === undefined || cwd === '') throw new PptModelError('当前会话没有工作区目录')
    return cwd
  }

  /**
   * 把工程目录解析到工作区内。
   * @param sessionId - 会话身份。
   * @param dir - 相对工作区的目录；缺省用会话当前打开的工程。
   * @returns 绝对目录。
   * @throws PptModelError - 目录越界或没有可用的当前工程时。
   */
  resolveDir(sessionId: string, dir?: string): string {
    const root = this.rootOf(sessionId)
    const target = dir ?? this.activeDir(sessionId)
    if (target === undefined) throw new PptModelError('还没有打开任何演示文稿，请先创建或打开一个工程')
    return resolveProjectDir(root, target)
  }

  /**
   * 会话当前打开的工程目录（相对工作区）。
   * @param sessionId - 会话身份。
   * @returns 相对目录；没有打开时为 undefined。
   */
  activeDir(sessionId: string): string | undefined {
    const dir = this.active.get(sessionId)
    if (dir === undefined) return undefined
    try {
      return this.relativeDir(sessionId, dir)
    } catch {
      this.active.delete(sessionId)
      return undefined
    }
  }

  private relativeDir(sessionId: string, dir: string): string {
    const root = this.rootOf(sessionId)
    const absolute = resolveProjectDir(root, dir)
    return absolute === root ? '.' : absolute.slice(root.length + 1)
  }

  /**
   * 记住会话要显示的工程，并让面板下一次轮询时切换过去。
   * @param sessionId - 会话身份。
   * @param dir - 绝对工程目录。
   * @returns 相对工作区的目录。
   */
  focus(sessionId: string, dir: string): string {
    const relative = this.relativeDir(sessionId, dir)
    this.active.set(sessionId, dir)
    this.openRequests.set(sessionId, { dir: relative, at: Date.now() })
    return relative
  }

  /**
   * 面板视角的整体状态。
   * @param sessionId - 会话身份。
   * @returns 工程列表、当前工程与待处理的打开请求。
   */
  async state(sessionId: string): Promise<PptWorkbenchState> {
    const root = this.rootOf(sessionId)
    const activeDir = this.active.get(sessionId)
    const active = activeDir === undefined ? null : await loadProject(activeDir).catch(() => null)
    if (active === null) this.active.delete(sessionId)
    return {
      projects: await listProjects(root),
      active,
      openRequest: this.openRequests.get(sessionId) ?? null,
      root,
    }
  }

  /**
   * 面板确认已处理某次打开请求。
   * @param sessionId - 会话身份。
   * @param at - 请求时间戳；与当前请求不一致时忽略，避免重复消费新请求。
   */
  ackOpenRequest(sessionId: string, at: number): void {
    if (this.openRequests.get(sessionId)?.at === at) this.openRequests.delete(sessionId)
  }

  /**
   * 新建工程并设为当前工程。
   * @param sessionId - 会话身份。
   * @param options - 标题、目录、尺寸与主题。
   * @returns 新工程快照。
   */
  create(sessionId: string, options: {
    title: string
    dir?: string
    size?: SlideSizeId
    theme?: ThemeId
  }): Promise<PptSnapshot> {
    const root = this.rootOf(sessionId)
    return (async () => {
      const dir = options.dir === undefined
        ? await suggestProjectDir(root, options.title)
        : resolveProjectDir(root, options.dir)
      const snapshot = await createProject(dir, options)
      this.focus(sessionId, dir)
      return snapshot
    })()
  }

  /**
   * 打开既有工程（模型 `ppt_open` 与面板点击共用）。
   * @param sessionId - 会话身份。
   * @param dir - 相对或绝对目录。
   * @returns 工程快照。
   */
  async open(sessionId: string, dir: string): Promise<PptSnapshot> {
    const absolute = this.resolveDir(sessionId, dir)
    const snapshot = await loadProject(absolute)
    this.focus(sessionId, absolute)
    return snapshot
  }

  /**
   * 读取工程。
   * @param sessionId - 会话身份。
   * @param dir - 相对或绝对目录；缺省为当前工程。
   * @returns 工程快照。
   */
  read(sessionId: string, dir?: string): Promise<PptSnapshot> {
    return loadProject(this.resolveDir(sessionId, dir))
  }

  /**
   * 应用一次编辑。
   * @param sessionId - 会话身份。
   * @param dir - 工程目录；缺省为当前工程。
   * @param ops - 未校验的编辑步骤。
   * @param baseRevision - 乐观锁基准版本。
   * @returns 写入后的快照。
   */
  edit(sessionId: string, dir: string | undefined, ops: unknown, baseRevision?: number): Promise<PptSnapshot> {
    return editProject(this.resolveDir(sessionId, dir), ops, baseRevision)
  }

  /**
   * 撤销。
   * @param sessionId - 会话身份。
   * @param dir - 工程目录；缺省为当前工程。
   * @param steps - 步数。
   * @returns 撤销后的快照。
   */
  undo(sessionId: string, dir: string | undefined, steps: number): Promise<PptSnapshot> {
    return undoProject(this.resolveDir(sessionId, dir), steps)
  }

  /**
   * 重做。
   * @param sessionId - 会话身份。
   * @param dir - 工程目录；缺省为当前工程。
   * @param steps - 步数。
   * @returns 重做后的快照。
   */
  redo(sessionId: string, dir: string | undefined, steps: number): Promise<PptSnapshot> {
    return redoProject(this.resolveDir(sessionId, dir), steps)
  }

  /**
   * 把工程导出成 PDF：先渲染每页 PNG（会同时在 Agent 浏览器里打开），再拼成 PDF。
   * @param sessionId - 会话身份。
   * @param dir - 工程目录；缺省为当前工程。
   * @returns 导出文件路径与大小。
   */
  async exportPdf(sessionId: string, dir?: string): Promise<{ path: string; bytes: number; revision: number }> {
    const absolute = this.resolveDir(sessionId, dir)
    const snapshot = await loadProject(absolute)
    const rendered = await this.render(sessionId, dir)
    const pages: { bytes: Uint8Array }[] = []
    for (const page of rendered) {
      const bytes = await readFile(page.path).catch(() => undefined)
      if (bytes !== undefined) pages.push({ bytes: new Uint8Array(bytes) })
    }
    if (pages.length === 0) throw new PptModelError('没有可写入 PDF 的页面图')
    const pdf = buildPdf(pages)
    const path = await writeExport(absolute, snapshot.revision, snapshot.title, pdf, 'pdf')
    return { path, bytes: pdf.length, revision: snapshot.revision }
  }

  /**
   * 把页面渲染成 PNG（工作台与导出一致的那一版）。
   * @param sessionId - 会话身份。
   * @param dir - 工程目录；缺省为当前工程。
   * @param pages - 要渲染的页下标（0 起）；缺省全部。
   * @returns 每页的 PNG 路径。
   */
  async render(sessionId: string, dir?: string, pages?: readonly number[]): Promise<RenderedPage[]> {
    const absolute = this.resolveDir(sessionId, dir)
    const snapshot = await loadProject(absolute)
    const media: Record<string, Uint8Array | undefined> = {}
    for (const page of snapshot.deck.pages) {
      for (const element of page.elements) {
        if (element.kind !== 'image' || media[element.source] !== undefined) continue
        media[element.source] = await readProjectMedia(absolute, element.source)
      }
    }
    const capture = this.ctx.get('egoBrowser') as unknown as PageCapture | undefined
    return renderPages({
      sessionId,
      projectDir: absolute,
      deck: snapshot.deck,
      ...pages === undefined ? {} : { pages },
      media,
      capture,
      revision: snapshot.revision,
    })
  }

  /**
   * 读取工程内的一张图片，供面板显示。
   * @param sessionId - 会话身份。
   * @param dir - 工程目录；缺省为当前工程。
   * @param source - 工程的 `media/<file>` 相对路径。
   * @returns 图片字节；越界或不存在时为 undefined。
   */
  media(sessionId: string, dir: string | undefined, source: string): Promise<Uint8Array | undefined> {
    return readProjectMedia(this.resolveDir(sessionId, dir), source)
  }

  /**
   * 把上传的图片写进工程并返回可写进元素的相对路径。
   * @param sessionId - 会话身份。
   * @param dir - 工程目录；缺省为当前工程。
   * @param name - 上传时的文件名（取扩展名）。
   * @param bytes - 图片字节。
   * @returns `media/<file>` 相对路径。
   */
  upload(sessionId: string, dir: string | undefined, name: string, bytes: Uint8Array): Promise<string> {
    return writeProjectMedia(this.resolveDir(sessionId, dir), name, bytes)
  }

  /**
   * 规则质检。
   * @param sessionId - 会话身份。
   * @param dir - 工程目录；缺省为当前工程。
   * @returns 质检结果。
   */
  async check(sessionId: string, dir?: string): Promise<PptCheckResult> {
    const snapshot = await loadProject(this.resolveDir(sessionId, dir))
    return checkDeck(snapshot.deck)
  }

  /**
   * 把工作区里的 .pptx 导入成工程。
   * @param sessionId - 会话身份。
   * @param source - 工作区相对的 .pptx 路径。
   * @param options - 目标目录与标题（都缺省时按源文件名生成）。
   * @returns 新工程快照与未能表达的类别。
   * @throws PptStoreError 远程工作区、越界、文件超限或目标已有内容时；失败不切换当前工程。
   */
  async import(sessionId: string, source: string, options: { dir?: string; title?: string }): Promise<{
    snapshot: PptSnapshot
    dropped: readonly string[]
  }> {
    const root = await this.localRoot(sessionId)
    if (typeof source !== 'string' || !/\.pptx$/iu.test(source)) {
      throw new PptStoreError('bad-request', '只支持导入 .pptx 文件')
    }
    const sourcePath = resolveProjectDir(root, source)
    const bytes = await readWorkspaceFile(root, sourcePath, PPT_IMPORT_MAX_BYTES)
    const title = options.title ?? basename(source).replace(/\.pptx$/iu, '')
    const imported = importPptx(bytes, { title })
    const dir = options.dir === undefined
      ? await suggestProjectDir(root, title)
      : resolveProjectDir(root, options.dir)
    const snapshot = await publishProject(root, dir, imported.deck, imported.media)
    this.focus(sessionId, dir)
    return { snapshot, dropped: imported.dropped }
  }

  private async localRoot(sessionId: string): Promise<string> {
    const root = this.rootOf(sessionId)
    try {
      if (await remoteWorkspacePath('.', root) !== undefined) {
        throw new PptStoreError('forbidden', 'PPT 工程导入、保存和套用暂不支持远程工作区')
      }
    } catch (error) {
      if (error instanceof PptStoreError) throw error
      throw new PptStoreError('forbidden', `无法核实本机工作区：${error instanceof Error ? error.message : String(error)}`)
    }
    return root
  }

  /** 列出本机用户模板；不切换任何会话的当前工程。
   * @returns 按创建时间排列的模板摘要。
   * @throws PptStoreError 模板仓库损坏或无法访问时。
   */
  listTemplates(): Promise<readonly PptTemplateSummary[]> {
    return this.templates.list()
  }

  /** 读取模板的完整 deck；不切换当前工程。
   * @param id - 模板 UUID。
   * @returns 模板详情。
   * @throws PptStoreError 模板不存在或仓库内容不合法时。
   */
  readTemplate(id: string): Promise<PptTemplateDetail> {
    return this.templates.read(id)
  }

  /** 将无宏 PPTX 转成可编辑模板；丢失的复杂结构在返回值中列出。
   * @param fileName - 安全的单层 .pptx 文件名。
   * @param bytes - 压缩源文件字节，上限 8 MiB；不会保存源文件本身。
   * @param options - 模板名称；缺省取去掉扩展名的文件名。
   * @returns 持久化的模板详情。
   * @throws PptStoreError 文件名、大小、内容或仓库不合法时。
   */
  async importTemplate(fileName: string, bytes: Uint8Array, options: { name?: string } = {}): Promise<PptTemplateDetail> {
    if (typeof fileName !== 'string' || fileName.length > 200 || fileName === '.' || fileName === '..'
      || fileName.includes('/') || fileName.includes('\\') || /[\u0000-\u001f\u007f:*?"<>|]/u.test(fileName)
      || !/\.pptx$/iu.test(fileName)) {
      throw new PptStoreError('bad-request', '模板来源必须是安全的 .pptx 文件名')
    }
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > PPT_IMPORT_MAX_BYTES) {
      throw new PptStoreError('bad-request', 'PPTX 文件大小必须在 1 字节到 8 MiB 之间')
    }
    const title = basename(fileName).replace(/\.pptx$/iu, '').slice(0, 160)
    if (title.trim() === '') throw new PptStoreError('bad-request', '模板来源文件名不能只包含扩展名')
    const imported = importPptx(bytes, { title })
    return this.templates.create({
      name: options.name ?? title, deck: parseDeck(imported.deck), media: imported.media,
      sourceName: fileName, dropped: imported.dropped,
    })
  }

  /** 将会话工作区里的 PPTX 文件保存为用户模板，不创建工程或切换当前工程。
   * @param sessionId - 本机会话身份。
   * @param source - 工作区内的 .pptx 文件路径。
   * @param options - 可选模板名称；缺省取源文件名去掉扩展名。
   * @returns 包含来源文件名与导入限制的持久模板详情。
   * @throws PptStoreError 远程工作区、路径越界、符号链接、文件超限或文件名不安全时。
   */
  async importTemplateFromFile(sessionId: string, source: string, options: { name?: string } = {}): Promise<PptTemplateDetail> {
    const root = await this.localRoot(sessionId)
    if (typeof source !== 'string' || !/\.pptx$/iu.test(source)) {
      throw new PptStoreError('bad-request', '模板来源只支持 .pptx 文件')
    }
    const fileName = basename(source)
    const sourcePath = resolveProjectDir(root, source)
    const bytes = await readWorkspaceFile(root, sourcePath, PPT_IMPORT_MAX_BYTES)
    return this.importTemplate(fileName, bytes, options)
  }

  /** 保存工程整稿和全部引用媒体的原字节；不改变当前工程。
   * @param sessionId - 本机会话身份。
   * @param options - 名称和可选工程目录；缺省取会话当前工程。
   * @returns 持久化的模板详情。
   * @throws PptStoreError 远程工作区、缺图、符号链接、越界或仓库错误时。
   */
  async saveTemplate(sessionId: string, options: { name: string; dir?: string }): Promise<PptTemplateDetail> {
    const root = await this.localRoot(sessionId)
    const dir = this.resolveDir(sessionId, options.dir)
    await readWorkspaceFile(root, join(dir, 'deck.json'), 8 * 1024 * 1024)
    const snapshot = await loadProject(dir)
    const media = await readWorkspaceMedia(root, dir, snapshot.deck)
    return this.templates.create({ name: options.name, deck: snapshot.deck, media })
  }

  /** 重命名模板但不修改 deck 或已由模板创建的工程。
   * @param id - 模板 UUID。
   * @param name - 新名称。
   * @returns 新摘要。
   * @throws PptStoreError 模板不存在或名称无效时。
   */
  renameTemplate(id: string, name: string): Promise<PptTemplateSummary> {
    return this.templates.rename(id, name)
  }

  /** 删除模板库条目，不影响已创建的工程；模型应传当前名称以防重命名后误删。
   * @param id - 模板 UUID。
   * @param expectedName - 模型确认时看到的名称，由仓库在删除锁内核对。
   * @returns 删除完成时兑现。
   * @throws PptStoreError 模板不存在、名称已变化或仓库内容不合法时。
   */
  deleteTemplate(id: string, expectedName?: string): Promise<void> {
    return this.templates.delete(id, expectedName)
  }

  /** 从模板创建可独立编辑的工程副本；成功发布后才切换会话焦点。
   * @param sessionId - 本机会话身份。
   * @param id - 模板 UUID。
   * @param options - 新标题和目标目录；缺省用模板名生成目录。
   * @returns 初始版本号为 1 的工程快照。
   * @throws PptStoreError 远程工作区、目标已存在、目录越界或模板损坏时。
   */
  async createFromTemplate(sessionId: string, id: string, options: { title?: string; dir?: string } = {}): Promise<PptSnapshot> {
    const root = await this.localRoot(sessionId)
    const { detail: template, media } = await this.templates.readWithMedia(id)
    const title = options.title ?? template.name
    const deck = parseDeck({ ...template.deck, title })
    const dir = options.dir === undefined ? await suggestProjectDir(root, title) : resolveProjectDir(root, options.dir)
    const snapshot = await publishProject(root, dir, deck, media)
    this.focus(sessionId, dir)
    return snapshot
  }

  /**
   * 导出当前版本为 .pptx。
   * @param sessionId - 会话身份。
   * @param dir - 工程目录；缺省为当前工程。
   * @param options - `skipCheck` 为 true 时跳过 error 级质检。
   * @returns 导出文件路径与大小。
   */
  async export(sessionId: string, dir?: string, options: { skipCheck?: boolean } = {}): Promise<PptExportResult> {
    const absolute = this.resolveDir(sessionId, dir)
    const snapshot = await loadProject(absolute)
    if (options.skipCheck !== true) {
      const result = checkDeck(snapshot.deck)
      const blockers = result.issues.filter(issue => issue.severity === 'error')
      if (blockers.length > 0) {
        throw new PptModelError(`导出被质检拦住：${blockers.map(issue => issue.message).join('；')}`)
      }
    }
    const sources = new Set<string>()
    for (const page of snapshot.deck.pages) {
      for (const element of page.elements) {
        if (element.kind === 'image') sources.add(element.source)
      }
    }
    const media = new Map<string, Uint8Array>()
    for (const source of sources) {
      const bytesOfImage = await readProjectMedia(absolute, source)
      if (bytesOfImage !== undefined) media.set(source, bytesOfImage)
    }
    const collected = await collectFonts(snapshot.deck, this.fontDirs)
    const bytes = buildPptx(snapshot.deck, {
      media: source => media.get(source),
      fonts: collected.fonts,
    })
    const path = await writeExport(absolute, snapshot.revision, snapshot.title, bytes)
    return {
      path,
      bytes: bytes.length,
      revision: snapshot.revision,
      fonts: collected.fonts.map(font => ({
        family: font.family,
        readonly: font.readonly,
        subset: font.subset,
      })),
      skippedFonts: collected.skipped,
    }
  }
}
