/**
 * 全局命名的 `wait_agent` 工具：把调用方邮箱的下一次投递当作唤醒信号，阻塞到出现
 * 子级投递、用户 steer 或超时。它属于 `ctx.subagents` 续跑能力（`spawn_agent` /
 * `send_message` / `followup_task` / `interrupt_agent` / `list_agents`）的等待面，
 * 与 `list-agents` 一样可以单独装载，好让部署决定是否给模型一个阻塞等待。
 *
 * 等待只观察调用方自己邮箱里的 `agent/inbox/inserted`：续跑子级结算时由
 * continuation manager 向父级投递通知，子级主动上报走同一投递边界。工具不轮询、不
 * 猜测子级状态，也不回传内容——内容仍按原投递边界进入下一步或下一轮，工具只报告
 * 本次等待为什么结束。
 * @module coding-tool-subagent-control/wait-agent
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from 'coding-tools'
import type { Agent } from 'coding-agent'
import type { UserMessage } from 'coding-llm'

export const name = 'tool-subagent-wait-agent'
export const inject = ['tools']

/**
 * 等待预算的部署配置。三个值都按毫秒计：缺省值决定模型省略 `timeout_ms` 时的等待
 * 时长，最小值把过小的请求抬到下限，最大值直接拒绝更大的请求（不静默截断）。
 */
export interface Config {
  /** 模型省略 `timeout_ms` 时使用的等待时长，默认 30000。 */
  defaultTimeoutMs?: number
  /** 单次等待的下限，默认 10000；更小的请求被抬到该值。 */
  minTimeoutMs?: number
  /** 单次等待的上限，默认 3600000；更大的请求按错误拒绝。 */
  maxTimeoutMs?: number
}

export const Config: z<Config> = z.object({
  defaultTimeoutMs: z.natural().default(30_000),
  minTimeoutMs: z.natural().default(10_000),
  maxTimeoutMs: z.natural().default(3_600_000),
})

interface WaitAgentArgs {
  timeout_ms?: number
}

type WaitOutcome = 'mailbox' | 'steered' | 'timed-out'

/** 校验等待预算，让模型看到的值全部落在部署声明的区间内。 */
function resolveTimeouts(config: Config): { defaultTimeoutMs: number; minTimeoutMs: number; maxTimeoutMs: number } {
  const defaultTimeoutMs = config.defaultTimeoutMs ?? 30_000
  const minTimeoutMs = config.minTimeoutMs ?? 10_000
  const maxTimeoutMs = config.maxTimeoutMs ?? 3_600_000
  if (!Number.isSafeInteger(defaultTimeoutMs) || !Number.isSafeInteger(minTimeoutMs) || !Number.isSafeInteger(maxTimeoutMs)) {
    throw new Error('tool-subagent-wait-agent: timeouts must be safe integers')
  }
  if (minTimeoutMs <= 0) throw new Error('tool-subagent-wait-agent: minTimeoutMs must be positive')
  if (maxTimeoutMs < minTimeoutMs) throw new Error('tool-subagent-wait-agent: maxTimeoutMs must be at least minTimeoutMs')
  if (defaultTimeoutMs < minTimeoutMs || defaultTimeoutMs > maxTimeoutMs) {
    throw new Error('tool-subagent-wait-agent: defaultTimeoutMs must fall inside [minTimeoutMs, maxTimeoutMs]')
  }
  return { defaultTimeoutMs, minTimeoutMs, maxTimeoutMs }
}

/**
 * 等待调用方邮箱的下一次投递。
 *
 * 用户投递与代理投递在结果里分开：用户新输入意味着这一轮被 steer，模型应当先回应用户；
 * 子级报告或结算通知意味着有委派结果可读。信号中止时以原因为准 reject，让被取消的轮次
 * 不把一次未完成的等待当成超时。
 * @param caller - 发起等待的在线 agent，监听注册在它自己的作用域上。
 * @param timeoutMs - 已归一化的等待上限。
 * @param signal - 本次工具调用的取消信号。
 * @returns 结束原因。
 */
function waitForActivity(caller: Agent, timeoutMs: number, signal: AbortSignal): Promise<WaitOutcome> {
  return new Promise<WaitOutcome>((resolve, reject) => {
    let settled = false
    const finish = (settle: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stopListening()
      signal.removeEventListener('abort', onAbort)
      settle()
    }
    function onAbort(): void {
      finish(() => {
        const reason: unknown = signal.reason
        reject(reason instanceof Error ? reason : new Error(`wait_agent aborted: ${String(reason)}`))
      })
    }
    const timer = setTimeout(() => { finish(() => { resolve('timed-out') }) }, timeoutMs)
    // Agent 作用域的事件过滤已经限定在调用方，身份比较只是防御直接上下文注册。
    const stopListening = caller.ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (agent !== caller) return
      finish(() => { resolve(describeActivity(message)) })
    })
    signal.addEventListener('abort', onAbort, { once: true })
    // 信号可能在监听注册之前就已中止，同步收口一次。
    if (signal.aborted) onAbort()
  })
}

/** 用户投递是 steer，其余投递（子级报告、结算通知、协调者消息）都是邮箱活动。 */
function describeActivity(message: UserMessage): WaitOutcome {
  return message.source.kind === 'user' ? 'steered' : 'mailbox'
}

/** 把结束原因和实际生效的等待时长渲染成模型可读的一行摘要。 */
function summarize(outcome: WaitOutcome, requestedTimeoutMs: number | undefined, timeoutMs: number): string {
  const base = outcome === 'mailbox'
    ? 'Wait completed.'
    : outcome === 'steered'
      ? 'Wait interrupted by new input.'
      : 'Wait timed out.'
  return requestedTimeoutMs !== undefined && requestedTimeoutMs < timeoutMs
    ? `${base}\n\nRequested timeout of ${requestedTimeoutMs}ms was clamped to the minimum of ${timeoutMs}ms.`
    : base
}

/**
 * 注册 `wait_agent` 工具。调用方必须是 agent：非 agent 调用没有邮箱可等，直接失败。
 * @param ctx - 携带工具注册表的上下文。
 * @param config - 部署声明的等待预算。
 */
export function apply(ctx: Context, config: Config = {}): void {
  const { defaultTimeoutMs, minTimeoutMs, maxTimeoutMs } = resolveTimeouts(config)
  ctx.tools.register(defineTool({
    name: 'wait_agent',
    description:
      'Wait for a mailbox update from any live agent: a queued message, a report, or a final-status '
      + 'notification. The wait also ends early when new user input is steered into the active turn. '
      + 'Returns a short summary and whether the wait timed out; it does not return the content, which '
      + 'arrives through normal message delivery. Use it instead of polling list_agents.',
    parameters: {
      timeout_ms: {
        type: 'integer',
        description: 'Maximum time to wait in milliseconds before reporting a timeout. '
          + `Defaults to ${defaultTimeoutMs}; values below ${minTimeoutMs} are raised to that minimum and `
          + `values above ${maxTimeoutMs} are rejected.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          message: { type: 'string', required: true },
          timed_out: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args: WaitAgentArgs, exec) {
      const caller = exec.agent
      if (!caller) throw new Error('wait_agent requires a calling agent (exec.agent was undefined)')
      const requested = args.timeout_ms
      if (requested !== undefined && requested > maxTimeoutMs) {
        throw new Error(`timeout_ms must be at most ${maxTimeoutMs}`)
      }
      const timeoutMs = requested === undefined ? defaultTimeoutMs : Math.max(requested, minTimeoutMs)
      // 等待开始前就排队的投递同样是可读更新：模型下一步就能拿到它，不必再等一次。
      const outcome = caller.inbox.hasPending
        ? 'mailbox'
        : await waitForActivity(caller, timeoutMs, exec.signal)
      return { message: summarize(outcome, requested, timeoutMs), timed_out: outcome === 'timed-out' }
    },
  }))
}
