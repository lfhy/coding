/** 将宿主提供的会话浏览器工具登记给模型，逐次执行会话审批与本机文件边界。 @module coding-tool-browser-ego */

import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from 'coding-llm'
import type { Session } from 'coding-session'
import { remoteWorkspacePath } from 'coding-subprocess'
import type { ToolDefinition, ToolRunContext } from 'coding-tools'
import type { ApprovalService } from 'coding-user-approval'
import type {} from 'coding-browser-ego-host'
import type {} from 'coding-attachment'
import type {} from 'coding-sandbox-policy'
import type {} from 'coding-user-approval'
import { newWorkspacePath, screenshotPath, uploadPath } from './paths.ts'

/** 插件名称。 */
export const name = 'tool-browser-ego'
/** 宿主只提供受支持的上游定义；审批与附件单独由消费方负责。 */
export const inject = ['tools', 'egoBrowser', 'attachments']

const MAX_RESULT_BYTES = 64 * 1024
const MAX_SCREENSHOT_BYTES = 100 * 1024 * 1024
const MAX_REASON_ORIGIN = 256
// 仅注册已逐项审计的非脚本工具；宿主的白名单仍是另一道独立限制。
const ALLOWED_TOOLS = new Set([
  'ego_snapshot', 'ego_navigate', 'ego_click', 'ego_fill', 'ego_screenshot', 'ego_page_info',
  'ego_tabs', 'ego_wait', 'ego_wait_for_selector', 'ego_wait_for_url', 'ego_wait_for_response',
  'ego_key', 'ego_hover', 'ego_read_element', 'ego_select', 'ego_drag', 'ego_scroll',
  'ego_upload', 'ego_download', 'ego_check', 'ego_dialog', 'ego_captcha', 'ego_wait_for_human',
])

function modelName(upstream: string): string {
  if (!/^ego_[a-z][a-z0-9_]*$/.test(upstream)) throw new Error('browser tool definition has an invalid name')
  return `browser_${upstream.slice(4)}`
}

/** schema 只改注解文字，不动参数结构和输出约束；不把上游说明里的旧工具名暴露给模型。 */
function renameDescription<T>(schema: T): T {
  if (Array.isArray(schema)) return schema.map(renameDescription) as T
  if (schema === null || typeof schema !== 'object') return schema
  return Object.fromEntries(Object.entries(schema).map(([key, value]) => [
    key,
    key === 'description' && typeof value === 'string' ? value.replaceAll('ego_', 'browser_') : renameDescription(value),
  ])) as T
}

function origin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) return 'unknown'
  try {
    const url = new URL(value)
    if (url.protocol === 'file:') return 'local file (path hidden)'
    if (['http:', 'https:'].includes(url.protocol) && url.origin.length <= MAX_REASON_ORIGIN && !url.username && !url.password) {
      return url.origin
    }
  } catch { /* 非 URL 的参数不应出现在审批理由或审计中。 */ }
  return 'unknown'
}

function reason(name: string, args: Record<string, unknown>): string {
  const target = origin(args.url)
  return `Browser ${name.slice('browser_'.length)} (origin: ${target}; this call only)`
}

function policyOf(approval: ApprovalService, session: Session): 'ask' | 'never' {
  return approval.overrideOf(session) ?? approval.config.policy ?? 'ask'
}

function inputRecord(input: unknown, name: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error(`${name}: parameters must be an object`)
  }
  return input as Record<string, unknown>
}

function requireWebUrl(value: unknown, name: string): void {
  if (typeof value !== 'string' || value.length > 2048 || /[\\\u0000-\u0020\u007f]/.test(value)) {
    throw new Error(`${name}: provide a plain HTTP(S) URL without credentials`)
  }
  try {
    const parsed = new URL(value)
    if (['http:', 'https:'].includes(parsed.protocol) && parsed.hostname && !parsed.username && !parsed.password
      && !value.match(/^https?:\/\/[^/?#]*@/i)) return
  } catch { /* 输入只能是明确的绝对网页地址。 */ }
  throw new Error(`${name}: provide a plain HTTP(S) URL without credentials`)
}

async function checkedArguments(name: string, input: unknown, cwd: string | undefined, signal: AbortSignal,
  mode: string | undefined): Promise<{ args: Record<string, unknown>; screenshotFile?: string }> {
  const args = inputRecord(input, name)
  // 仅复制用于转发的路径字段；源参数对象由工具注册表冻结，不能就地修改。
  const prepared = { ...args }
  if (name === 'browser_navigate') requireWebUrl(args.url, name)
  if (name === 'browser_tabs' && args.action === 'open') {
    if (args.url !== undefined && args.url !== '') requireWebUrl(args.url, name)
  }
  if (name === 'browser_download') {
    if (args.triggerScript !== undefined && args.triggerScript !== '' && mode !== 'danger-full-access') {
      throw new Error(`${name}: page scripts require full access and a single approval`)
    }
    const path = args.savePath === undefined ? join(cwd ?? '', `.browser-download-${randomUUID()}`) : args.savePath
    prepared.savePath = await newWorkspacePath(cwd, path, name, signal)
  }
  if (name === 'browser_upload') prepared.path = await uploadPath(cwd, args.path, signal)
  if (name === 'browser_screenshot') {
    const path = args.path === undefined
      ? join(cwd ?? '', `.browser-screenshot-${randomUUID()}.png`)
      : args.path
    prepared.path = await newWorkspacePath(cwd, path, name, signal)
    // 截图由本消费方准入并持久化，不由上游附带未校验的文件产物。
    return { args: prepared, screenshotFile: prepared.path as string }
  }
  return { args: prepared }
}

async function checkLocal(cwd: string | undefined, signal: AbortSignal, name: string): Promise<void> {
  signal.throwIfAborted()
  if (cwd !== undefined && await remoteWorkspacePath('.', cwd, signal) !== undefined) {
    throw new Error(`${name}: remote workspaces do not support local browser operations`)
  }
  signal.throwIfAborted()
}

function bounded(value: unknown, name: string): void {
  // 整体 JSON 字节上限在输出 schema 校验前判断；不可截断字段，否则破坏上游结果与协议。
  let serialized: unknown
  try { serialized = JSON.stringify(value) } catch {
    throw new Error(`${name}: browser result is not valid JSON`)
  }
  if (typeof serialized !== 'string') throw new Error(`${name}: browser result is not valid JSON`)
  if (Buffer.byteLength(serialized) > MAX_RESULT_BYTES) {
    throw new Error(`${name}: browser result is too large; request a narrower observation`)
  }
}

async function persistScreenshot(ctx: Context, value: unknown, expected: string, signal: AbortSignal): Promise<ContentBlock> {
  const path = await screenshotPath(expected, inputRecord(value, 'browser_screenshot').path, signal)
  const info = await stat(path)
  if (info.size > MAX_SCREENSHOT_BYTES) throw new Error('browser_screenshot: image exceeds the attachment size limit')
  signal.throwIfAborted()
  const data = await readFile(path)
  signal.throwIfAborted()
  const attachment = await ctx.attachments.saveImage({ data, mediaType: 'image/png', name: 'browser-screenshot.png' })
  return { type: 'image', attachment }
}

async function run(ctx: Context, source: ToolDefinition, name: string, input: unknown, exec: ToolRunContext,
  imageForPath: Map<string, ContentBlock>): Promise<unknown> {
  const agent = exec.agent
  if (agent === undefined) throw new Error(`${name}: calling agent is required`)
  const cwd = agent.session.header.cwd
  await checkLocal(cwd, exec.signal, name)
  const approval = ctx.get('approval')
  if (approval === undefined) throw new Error(`${name}: approval service is unavailable`)
  const mode = ctx.get('sandboxPolicy')?.resolve({ session: agent.session }).mode
  const args = inputRecord(input, name)
  const hasScript = name === 'browser_download' && args.triggerScript !== undefined && args.triggerScript !== ''
  if (hasScript && mode !== 'danger-full-access') {
    throw new Error(`${name}: page scripts require full access and a single approval`)
  }
  // 文件写入必须在会话允许的工作区内；只读会话不能靠一次审批绕过文件策略。
  if ((name === 'browser_screenshot' || name === 'browser_download') && mode === 'read-only') {
    throw new Error(`${name}: saving files requires a full-access session`)
  }
  if (name === 'browser_download' && args.savePath === undefined && mode !== 'danger-full-access') {
    throw new Error(`${name}: downloads require an explicit workspace savePath in this session`)
  }
  if (hasScript && policyOf(approval, agent.session) === 'never') {
    throw new Error(`${name}: page scripts require a single approval`)
  }
  const checked = await checkedArguments(name, args, cwd, exec.signal, mode)
  const policy = policyOf(approval, agent.session)
  const noPrompt = mode === 'danger-full-access' && policy === 'never' && !hasScript
  if (!noPrompt) {
    const outcome = await approval.request({ agent, toolName: name, callId: exec.callId,
      reason: reason(name, args), signal: exec.signal })
    exec.signal.throwIfAborted()
    if (outcome !== 'allowed-once') throw new Error(`${name}: approval ${outcome}`)
  }
  await checkLocal(cwd, exec.signal, name)
  // 审批期间文件或策略可能变化；路径在调用前再次按会话根校验。
  const liveMode = ctx.get('sandboxPolicy')?.resolve({ session: agent.session }).mode
  if (liveMode !== mode || policyOf(approval, agent.session) !== policy) {
    throw new Error(`${name}: session permissions changed while awaiting approval`)
  }
  const ready = await checkedArguments(name, checked.args, cwd, exec.signal, mode)
  if (name === 'browser_upload' && ready.args.path !== checked.args.path) {
    throw new Error(`${name}: file changed while awaiting approval`)
  }
  if (ready.screenshotFile !== checked.screenshotFile || ready.args.savePath !== checked.args.savePath) {
    throw new Error(`${name}: output path changed while awaiting approval`)
  }
  await checkLocal(cwd, exec.signal, name)
  let value: unknown
  try { value = await source.execute(ready.args, exec) } catch {
    exec.signal.throwIfAborted()
    throw new Error(`${name}: browser operation failed; inspect the current page before retrying`)
  }
  bounded(value, name)
  if (name === 'browser_download') {
    const reported = inputRecord(value, name).path
    if (reported !== ready.args.savePath) throw new Error(`${name}: unexpected downloaded file path`)
  }
  if (ready.screenshotFile !== undefined) {
    const image = await persistScreenshot(ctx, value, ready.screenshotFile, exec.signal)
    // 输出 JSON 原封不动，图像按本次专有路径绑定到随后同步执行的渲染。
    imageForPath.set(ready.screenshotFile, image)
  }
  return value
}

/**
 * 注册宿主实际允许的工具；服务只提供定义，不在宿主注册模型工具。
 * @param ctx 拥有工具、宿主、审批与持久附件服务的 Cordis 上下文。
 * @returns 无返回值；注册项随插件卸载撤销。
 */
export function apply(ctx: Context): void {
  const imageForPath = new Map<string, ContentBlock>()
  for (const source of ctx.egoBrowser.toolDefinitions()) {
    if (!ALLOWED_TOOLS.has(source.name)) continue
    const visibleName = modelName(source.name)
    const parameterSchema = renameDescription(source.parameters)
    ctx.tools.register({
      ...source,
      name: visibleName,
      description: source.description.replaceAll('ego_', 'browser_'),
      parameters: parameterSchema,
      output: {
        ...source.output,
        render(args, value): ContentBlock[] {
          const file = visibleName === 'browser_screenshot' && value !== null && typeof value === 'object'
            ? (value as { path?: unknown }).path : undefined
          const image = typeof file === 'string' ? imageForPath.get(file) : undefined
          if (typeof file === 'string') imageForPath.delete(file)
          const blocks = source.output.render(args, value)
          if (image && typeof file === 'string') {
            return [...blocks, image]
          }
          return blocks
        },
      },
      execute: (args, exec) => run(ctx, source, visibleName, args, exec, imageForPath),
    })
  }
}
