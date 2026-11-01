/** 将宿主提供的会话浏览器工具登记给模型，逐次执行会话审批与本机文件边界。 @module coding-tool-browser-ego */

import { readFile, stat } from 'node:fs/promises'
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

/** 插件名称。 */
export const name = 'tool-browser-ego'
/** 宿主只提供受支持的上游定义；审批与附件单独由消费方负责。 */
export const inject = ['tools', 'egoBrowser', 'attachments']

const MAX_RESULT_BYTES = 64 * 1024
const MAX_SCREENSHOT_BYTES = 100 * 1024 * 1024
const MAX_REASON_ORIGIN = 256
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

function bounded(value: unknown, name: string): void {
  let serialized: unknown
  try { serialized = JSON.stringify(value) } catch { throw new Error(`${name}: browser result is not valid JSON`) }
  if (typeof serialized !== 'string') throw new Error(`${name}: browser result is not valid JSON`)
  if (Buffer.byteLength(serialized) > MAX_RESULT_BYTES) {
    throw new Error(`${name}: browser result is too large; request a narrower observation`)
  }
}

/** 远程工作区没有本机浏览器；在审批前后都拒绝，避免策略变化时落到本机。 */
async function checkLocal(cwd: string | undefined, signal: AbortSignal, name: string): Promise<void> {
  signal.throwIfAborted()
  if (cwd !== undefined && await remoteWorkspacePath('.', cwd, signal) !== undefined) {
    throw new Error(`${name}: remote workspaces do not support local browser operations`)
  }
  signal.throwIfAborted()
}

/** 只把本次截图读取为模型图片；路径与大小由上游与附件服务各自校验。 */
async function persistScreenshot(ctx: Context, value: unknown, signal: AbortSignal): Promise<ContentBlock | null> {
  if (value === null || typeof value !== 'object') return null
  const path = (value as { path?: unknown }).path
  if (typeof path !== 'string') return null
  signal.throwIfAborted()
  let info
  try { info = await stat(path) } catch { return null }
  if (!info.isFile() || info.size > MAX_SCREENSHOT_BYTES) return null
  let data: Buffer
  try { data = await readFile(path) } catch { return null }
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
  const args = (input !== null && typeof input === 'object' && !Array.isArray(input)) ? input as Record<string, unknown> : {}
  const policy = policyOf(approval, agent.session)
  const mode = ctx.get('sandboxPolicy')?.resolve({ session: agent.session }).mode
  if (!(mode === 'danger-full-access' && policy === 'never')) {
    const outcome = await approval.request({ agent, toolName: name, callId: exec.callId,
      reason: reason(name, args), signal: exec.signal })
    exec.signal.throwIfAborted()
    if (outcome !== 'allowed-once') throw new Error(`${name}: approval ${outcome}`)
  }
  await checkLocal(cwd, exec.signal, name)
  const liveMode = ctx.get('sandboxPolicy')?.resolve({ session: agent.session }).mode
  if (liveMode !== mode || policyOf(approval, agent.session) !== policy) {
    throw new Error(`${name}: session permissions changed while awaiting approval`)
  }
  let value: unknown
  try { value = await source.execute(args, exec) } catch {
    exec.signal.throwIfAborted()
    throw new Error(`${name}: browser operation failed; inspect the current page before retrying`)
  }
  bounded(value, name)
  if (name === 'browser_screenshot') {
    const image = await persistScreenshot(ctx, value, exec.signal)
    const path = value !== null && typeof value === 'object' ? (value as { path?: unknown }).path : undefined
    if (image !== null && typeof path === 'string') imageForPath.set(path, image)
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
