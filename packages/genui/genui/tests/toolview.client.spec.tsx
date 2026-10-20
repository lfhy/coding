// @vitest-environment jsdom
/** 面板功能移除后，普通工具结果与历史 panel 结果都只显示在工具行。 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ToolCallViewProps } from 'coding-client-ui-tool/client'
import { GenuiToolView } from '../src/client/toolview.tsx'

beforeEach(() => { localStorage.clear() })
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
})
