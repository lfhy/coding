/** 面向模型的浏览器操作；调用会话的权限决定是否审批，页面、安全策略及资源生命周期属于提供方。 @module coding-tool-browser */

import type { Context } from '@deepseek-ai/cordis'
import type { BrowserCommand, BrowserExpectedTarget, BrowserObservation } from 'coding-browser'
import { BrowserUseError } from 'coding-browser'
import type { ImageAttachmentRef } from 'coding-attachment'
import type { ContentBlock } from 'coding-llm'
import { AttachmentId } from 'coding-attachment'
import { remoteWorkspacePath } from 'coding-subprocess'
import { defineTool } from 'coding-tools'
import type { ParameterSchemaSpec, ToolRunContext } from 'coding-tools'
import type {} from 'coding-user-approval'
import type {} from 'coding-sandbox-policy'

/** 插件名。 */
export const name = 'tool-browser'
/** 浏览器操作、提示词路由及持久截图所需服务；审批缺席时执行仍须明确拒绝。 */
export const inject = ['tools', 'browserUse', 'attachments', 'systemPrompt']

const MAX_SNAPSHOT_CHARS = 12_000
const MAX_TITLE_CHARS = 512
const MAX_URL_CHARS = 2_048
const MAX_GENERATION_CHARS = 128
const MAX_FILL_CHARS = 2_000
const MAX_APPROVAL_ORIGIN_CHARS = 256
const MAX_STALE_REASON_CHARS = 200
const STOPPED_NAVIGATION_DIAGNOSTIC = 'browser navigation timed out; loading stopped, take a new snapshot of the current page'

function validateNavigationUrl(raw: string): void {
  const invalid = 'browser_navigate: url must be a plain absolute HTTP(S) or local file:/// URL, not a Markdown link; pass only the address'
  let url: URL
  try { url = new URL(raw) } catch { throw new Error(invalid) }
  if (/^file:\/\/\/(?!\/)/i.test(raw) && url.protocol === 'file:' && url.hostname === ''
    && !/\\|%(?:2f|5c|00)/i.test(raw)) return
  const authority = raw.match(/^https?:\/\/([^/?#\\\s]+)(?:[/?#]|$)/i)?.[1]
  if (!authority || !['http:', 'https:'].includes(url.protocol)) throw new Error(invalid)
  if (authority.includes('@') || url.username || url.password) {
    throw new Error('browser_navigate: url must not contain username or password; pass an HTTP(S) address without credentials')
  }
}

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
  width?: number
  height?: number
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
    fill: ['ref', 'revision', 'text'], scroll: ['direction', 'pixels'], viewport: ['width', 'height'],
    screenshot: [], close: [],
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
      validateNavigationUrl(args.url)
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
    case 'viewport':
      if (!Number.isSafeInteger(args.width) || args.width === undefined || args.width < 200 || args.width > 1920 ||
        !Number.isSafeInteger(args.height) || args.height === undefined || args.height < 240 ||
        args.height > 1400 || args.width * args.height > 1_800_000) {
        throw new Error(`${toolName}: width (200..1920) and height (240..1400) are required, and width times height must not exceed 1800000`)
      }
      return { kind: 'viewport', width: args.width, height: args.height }
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
    // 最近观测只供审批提示；本地文件仅标明来源，不泄露路径和查询参数。
    if (parsed.protocol === 'file:' && parsed.hostname === '') return 'local file (path hidden)'
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
  if (command.kind === 'viewport') {
    return `Browser viewport ${command.width}x${command.height} (current origin: ${approvalOrigin(currentUrl) ?? 'unknown'}; approval is for this call only)`
  }
  const ref = command.kind === 'click' || command.kind === 'fill'
    ? ` ref ${/^[a-zA-Z0-9_-]{1,64}$/.test(command.ref) ? command.ref : '[opaque]'}`
    : ''
  return `Browser ${command.kind}${ref} (current origin: ${approvalOrigin(currentUrl) ?? 'unknown'}; approval is for this call only)`
}

/**
 * 提供方对过期引用的具体诊断（遮挡、禁用、移出视口、结构变化）。模型只有拿到原因才
 * 能决定是重拍快照、滚动，还是换目标；统一成一句「元素变了」会让它原地循环。
 * 仅用于点击与填写，且限长并去掉控制字符：文本可能夹带页面内容。
 * @param error 提供方拒绝的原因。
 * @returns 可拼接的原因前缀，空原因返回空串。
 */
function staleTargetReason(error: BrowserUseError): string {
  const reason = error.message.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return reason === '' ? '' : `${reason.slice(0, MAX_STALE_REASON_CHARS)}; `
}

function browserFailure(command: BrowserCommand, error: BrowserUseError): BrowserUseError {
  // 客户端以此固定句识别已安全停载的原生导航；只接受完全相等，避免透传提供方的 URL。
  if (command.kind === 'navigate' && error.code === 'BROWSER_FAILED' && error.message === STOPPED_NAVIGATION_DIAGNOSTIC) {
    return new BrowserUseError(STOPPED_NAVIGATION_DIAGNOSTIC, error.code, { cause: error })
  }
  const toolName = `browser_${command.kind}`
  let guidance: string
  switch (error.code) {
    case 'BROWSER_STALE_REF':
      if (command.kind === 'snapshot' && error.message.includes('document changed during observation')) {
        guidance = 'document changed during observation; try at most two fresh browser_snapshot calls. If both fail, reopen the last successfully observed HTTP(S) or local file:/// URL once with browser_navigate only when still relevant, then inspect its observation; stop if that fails. The last observed URL may not be the current URL'
      } else if (command.kind === 'click' || command.kind === 'fill') {
        const reason = staleTargetReason(error)
        guidance = reason === ''
          ? 'target or element changed; take a fresh browser_snapshot before acting. A click or fill may have taken effect: do not replay it without checking the new page'
          : `${reason}take a fresh browser_snapshot for the current state, or pick a different element. A click or fill may have taken effect: do not replay it without checking the new page`
      } else {
        guidance = 'target or element changed; take a fresh browser_snapshot before acting. A click or fill may have taken effect: do not replay it without checking the new page'
      }
      break
    case 'BROWSER_CLOSED':
      guidance = 'active browser tab is closed; browser_navigate can open a page only with a user-provided or previously observed HTTP(S) or local file:/// URL'
      break
    case 'BROWSER_BUSY':
      guidance = 'browser is busy; wait for the other operation, do not navigate to bypass it'
      break
    case 'BROWSER_DENIED':
      guidance = 'browser operation denied; do not retry or navigate to bypass the denial'
      break
    case 'BROWSER_UNAVAILABLE':
      guidance = 'browser unavailable; do not retry or navigate to bypass this failure'
      break
    case 'BROWSER_INVALID_URL':
      guidance = 'invalid navigation URL; provide a plain absolute HTTP(S) address without credentials or a local file:/// URL'
      break
    case 'BROWSER_FAILED':
      guidance = error.message.includes('navigation timed out; loading stopped')
        ? 'navigation timed out and loading stopped; take one fresh browser_snapshot before deciding whether another navigation is needed'
        : command.kind === 'viewport'
          ? 'the viewport change failed; keep width 200..1920 and height 240..1400 with an area of at most 1800000 pixels'
          : 'browser operation failed; do not replay a click or fill without checking whether it took effect'
      break
  }
  return new BrowserUseError(`${toolName}: ${error.code}: ${guidance}`, error.code, { cause: error })
}

/**
 * 注册七个动作工具和它们的系统提示词路由；仅全权限且关闭审批提示的会话免于一次性审批，审批服务缺席仍拒绝。
 * @param ctx - 持有浏览器服务、附件存储、工具注册表和系统提示词的上下文。
 * @returns 无返回值；注册随插件卸载撤销。
 */
export function apply(ctx: Context): void {
  // 跨调用路由属于系统提示词：模型最容易走错的替代方案是在 bash 里自建无头浏览器脚本，
  // 而八项工具的 schema 只在模型已决定调用浏览器后才生效。
  ctx.systemPrompt.section({
    name: 'tool:browser',
    order: 107,
    text: 'Use the browser tools, not a headless browser script run in bash, when a task needs a rendered page read, reproduced, verified, or driven, including your own app on localhost or a dev server.',
  })

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
  register('navigate', 'Open an absolute HTTP(S) or local file:/// URL. Load the browser-use skill first when available; inspect the returned observation before acting.', {
    url: { type: 'string', required: true, description: 'Plain absolute HTTP(S) address (https://example.com/) or local file:/// URL. Do not pass a Markdown link like [label](https://example.com/). No credentials or remote file hosts; at most 2048 characters.' },
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
  register('viewport', 'Change the CSS viewport of the session browser, for example 390x844 to check a phone layout, then take browser_screenshot to see how the page renders. Refs and earlier screenshots go stale; the returned observation is fresh.', {
    width: { type: 'integer', required: true, description: 'CSS viewport width in pixels, 200..1920; width times height must not exceed 1800000.' },
    height: { type: 'integer', required: true, description: 'CSS viewport height in pixels, 240..1400.' },
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
  let release: (() => void) | undefined
  try {
    release = await ctx.browserUse.acquireOperation(sessionId, exec.signal)
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
  } catch (error) {
    if (error instanceof BrowserUseError) throw browserFailure(command, error)
    throw error
  } finally { release?.() }
}
