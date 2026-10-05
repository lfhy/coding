/** 真实 Loader、agent loop 与 Playwright 提供方固定默认环回导航及无审批 transcript。 */

import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeSessionLog, normalizeStdout } from '@deepseek-ai/dsh-acp-snapshot'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { decodeStorageRecord, packChunkRuns } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'

const fixtureDir = fileURLToPath(new URL('./snapshots/browser-unrestricted-network', import.meta.url))
const configPath = fileURLToPath(new URL('../browser-unrestricted-network.cordis.snapshot.yml', import.meta.url))
const binScript = fileURLToPath(new URL('./fixtures/headless-driver.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const sessionExpected = join(fixtureDir, 'session.expected.jsonl')
const streamExpected = join(fixtureDir, 'stream-json.expected.jsonl')
const refreshing = process.env.DSH_SNAPSHOT === 'refresh'

describe('Unrestricted browser network transcript snapshot', () => {
  it('navigates to loopback with the default Playwright provider and no approval events', async () => {
    const input = JSON.parse(await readFile(join(fixtureDir, 'input.json'), 'utf8')) as {
      steps: { op: string; text: string }[]
    }
    const prompt = input.steps.find(step => step.op === 'prompt')?.text
    if (prompt === undefined) throw new Error('browser-unrestricted-network input has no prompt')
    let context = { sessionIds: [] as string[], cwd: '' }
    const result = await runLoaderSmoke({
      label: 'Unrestricted browser network headless snapshot',
      tempDirPrefix: 'dsh-browser-unrestricted-network-',
      binScript,
      libBinScript: binScript,
      configPath,
      binArgs: [configPath, prompt],
      tsconfigPath,
      env: {
        DSH_SNAPSHOT: 'replay',
        // 首次刷新由 override 驱动；生成后的日志固定组装请求与模型可见结果。
        DSH_SNAPSHOT_FILE: sessionExpected,
        DSH_SNAPSHOT_OVERRIDE: join(fixtureDir, 'replay.override.json'),
      },
      inspect: async (cwd) => {
        const root = join(cwd, '.sessions')
        const files = (await readdir(root, { recursive: true })).filter(file => file.endsWith('.jsonl'))
        expect(files).toHaveLength(1)
        const session = await readFile(join(root, files[0]!), 'utf8')
        const header = JSON.parse(session.split('\n')[0]!) as { id: string }
        context = { sessionIds: [header.id], cwd }
        // 进程外检查实际 goto，而非模型的成功声明；旧默认 ACL 会在此副作用之前拒绝环回地址。
        const calls = (await readFile(join(cwd, 'browser-adapter-calls.jsonl'), 'utf8')).trim().split('\n')
          .map(line => JSON.parse(line) as unknown)
        expect(calls).toEqual([
          { kind: 'new-context', options: {
            viewport: { width: 1280, height: 720 }, acceptDownloads: false, permissions: [],
          } },
          { kind: 'goto', url: 'http://127.0.0.1:59723/browser-unrestricted-network',
            options: { waitUntil: 'domcontentloaded', timeout: 15_000 } },
        ])
        const [headerLine, ...body] = session.trim().split('\n')
        const events = body.flatMap(line => decodeStorageRecord(JSON.parse(line) as unknown))
        const packed = [headerLine, ...packChunkRuns(events).map(record => JSON.stringify(record)), ''].join('\n')
        const normalized = normalizeSessionLog(packed, context)
        expect(events.filter(event => event.type === 'step/start')).toHaveLength(2)
        expect(events.filter(event => event.type === 'tool/call')).toHaveLength(1)
        const results = events.filter(event => event.type === 'tool/result')
        expect(results).toHaveLength(1)
        const resultBlock = results[0]?.data.message.content[0]
        expect(resultBlock, JSON.stringify(resultBlock)).toMatchObject({ toolCallId: 'call_browser_loopback', isError: false })
        const text = resultBlock?.content[0]
        if (text?.type !== 'text') throw new Error('browser navigation did not produce a text observation')
        expect(JSON.parse(text.text) as unknown).toMatchObject({
          action: 'navigate', image: null,
          observation: { revision: 1, url: 'http://127.0.0.1:59723/browser-unrestricted-network',
            title: 'Loopback browser fixture', snapshot: 'Page text:\nLocal network access verified\nElements:\n',
            viewport: { width: 1280, height: 720 }, cursor: null },
        })
        expect(normalized).not.toContain('"type":"approval/asked"')
        expect(normalized).not.toContain('"type":"approval/decided"')
        expect(normalized).toContain('"name":"browser_navigate"')
        expect(normalized).toContain('Local network access verified')
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
      type: 'result', output: 'Observed page title: Loopback browser fixture.',
    })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
