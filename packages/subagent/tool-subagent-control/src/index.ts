/**
 * Model-facing subagent control tools over `ctx.subagents`.
 *
 * `send_message` delivers a next-step message without interrupting an active
 * request. `followup_task` queues a later turn. `interrupt_agent` requests
 * cancellation of the current turn. Authority and lifecycle remain owned by the
 * subagent service.
 * @module coding-tool-subagent-control
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from 'coding-tools'
import type { ContentBlock } from 'coding-llm'
import { SessionId } from 'coding-session'
import type {} from 'coding-subagent'

export const name = 'tool-subagent-control'
export const inject = ['tools', 'subagents']

/** Optional model-facing name for the next-turn follow-up operation. */
export interface Config {
  followupToolName?: string
}

export const Config: z<Config> = z.object({
  followupToolName: z.string().default('followup_task'),
})

interface FollowupArgs {
  subagent_id: string
  message: string
}

function followupTool(
  ctx: Context,
  toolName: string,
  mode: 'next-step' | 'next-turn',
): ReturnType<typeof defineTool> {
  const label = mode === 'next-step' ? 'next-step' : 'next-turn'
  return defineTool({
    name: toolName,
    description: mode === 'next-step'
      ? 'Send a message to a background subagent by its subagent id. The message is inserted into the next available step without interrupting an in-flight model request or tool call. If the agent is idle, the message wakes it. This confirms acceptance, not that the agent has read the message.'
      : 'Send a follow-up task to a background subagent by its subagent id. The message is queued for the next turn; it does not interrupt an in-flight model request or tool call. This confirms acceptance, not completion of the task.',
    parameters: {
      subagent_id: { type: 'string', required: true, description: 'The subagent id returned when the background subagent was started.' },
      message: { type: 'string', required: true, description: 'The message to deliver to the subagent.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { messageId: { type: 'string', required: true } },
      },
      render: (args, _value) => [{
        type: 'text',
        text: `message accepted for ${label} delivery to subagent ${args.subagent_id}`,
      }],
    },
    async execute(args: FollowupArgs, exec) {
      const parent = exec.agent
      if (!parent) throw new Error(`${toolName} requires a calling agent (exec.agent was undefined)`)
      const message: ContentBlock[] = [{ type: 'text', text: args.message }]
      const messageId = await ctx.subagents.followup(
        parent,
        SessionId(args.subagent_id),
        message,
        {
          source: { kind: 'coordinator', form: 'relay', senderSessionId: parent.id },
          mode,
          signal: exec.signal,
        },
      )
      return { messageId }
    },
  })
}

/** Register the send, follow-up, and interrupt controls. */
export function apply(ctx: Context, config: Config = {}): void {
  const followupToolName = config.followupToolName ?? 'followup_task'
  if (followupToolName.trim().length === 0) throw new Error('tool-subagent-control: followupToolName must be non-empty')

  ctx.tools.register(followupTool(ctx, 'send_message', 'next-step'))
  ctx.tools.register(followupTool(ctx, followupToolName, 'next-turn'))
  ctx.tools.register(defineTool({
    name: 'interrupt_agent',
    description:
      'Request cancellation of a background agent\'s current turn by its agent id. The target may be your '
      + 'direct child or a deeper agent created under you. Only the current turn stops: queued messages stay '
      + 'parked until a later send_message or followup_task, agents it started keep running, and the agent stays available. The '
      + 'call returns as soon as the stop request is accepted; interrupting an already finished agent is a no-op.',
    parameters: {
      agent_id: { type: 'string', required: true, description: 'The agent id of the running agent to interrupt.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { accepted: { type: 'boolean', required: true } },
      },
      render: (args, _value) => [{ type: 'text', text: `interrupt requested for agent ${args.agent_id}` }],
    },
    execute(args, exec) {
      const caller = exec.agent
      if (!caller) throw new Error('interrupt_agent requires a calling agent (exec.agent was undefined)')
      ctx.subagents.interrupt(SessionId(args.agent_id), { kind: 'ancestor', agent: caller })
      return Promise.resolve({ accepted: true })
    },
  }))
}
