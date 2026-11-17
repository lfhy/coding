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
import { newScreenshotPath, newWorkspacePath, screenshotPath, uploadPath } from './paths.ts'

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

/** 上游描述中的旧工具名不进入模型提示。 */
function renameDescription<T>(schema: T): T {
  if (Array.isArray(schema)) return schema.map(renameDescription) as T
  if (schema === null || typeof schema !== 'object') return schema
  return Object.fromEntries(Object.entries(schema).map(([key, value]) => [
    key,
    key === 'description' && typeof value === 'string' ? value.replaceAll('ego_', 'browser_') : renameDescription(value),
  ])) as T
}

/** 截图落点由本包决定，因此说明直接写清楚：路径相对工作区，结果回传绝对路径。 */
const SCREENSHOT_DESCRIPTION = 'Capture a screenshot of the current page (or of a single element if selector is given). '
  + '`path` is resolved inside the session workspace and must not exist yet; omit it to save a uniquely named PNG there. '
  + 'The result carries that PNG’s absolute path, and the image itself is part of this result.'
/** 脚本进程的工作目录不是会话工作区，模型必须自己把绝对路径写进脚本并打印返回值。 */
const SCRIPT_PATH_NOTE = ' Relative file paths inside the script belong to the Host process, not the session workspace:'
  + ' pass an absolute path for every file the script writes, and print what `page.screenshot(...)` returns —'
  + ' that value is the PNG’s absolute path.'
const FILE_PARAMETER_DESCRIPTIONS: Readonly<Record<string, string>> = {
  'browser_screenshot.path': 'Optional output path for the PNG, resolved inside the session workspace.'
    + ' Omit it to save a uniquely named file there; the result returns the absolute path.',
  'browser_download.savePath': 'Optional destination for the downloaded file, resolved inside the session workspace.'
    + ' Omit it to keep only the captured temporary file.',
  'browser_upload.path': 'Path of the file to upload. A relative path resolves inside the session workspace;'
    + ' an absolute path must stay there.',
}

/** 把上游的全局空间说明收敛为当前会话，不改实际参数与输出格式。 */
function browserDescription(name: string, description: string): string {
  const text = description.replaceAll('ego_', 'browser_')
  if (name === 'browser_space_open') {
    return 'Open or reuse this session’s browser pages. Other sessions’ pages are not available.'
  }
  if (name === 'browser_space_close') {
    return 'Close this session’s browser pages. Keep them open when you finish a task so you can continue later.'
  }
  if (name === 'browser_screenshot') return SCREENSHOT_DESCRIPTION
  if (name === 'browser_script' || name === 'browser_cli') return `${text}${SCRIPT_PATH_NOTE}`
  return text
}

/** schema 中的空间参数只接受当前会话；文件路径说明改成工作区口径。 */
function browserParameters(name: string, schema: Record<string, unknown>): Record<string, unknown> {
  const parameters = renameDescription(schema)
  if (!('properties' in parameters) || !parameters.properties || typeof parameters.properties !== 'object') return parameters
  const properties: Record<string, unknown> = { ...(parameters.properties as Record<string, unknown>) }
  for (const [path, text] of Object.entries(FILE_PARAMETER_DESCRIPTIONS)) {
    const [owner, property] = path.split('.') as [string, string]
    const field = properties[property]
    if (owner !== name || !field || typeof field !== 'object') continue
    properties[property] = { ...field, description: text }
  }
  const key = name === 'browser_space_open' || name === 'browser_space_close' ? 'name' : 'space'
  const field = properties[key]
  if (field && typeof field === 'object') {
    properties[key] = { ...field,
      description: key === 'space'
        ? 'Optional. Uses this session’s pages; other sessions’ pages are unavailable. Leave blank unless resuming an older call.'
        : 'Use "default" to select this session’s browser pages; other sessions’ pages are unavailable.',
    }
  }
  return { ...parameters, properties }
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

/**
 * 上游失败的简短原因，供模型自我修正用。
 *
 * 统一报“操作失败”会把可操作的信息（目标不在当前空间、选择器无效、能力缺失）
 * 一起吞掉，模型只能盲目重试。这里只保留单行、限长的文本：足够指明原因，
 * 又不会把页面内容、堆栈或本机路径带进上下文。
 * @param error - 上游工具抛出的任意值。
 * @returns 单行原因；没有可用文本时为空串。
 */
function failureDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const line = message.replace(/\s+/gu, ' ').trim()
  if (line === '') return ''
  return line.length > 240 ? `${line.slice(0, 240)}…` : line
}

/**
 * 远程工作区仍可使用浏览器：浏览器属于执行工具的那台 Host，与工作区内容无关。
 * 但上传、下载、带落点的截图与本地 `file://` 文档都要读写 Host 自己的文件，
 * 这些入口按工作区拒绝，免得远程会话借此读写本机文件。
 */
async function checkLocalFiles(cwd: string | undefined, name: string, args: Record<string, unknown>,
  signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const screenshotFile = name === 'browser_screenshot' && typeof args.path === 'string' && args.path !== ''
  const localFile = name === 'browser_upload' || name === 'browser_download' || screenshotFile
    || (name === 'browser_navigate' && typeof args.url === 'string' && /^file:/iu.test(args.url))
  if (!localFile || cwd === undefined) return
  if (await remoteWorkspacePath('.', cwd, signal) !== undefined) {
    throw new Error(`${name}: remote workspaces cannot read or write local files through the browser`)
  }
  signal.throwIfAborted()
}

/**
 * 模型看不到 Host 进程的当前目录，因此文件参数一律以会话工作区为基准：
 * 上传读工作区里已有的文件，截图与下载写工作区内尚不存在的新文件。
 *
 * 改写后的绝对路径会随结果回到模型，模型下一次直接读它即可，不必猜截图落在哪；
 * 只读会话不能把浏览器产物写进工作区，此时带显式路径的调用直接拒绝。
 * 上传、下载与带路径的截图已先由 {@link checkLocalFiles} 挡在远程工作区之外。
 * 没有工作区路径的会话不做改写：没有可锚定的目录，保持上游原有语义。
 * @param options 调用会话、工具名、原始参数、有效沙箱模式与取消信号。
 * @returns 交给宿主执行的参数，以及本包授权的截图落点（没有落定时省略）。
 */
async function localizeFileArgs(options: {
  readonly cwd: string | undefined
  readonly name: string
  readonly args: Record<string, unknown>
  readonly mode: string | undefined
  readonly signal: AbortSignal
}): Promise<{ args: Record<string, unknown>; expected?: string }> {
  const { cwd, name, args, mode, signal } = options
  signal.throwIfAborted()
  if (cwd === undefined) return { args }
  if (name === 'browser_upload') {
    if (typeof args.path !== 'string' || args.path === '') return { args }
    return { args: { ...args, path: await uploadPath(cwd, args.path, signal) } }
  }
  const key = name === 'browser_screenshot' ? 'path' : name === 'browser_download' ? 'savePath' : undefined
  if (key === undefined) return { args }
  const requested = typeof args[key] === 'string' && args[key] !== '' ? args[key] : undefined
  if (mode === 'read-only') {
    if (requested === undefined) return { args }
    throw new Error(`${name}: a read-only session cannot write files into the session workspace`)
  }
  const target = requested !== undefined
    ? await newWorkspacePath(cwd, requested, name, signal)
    // 下载没有显式落点时保持上游的临时文件；截图的默认落点在工作区里。
    : name === 'browser_screenshot' ? await newScreenshotPath(cwd, signal) : undefined
  if (target === undefined) return { args }
  return { args: { ...args, [key]: target }, ...name === 'browser_screenshot' ? { expected: target } : {} }
}

/**
 * 只把本次截图读取为模型图片。
 *
 * 指定了落点时先核对提供方写的正是这个文件（否则可能读到别的本机文件），
 * 没指定时接受提供方自己报告的临时路径；大小与格式由附件服务复核。
 * 上游报告失败时没有图片可读，保留它自己的诊断。
 * @param ctx 提供持久附件服务的上下文。
 * @param value 上游截图结果。
 * @param expected 本次授权的绝对落点；省略路径且没有默认落点时为 undefined。
 * @param signal 调用取消信号。
 * @returns 模型图片块与它对应的绝对路径；截图不可读时为 null。
 */
async function persistScreenshot(ctx: Context, value: unknown, expected: string | undefined,
  signal: AbortSignal): Promise<{ path: string; image: ContentBlock } | null> {
  if (value === null || typeof value !== 'object' || (value as { ok?: unknown }).ok === false) return null
  const reported = (value as { path?: unknown }).path
  let path: string
  if (expected !== undefined) path = await screenshotPath(expected, reported, signal)
  else if (typeof reported === 'string') path = reported
  else return null
  signal.throwIfAborted()
  let info
  try { info = await stat(path) } catch { return null }
  if (!info.isFile() || info.size > MAX_SCREENSHOT_BYTES) return null
  let data: Buffer
  try { data = await readFile(path) } catch { return null }
  signal.throwIfAborted()
  const attachment = await ctx.attachments.saveImage({ data, mediaType: 'image/png', name: 'browser-screenshot.png' })
  return { path, image: { type: 'image', attachment } }
}

async function run(ctx: Context, source: ToolDefinition, name: string, input: unknown, exec: ToolRunContext,
  imageForPath: Map<string, ContentBlock>): Promise<unknown> {
  const agent = exec.agent
  if (agent === undefined) throw new Error(`${name}: calling agent is required`)
  const cwd = agent.session.header.cwd
  const approval = ctx.get('approval')
  if (approval === undefined) throw new Error(`${name}: approval service is unavailable`)
  const args = (input !== null && typeof input === 'object' && !Array.isArray(input)) ? input as Record<string, unknown> : {}
  await checkLocalFiles(cwd, name, args, exec.signal)
  const policy = policyOf(approval, agent.session)
  const mode = ctx.get('sandboxPolicy')?.resolve({ session: agent.session }).mode
  // 文件参数在审批前落到工作区：路径不合规不该先弹一次审批。
  const localized = await localizeFileArgs({ cwd, name, args, mode, signal: exec.signal })
  if (!(mode === 'danger-full-access' && policy === 'never')) {
    const outcome = await approval.request({ agent, toolName: name, callId: exec.callId,
      reason: reason(name, args), signal: exec.signal })
    exec.signal.throwIfAborted()
    if (outcome !== 'allowed-once') throw new Error(`${name}: approval ${outcome}`)
  }
  // 审批期间工作区可能被切到远程，因此放行前后各查一次同样的文件边界。
  await checkLocalFiles(cwd, name, localized.args, exec.signal)
  const liveMode = ctx.get('sandboxPolicy')?.resolve({ session: agent.session }).mode
  if (liveMode !== mode || policyOf(approval, agent.session) !== policy) {
    throw new Error(`${name}: session permissions changed while awaiting approval`)
  }
  let value: unknown
  try { value = await source.execute(localized.args, exec) } catch (error) {
    exec.signal.throwIfAborted()
    const detail = failureDetail(error)
    const isSpaceError = detail.includes('another task space is not available')
    const advice = isSpaceError
      ? 'omit the space argument to use this session’s pages; do not retry another session’s space'
      : 'inspect the current page before retrying'
    throw new Error(`${name}: browser operation failed${detail === '' ? '' : `: ${detail}`}; ${advice}`)
  }
  bounded(value, name)
  if (name === 'browser_screenshot') {
    const shot = await persistScreenshot(ctx, value, localized.expected, exec.signal)
    if (shot !== null) imageForPath.set(shot.path, shot.image)
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
    const parameterSchema = browserParameters(visibleName, source.parameters)
    ctx.tools.register({
      ...source,
      name: visibleName,
      description: browserDescription(visibleName, source.description),
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
