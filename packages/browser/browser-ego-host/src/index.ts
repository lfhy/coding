/** ego-lite 浏览器 Host：只交付会话限定的工具定义，不注册模型工具。 @module coding-browser-ego-host */
import { randomUUID } from 'node:crypto'
import { constants, existsSync } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Service, type Context } from '@deepseek-ai/cordis'
import { defineTool, type ParameterSchemaSpec, type ToolDefinition, type ToolRunContext } from 'coding-tools'
import type {} from 'coding-client-connection'
import type {} from 'coding-host-webserver'
import type {} from 'coding-session'
import type { JsonValue } from 'coding-session'
import type {} from 'coding-subprocess'
import type { SessionId } from 'coding-session/types'
import { markToolStart } from './activity.ts'
import { installRoutes } from './routes.ts'
import { parseScriptResult, scriptFor } from './scripts.ts'
import { targetIdsForSession, validId } from './session-space.ts'
import { ensureWorker } from './worker.ts'

const CLI = fileURLToPath(new URL('../runtime/ego-linux/bin/ego-browser.mjs', import.meta.url))
const MAX_OUTPUT = 96 * 1024
let chain: Promise<unknown> = Promise.resolve()

declare module '@deepseek-ai/cordis' {
  interface Context { egoBrowser: EgoBrowserHost }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function render(_args: unknown, value: unknown): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

function browserEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    EGO_ISOLATE_SPACES: '1', EGO_BROWSER_NO_UPDATE_NOTIFIER: '1',
    EGO_LINUX_CDP_URL: undefined, EGO_LINUX_EXTRA_ARGS: undefined,
  }
  if ((process.versions as { electron?: string }).electron) env.ELECTRON_RUN_AS_NODE = '1'
  if (!process.env.EGO_LINUX_CHROME && process.platform === 'darwin') {
    const candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    ]
    // Host installation detection is optional; runtime still reports missing Chrome clearly.
    env.EGO_LINUX_CHROME = candidates.find(existsSync)
  }
  return env
}

/** 服务不含动态装配参数；工具权限由调用者自己的审批消费方处理。 */
export default class EgoBrowserHost extends Service {
  static inject = ['sessions', 'subprocess']
  private readonly definitions: readonly ToolDefinition[]

  constructor(ctx: Context) {
    super(ctx, 'egoBrowser')
    this.definitions = Object.freeze([
      this.make('ego_navigate', 'Open a URL in the current session browser.', {
        url: { type: 'string', required: true, description: 'HTTP(S) page URL.' },
      }),
      this.make('ego_snapshot', 'Read the current page semantic tree.', {}),
      this.make('ego_page_info', 'Read the current page title, URL and viewport.', {}),
      this.make('ego_tabs', 'List pages in the current session only.', {}),
      this.make('ego_click', 'Click a page element by selector or snapshot ref.', {
        selector: { type: 'string', required: true, description: 'CSS selector or ref from snapshot.' },
      }),
      this.make('ego_fill', 'Fill a page input with text.', {
        selector: { type: 'string', required: true, description: 'CSS selector or ref from snapshot.' },
        text: { type: 'string', required: true, description: 'Text to enter.' },
      }),
      this.make('ego_scroll', 'Scroll the current page by pixel offsets.', {
        deltaX: { type: 'number', description: 'Horizontal offset in pixels.' },
        deltaY: { type: 'number', description: 'Vertical offset in pixels.' },
      }),
      this.make('ego_wait', 'Wait briefly for page updates.', {
        ms: { type: 'integer', required: true, description: 'Wait between 1 and 30000 milliseconds.' },
      }),
      this.make('ego_wait_for_selector', 'Wait for a page element to appear or disappear.', {
        selector: { type: 'string', required: true, description: 'Page selector.' },
        state: { type: 'string', enum: ['visible', 'attached', 'hidden', 'detached'], description: 'Desired element state.' },
        timeout: { type: 'integer', description: 'Maximum wait in milliseconds.' },
      }),
      this.make('ego_wait_for_url', 'Wait until the current page reaches a URL pattern.', {
        pattern: { type: 'string', required: true, description: 'URL or glob pattern.' },
        timeout: { type: 'integer', description: 'Maximum wait in milliseconds.' },
      }),
      this.make('ego_key', 'Press a key or type into the focused page.', {
        key: { type: 'string', description: 'Key combination, e.g. Enter or Control+a.' },
        text: { type: 'string', description: 'Text to type instead of pressing one key.' },
      }),
      this.make('ego_hover', 'Hover over a page element.', {
        selector: { type: 'string', required: true, description: 'CSS selector or snapshot ref.' },
      }),
      this.make('ego_read_element', 'Read one page element rather than a full snapshot.', {
        selector: { type: 'string', required: true, description: 'CSS selector or snapshot ref.' },
        what: { type: 'string', enum: ['text', 'html', 'value', 'attribute', 'visible', 'enabled', 'count'], description: 'Property to read.' },
        attribute: { type: 'string', description: 'Attribute name when reading an attribute.' },
      }),
      this.make('ego_select', 'Choose an option from a page select element.', {
        selector: { type: 'string', required: true, description: 'Select element.' },
        value: { type: 'string', required: true, description: 'Option value or label.' },
      }),
      this.make('ego_drag', 'Drag one page element onto another.', {
        from: { type: 'string', required: true, description: 'Start element.' },
        to: { type: 'string', required: true, description: 'Drop element.' },
      }),
      this.make('ego_check', 'Set or clear a checkbox.', {
        selector: { type: 'string', required: true, description: 'Checkbox selector.' },
        checked: { type: 'boolean', description: 'Whether the checkbox should be checked.' },
      }),
      this.make('ego_captcha', 'Detect a human-verification challenge on the current page.', {}),
      this.make('ego_screenshot', 'Save a screenshot in the session workspace.', {
        path: { type: 'string', description: 'Optional new PNG file in the session workspace root.' },
      }),
    ])
    installRoutes(ctx)
  }

  /**
   * 暴露固定安全集合给按 Agent 权限审批的工具消费方；本服务不碰 ctx.tools。
   * @returns 带执行时会话复核的结构化定义；调用者决定是否、何时注册。
   */
  toolDefinitions(): readonly ToolDefinition[] { return this.definitions }

  private make(name: string, description: string, parameters: ParameterSchemaSpec): ToolDefinition {
    return defineTool({ name, description, parameters,
      output: { schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean', required: true } } }, render },
      timeoutMs: 120_000,
      execute: async (raw: Record<string, unknown>, exec: ToolRunContext): Promise<{ ok: boolean } & Record<string, JsonValue>> => {
        const args = record(raw)
        const session = exec.agent?.session
        const id = session?.id
        if (!args || !session || !validId(id) || this.ctx.sessions.get(id) !== session || 'space' in args
          || 'tab' in args || 'targetId' in args) throw new Error('browser session is unavailable')
        const sessionId = id
        exec.signal.throwIfAborted()
        const run = chain.then(async (): Promise<{ ok: boolean } & Record<string, JsonValue>> => {
          exec.signal.throwIfAborted()
          if (this.ctx.sessions.get(sessionId) !== session) throw new Error('browser session is unavailable')
          markToolStart(sessionId)
          if (name === 'ego_screenshot') return this.saveScreenshot(sessionId, session.header.cwd, args, exec.signal)
          const result = await this.executeScript(name, args, sessionId, exec.signal)
          const parsed = record(result)
          return parsed && typeof parsed.ok === 'boolean'
            ? parsed as { ok: boolean } & Record<string, JsonValue>
            : { ok: false }
        })
        chain = run.catch(() => {})
        return run
      },
    })
  }

  private async executeScript(name: string, args: Record<string, unknown>, sessionId: SessionId,
    signal: AbortSignal): Promise<unknown> {
    if (name === 'ego_navigate') {
      const url = typeof args.url === 'string' ? args.url : ''
      try {
        const parsed = new URL(url)
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || url.length > 2048) throw new Error()
      } catch { throw new Error('browser URL must be a plain HTTP(S) address') }
    }
    if (name === 'ego_fill' && (typeof args.text !== 'string' || args.text.length > 10_000)) throw new Error('browser input is too long')
    if (['ego_click', 'ego_fill', 'ego_hover', 'ego_read_element', 'ego_select', 'ego_check', 'ego_wait_for_selector'].includes(name)
      && (typeof args.selector !== 'string' || args.selector.length === 0 || args.selector.length > 2048)) {
      throw new Error('browser selector is invalid')
    }
    if (name === 'ego_read_element' && args.what === 'attribute'
      && (typeof args.attribute !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u.test(args.attribute))) {
      throw new Error('browser attribute name is invalid')
    }
    if (name === 'ego_wait_for_url' && (typeof args.pattern !== 'string' || args.pattern.length > 2048)) {
      throw new Error('browser URL pattern is invalid')
    }
    if (['ego_wait_for_url', 'ego_wait_for_selector'].includes(name) && args.timeout !== undefined
      && (!Number.isInteger(args.timeout) || (args.timeout as number) < 1 || (args.timeout as number) > 30_000)) {
      throw new Error('browser wait timeout is invalid')
    }
    if (name === 'ego_wait' && (!Number.isInteger(args.ms) || (args.ms as number) < 1 || (args.ms as number) > 30_000)) {
      throw new Error('browser wait time is invalid')
    }
    if (name === 'ego_key' && ((typeof args.key !== 'string' || args.key.length > 64)
      && (typeof args.text !== 'string' || args.text.length === 0 || args.text.length > 2000))) {
      throw new Error('browser key is invalid')
    }
    if (name === 'ego_drag' && ([args.from, args.to].some(value => typeof value !== 'string' || value.length > 2048))) {
      throw new Error('browser drag selectors are invalid')
    }
    if (name === 'ego_scroll' && [args.deltaX ?? 0, args.deltaY ?? 0].some(value => typeof value !== 'number'
      || !Number.isFinite(value) || Math.abs(value) > 2000)) throw new Error('browser scroll distance is invalid')
    const handle = this.ctx.subprocess.spawn({
      argv: [process.execPath, CLI, 'nodejs'], cwd: process.cwd(), env: browserEnvironment(),
      stdio: { stdin: { data: scriptFor(name, args, sessionId) }, stdout: { maxBytes: MAX_OUTPUT }, stderr: { maxBytes: 8192 } },
      graceMs: 10_000, signal,
    })
    const outcome = await handle.done
    signal.throwIfAborted()
    if (outcome.exitCode !== 0) throw new Error('browser operation failed')
    const output = handle.collected.stdout?.readFrom(0)
    if (!output || output.lossy || Buffer.byteLength(output.text) > MAX_OUTPUT) throw new Error('browser result is too large')
    return parseScriptResult(output.text)
  }

  private async saveScreenshot(sessionId: SessionId, cwd: string | undefined,
    args: Record<string, unknown>, signal: AbortSignal): Promise<{ ok: boolean; path: string }> {
    if (!cwd || (args.path !== undefined && (typeof args.path !== 'string' || !isAbsolute(args.path)))) {
      throw new Error('browser screenshot requires a new workspace file')
    }
    const root = await realpath(cwd)
    const path = typeof args.path === 'string' ? args.path : join(root, `.browser-screenshot-${randomUUID()}.png`)
    const parent = await realpath(dirname(path))
    if (parent !== root) throw new Error('browser screenshot path is unavailable')
    const targetIds = await targetIdsForSession(sessionId)
    if (targetIds.size === 0) throw new Error('browser page is unavailable')
    const port = await ensureWorker(this.ctx)
    if (port === null) throw new Error('browser preview is unavailable')
    const item = [...targetIds][0]
    if (!item) throw new Error('browser page is unavailable')
    const response = await fetch(`http://127.0.0.1:${port}/api/snapshot?targetId=${encodeURIComponent(item)}&maxWidth=1280`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    })
    if (!response.ok || Number(response.headers.get('content-length')) > 8 * 1024 * 1024) throw new Error('browser screenshot failed')
    const png = Buffer.from(await response.arrayBuffer())
    if (png.length < 8 || png.length > 8 * 1024 * 1024 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new Error('browser screenshot is invalid')
    }
    if (this.ctx.sessions.get(sessionId) === undefined || !(await targetIdsForSession(sessionId)).has(item)) {
      throw new Error('browser page changed before capture')
    }
    signal.throwIfAborted()
    const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { await file.writeFile(png) }
    finally { await file.close() }
    return { ok: true, path }
  }
}
