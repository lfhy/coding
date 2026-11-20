/** 打开笔记页与开始新的笔记对话：会话都以笔记目录为工作目录并切到笔记专用模式。 */
import type { ClientContext } from 'coding-client-runtime/client'
import type { ConnectionHandle } from 'coding-api-remotes/client'
import type { SessionId } from 'coding-session/types'
import { notesCwd } from './wire.ts'

const PAGE = 'notes'
const PRESET = 'notes'

/**
 * 把会话切到笔记专用模式，保证助手按笔记用途读写当前目录。
 * @param ctx - 浏览器插件 Context。
 * @param sessionId - 目标会话；必须仍是空白会话。
 * @param created - 会话是否由本次流程创建，决定空白检查的严格程度。
 * @returns 切换完成；未就绪或 Host 拒绝时抛出。
 */
async function applyNotesPreset(ctx: ClientContext, sessionId: SessionId, created: boolean): Promise<void> {
  const targetSummary = ctx.sessions.list.getSnapshot().byId[sessionId]
  if (targetSummary?.agentPreset === PRESET) return
  if (!created && targetSummary?.blank !== true) throw new Error('笔记助手需要空白会话')
  const api = (ctx.get('connection') as ConnectionHandle).api
  const response = await api.agentPresets.select({ sessionId, agentPreset: PRESET })
  if (!response.result.ok || response.result.value.agentPreset !== PRESET) {
    throw new Error('笔记专用模式暂不可用')
  }
  ctx.sessions.noteAgentPreset(sessionId, PRESET)
}

/**
 * 创建笔记页打开动作；同一时刻只允许一个进行中的打开流程。
 * 本次运行里已经在用的对话会继续用；重开窗口后的第一次进入从空白对话开始，
 * 让助手停在带历史列表的欢迎页，历史对话只在「最近对话」里手动接续。
 * @param ctx - 浏览器插件 Context。
 * @param currentConversation - 读取笔记页当前显示的会话；未进入过或已离开本次运行返回 undefined。
 * @returns 幂等的打开函数；失败时抛出供入口显示提示。
 */
export function createNotesNavigation(
  ctx: ClientContext,
  currentConversation: () => SessionId | undefined,
): () => Promise<void> {
  let opening: Promise<void> | undefined
  const run = async (): Promise<void> => {
    const current = ctx.sessions.list.getSnapshot().current
    // 从其他独立页切入时沿用先前对话的来处，不把笔记页所属会话当成归途。
    const origin = ctx.layout.page.getSnapshot()?.returnSessionId ?? current
    // 先让文件库创建私有笔记目录，再以其为会话工作目录，避免会话按默认权限创建同一路径。
    const cwd = await notesCwd(new AbortController().signal)
    const { byId } = ctx.sessions.list.getSnapshot()
    const sameDirectory = Object.values(byId).filter(session => session.cwd === cwd)
      .sort((left, right) => right.updatedAt - left.updatedAt)
    const remembered = currentConversation()
    const previous = remembered === undefined ? undefined : byId[remembered]
    // 只接续本次运行里用过的对话，其余情况挑同目录的空白会话；带历史却不在用的
    // 对话留在欢迎页的「最近对话」里，不自动打开。
    const existing = previous?.cwd === cwd ? previous : sameDirectory.find(session => session.blank)
    const created = existing === undefined
    const target = existing?.id ?? await ctx.sessions.create({ cwd })
    await applyNotesPreset(ctx, target, created)
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

/**
 * 创建笔记页助手的「新对话」动作：同一笔记目录上新建空白会话，沿用笔记专用模式，
 * 页面与助手保持在原位。失败时不切换会话，当前草稿与对话保持不变。
 * @param ctx - 浏览器插件 Context。
 * @returns 幂等的新对话动作；上一次未完成时忽略重复点击。
 */
export function createNotesConversation(ctx: ClientContext): () => Promise<void> {
  let starting = false
  const run = async (): Promise<void> => {
    const page = ctx.layout.page.getSnapshot()
    if (page === null || page.kind !== PAGE) return
    const cwd = await notesCwd(new AbortController().signal)
    const target = await ctx.sessions.create({ cwd })
    await applyNotesPreset(ctx, target, true)
    // 先选中新会话再切页面；反过来会因页面所属会话不是当前选择而被丢弃。
    ctx.sessions.open(target)
    ctx.layout.openPage(PAGE, target, page.returnSessionId)
    ctx.layout.setPageAssistant('auto')
  }
  return () => {
    if (starting) return Promise.resolve()
    starting = true
    return run().finally(() => { starting = false })
  }
}
