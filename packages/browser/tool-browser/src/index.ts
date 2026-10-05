/** 面向模型的浏览器操作；调用会话的权限决定是否审批，页面、安全策略及资源生命周期属于提供方。 @module @deepseek-ai/dsh-tool-browser */

import type { Context } from '@deepseek-ai/cordis'
import type { BrowserCommand, BrowserExpectedTarget, BrowserObservation } from '@deepseek-ai/dsh-browser'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { remoteWorkspacePath } from '@deepseek-ai/dsh-subprocess'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ParameterSchemaSpec, ToolRunContext } from '@deepseek-ai/dsh-tools'
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
  url?: string
  ref?: string
  revision?: number
  text?: string
  direction?: 'up' | 'down'
  pixels?: number
}

/**
 * 校验各操作字段并转换为服务命令；调用方不能透传选择器、脚本或多余字段。
 * @param action - 调用的公开工具所固定的动作。
 * @param args - 经该工具参数 schema 校验的原始参数。
 * @returns 与工具动作完全对应的服务命令。
 */
export function parseBrowserCommand(action: BrowserCommand['kind'], args: BrowserArgs): BrowserCommand {
  const allowed: Record<BrowserCommand['kind'], readonly (keyof BrowserArgs)[]> = {
    navigate: ['url'], snapshot: [], click: ['ref', 'revision'],
    fill: ['ref', 'revision', 'text'], scroll: ['direction', 'pixels'], screenshot: [], close: [],
  }
  const toolName = `browser_${action}`
  const unexpected = Object.keys(args).filter(key => !allowed[action].includes(key as keyof BrowserArgs))
  if (unexpected.length > 0) {
    const fields = allowed[action].length === 0 ? 'no parameters' : `only ${allowed[action].join(', ')} allowed`
    throw new Error(`${toolName}: unexpected field: ${unexpected.join(', ')}; ${fields}`)
  }
  switch (action) {
    case 'navigate':
      if (args.url === undefined || args.url.trim().length === 0) throw new Error(`${toolName}: url must be non-empty`)
      if (args.url.length > MAX_URL_CHARS) throw new Error(`${toolName}: url exceeds ${MAX_URL_CHARS} characters`)
      return { kind: 'navigate', url: args.url }
    case 'click':
    case 'fill': {
      if (args.ref === undefined || args.ref.trim().length === 0) throw new Error(`${toolName}: ref must be non-empty`)
      if (args.ref.length > 256) throw new Error(`${toolName}: ref exceeds 256 characters`)
      if (!Number.isSafeInteger(args.revision) || args.revision === undefined || args.revision < 1) {
        throw new Error(`${toolName}: revision must be a positive integer`)
      }
      if (action === 'click') return { kind: 'click', ref: args.ref, revision: args.revision }
      if (args.text === undefined || args.text.length > MAX_FILL_CHARS) {
        throw new Error(`${toolName}: text is required and must not exceed ${MAX_FILL_CHARS} characters`)
      }
      return { kind: 'fill', ref: args.ref, revision: args.revision, text: args.text }
    }
    case 'scroll':
      if (args.direction === undefined || !Number.isSafeInteger(args.pixels)
        || args.pixels === undefined || args.pixels < 1 || args.pixels > 2_000) {
        throw new Error(`${toolName}: direction and pixels (1..2000) are required`)
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
 * 注册七个动作工具；仅全权限且关闭审批提示的会话免于一次性审批，审批服务缺席仍拒绝。
 * @param ctx - 持有浏览器服务、附件存储和工具注册表的上下文。
 * @returns 无返回值；工具注册随插件卸载撤销。
 */
export function apply(ctx: Context): void {
  function register(action: BrowserCommand['kind'], description: string, parameters: ParameterSchemaSpec): void {
    ctx.tools.register(defineTool({
      name: `browser_${action}`, description, parameters,
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            action: { type: 'string', const: action, required: true },
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
      execute(args, exec): Promise<BrowserUseValue> {
        return executeBrowserCommand(ctx, parseBrowserCommand(action, args as BrowserArgs), exec)
      },
    }))
  }
  const ref = { type: 'string', required: true, description: 'Opaque ref from the current observation, not a selector.' } as const
  const revision = { type: 'integer', required: true, description: 'Positive revision paired with the current observation ref.' } as const
  register('navigate', 'Open an absolute HTTP(S) URL. Load the browser-use skill first when available; inspect the returned observation before acting.', {
    url: { type: 'string', required: true, description: 'Absolute HTTP(S) URL without credentials, at most 2048 characters.' },
  })
  register('snapshot', 'Read the current page. Load the browser-use skill first when available; use an observed ref and revision for browser_click or browser_fill.', {})
  register('click', 'Click an element using its ref and revision from the current browser observation; never use selectors.', {
    ref, revision,
  })
  register('fill', 'Fill an element using its ref and revision from the current browser observation; never use selectors.', {
    ref, revision, text: { type: 'string', required: true, description: 'Text to enter, at most 2000 characters.' },
  })
  register('scroll', 'Scroll the active page, then return a fresh observation with refs and revision.', {
    direction: { type: 'string', enum: ['up', 'down'], required: true, description: 'Scroll direction.' },
    pixels: { type: 'integer', required: true, description: 'Requested wheel delta, 1..2000 pixels; capped at one viewport height per call.' },
  })
  register('screenshot', 'Capture and persist a PNG of the active page; also return its current observation.', {})
  register('close', 'Close the session browser only when requested; the returned observation is no longer a live page.', {})
}

async function executeBrowserCommand(ctx: Context, command: BrowserCommand, exec: ToolRunContext): Promise<BrowserUseValue> {
  const toolName = `browser_${command.kind}`
  const agent = exec.agent
  if (agent === undefined) throw new Error(`${toolName}: calling agent is required`)
  const cwd = agent.session.header.cwd
  if (cwd !== undefined && await remoteWorkspacePath('.', cwd, exec.signal) !== undefined) {
    throw new Error(`${toolName}: remote workspaces do not support browser operations`)
  }
  exec.signal.throwIfAborted()
  const approval = ctx.get('approval')
  if (approval === undefined) throw new Error(`${toolName}: approval service is unavailable`)
  const sessionId = agent.session.id
  const release = await ctx.browserUse.acquireOperation(sessionId, exec.signal)
  try {
    const expectedTarget: BrowserExpectedTarget = await ctx.browserUse.prepareTarget(sessionId, exec.signal)
    if (expectedTarget.kind === 'none' && command.kind !== 'navigate') {
      throw new Error(`${toolName}: browser session is closed; use browser_navigate to open a page`)
    }
    const sandboxPolicy = ctx.get('sandboxPolicy')
    const fullAccess = sandboxPolicy?.resolve({ session: agent.session }).mode === 'danger-full-access'
          && (approval.overrideOf(agent.session) ?? approval.config.policy ?? 'ask') === 'never'
    if (!fullAccess) {
      const currentUrl = command.kind === 'navigate' || expectedTarget.kind === 'none' ? undefined : expectedTarget.url
      const outcome = await approval.request({
        agent, toolName, callId: exec.callId,
        reason: approvalReason(command, currentUrl),
        signal: exec.signal,
      })
      exec.signal.throwIfAborted()
      if (outcome !== 'allowed-once') throw new Error(`${toolName}: approval ${outcome}`)
    }
    exec.signal.throwIfAborted()
    if (cwd !== undefined && await remoteWorkspacePath('.', cwd, exec.signal) !== undefined) {
      throw new Error(`${toolName}: remote workspaces do not support browser operations`)
    }
    exec.signal.throwIfAborted()
    const capture = await ctx.browserUse.execute(sessionId, command, exec.signal, expectedTarget)
    let image: BrowserUseValue['image'] = null
    if (command.kind === 'screenshot') {
      if (capture.png === null) throw new Error(`${toolName}: screenshot produced no PNG`)
      const ref = await ctx.attachments.saveImage({ data: capture.png, mediaType: 'image/png', name: 'browser-screenshot.png' })
      image = {
        attachmentId: ref.attachmentId, mediaType: 'image/png', bytes: ref.bytes,
        width: ref.width, height: ref.height,
        ...ref.name === undefined ? {} : { name: ref.name },
      }
    }
    return { action: command.kind, observation: boundedObservation(capture.observation), image }
  } finally { release() }
}
