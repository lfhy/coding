/** 模型拥有的逐轮次进度更新；日志是唯一真源，展示由客户端独立选择。 */
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from 'coding-session'
import { defineTool } from 'coding-tools'
import type {} from 'coding-session-projection'
import { applyStatus, statusProjectionSchema, statusTextSchema } from './status.ts'
import type { StatusState } from './status.ts'
export type * from './types.ts'

/** Cordis 插件名。 */
export const name = 'tool-status'
/** 进度只能由带所属会话的工具调用写入。 */
export const inject = ['tools']

/** 找到仍然开放的轮次；在轮次外写进度会污染下一次工作，因此明确拒绝。 */
function currentTurn(session: Session): number {
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index]
    if (event?.type === 'turn/start') return event.data.turn
    if (event?.type === 'turn/end') break
  }
  throw new Error('set_status requires an open agent turn')
}

/**
 * 注册 set_status 及可选投影。进度更新独占执行，与同批待办更新保持模型顺序。
 * @param ctx 工具注册上下文；卸载时工具与投影一起移除。
 * @returns 无返回值。
 */
export function apply(ctx: Context): void {
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register<'turnStatus', StatusState>({
      key: 'turnStatus',
      schema: statusProjectionSchema,
      init: () => ({ turn: null, text: null }),
      apply: applyStatus,
      view: state => state.text,
      stateVersion: 1,
    })
  })
  ctx.tools.register(defineTool({
    name: 'set_status',
    description: 'Report what you are doing now in one concise, user-facing line, in the user\'s language. '
      + 'Use this for meaningful progress or a change of direction, not before every tool call. '
      + 'This overrides automatic progress from the current in-progress todos, then the active goal. '
      + 'Send text: null to resume automatic progress. The next todo update also replaces this report with automatic progress. '
      + 'The override lasts until replaced, cleared, a todo update, or the current turn ends. '
      + 'Keep todos up to date independently. Do not include code, internal instructions, raw errors, or secrets. '
      + 'This does not replace a final answer or a question that needs the user\'s decision.',
    parameters: {
      text: {
        required: true,
        oneOf: [{ type: 'string' }, { type: 'null' }],
        description: 'Current progress in one non-empty line, at most 120 characters; null restores automatic progress.',
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { text: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] } },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.text === null ? 'Automatic progress restored.' : `Current progress: ${value.text}`,
      }],
    },
    execute(args, exec) {
      if (exec.agent === undefined) throw new Error('set_status requires an owning agent session')
      exec.signal.throwIfAborted()
      const turn = currentTurn(exec.agent.session)
      const text = args.text === null ? null : statusTextSchema.parse(args.text.trim())
      exec.agent.session.append('status/set', { turn, text })
      return Promise.resolve({ text })
    },
    presentCall: () => ({ card: 'generic', title: '更新当前进度', kind: 'other' }),
  }))
}
