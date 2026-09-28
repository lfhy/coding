/** 在回放模式先运行共享状态用例，再启动有界并行的浏览器测试。 */
import { spawn } from 'node:child_process'
import { availableParallelism } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const serialFiles = [
  'apps/web/tests/hmr-live.e2e.ts',
  'apps/web/tests/cordis-tool-round.e2e.ts',
]

interface WebSnapshotOptions {
  snapshotMode: string | undefined
  workerRaw: string | undefined
  availableCpus: number
  pnpmEntrypoint: string | undefined
}

/**
 * 规划浏览器测试进程；录制及刷新不得与其他文件同时写入快照。
 * @param options 快照模式、显式 worker 数、可用 CPU 数与 pnpm 入口。
 * @returns 按执行顺序排列的 Node 参数列表。
 */
export function planWebSnapshotRuns(options: WebSnapshotOptions): string[][] {
  const { snapshotMode, workerRaw, availableCpus, pnpmEntrypoint } = options
  if (snapshotMode !== undefined && snapshotMode !== '' && !['replay', 'record', 'refresh'].includes(snapshotMode)) {
    throw new Error(`DSH_SNAPSHOT must be replay, record, or refresh; got ${JSON.stringify(snapshotMode)}`)
  }
  if (workerRaw !== undefined && workerRaw !== ''
    && (!/^[1-9]\d*$/.test(workerRaw) || !Number.isSafeInteger(Number(workerRaw)) || Number(workerRaw) < 2)) {
    throw new Error(`DSH_WEB_SNAPSHOT_WORKERS must be an integer greater than 1, got ${JSON.stringify(workerRaw)}.`)
  }
  if (pnpmEntrypoint === undefined || pnpmEntrypoint === '') {
    throw new Error('web snapshots must be invoked through a pnpm package script.')
  }

  const baseArgs = [pnpmEntrypoint, 'exec', 'vitest', 'run', '--config', 'vitest.web.config.ts']
  const workers = workerRaw === undefined || workerRaw === '' ? Math.min(2, availableCpus) : Number(workerRaw)
  if (snapshotMode === 'record' || snapshotMode === 'refresh' || workers < 2) return [baseArgs]

  return [
    ...serialFiles.map(file => [...baseArgs, file]),
    [
      ...baseArgs,
      ...serialFiles.map(file => `--exclude=${file}`),
      '--fileParallelism',
      `--maxWorkers=${String(workers)}`,
    ],
  ]
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const runs = planWebSnapshotRuns({
    snapshotMode: process.env.DSH_SNAPSHOT,
    workerRaw: process.env.DSH_WEB_SNAPSHOT_WORKERS,
    availableCpus: availableParallelism(),
    pnpmEntrypoint: process.env.npm_execpath,
  })
  for (const args of runs) {
    process.exitCode = await run(args)
    if (process.exitCode !== 0) break
  }
}

function run(args: string[]): Promise<number> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (exitCode, signalCode) => {
      if (signalCode !== null) {
        console.error(`web snapshots terminated by ${signalCode}`)
        resolveRun(1)
        return
      }
      resolveRun(exitCode ?? 1)
    })
  })
}
