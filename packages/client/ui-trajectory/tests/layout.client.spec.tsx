// @vitest-environment jsdom
/**
 * Trajectory turn chrome and layout fold: expand blocks, usage on Message,
 * tool own-duration, group wall-span descriptions, in-flight rows.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type {
  ConversationLocation, ConversationSnapshot, RequestView,
} from 'coding-client-runtime/client'
import { TrajectoryGroupHeader } from '../src/client/TrajectoryGroupHeader.tsx'
import { TrajectoryTurn } from '../src/client/TrajectoryTurn.tsx'
import { TrajectoryTurnHeader } from '../src/client/TrajectoryTurnHeader.tsx'
import {
  appendTrajectoryPartialLayout, deriveTrajectoryLayout,
} from '../src/client/layout.ts'

afterEach(cleanup)

describe('TrajectoryTurnHeader', () => {
  it('renders Turn N and the four metric column labels', () => {
    render(<TrajectoryTurnHeader turn={1} />)
    expect(screen.getByText('Turn 1')).toBeTruthy()
    expect(screen.getByText('Input')).toBeTruthy()
    expect(screen.getByText('Output')).toBeTruthy()
    expect(screen.getByText('Think')).toBeTruthy()
    expect(screen.getByText('Time')).toBeTruthy()
  })
})

describe('TrajectoryGroupHeader', () => {
  it('renders title and optional description', () => {
    render(<TrajectoryGroupHeader title="Step 1" description="2.2s skill" />)
    expect(screen.getByText('Step 1')).toBeTruthy()
    expect(screen.getByText('2.2s skill')).toBeTruthy()
  })

  it('omits the description node when absent', () => {
    const { container } = render(<TrajectoryGroupHeader title="Message" />)
    expect(screen.getByText('Message')).toBeTruthy()
    expect(container.querySelectorAll('span')).toHaveLength(1)
  })
})

describe('TrajectoryTurn', () => {
  it('wraps a sticky header and body children', () => {
    render(
      <TrajectoryTurn turn={3}>
        <TrajectoryGroupHeader title="Message" description="49s" />
      </TrajectoryTurn>,
    )
    expect(screen.getByText('Turn 3')).toBeTruthy()
    expect(screen.getByText('Message')).toBeTruthy()
    expect(screen.getByText('49s')).toBeTruthy()
  })
})

describe('deriveTrajectoryLayout', () => {
  it('expands assistant blocks, hangs usage on Message, and folds call+result into Tool', () => {
    const nodes = [
      { kind: 'user', seq: 1, time: 1_000, content: [{ type: 'text', text: 'hello' }], source: null },
      {
        kind: 'assistant', seq: 2, time: 6_000, turn: 1, step: 1,
        blocks: [
          { kind: 'reasoning', text: 'thinking…' },
          { kind: 'text', text: 'I will run bash' },
          { kind: 'tool-call', callId: 'c1', name: 'bash', argsRaw: '{"command":"ls"}' },
        ],
        usage: { inputTokens: 10, outputTokens: 20, reasoningTokens: 5 },
      },
      {
        kind: 'tool-result', seq: 3, time: 7_500, callId: 'c1',
        call: { name: 'bash', argsRaw: '{"command":"ls"}' }, callTime: 6_200,
        content: [{ type: 'text', text: 'a.txt' }], isError: false, callView: null, resultView: null, subCalls: [],
      },
    ] as unknown as ConversationSnapshot['nodes']
    const turns = deriveTrajectoryLayout({ nodes, partial: null, runningCalls: [] })
    expect(turns).toHaveLength(1)
    expect(turns[0]?.turn).toBe(1)
    const kinds = turns[0]?.groups.flatMap(g => g.cells.map(c => c.kind))
    expect(kinds).toEqual(['user', 'message', 'tool'])
    const message = turns[0]?.groups.flatMap(g => g.cells).find(c => c.kind === 'message')
    expect(message).toMatchObject({
      input: 10, output: 20, think: 5, timeSeconds: 5,
    })
    const tool = turns[0]?.groups.flatMap(g => g.cells).find(c => c.kind === 'tool')
    expect(tool).toMatchObject({
      text: 'Bash',
      inputDetail: '{"command":"ls"}',
    })
    expect(tool?.timeSeconds).toBe(1.3)
  })

  it('adds runningCalls not already present and leaves their time blank', () => {
    const turns = deriveTrajectoryLayout({
      nodes: [],
      partial: null,
      runningCalls: [{
        callId: 'r1', name: 'bash', argsRaw: '{"command":"pwd"}',
        turn: 1, step: 2, time: 9_000, callView: null, subCalls: [],
      }],
    })
    expect(turns[0]?.groups.map(g => g.title)).toEqual(['Step 2'])
    expect(turns[0]?.groups[0]?.cells[0]).toMatchObject({
      kind: 'tool',
      text: 'Bash',
      inputDetail: '{"command":"pwd"}',
      timeSeconds: null,
    })
  })

  it('projects operation descriptions for running calls and keeps original arguments inspectable', () => {
    const argsRaw = JSON.stringify({ command: 'echo private', description: '检查当前目录' })
    const turns = deriveTrajectoryLayout({
      nodes: [], partial: null,
      runningCalls: [{ callId: 'r2', name: 'exec_command', argsRaw, turn: 1, step: 1, time: 1_000, callView: null, subCalls: [] }],
    })
    const cell = turns[0]?.groups[0]?.cells[0]
    expect(cell).toMatchObject({ text: 'Bash', previewMarkdown: '检查当前目录', inputDetail: argsRaw })
    expect(cell?.previewMarkdown).not.toContain('private')
  })

  it('distinguishes background reads, stops and subagent sends in running records', () => {
    for (const [name, argsRaw, title] of [
      ['write_stdin', '{"session_id":"bash-1","chars":"","yield_time_ms":0}', '读取后台任务输出'],
      ['write_stdin', '{"session_id":"bash-1","chars":"\\u0003"}', '停止后台任务'],
      ['send_message', '{"subagent_id":"child-1","message":"private payload"}', '向子代理发送消息'],
      ['followup_task', '{"subagent_id":"child-1","message":"private payload"}', '安排子代理后续任务'],
    ] as const) {
      const turns = deriveTrajectoryLayout({
        nodes: [], partial: null,
        runningCalls: [{ callId: name, name, argsRaw, turn: 1, step: 1, time: 1_000, callView: null, subCalls: [] }],
      })
      const cell = turns[0]?.groups[0]?.cells[0]
      expect(cell).toMatchObject({ text: title, inputDetail: argsRaw })
      expect(cell?.previewMarkdown).toBeUndefined()
    }
  })

  it('keeps full background output in details but summarizes its status and message delivery', () => {
    for (const [name, argsRaw, raw, summary] of [
      ['write_stdin', '{"session_id":"bash-1"}', 'private stdout\n[status: completed]', '任务已结束，结果见详情'],
      ['send_message', '{"subagent_id":"child-1","message":"private payload"}',
        'message accepted for next-step delivery to subagent child-1', '消息已接受，等待处理'],
    ]) {
      const nodes = [{
        kind: 'tool-result', seq: 1, time: 2_000, callId: name,
        call: { name, argsRaw }, callTime: 1_000,
        content: [{ type: 'text', text: raw }], isError: false, callView: null, resultView: null, subCalls: [],
      }] as unknown as ConversationSnapshot['nodes']
      const turns = deriveTrajectoryLayout({ nodes, partial: null, runningCalls: [] })
      const cell = turns[0]?.groups[0]?.cells[0]
      expect(cell).toMatchObject({ text: name === 'send_message' ? '向子代理发送消息' : '等待后台任务输出', result: summary, outputDetail: raw })
      expect(cell?.resultPreviewMarkdown).toBeUndefined()
    }
  })

  it('associates background readers with the starter description only inside the loaded window', () => {
    const starter = {
      kind: 'tool-result', seq: 1, time: 1_000, callId: 'starter',
      call: { name: 'exec_command', argsRaw: JSON.stringify({
        command: 'private command', description: '检查最新预览', run_in_background: true,
      }) }, callTime: 900,
      content: [{ type: 'text', text: 'started background job bash-1' }],
      isError: false, callView: null, resultView: null, subCalls: [],
    }
    const reader = {
      kind: 'tool-result', seq: 2, time: 2_000, callId: 'reader',
      call: { name: 'write_stdin', argsRaw: '{"session_id":"bash-1"}' }, callTime: 1_500,
      content: [{ type: 'text', text: 'private output\n[status: running]' }],
      isError: false, callView: null, resultView: null, subCalls: [],
    }
    const turns = deriveTrajectoryLayout({
      nodes: [starter, reader] as unknown as ConversationSnapshot['nodes'], partial: null, runningCalls: [],
    })
    const cell = turns.flatMap(turn => turn.groups.flatMap(group => group.cells)).find(item => item.callId === 'reader')
    expect(cell).toMatchObject({ text: '等待后台任务输出', previewMarkdown: '检查最新预览', result: '任务仍在运行' })
    expect(cell?.previewMarkdown).not.toContain('private command')

    const withoutStarter = deriveTrajectoryLayout({
      nodes: [reader] as unknown as ConversationSnapshot['nodes'], partial: null, runningCalls: [],
    })
    expect(withoutStarter[0]?.groups[0]?.cells[0]?.previewMarkdown).toBeUndefined()
  })

  it('links nested background starters to their exact session, not unrelated or failed receipts', () => {
    const nested = {
      kind: 'tool-result', seq: 2, time: 2_000, callId: 'nested',
      call: { name: 'bash', argsRaw: JSON.stringify({
        command: 'private', description: '验证后台同步', run_in_background: true,
      }) }, callTime: 1_000, content: [{ type: 'text', text: 'started background job bash-2' }],
      isError: false, callView: null, resultView: null, subCalls: [],
    }
    const parent = {
      kind: 'tool-result', seq: 1, time: 2_000, callId: 'parent',
      call: { name: 'run_code', argsRaw: '{"code":"private"}' }, callTime: 1_000,
      content: [], isError: false, callView: null, resultView: null, subCalls: [nested],
    }
    const reader = {
      kind: 'tool-result', seq: 3, time: 3_000, callId: 'reader',
      call: { name: 'write_stdin', argsRaw: '{"session_id":"bash-2"}' }, callTime: 2_500,
      content: [{ type: 'text', text: '[status: completed]' }],
      isError: false, callView: null, resultView: null, subCalls: [],
    }
    const cells = (starter: typeof parent) => deriveTrajectoryLayout({
      nodes: [starter, reader] as unknown as ConversationSnapshot['nodes'], partial: null, runningCalls: [],
    }).flatMap(turn => turn.groups.flatMap(group => group.cells))
    expect(cells(parent).find(cell => cell.callId === 'reader'))
      .toMatchObject({ previewMarkdown: '验证后台同步', result: '任务已结束，结果见详情' })
    expect(cells({ ...parent, subCalls: [{ ...nested, isError: true }] }).find(cell => cell.callId === 'reader')?.previewMarkdown)
      .toBeUndefined()
    expect(cells({ ...parent, subCalls: [{ ...nested, content: [{ type: 'text', text: 'output started background job bash-2' }] }] })
      .find(cell => cell.callId === 'reader')?.previewMarkdown).toBeUndefined()
    expect(cells({ ...parent, subCalls: [{ ...nested, call: { ...nested.call, argsRaw: JSON.stringify({ command: 'private' }) } }] })
      .find(cell => cell.callId === 'reader')?.previewMarkdown).toBeUndefined()
  })

  it('shows patch targets in records without exposing patch content', () => {
    const argsRaw = JSON.stringify({ input: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-secret\n+new\n*** Add File: src/b.ts\n+x\n*** End Patch' })
    const turns = deriveTrajectoryLayout({
      nodes: [], partial: null,
      runningCalls: [{ callId: 'patch-1', name: 'apply_patch', argsRaw, turn: 1, step: 1, time: 1_000, callView: null, subCalls: [] }],
    })
    const cell = turns[0]?.groups[0]?.cells[0]
    expect(cell).toMatchObject({ text: 'Apply patch', previewMarkdown: 'src/a.ts 等 2 个文件', inputDetail: argsRaw })
    expect(cell?.previewMarkdown).not.toContain('secret')
    const described = JSON.stringify({ input: '*** Begin Patch\n*** Update File: src/a.ts\n@@', display_description: '修复页面' })
    const withDescription = deriveTrajectoryLayout({
      nodes: [], partial: null,
      runningCalls: [{ callId: 'patch-2', name: 'apply_patch', argsRaw: described, turn: 1, step: 1, time: 1_000, callView: null, subCalls: [] }],
    })
    expect(withDescription[0]?.groups[0]?.cells[0]?.previewMarkdown).toBe('src/a.ts · 修复页面')
  })

  it.each([
    ['browser_click', '{"selector":"#private","label":"确认按钮"}', '点击网页元素', '确认按钮'],
    ['browser_js', '{"expression":"window.secret"}', '执行网页脚本', undefined],
    ['lsp', '{"file_path":"src/a.ts","line":1}', '查询代码定义与引用', 'src/a.ts'],
    ['terminal_open', '{}', '打开终端', undefined],
    ['session_search', '{}', '搜索历史会话', undefined],
  ])('shows %s with its own action instead of the tool name or raw input', (name, argsRaw, title, preview) => {
    const turns = deriveTrajectoryLayout({
      nodes: [], partial: null,
      runningCalls: [{ callId: name, name, argsRaw, turn: 1, step: 1, time: 1_000, callView: null, subCalls: [] }],
    })
    expect(turns[0]?.groups[0]?.cells[0]).toMatchObject({ text: title, inputDetail: argsRaw })
    expect(turns[0]?.groups[0]?.cells[0]?.previewMarkdown).toBe(preview)
  })

  it.each([
    ['wait_agent', 'Wait for agents'],
    ['list_agents', 'List agents'],
    ['list_subagent_models', 'Browse models'],
    ['memory_list', 'List memory'],
    ['validate_gen_ui', '校验UI语法'],
    ['browser_close', '关闭浏览器'],
    ['browser_screenshot', '截取网页画面'],
    ['browser_snapshot', '查看网页'],
    ['browser_auth_flush', '保存浏览器登录状态'],
    ['browser_doctor', '检查浏览器环境'],
    ['browser_status', '查看浏览器状态'],
    ['computer_list_apps', '查看应用列表'],
    ['cordis_inspect_list', 'Browse plugin capabilities'],
    ['terminal_list', 'List terminals'],
    ['canvas_state', 'View canvas'],
    ['ppt_templates', '浏览演示模板'],
    ['schedule_list', '查看提醒'],
    ['ask_user_question', 'Ask question'],
    ['report', 'Report result'],
  ])('renders %s as a static title, with raw input only in Payload', (name, title) => {
    const argsRaw = JSON.stringify({ summary: '不应显示', private: 'raw input' })
    const turns = deriveTrajectoryLayout({
      nodes: [], partial: null,
      runningCalls: [{ callId: name, name, argsRaw, turn: 1, step: 1, time: 1_000, callView: null, subCalls: [] }],
    })
    const cell = turns[0]?.groups[0]?.cells[0]
    expect(cell).toMatchObject({ text: title, inputDetail: argsRaw })
    expect(cell?.previewMarkdown).toBeUndefined()
  })

  it.each(['structured_output', 'mcp__server__tool'])('%s does not show business summary as a call description', (name) => {
    const argsRaw = JSON.stringify({ summary: '业务参数', display_description: '历史说明' })
    const turns = deriveTrajectoryLayout({
      nodes: [], partial: null,
      runningCalls: [{ callId: name, name, argsRaw, turn: 1, step: 1, time: 1_000, callView: null, subCalls: [] }],
    })
    const cell = turns[0]?.groups[0]?.cells[0]
    expect(cell).toMatchObject({ text: name, inputDetail: argsRaw })
    expect(cell?.previewMarkdown).toBeUndefined()
  })

  it('uses legacy display_description when a normal tool has no summary', () => {
    const argsRaw = JSON.stringify({ display_description: '历史说明' })
    const turns = deriveTrajectoryLayout({
      nodes: [], partial: null,
      runningCalls: [{ callId: 'read-1', name: 'read', argsRaw, turn: 1, step: 1, time: 1_000, callView: null, subCalls: [] }],
    })
    expect(turns[0]?.groups[0]?.cells[0]).toMatchObject({ text: 'Read', previewMarkdown: '历史说明' })
  })

  it('appends a streaming partial without rebuilding unaffected finalized turns', () => {
    const nodes = [{
      kind: 'assistant', seq: 2, time: 2_000, turn: 1, step: 1,
      blocks: [{ kind: 'text', text: 'finalized' }],
    }] as unknown as ConversationSnapshot['nodes']
    const partial = {
      turn: 2,
      step: 1,
      blocks: [{ kind: 'reasoning' as const, text: 'streaming' }],
    }
    const request = {
      purpose: 'assistant', startSeq: 3, turn: 2, step: 1,
      startedAt: 3_000, completedAt: null, status: 'running',
    } as unknown as RequestView
    const base = deriveTrajectoryLayout({
      nodes,
      partial: { ...partial, blocks: [] },
      requests: [request],
      runningCalls: [],
    })
    expect(base).toHaveLength(1)

    const streamed = appendTrajectoryPartialLayout(base, partial, 1)

    expect(streamed[0]).toBe(base[0])
    expect(streamed).toHaveLength(2)
    expect(streamed[1]?.groups[0]?.cells).toMatchObject([{
      index: 2,
      kind: 'message',
      text: '',
      previewMarkdown: 'streaming',
      timeSeconds: null,
    }])
    expect(streamed[1]?.groups[0]?.cells[0]?.requestOnly).toBeUndefined()
  })

  it('replaces a running-call placeholder with the matching streamed tool call', () => {
    const partial = {
      turn: 1,
      step: 1,
      blocks: [{
        kind: 'tool-call' as const,
        callId: 'c1',
        name: 'bash',
        argsRaw: '{"command":"pwd"}',
      }],
    }
    const base = deriveTrajectoryLayout({
      nodes: [],
      partial: { ...partial, blocks: [] },
      runningCalls: [{
        callId: 'c1', name: 'bash', argsRaw: '{"command":"pwd"}',
        turn: 1, step: 1, time: 9_000, callView: null, subCalls: [],
      }],
    })

    const streamed = appendTrajectoryPartialLayout(base, partial, 1)
    const cells = streamed[0]?.groups[0]?.cells ?? []

    expect(cells.map(cell => cell.kind)).toEqual(['message', 'tool'])
    expect(cells.filter(cell => cell.callId === 'c1')).toHaveLength(1)
  })

  it('omits duration when node times are missing instead of rendering NaN', () => {
    const nodes = [
      { kind: 'user', seq: 1, content: [{ type: 'text', text: 'hi' }], source: null },
      {
        kind: 'assistant', seq: 2, turn: 1, step: 1,
        blocks: [
          { kind: 'reasoning', text: '…' },
          { kind: 'text', text: 'ok' },
        ],
        usage: { inputTokens: 1, outputTokens: 2, reasoningTokens: 3 },
      },
    ] as unknown as ConversationSnapshot['nodes']
    const turns = deriveTrajectoryLayout({ nodes, partial: null, runningCalls: [] })
    const cells = turns[0]?.groups.flatMap(g => g.cells) ?? []
    expect(cells.find(c => c.kind === 'message')?.timeSeconds).toBeNull()
    expect(turns[0]?.groups.find(g => g.title === 'Step 1')?.description).toBeUndefined()
  })

  it('builds a wall-span step description with a tool histogram', () => {
    const nodes = [
      {
        kind: 'assistant', seq: 1, time: 1_000, turn: 1, step: 1,
        blocks: [
          { kind: 'tool-call', callId: 'a', name: 'bash', argsRaw: '{}' },
          { kind: 'tool-call', callId: 'b', name: 'bash', argsRaw: '{}' },
        ],
      },
      {
        kind: 'tool-result', seq: 2, time: 2_500, callId: 'a',
        call: { name: 'bash', argsRaw: '{}' }, callTime: 1_100,
        content: [], isError: false, callView: null, resultView: null, subCalls: [],
      },
      {
        kind: 'tool-result', seq: 3, time: 4_000, callId: 'b',
        call: { name: 'bash', argsRaw: '{}' }, callTime: 2_600,
        content: [], isError: false, callView: null, resultView: null, subCalls: [],
      },
    ] as unknown as ConversationSnapshot['nodes']
    const turns = deriveTrajectoryLayout({ nodes, partial: null, runningCalls: [] })
    expect(turns[0]?.groups[0]?.description).toBe('3,000 ms bash×2')
  })

  it('assigns each user message to its enclosing turn instead of pooling into Turn 1', () => {
    const nodes = [
      { kind: 'user', seq: 1, time: 1_000, content: [{ type: 'text', text: 'first' }], source: null },
      {
        kind: 'assistant', seq: 2, time: 2_000, turn: 1, step: 0,
        blocks: [{ kind: 'text', text: 'ok1' }],
      },
      { kind: 'user', seq: 3, time: 3_000, content: [{ type: 'text', text: 'second' }], source: null },
      {
        kind: 'assistant', seq: 4, time: 4_000, turn: 2, step: 0,
        blocks: [{ kind: 'text', text: 'ok2' }],
      },
    ] as unknown as ConversationSnapshot['nodes']
    const turns = deriveTrajectoryLayout({ nodes, partial: null, runningCalls: [] })
    expect(turns.map(t => t.turn)).toEqual([1, 2])
    expect(turns[0]?.groups.flatMap(g => g.cells.map(c => c.previewMarkdown))).toEqual([
      'first',
      'ok1',
    ])
    expect(turns[1]?.groups.flatMap(g => g.cells.map(c => c.previewMarkdown))).toEqual([
      'second',
      'ok2',
    ])
  })

  it('places steering in its resolved step instead of the turn-opening Message group', () => {
    const nodes = [
      { kind: 'user', seq: 1, time: 1_000, content: [{ type: 'text', text: 'start' }], source: null },
      {
        kind: 'assistant', seq: 2, time: 2_000, turn: 1, step: 1,
        blocks: [{ kind: 'text', text: 'first step' }],
      },
      {
        kind: 'steering', messageId: 'steer-1', seq: 3, time: 3_000,
        content: [{ type: 'text', text: 'change direction' }], source: null,
      },
      {
        kind: 'assistant', seq: 4, time: 4_000, turn: 1, step: 2,
        blocks: [{ kind: 'text', text: 'second step' }],
      },
    ] as unknown as ConversationSnapshot['nodes']
    const data = { get: () => undefined }
    const step = { turn: 1, step: 2, start: undefined, end: undefined, status: 'open' as const, data }
    const turn = {
      turn: 1, start: undefined, end: undefined, status: 'open' as const, steps: [step], data,
    }
    const eventLocations = new Map<number, ConversationLocation>([[
      3,
      { kind: 'step', turn, step },
    ]])

    const turns = deriveTrajectoryLayout({
      nodes,
      eventLocations,
      partial: null,
      runningCalls: [],
    })

    expect(turns).toHaveLength(1)
    expect(turns[0]?.groups.map(group => group.title)).toEqual([
      'Message', 'Step 1', 'Step 2',
    ])
    expect(turns[0]?.groups[2]?.cells).toMatchObject([
      { kind: 'user', previewMarkdown: 'change direction', sourceSeq: 3 },
      { kind: 'message', previewMarkdown: 'second step', sourceSeq: 4 },
    ])
  })

  it('keeps a running request boundary after steering input', () => {
    const nodes = [{
      kind: 'steering', messageId: 'steer-1', seq: 3, time: 3_000,
      content: [{ type: 'text', text: 'change direction' }], source: null,
    }] as unknown as ConversationSnapshot['nodes']
    const data = { get: () => undefined }
    const step = { turn: 1, step: 2, start: undefined, end: undefined, status: 'open' as const, data }
    const turn = {
      turn: 1, start: undefined, end: undefined, status: 'open' as const, steps: [step], data,
    }
    const eventLocations = new Map<number, ConversationLocation>([[
      3,
      { kind: 'step', turn, step },
    ]])

    const turns = deriveTrajectoryLayout({
      nodes,
      eventLocations,
      partial: null,
      runningCalls: [],
      requests: [{
        purpose: 'assistant',
        startSeq: 2,
        turn: 1,
        step: 2,
        startedAt: 2_000,
        completedAt: null,
        status: 'running',
      }],
    })

    expect(turns[0]?.groups[0]?.cells).toMatchObject([
      { kind: 'user', previewMarkdown: 'change direction', sourceSeq: 3 },
      { kind: 'message', requestOnly: true, sourceSeq: 2 },
    ])
  })

  it('uses the following assistant step while a historical window lacks steering Location', () => {
    const nodes = [
      {
        kind: 'steering', messageId: 'steer-1', seq: 3, time: 3_000,
        content: [{ type: 'text', text: 'change direction' }], source: null,
      },
      {
        kind: 'assistant', seq: 4, time: 4_000, turn: 2, step: 3,
        blocks: [{ kind: 'text', text: 'continued' }],
      },
    ] as unknown as ConversationSnapshot['nodes']

    const turns = deriveTrajectoryLayout({ nodes, partial: null, runningCalls: [] })

    expect(turns[0]).toMatchObject({
      turn: 2,
      groups: [{
        title: 'Step 3',
        cells: [
          { kind: 'user', previewMarkdown: 'change direction' },
          { kind: 'message', previewMarkdown: 'continued' },
        ],
      }],
    })
  })

  it('places standalone compaction chronologically in its own between-turn section', () => {
    const nodes = [
      { kind: 'user', seq: 1, time: 1_000, content: [{ type: 'text', text: 'first' }], source: null },
      {
        kind: 'assistant', seq: 2, time: 2_000, turn: 1, step: 1,
        blocks: [{ kind: 'text', text: 'before compaction' }],
      },
      { kind: 'user', seq: 5, time: 5_000, content: [{ type: 'text', text: 'second' }], source: null },
      {
        kind: 'assistant', seq: 6, time: 6_000, turn: 2, step: 1,
        blocks: [{ kind: 'text', text: 'after compaction' }],
      },
    ] as unknown as ConversationSnapshot['nodes']
    const compaction: RequestView = {
      purpose: 'compaction',
      startSeq: 3,
      turn: null,
      step: 0,
      startedAt: 3_000,
      completedAt: 4_000,
      status: 'complete',
      summary: [{ type: 'text', text: 'standalone summary' }],
    }

    const turns = deriveTrajectoryLayout({
      nodes,
      partial: null,
      runningCalls: [],
      requests: [compaction],
    })

    expect(turns.map(turn => turn.turn)).toEqual([1, null, 2])
    expect(turns[1]?.groups).toMatchObject([{
      title: 'Compaction 3',
      cells: [{
        kind: 'compacted',
        sourceSeq: 3,
        text: '',
        previewMarkdown: 'standalone summary',
      }],
    }])
  })

  it('keeps usage and a meaningful summary when assistant has no text block', () => {
    const nodes = [
      {
        kind: 'assistant', seq: 1, time: 5_000, turn: 1, step: 0,
        blocks: [{ kind: 'reasoning', text: '…' }],
        usage: { inputTokens: 11, outputTokens: 22, reasoningTokens: 3 },
      },
    ] as unknown as ConversationSnapshot['nodes']
    const turns = deriveTrajectoryLayout({ nodes, partial: null, runningCalls: [] })
    const message = turns[0]?.groups.flatMap(g => g.cells).find(c => c.kind === 'message')
    expect(message).toMatchObject({
      text: '', previewMarkdown: '…', input: 11, output: 22, think: 3,
    })
  })

  it('bounds a long Markdown-like thinking preview while retaining its full detail', () => {
    const thinking = `# Investigation\n\n**NAVIGATION_OK file_path** ${'- repeated detail '.repeat(1_000)}`
    const nodes = [{
      kind: 'assistant', seq: 1, time: 5_000, turn: 1, step: 0,
      blocks: [{ kind: 'reasoning', text: thinking }],
    }] as unknown as ConversationSnapshot['nodes']

    const turns = deriveTrajectoryLayout({
      nodes, partial: null, runningCalls: [],
    })
    const message = turns[0]?.groups.flatMap(group => group.cells)
      .find(cell => cell.kind === 'message')

    expect(message?.text).toBe('')
    expect(message?.previewMarkdown).toBe(thinking)
    expect(message?.thinkingDetail).toBe(thinking)
  })

  it('advances the duration cursor over context and compaction nodes', () => {
    const nodes = [
      { kind: 'user', seq: 1, time: 1_000, content: [{ type: 'text', text: 'hi' }], source: null },
      {
        kind: 'assistant', seq: 2, time: 2_000, turn: 1, step: 1,
        blocks: [{ kind: 'tool-call', callId: 'c1', name: 'bash', argsRaw: '{}' }],
      },
      {
        kind: 'tool-result', seq: 3, time: 3_000, callId: 'c1',
        call: { name: 'bash', argsRaw: '{}' }, callTime: 2_100,
        content: [], isError: false, callView: null, resultView: null, subCalls: [],
      },
      {
        kind: 'context', seq: 4, time: 9_000,
        content: [{ type: 'text', text: 'extra' }], source: null,
      },
      // A landed compaction renders no cell, but is still a real log position,
      // so it moves the cursor after the visible context row.
      {
        kind: 'compaction', seq: 5, time: 9_500, summary: 'checkpoint facts',
        summaryEventSeq: 4, shadowedItemCount: 2, shadowedTokenCount: 100,
      },
      {
        kind: 'assistant', seq: 6, time: 10_000, turn: 1, step: 0,
        blocks: [{ kind: 'text', text: 'done' }],
      },
    ] as unknown as ConversationSnapshot['nodes']
    const turns = deriveTrajectoryLayout({ nodes, partial: null, runningCalls: [] })
    const cells = turns[0]?.groups.flatMap(g => g.cells) ?? []
    const message = cells.find(c => c.kind === 'message' && c.previewMarkdown === 'done')
    // From the compaction marker at 9.5s, not from context at 9s or the earlier surfaces.
    expect(message?.timeSeconds).toBe(0.5)
    // Context remains inspectable in trajectory; the Chat marker is not duplicated.
    expect(cells.map(cell => cell.kind)).toEqual(['user', 'message', 'tool', 'context', 'message'])
  })

  it('uses the recorded step start for assistant duration when timing exists', () => {
    const nodes = [
      { kind: 'user', seq: 1, time: 1_000, content: [{ type: 'text', text: 'hi' }], source: null },
      {
        kind: 'assistant', seq: 2, time: 4_000, turn: 1, step: 1,
        blocks: [{ kind: 'text', text: 'done' }],
        timing: { stepStartTime: 3_000, firstTokenTime: 3_500, completedTime: 4_000 },
      },
    ] as unknown as ConversationSnapshot['nodes']
    const turns = deriveTrajectoryLayout({
      nodes, partial: null, runningCalls: [],
    })
    const message = turns[0]?.groups.flatMap(group => group.cells)
      .find(cell => cell.kind === 'message')
    expect(message).toMatchObject({ startedAt: 3_000, timeSeconds: 1 })
  })
})

describe('run_code sub-dispatch cells', () => {
  const runCodeNodes = [
    {
      kind: 'assistant', seq: 2, time: 6_000, turn: 1, step: 1,
      blocks: [
        { kind: 'tool-call', callId: 'p1', name: 'run_code', argsRaw: '{"code":"…","description":"批量读取"}' },
      ],
    },
    {
      kind: 'tool-result', seq: 3, time: 9_000, callId: 'p1',
      call: { name: 'run_code', argsRaw: '{"code":"…","description":"批量读取"}' }, callTime: 6_200,
      content: [{ type: 'text', text: 'done' }], isError: false, callView: null, resultView: null,
      subCalls: [],
    },
  ] as unknown as ConversationSnapshot['nodes']

  const settledSub = (n: number, name: string, start: number, end: number) => ({
    kind: 'tool-result' as const, seq: 100 + n, time: end,
    callId: `p1:code:${n}`,
    call: { name, argsRaw: '{"x":1}' }, callTime: start,
    content: [{ type: 'text' as const, text: 'ok' }], isError: false, callView: null, resultView: null,
    subCalls: [],
  })

  const withSubCalls = (subCalls: readonly ReturnType<typeof settledSub>[] | readonly object[]) =>
    runCodeNodes.map(node => node.kind === 'tool-result' ? { ...node, subCalls } : node) as ConversationSnapshot['nodes']

  it('nests settled sub-cells after their parent Tool cell with real durations', () => {
    const subCalls = [
      settledSub(1, 'bash', 6_300, 7_300),
      settledSub(2, 'read', 7_300, 7_800),
    ]
    const turns = deriveTrajectoryLayout({ nodes: withSubCalls(subCalls), partial: null, runningCalls: [] })
    const cells = turns[0]!.groups.flatMap(g => g.cells)
    expect(cells.map(c => c.kind)).toEqual(['message', 'tool', 'subtool', 'subtool'])
    expect(cells[0]?.text).toBe('Tool call only')
    // Sequential indexes across the interleave; durations from the pair times.
    expect(cells.map(c => c.index)).toEqual([1, 2, 3, 4])
    expect(cells[2]).toMatchObject({
      text: 'Bash', inputDetail: '{"x":1}', timeSeconds: 1,
    })
    expect(cells[3]).toMatchObject({ timeSeconds: 0.5 })
  })

  it('a running (unsettled) sub-call renders a subtool cell with blank time', () => {
    const running = {
      callId: 'p1:code:1', name: 'grep', argsRaw: '{"pattern":"x"}',
      turn: 0, step: 0, time: 6_400, callView: null, subCalls: [],
    }
    const turns = deriveTrajectoryLayout({ nodes: withSubCalls([running]), partial: null, runningCalls: [] })
    const sub = turns[0]!.groups.flatMap(g => g.cells).find(c => c.kind === 'subtool')
    expect(sub).toMatchObject({
      text: 'Search', inputDetail: '{"pattern":"x"}', timeSeconds: null,
    })
  })

  it('recursively flattens nested child calls immediately after their parent', () => {
    const leaf = {
      ...settledSub(2, 'read', 7_300, 7_800),
      callId: 'p1:code:1:code:1',
    }
    const child = {
      ...settledSub(1, 'run_code', 6_300, 8_000),
      subCalls: [leaf],
    }
    const turns = deriveTrajectoryLayout({ nodes: withSubCalls([child]), partial: null, runningCalls: [] })
    const cells = turns[0]!.groups.flatMap(group => group.cells)
    expect(cells.map(cell => cell.kind)).toEqual(['message', 'tool', 'subtool', 'subtool'])
    expect(cells.slice(2).map(cell => cell.callId)).toEqual([
      'p1:code:1',
      'p1:code:1:code:1',
    ])
    expect(cells.map(cell => cell.index)).toEqual([1, 2, 3, 4])
  })
})
