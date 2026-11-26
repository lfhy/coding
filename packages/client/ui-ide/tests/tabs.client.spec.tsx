// @vitest-environment jsdom
/** 文件标签的鼠标、键盘导航与关闭动作。 */
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

function setup(activePath: string | null = 'b.ts') {
  const onActivate = vi.fn()
  const onClose = vi.fn()
  const tabs = [tab('a.ts'), tab('b.ts', true), tab('c.ts')]
  const view = render(<IdeTabs tabs={tabs} activePath={activePath} onActivate={onActivate} onClose={onClose} t={translate} />)
  return { ...view, onActivate, onClose }
}

describe('IDE 文件标签', () => {
  it('方向键、Home 与 End 切换并聚焦标签', () => {
    const { onActivate } = setup()
    const list = screen.getByRole('tablist')
    fireEvent.keyDown(list, { key: 'ArrowRight' })
    expect(onActivate).toHaveBeenLastCalledWith('c.ts')
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /c\.ts/ }))
    fireEvent.keyDown(list, { key: 'ArrowLeft' })
    expect(onActivate).toHaveBeenLastCalledWith('a.ts')
    fireEvent.keyDown(list, { key: 'Home' })
    expect(onActivate).toHaveBeenLastCalledWith('a.ts')
    fireEvent.keyDown(list, { key: 'End' })
    expect(onActivate).toHaveBeenLastCalledWith('c.ts')
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
    expect(second.onActivate).toHaveBeenCalledWith('a.ts')
    fireEvent.click(screen.getByRole('button', { name: zh.closeFile.replace('{name}', 'b.ts') }))
    expect(second.onClose).toHaveBeenCalledWith('b.ts')
  })
})
