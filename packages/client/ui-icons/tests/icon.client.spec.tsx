// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { Icon, IconPanelLeftOutline16 } from '../src/index.ts'

afterEach(cleanup)

describe('语义图标适配', () => {
  it('统一传递尺寸、类名和无障碍隐藏状态', () => {
    const view = render(<Icon name="sidebar" size={18} className="panel-control" />)
    const wrapper = view.container.querySelector('.panel-control') as HTMLElement
    expect(wrapper.classList.contains('semi-icon')).toBe(true)
    expect(wrapper.style.fontSize).toBe('18px')
    expect(wrapper.getAttribute('aria-hidden')).toBe('true')
    expect(wrapper.querySelector('svg')).not.toBeNull()
  })

  it('文件侧栏与导航栏共享图形但旋转只由适配层处理', () => {
    const view = render(<><Icon name="sidebar" /><Icon name="files-panel" /></>)
    const [sidebar, files] = view.container.querySelectorAll<HTMLElement>('.semi-icon')
    expect(sidebar?.style.transform).toBe('')
    expect(files?.style.transform).toBe('rotate(180deg)')
    expect(sidebar?.querySelector('path')?.getAttribute('d'))
      .toBe(files?.querySelector('path')?.getAttribute('d'))
  })

  it('底栏使用不同于侧边栏的终端图形', () => {
    const view = render(<><Icon name="sidebar" /><Icon name="bottom-panel" /></>)
    const [sidebar, bottom] = view.container.querySelectorAll<HTMLElement>('.semi-icon')
    expect(bottom?.querySelector('path')?.getAttribute('d'))
      .not.toBe(sidebar?.querySelector('path')?.getAttribute('d'))
  })

  it('原有图标迁移后仍保留原尺寸与 SVG 图形', () => {
    const view = render(<IconPanelLeftOutline16 />)
    expect(view.container.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 16 16')
    expect(view.container.querySelector('svg')?.getAttribute('width')).toBe('16')
  })
})
