/** 经真实 Loader 和 agent loop 固定 Full access 的浏览器结果、无审批审计与模型工具说明。 */

import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeSessionLog, normalizeStdout } from '@deepseek-ai/dsh-acp-snapshot'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { decodeStorageRecord, packChunkRuns } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'

const fixtureDir = fileURLToPath(new URL('./snapshots/browser-full-access', import.meta.url))
const configPath = fileURLToPath(new URL('../browser-full-access.cordis.snapshot.yml', import.meta.url))
const binScript = fileURLToPath(new URL('./fixtures/headless-driver.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const replayOverride = join(fixtureDir, 'replay.override.json')
const sessionExpected = join(fixtureDir, 'session.expected.jsonl')
const streamExpected = join(fixtureDir, 'stream-json.expected.jsonl')
const refreshing = process.env.DSH_SNAPSHOT === 'refresh'

describe('Full access browser transcript snapshot', () => {
  it('executes browser_use without approval through the assembled headless agent', async () => {
    const input = JSON.parse(await readFile(join(fixtureDir, 'input.json'), 'utf8')) as {
      steps: { op: string; text: string }[]
    }
    const prompt = input.steps.find(step => step.op === 'prompt')?.text
    if (prompt === undefined) throw new Error('browser-full-access input has no prompt')
    let context = { sessionIds: [] as string[], cwd: '' }
    const result = await runLoaderSmoke({
      label: 'Full access browser headless snapshot',
      tempDirPrefix: 'dsh-browser-full-access-',
      binScript,
      libBinScript: binScript,
      configPath,
      binArgs: [configPath, prompt],
      tsconfigPath,
      env: {
        DSH_SNAPSHOT: 'replay',
        // 初次刷新由 override 驱动；生成后会话文件提供回放身份，不修改模型脚本。
        DSH_SNAPSHOT_FILE: sessionExpected,
        DSH_SNAPSHOT_OVERRIDE: replayOverride,
      },
      inspect: async (cwd) => {
        const root = join(cwd, '.sessions')
        const files = (await readdir(root, { recursive: true })).filter(file => file.endsWith('.jsonl'))
        expect(files).toHaveLength(1)
        const session = await readFile(join(root, files[0]!), 'utf8')
        const header = JSON.parse(session.split('\n')[0]!) as { id: string }
        context = { sessionIds: [header.id], cwd }
        const calls = (await readFile(join(cwd, 'browser-calls.jsonl'), 'utf8')).trim().split('\n').map(
          line => JSON.parse(line) as unknown,
        )
        expect(calls).toEqual([{
          sessionId: header.id,
          command: { kind: 'navigate', url: 'https://browser.example.invalid/full-access' },
          expectedTarget: { kind: 'none' },
        }])
        const [headerLine, ...body] = session.trim().split('\n')
        const events = body.flatMap(line => decodeStorageRecord(JSON.parse(line) as unknown))
        const packedSession = [headerLine, ...packChunkRuns(events).map(record => JSON.stringify(record)), ''].join('\n')
        const normalized = normalizeSessionLog(packedSession, context)
        expect(normalized).not.toContain('"type":"approval/asked"')
        expect(normalized).not.toContain('"type":"approval/decided"')
        expect(normalized).toContain('Calls require approval except in full-access mode with approval prompts disabled.')
        expect(normalized).toContain('Browser access verified')
        expect(normalized).toContain('"isError":false')
        expect(normalized).not.toContain('"isError":true')
        if (refreshing) await writeFile(sessionExpected, normalized)
        expect(normalized).toBe(await readFile(sessionExpected, 'utf8'))
      },
    })
    expect(result.stderr).toBe('')
    const records = result.stdout.trim().split('\n').map(line => JSON.parse(line) as {
      type: string
      event?: unknown
    })
    const events = records.filter(record => record.type === 'session_event').map(record => record.event)
    const normalizedEvents = normalizeSessionLog(events.map(event => JSON.stringify(event)).join('\n') + '\n', context)
      .trim().split('\n').map(line => JSON.parse(line) as unknown)
    const stream = records.map((record, index) => record.type === 'session_event'
      ? { ...record, event: normalizedEvents[index] }
      : record)
    const normalized = normalizeStdout(stream.map(record => JSON.stringify(record)).join('\n') + '\n', context)
    if (refreshing) await writeFile(streamExpected, normalized)
    expect(normalized).toBe(await readFile(streamExpected, 'utf8'))
    expect(JSON.parse(normalized.trim().split('\n').at(-1)!)).toMatchObject({
      type: 'result', output: 'Observed page title: Full access browser fixture.',
    })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
