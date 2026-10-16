/**
 * 长任务进度提醒。一个轮次内累计完成的工具调用达到阈值而模型始终没有向用户说话时，
 * 循环在下一步骤前注入一条系统提醒，要求先汇报进度再继续干。
 *
 * 计数完全从会话日志派生：从尾部回扫，遇到本插件上一次注入的提醒或上一个轮次的
 * `turn/end` 就停。因此恢复、fork、压缩遮蔽后的计数都一致，插件不持有顺序敏感的
 * 内存状态，也不会因为漏记一次事件而少提醒或多提醒。
 *
 * @module @deepseek-ai/dsh-progress-reminder
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'progress-reminder'

/** The agent registry that owns pre-step processing. */
export const inject = ['agents']

/** 省略 `toolCallsPerReminder` 时一个轮次内允许连续完成的工具调用数。 */
export const DEFAULT_TOOL_CALLS_PER_REMINDER = 15

/** 进度提醒节奏。非法值在插件加载时失败。 */
export interface Config {
  /** 一个轮次内连续完成这么多次工具调用而仍无进展汇报时提醒一次；默认 {@link DEFAULT_TOOL_CALLS_PER_REMINDER}。 */
  toolCallsPerReminder?: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  toolCallsPerReminder: z.number().default(DEFAULT_TOOL_CALLS_PER_REMINDER),
})

/**
 * 渲染提醒文本。数量取实际未汇报的调用数，因此一次并行批次跨过阈值时模型看到的是真实值。
 *
 * 文本点名"正文"并说明用户看不到思考过程：实测里模型会把整段进度写在推理块中，
 * 而推理块在客户端默认折叠，用户读不到。
 * @param toolCalls - 本插件这条提醒之前、当前轮次内已完成的工具调用数。
 * @returns 带 system-reminder 框架的注入文本。
 */
export function renderProgressReminder(toolCalls: number): string {
  return [
    '<system-reminder>',
    `你已连续执行 ${toolCalls} 次工具调用，其间没有向用户汇报过进展。`,
    '用户看不到你的思考过程，只能看到回复正文。',
    '现在先在正文里写一段简短的进度说明：已完成什么、还剩什么、有没有需要用户拍板的地方；然后继续执行剩余任务。',
    '</system-reminder>',
  ].join('\n')
}

/** 判断一条用户消息是否为本插件注入的提醒。 */
function isProgressReminder(message: UserMessage): boolean {
  return message.source.kind === 'plugin' && message.source.plugin === name
}

/**
 * 统计当前轮次内、本插件上一次提醒之后完成的工具调用数。
 * @param events - 目标会话的全量日志；调用方可传 `session.events`。
 * @returns 尚未汇报的 `tool/result` 数；上一个 `turn/end` 或本插件的提醒消息都是计数边界。
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
