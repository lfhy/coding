/**
 * AI 版式审阅：把工程的「大纲视图」交给会话所用的模型，让它按人读稿子的角度给建议
 * （信息密度、层级、配色、讲述顺序），规则层覆盖不到的判断由它补上。
 *
 * 它只返回建议、不改工程也不阻断导出：模型给出的评价不能当作确定性结论。没有可用的
 * 模型路由时如实返回 `performed: false` 与原因，而不是假装审阅过。
 * @module coding-tool-ppt/ai-review
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from 'coding-agent'
import { createUserMessage } from 'coding-llm'
import type { GenerateOptions } from 'coding-llm'

/** 一页在审阅提示里的摘要。 */
interface PageDigest {
  readonly name: string
  readonly texts: readonly string[]
  readonly shapes: number
  readonly tables: number
  readonly charts: number
  readonly images: number
  readonly transition: string
}

/**
 * 把工程压缩成适合模型阅读的大纲文本。
 * @param title - 演示文稿标题。
 * @param size - 画布尺寸。
 * @param theme - 主题名。
 * @param pages - 每页摘要。
 * @returns 大纲文本。
 */
export function outlineText(
  title: string,
  size: string,
  theme: string,
  pages: readonly PageDigest[],
): string {
  const lines = [`演示文稿《${title}》，画布 ${size}，主题 ${theme}，共 ${pages.length} 页。`]
  for (const [index, page] of pages.entries()) {
    const parts = [`第 ${index + 1} 页「${page.name}」`]
    if (page.texts.length > 0) {
      parts.push(`文字：${page.texts.slice(0, 4).map(text => `「${text.slice(0, 80)}」`).join('、')}`)
    }
    if (page.shapes > 0) parts.push(`形状 ${page.shapes} 个`)
    if (page.images > 0) parts.push(`图片 ${page.images} 张`)
    if (page.tables > 0) parts.push(`表格 ${page.tables} 个`)
    if (page.charts > 0) parts.push(`图表 ${page.charts} 个`)
    parts.push(`转场 ${page.transition}`)
    lines.push(parts.join('；'))
  }
  return lines.join('\n')
}

const INSTRUCTION = '你是资深演示文稿审阅者。下面是一份 PPT 的页面大纲（只有结构、文字与元素数量，没有图片预览）。'
  + '请用中文给出最多 5 条可以直接执行的改进建议，每条一行、以「- 」开头，'
  + '针对具体页与具体做法（例如「第 2 页文字超过 200 字，拆成两页」「第 4 页与第 5 页配色不一致，统一为主题强调色」）。'
  + '不要复述大纲，不要给泛泛而谈的原则，也不要建议修改工具或流程。如果这份稿子在结构与讲述上已经成立，就只回一行「- 结构与讲述顺序成立，无需调整」。'

/**
 * 调用会话模型审阅工程大纲。
 * @param ctx - 提供 `llm` 服务的宿主上下文。
 * @param agent - 当前会话所属 Agent，用于取路由与会话 id。
 * @param outline - 大纲文本。
 * @param signal - 取消信号。
 * @returns 模型给出的建议文本。
 * @throws Error - 没有可用路由，或模型没有产出文字时。
 */
export async function reviewOutline(
  ctx: Context,
  agent: {
    options: { provider?: string; model?: string }
    session: {
      id: import('coding-session/types').SessionId
      requestHeader: () => { config?: { provider: string; model: string } } | undefined
    }
  },
  outline: string,
  signal?: AbortSignal,
): Promise<string> {
  const header = agent.session.requestHeader()?.config
  const target = agent.options.provider !== undefined && agent.options.provider !== ''
    && agent.options.model !== undefined && agent.options.model !== ''
    ? { provider: agent.options.provider, model: agent.options.model }
    : header
  if (target === undefined) throw new Error('当前会话还没有可用的模型路由，无法做 AI 审阅')
  const options: GenerateOptions = {
    provider: target.provider,
    model: target.model,
    messages: [
      createUserMessage({
        content: [{ type: 'text', text: `${INSTRUCTION}\n\n${outline}` }],
        source: { kind: 'plugin', plugin: 'coding-tool-ppt' },
      }),
    ],
    maxTokens: 1200,
    sessionId: agent.session.id,
    ...signal === undefined ? {} : { signal },
  }
  let text = ''
  for await (const chunk of ctx.llm.stream(options)) {
    if (chunk.type === 'text-delta') text += chunk.text
  }
  if (text.trim() === '') throw new Error('模型没有返回审阅文字')
  return text.trim()
}
