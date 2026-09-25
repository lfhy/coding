/** 构建 Electron 壳使用的本机 Go helper；签名由打包步骤负责。 */

import { spawn } from 'node:child_process'
import { lstat, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const repositoryRoot = resolve(import.meta.dirname, '..')
const remoteAgentFiles = [
  'manifest.json',
  'coding-remote-agent-darwin-amd64',
  'coding-remote-agent-darwin-arm64',
  'coding-remote-agent-linux-amd64',
  'coding-remote-agent-linux-arm64',
  'coding-remote-agent-windows-amd64.exe',
  'coding-remote-agent-windows-arm64.exe',
] as const

type Run = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<void>

interface BuildOptions {
  platform?: string
  arch?: string
  root?: string
  requireRemoteAgent?: boolean
  isRegularFile?: (path: string) => Promise<boolean>
  run?: Run
}

function runCommand(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { ...options, stdio: 'inherit', shell: false })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`build:electron-helper: ${command} exited with ${String(code ?? signal)}`))
    })
  })
}

async function isRegularFile(path: string): Promise<boolean> {
  const entry = await lstat(path).catch(() => undefined)
  return entry?.isFile() === true
}

/**
 * 构建与当前 macOS arm64 主机匹配的 helper，可为开发流程校验远端 agent 闭包。
 * @param options - 本机平台、仓库目录及供定向测试替换的文件/进程入口。
 * @returns Go 构建成功后结算的 Promise；不创建安装包或进行签名。
 */
export async function buildElectronHelper(options: BuildOptions = {}): Promise<void> {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  if (platform !== 'darwin' || arch !== 'arm64') {
    throw new Error(`build:electron-helper: only native macOS arm64 is supported (got ${platform}/${arch})`)
  }

  const root = options.root ?? repositoryRoot
  if (options.requireRemoteAgent) {
    const exists = options.isRegularFile ?? isRegularFile
    const missing = (await Promise.all(remoteAgentFiles.map(async file => ({ file, present: await exists(join(root, 'dist', 'remote-agent', file)) }))))
      .filter(entry => !entry.present).map(entry => entry.file)
    if (missing.length !== 0) {
      throw new Error(`build:electron-helper: missing remote-agent artifacts (${missing.join(', ')}); run pnpm run build:remote-agent first`)
    }
  }

  const output = join(root, 'dist', 'coding-electron-helper-darwin-arm64')
  await mkdir(join(root, 'dist'), { recursive: true })
  await (options.run ?? runCommand)('go', [
    'build', '-trimpath', '-buildvcs=false', '-o', output, './cmd/electron-helper',
  ], {
    cwd: join(root, 'apps', 'desktop'),
    env: { ...process.env, CGO_ENABLED: '1', GOOS: 'darwin', GOARCH: 'arm64' },
  })
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: { 'require-remote-agent': { type: 'boolean', default: false } },
    allowPositionals: false,
  })
  await buildElectronHelper({ requireRemoteAgent: values['require-remote-agent'] })
}
