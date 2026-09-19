/**
 * open-in-app catalog 的平台解析器。每条 locator 链都会落实为当前 Host 实际
 * 持有的 {@link OpenInAppResolvedLaunch}；一趟解析产出路由提供和启动所用
 * 的映射，点击不会重新探测。PATH 名称经注入的 subprocess 在进程内解析；
 * `xcode-select`、`reg.exe` 等命令经 `dsh-native-command` 以 argv 执行。
 * 应用适配器使用清理过凭据的环境 detached 派生，并遵守 Windows 可见性
 * 策略；文件管理器的 `shell-open` 则经共享路径打开器交给 OS 默认动作。
 */

import { spawn } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir, platform as osPlatform } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import {
  canOpenNativePath, openNativePath, runNativeCommand, type NativeCommandRunner,
} from '@deepseek-ai/dsh-native-command'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import {
  OPEN_IN_APP_CATALOG, PATH_TOKEN,
  type OpenInAppApp, type OpenInAppLaunch, type OpenInAppLocator, type OpenInAppPlatformSpec,
} from './catalog.ts'

/** 当前 Host 保存一个已解析应用图标像素的位置。 */
export type OpenInAppIconSource =
  | { readonly kind: 'app-bundle'; readonly path: string }
  | { readonly kind: 'executable'; readonly path: string }

/** 一个 catalog 条目在当前 Host 的已验证 launcher 与图标来源。 */
export interface OpenInAppResolvedLaunch {
  readonly launch: OpenInAppLaunch
  readonly fallbackLaunch?: OpenInAppLaunch | undefined
  /**
   * 图标像素来源。Linux 由图标路由跟随 spec 的 desktop entry，因此省略；
   * 没有自身 artwork 的 launcher 也省略。
   */
  readonly icon?: OpenInAppIconSource | undefined
}

/** 一次 detached GUI 启动：派生后在窗口内观察早期失败。 */
export type OpenInAppLauncher = (
  command: string,
  args: readonly string[],
  options: {
    readonly watchMs: number
    readonly env?: Readonly<Record<string, string>> | undefined
    readonly windowsHide?: boolean | undefined
  },
) => Promise<void>

/** 一次启动尝试的结果；`missing` 表示 ENOENT 导致的过期解析。 */
export type OpenInAppLaunchOutcome = 'launched' | 'missing' | 'failed'

/**
 * 从当前进程 detached 启动一个应用适配器。子进程取得清理过凭据的环境加
 * 适配器显式覆盖项，不持有 stdio pipe，并可在 dsh 退出后继续运行。Windows
 * GUI 默认可见，除非适配器显式隐藏负责另行打开 GUI 的 CLI。启动成功不等于
 * 进程退出：kitty 与 JetBrains IDE 会在整个窗口生命周期内保持前台，因此
 * 观察窗口只捕获立即失败。窗口内 spawn 失败或非零退出会拒绝；窗口关闭时
 * 仍在运行的 child 会 unref 并计为已启动，绝不 kill。
 * @param command - 可执行文件路径或 PATH 名称。
 * @param args - argv，绝不接受 Shell 字符串。
 * @param options - 观察窗口长度与适配器专用进程选项。
 * @returns 启动计为成功后完成；早期失败时拒绝。
 */
export const launchDetachedApp: OpenInAppLauncher = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      detached: true,
      stdio: 'ignore',
      windowsHide: options.windowsHide,
      env: { ...scrubbedParentEnv(), ...options.env },
    })
    let settled = false
    const settle = (outcome: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(watch)
      child.unref()
      outcome()
    }
    const watch = setTimeout(() => { settle(resolve) }, options.watchMs)
    child.on('error', (error) => { settle(() => { reject(error) }) })
    child.on('exit', (code, signalName) => {
      if (code === 0) settle(resolve)
      else settle(() => { reject(new Error(`launcher exited with code ${String(code)}, signal ${String(signalName)}`)) })
    })
  })

/** 用于确定性测试的可注入平台事实。 */
export interface OpenInAppInternals {
  platform?: NodeJS.Platform
  /** 只来自继承进程层的 SSH 启动事实，与 `.env` 值无关。 */
  ssh?: boolean
  /** 替代 `/Applications` 与 `~/Applications` 的 bundle 根目录。 */
  applicationRoots?: readonly string[]
  /** 候选与注册表值中 `${VAR}`／`%VAR%` 展开的环境。 */
  env?: Readonly<Record<string, string | undefined>>
  /** 替换候选开头 `~/` 的 home 目录。 */
  home?: string
  run?: NativeCommandRunner
  launch?: OpenInAppLauncher
  /** 进程内 PATH 名称解析；名称不在 PATH 时返回 null。 */
  resolveExecutable?: (name: string) => Promise<string | null>
}

/** 每个公开入口执行一次显式默认化后的平台事实。 */
export interface ResolvedInternals {
  platform: NodeJS.Platform
  ssh: boolean
  applicationRoots: readonly string[]
  env: Readonly<Record<string, string | undefined>>
  home: string
  run: NativeCommandRunner
  launch: OpenInAppLauncher
  resolveExecutable: (name: string) => Promise<string | null>
}

/**
 * 根据运行中的 Host 补全可注入事实。`resolveExecutable` 没有 Host 默认值；
 * 插件必须传入 composition 的 subprocess 能力，省略时在此明确失败，而不是
 * 把每个 `cli` locator 静默当成缺失。
 * @param internals - 可注入事实。
 * @returns 已补全事实。
 */
export function resolveInternals(internals: OpenInAppInternals): ResolvedInternals {
  const home = internals.home ?? homedir()
  const resolveExecutable = internals.resolveExecutable
  if (resolveExecutable === undefined) {
    throw new Error('open-in-app: internals.resolveExecutable is required (the subprocess capability provides it)')
  }
  return {
    platform: internals.platform ?? osPlatform(),
    ssh: internals.ssh ?? false,
    applicationRoots: internals.applicationRoots ?? ['/Applications', join(home, 'Applications')],
    env: internals.env ?? process.env,
    home,
    run: internals.run ?? runNativeCommand,
    launch: internals.launch ?? launchDetachedApp,
    resolveExecutable,
  }
}

/** catalog locator 封闭联合的穷尽性栅栏。 */
/* v8 ignore next 3 -- closed catalog union; only reached if an entry is forged */
function assertNever(value: never): never {
  throw new Error(`unhandled open-in-app catalog kind: ${JSON.stringify(value)}`)
}

/**
 * 运行一条有界 Host 命令。
 * @param command - 可执行文件路径或 PATH 名称。
 * @param args - argv，绝不接受 Shell 字符串。
 * @param timeoutMs - 命令期限。
 * @param internals - 已补全平台事实。
 * @returns 退出码为 0 时的 stdout；spawn、非零退出或超时时返回 null。
 */
export async function output(
  command: string, args: readonly string[], timeoutMs: number, internals: ResolvedInternals,
): Promise<string | null> {
  try {
    const { stdout } = await internals.run(command, args, AbortSignal.timeout(timeoutMs))
    return stdout
  } catch {
    // spawn、非零退出和超时在探测中含义相同：不可用。
    return null
  }
}

/**
 * 检查路径是否为现存目录。
 * @param path - 候选路径。
 * @returns 路径存在且为目录时返回 true。
 */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    // ENOENT／EACCES 都表示候选不能证明一个 bundle。
    return false
  }
}

/**
 * 检查路径是否为现存普通文件。
 * @param path - 候选路径。
 * @returns 路径存在且为普通文件时返回 true。
 */
export async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    // ENOENT／EACCES 都表示候选不能证明一个 launcher。
    return false
  }
}

/**
 * 展开 `${VAR}` 引用与开头的 `~/`。展开只做字符串替换，模板在前缀之后的
 * `/` 分隔符保持不变，Win32 path API 可接受该形式。
 * @param template - 候选模板。
 * @param internals - 已补全平台事实。
 * @returns 展开后的候选；任一变量未设置时返回 null。
 */
export function expandCandidate(template: string, internals: ResolvedInternals): string | null {
  const unset: string[] = []
  const expanded = template.replace(/\$\{([^}]+)\}/g, (token, name: string) => {
    const value = internals.env[name]
    if (value === undefined) unset.push(name)
    return value ?? token
  })
  if (unset.length > 0) return null
  return expanded.startsWith('~/') ? join(internals.home, expanded.slice(2)) : expanded
}

/** 展开 Windows 注册表值中的 `%VAR%`；变量未设置时返回 null。 */
function expandRegistryValue(value: string, internals: ResolvedInternals): string | null {
  const unset: string[] = []
  const expanded = value.replace(/%([^%]+)%/g, (token, name: string) => {
    const found = internals.env[name]
    if (found === undefined) unset.push(name)
    return found ?? token
  })
  return unset.length > 0 ? null : expanded
}

/** Windows Uninstall 记录中与 launcher 推导相关的字段。 */
interface WindowsInstallRecord {
  readonly displayName: string
  readonly installLocation?: string | undefined
  readonly displayIcon?: string | undefined
}

/** 单趟解析惰性构建并共享的 Windows 注册表事实。 */
export interface WindowsRegistryView {
  /** 小写注册可执行文件名到其 `App Paths` 默认值。 */
  readonly appPaths: ReadonlyMap<string, string>
  readonly installRecords: readonly WindowsInstallRecord[]
}

/** `App Paths` 根；用户 hive 优先，使逐用户安装覆盖机器安装。 */
const APP_PATHS_ROOTS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths',
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths',
] as const

/** Uninstall 记录根：用户 hive、64 位机器 hive、32 位机器视图。 */
const UNINSTALL_ROOTS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
] as const

/**
 * 把 `reg.exe query <root> /s` 输出解析为逐子键字符串值。`reg.exe` 为每个
 * 子键先打印 key path，再打印缩进 value；默认值标记会本地化，因此通过
 * `REG_*` 类型 token 匹配名称／类型／数据列。
 * @param dump - 原始 `reg.exe` stdout。
 * @returns 子键路径到其按名称索引的 `REG_SZ`／`REG_EXPAND_SZ`；默认值
 *   无论 locale 都规范为 `(Default)`。
 */
export function parseRegistryDump(dump: string): ReadonlyMap<string, ReadonlyMap<string, string>> {
  const keys = new Map<string, Map<string, string>>()
  let current: Map<string, string> | undefined
  for (const line of dump.split(/\r?\n/)) {
    if (/^HK/.test(line)) {
      current = new Map()
      keys.set(line.trim(), current)
      continue
    }
    const value = /^\s+(.*?)\s+(REG_SZ|REG_EXPAND_SZ)\s+(.*)$/.exec(line)
    if (value === null || current === undefined) continue
    // oxlint-disable-next-line typescript/no-non-null-assertion -- 正则命中时两个捕获组必定存在
    const [name, data] = [value[1]!, value[3]!]
    // reg.exe 会本地化默认值标记，但各 locale 都使用括号包裹。
    current.set(/^\(.*\)$/.test(name) ? '(Default)' : name, data.trim())
  }
  return keys
}

/**
 * 构建单趟解析使用的 Windows 注册表事实：`App Paths` 表和 Uninstall
 * 记录，每个 root 执行一次 `reg.exe query /s`。缺失或读取失败的 root
 * 不贡献内容。
 * @param timeoutMs - 每条 `reg.exe` 的期限。
 * @param internals - 已补全平台事实。
 * @returns 已解析视图。
 */
export async function readWindowsRegistryView(
  timeoutMs: number, internals: ResolvedInternals,
): Promise<WindowsRegistryView> {
  const appPaths = new Map<string, string>()
  const installRecords: WindowsInstallRecord[] = []
  for (const root of APP_PATHS_ROOTS) {
    const dump = await output('reg.exe', ['query', root, '/s'], timeoutMs, internals)
    if (dump === null) continue
    for (const [key, values] of parseRegistryDump(dump)) {
      // 注册表 key 在所有运行环境都以 '\' 分隔；测试会在 POSIX 解析 fixture，不能用 path.basename。
      const exe = key.slice(key.lastIndexOf('\\') + 1).toLowerCase()
      const target = values.get('(Default)')
      if (!exe.endsWith('.exe') || target === undefined || appPaths.has(exe)) continue
      const expanded = expandRegistryValue(target.replace(/^"|"$/g, ''), internals)
      if (expanded !== null) appPaths.set(exe, expanded)
    }
  }
  for (const root of UNINSTALL_ROOTS) {
    const dump = await output('reg.exe', ['query', root, '/s'], timeoutMs, internals)
    if (dump === null) continue
    for (const values of parseRegistryDump(dump).values()) {
      const displayName = values.get('DisplayName')
      if (displayName === undefined) continue
      installRecords.push({
        displayName,
        installLocation: values.get('InstallLocation'),
        displayIcon: values.get('DisplayIcon'),
      })
    }
  }
  return { appPaths, installRecords }
}

/** 单趟探测作用域的惰性 holder，保证注册表最多读取一次。 */
class RegistryViewOnce {
  private view: Promise<WindowsRegistryView> | undefined
  constructor(private readonly timeoutMs: number, private readonly internals: ResolvedInternals) {}

  /** 本趟解析的注册表视图，首次使用时读取。 */
  read(): Promise<WindowsRegistryView> {
    this.view ??= readWindowsRegistryView(this.timeoutMs, this.internals)
    return this.view
  }
}

/** Windows Uninstall 记录能证明的可执行文件；无法证明时为 null。 */
async function recordLauncher(
  record: WindowsInstallRecord,
  relativeLauncher: string | undefined,
  internals: ResolvedInternals,
): Promise<string | null> {
  if (relativeLauncher !== undefined && record.installLocation !== undefined && record.installLocation !== '') {
    const expanded = expandRegistryValue(record.installLocation.replace(/^"|"$/g, ''), internals)
    if (expanded !== null) {
      const candidate = join(expanded, relativeLauncher)
      if (await isFile(candidate)) return candidate
    }
  }
  if (record.displayIcon !== undefined) {
    // DisplayIcon 可能带 `,<index>` 后缀，路径也可能被引号包裹。
    const bare = record.displayIcon.replace(/,-?\d+$/, '').replace(/^"|"$/g, '').trim()
    const expanded = expandRegistryValue(bare, internals)
    if (expanded !== null && expanded.toLowerCase().endsWith('.exe') && await isFile(expanded)) return expanded
  }
  return null
}

/** resolver 与图标路由读取的一份 XDG desktop entry 字段。 */
export interface DesktopEntry {
  readonly exec?: string
  readonly tryExec?: string
  readonly icon?: string
}

/**
 * 解析 `[Desktop Entry]` 区段的 `Exec`／`TryExec`／`Icon` 键。
 * @param text - desktop-entry 文件文本。
 * @returns 已识别字段；entry 区段外的键会被忽略。
 */
export function parseDesktopEntry(text: string): DesktopEntry {
  let inEntry = false
  const fields: { exec?: string; tryExec?: string; icon?: string } = {}
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.startsWith('[')) {
      inEntry = trimmed === '[Desktop Entry]'
      continue
    }
    if (!inEntry) continue
    const separator = trimmed.indexOf('=')
    if (separator < 0) continue
    const key = trimmed.slice(0, separator).trim()
    const value = trimmed.slice(separator + 1).trim()
    if (key === 'Exec') fields.exec = value
    else if (key === 'TryExec') fields.tryExec = value
    else if (key === 'Icon') fields.icon = value
  }
  return fields
}

/**
 * 按优先级返回 XDG data 目录：先 `XDG_DATA_HOME`，再 `XDG_DATA_DIRS`。
 * @param internals - 已补全平台事实。
 * @returns 应用 freedesktop 默认值后的 data 目录。
 */
export function xdgDataDirectories(internals: ResolvedInternals): readonly string[] {
  const dataHome = internals.env['XDG_DATA_HOME'] ?? join(internals.home, '.local', 'share')
  const dataDirs = internals.env['XDG_DATA_DIRS'] ?? '/usr/local/share:/usr/share'
  return [dataHome, ...dataDirs.split(':').filter(dir => dir !== '')]
}

/**
 * 按 id 从 XDG application 目录读取一个 desktop entry。
 * @param desktopId - 不带 `.desktop` 后缀的 entry id。
 * @param internals - 已补全平台事实。
 * @returns 已解析 entry；所有目录都不存在时返回 null。
 */
export async function findDesktopEntry(
  desktopId: string, internals: ResolvedInternals,
): Promise<DesktopEntry | null> {
  for (const dataDir of xdgDataDirectories(internals)) {
    const path = join(dataDir, 'applications', `${desktopId}.desktop`)
    try {
      return parseDesktopEntry(await readFile(path, 'utf8'))
    } catch {
      // ENOENT／EACCES 时继续尝试下一个 data 目录。
    }
  }
  return null
}

/**
 * desktop entry 能证明的可执行文件：优先 `TryExec`，否则取 `Exec` 首个 token。
 * 绝对路径在磁盘验证，裸名称经 subprocess 在进程内解析。
 */
async function desktopLauncher(entry: DesktopEntry, internals: ResolvedInternals): Promise<string | null> {
  const candidate = entry.tryExec ?? execCommand(entry.exec)
  if (candidate === null || candidate === '') return null
  if (isAbsolute(candidate)) return await isFile(candidate) ? candidate : null
  return internals.resolveExecutable(candidate)
}

/**
 * 读取 `Exec=` 值的首个 token。
 * @param exec - entry 携带的原始 `Exec=` 值。
 * @returns 引号中的路径或首段非空白文本；缺失或空白时为 null。
 */
export function execCommand(exec: string | undefined): string | null {
  if (exec === undefined) return null
  const quoted = /^"([^"]+)"/.exec(exec)
  if (quoted?.[1] !== undefined) return quoted[1]
  const bare = /^\S+/.exec(exec)
  return bare === null ? null : bare[0]
}

/**
 * 取得 catalog 条目在一个平台上的 spec。
 * @param app - catalog 条目。
 * @param platform - Host 平台。
 * @returns 已声明 spec；不在三个支持平台上时为 undefined。
 */
export function specFor(app: OpenInAppApp, platform: NodeJS.Platform): OpenInAppPlatformSpec | undefined {
  return platform === 'darwin' || platform === 'win32' || platform === 'linux'
    ? app.platforms[platform]
    : undefined
}

/** 已解析可执行文件的图标来源；Windows 从 binary 本身提取。 */
function executableIcon(path: string, internals: ResolvedInternals): OpenInAppIconSource | undefined {
  return internals.platform === 'win32' ? { kind: 'executable', path } : undefined
}

/** 把一个 locator 解析为已验证启动信息；无法证明时返回 null。 */
async function locate(
  locator: OpenInAppLocator,
  probeTimeoutMs: number,
  registry: RegistryViewOnce,
  internals: ResolvedInternals,
): Promise<OpenInAppResolvedLaunch | null> {
  switch (locator.kind) {
    case 'fixed': {
      // fixed 条目随 OS 提供，图标路径无需预探测；意外缺失会在提取时回答 404。
      // 只有 `${SystemRoot}` 等变量未设置时才放弃图标声明。
      const iconPath = expandCandidate(locator.iconPath, internals)
      const icon = iconPath === null
        ? undefined
        : internals.platform === 'win32'
          ? { kind: 'executable' as const, path: iconPath }
          : { kind: 'app-bundle' as const, path: iconPath }
      return { launch: locator.launch, icon }
    }
    case 'app': {
      for (const root of internals.applicationRoots) {
        for (const fsName of locator.fsNames) {
          const bundle = join(root, fsName)
          if (await isDirectory(bundle)) {
            return {
              launch: { kind: 'argv', command: 'open', args: ['-a', bundle] },
              icon: { kind: 'app-bundle', path: bundle },
            }
          }
        }
      }
      return null
    }
    case 'xcode': {
      const developer = await output('xcode-select', ['-p'], probeTimeoutMs, internals)
      if (developer === null) return null
      const bundle = dirname(dirname(developer.trim()))
      if (!bundle.endsWith('.app') || !await isDirectory(bundle)) return null
      return {
        launch: { kind: 'argv', command: 'xed', args: [] },
        fallbackLaunch: { kind: 'argv', command: 'open', args: ['-a', bundle] },
        icon: { kind: 'app-bundle', path: bundle },
      }
    }
    case 'cli': {
      if (locator.requiresDesktop === true && !canOpenNativePath({
        platform: internals.platform,
        env: { ...internals.env },
      })) return null
      const found = await internals.resolveExecutable(locator.name)
      return found === null
        ? null
        : { launch: { kind: 'argv', command: found, args: locator.args }, icon: executableIcon(found, internals) }
    }
    case 'file': {
      for (const candidate of locator.candidates) {
        const path = expandCandidate(candidate, internals)
        if (path !== null && await isFile(path)) {
          return { launch: { kind: 'argv', command: path, args: locator.args }, icon: executableIcon(path, internals) }
        }
      }
      return null
    }
    case 'scan': {
      const root = expandCandidate(locator.root, internals)
      if (root === null) return null
      let entries: string[]
      try {
        entries = await readdir(root)
      } catch {
        // 根目录缺失或不可读表示没有可扫描的安装目录。
        return null
      }
      // 版本后缀目录使用数字感知比较并取最新项，避免字典序误排 2024.1.10 与 2024.1.9。
      const versions = entries.filter(entry => entry.startsWith(locator.namePrefix))
        .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
      for (const version of versions) {
        const launcher = join(root, version, locator.relativeLauncher)
        if (await isFile(launcher)) {
          return { launch: { kind: 'argv', command: launcher, args: locator.args }, icon: executableIcon(launcher, internals) }
        }
      }
      return null
    }
    case 'app-paths': {
      const target = (await registry.read()).appPaths.get(locator.exe.toLowerCase())
      if (target === undefined || !await isFile(target)) return null
      return { launch: { kind: 'argv', command: target, args: locator.args }, icon: { kind: 'executable', path: target } }
    }
    case 'install-record': {
      for (const record of (await registry.read()).installRecords) {
        if (!record.displayName.startsWith(locator.displayNamePrefix)) continue
        const launcher = await recordLauncher(record, locator.relativeLauncher, internals)
        if (launcher !== null) {
          return { launch: { kind: 'argv', command: launcher, args: locator.args }, icon: { kind: 'executable', path: launcher } }
        }
      }
      return null
    }
    case 'github-desktop': {
      const root = expandCandidate(locator.root, internals)
      if (root === null) return null
      let versions: string[]
      try {
        versions = (await readdir(root))
          .filter(entry => entry.startsWith('app-'))
          .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
      } catch {
        // 安装根缺失或不可读表示 GitHub Desktop 不可用。
        return null
      }
      for (const version of versions) {
        const directory = join(root, version)
        const executable = join(directory, 'GitHubDesktop.exe')
        const cli = join(directory, 'resources', 'app', 'cli.js')
        if (await isFile(executable) && await isFile(cli)) {
          return {
            launch: {
              kind: 'argv',
              command: executable,
              args: [cli, 'open'],
              env: { ELECTRON_RUN_AS_NODE: '1' },
              windowsHide: true,
            },
            icon: { kind: 'executable', path: executable },
          }
        }
      }
      return null
    }
    case 'desktop': {
      const entry = await findDesktopEntry(locator.desktopId, internals)
      if (entry === null) return null
      const launcher = await desktopLauncher(entry, internals)
      return launcher === null ? null : { launch: { kind: 'argv', command: launcher, args: locator.args } }
    }
    /* v8 ignore next -- closed locator union */
    default: return assertNever(locator)
  }
}

/**
 * 在当前 Host 解析一个 catalog 条目：按顺序尝试当前平台 locator，首个已验证
 * launcher 胜出。
 * @param app - catalog 条目。
 * @param probeTimeoutMs - 解析 Host 命令的逐命令期限。
 * @param internals - 用于确定性测试的平台与运行器钩子。
 * @returns 已验证启动信息；SSH 启动或当前机器未安装时返回 null。
 */
export async function resolveLaunch(
  app: OpenInAppApp, probeTimeoutMs: number, internals: OpenInAppInternals = {},
): Promise<OpenInAppResolvedLaunch | null> {
  const resolved = resolveInternals(internals)
  if (resolved.ssh) return null
  return resolveWithRegistry(app, probeTimeoutMs, new RegistryViewOnce(probeTimeoutMs, resolved), resolved)
}

/** 使用单趟共享注册表视图解析一个条目。 */
async function resolveWithRegistry(
  app: OpenInAppApp,
  probeTimeoutMs: number,
  registry: RegistryViewOnce,
  internals: ResolvedInternals,
): Promise<OpenInAppResolvedLaunch | null> {
  const platformSpec = specFor(app, internals.platform)
  if (platformSpec === undefined) return null
  for (const locator of platformSpec.locators) {
    const found = await locate(locator, probeTimeoutMs, registry, internals)
    if (found !== null) return found
  }
  return null
}

/**
 * 一次解析完整 catalog，按菜单顺序得到当前 Host 上每个条目的已验证 launcher。
 * Windows 注册表每趟最多读取一次。返回 Map 是调用方拥有的可变权威；路由提供
 * 其 keys 并启动其 values，`ENOENT` 后会原地替换或移除过期条目。SSH 启动
 * 不执行探测，直接返回空 Map。
 * @param probeTimeoutMs - 解析 Host 命令的逐命令期限。
 * @param internals - 用于确定性测试的平台与运行器钩子。
 * @returns 按 catalog 顺序排列的 id 到已验证启动信息。
 */
export async function resolveOpenInAppApps(
  probeTimeoutMs: number, internals: OpenInAppInternals = {},
): Promise<Map<string, OpenInAppResolvedLaunch>> {
  const resolved = resolveInternals(internals)
  if (resolved.ssh) {
    return new Map()
  }
  const registry = new RegistryViewOnce(probeTimeoutMs, resolved)
  const entries = await Promise.all(OPEN_IN_APP_CATALOG.map(async app =>
    [app.id, await resolveWithRegistry(app, probeTimeoutMs, registry, resolved)] as const))
  const map = new Map<string, OpenInAppResolvedLaunch>()
  for (const [id, launch] of entries) {
    if (launch !== null) map.set(id, launch)
  }
  return map
}

/** 把目录替换进启动 argv 的 token；没有参数携带 token 时追加目录。 */
function launchArgs(args: readonly string[], path: string): readonly string[] {
  return args.some(arg => arg.includes(PATH_TOKEN))
    ? args.map(arg => arg.replaceAll(PATH_TOKEN, path))
    : [...args, path]
}

/** 启动拒绝是否表示可执行文件缺失，即解析已过期。 */
function isMissingExecutable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

/**
 * 在启动观察窗口内通过 OS 默认 open 动作打开目录。窗口内完成的命令决定结果；
 * 窗口关闭时仍运行的 opener 计为已启动并继续运行。冷启动 `powershell.exe`
 * 可能超过窗口，其晚到 settlement 会被消费，因为请求已经回答。
 */
function runShellOpen(
  path: string, watchMs: number, internals: ResolvedInternals,
): Promise<OpenInAppLaunchOutcome> {
  const opening = openNativePath(path, new AbortController().signal, {
    platform: internals.platform, run: internals.run, env: internals.env,
  })
  return new Promise((resolve) => {
    const watch = setTimeout(() => {
      opening.catch(() => {
        // opener 已被窗口计为成功，晚到失败只需被消费。
      })
      resolve('launched')
    }, watchMs)
    opening.then(
      () => {
        clearTimeout(watch)
        resolve('launched')
      },
      (error: unknown) => {
        clearTimeout(watch)
        resolve(isMissingExecutable(error) ? 'missing' : 'failed')
      },
    )
  })
}

/** 执行一个 launcher 并分类结果。 */
async function runLaunch(
  launch: OpenInAppLaunch, path: string, watchMs: number, internals: ResolvedInternals,
): Promise<OpenInAppLaunchOutcome> {
  switch (launch.kind) {
    case 'shell-open':
      return runShellOpen(path, watchMs, internals)
    case 'argv':
      try {
        await internals.launch(launch.command, launchArgs(launch.args, path), {
          watchMs,
          ...(launch.env === undefined ? {} : { env: launch.env }),
          ...(launch.windowsHide === undefined ? {} : { windowsHide: launch.windowsHide }),
        })
        return 'launched'
      } catch (error: unknown) {
        // 可执行文件缺失表示解析过期，调用方会重解析一次；其它 spawn 或早退
        // 失败都表示 launcher 未打开任何内容，调用方仍可尝试 fallback。
        return isMissingExecutable(error) ? 'missing' : 'failed'
      }
    /* v8 ignore next -- closed launch union */
    default: return assertNever(launch)
  }
}

/**
 * 在目录上启动已解析应用：先尝试 primary，观察窗口内失败时再尝试 fallback。
 * @param resolved - 条目的已验证 launcher。
 * @param path - 已由路由校验的绝对工作区目录。
 * @param watchMs - 每个 launcher 的早期失败窗口；关闭时仍运行的 child 计为成功。
 * @param internals - 用于确定性测试的 launcher 钩子。
 * @returns 尝试结果；已尝试 launcher 的可执行文件消失时为 `missing`，提示调用方重解析一次。
 */
export async function launchResolved(
  resolved: OpenInAppResolvedLaunch, path: string, watchMs: number, internals: OpenInAppInternals = {},
): Promise<OpenInAppLaunchOutcome> {
  const completed = resolveInternals(internals)
  const primary = await runLaunch(resolved.launch, path, watchMs, completed)
  if (primary === 'launched' || resolved.fallbackLaunch === undefined) return primary
  const fallback = await runLaunch(resolved.fallbackLaunch, path, watchMs, completed)
  if (fallback === 'launched') return 'launched'
  // 任一已尝试 launcher 消失都足以刷新解析。
  return primary === 'missing' || fallback === 'missing' ? 'missing' : 'failed'
}
