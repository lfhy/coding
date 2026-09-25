/** Electron 开发数据目录的实际路径检查，先拒绝串用再创建子目录。 */
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'

/** 启动器持有的开发目录和必须避开的另两套 Home。 */
export interface DevelopmentDirectories {
  hostHome: string
  installedHome: string
  wailsDevelopmentHome: string
  userData: string
  workspace: string
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

/**
 * 在创建 userData/workspace 前核验开发 Home，避免已有符号链接污染安装版。
 * @param paths - 三套 Home 及 Electron 两个子目录的绝对路径。
 * @returns 私有子目录已创建并确认仍在开发 Home 内时完成。
 */
export async function prepareDevelopmentDirectories(paths: DevelopmentDirectories): Promise<void> {
  await mkdir(paths.hostHome, { recursive: true, mode: 0o700 })
  // macOS 的 /var 可能解析到 /private/var；只拒绝开发 Home 自身的链接。
  if ((await lstat(paths.hostHome)).isSymbolicLink()) {
    throw new Error('Electron development home must not be a symbolic link')
  }
  const actualHome = await realpath(paths.hostHome)
  for (const otherHome of [paths.installedHome, paths.wailsDevelopmentHome]) {
    let actualOtherHome: string
    try {
      actualOtherHome = await realpath(otherHome)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (isWithin(actualOtherHome, actualHome) || isWithin(actualHome, actualOtherHome)) {
      throw new Error('Electron development home overlaps another Coding home')
    }
  }

  await Promise.all([paths.userData, paths.workspace].map(path => mkdir(path, { recursive: true, mode: 0o700 })))
  const [actualUserData, actualWorkspace] = await Promise.all([
    realpath(paths.userData), realpath(paths.workspace),
  ])
  if (!isWithin(actualHome, actualUserData) || !isWithin(actualHome, actualWorkspace)) {
    throw new Error('Electron development directories must stay inside their private home')
  }
}
