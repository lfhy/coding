/** Electron helper 启动前的只读路径与环境配置。 */
import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

/** Electron 的两种运行模式共用的输入；平台注入仅用于验证打包限制。 */
export interface RuntimeConfigOptions {
  packaged: boolean
  userHome: string
  resourcesPath: string
  repoRoot: string
  environment: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  arch?: string
}

/** 供主进程设置 userData 和启动 Go helper 的配置，不负责创建目录。 */
export interface RuntimeConfig {
  home: string
  cwd: string
  userData: string
  iconPath: string
  helper: {
    executable: string
    args: string[]
    cwd: string
    env: NodeJS.ProcessEnv
  }
  version: string
}

function absolutePath(path: string, label: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error(`Electron ${label} must be a normalized absolute path`)
  return path
}

async function requireEntry(path: string, kind: 'file' | 'directory', optional = false): Promise<void> {
  let entry
  try {
    entry = await lstat(path)
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new Error(`Electron required ${kind} is unavailable: ${path}`, { cause: error })
  }
  if (entry.isSymbolicLink()) throw new Error(`Electron path must not be a symbolic link: ${path}`)
  if (kind === 'file' ? !entry.isFile() : !entry.isDirectory()) {
    throw new Error(`Electron expected ${kind}: ${path}`)
  }
}

function cleanEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...environment }
  delete env.DSH_REMOTE_BRIDGE_URL
  delete env.DSH_REMOTE_BRIDGE_TOKEN
  delete env.DSH_AGENTS_HOME
  delete env.DSH_HOME
  delete env.DSH_CWD
  delete env.DSH_APP_VERSION
  delete env.CODING_HOST_COMMAND
  delete env.CODING_REPO_ROOT
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  return env
}

async function runtimeVersion(metadataPath: string): Promise<string> {
  await requireEntry(metadataPath, 'file')
  let metadata: unknown
  try {
    metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as unknown
  } catch {
    throw new Error(`Electron invalid runtime metadata: ${metadataPath}`)
  }
  const version = typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>).version : undefined
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version)) {
    throw new Error(`Electron invalid runtime version metadata: ${metadataPath}`)
  }
  return version
}

/**
 * 只读核验打包资源和开发资源，返回 helper 启动参数；生产 Home 须在 helper 抢锁后再检查或创建。
 * @param options - 用户 Home、当前模式、资源路径和原始进程环境。
 * @returns Electron 数据位置与经过隔离的 Go helper 启动配置。
 */
export async function resolveRuntimeConfig(options: RuntimeConfigOptions): Promise<RuntimeConfig> {
  const userHome = absolutePath(options.userHome, 'user home')
  await requireEntry(userHome, 'directory')
  const env = cleanEnvironment(options.environment)
  if (options.packaged) {
    if ((options.platform ?? process.platform) !== 'darwin' || (options.arch ?? process.arch) !== 'arm64') {
      throw new Error('Electron packaged runtime requires macOS arm64')
    }
    const resourcesPath = absolutePath(options.resourcesPath, 'resources path')
    await requireEntry(resourcesPath, 'directory')
    const executable = join(resourcesPath, 'coding-electron-helper')
    const iconPath = join(resourcesPath, 'CodingIcon.png')
    const [version] = await Promise.all([
      runtimeVersion(join(resourcesPath, 'metadata.json')),
      requireEntry(executable, 'file'),
      requireEntry(iconPath, 'file'),
      requireEntry(join(resourcesPath, 'coding-host'), 'file'),
      requireEntry(join(resourcesPath, 'runtime'), 'directory'),
      requireEntry(join(resourcesPath, 'runtime', 'node_modules'), 'directory'),
      requireEntry(join(resourcesPath, 'runtime', 'node_modules', '@deepseek-ai'), 'directory'),
      requireEntry(join(resourcesPath, 'runtime', 'node_modules', '@deepseek-ai', 'dsh'), 'directory'),
      requireEntry(join(resourcesPath, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib'), 'directory'),
      requireEntry(join(resourcesPath, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), 'file'),
      requireEntry(join(resourcesPath, 'remote-agent'), 'directory'),
    ])
    const home = join(userHome, '.dsh')
    const cwd = userHome
    const userData = join(userHome, '.dsh-electron-user-data')
    await requireEntry(userData, 'directory', true)
    return {
      home, cwd, userData, iconPath, version,
      helper: {
        executable,
        args: ['--home', home, '--cwd', cwd, '--host-version', version,
          '--runtime-root', resourcesPath, '--exclusive-wails-instance'],
        cwd, env,
      },
    }
  }

  const repoRoot = absolutePath(options.repoRoot, 'repository root')
  await requireEntry(repoRoot, 'directory')
  const executable = join(repoRoot, 'dist', 'coding-electron-helper-darwin-arm64')
  const iconPath = join(repoRoot, 'apps', 'desktop', 'packaging', 'icon.iconset', 'icon_512x512@2x.png')
  await Promise.all([requireEntry(executable, 'file'), requireEntry(iconPath, 'file')])
  const home = join(userHome, '.dsh-electron-dev')
  const cwd = join(home, 'workspace')
  const userData = join(home, 'electron-user-data')
  await Promise.all([home, cwd, userData].map(path => requireEntry(path, 'directory', true)))
  return {
    home, cwd, userData, iconPath, version: 'dev',
    helper: {
      executable,
      args: ['--home', home, '--cwd', cwd, '--host-version', 'dev', '--repo-root', repoRoot],
      cwd: repoRoot, env,
    },
  }
}
