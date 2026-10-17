/**
 * cua-driver 后端：把 `ComputerUseBackend` 接缝映射到 trycua/cua 的驱动 CLI。
 *
 * 每次调用都是一次固定 argv 的子进程：`cua-driver call <tool> <json>`，绝不经过 shell，
 * 也不允许模型提供工具名、参数之外的东西。驱动的返回是外部输入，全部按边界收窄；
 * 形状不符或拒绝语义都按 `COMPUTER_PROVIDER_FAILURE` 失败关闭，不做猜测性重试。
 * 驱动自身按 element token 判定快照过期，本地再用观察时的状态哈希挡一次窗口身份变化。
 *
 * @module coding-computer-use/providers/cua-driver
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {
  BackendActionRequest,
  BackendActionResult,
  BackendCursorAction,
  BackendCursorActivation,
  BackendElement,
  BackendHealth,
  BackendObservation,
  BackendObserveOptions,
  BackendTrackedDragResult,
  ComputerUseBackend,
  CursorVisibility,
} from '../backend.ts'
import type { ResolvedComputerUseConfig } from '../config.ts'
import { ComputerUseError, computerUseError } from '../errors.ts'
import type {
  ComputerAppIdentity,
  ComputerAppSelector,
  ComputerAppSummary,
  ComputerPermissionState,
  ComputerRect,
} from '../types.ts'

/** 显式指定驱动可执行文件的环境变量；与驱动的官方安装器约定一致。 */
const DRIVER_BIN_ENV = 'CUA_DRIVER_BIN'
/** 驱动单次调用的响应上限，超过即视为协议异常。 */
const DRIVER_RESPONSE_MAX_BYTES = 8 * 1024 * 1024
/** 官方安装器把驱动放在这个相对主目录的位置。 */
const INSTALLED_DRIVER_PATH = join('.cua-driver', 'packages', 'current', 'cua-driver')
/** 驱动的 CLI 不回传 TCC 状态，未知就是未知，不能当成已授权。 */
const NOT_DETERMINED: ComputerPermissionState = 'not-determined'
/** 驱动上游默认上报匿名遥测；本客户端默认关掉，用户在环境里显式设置时以用户为准。 */
const TELEMETRY_ENV = 'CUA_DRIVER_RS_TELEMETRY_ENABLED'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/** 驱动的 frame 使用 `{x, y, w, h}`；接缝使用 `{x, y, width, height}`。 */
function asRect(value: unknown): ComputerRect | undefined {
  if (!isRecord(value)) return undefined
  const x = asNumber(value.x)
  const y = asNumber(value.y)
  const width = asNumber(value.w ?? value.width)
  const height = asNumber(value.h ?? value.height)
  if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined
  return { x, y, width, height }
}

/** 驱动返回的 `effect`/`code` 表达拒绝，不能当作成功继续。 */
function refusalOf(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const effect = asString(value.effect)
  if (effect === 'refused' || effect === 'rejected' || effect === 'suspected_noop') {
    // 拒绝原因同时可能落在 code 与 reason/message 上，两个都要给，模型才能决定下一步。
    const detail = [asString(value.code), asString(value.reason) ?? asString(value.message)]
      .filter((part): part is string => part !== undefined)
      .join(': ')
    return detail === '' ? `${effect} by the cua-driver engine` : `${effect} by the cua-driver engine (${detail})`
  }
  if (value.code === 'background_unavailable') {
    const reason = asString(value.reason) ?? asString(value.message) ?? ''
    return reason === '' ? 'the cua-driver engine refused background delivery' : `the cua-driver engine refused background delivery: ${reason}`
  }
  return asString(value.error)
}

/** 声明里的一行元素文本；模型按它选择编号。 */
function renderElementLine(element: BackendElement): string {
  const parts = [`[${element.index}] ${element.role}`]
  const label = element.label ?? element.value
  if (label !== undefined && label.length > 0) parts.push(`"${label}"`)
  if (element.frame !== undefined) {
    const x = Math.round(element.frame.x + element.frame.width / 2)
    const y = Math.round(element.frame.y + element.frame.height / 2)
    parts.push(`@(${x},${y})`)
  }
  return parts.join(' ')
}

function truncateBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const encoded = Buffer.byteLength(text, 'utf8')
  if (encoded <= maxBytes) return { text, truncated: false }
  return { text: Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8'), truncated: true }
}

/** 一次驱动调用的原始回包。 */
interface DriverCall {
  tool: string
  value: Record<string, unknown>
}

/**
 * 沿 `cuaDriver.bin` → `CUA_DRIVER_BIN` → PATH 上的 `cua-driver` → 官方安装器路径解析可执行文件。
 * 顺序与驱动的官方安装器一致，解析失败时把安装指引交给调用方。
 * @param configured - 配置里显式给出的路径。
 * @param env - 进程环境。
 * @param home - 主目录，用于拼官方安装器路径。
 * @returns 可执行文件路径或命令名（交给 spawn 报 ENOENT）。
 */
export function resolveDriverBin(
  configured: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  if (configured !== undefined && configured.trim() !== '') return configured.trim()
  const fromEnv = env[DRIVER_BIN_ENV]
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim()
  return join(home, INSTALLED_DRIVER_PATH)
}

/**
 * 驱动后端。它只实现驱动实际提供的动作；其余动作（设置值、执行可访问性动作、选择文本）明确拒绝，
 * 不会退化成别的技术路线。
 */
export class CuaDriverBackend implements ComputerUseBackend {
  readonly name = 'cua-driver' as const
  private readonly bin: string
  private readonly session: string
  /** 观察时的窗口状态哈希，按 `pid:window` 记录，用于挡住窗口身份变化后的坐标动作。 */
  private readonly hashes = new Map<string, string>()

  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedComputerUseConfig,
  ) {
    this.bin = resolveDriverBin(config.cuaDriver.bin)
    this.session = config.cuaDriver.session
  }

  get helperPath(): string {
    return this.bin
  }

  /** 单一固定的调用形状；工具名与参数由本类构造，模型无法提供。 */
  private async call(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<DriverCall> {
    const timeout = AbortSignal.timeout(this.config.actionTimeoutMs)
    const combined = AbortSignal.any([signal, timeout])
    const handle = this.ctx.subprocess.spawn({
      argv: [this.bin, 'call', tool, JSON.stringify({ ...args, session: this.session })],
      cwd: process.cwd(),
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: DRIVER_RESPONSE_MAX_BYTES },
        stderr: { maxBytes: 64 * 1024 },
      },
      graceMs: 1000,
      signal: combined,
      env: {
        LANG: process.env.LANG ?? 'en_US.UTF-8',
        LC_ALL: process.env.LC_ALL ?? 'en_US.UTF-8',
        [TELEMETRY_ENV]: process.env[TELEMETRY_ENV] ?? '0',
      },
    })
    let outcome
    try {
      outcome = await handle.done
    } catch (error) {
      throw computerUseError(error, `cua-driver ${tool} could not be started; install the driver or point ${DRIVER_BIN_ENV} at it`)
    }
    const stdoutReader = handle.collected.stdout
    const stderrReader = handle.collected.stderr
    const stdout = stdoutReader === undefined ? { text: '' } : stdoutReader.readFrom(0)
    const stderr = stderrReader === undefined ? { text: '' } : stderrReader.readFrom(0)
    if (combined.aborted && signal.aborted) {
      throw new ComputerUseError('COMPUTER_CANCELLED', `cua-driver ${tool} was cancelled`)
    }
    if (outcome.exitCode !== 0) {
      const detail = (stderr.text.trim() || stdout.text.trim()).slice(0, 800)
      throw new ComputerUseError('COMPUTER_PROVIDER_FAILURE', `cua-driver ${tool} failed with exit ${String(outcome.exitCode)}: ${detail}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(stdout.text)
    } catch {
      throw new ComputerUseError('COMPUTER_PROVIDER_FAILURE', `cua-driver ${tool} did not return JSON: ${stdout.text.slice(0, 200)}`)
    }
    if (!isRecord(parsed)) {
      throw new ComputerUseError('COMPUTER_PROVIDER_FAILURE', `cua-driver ${tool} returned a non-object response`)
    }
    const refusal = refusalOf(parsed)
    if (refusal !== undefined) throw new ComputerUseError('COMPUTER_ACTION_BLOCKED', `cua-driver ${tool}: ${refusal}`)
    return { tool, value: parsed }
  }

  /** 驱动只按 pid/title/app_name 描述窗口；这里按需选出唯一目标窗口。 */
  private async windows(signal: AbortSignal): Promise<Array<Record<string, unknown>>> {
    const { value } = await this.call('list_windows', { on_screen_only: true }, signal)
    const list = value.windows
    return Array.isArray(list) ? list.filter(isRecord) : []
  }

  private static appOf(row: Record<string, unknown>): ComputerAppIdentity | undefined {
    const pid = asNumber(row.pid)
    const name = asString(row.name) ?? asString(row.app_name)
    const bundleId = asString(row.bundle_id) ?? asString(row.bundleId) ?? asString(row.app_id) ?? name
    if (pid === undefined || bundleId === undefined) return undefined
    return { pid, bundleId, name: name ?? bundleId }
  }

  async listApps(signal: AbortSignal): Promise<ComputerAppSummary[]> {
    const { value } = await this.call('list_apps', {}, signal)
    const rows = Array.isArray(value.apps) ? value.apps.filter(row => isRecord(row)) : []
    const apps: ComputerAppSummary[] = []
    for (const row of rows) {
      const app = CuaDriverBackend.appOf(row)
      if (app === undefined) continue
      apps.push({
        ...app,
        frontmost: asBoolean(row.active) ?? asBoolean(row.frontmost) ?? false,
        // 驱动的 CLI 不回传 TCC 状态；这里是未知而不是已授权。
        accessibility: 'not-determined',
        screenRecording: 'not-determined',
      })
    }
    if (apps.length === 0 && rows.length > 0) {
      throw new ComputerUseError('COMPUTER_PROVIDER_FAILURE', 'cua-driver list_apps rows are missing pid or bundle id fields')
    }
    return apps
  }

  async resolveApp(selector: ComputerAppSelector, signal: AbortSignal): Promise<ComputerAppIdentity> {
    const apps = await this.listApps(signal)
    const wanted = selector.bundleId ?? selector.name
    const matches = apps.filter(app => selector.pid !== undefined
      ? app.pid === selector.pid
      : selector.bundleId !== undefined
        ? app.bundleId === selector.bundleId
        : app.name.toLowerCase() === (wanted ?? '').toLowerCase())
    const [match] = matches
    if (match === undefined) {
      throw new ComputerUseError('COMPUTER_APP_NOT_FOUND', `no running application matches ${JSON.stringify(selector)}`)
    }
    if (matches.length > 1) {
      throw new ComputerUseError('COMPUTER_TARGET_AMBIGUOUS', `${matches.length} running applications match ${JSON.stringify(selector)}`)
    }
    return { bundleId: match.bundleId, pid: match.pid, name: match.name }
  }

  /** 目标窗口：同一 pid 下取 z 序最前者，与驱动的可见窗口列表一致。 */
  private async windowFor(app: ComputerAppIdentity, signal: AbortSignal): Promise<Record<string, unknown>> {
    const rows = (await this.windows(signal)).filter(row => asNumber(row.pid) === app.pid)
    const sorted = rows.sort((left, right) => (asNumber(right.z_index) ?? 0) - (asNumber(left.z_index) ?? 0))
    const [target] = sorted
    if (target === undefined) {
      throw new ComputerUseError('COMPUTER_TARGET_UNAVAILABLE', `${app.name} has no on-screen window to observe`)
    }
    return target
  }

  async observe(app: ComputerAppIdentity, options: BackendObserveOptions, signal: AbortSignal): Promise<BackendObservation> {
    const target = await this.windowFor(app, signal)
    const windowId = asNumber(target.window_id)
    const state = await this.call('get_window_state', {
      pid: app.pid,
      ...(windowId === undefined ? {} : { window_id: windowId }),
      include_screenshot: options.screenshot !== 'none',
      max_elements: options.maxNodes,
    }, signal)
    const rows = Array.isArray(state.value.elements) ? state.value.elements.filter(row => isRecord(row)) : []
    const elements: BackendElement[] = rows.map((row, position) => {
      const index = asNumber(row.element_index) ?? position
      const token = asString(row.element_token)
      const role = asString(row.role) ?? 'AXUnknown'
      const label = asString(row.label)
      const value = asString(row.value)
      const enabled = asBoolean(row.enabled)
      const frame = asRect(row.frame)
      return {
        index,
        role,
        actions: [],
        locator: [],
        ...(token === undefined ? {} : { nativeIdentifier: token }),
        ...(label === undefined ? {} : { title: label }),
        ...(label === undefined ? {} : { label }),
        ...(value === undefined ? {} : { value }),
        ...(enabled === undefined ? {} : { enabled }),
        ...(frame === undefined ? {} : { frame }),
      }
    })
    const rendered = truncateBytes(elements.map(element => renderElementLine(element)).join('\n'), options.maxTextBytes)
    const windowFrame = asRect(target.frame)
    const title = asString(target.title)
    const stateHash = createHash('sha256')
      .update(`${String(app.pid)}:${String(windowId ?? '')}:${elements.map(element => element.nativeIdentifier ?? '').join(',')}:${String(elements.length)}`)
      .digest('hex')
    this.hashes.set(`${String(app.pid)}:${String(windowId ?? '')}`, stateHash)

    const screenshot = await this.persistScreenshot(state.value, options)
    if (screenshot !== undefined && windowFrame !== undefined && windowFrame.width > 0) {
      this.scales.set(`${String(app.pid)}:${String(windowId ?? '')}`, screenshot.width / windowFrame.width)
    }
    return {
      app,
      stateHash,
      frontmost: asBoolean(target.active) ?? false,
      ...(windowFrame === undefined ? {} : {
        window: {
          frame: windowFrame,
          ...(title === undefined ? {} : { title }),
          ...(windowId === undefined ? {} : { id: windowId }),
        },
      }),
      treeText: rendered.text,
      truncated: rendered.truncated,
      elements,
      ...(screenshot === undefined ? {} : { screenshot }),
      permissions: { accessibility: NOT_DETERMINED, screenRecording: NOT_DETERMINED },
    }
  }

  /** 把驱动返回的 base64 截图写到服务分配的路径上；缺失时按请求强度决定是否失败。 */
  private async persistScreenshot(
    value: Record<string, unknown>,
    options: BackendObserveOptions,
  ): Promise<BackendObservation['screenshot']> {
    const encoded = asString(value.screenshot_png_b64)
    if (encoded === undefined || options.screenshot === 'none' || options.screenshotPath === undefined) {
      if (options.screenshot === 'required') {
        throw new ComputerUseError('COMPUTER_PROVIDER_FAILURE', 'cua-driver did not return a screenshot for a required capture')
      }
      return undefined
    }
    const data = Buffer.from(encoded, 'base64')
    if (data.byteLength > this.config.maxScreenshotBytes) {
      throw new ComputerUseError('COMPUTER_PROVIDER_FAILURE', `cua-driver screenshot exceeds maxScreenshotBytes (${String(data.byteLength)})`)
    }
    await mkdir(dirname(options.screenshotPath), { recursive: true })
    await writeFile(options.screenshotPath, data)
    const width = asNumber(value.screenshot_width)
    const height = asNumber(value.screenshot_height)
    if (width === undefined || height === undefined) {
      throw new ComputerUseError('COMPUTER_PROVIDER_FAILURE', 'cua-driver screenshot is missing its pixel dimensions')
    }
    return { path: options.screenshotPath, width, height }
  }

  /** 坐标动作要求窗口身份未变；驱动的 element token 只覆盖元素动作。 */
  private assertFresh(request: BackendActionRequest): void {
    const key = `${String(request.app.pid)}:${String(request.window?.id ?? '')}`
    if (this.hashes.get(key) !== request.expectedStateHash) {
      throw new ComputerUseError(
        'COMPUTER_STALE_OBSERVATION',
        'the observed window changed since this observation; observe again before acting',
      )
    }
  }

  /** 元素动作交给驱动自己的 element token，坐标动作换算出驱动的窗口本地像素。 */
  private targetArgs(request: BackendActionRequest): Record<string, unknown> {
    const token = request.element?.nativeIdentifier
    if (token !== undefined) {
      return { pid: request.app.pid, element_token: token }
    }
    const action = request.action
    const x = 'x' in action ? action.x : undefined
    const y = 'y' in action ? action.y : undefined
    if (x === undefined || y === undefined) {
      throw new ComputerUseError('COMPUTER_TARGET_UNAVAILABLE', `${action.kind} needs an observed element or a coordinate pair`)
    }
    const frame = request.window?.frame
    const scale = this.rasterScale(request)
    return {
      pid: request.app.pid,
      ...(request.window?.id === undefined ? {} : { window_id: request.window.id }),
      x: Math.round(frame === undefined ? x : x / scale),
      y: Math.round(frame === undefined ? y : y / scale),
    }
  }

  /** 交付栅格与窗口逻辑宽度的比例；观察缺尺寸时按 1:1 处理。 */
  private rasterScale(request: BackendActionRequest): number {
    const key = `${String(request.app.pid)}:${String(request.window?.id ?? '')}`
    const scale = this.scales.get(key)
    return scale === undefined || scale <= 0 ? 1 : scale
  }

  private readonly scales = new Map<string, number>()

  async act(request: BackendActionRequest, signal: AbortSignal): Promise<BackendActionResult> {
    this.assertFresh(request)
    const action = request.action
    const target = this.targetArgs(request)
    const keyboard = { pid: request.app.pid }
    switch (action.kind) {
      case 'click': {
        const count = action.clickCount ?? 1
        const button = action.button ?? 'left'
        await this.call('click', { ...target, count, button, delivery_mode: 'background' }, signal)
        return {
          channel: target.element_token === undefined ? 'coordinates' : 'accessibility',
          activation: 'not-requested',
          pointerInput: true,
          pointerRouting: 'target-process',
        }
      }
      case 'type-text':
        await this.call('type_text', { ...keyboard, text: action.text, delivery_mode: 'background' }, signal)
        return { channel: 'keyboard', activation: 'not-requested', pointerInput: false, pointerRouting: 'none' }
      case 'press-key':
        await this.call('press_key', {
          ...keyboard,
          key: action.modifiers === undefined || action.modifiers.length === 0
            ? action.key
            : `${action.modifiers.map(modifier => modifier === 'command' ? 'cmd' : modifier === 'option' ? 'alt' : modifier === 'control' ? 'ctrl' : modifier).join('+')}+${action.key}`,
          delivery_mode: 'background',
        }, signal)
        return { channel: 'keyboard', activation: 'not-requested', pointerInput: false, pointerRouting: 'none' }
      case 'scroll':
        await this.call('scroll', {
          ...target,
          direction: action.direction,
          amount: action.pages ?? 1,
          delivery_mode: 'background',
        }, signal)
        return {
          channel: target.element_token === undefined ? 'coordinates' : 'accessibility',
          activation: 'not-requested',
          pointerInput: true,
          pointerRouting: 'target-process',
        }
      case 'drag':
        await this.call('drag', {
          pid: request.app.pid,
          ...(request.window?.id === undefined ? {} : { window_id: request.window.id }),
          from_x: Math.round(action.fromX / this.rasterScale(request)),
          from_y: Math.round(action.fromY / this.rasterScale(request)),
          to_x: Math.round(action.toX / this.rasterScale(request)),
          to_y: Math.round(action.toY / this.rasterScale(request)),
          delivery_mode: 'background',
        }, signal)
        return { channel: 'coordinates', activation: 'not-requested', pointerInput: true, pointerRouting: 'target-process' }
      case 'set-value':
      case 'perform-action':
        throw new ComputerUseError(
          'COMPUTER_ACTION_BLOCKED',
          `${action.kind} is not supported by the cua-driver backend; use an element click, paste or typing instead`,
        )
    }
  }

  async activateForCursor(
    app: ComputerAppIdentity,
    expectedStateHash: string,
    options: BackendObserveOptions,
    signal: AbortSignal,
  ): Promise<BackendCursorActivation> {
    // 驱动按后台投递语义工作，没有“为光标激活目标应用”的请求；报告前台现状即可。
    const observation = await this.observe(app, options, signal)
    if (observation.stateHash !== expectedStateHash) {
      throw new ComputerUseError('COMPUTER_STALE_OBSERVATION', 'the window changed while preparing to act; observe again')
    }
    return { observation, activation: observation.frontmost ? 'already-frontmost' : 'activated' }
  }

  actDragWithCursor(): Promise<BackendTrackedDragResult> {
    return Promise.reject(new ComputerUseError('COMPUTER_ACTION_BLOCKED', 'the cua-driver backend does not track an agent cursor'))
  }

  /** 驱动不画独立光标；这里如实报告不可见，部署应把 cursorVisualization 设为 hidden。 */
  visualizeCursor(action: BackendCursorAction): Promise<CursorVisibility> {
    return Promise.resolve({
      visible: false,
      reason: `the cua-driver backend does not draw an agent cursor for ${action.kind}`,
    })
  }

  async health(signal: AbortSignal): Promise<BackendHealth> {
    const apps = await this.listApps(signal)
    const review = await this.driverDigest()
    return {
      helperVersion: 'cua-driver',
      helperSha256: review,
      // 驱动的 CLI 不回传 TCC 状态；权限真值由 `cua-driver doctor` 报告，这里不猜。
      accessibility: 'not-determined',
      screenRecording: 'not-determined',
      ready: true,
      error: `${String(apps.length)} visible application(s) reported by cua-driver`,
    }
  }

  /** 显式路径上的驱动做内容哈希；PATH 上的命令名不做（没有可读文件）。 */
  private async driverDigest(): Promise<string> {
    if (!this.bin.includes('/')) return 'unversioned'
    try {
      return createHash('sha256').update(await readFile(this.bin)).digest('hex')
    } catch {
      return 'unversioned'
    }
  }

  openSettings(): Promise<void> {
    return Promise.reject(new ComputerUseError(
      'COMPUTER_ACTION_BLOCKED',
      'the cua-driver backend does not open system privacy panes; run `cua-driver doctor` and follow its remediation',
    ))
  }

  dispose(): Promise<void> {
    this.hashes.clear()
    return Promise.resolve()
  }
}
