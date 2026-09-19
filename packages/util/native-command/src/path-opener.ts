/**
 * 宿主 UI 集成使用的跨平台原生路径与文本文件打开器。
 *
 * 默认意图会优先用平台可识别的默认浏览器打开可渲染文档，再回退到默认应用。
 * WSL 会先把所有路径转换给 Windows 桌面，不假设 Linux 图形环境；文本编辑意图不查询浏览器。
 * @module @deepseek-ai/dsh-native-command/path-opener
 */

import { release as osRelease } from 'node:os'
import { extname } from 'node:path'
import { runNativeCommand, type NativeCommandRunner } from './runner.ts'

/** 可测试的命令边界；原生实现绝不调用 Shell。 */
export type PathOpenerRunner = NativeCommandRunner

/** 用于确定性适配器测试的可注入平台事实。 */
export interface PathOpenerInternals {
  platform?: NodeJS.Platform
  /** 用于区分 WSL 与桌面 Linux 的内核版本覆盖值。 */
  osRelease?: string
  /** WSL 标记与桌面 Linux 浏览器约定读取的环境。 */
  env?: NodeJS.ProcessEnv
  run?: PathOpenerRunner
}

/** 浏览器能够渲染、而非仅由编辑器编辑的文档。 */
const BROWSER_DOCUMENTS = new Set(['.html', '.htm', '.xhtml', '.svg'])

/**
 * 从 LaunchServices 属性列表中读取为 `https` 注册的 macOS 默认浏览器 bundle。
 * 嵌套版本字典也可能携带 `LSHandlerRoleAll`，因此匹配前先剔除。
 * @param plist - LaunchServices 属性列表文本。
 * @returns 默认浏览器 bundle id；不存在时返回 undefined。
 */
function macBundleForHttps(plist: string): string | undefined {
  const stripped = plist.replace(/LSHandlerPreferredVersions\s*=\s*\{[^}]*\};/g, '')
  const block = /\{[^{}]*LSHandlerURLScheme\s*=\s*"?https"?;[^{}]*\}/.exec(stripped)?.[0]
  if (block === undefined) return undefined
  return /LSHandlerRoleAll\s*=\s*"?([\w.-]+)"?;/.exec(block)?.[1]
}

/**
 * 尝试用默认浏览器打开浏览器可渲染文档。
 * @param path - 要打开的路径。
 * @param signal - 调用方生命周期。
 * @param platform - 宿主平台。
 * @param run - 原生命令运行器。
 * @param env - 浏览器约定读取的环境。
 * @returns 浏览器已接管时为 true；平台无法识别浏览器或识别失败时为 false，调用方随后使用默认应用。
 */
async function openInBrowser(
  path: string,
  signal: AbortSignal,
  platform: NodeJS.Platform,
  run: PathOpenerRunner,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  if (platform === 'darwin') {
    let bundle: string | undefined
    try {
      const { stdout } = await run(
        'defaults', ['read', 'com.apple.LaunchServices/com.apple.launchservices.secure'], signal,
      )
      bundle = macBundleForHttps(stdout)
    } catch {
      // 新账户可能没有默认浏览器记录，此时内容类型处理器本身就是系统选择。
      return false
    }
    if (bundle === undefined) return false
    await run('open', ['-b', bundle, path], signal)
    return true
  }
  if (platform === 'linux') {
    // $BROWSER 是可移植约定；通过 xdg-settings 解析 desktop entry 需要本包不应自带的启动器。
    const browser = env.BROWSER
    if (browser === undefined || browser === '') return false
    await run(browser, [path], signal)
    return true
  }
  // Windows 若不读取 UserChoice 注册表就无法单独命名浏览器；通常的 .html 关联已经指向浏览器。
  return false
}

/** 原生路径打开意图；macOS 会区分默认关联与文本编辑。 */
type PathOpenIntent = 'default' | 'text-editor'

/** 生成 PowerShell 单引号字面量，并把路径内的单引号加倍。 */
function powershellLiteral(path: string): string {
  return `'${path.replace(/'/g, "''")}'`
}

/** 环境标记非空时才视为存在。 */
function present(value: string | undefined): boolean {
  return value !== undefined && value !== ''
}

/** 结合进程与内核标记区分 WSL 和桌面 Linux。 */
function isWsl(internals: PathOpenerInternals): boolean {
  const env = internals.env ?? process.env
  if (present(env.WSL_DISTRO_NAME) || present(env.WSL_INTEROP)) return true
  return (internals.osRelease ?? osRelease()).toLowerCase().includes('microsoft')
}

/** 通过 Windows 注册的桌面应用打开一个 Windows 可解析路径。 */
async function openWindowsPath(path: string, signal: AbortSignal, run: PathOpenerRunner): Promise<void> {
  await run('powershell.exe', [
    '-NoProfile',
    '-Command',
    `Invoke-Item -LiteralPath ${powershellLiteral(path)}`,
  ], signal)
}

/** 把 WSL 路径转换成 Windows 路径后交给 Windows 桌面。 */
async function openWslPath(path: string, signal: AbortSignal, run: PathOpenerRunner): Promise<void> {
  const translated = await run('wslpath', ['-w', path], signal)
  signal.throwIfAborted()
  const windowsPath = translated.stdout.replace(/[\r\n]+$/, '')
  if (windowsPath === '') throw new Error('wslpath returned no Windows path')
  await openWindowsPath(windowsPath, signal, run)
}

/** 按打开意图分派一个不经 Shell 的平台命令。 */
async function openNativePathWithIntent(
  path: string,
  signal: AbortSignal,
  intent: PathOpenIntent,
  internals: PathOpenerInternals = {},
): Promise<void> {
  const platform = internals.platform ?? process.platform
  const run = internals.run ?? runNativeCommand
  const env = internals.env ?? process.env
  const wsl = platform === 'linux' && isWsl(internals)

  if (!wsl && intent === 'default' && BROWSER_DOCUMENTS.has(extname(path).toLowerCase())
    && await openInBrowser(path, signal, platform, run, env)) return

  if (platform === 'darwin') {
    await run('open', intent === 'text-editor' ? ['-t', path] : [path], signal)
    return
  }

  if (platform === 'win32') {
    await openWindowsPath(path, signal, run)
    return
  }

  if (platform === 'linux') {
    if (wsl) {
      await openWslPath(path, signal, run)
      return
    }
    await run('xdg-open', [path], signal)
    return
  }

  throw new Error(`native path opener is unsupported on ${platform}`)
}

/**
 * 判断 {@link openNativePath} 是否可能触达宿主桌面。
 *
 * macOS 与 Windows 总有桌面打开器；Linux 仅在 WSL 或已声明显示服务器时可用。
 * 无头 Linux 返回 false，避免界面提供一个只会把 `xdg-open` 启动到空环境的按钮。
 * @param internals - 用于确定性测试的平台与环境事实。
 * @returns 原生打开器可能有效时为 true。
 */
export function canOpenNativePath(internals: PathOpenerInternals = {}): boolean {
  const platform = internals.platform ?? process.platform
  if (platform === 'darwin' || platform === 'win32') return true
  if (platform !== 'linux') return false
  const env = internals.env ?? process.env
  return isWsl(internals) || present(env.DISPLAY) || present(env.WAYLAND_DISPLAY)
}

/**
 * 用操作系统默认应用打开文件系统路径；浏览器可渲染文档会优先使用默认浏览器。
 * @param path - 绝对路径或宿主可解析路径，解析责任属于调用方。
 * @param signal - 调用方生命周期；取消时终止原生命令。
 * @param internals - 用于确定性测试的平台、环境与运行器钩子。
 * @returns 打开命令完成后的 Promise。
 */
export function openNativePath(
  path: string,
  signal: AbortSignal,
  internals: PathOpenerInternals = {},
): Promise<void> {
  return openNativePathWithIntent(path, signal, 'default', internals)
}

/**
 * 打开文本文件用于编辑；macOS 会绕过文件类型关联，避免 YAML 等关联被浏览器接管。
 * @param path - 绝对路径或宿主可解析的文本文件路径。
 * @param signal - 调用方生命周期；取消时终止原生命令。
 * @param internals - 用于确定性测试的平台与运行器钩子。
 * @returns 打开命令完成后的 Promise。
 */
export function openNativeTextFile(
  path: string,
  signal: AbortSignal,
  internals: PathOpenerInternals = {},
): Promise<void> {
  return openNativePathWithIntent(path, signal, 'text-editor', internals)
}
