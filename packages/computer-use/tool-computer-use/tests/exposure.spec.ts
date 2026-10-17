/** 渐进式暴露的单元覆盖：两条持久化证据路径都必须被识别，无关技能不得解锁执行工具。 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId, createUserMessage } from 'coding-llm'
import SessionStore, { SessionId } from 'coding-session'
import type { Session } from 'coding-session'
import { COMPUTER_USE_SKILL_CONTENT, COMPUTER_USE_SKILL_NAME } from '../src/skill.ts'
import { hasLoadedComputerUseSkill } from '../src/exposure.ts'

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

/** 建一个只有事件日志的真实会话，证据完全来自 append 的事件。 */
async function session(id: string): Promise<Session> {
  ctx = new Context()
  await ctx.plugin(SessionStore)
  const value = ctx.sessions.create(SessionId(id), { meta: { cwd: process.cwd() } })
  value.append('turn/start', { turn: 1 })
  return value
}

function skillInvocation(value: Session, name = COMPUTER_USE_SKILL_NAME): void {
  value.append('user/message', createUserMessage({
    content: [{ type: 'text', text: COMPUTER_USE_SKILL_CONTENT }],
    source: { kind: 'skill-invocation', name, form: 'instructions' },
  }), { surfaceOp: 'append' })
}

function codeDispatch(value: Session, dispatched: unknown, content: { type: 'text'; text: string }[]): void {
  value.append('tool/code-dispatch', {
    rootCallId: CallId('root-call'),
    parentCallId: CallId('parent-call'),
    subCallId: CallId('sub-call'),
    name: 'skill',
    arguments: dispatched,
    isError: false,
    content,
  })
}

describe('hasLoadedComputerUseSkill', () => {
  it('recognises the durable user-message invocation the Skill tool appends', async () => {
    const owner = await session('cu-exposure-native')
    expect(hasLoadedComputerUseSkill(owner)).toBe(false)
    skillInvocation(owner)
    expect(hasLoadedComputerUseSkill(owner)).toBe(true)
  })

  it('recognises a Code Mode dispatch that returned this Skill body', async () => {
    const owner = await session('cu-exposure-code')
    codeDispatch(
      owner,
      { name: COMPUTER_USE_SKILL_NAME },
      [{ type: 'text', text: COMPUTER_USE_SKILL_CONTENT }],
    )
    expect(hasLoadedComputerUseSkill(owner)).toBe(true)
  })

  it('ignores other Skills, other tools and failed dispatches', async () => {
    const owner = await session('cu-exposure-other')
    skillInvocation(owner, 'browser-use')
    codeDispatch(owner, { name: 'browser-use' }, [{ type: 'text', text: COMPUTER_USE_SKILL_CONTENT }])
    codeDispatch(owner, { name: COMPUTER_USE_SKILL_NAME }, [{ type: 'text', text: 'unrelated body' }])
    expect(hasLoadedComputerUseSkill(owner)).toBe(false)
  })
})
