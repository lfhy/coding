/**
 * `ctx.userQuestions` 的模型侧 Consumer。等待真人回答期间仅暂停本次工具调用；
 * 五分钟无人回答时撤回问题，并将需要自行决策的结果交给模型。
 *
 * @module coding-tool-ask-user
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from 'coding-tools'
import { deadline, timeoutOf } from 'coding-timeout'
import { UserQuestionError, type AskUserQuestionAnswer } from 'coding-user-questions'

export const name = 'tool-ask-user'
export const inject = ['tools', 'userQuestions']

const ASK_TIMEOUT = 'ASK_TIMEOUT'
const ASK_TIMEOUT_MS = 5 * 60_000
const timeoutMessage = '用户未响应 需要自行决策'

const description = 'Ask the user a concise question when you need confirmation, a choice, or missing information before proceeding. '
  + 'Send one or more questions, each with a stable id that will be echoed in the answer.'

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'ask_user_question',
    description,
    parameters: {
      questions: {
        type: 'array',
        required: true,
        description: 'Questions to ask the user before continuing.',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            id: { type: 'string', required: true, description: 'Stable id for this question; echoed in the answer.' },
            question: { type: 'string', required: true, description: 'The specific question to ask the user.' },
            header: {
              type: 'string',
              description: 'Optional short heading for the question, such as "Confirm" or "Choose Mode".',
            },
            options: {
              type: 'array',
              description: 'Optional choices to show the user. If you recommend one, put it first and append "(Recommended)" to that label.',
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  label: { type: 'string', required: true, description: 'Short user-facing option label.' },
                  description: { type: 'string', description: 'One sentence explaining the tradeoff or impact.' },
                },
              },
            },
            multi_select: {
              type: 'boolean',
              description: 'Whether the user may select more than one option. Defaults to false.',
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          answers: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                selected: { type: 'array', required: true, items: { type: 'string' } },
                custom: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      using d = deadline(exec.signal, ASK_TIMEOUT_MS, ASK_TIMEOUT)
      let onAbort: (() => void) | undefined
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => { reject(new UserQuestionError('ask_user_question was aborted before the user answered', 'ASK_ABORTED')) }
        if (d.signal.aborted) onAbort()
        else d.signal.addEventListener('abort', onAbort, { once: true })
      })
      let result: AskUserQuestionAnswer
      try {
        // 将同一截止信号交给提供方以撤回界面等待；竞速防止不处理信号的提供方卡住工具。
        result = await Promise.race([ctx.userQuestions.ask({
          questions: args.questions.map(question => ({
            id: question.id,
            question: question.question,
            ...question.header !== undefined ? { header: question.header } : {},
            ...question.options !== undefined ? { options: question.options } : {},
            ...question.multi_select !== undefined ? { multiSelect: question.multi_select } : {},
          })),
          ...exec.agent !== undefined ? { agent: exec.agent } : {},
          signal: d.signal,
        }), aborted])
      } catch (error) {
        if (timeoutOf(d.signal, ASK_TIMEOUT) !== undefined) {
          throw new UserQuestionError(timeoutMessage, ASK_TIMEOUT)
        }
        throw error
      } finally {
        if (onAbort !== undefined) d.signal.removeEventListener('abort', onAbort)
      }
      // 同一时钟滴答内即使回答 Promise 先完成，也不能把过期回答作为真人选择提交。
      if (timeoutOf(d.signal, ASK_TIMEOUT) !== undefined) {
        throw new UserQuestionError(timeoutMessage, ASK_TIMEOUT)
      }
      return {
        answers: result.answers.map(answer => ({
          id: answer.id,
          selected: [...answer.selected],
          ...answer.custom !== undefined ? { custom: answer.custom } : {},
        })),
      }
    },
  }))
}
