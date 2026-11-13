// @vitest-environment jsdom
/** 面板功能移除后，普通工具结果与历史 panel 结果都只显示在工具行。 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ToolCallViewProps } from 'coding-client-ui-tool/client'
import { setLocale } from '../src/client/i18n/index.ts'
import { GenuiToolView } from '../src/client/toolview.tsx'

beforeEach(() => { localStorage.clear(); setLocale('zh') })
afterEach(cleanup)

function props(panel?: boolean): ToolCallViewProps {
  return {
    toolName: 'render_ui', sessionId: 'tool-ui-test', callId: 'render-test',
    block: {
      kind: 'tool-result', seq: 10, time: 0, callId: 'render-test', call: null, callTime: null,
      isError: false, content: [], callView: null, resultView: null, subCalls: [],
      meta: { panel, items: [{ type: 'text', content: '只在工具行显示' }] },
    },
    openFile: () => {},
  } as ToolCallViewProps
}

describe('GenUI 工具行', () => {
  it.each([undefined, true])('不因历史 panel=%s 创建额外 dock 或面板持久状态', (panel) => {
    const view = render(<GenuiToolView {...props(panel)} />)
    expect(screen.getByText('只在工具行显示').closest('[data-genui-tool]')).not.toBeNull()
    expect(view.container.querySelector('[data-genui-panel]')).toBeNull()
    const storedKeys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
    expect(storedKeys.some(key => key?.includes('panel'))).toBe(false)
  })

  it('新调用只显示静态等待状态，不读取额外摘要或历史说明', () => {
    const running = {
      callId: 'render-test', name: 'render_ui', time: 1, turn: 1, step: 1,
      argsRaw: JSON.stringify({ summary: '呈现本周进度', display_description: '旧版进度说明' }),
      callView: null, subCalls: [],
    } as ToolCallViewProps['block']
    const view = render(<GenuiToolView {...props()} block={running} />)
    expect(screen.getByRole('status').textContent).toBe('正在创建…')
    expect(view.container.textContent).not.toContain('呈现本周进度')
    expect(view.container.textContent).not.toContain('旧版进度说明')
    expect(view.container.textContent).not.toContain('render_ui')
    expect(view.container.textContent).not.toContain('render-test')
  })

  it('旧日志的 display_description 保留展示，结果卡片和错误状态不变', () => {
    const complete = props()
    const block = complete.block
    if (!('kind' in block)) throw new Error('测试需要已结算的结果')
    const described = { ...block, call: {
      name: 'render_ui', argsRaw: JSON.stringify({ display_description: '呈现本周进度' }),
    } }
    const view = render(<GenuiToolView {...complete} block={described} />)
    expect(screen.getByText('呈现本周进度')).toBeTruthy()
    expect(screen.getByText('只在工具行显示')).toBeTruthy()
    view.rerender(<GenuiToolView {...complete} block={{ ...described, isError: true }} />)
    expect(screen.getByRole('alert').textContent).toContain('界面创建失败')
    expect(screen.getByText('只在工具行显示')).toBeTruthy()
    view.rerender(<GenuiToolView {...complete} block={{ ...block, meta: undefined, isError: true }} />)
    expect(screen.getByRole('status').textContent).toBe('界面创建失败')
    expect(view.container.textContent).not.toContain('render-test')
    expect(view.container.textContent).not.toContain('render_ui')
  })

  it('已结算的新调用显示卡片自身标题，不显示额外 summary', () => {
    const complete = props()
    const block = complete.block
    if (!('kind' in block)) throw new Error('测试需要已结算的结果')
    const view = render(<GenuiToolView {...complete} block={{
      ...block,
      call: { name: 'render_ui', argsRaw: JSON.stringify({ summary: '非卡片摘要' }) },
      meta: { title: '本周进度', items: [{ type: 'text', content: '进度已更新' }] },
    }} />)
    expect(screen.getByText('本周进度')).toBeTruthy()
    expect(screen.getByText('进度已更新')).toBeTruthy()
    expect(view.container.textContent).not.toContain('非卡片摘要')
  })

  it.each(['structured_output', 'mcp__rea__analyze'])('工具 %s 的业务 summary 不被误用为动作说明', (toolName) => {
    const complete = props()
    const block = complete.block
    if (!('kind' in block)) throw new Error('测试需要已结算的结果')
    const view = render(<GenuiToolView {...complete} toolName={toolName} block={{
      ...block, meta: undefined,
      call: { name: toolName, argsRaw: JSON.stringify({ summary: '业务内容摘要', display_description: '旧版说明' }) },
    }} />)
    expect(screen.getByRole('status').textContent).toBe('没有可显示的界面')
    expect(view.container.textContent).not.toContain('业务内容摘要')
    expect(view.container.textContent).not.toContain('旧版说明')
  })

  it('旧记录中断和无效参数只显示本地化状态', () => {
    const complete = props()
    const block = complete.block
    if (!('kind' in block)) throw new Error('测试需要已结算的结果')
    const view = render(<GenuiToolView {...complete} block={{
      ...block, meta: undefined, error: { name: 'InterruptedError', code: 'interrupted' },
    }} />)
    expect(screen.getByRole('status').textContent).toBe('已停止创建')
    view.rerender(<GenuiToolView {...complete} block={{
      ...block, meta: undefined, call: { name: 'render_ui', argsRaw: '{"display_description":' },
    }} />)
    expect(screen.getByRole('status').textContent).toBe('没有可显示的界面')
    expect(view.container.textContent).not.toContain('display_description')
  })
})
