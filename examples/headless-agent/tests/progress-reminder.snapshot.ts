/** 经真实 Loader 与 headless app 固定正文之后的工具计数，以及后续阈值提醒。 */

import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeSessionLog, normalizeStdout, scrubRequestHeaders } from 'coding-acp-snapshot'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from 'coding-loader-smoke'
import { decodeStorageRecord, packChunkRuns, type SessionEvent } from 'coding-session'
import { describe, expect, it } from 'vitest'

const fixtureDir = fileURLToPath(new URL('./snapshots/progress-reminder', import.meta.url))
const configPath = fileURLToPath(new URL('../progress-reminder.cordis.snapshot.yml', import.meta.url))
const binScript = fileURLToPath(new URL('./fixtures/headless-driver.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const sessionExpected = join(fixtureDir, 'session.expected.jsonl')
const streamExpected = join(fixtureDir, 'stream-json.expected.jsonl')
const refreshing = process.env.DSH_SNAPSHOT === 'refresh'
const task = 'Complete the scripted work, reporting progress before the first reminder threshold.'

interface StreamRecord {
  type: 'session_event' | 'result'
  sessionId: string
  event?: SessionEvent
  output?: string
}

describe('progress reminder transcript snapshot', () => {
  it('counts only tool results after assistant text and reminds again at the next threshold', async () => {
    let context = { sessionIds: [] as string[], cwd: '' }
    const result = await runLoaderSmoke({
      label: 'progress reminder headless snapshot',
      tempDirPrefix: 'headless-snapshot-progress-reminder-',
      binScript,
      libBinScript: binScript,
      configPath,
      binArgs: [configPath, task],
      tsconfigPath,
      env: {
        DSH_SNAPSHOT: 'replay',
        DSH_SNAPSHOT_FILE: sessionExpected,
        DSH_SNAPSHOT_OVERRIDE: join(fixtureDir, 'replay.override.json'),
      },
      inspect: async (cwd) => {
        const root = join(cwd, '.sessions')
        const files = (await readdir(root, { recursive: true })).filter(file => file.endsWith('.jsonl'))
        expect(files).toHaveLength(1)
        const session = await readFile(join(root, files[0]!), 'utf8')
        const [headerLine, ...body] = session.trim().split('\n')
        const header = JSON.parse(headerLine!) as { id: string }
        context = { sessionIds: [header.id], cwd }
        const events = body.flatMap(line => decodeStorageRecord(JSON.parse(line) as unknown))
        const calls = events.filter(event => event.type === 'tool/call')
        expect(calls.map(event => event.data.name)).toEqual(Array<string>(8).fill('todo_write'))
        expect(events.filter(event => event.type === 'tool/result').map(event => event.data.message.content[0]?.isError))
          .toEqual(Array<boolean>(8).fill(false))

        const assistants = events.filter(event => event.type === 'assistant/message')
        expect(assistants.map(event => event.data.step)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
        expect(assistants[1]?.data.message.content.map(block => block.type)).toEqual(['text', 'tool-call'])
        expect(assistants[2]?.data.message.content.map(block => block.type)).toEqual(['text', 'reasoning', 'tool-call'])

        const reminders = events.filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message'
          && event.data.source.kind === 'plugin' && event.data.source.plugin === 'progress-reminder')
        // 正文前的两次结果不能让第三步提前提醒；空白正文和推理也不能清零后续计数。
        expect(reminders.map(reminder => ({
          step: events.findLast(event => event.seq < reminder.seq && event.type === 'step/start')?.data,
          completedTools: events.filter(event => event.seq < reminder.seq && event.type === 'tool/result').length,
        }))).toEqual([
          { step: { turn: 1, step: 5 }, completedTools: 5 },
          { step: { turn: 1, step: 8 }, completedTools: 8 },
        ])
        for (const reminder of reminders) {
          expect(reminder.data.content).toHaveLength(1)
          const block = reminder.data.content[0]
          if (block?.type !== 'text') throw new Error('progress reminder did not contain one text block')
          expect(block.text).toContain('你已连续执行 3 次工具调用')
        }
        expect(events.findLast(event => event.type === 'todo/write')?.data.todos)
          .toEqual([{ content: 'Finish the progress reminder proof', status: 'completed' }])
        expect(events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })

        const packed = [headerLine, ...packChunkRuns(events).map(record => JSON.stringify(record)), ''].join('\n')
        const normalized = scrubRequestHeaders(normalizeSessionLog(packed, context))
        if (refreshing) await writeFile(sessionExpected, normalized)
        expect(normalized).toBe(await readFile(sessionExpected, 'utf8'))
      },
    })

    expect(result.stderr).toBe('')
    const records = result.stdout.trim().split('\n').map(line => JSON.parse(line) as StreamRecord)
    expect(records.at(-1)).toMatchObject({ type: 'result', output: 'PROGRESS_REMINDER_OK' })
    const rawEvents = records.filter(record => record.type === 'session_event').map(record => record.event)
    const normalizedEvents = scrubRequestHeaders(normalizeSessionLog(
      rawEvents.map(event => JSON.stringify(event)).join('\n') + '\n', context,
    )).trim().split('\n').map(line => JSON.parse(line) as unknown)
    const stream = records.map((record, index) => record.type === 'session_event'
      ? { ...record, event: normalizedEvents[index] }
      : record)
    const normalized = normalizeStdout(stream.map(record => JSON.stringify(record)).join('\n') + '\n', context)
    if (refreshing) await writeFile(streamExpected, normalized)
    expect(normalized).toBe(await readFile(streamExpected, 'utf8'))
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
