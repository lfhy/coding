/**
 * 已解析 open-in-app 应用的 Host 图标提取器。macOS 用 `plutil` 与 `sips`
 * 把 bundle 的 `.icns` 转成 128px PNG；Windows 通过生成的 PowerShell
 * script 把可执行文件关联图标提取为 32px PNG；Linux 沿 desktop entry 的
 * `Icon=` 查找 hicolor 与 pixmaps 中的 PNG／SVG。任何失败都返回 null，
 * 图标路由随后回答 404，由浏览器显示通用 glyph。
 */

import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { OpenInAppApp } from './catalog.ts'
import {
  findDesktopEntry, isFile, output, resolveInternals, specFor, xdgDataDirectories,
  type OpenInAppInternals, type OpenInAppResolvedLaunch, type ResolvedInternals,
} from './resolver.ts'

/** 一个已提取图标：原始字节与路由提供的媒体类型。 */
export interface OpenInAppIcon {
  readonly bytes: Buffer
  readonly contentType: 'image/png' | 'image/svg+xml'
}

/**
 * 把一个 bundle 图标提取为 128px PNG：先从 Info.plist 读取
 * `CFBundleIconFile`，再回退到首个 `Resources/*.icns`，最后在独立临时
 * 目录中用 `sips` 转换。
 */
async function extractBundleIconPng(
  bundlePath: string, timeoutMs: number, internals: ResolvedInternals,
): Promise<Buffer | null> {
  const resources = join(bundlePath, 'Contents', 'Resources')
  let iconFile: string | null = null
  const plistJson = await output(
    'plutil', ['-convert', 'json', '-o', '-', join(bundlePath, 'Contents', 'Info.plist')], timeoutMs, internals)
  if (plistJson !== null) {
    try {
      const declared: unknown = (JSON.parse(plistJson) as { CFBundleIconFile?: unknown }).CFBundleIconFile
      if (typeof declared === 'string' && declared !== '') {
        iconFile = declared.endsWith('.icns') ? declared : `${declared}.icns`
      }
    } catch {
      // plutil JSON 损坏不阻止后续 Resources 扫描。
    }
  }
  if (iconFile === null) {
    try {
      iconFile = (await readdir(resources)).find(entry => entry.endsWith('.icns')) ?? null
    } catch {
      // Resources 目录缺失表示该 bundle 无可用图标。
      return null
    }
  }
  if (iconFile === null) return null
  const icns = join(resources, iconFile)
  try {
    await stat(icns)
  } catch {
    // Info.plist 可能声明磁盘上不存在的图标文件。
    return null
  }
  const workDir = await mkdtemp(join(tmpdir(), 'dsh-open-in-app-'))
  try {
    const outPng = join(workDir, 'icon.png')
    if (await output('sips', ['-s', 'format', 'png', '-Z', '128', icns, '--out', outPng], timeoutMs, internals) === null) {
      return null
    }
    try {
      return await readFile(outPng)
    } catch {
      // sips 即使退出 0 也可能未写出目标文件。
      return null
    }
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

/**
 * Windows 关联图标提取 script。`-File` 位置参数让路径不进入命令文本解析；
 * `ExtractAssociatedIcon` 返回 32px，这是不引入原生 addon 时 .NET 标准
 * 接口能提供的尺寸。
 */
const EXTRACT_ICON_PS1 = [
  'param([string]$Source, [string]$Target)',
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Drawing',
  '$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($Source)',
  'if ($null -eq $icon) { exit 1 }',
  '$bitmap = $icon.ToBitmap()',
  '$bitmap.Save($Target, [System.Drawing.Imaging.ImageFormat]::Png)',
  '',
].join('\n')

/** 把一个 Windows 可执行文件的关联图标提取为 32px PNG。 */
async function extractExecutableIconPng(
  executablePath: string, timeoutMs: number, internals: ResolvedInternals,
): Promise<Buffer | null> {
  const workDir = await mkdtemp(join(tmpdir(), 'dsh-open-in-app-'))
  try {
    const script = join(workDir, 'extract-icon.ps1')
    const outPng = join(workDir, 'icon.png')
    await writeFile(script, EXTRACT_ICON_PS1, 'utf8')
    const ran = await output('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, executablePath, outPng,
    ], timeoutMs, internals)
    if (ran === null) return null
    try {
      return await readFile(outPng)
    } catch {
      // script 即使退出 0 也可能未写出目标文件。
      return null
    }
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

/** 从大到小搜索的主题尺寸；按钮以 15–18 CSS px 渲染。 */
const HICOLOR_SIZES = ['512x512', '256x256', '128x128', '64x64', '48x48', '32x32'] as const

/** 图标扩展名对应的媒体类型。 */
function iconContentType(path: string): OpenInAppIcon['contentType'] | null {
  if (path.endsWith('.png')) return 'image/png'
  if (path.endsWith('.svg')) return 'image/svg+xml'
  return null
}

/** 文件存在且媒体类型可提供时读取一个图标。 */
async function readIconFile(path: string): Promise<OpenInAppIcon | null> {
  const contentType = iconContentType(path)
  if (contentType === null || !await isFile(path)) return null
  return { bytes: await readFile(path), contentType }
}

/**
 * 从大到小在 hicolor 与 pixmaps 目录解析 Linux 图标名。不查询用户当前主题；
 * hicolor 是所有 freedesktop 主题继承的 fallback，只要应用安装了标准图标
 * 即可找到其原始版本。
 */
async function findLinuxThemeIcon(
  name: string, dataDirs: readonly string[],
): Promise<OpenInAppIcon | null> {
  for (const dataDir of dataDirs) {
    for (const size of HICOLOR_SIZES) {
      for (const extension of ['png', 'svg'] as const) {
        const icon = await readIconFile(join(dataDir, 'icons', 'hicolor', size, 'apps', `${name}.${extension}`))
        if (icon !== null) return icon
      }
    }
    const scalable = await readIconFile(join(dataDir, 'icons', 'hicolor', 'scalable', 'apps', `${name}.svg`))
    if (scalable !== null) return scalable
    for (const extension of ['png', 'svg'] as const) {
      const pixmap = await readIconFile(join(dataDir, 'pixmaps', `${name}.${extension}`))
      if (pixmap !== null) return pixmap
    }
  }
  return null
}

/** 从 desktop entry 的 `Icon=` 键提取一个 Linux 应用图标。 */
async function extractLinuxIcon(
  desktopId: string, internals: ResolvedInternals,
): Promise<OpenInAppIcon | null> {
  const entry = await findDesktopEntry(desktopId, internals)
  const icon = entry?.icon
  if (icon === undefined || icon === '') return null
  if (isAbsolute(icon)) return readIconFile(icon)
  return findLinuxThemeIcon(icon, xdgDataDirectories(internals))
}

/**
 * 在当前 Host 提取一个已解析应用的图标。
 * @param app - catalog 条目；Linux spec 在其中命名 desktop entry。
 * @param resolved - 条目的已验证启动信息；macOS／Windows 图标来源位于其中。
 * @param timeoutMs - 图标命令的逐命令期限。
 * @param internals - 用于确定性测试的平台与运行器钩子。
 * @returns 图标字节和媒体类型；当前 Host 无法提供时返回 null。
 */
export async function extractAppIcon(
  app: OpenInAppApp,
  resolved: OpenInAppResolvedLaunch,
  timeoutMs: number,
  internals: OpenInAppInternals = {},
): Promise<OpenInAppIcon | null> {
  const completed = resolveInternals(internals)
  if (completed.platform === 'linux') {
    const desktopId = specFor(app, completed.platform)?.desktopId
    return desktopId === undefined ? null : extractLinuxIcon(desktopId, completed)
  }
  if (resolved.icon === undefined) return null
  if (resolved.icon.kind === 'app-bundle') {
    const bytes = await extractBundleIconPng(resolved.icon.path, timeoutMs, completed)
    return bytes === null ? null : { bytes, contentType: 'image/png' }
  }
  const bytes = await extractExecutableIconPng(resolved.icon.path, timeoutMs, completed)
  return bytes === null ? null : { bytes, contentType: 'image/png' }
}
