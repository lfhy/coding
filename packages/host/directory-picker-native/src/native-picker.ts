/** Cross-platform native single-directory chooser behind the native backend's capability. */

import { runNativeCommand, type NativeCommandRunner } from '@deepseek-ai/dsh-native-command'
import { pickWin32Directory } from './win32-dialog.ts'

/** Testable command boundary; native implementations never invoke a shell. */
export type DirectoryPickerRunner = NativeCommandRunner

/** Injectable platform facts for deterministic adapter tests. */
export interface DirectoryPickerInternals {
  platform?: NodeJS.Platform
  run?: DirectoryPickerRunner
  /** Replaces the in-process Win32 dialog (`pickWin32Directory`) for deterministic tests. */
  pickWin32Dialog?: (signal: AbortSignal) => Promise<string | null>
}

function outputPath(stdout: string): string | null {
  const path = stdout.replace(/[\r\n]+$/, '')
  return path === '' ? null : path
}

function errorCode(error: unknown): string | number | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' || typeof code === 'number' ? code : undefined
}

function isMissingCommand(error: unknown): boolean {
  return errorCode(error) === 'ENOENT'
}

function rethrowIfAborted(signal: AbortSignal, error: unknown): void {
  if (signal.aborted) throw error
}

/**
 * macOS 目录面板的 JXA 脚本。
 *
 * AppleScript 的 `choose folder` 由无 bundle 的 osascript 进程呈现面板，宿主由桌面壳或
 * 后台进程启动时该面板只会被创建而不上屏，调用方要等到 AppleEvent 超时（-1712）才拿到
 * 错误。脚本改为在进程内构造 `NSOpenPanel`、显式激活应用后再 `runModal`，面板才会出现在
 * 屏幕上。取消时返回空串，由 `outputPath` 折叠为 null；脚本失败仍以 osascript 的退出码和
 * stderr 上报，不设回退层级。
 */
const MACOS_PICK_SCRIPT = [
  'ObjC.import("AppKit")',
  'const app = $.NSApplication.sharedApplication',
  'app.setActivationPolicy(1)',
  'app.activateIgnoringOtherApps(true)',
  'const panel = $.NSOpenPanel.openPanel',
  'panel.setCanChooseDirectories(true)',
  'panel.setCanChooseFiles(false)',
  'panel.setAllowsMultipleSelection(false)',
  'panel.setMessage("Select Workspace Directory")',
  'const response = panel.runModal',
  'response === 1 ? ObjC.unwrap(panel.URLs.objectAtIndex(0).path) : ""',
].join('; ')

/**
 * 打开平台目录选择器。
 * @param signal - 调用方/连接的生命周期；中止会终止原生命令。
 * @param internals - 平台与运行器钩子，供测试确定性地替换真实实现。
 * @returns 所选路径；用户取消时为 null。
 */
export async function pickNativeDirectory(
  signal: AbortSignal,
  internals: DirectoryPickerInternals = {},
): Promise<string | null> {
  const platform = internals.platform ?? process.platform
  const run = internals.run ?? runNativeCommand

  if (platform === 'darwin') {
    const result = await run('osascript', ['-l', 'JavaScript', '-e', MACOS_PICK_SCRIPT], signal)
    return outputPath(result.stdout)
  }

  if (platform === 'win32') {
    // The koffi-backed IFileOpenDialog child process — the modern picker with
    // per-monitor-v2 DPI and abort support. koffi is a packaged dependency
    // whose availability the install guarantees, so there is no fallback
    // tier: any failure surfaces as-is (no PowerShell fallback tier; see
    // .agents/notes/implemented/simplification/2026-08-04-drop-windows-powershell-picker-fallback.md).
    const pickDialog = internals.pickWin32Dialog ?? pickWin32Directory
    return await pickDialog(signal)
  }

  if (platform === 'linux') {
    try {
      const result = await run('zenity', [
        '--file-selection', '--directory', '--title=Select Workspace Directory',
      ], signal)
      return outputPath(result.stdout)
    } catch (error: unknown) {
      rethrowIfAborted(signal, error)
      if (errorCode(error) === 1) return null
      if (!isMissingCommand(error)) throw error
    }

    try {
      const result = await run('kdialog', [
        '--getexistingdirectory', '.', '--title', 'Select Workspace Directory',
      ], signal)
      return outputPath(result.stdout)
    } catch (error: unknown) {
      rethrowIfAborted(signal, error)
      if (errorCode(error) === 1) return null
      if (isMissingCommand(error)) {
        throw new Error('no supported native directory picker found (install zenity or kdialog)')
      }
      throw error
    }
  }

  throw new Error(`native directory picker is unsupported on ${platform}`)
}
