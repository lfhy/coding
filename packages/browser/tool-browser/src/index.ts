/** 面向模型的浏览器操作；调用会话的权限决定是否审批，页面、安全策略及资源生命周期属于提供方。 @module @deepseek-ai/dsh-tool-browser */

import type { Context } from '@deepseek-ai/cordis'
import type { BrowserCommand, BrowserExpectedTarget, BrowserObservation } from '@deepseek-ai/dsh-browser'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { remoteWorkspacePath } from '@deepseek-ai/dsh-subprocess'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-sandbox-policy'

/** 插件名。 */
export const name = 'tool-browser'
/** 浏览器操作及持久截图所需服务；审批缺席时执行仍须明确拒绝。 */
export const inject = ['tools', 'browserUse', 'attachments']

const MAX_SNAPSHOT_CHARS = 12_000
const MAX_TITLE_CHARS = 512
const MAX_URL_CHARS = 2_048
const MAX_GENERATION_CHARS = 128
const MAX_FILL_CHARS = 2_000
const MAX_APPROVAL_ORIGIN_CHARS = 256

/** 工具成功后的规范 JSON；截图引用在结果提交前已持久保存。 */
export interface BrowserUseValue {
  action: BrowserCommand['kind']
  observation: BrowserObservation
  image: {
    attachmentId: string
    mediaType: 'image/png'
    bytes: number
    width: number
    height: number
    name?: string
  } | null
}

interface BrowserArgs {
  action: BrowserCommand['kind']
  url?: string
  ref?: string
  revision?: number
  text?: string
  direction?: 'up' | 'down'
  pixels?: number
}

/**
 * 校验各操作字段并转换为服务命令；调用方不能透传选择器、脚本或多余字段。
 * @param args - 经工具参数 schema 校验的原始参数。
 * @returns 与 action 完全对应的服务命令。
 */
export function parseBrowserCommand(args: BrowserArgs): BrowserCommand {
  const allowed: Record<BrowserCommand['kind'], readonly (keyof BrowserArgs)[]> = {
    navigate: ['action', 'url'], snapshot: ['action'], click: ['action', 'ref', 'revision'],
    fill: ['action', 'ref', 'revision', 'text'], scroll: ['action', 'direction', 'pixels'],
    screenshot: ['action'], close: ['action'],
  }
  if (Object.keys(args).some(key => !allowed[args.action].includes(key as keyof BrowserArgs))) {
    throw new Error(`browser_use: unexpected field for ${args.action}`)
  }
  switch (args.action) {
    case 'navigate':
      if (args.url === undefined || args.url.trim().length === 0) throw new Error('browser_use: url must be non-empty')
      if (args.url.length > MAX_URL_CHARS) throw new Error(`browser_use: url exceeds ${MAX_URL_CHARS} characters`)
      return { kind: 'navigate', url: args.url }
    case 'click':
    case 'fill': {
      if (args.ref === undefined || args.ref.trim().length === 0) throw new Error('browser_use: ref must be non-empty')
      if (args.ref.length > 256) throw new Error('browser_use: ref exceeds 256 characters')
      if (!Number.isSafeInteger(args.revision) || args.revision === undefined || args.revision < 1) {
        throw new Error('browser_use: revision must be a positive integer')
      }
      if (args.action === 'click') return { kind: 'click', ref: args.ref, revision: args.revision }
      if (args.text === undefined || args.text.length > MAX_FILL_CHARS) {
        throw new Error(`browser_use: text is required and must not exceed ${MAX_FILL_CHARS} characters`)
      }
      return { kind: 'fill', ref: args.ref, revision: args.revision, text: args.text }
    }
    case 'scroll':
      if (args.direction === undefined || !Number.isSafeInteger(args.pixels)
        || args.pixels === undefined || args.pixels < 1 || args.pixels > 2_000) {
        throw new Error('browser_use: direction and pixels (1..2000) are required')
      }
      return { kind: 'scroll', direction: args.direction, pixels: args.pixels }
    case 'snapshot': return { kind: 'snapshot' }
    case 'screenshot': return { kind: 'screenshot' }
    case 'close': return { kind: 'close' }
  }
}

function boundedObservation(observation: BrowserObservation): BrowserObservation {
  return {
    tabId: observation.tabId,
    generation: observation.generation.slice(0, MAX_GENERATION_CHARS),
    revision: observation.revision,
    url: observation.url.slice(0, MAX_URL_CHARS),
    title: observation.title.slice(0, MAX_TITLE_CHARS),
    snapshot: observation.snapshot.slice(0, MAX_SNAPSHOT_CHARS),
    viewport: observation.viewport,
    cursor: observation.cursor,
  }
}

function imageRef(image: NonNullable<BrowserUseValue['image']>): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(image.attachmentId), mediaType: image.mediaType,
    bytes: image.bytes, width: image.width, height: image.height,
    ...image.name === undefined ? {} : { name: image.name },
  }
}

function renderBrowserResult(value: Pick<BrowserUseValue, 'action' | 'image'> & { observation: { tabId: string } }): ContentBlock[] {
  const text = JSON.stringify({ action: value.action, observation: value.observation, image: value.image })
  if (value.action !== 'screenshot' || value.image === null) return [{ type: 'text', text }]
  return [{ type: 'text', text }, { type: 'image', attachment: imageRef(value.image) }]
}

function approvalOrigin(url: string | undefined): string | undefined {
  if (url === undefined || url.length > MAX_URL_CHARS) return undefined
  try {
    const parsed = new URL(url)
    // 最近观测只供审批提示；不展示可能包含凭据或页面数据的其余 URL 部分。
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin.length > MAX_APPROVAL_ORIGIN_CHARS) return undefined
    return parsed.origin
  } catch {
    return undefined
  }
}

function approvalReason(command: BrowserCommand, currentUrl: string | undefined): string {
  if (command.kind === 'navigate') {
    return `Browser navigate (target origin: ${approvalOrigin(command.url) ?? 'invalid target'}; may redirect or load subresources; approval is for this call only)`
  }
  const ref = command.kind === 'click' || command.kind === 'fill'
    ? ` ref ${/^[a-zA-Z0-9_-]{1,64}$/.test(command.ref) ? command.ref : '[opaque]'}`
    : ''
  return `Browser ${command.kind}${ref} (current origin: ${approvalOrigin(currentUrl) ?? 'unknown'}; approval is for this call only)`
}

/**
 * 注册单一 browser_use 工具；仅全权限且关闭审批提示的会话免于一次性审批，审批服务缺席仍拒绝。
 * @param ctx - 持有浏览器服务、附件存储和工具注册表的上下文。
 * @returns 无返回值；工具注册随插件卸载撤销。
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'browser_use',
    description: 'Use a session browser to navigate, inspect accessible elements, interact by observed ref and revision, scroll, capture a screenshot, or close. Calls require approval except in full-access mode with approval prompts disabled. No selectors or scripts.',
    parameters: {
      action: { type: 'string', enum: ['navigate', 'snapshot', 'click', 'fill', 'scroll', 'screenshot', 'close'], required: true, description: 'One browser operation.' },
      url: { type: 'string', description: 'URL for navigate.' },
      ref: { type: 'string', description: 'Opaque element ref from the latest observation for click or fill.' },
      revision: { type: 'integer', description: 'Positive observation revision paired with ref.' },
      text: { type: 'string', description: 'Text for fill, at most 2000 characters.' },
      direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction.' },
      pixels: { type: 'integer', description: 'Scroll distance, 1..2000 pixels.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['navigate', 'snapshot', 'click', 'fill', 'scroll', 'screenshot', 'close'], required: true },
          observation: { type: 'object', required: true, additionalProperties: false, properties: {
            tabId: { type: 'string', required: true },
            generation: { type: 'string', required: true }, revision: { type: 'integer', required: true },
            url: { type: 'string', required: true }, title: { type: 'string', required: true },
            snapshot: { type: 'string', required: true },
            viewport: { type: 'object', required: true, additionalProperties: false, properties: {
              width: { type: 'integer', required: true }, height: { type: 'integer', required: true },
            } },
            cursor: { oneOf: [
              { type: 'null' },
              { type: 'object', additionalProperties: false, properties: {
                x: { type: 'number', required: true }, y: { type: 'number', required: true },
                kind: { type: 'string', enum: ['click', 'fill', 'scroll'], required: true },
                at: { type: 'number', required: true },
              } },
            ], required: true },
          } },
          image: { oneOf: [
            { type: 'null' },
            { type: 'object', additionalProperties: false, properties: {
              attachmentId: { type: 'string', required: true }, mediaType: { type: 'string', const: 'image/png', required: true },
              bytes: { type: 'integer', required: true }, width: { type: 'integer', required: true },
              height: { type: 'integer', required: true }, name: { type: 'string' },
            } },
          ], required: true },
        },
      },
      render: (_args, value) => renderBrowserResult(value),
    },
    async execute(args, exec): Promise<BrowserUseValue> {
      const command = parseBrowserCommand(args)
      const agent = exec.agent
      if (agent === undefined) throw new Error('browser_use: calling agent is required')
      const cwd = agent.session.header.cwd
      if (cwd !== undefined && await remoteWorkspacePath('.', cwd, exec.signal) !== undefined) {
        throw new Error('browser_use: remote workspaces do not support browser operations')
      }
      exec.signal.throwIfAborted()
      const approval = ctx.get('approval')
      if (approval === undefined) throw new Error('browser_use: approval service is unavailable')
      const sessionId = agent.session.id
      const state = ctx.browserUse.state(sessionId)
      let expectedTarget: BrowserExpectedTarget
      if (state === undefined) {
        if (command.kind !== 'navigate') {
          throw new Error('browser_use: browser session is closed; navigate to open a page')
        }
        expectedTarget = { kind: 'none' }
      } else {
        const active = state.tabs.find(tab => tab.id === state.activeTabId)
        if (active === undefined) throw new Error('browser_use: active tab is unavailable')
        expectedTarget = { kind: 'tab', browserGeneration: state.browserGeneration, stateRevision: state.stateRevision,
          tabId: active.id, generation: active.generation, url: active.url }
      }
      const sandboxPolicy = ctx.get('sandboxPolicy')
      const fullAccess = sandboxPolicy?.resolve({ session: agent.session }).mode === 'danger-full-access'
        && (approval.overrideOf(agent.session) ?? approval.config.policy ?? 'ask') === 'never'
      if (!fullAccess) {
        const currentUrl = command.kind === 'navigate' || expectedTarget.kind === 'none' ? undefined : expectedTarget.url
        const outcome = await approval.request({
          agent, toolName: 'browser_use', callId: exec.callId,
          reason: approvalReason(command, currentUrl),
          signal: exec.signal,
        })
        exec.signal.throwIfAborted()
        if (outcome !== 'allowed-once') throw new Error(`browser_use: approval ${outcome}`)
      }
      exec.signal.throwIfAborted()
      const capture = await ctx.browserUse.execute(sessionId, command, exec.signal, expectedTarget)
      let image: BrowserUseValue['image'] = null
      if (command.kind === 'screenshot') {
        if (capture.png === null) throw new Error('browser_use: screenshot produced no PNG')
        const ref = await ctx.attachments.saveImage({ data: capture.png, mediaType: 'image/png', name: 'browser-screenshot.png' })
        image = {
          attachmentId: ref.attachmentId, mediaType: 'image/png', bytes: ref.bytes,
          width: ref.width, height: ref.height,
          ...ref.name === undefined ? {} : { name: ref.name },
        }
      }
      return { action: command.kind, observation: boundedObservation(capture.observation), image }
    },
  }))
}
