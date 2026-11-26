// @vitest-environment jsdom
/** 文件标签的鼠标、键盘导航、关闭与拖拽起点。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { IdeTabs } from '../src/client/IdeTabs.tsx'
import type { IdeDocument } from '../src/client/ide-store.ts'
import { zh } from '../src/client/locales.ts'
import { translate } from './translate.client.ts'

afterEach(() => { cleanup() })

function tab(path: string, dirty = false): IdeDocument {
  return {
    path, name: path, segments: [path], content: '', savedContent: '', version: 'v1', dirty, status: 'ready',
  }
}

function setup(activePath: string | null = 'b.ts', paneId = 'pane-0') {
  const onActivate = vi.fn()
  const onClose = vi.fn()
  const onDragStart = vi.fn()
  const onDragEnd = vi.fn()
  const tabs = [tab('a.ts'), tab('b.ts', true), tab('c.ts')]
  const view = render(<IdeTabs tabs={tabs} activePath={activePath} paneId={paneId}
    onActivate={onActivate} onClose={onClose} onDragStart={onDragStart} onDragEnd={onDragEnd} t={translate} />)
  return { ...view, onActivate, onClose, onDragStart, onDragEnd }
}

describe('IDE 文件标签', () => {
  it('方向键、Home 与 End 切换并聚焦标签', () => {
    const { onActivate } = setup()
    const list = screen.getByRole('tablist')
    fireEvent.keyDown(list, { key: 'ArrowRight' })
    expect(onActivate).toHaveBeenLastCalledWith('pane-0', 'c.ts')
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /c\.ts/ }))
    fireEvent.keyDown(list, { key: 'ArrowLeft' })
    expect(onActivate).toHaveBeenLastCalledWith('pane-0', 'a.ts')
    fireEvent.keyDown(list, { key: 'Home' })
    expect(onActivate).toHaveBeenLastCalledWith('pane-0', 'a.ts')
    fireEvent.keyDown(list, { key: 'End' })
    expect(onActivate).toHaveBeenLastCalledWith('pane-0', 'c.ts')
  })

  it('非导航键与无活动标签不触发切换，点击标签和关闭按钮分别回调', () => {
    const first = setup(null)
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' })
    expect(first.onActivate).not.toHaveBeenCalled()
    cleanup()
    const second = setup()
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'Enter' })
    expect(second.onActivate).not.toHaveBeenCalled()
    expect(screen.getByLabelText(zh.unsaved)).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: /a\.ts/ }))
    expect(second.onActivate).toHaveBeenCalledWith('pane-0', 'a.ts')
    fireEvent.click(screen.getByRole('button', { name: zh.closeFile.replace('{name}', 'b.ts') }))
    expect(second.onClose).toHaveBeenCalledWith('b.ts')
  })

  it('标签可拖动，起止都交给工作区判断', () => {
    const { onDragStart, onDragEnd } = setup()
    const draggable = screen.getByRole('tab', { name: /a\.ts/ }).closest('[draggable="true"]')
    expect(draggable).not.toBeNull()
    const written = new Map<string, string>()
    const transfer = {
      effectAllowed: 'none',
      setData: (type: string, value: string) => { written.set(type, value) },
    }
    fireEvent.dragStart(draggable as Element, { dataTransfer: transfer })
    expect(onDragStart).toHaveBeenCalledWith('pane-0', 'a.ts')
    expect(written.get('text/plain')).toBe('a.ts')
    expect(transfer.effectAllowed).toBe('move')
    fireEvent.dragEnd(draggable as Element)
    expect(onDragEnd).toHaveBeenCalledOnce()
  })

  it('标签的 aria-controls 指向本分组的编辑器面板', () => {
    setup('b.ts', 'pane-7')
    expect(screen.getByRole('tab', { name: /b\.ts/ }).getAttribute('aria-controls')).toBe('ide-editor-panel-pane-7')
  })
})
