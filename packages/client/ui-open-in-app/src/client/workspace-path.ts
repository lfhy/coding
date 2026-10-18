/** 工作台文件标签使用的路径归一化；不暴露 Host provider 的内部 target。 */

/**
 * 把一个会话工作区路径转换为工作台可回传的路径段。
 * @param cwd - 会话工作区根目录。
 * @param path - 模型或 UI 提供的文件路径。
 * @returns 工作区内的路径段；无法安全映射时返回 undefined。
 */
export function workspaceFileSegments(cwd: string | undefined, path: string): readonly string[] | undefined {
  if (cwd === undefined || cwd === '' || path === '' || path.includes('\0') || cwd.includes('\0') || path.startsWith('~/')) return undefined
  const normalizedCwd = slashPath(cwd).replace(/\/+$/u, '') || '/'
  const normalizedPath = slashPath(path)
  const windows = isWindowsPath(normalizedCwd)
  const compareCwd = comparable(normalizedCwd, windows)
  const comparePath = comparable(normalizedPath, windows)
  let relative = normalizedPath
  if (isAbsolutePath(normalizedPath)) {
    if (comparePath === compareCwd) return undefined
    const prefix = normalizedCwd === '/' ? '/' : `${normalizedCwd.replace(/\/+$/u, '')}/`
    const comparePrefix = comparable(prefix, windows)
    if (!comparePath.startsWith(comparePrefix)) return undefined
    relative = normalizedPath.slice(prefix.length)
  }
  const segments = relative.split('/').filter(segment => segment !== '' && segment !== '.')
  if (segments.length === 0 || segments.some(segment => segment === '..')) return undefined
  return segments
}

/**
 * 取得工作台文件标签显示的最后一段名称。
 * @param path - 文件路径。
 * @returns 路径最后一段。
 */
export function workspaceFileName(path: string): string {
  const segments = slashPath(path).split('/').filter(segment => segment !== '')
  return segments.at(-1) ?? path
}

function slashPath(value: string): string {
  return value.replaceAll('\\', '/')
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || isWindowsPath(value)
}

function isWindowsPath(value: string): boolean {
  return /^[A-Za-z]:\//u.test(value) || value.startsWith('//')
}

function comparable(value: string, windows: boolean): string {
  return windows ? value.toLocaleLowerCase() : value
}
