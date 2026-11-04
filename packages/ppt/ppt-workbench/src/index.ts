/**
 * PPT 创作模式的宿主能力：演示文稿工程服务（`pptProjects`）与右侧工作台的数据通道。
 *
 * 职责边界：本包拥有工程目录布局、版本与撤销历史、.pptx 导出，以及「模型打开的工程」
 * 与「右侧工作台当前工程」之间的会话级交接。模型可见的工具在 `coding-tool-ppt`，面板在
 * `./client`，两者都只经这里的方法读写，不复制存储逻辑。
 * @module coding-ppt-workbench
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from 'coding-host-webserver'
import type {} from 'coding-session'
import type { SessionId } from 'coding-session/types'
import { buildPptx } from './export/pptx.ts'
import { PptModelError, type SlideSizeId, type ThemeId } from 'coding-ppt-model'
import { installRoutes } from './routes.ts'
import {
  createProject, editProject, listProjects, loadProject, redoProject, resolveProjectDir,
  suggestProjectDir, undoProject, writeExport,
  type PptProjectSummary, type PptSnapshot,
} from './store.ts'

export type * from './store.ts'
export type * from 'coding-ppt-model'
export type * from './ops.ts'
export { PptModelError } from 'coding-ppt-model'
export { PptStoreError } from './store.ts'

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
}

declare module '@deepseek-ai/cordis' {
  interface Context { pptProjects: PptProjects }
}

/** 会话级工程服务；所有写入口都在这里串行化并转换错误码。 */
export default class PptProjects extends Service {
  static inject = ['sessions']

  /** 每个会话当前打开的工程目录（绝对路径）。 */
  private readonly active = new Map<string, string>()
  /** 模型最近一次要求面板打开工程的时间戳。 */
  private readonly openRequests = new Map<string, PptOpenRequest>()

  constructor(ctx: Context) {
    super(ctx, 'pptProjects')
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
   * @returns 工程列表、当前工程与待处理的开打请求。
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
   * 导出当前版本为 .pptx。
   * @param sessionId - 会话身份。
   * @param dir - 工程目录；缺省为当前工程。
   * @returns 导出文件路径与大小。
   */
  async export(sessionId: string, dir?: string): Promise<PptExportResult> {
    const absolute = this.resolveDir(sessionId, dir)
    const snapshot = await loadProject(absolute)
    const bytes = buildPptx(snapshot.deck)
    const path = await writeExport(absolute, snapshot.revision, snapshot.title, bytes)
    return { path, bytes: bytes.length, revision: snapshot.revision }
  }
}
