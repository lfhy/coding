import { describe, expect, it } from 'vitest'
import { planWebSnapshotRuns } from './run-web-snapshots.ts'

const base = ['/private/pnpm.cjs', 'exec', 'vitest', 'run', '--config', 'vitest.web.config.ts']

function plan(snapshotMode: string | undefined, workerRaw: string | undefined, availableCpus: number) {
  return planWebSnapshotRuns({ snapshotMode, workerRaw, availableCpus, pnpmEntrypoint: base[0] })
}

describe('web snapshot dispatch', () => {
  it.each([
    ['explicit replay', 'replay', 8, 2],
    ['default replay', undefined, 3, 2],
    ['explicit override', 'replay', 2, 6],
  ] as const)('runs the shared-state owners before a bounded pool for %s', (_label, mode, cpus, workers) => {
    const override = workers === 6 ? '6' : undefined
    expect(plan(mode, override, cpus)).toEqual([
      [...base, 'apps/web/tests/hmr-live.e2e.ts'],
      [...base, 'apps/web/tests/cordis-tool-round.e2e.ts'],
      [
        ...base,
        '--exclude=apps/web/tests/hmr-live.e2e.ts',
        '--exclude=apps/web/tests/cordis-tool-round.e2e.ts',
        '--fileParallelism',
        `--maxWorkers=${workers}`,
      ],
    ])
  })

  it('uses one serial Vitest invocation when only one CPU is available', () => {
    expect(plan('replay', undefined, 1)).toEqual([base])
  })

  it('treats an empty worker override as the default', () => {
    expect(plan('replay', '', 8)).toEqual(plan('replay', undefined, 8))
  })

  it.each(['record', 'refresh'] as const)('keeps %s in one serial Vitest invocation', (mode) => {
    expect(plan(mode, undefined, 8)).toEqual([base])
    expect(plan(mode, '6', 8)).toEqual([base])
  })

  it.each(['0', '1', '1.5', '2x', '02', '-2', '9007199254740992'])('rejects invalid worker override %j', (workerRaw) => {
    expect(() => plan('replay', workerRaw, 8)).toThrow('DSH_WEB_SNAPSHOT_WORKERS must be an integer greater than 1')
  })

  it('rejects invalid snapshot mode before spawning', () => {
    expect(() => plan('unknown', undefined, 8)).toThrow('DSH_SNAPSHOT must be replay, record, or refresh')
  })
})
