/** 测试使用真实工具执行器、会话与投影；仅省略不参与被测行为的 Agent 驱动。 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from 'coding-agent'
import { CallId } from 'coding-llm'
import SessionStore, { SessionId, type Session } from 'coding-session'
import SessionProjectionRegistry from 'coding-session-projection'
import SystemPrompt from 'coding-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from 'coding-tools'
import * as ToolStatus from '../src/index.ts'

/**
 * 挂载每项测试独占的运行时；调用者负责释放根上下文。
 * @param options 是否挂载进度工具与可选投影服务。
 * @returns 真实 Cordis 根上下文。
 */
export async function statusHarness(options: { tool?: boolean; projections?: boolean } = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  if (options.projections === true) await ctx.plugin(SessionProjectionRegistry)
  if (options.tool !== false) await ctx.plugin(ToolStatus)
  return ctx
}

/**
 * 为工具执行提供真实会话，未使用的驱动方法不参与替身。
 * @param ctx 拥有会话的根上下文。
 * @param id 测试内部的会话标识。
 * @param turn 开放轮次；省略时保持轮次外状态。
 * @returns 工具所需的所属 Agent。
 */
export function statusAgent(ctx: Context, id: string, turn?: number): Agent {
  const session = ctx.sessions.create(SessionId(id))
  if (turn !== undefined) session.append('turn/start', { turn })
  return { id: session.id, session, ctx } as Agent
}

/**
 * 经真实工具参数验证与错误归一化执行进度更新。
 * @param ctx 持有工具注册表的上下文。
 * @param owner 所属 Agent；省略时验证无所属会话的拒绝路径。
 * @param args 未信任的模型参数。
 * @param signal 调用取消信号。
 * @returns 真实执行器的规范结果。
 */
export function callStatus(ctx: Context, owner: Agent | undefined, args: unknown,
  signal = new AbortController().signal): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    callId: CallId('status-test-call'), name: 'set_status', arguments: args, signal,
    ...(owner === undefined ? {} : { agent: owner }),
  })
}

/**
 * 提取进度领域事实，不把工具调用轨迹误当成进度写入。
 * @param session 被检查的真实会话。
 * @returns 按原顺序排列的完整进度事实。
 */
export function statusFacts(session: Session) {
  return session.events.filter(event => event.type === 'status/set')
}

/**
 * 提取模型看到的文字结果。
 * @param result 真实执行结果。
 * @returns 所有文字块拼接后的内容。
 */
export function resultText(result: ToolExecutionResult): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}
