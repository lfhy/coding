/** 构建经 SSH 部署的无 Node 依赖 remote agent。 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'

const root = resolve(import.meta.dirname, '..')
const desktopRoot = join(root, 'apps', 'desktop')
const outputRoot = join(root, 'dist', 'remote-agent')

const targets = [
  { goos: 'darwin', goarch: 'amd64' },
  { goos: 'darwin', goarch: 'arm64' },
  { goos: 'linux', goarch: 'amd64' },
  { goos: 'linux', goarch: 'arm64' },
  { goos: 'windows', goarch: 'amd64' },
  { goos: 'windows', goarch: 'arm64' },
] as const

type Target = (typeof targets)[number]

/** 执行一个不经 shell 的 Go 编译命令。 */
function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: desktopRoot, env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`build-remote-agent: ${command} ${args.join(' ')} exited ${String(code)}`))
    })
  })
}

/** 生成与 Manager 选择逻辑一致的发行文件名。 */
function filename(target: Target): string {
  const suffix = target.goos === 'windows' ? '.exe' : ''
  return `coding-remote-agent-${target.goos}-${target.goarch}${suffix}`
}

async function main(): Promise<void> {
  const values = parseArgs({
    args: process.argv.slice(2),
    options: { 'dry-run': { type: 'boolean', default: false } },
  }).values
  const version = process.env.npm_package_version?.trim() || 'dev'
  if (values['dry-run']) {
    for (const target of targets) {
      console.log(`build-remote-agent: GOOS=${target.goos} GOARCH=${target.goarch} ${filename(target)}`)
    }
    return
  }

  await rm(outputRoot, { recursive: true, force: true })
  await mkdir(outputRoot, { recursive: true })
  for (const target of targets) {
    const output = join(outputRoot, filename(target))
    await run('go', [
      'build', '-trimpath', '-ldflags',
      `-s -w -X github.com/deepseek-ai/coding/apps/desktop/internal/remoteagent.AgentVersion=${version}`,
      '-o', output, './cmd/remote-agent',
    ], {
      ...process.env,
      CGO_ENABLED: '0',
      GOOS: target.goos,
      GOARCH: target.goarch,
    })
  }
  await writeFile(join(outputRoot, 'manifest.json'), `${JSON.stringify({
    version,
    protocol: 1,
    artifacts: targets.map(target => ({ ...target, file: filename(target) })),
  }, null, 2)}\n`)
}

await main()
