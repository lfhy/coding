/** 打开笔记页：先取笔记根目录，复用或创建以它为工作目录的会话，再打开页面并挂上 AI 助手轨。 */
import type { ClientContext } from 'coding-client-runtime/client'
import { notesCwd } from './wire.ts'

const PAGE = 'notes'

/**
 * 创建笔记页打开动作；同一时刻只允许一个进行中的打开流程。
 * @param ctx - 浏览器插件 Context。
 * @returns 幂等的打开函数；失败时抛出供入口显示提示。
 */
export function createNotesNavigation(ctx: ClientContext): () => Promise<void> {
  let opening: Promise<void> | undefined
  const run = async (): Promise<void> => {
    const current = ctx.sessions.list.getSnapshot().current
    // 从其他独立页切入时沿用先前对话的来处，不把笔记页所属会话当成归途。
    const origin = ctx.layout.page.getSnapshot()?.returnSessionId ?? current
    // 先让文件库创建私有笔记目录，再以其为会话工作目录，避免会话按默认权限创建同一路径。
    const cwd = await notesCwd(new AbortController().signal)
    const byId = ctx.sessions.list.getSnapshot().byId
    const existing = Object.values(byId).find(session => session.cwd === cwd)
    const target = existing?.id ?? await ctx.sessions.create({ cwd })
    ctx.sessions.open(target)
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        ctx.layout.togglePage(PAGE, target, origin)
        ctx.layout.setPageAssistant(true)
        return
      } catch {
        await new Promise<void>((resolve) => { window.setTimeout(resolve, 32) })
      }
    }
    throw new Error('notes page unavailable')
  }
  return () => {
    opening ??= run().finally(() => { opening = undefined })
    return opening
  }
}
