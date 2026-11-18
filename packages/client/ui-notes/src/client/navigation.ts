/** 打开笔记页：复用笔记目录的会话，并由布局在空间充足时自动展开助手。 */
import type { ClientContext } from 'coding-client-runtime/client'
import type { ConnectionHandle } from 'coding-api-remotes/client'
import { notesCwd } from './wire.ts'

const PAGE = 'notes'
const PRESET = 'notes'

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
    const { byId } = ctx.sessions.list.getSnapshot()
    const sameDirectory = Object.values(byId).filter((session): session is NonNullable<typeof session> => session?.cwd === cwd)
      .sort((left, right) => right.updatedAt - left.updatedAt)
    const existing = sameDirectory.find(session => session.agentPreset === PRESET)
      ?? sameDirectory.find(session => session.blank)
    const created = existing === undefined
    const target = existing?.id ?? await ctx.sessions.create({ cwd })
    const targetSummary = ctx.sessions.list.getSnapshot().byId[target]
    if (targetSummary?.agentPreset !== PRESET) {
      if (!created && !targetSummary?.blank) throw new Error('笔记助手需要空白会话')
      const api = (ctx.get('connection') as ConnectionHandle).api
      const response = await api.agentPresets.select({ sessionId: target, agentPreset: PRESET })
      if (!response.result.ok || response.result.value.agentPreset !== PRESET) throw new Error('笔记专用模式暂不可用')
      ctx.sessions.noteAgentPreset(target, PRESET)
    }
    ctx.sessions.open(target)
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        ctx.layout.togglePage(PAGE, target, origin)
      } catch {
        await new Promise<void>((resolve) => { window.setTimeout(resolve, 32) })
        continue
      }
      ctx.layout.setPageAssistant('auto')
      return
    }
    throw new Error('notes page unavailable')
  }
  return () => {
    opening ??= run().finally(() => { opening = undefined })
    return opening
  }
}
