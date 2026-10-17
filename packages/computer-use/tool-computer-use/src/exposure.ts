/** Agent-scoped progressive exposure for Computer Use execution Tools. */

import type { Agent } from 'coding-agent'
import type { ContentBlock } from 'coding-llm'
import type { Session, SessionEvent } from 'coding-session'
import { defineTool, type ToolDefinition } from 'coding-tools'
import type { Context } from '@deepseek-ai/cordis'
import { COMPUTER_USE_SKILL_CONTENT, COMPUTER_USE_SKILL_NAME, COMPUTER_USE_SKILL_NAMES } from './skill.ts'

/** One global bootstrap retained until the current Agent loads the Skill. */
export const COMPUTER_USE_ACTIVATE = 'computer_use_activate'

const VISION_TOOL_NAMES = [
  'vision_glance',
  'vision_ground',
  'vision_detect',
  'vision_crop',
  'vision_long_screenshot_ocr',
  'vision_toolkit_activate',
] as const

// 三条正则都带 `i` 标志：字符类里的 A-Z 与 a-z 等价，只保留小写区间即可（匹配集合不变）。
// 超长表达式按段拼接，行宽受限时仍保持与上游逐字等价的模式与标志。
const COMMAND_PREFIX = new RegExp(
  String.raw`^(?:(?:[a-z_][a-z0-9_]*=\S+)\s+)*`
  + String.raw`(?:(?:\S*\/)?(?:sudo|env|nohup|time|command|exec)\s+`
  + String.raw`(?:(?:-\S+|[a-z_][a-z0-9_]*=\S+)\s+)*)?`,
  'iu',
)
const OCR_COMMAND_PROBE = /^(?:which|type|command\s+-v)\b[^\n;&|]*\b(?:tesseract|screencapture)\b/iu
const OCR_EXECUTABLE = /^(?:\S*\/)?(?:tesseract|screencapture)(?:\s|$)/iu
const OCR_STACK_SETUP = new RegExp(
  String.raw`^(?:(?:\S*\/)?(?:brew|port|apt(?:-get)?|dnf|yum|pacman)\b[^\n]*(?:install|add)\b[^\n]*\btesseract(?:-ocr)?\b`
  + String.raw`|(?:\S*\/)?(?:pip(?:3(?:\.\d+)*)?|uv\s+pip|poetry\s+add|pdm\s+add)\b[^\n]*(?:install|add)?[^\n]*\b(?:pytesseract|easyocr|ocrmypdf)\b)`,
  'iu',
)
const SCRIPTED_OCR_EXECUTABLE = /^(?:\S*\/)?(?:python(?:3(?:\.\d+)*)?|swift)(?:\s|$)/iu
const SCRIPTED_OCR_MARKER = /(?:\bpytesseract\b|\beasyocr\b|\bocrmypdf\b|VNRecognizeTextRequest|\bimport\s+Vision\b)/iu
const SHELL_META = /(?:&&|\|\||[;|\n])/u

interface AgentExposure {
  active: boolean
  hideActivation?: () => void
  toolDisposers: Array<() => void>
  toolNames: string[]
}

/** Activation result returned to the model. */
export interface ComputerUseActivationResult {
  activated: boolean
  tools: string[]
}

function renderJson(_args: unknown, value: unknown): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function adHocOcrCommand(value: unknown): boolean {
  if (!isRecord(value) || typeof value.command !== 'string') return false
  const commands = value.command.split(SHELL_META)
    .map(command => command.trimStart().replace(COMMAND_PREFIX, ''))
  if (commands.some(command => OCR_COMMAND_PROBE.test(command)
    || OCR_EXECUTABLE.test(command)
    || OCR_STACK_SETUP.test(command))) return true
  return SCRIPTED_OCR_MARKER.test(value.command)
    && commands.some(command => SCRIPTED_OCR_EXECUTABLE.test(command))
}

function isSkillArguments(value: unknown): boolean {
  return isRecord(value) && COMPUTER_USE_SKILL_NAMES.has(value.name as string)
}

function nativeSkillCall(raw: string): boolean {
  try { return isSkillArguments(JSON.parse(raw)) } catch { return false }
}

function containsSkillContent(blocks: readonly unknown[]): boolean {
  return blocks.some(block => isRecord(block)
    && block.type === 'text'
    && typeof block.text === 'string'
    && block.text.includes(COMPUTER_USE_SKILL_CONTENT))
}

function isSkillResult(value: unknown): boolean {
  return isRecord(value)
    && COMPUTER_USE_SKILL_NAMES.has(value.name as string)
    && value.content === COMPUTER_USE_SKILL_CONTENT
}

/** Code Mode 里一次 `run_code` 子派发的日志事件类型。 */
const DISPATCH_EVENT_TYPE = 'tool/code-dispatch'

/** 把日志事件收窄成 Code Mode 派发：`event.type` 是宽字符串，收窄点只在这里。 */
function isDispatchEvent(event: SessionEvent): event is Extract<SessionEvent, { type: typeof DISPATCH_EVENT_TYPE }> {
  return event.type === DISPATCH_EVENT_TYPE
}

/**
 * 会话日志是否已证明这个 agent 加载过本 Skill。
 *
 * 只认两类持久证据：技能工具注入的 `skill-invocation` 用户消息（标准模式），
 * 或 Code Mode 派发技能工具并返回同一份正文（PTC 模式）。日志被裁剪或改写后
 * 需要重新加载技能，工具也会因此重新变成未暴露状态。
 * @param session - 被检查的会话。
 * @returns 已加载时返回 true。
 */
export function hasLoadedComputerUseSkill(session: Session): boolean {
  const nativeCalls = new Set<string>()
  for (const event of session.events) {
    if (event.type === 'user/message') {
      const source = event.data.source
      if (source.kind === 'skill-invocation'
        && COMPUTER_USE_SKILL_NAMES.has(source.name)
        && containsSkillContent(event.data.content)) return true
      continue
    }
    if (event.type === 'tool/call') {
      if (event.data.name === 'skill' && nativeSkillCall(event.data.arguments)) nativeCalls.add(String(event.data.callId))
      continue
    }
    if (event.type === 'tool/result') {
      // `tool/result` 的正文是已由会话层收紧的 `ToolResultBlock`：类型字段恒为 tool-result，
      // 这里只比对调用 id 与正文，不再重复判断块类型。
      const [block] = event.data.message.content
      if (block.isError !== true
        && nativeCalls.has(String(block.toolCallId))
        && containsSkillContent(block.content)) return true
      continue
    }
    if (isDispatchEvent(event)
      && event.data.name === 'skill'
      && !event.data.isError
      && isSkillArguments(event.data.arguments)
      && containsSkillContent(event.data.content)) return true
  }
  return false
}

/** Owns one progressive Tool-exposure generation. */
export class ComputerUseExposure {
  readonly activationTool: ToolDefinition
  private readonly states = new Map<Agent, AgentExposure>()
  private installed = false

  constructor(
    private readonly ctx: Context,
    private readonly createTools: () => ToolDefinition[],
  ) {
    this.activationTool = defineTool({
      name: COMPUTER_USE_ACTIVATE,
      description: `Activate the macOS Computer Use execution tools for this Agent after loading the ${COMPUTER_USE_SKILL_NAME} Skill. The Skill tool normally activates them automatically; call this only after a direct Skill invocation when the tools are still absent. This bootstrap disappears after success.`,
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            activated: { type: 'boolean', required: true },
            tools: { type: 'array', items: { type: 'string' }, required: true },
          },
        },
        render: renderJson,
      },
      execute: (_args, exec): Promise<ComputerUseActivationResult> => {
        if (exec.agent === undefined) throw new Error(`${COMPUTER_USE_ACTIVATE}: an Agent Session is required`)
        if (!hasLoadedComputerUseSkill(exec.agent.session)) {
          throw new Error(`${COMPUTER_USE_ACTIVATE}: load the ${COMPUTER_USE_SKILL_NAME} Skill first`)
        }
        return Promise.resolve(this.activate(exec.agent))
      },
      presentCall: () => ({ card: 'generic', title: 'Activate Computer Use', kind: 'execute' }),
    })
  }

  /** Install lifecycle listeners and adopt existing Agents. */
  install(): () => void {
    if (this.installed) throw new Error('dsh-computer-use: progressive exposure is already installed')
    this.installed = true
    const effects = [
      this.ctx.on('agent/created', ({ agent }) => { this.attach(agent) }),
      this.ctx.on('agent/disposed', ({ agent }) => { this.detach(agent) }),
      this.ctx.tools.guard((exec) => {
        if (exec.name !== 'bash'
          || exec.agent === undefined
          || !hasLoadedComputerUseSkill(exec.agent.session)
          || !adHocOcrCommand(exec.arguments)
          || !VISION_TOOL_NAMES.some(name => this.ctx.tools.get(name, exec.agent) !== undefined)) return undefined
        return 'Computer Use screenshot analysis must use the installed Vision Toolkit instead of a shell-built OCR stack. If vision_glance is absent, call the skill tool with {"name":"vision-tools"}; then pass the existing screenshot Artifact path to vision_glance, vision_ground, vision_detect, vision_crop, or vision_long_screenshot_ocr.'
      }),
      this.ctx.on('tools/result', (exec, result) => {
        if (!result.isError
          && exec.name === 'skill'
          && exec.agent !== undefined
          && isSkillArguments(exec.arguments)
          && isSkillResult(result.value)) this.activate(exec.agent)
        return undefined
      }),
    ]
    try {
      for (const agent of this.ctx.agents.list()) this.attach(agent)
    } catch (error) {
      for (const dispose of effects.reverse()) dispose()
      this.disposeStates()
      this.installed = false
      throw error
    }
    return () => {
      if (!this.installed) return
      this.installed = false
      for (const dispose of effects.reverse()) dispose()
      this.disposeStates()
    }
  }

  private attach(agent: Agent): void {
    if (this.states.has(agent)) return
    this.states.set(agent, { active: false, toolDisposers: [], toolNames: [] })
    if (hasLoadedComputerUseSkill(agent.session)) this.activate(agent)
  }

  private activate(agent: Agent): ComputerUseActivationResult {
    this.attach(agent)
    const state = this.states.get(agent)
    if (state === undefined) throw new Error(`dsh-computer-use: Agent ${String(agent.id)} has no exposure state`)
    if (state.active) return { activated: false, tools: [...state.toolNames] }
    const definitions = this.createTools()
    const toolDisposers: Array<() => void> = []
    let hideActivation: (() => void) | undefined
    try {
      for (const definition of definitions) toolDisposers.push(agent.ctx.tools.register(definition))
      hideActivation = agent.ctx.tools.restrict({ deny: [COMPUTER_USE_ACTIVATE] })
    } catch (error) {
      hideActivation?.()
      for (const dispose of toolDisposers.reverse()) dispose()
      throw error
    }
    state.active = true
    state.hideActivation = hideActivation
    state.toolDisposers = toolDisposers
    state.toolNames = definitions.map(definition => definition.name)
    return { activated: true, tools: [...state.toolNames] }
  }

  private detach(agent: Agent): void {
    const state = this.states.get(agent)
    if (state === undefined) return
    this.states.delete(agent)
    this.disposeState(state)
  }

  private disposeStates(): void {
    for (const state of this.states.values()) this.disposeState(state)
    this.states.clear()
  }

  private disposeState(state: AgentExposure): void {
    state.hideActivation?.()
    for (const dispose of state.toolDisposers.reverse()) dispose()
  }
}
