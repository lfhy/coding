/**
 * 长任务进度提醒。一个轮次内累计完成的工具调用达到阈值而模型始终没有向用户说话时，
 * 循环在下一步骤前注入一条系统提醒，要求用一句话说明当前进展后立即继续执行。
 * 提醒不启动新的排查阶段，也不要求后续步骤重复汇报；若当前可用工具包含 set_status，同时引导模型更新当前工作状态；
 * 没有用户决策时不打断任务。
 *
 * 计数完全从会话日志派生：从尾部回扫，遇到最近的非空助手正文、本插件上一次提醒或
 * 上一个轮次的 `turn/end` 就停。因此恢复、fork、压缩遮蔽后的计数都一致，插件不持有
 * 顺序敏感的内存状态，也不会因为漏记一次事件而少提醒或多提醒。
 *
 * @module coding-progress-reminder
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PreStepDecision } from 'coding-agent'
import { createUserMessage } from 'coding-llm'
import type { UserMessage } from 'coding-llm'
import type { SessionEvent } from 'coding-session'

/** Cordis 插件名，用于加载器诊断与提醒来源。 */
export const name = 'progress-reminder'

/** 提供 pre-step 事件的 agent 注册表。 */
export const inject = ['agents']

/** 省略 `toolCallsPerReminder` 时一个轮次内允许连续完成的工具调用数。 */
export const DEFAULT_TOOL_CALLS_PER_REMINDER = 15

/** 进度提醒节奏。非法值在插件加载时失败。 */
export interface Config {
  /** 一个轮次内连续完成这么多次工具调用而仍无进展汇报时提醒一次；默认 {@link DEFAULT_TOOL_CALLS_PER_REMINDER}。 */
  toolCallsPerReminder?: number
}

/** 提醒节奏配置的 Schemastery 校验入口。 */
export const Config: z<Config> = z.object({
  toolCallsPerReminder: z.number().default(DEFAULT_TOOL_CALLS_PER_REMINDER),
})

/**
 * 渲染提醒文本。数量取实际未汇报的调用数，因此一次并行批次跨过阈值时模型看到的是真实值。
 * 连续工具调用只表明模型需要确认节奏，不要求它为汇报停下；提醒应明确一次说明后立即继续执行。
 * 提醒文案会写入会话历史，修改后需同步持久日志快照。
 * @param toolCalls - 最近一次计数边界之后、这条提醒之前完成的工具调用数。
 * @param includeStatusTool - 是否保留状态工具的条件引导；仅历史提醒校验传 false，正常注入始终使用默认值。
 * @returns 带 system-reminder 框架的注入文本。
 */
export function renderProgressReminder(toolCalls: number, includeStatusTool = true): string {
  return [
    '<system-reminder>',
    `你已连续执行 ${toolCalls} 次工具调用，其间没有向用户汇报过进展。`,
    '只需用一句话说明当前进展，然后立即继续执行；不要把这条提醒变成新的排查阶段，也不要重复汇报。',
    ...includeStatusTool ? ['若当前可用工具中有 `set_status`，可同时用简短的单行文本更新当前工作；工具不可用时不要尝试调用。状态更新不能代替本次说明，也不要为了更新状态停下或提问。'] : [],
    '除非确实需要用户选择或确认，否则不要停下、提问或等待回复；找到根因后立即修复，验证失败就修复后重试。任务完成时再按正常方式报告结果。',
    '</system-reminder>',
  ].join('\n')
}

/** 判断一条用户消息是否为本插件注入的提醒。 */
function isProgressReminder(message: UserMessage): boolean {
  return message.source.kind === 'plugin' && message.source.plugin === name
}

/**
 * 统计当前轮次内、最近一次正文或提醒之后完成的工具调用数。
 * 只有 trim 后非空的 text 块算正文；推理、工具调用和空白文本不重置计数。
 * @param events - 目标会话的全量日志；调用方可传 `session.events`。
 * @returns 尚未汇报的 `tool/result` 数；最近的非空正文、本插件提醒或 `turn/end` 为计数边界。
 */
export function unreportedToolCalls(events: readonly SessionEvent[]): number {
  let completed = 0
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined) continue
    if (event.type === 'tool/result') {
      completed += 1
      continue
    }
    if (event.type === 'turn/end') break
    if (event.type === 'assistant/message'
      && event.data.message.content.some(block => block.type === 'text' && block.text.trim().length > 0)) break
    if (event.type === 'user/message' && isProgressReminder(event.data)) break
  }
  return completed
}

/** 拒绝无法作为节奏阈值的值；程序化挂载绕过 schema 时同样成立。 */
function validateToolCallsPerReminder(toolCallsPerReminder: number): void {
  if (!Number.isSafeInteger(toolCallsPerReminder) || toolCallsPerReminder < 1) {
    throw new TypeError(
      `progress-reminder: toolCallsPerReminder must be a positive safe integer, got ${String(toolCallsPerReminder)}`,
    )
  }
}

/**
 * 注册追加式 pre-step 监听器，随 `ctx` 一起释放。
 * @param ctx - 插件上下文；监听器归它所有。
 * @param config - 提醒节奏配置。
 * @throws 当 `toolCallsPerReminder` 不是正的安全整数时。
 */
export function apply(ctx: Context, config: Config): void {
  const threshold = config.toolCallsPerReminder ?? DEFAULT_TOOL_CALLS_PER_REMINDER
  validateToolCallsPerReminder(threshold)

  ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    // 被下游拒绝或已取消的步骤不会进入请求，提醒必须跟着真正进入的那一批。
    if (decision.kind === 'reject' || signal.aborted) return decision
    const unreported = unreportedToolCalls(agent.session.events)
    if (unreported < threshold) return decision
    return {
      kind: 'enter',
      messages: [
        ...decision.messages,
        createUserMessage({
          content: [{ type: 'text', text: renderProgressReminder(unreported) }],
          source: { kind: 'plugin', plugin: name },
        }),
      ],
    }
  })
}
