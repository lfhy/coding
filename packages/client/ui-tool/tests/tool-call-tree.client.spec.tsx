// @vitest-environment jsdom
/** 工具调用树拥有的根／子调用标记、选择投影与图片加载接线。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { ImageAttachmentRef } from 'coding-attachment'
import type { HostDescription } from 'coding-client-connection/client'
import type { ConversationSnapshot, ToolResultNode } from 'coding-client-runtime/client'
import { makeTranslate } from 'coding-client-test-runtime'
import { zh as commonZh } from 'coding-client-locale/src/locales/zh.ts'
import type { ToolCallOwnerProps, ToolTreeProps } from '../src/client/contract/slots.ts'
import { ToolCallTree } from '../src/client/tool/ToolCallTree.tsx'
import { zh } from 'coding-client-ui-conversation/src/client/locales.ts'

afterEach(cleanup)

const t: ToolTreeProps['t'] = makeTranslate(zh, commonZh)

const root = (callId: string, call: ToolResultNode['call']): ToolResultNode => ({
  kind: 'tool-result', seq: 3, time: 3_000, callId, call, callTime: 2_000,
  content: [], isError: false, callView: null, resultView: null, subCalls: [],
})

function props(
  block: ToolResultNode,
  selectedCallId?: string,
  description?: HostDescription,
  history: readonly ToolResultNode[] = [],
): ToolTreeProps {
  const snapshot = { chat: { nodes: { values: () => history.map(entry => ({
    kind: 'tool-call', data: { root: entry },
  })) } } } as unknown as ConversationSnapshot
  const useSession = ((selector: (value: ConversationSnapshot) => unknown) => selector(snapshot)) as ToolTreeProps['useSession']
  const renderSlot = ((_key: string, _owner: object, options?: { fallback?: React.ReactNode }) =>
    options?.fallback ?? null) as unknown as ToolTreeProps['renderSlot']
  return {
    useSession,
    renderSlot,
    node: {
      key: `tool:${block.callId}`,
      kind: 'tool-call',
      id: block.callId,
      target: 'chat',
      anchorSeq: block.seq,
      location: { kind: 'session' },
      visibility: 'visible',
      data: { root: block },
    },
    selectedCallId,
    openFile: vi.fn(),
    inspectCall: vi.fn(),
    forkAt: vi.fn(),
    retryTurn: vi.fn(async () => {}),
    fileMentions: vi.fn(),
    useHostDescription: (selector => selector(description)) as ToolTreeProps['useHostDescription'],
    t,
  } as unknown as ToolTreeProps
}

describe('ToolCallTree', () => {
  it('links a background read to its completed starter description without exposing the command or output', () => {
    const start = {
      ...root('starter', { name: 'exec_command', argsRaw: JSON.stringify({
        command: 'private command', description: '验证设置面板布局', run_in_background: true,
      }) }),
      content: [{ type: 'text' as const, text: 'started background job bash-1' }],
    }
    const read = {
      ...root('reader', { name: 'write_stdin', argsRaw: '{"session_id":"bash-1","chars":""}' }),
      content: [{ type: 'text' as const, text: 'private output\n[status: running]' }],
    }
    const view = render(<ToolCallTree {...props(read, undefined, undefined, [start, read])} />)
    expect(view.getByText('验证设置面板布局 · 任务仍在运行')).toBeTruthy()
    expect(view.container.textContent).not.toContain('private command')
    expect(view.container.textContent).not.toContain('private output')

    view.rerender(<ToolCallTree {...props(read, undefined, undefined, [read])} />)
    expect(view.getByText('任务仍在运行')).toBeTruthy()
    expect(view.container.textContent).not.toContain('验证设置面板布局')
  })

  it('does not attach a different session description, untrusted receipt, or parent description to child calls', () => {
    const starter = (callId: string, id: string, description: string) => ({
      ...root(callId, { name: 'exec_command', argsRaw: JSON.stringify({
        command: 'private command', description, run_in_background: true,
      }) }),
      content: [{ type: 'text' as const, text: `started background job ${id}` }],
    })
    const child = { ...root('child', { name: 'write_stdin', argsRaw: '{"session_id":"bash-2"}' }),
      content: [{ type: 'text' as const, text: '[status: completed]' }] }
    const parent = {
      ...root('parent', { name: 'write_stdin', argsRaw: '{"session_id":"bash-1"}' }),
      content: [{ type: 'text' as const, text: '[status: completed]' }], subCalls: [child],
    }
    const matched = starter('start-1', 'bash-1', '检查主任务')
    const different = starter('start-2', 'bash-2', '检查子任务')
    const forged = { ...starter('forged', 'bash-2', '伪造说明'), isError: true }
    const view = render(<ToolCallTree {...props(parent, undefined, undefined, [matched, different, forged])} />)
    expect(view.getByText('检查主任务 · 任务已结束，结果见详情')).toBeTruthy()
    expect(view.getByText('检查子任务 · 任务已结束，结果见详情')).toBeTruthy()
    expect(view.container.textContent).not.toContain('伪造说明')

    view.rerender(<ToolCallTree {...props(parent, undefined, undefined, [matched])} />)
    expect(view.getByText('检查主任务 · 任务已结束，结果见详情')).toBeTruthy()
    expect(view.getByText('任务已结束，结果见详情')).toBeTruthy()
  })

  it('owns the root marker, generic fallback, and selected state for a window-truncated call', () => {
    const block = root('w1', null)
    const view = render(<ToolCallTree {...props(block, 'w1')} />)
    const row = view.container.querySelector('[data-chat-call-id="w1"]')
    expect(row?.getAttribute('data-chat-anchor-key')).toBe('call:w1')
    expect(row?.getAttribute('data-selected')).toBe('true')
    expect(view.container.querySelector('[data-variant="others"]')).not.toBeNull()
    expect(view.getByText('使用工具')).toBeTruthy()
    expect(view.queryByText('w1')).toBeNull()
  })

  it('recursively renders a selected leaf without selecting its ancestors', () => {
    const leaf = root('parent:code:1:code:1', { name: 'read', argsRaw: '{"path":"a.ts"}' })
    const child = {
      ...root('parent:code:1', { name: 'run_code', argsRaw: '{"code":"return 1"}' }),
      subCalls: [leaf],
    }
    const block = {
      ...root('parent', { name: 'run_code', argsRaw: '{"code":"return 1"}' }),
      subCalls: [child],
    }
    const view = render(<ToolCallTree {...props(block, leaf.callId)} />)
    const nests = view.container.querySelectorAll('[data-subcalls]')
    expect(nests[0]?.parentElement).toBe(view.container.querySelector('[data-chat-call-id="parent"]'))
    expect(nests[1]?.parentElement).toBe(view.container.querySelector('[data-chat-call-id="parent:code:1"]'))
    expect(view.container.querySelector('[data-chat-call-id="parent"]')?.hasAttribute('data-selected')).toBe(false)
    expect(view.container.querySelector('[data-chat-call-id="parent:code:1"]')?.hasAttribute('data-selected')).toBe(false)
    expect(view.container.querySelector('[data-chat-call-id="parent:code:1:code:1"]')?.getAttribute('data-selected')).toBe('true')
    expect(nests).toHaveLength(2)
  })

  it('abbreviates a POSIX home path in the generic tool summary', () => {
    const block = root('w1', { name: 'read', argsRaw: '{"path":"/h/docs/a.ts"}' })
    const view = render(<ToolCallTree {...props(block, 'w1', {
      version: '0', cwd: '/tmp', attachedSessions: 0, home: '/h', canOpenPath: false,
    })} />)
    expect(view.getByText('~/docs/a.ts')).toBeTruthy()
  })

  it('forwards the same session image loader to root and recursive atomic owners and updates it', () => {
    const leaf = root('parent:code:1:code:1', { name: 'unknown_image_tool', argsRaw: '{}' })
    const child = {
      ...root('parent:code:1', { name: 'run_code', argsRaw: '{}' }),
      subCalls: [leaf],
    }
    const block = { ...root('parent', { name: 'run_code', argsRaw: '{}' }), subCalls: [child] }
    const treeProps = props(block)
    const renderSlot = vi.fn((_key: string, _owner: ToolCallOwnerProps) => null)
    const loadImage = vi.fn(async () => 'blob:first')
    const view = render(
      <ToolCallTree {...treeProps} renderSlot={renderSlot as ToolTreeProps['renderSlot']} loadImage={loadImage} />,
    )
    expect(renderSlot.mock.calls.map(([key, owner]) => [key, owner.callId, owner.loadImage])).toEqual([
      ['tool.call.toolview', block.callId, loadImage],
      ['tool.call.toolview', child.callId, loadImage],
      ['tool.call.toolview', leaf.callId, loadImage],
    ])

    renderSlot.mockClear()
    const replacement = vi.fn(async () => 'blob:replacement')
    view.rerender(
      <ToolCallTree {...treeProps} renderSlot={renderSlot as ToolTreeProps['renderSlot']} loadImage={replacement} />,
    )
    expect(renderSlot.mock.calls.map(([, owner]) => owner.loadImage)).toEqual([
      replacement, replacement, replacement,
    ])
  })

  it('loads a recursive generic fallback image and opens the shared original preview', async () => {
    const attachment: ImageAttachmentRef = {
      attachmentId: 'tool-image' as never, mediaType: 'image/png', bytes: 4, width: 2, height: 2,
    }
    const child = {
      ...root('parent:code:1', { name: 'unknown_image_tool', argsRaw: '{}' }),
      content: [{ type: 'image', attachment } as never],
    }
    const block = { ...root('parent', { name: 'run_code', argsRaw: '{}' }), subCalls: [child] }
    const treeProps = props(block)
    const renderSlot = vi.fn(treeProps.renderSlot)
    const loadImage = vi.fn(async () => 'blob:tool-image')
    const view = render(
      <ToolCallTree {...treeProps} renderSlot={renderSlot as unknown as ToolTreeProps['renderSlot']} loadImage={loadImage} />,
    )

    expect(renderSlot.mock.calls.find(([, owner]) => owner.callId === child.callId)?.[1].loadImage).toBe(loadImage)
    expect(loadImage).not.toHaveBeenCalled()
    expect(view.queryByRole('img', { name: '图片' })).toBeNull()
    fireEvent.click(view.getByRole('button', { name: /使用工具/ }))
    const image = await view.findByRole('img', { name: '图片' })
    expect(loadImage).toHaveBeenCalledWith(attachment)
    expect(image.getAttribute('src')).toBe('blob:tool-image')
    fireEvent.click(image)
    expect(view.getByRole('dialog', { name: '原图预览' })).toBeTruthy()
    expect(view.getByRole('button', { name: '关闭原图预览' })).toBeTruthy()
  })
})
