/**
 * 电脑操作设置：只在浏览器侧收窄命名空间的形状、暂存草稿并串行写入。
 *
 * 开关、后端与授权范围的最终校验由 Host 的 `computer-use` 设置分节拥有；这里重复的
 * 上下界只用于在提交前挡住明显不合法的草稿，避免把用户输入原样送上线路。
 */
import {
  createSnapshotStore, type SettingsScope, type SettingsScopeSnapshot, type SnapshotStore,
} from 'coding-client-runtime/client'

/** 与宿主提供方共用的设置命名空间。 */
export const SETTINGS_NAMESPACE = 'computer-use'

/** 可选后端：随包 Swift helper 或 trycua/cua 的驱动 CLI。 */
export type ComputerProvider = 'native' | 'cua-driver'
/** 目标应用是否被带到前台。 */
export type FocusPolicy = 'preserve' | 'activate'
/** 坐标输入策略：只定向投递，或完全关闭。 */
export type PointerInputPolicy = 'deny' | 'targeted'
/** 独立 Agent 光标是否绘制。 */
export type CursorVisualization = 'hidden' | 'visible'

/** 一条按应用授权；`control` 隐含读取。 */
export interface ComputerUseGrant {
  bundleId: string
  read: boolean
  control: boolean
}

/** 交互策略，与宿主 `interaction` 分节同形。 */
export interface ComputerUseInteraction {
  focusPolicy: FocusPolicy
  keyboardPolicy: FocusPolicy
  pointerInputPolicy: PointerInputPolicy
  cursorVisualization: CursorVisualization
}

/** 设置页读写的完整命名空间形状。 */
export interface ComputerUseSettings {
  enabled: boolean
  provider: ComputerProvider
  helper: { path?: string; allowSourceBuild?: boolean }
  cuaDriver: { bin?: string; session?: string }
  interaction: ComputerUseInteraction
  allowAllApps: boolean
  grants: ComputerUseGrant[]
  observationTtlMs: number
  confirmationTtlMs: number
  actionTimeoutMs: number
  artifactRoot: string
}

/** 数值字段的标识；上下界与宿主 `resolveConfig` 一致。 */
export type NumericField = 'observationTtlMs' | 'confirmationTtlMs' | 'actionTimeoutMs'

/** 数值字段的取值范围；`observationTtlMs` 的 0 表示观察不过期。 */
export const NUMERIC_BOUNDS: Record<NumericField, { min: number; max: number; zeroAllowed: boolean }> = {
  observationTtlMs: { min: 1000, max: 86_400_000, zeroAllowed: true },
  confirmationTtlMs: { min: 1000, max: 900_000, zeroAllowed: false },
  actionTimeoutMs: { min: 1000, max: 120_000, zeroAllowed: false },
}

/** 后端名只有两个取值。 */
function isProvider(value: unknown): value is ComputerProvider {
  return value === 'native' || value === 'cua-driver'
}

/** 策略字段在允许集合内才算合法。 */
function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? value as T : fallback
}

/** 可选文本字段：缺省接受，非字符串视为损坏。 */
function optionalText(value: unknown): { ok: true; value?: string } | { ok: false } {
  if (value === undefined) return { ok: true }
  if (typeof value !== 'string') return { ok: false }
  return { ok: true, value }
}

/**
 * 收窄一条授权；`control` 隐含读取，与宿主归一化保持一致。
 * @param value - 线路上的授权条目。
 * @returns 归一化后的授权；形状不符时为 undefined。
 */
export function decodeGrant(value: unknown): ComputerUseGrant | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.bundleId !== 'string') return undefined
  if (record.read !== undefined && typeof record.read !== 'boolean') return undefined
  if (record.control !== undefined && typeof record.control !== 'boolean') return undefined
  const control = record.control === true
  return { bundleId: record.bundleId, read: record.read === true || control, control }
}

/**
 * 收窄整个命名空间分节；任何字段形状不符时返回 undefined，让镜像保留上一次已知值。
 * @param value - Host 返回的 `computer-use` 分节。
 * @returns 已归一化的设置；形状不符时为 undefined。
 */
export function decodeComputerUseSettings(value: unknown): ComputerUseSettings | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const fields = value as Record<string, unknown>
  if (typeof fields.enabled !== 'boolean' || typeof fields.allowAllApps !== 'boolean') return undefined
  if (!isProvider(fields.provider)) return undefined
  if (typeof fields.observationTtlMs !== 'number' || typeof fields.confirmationTtlMs !== 'number') return undefined
  if (typeof fields.actionTimeoutMs !== 'number' || typeof fields.artifactRoot !== 'string') return undefined
  const helper = fields.helper
  const cuaDriver = fields.cuaDriver
  const interaction = fields.interaction
  const grants = fields.grants
  if (typeof helper !== 'object' || helper === null || Array.isArray(helper)) return undefined
  if (typeof cuaDriver !== 'object' || cuaDriver === null || Array.isArray(cuaDriver)) return undefined
  if (typeof interaction !== 'object' || interaction === null || Array.isArray(interaction)) return undefined
  if (!Array.isArray(grants)) return undefined
  const helperPath = optionalText((helper as Record<string, unknown>).path)
  const driverBin = optionalText((cuaDriver as Record<string, unknown>).bin)
  const driverSession = optionalText((cuaDriver as Record<string, unknown>).session)
  const allowSourceBuild = (helper as Record<string, unknown>).allowSourceBuild
  if (!helperPath.ok || !driverBin.ok || !driverSession.ok) return undefined
  if (allowSourceBuild !== undefined && typeof allowSourceBuild !== 'boolean') return undefined
  const decodedGrants: ComputerUseGrant[] = []
  for (const grant of grants) {
    const decoded = decodeGrant(grant)
    if (decoded === undefined) return undefined
    decodedGrants.push(decoded)
  }
  const interactionFields = interaction as Record<string, unknown>
  return {
    enabled: fields.enabled,
    provider: fields.provider,
    helper: {
      ...helperPath.value === undefined || helperPath.value.trim() === '' ? {} : { path: helperPath.value.trim() },
      ...allowSourceBuild === undefined ? {} : { allowSourceBuild },
    },
    cuaDriver: {
      ...driverBin.value === undefined || driverBin.value.trim() === '' ? {} : { bin: driverBin.value.trim() },
      ...driverSession.value === undefined ? {} : { session: driverSession.value },
    },
    interaction: {
      focusPolicy: pick(interactionFields.focusPolicy, ['preserve', 'activate'] as const, 'preserve'),
      keyboardPolicy: pick(interactionFields.keyboardPolicy, ['preserve', 'activate'] as const, 'preserve'),
      pointerInputPolicy: pick(interactionFields.pointerInputPolicy, ['deny', 'targeted'] as const, 'targeted'),
      cursorVisualization: pick(interactionFields.cursorVisualization, ['hidden', 'visible'] as const, 'visible'),
    },
    allowAllApps: fields.allowAllApps,
    grants: decodedGrants,
    observationTtlMs: fields.observationTtlMs,
    confirmationTtlMs: fields.confirmationTtlMs,
    actionTimeoutMs: fields.actionTimeoutMs,
    artifactRoot: fields.artifactRoot,
  }
}

/** 设置页默认值：与宿主 schema 一致，只在命名空间尚未返回时用于渲染。 */
export const DEFAULT_SETTINGS: ComputerUseSettings = {
  enabled: true,
  provider: 'native',
  helper: {},
  cuaDriver: { session: 'dsh-computer-use' },
  interaction: {
    focusPolicy: 'preserve',
    keyboardPolicy: 'preserve',
    pointerInputPolicy: 'targeted',
    cursorVisualization: 'visible',
  },
  allowAllApps: false,
  grants: [],
  observationTtlMs: 0,
  confirmationTtlMs: 300_000,
  actionTimeoutMs: 15_000,
  artifactRoot: '.dsh-computer-use/artifacts',
}

/**
 * 判断一段文本能否作为按应用授权里的应用标识。
 * @param value - 用户输入的应用标识。
 * @returns 非空、不含空白与通配符且不超过 255 个字符时为 true。
 */
export function validBundleId(value: string): boolean {
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= 255 && !trimmed.includes('*') && !/\s/u.test(trimmed)
}

/**
 * 校验一份授权列表：条目合法且 bundle id 不重复。
 * @param grants - 草稿里的授权列表。
 * @returns 全部条目合法且不重复时为 true。
 */
export function validGrants(grants: readonly ComputerUseGrant[]): boolean {
  const seen = new Set<string>()
  for (const grant of grants) {
    if (!validBundleId(grant.bundleId)) return false
    const key = grant.bundleId.trim()
    if (seen.has(key)) return false
    seen.add(key)
  }
  return true
}

/**
 * 判断截图目录能否写进设置：必须是工作区相对路径且不含 `..`。
 * @param value - 用户输入的目录。
 * @returns 可用作会话工作区相对路径时为 true。
 */
export function validArtifactRoot(value: string): boolean {
  const trimmed = value.trim()
  return trimmed.length > 0 && !trimmed.startsWith('/') && !trimmed.split(/[\\/]+/u).includes('..')
}

/**
 * 校验一个数值字段。
 * @param field - 字段名。
 * @param value - 用户输入的整数。
 * @returns 落在宿主接受的范围内时为 true。
 */
export function validNumeric(field: NumericField, value: number): boolean {
  const bounds = NUMERIC_BOUNDS[field]
  if (!Number.isInteger(value)) return false
  if (value === 0) return bounds.zeroAllowed
  return value >= bounds.min && value <= bounds.max
}

/** 设置页读取的全部状态：分节快照与最近的保存结果。 */
export interface ComputerUseSettingsView {
  section: SettingsScopeSnapshot<ComputerUseSettings>
  saving: boolean
  failed: boolean
}

/** 渲染器把这两个裸 observable 绑定为 `useComputerUseSettings` 与 `useComputerUseAccess`。 */
export interface ComputerUseSettingsFace {
  hooks: {
    computerUseSettings: SnapshotStore<ComputerUseSettingsView>
    computerUseAccess: SnapshotStore<ComputerUseAccessView>
  }
  /** 写入一份草稿；返回是否全部字段都已落盘。 */
  save: (changes: Partial<ComputerUseSettings>) => Promise<boolean>
  /** 让 Host 重新做一次健康检查，结果回到 `computerUseAccess`。 */
  check: () => Promise<void>
  /** 打开 macOS 隐私面板；失败时把原因留在返回文本里。 */
  openPermissionSettings: (kind: 'accessibility' | 'screen-recording') => Promise<boolean>
}

/** 一份设置作用域的生命周期所有者；设置页与将来的入口共用同一份镜像。 */
export class ComputerUseSettingsController {
  /** 设置页读取的快照源；渲染器把它绑定为 `useComputerUseSettings`。 */
  readonly view: SnapshotStore<ComputerUseSettingsView>
  /** 授权与运行结论的快照源，绑定为 `useComputerUseAccess`。 */
  readonly access: SnapshotStore<ComputerUseAccessView>
  private readonly unsubscribe: () => void
  private disposed = false
  private generation = 0
  private accessGeneration = 0

  /**
   * @param scope - `computer-use` 命名空间的镜像与串行写入通道。
   * @param remote - 电脑控制服务的远端面：状态读取、显式检查与打开隐私面板。
   */
  constructor(
    private readonly scope: SettingsScope<ComputerUseSettings>,
    private readonly remote: ComputerUseRemote,
  ) {
    this.view = createSnapshotStore<ComputerUseSettingsView>({
      section: scope.getSnapshot(),
      saving: false,
      failed: false,
    })
    this.access = createSnapshotStore<ComputerUseAccessView>({ status: 'loading', checking: false })
    this.unsubscribe = scope.subscribe(() => {
      const section = scope.getSnapshot()
      this.view.update((draft) => { draft.section = section })
    })
    void this.refreshAccess()
  }

  /**
   * 读取一次授权结论；失败标成 error 而不是保留旧值。
   * 开关或后端刚改过时调用它，让状态带与权限行立刻反映新配置。
   * @returns 读取完成后的结算。
   */
  async refreshAccess(): Promise<void> {
    const generation = ++this.accessGeneration
    const result = await this.remote.status()
    if (this.disposed || generation !== this.accessGeneration) return
    this.access.update((draft) => {
      if (result.ok) {
        draft.status = 'ready'
        draft.value = result.value
      } else {
        draft.status = 'error'
        delete draft.value
      }
    })
  }

  /**
   * 让 Host 做一次显式健康检查：会启动本机组件，可能需要几秒。
   * @returns 检查完成后的结算；失败原因由 Host 写进结论的 `lastError`。
   */
  async check(): Promise<void> {
    const generation = ++this.accessGeneration
    this.access.update((draft) => { draft.checking = true })
    try {
      const result = await this.remote.check()
      if (this.disposed || generation !== this.accessGeneration) return
      this.access.update((draft) => {
        draft.status = result.ok ? 'ready' : 'error'
        if (result.ok) draft.value = result.value
      })
    } finally {
      if (!this.disposed) this.access.update((draft) => { draft.checking = false })
    }
  }

  /**
   * 打开 macOS 隐私面板；插件不授予权限。
   * @param kind - 辅助功能或屏幕录制。
   * @returns 远端接受了这次请求时为 true。
   */
  async openPermissionSettings(kind: 'accessibility' | 'screen-recording'): Promise<boolean> {
    const result = await this.remote.openPermissionSettings(kind)
    return result.ok
  }

  /** 卸载后停止派生，并抛弃晚到的写入结果。 */
  dispose(): void {
    this.disposed = true
    this.generation++
    this.unsubscribe()
  }

  /**
   * slot 的注入面：hooks 供渲染器绑定，`save` 是唯一的写入入口。
   * @returns 该分区的注入面。
   */
  inject(): ComputerUseSettingsFace {
    return {
      hooks: { computerUseSettings: this.view, computerUseAccess: this.access },
      save: changes => this.save(changes),
      check: () => this.check(),
      openPermissionSettings: kind => this.openPermissionSettings(kind),
    }
  }

  /**
   * 逐字段写入一份草稿；字段按对象键顺序提交，任一失败即停止并保留草稿。
   * @param changes - 用户改动过的顶层字段。
   * @returns 全部字段都写入成功时为 true。
   */
  async save(changes: Partial<ComputerUseSettings>): Promise<boolean> {
    const snapshot = this.scope.getSnapshot()
    if (snapshot.status !== 'ready' || !snapshot.writable) return false
    const generation = ++this.generation
    this.view.update((draft) => { draft.saving = true; draft.failed = false })
    try {
      for (const [field, value] of Object.entries(changes) as [string, unknown][]) {
        // 调用方可能显式传 undefined 表示「不改这个字段」；跳过而不是写空值。
        if (value === undefined) continue
        await this.scope.set(field, value)
        if (this.disposed || generation !== this.generation) return false
      }
      return true
    } catch (error) {
      void error
      if (!this.disposed) this.view.update((draft) => { draft.failed = true })
      return false
    } finally {
      if (!this.disposed) this.view.update((draft) => { draft.saving = false })
    }
  }
}

/** 数值字段在表单里的整数字符串；两个有效期按秒展示，动作超时按毫秒。 */
export type NumericText = Record<NumericField, string>

/**
 * 取一个数值字段的编辑单位。
 * @param field - 字段名。
 * @returns 动作超时为 1，两个有效期按秒换算时为 1000。
 */
export function unitOf(field: NumericField): number {
  return field === 'actionTimeoutMs' ? 1 : 1000
}

/**
 * 把存储值换算成输入框文本。
 * @param field - 字段名。
 * @param value - 存储的毫秒值。
 * @returns 整数文本，不带单位。
 */
export function numberText(field: NumericField, value: number): string {
  return String(Math.round(value / unitOf(field)))
}

/**
 * 把输入框文本换算回存储值。
 * @param field - 字段名。
 * @param text - 用户输入的整数文本。
 * @returns 合法时返回毫秒值，否则返回 undefined。
 */
export function numberValue(field: NumericField, text: string): number | undefined {
  if (!/^\d+$/u.test(text.trim())) return undefined
  const value = Number(text.trim()) * unitOf(field)
  return validNumeric(field, value) ? value : undefined
}

/**
 * 取表单三处数值字段的当前输入文本。
 * @param settings - 已存或草稿中的设置。
 * @returns 每个字段的整数字符串。
 */
export function numericTextOf(settings: ComputerUseSettings): NumericText {
  return {
    observationTtlMs: numberText('observationTtlMs', settings.observationTtlMs),
    confirmationTtlMs: numberText('confirmationTtlMs', settings.confirmationTtlMs),
    actionTimeoutMs: numberText('actionTimeoutMs', settings.actionTimeoutMs),
  }
}

/**
 * 把一份草稿收敛成需要写入的字段：只包含与已存值不同的顶层字段，
 * 数值字段先按输入文本校验。草稿不合法时不返回任何改动。
 * @param saved - 服务端接受的当前设置。
 * @param next - 用户正在编辑的整份设置。
 * @param numbers - 三处数值字段的输入文本。
 * @returns 合法时返回待写字段（可能为空对象），否则返回 undefined。
 */
export function collectChanges(
  saved: ComputerUseSettings,
  next: ComputerUseSettings,
  numbers: NumericText,
): Partial<ComputerUseSettings> | undefined {
  const observationTtlMs = numberValue('observationTtlMs', numbers.observationTtlMs)
  const confirmationTtlMs = numberValue('confirmationTtlMs', numbers.confirmationTtlMs)
  const actionTimeoutMs = numberValue('actionTimeoutMs', numbers.actionTimeoutMs)
  if (observationTtlMs === undefined || confirmationTtlMs === undefined || actionTimeoutMs === undefined) return undefined
  if (!validGrants(next.grants) || !validArtifactRoot(next.artifactRoot)) return undefined
  const changes: Partial<ComputerUseSettings> = {}
  if (next.enabled !== saved.enabled) changes.enabled = next.enabled
  if (next.provider !== saved.provider) changes.provider = next.provider
  if (next.provider === 'cua-driver' && (next.cuaDriver.bin ?? '') !== (saved.cuaDriver.bin ?? '')) {
    const session = saved.cuaDriver.session ?? next.cuaDriver.session
    changes.cuaDriver = { ...next.cuaDriver, ...session === undefined ? {} : { session } }
  }
  if (JSON.stringify(next.interaction) !== JSON.stringify(saved.interaction)) changes.interaction = next.interaction
  if (next.allowAllApps !== saved.allowAllApps) changes.allowAllApps = next.allowAllApps
  if (JSON.stringify(next.grants) !== JSON.stringify(saved.grants)) changes.grants = next.grants
  if (observationTtlMs !== saved.observationTtlMs) changes.observationTtlMs = observationTtlMs
  if (confirmationTtlMs !== saved.confirmationTtlMs) changes.confirmationTtlMs = confirmationTtlMs
  if (actionTimeoutMs !== saved.actionTimeoutMs) changes.actionTimeoutMs = actionTimeoutMs
  if (next.artifactRoot.trim() !== saved.artifactRoot.trim()) changes.artifactRoot = next.artifactRoot.trim()
  return changes
}

/** 一项系统权限的观察结果，与 Host 的 `ComputerPermissionState` 同形。 */
export type ComputerPermissionState = 'granted' | 'denied' | 'not-determined' | 'unavailable'

/** 设置页展示的授权与运行结论；来自 Host 的电脑控制服务。 */
export interface ComputerUseAccess {
  enabled: boolean
  platform: string
  provider: 'macos-ax' | 'cua-driver' | 'unsupported'
  ready: boolean
  helperVersion?: string
  accessibility: ComputerPermissionState
  screenRecording: ComputerPermissionState
  lastError?: string
}

/** 授权阅读的三个状态：首次读取、已取得结论、读取失败。 */
export interface ComputerUseAccessView {
  status: 'loading' | 'ready' | 'error'
  value?: ComputerUseAccess
  /** 正在执行的显式检查；与首次读取分开，以便按钮显示自己的忙状态。 */
  checking: boolean
}

/** 远端面的最小形状：由 api-remotes 组合挂载的 `computerUse` 命名空间提供。 */
export interface ComputerUseRemote {
  status: () => Promise<{ ok: true; value: ComputerUseAccess } | { ok: false; error: unknown }>
  check: () => Promise<{ ok: true; value: ComputerUseAccess } | { ok: false; error: unknown }>
  openPermissionSettings: (kind: 'accessibility' | 'screen-recording') =>
  Promise<{ ok: true; value: void } | { ok: false; error: unknown }>
}
