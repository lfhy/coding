/**
 * 宿主侧渲染：把每页 HTML 交给 Agent 浏览器（ego）打开并截图，得到与工作台一致的 PNG。
 *
 * 浏览器机制（CLI 路径、任务空间、进程）归 `coding-browser-ego-host`，这里只负责生成
 * HTML、落盘与读取结果；两者通过 `ctx.get('egoBrowser')` 的 `captureLocalPage` 契约衔接，
 * 因此没有浏览器提供方时这里给出明确诊断，而不是假装渲染成功。
 * @module coding-ppt-workbench/render
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SLIDE_SIZES, type PptDeck } from 'coding-ppt-model'
import { renderPageHtml, type RenderMedia } from './render-html.ts'

/** 会话自己的 Agent 浏览器：打开本地页面并截图。 */
export interface PageCapture {
  captureSessionPage(options: {
    readonly sessionId: string
    readonly htmlPath: string
    readonly width: number
    readonly height: number
    readonly outPath: string
    readonly settleMs?: number
  }): Promise<boolean>
}

/** 一页的渲染结果。 */
export interface RenderedPage {
  /** 页面 id。 */
  readonly page: string
  /** 页面名。 */
  readonly name: string
  /** PNG 的绝对路径。 */
  readonly path: string
}

/** 渲染失败；`reason` 直接交给调用方说明为什么没有图。 */
export class RenderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RenderError'
  }
}

/**
 * 渲染指定页为 PNG。
 * @param options.sessionId - 会话身份；页面进它自己的 Agent 浏览器空间，右侧标签会跟着显示。
 * @param options.projectDir - 工程的绝对目录（HTML 与图片都写在这里的子目录）。
 * @param options.deck - 演示文稿。
 * @param options.pages - 要渲染的页下标；缺省渲染全部。
 * @param options.media - 工程内图片字节。
 * @param options.capture - 浏览器提供方。
 * @param options.revision - 版本号，进文件名便于对照。
 * @returns 每页的 PNG 路径。
 * @throws RenderError - 没有浏览器提供方，或截图失败时。
 */
export async function renderPages(options: {
  readonly sessionId: string
  readonly projectDir: string
  readonly deck: PptDeck
  readonly pages?: readonly number[]
  readonly media: RenderMedia
  readonly capture: PageCapture | undefined
  readonly revision: number
}): Promise<RenderedPage[]> {
  if (options.capture === undefined) {
    throw new RenderError('当前部署没有可用的浏览器提供方，无法渲染页面图')
  }
  const size = SLIDE_SIZES[options.deck.size]
  const workDir = join(options.projectDir, '.render')
  const outDir = join(options.projectDir, 'render')
  await mkdir(workDir, { recursive: true })
  await mkdir(outDir, { recursive: true })
  const indices = options.pages ?? options.deck.pages.map((_, index) => index)
  const rendered: RenderedPage[] = []
  for (const index of indices) {
    const page = options.deck.pages[index]
    if (page === undefined) throw new RenderError(`没有第 ${index + 1} 页`)
    const htmlPath = join(workDir, `slide-${index + 1}.html`)
    await writeFile(htmlPath, renderPageHtml(options.deck, page, options.media), 'utf8')
    const outPath = join(outDir, `slide-${index + 1}-v${options.revision}.png`)
    const ok = await options.capture.captureSessionPage({
      sessionId: options.sessionId,
      htmlPath,
      width: size.width,
      height: size.height,
      outPath,
    })
    if (!ok) throw new RenderError(`第 ${index + 1} 页截图失败：浏览器没有返回画面`)
    rendered.push({ page: page.id, name: page.name, path: outPath })
  }
  return rendered
}
