// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import {
  AspectRatioGlyph, Icon, IconPanelLeftOutline16, IconTerminalOutline16, IconThinkOutline16,
} from '../src/index.ts'

afterEach(cleanup)

describe('语义图标适配', () => {
  it.each(['conversation', 'recent'] as const)('%s 使用线性语义图形并继承主题颜色', (name) => {
    const view = render(<Icon name={name} size={14} className="view-icon" />)
    const icon = view.container.querySelector<HTMLElement>('.view-icon')!
    expect(icon.style.fontSize).toBe('14px')
    expect(icon.getAttribute('aria-hidden')).toBe('true')
    expect(icon.querySelector('svg')).not.toBeNull()
    expect(icon.querySelector('img')).toBeNull()
  })

  it('首页使用线性房屋图形而非品牌图片，继承尺寸和无障碍隐藏状态', () => {
    const view = render(<Icon name="home" size={20} className="home-control" />)
    const icon = view.container.querySelector<HTMLElement>('.home-control')!
    expect(icon.style.fontSize).toBe('20px')
    expect(icon.getAttribute('aria-hidden')).toBe('true')
    expect(icon.querySelector('svg')).not.toBeNull()
    expect(icon.querySelector('img')).toBeNull()
  })

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

  it('工作台终端菜单使用透明内部的线性图标', () => {
    const view = render(<Icon name="terminal-menu" size={18} className="menu-icon" />)
    const glyph = render(<IconTerminalOutline16 />)
    const icon = view.container.querySelector('svg') as SVGElement
    expect(icon.getAttribute('viewBox')).toBe('0 0 16 16')
    expect(icon.getAttribute('width')).toBe('18')
    expect(icon.classList.contains('menu-icon')).toBe(true)
    expect(icon.getAttribute('aria-hidden')).toBe('true')
    expect(icon.querySelector('rect')?.getAttribute('stroke')).toBe('currentColor')
    expect(icon.querySelector('path')?.getAttribute('stroke')).toBe('currentColor')
    expect(icon.querySelector('path')?.getAttribute('d'))
      .toBe(glyph.container.querySelector('path')?.getAttribute('d'))
    expect(view.container.querySelector('.semi-icon')).toBeNull()
  })

  it('模型能力的视觉与推理语义使用各自图形并向无障碍树隐藏', () => {
    const view = render(<><Icon name="model-vision" size={16} /><Icon name="model-reasoning" size={16} /></>)
    const vision = view.container.querySelector('.semi-icon') as HTMLElement
    const reasoning = view.container.querySelector('svg[viewBox="0 0 16 16"]') as SVGElement
    const original = render(<IconThinkOutline16 />)
    expect(vision.querySelector('svg')).not.toBeNull()
    expect(vision.getAttribute('aria-hidden')).toBe('true')
    expect(reasoning.getAttribute('aria-hidden')).toBe('true')
    expect(reasoning.querySelector('path')?.getAttribute('d'))
      .toBe(original.container.querySelector('path')?.getAttribute('d'))
  })

  it('外部窗口语义使用设计系统的内置图形，按字号缩放并隐藏于无障碍树', () => {
    const view = render(<Icon name="open-window" size={18} className="toolbar-icon" />)
    const wrapper = view.container.querySelector('.toolbar-icon') as HTMLElement
    const svg = wrapper.querySelector('svg') as SVGElement
    // 图形来自图标库的 24px 画布，跟随字号缩放；调用方只给语义和尺寸。
    expect(wrapper.classList.contains('semi-icon')).toBe(true)
    expect(wrapper.style.fontSize).toBe('18px')
    expect(wrapper.getAttribute('aria-hidden')).toBe('true')
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24')
    expect(svg.getAttribute('width')).toBe('1em')
    expect(svg.querySelectorAll('path').length).toBeGreaterThan(0)
  })

  it('撤销与重做使用相向的回转箭头并传递默认/指定尺寸和类名', () => {
    const view = render(<><Icon name="undo" /><Icon name="redo" size={18} className="history-icon" /></>)
    const [undo, redo] = view.container.querySelectorAll<HTMLElement>('.semi-icon')
    expect(undo?.style.fontSize).toBe('16px')
    expect(redo?.style.fontSize).toBe('18px')
    expect(redo?.classList.contains('history-icon')).toBe(true)
    expect(undo?.getAttribute('aria-hidden')).toBe('true')
    expect(redo?.getAttribute('aria-hidden')).toBe('true')
    const undoSvg = undo?.querySelector('svg')
    const redoSvg = redo?.querySelector('svg')
    expect(undoSvg?.getAttribute('viewBox')).toBe('0 0 24 24')
    expect(redoSvg?.getAttribute('viewBox')).toBe('0 0 24 24')
    expect(undoSvg?.querySelector('path')?.getAttribute('fill')).toBe('currentColor')
    expect(redoSvg?.querySelector('path')?.getAttribute('fill')).toBe('currentColor')
    expect(undoSvg?.querySelector('path')?.getAttribute('d')).not.toBe(redoSvg?.querySelector('path')?.getAttribute('d'))
  })

  it('拖拽手柄使用六点图形并传递尺寸、类名及无障碍隐藏状态', () => {
    const view = render(<><Icon name="drag-handle" /><Icon name="drag-handle" size={18} className="drag-grip" /></>)
    const [defaultHandle, customHandle] = view.container.querySelectorAll<HTMLElement>('.semi-icon')
    expect(defaultHandle?.style.fontSize).toBe('16px')
    expect(customHandle?.style.fontSize).toBe('18px')
    expect(customHandle?.classList.contains('drag-grip')).toBe(true)
    expect(customHandle?.getAttribute('aria-hidden')).toBe('true')
    const svg = customHandle?.querySelector('svg')
    expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24')
    expect(svg?.querySelectorAll('path')).toHaveLength(6)
    expect(Array.from(svg?.querySelectorAll('path') ?? [], path => path.getAttribute('fill')))
      .toEqual(Array(6).fill('currentColor'))
  })

  it('PPT 品牌标按语义绘制原始双色图形并透传尺寸和类名', () => {
    const defaults = render(<Icon name="ppt-workbench" />)
    const defaultIcon = defaults.container.querySelector('svg') as SVGElement
    expect(defaultIcon.getAttribute('width')).toBe('16')
    expect(defaultIcon.getAttribute('height')).toBe('16')
    expect(defaultIcon.getAttribute('viewBox')).toBe('0 0 36 36')
    expect(defaultIcon.getAttribute('aria-hidden')).toBe('true')

    const view = render(<Icon name="ppt-workbench" size={20} className="ppt-brand" />)
    const icon = view.container.querySelector('svg.ppt-brand') as SVGElement
    expect(icon.getAttribute('width')).toBe('20')
    expect(icon.getAttribute('height')).toBe('20')
    expect(icon.getAttribute('aria-hidden')).toBe('true')
    expect(icon.querySelector('g')?.getAttribute('transform')).toBe('translate(18 18) scale(1.3) translate(-18 -18)')
    const rects = Array.from(icon.querySelectorAll('rect'))
    expect(rects.map(rect => [rect.getAttribute('x'), rect.getAttribute('y'), rect.getAttribute('width'), rect.getAttribute('height')]))
      .toEqual([['13.5', '8', '14', '11'], ['8', '13.5', '17', '13'], ['11.5', '17', '10', '2'], ['11.5', '21', '6.5', '2']])
    expect(rects.slice(2).map(rect => rect.getAttribute('fill'))).toEqual(['#FFFFFF', '#FFFFFF'])
    expect(rects[3]?.getAttribute('fill-opacity')).toBe('0.85')
    expect(Array.from(icon.querySelectorAll('linearGradient'), gradient =>
      Array.from(gradient.querySelectorAll('stop'), stop => stop.getAttribute('stop-color'))))
      .toEqual([['#FF9E66', '#FA541C'], ['#69B9FF', '#324DE2']])
  })

  it('PPT 品牌标的每个实例独占渐变且填充引用正确实例', () => {
    const view = render(<><Icon name="ppt-workbench" /><Icon name="ppt-workbench" /></>)
    const icons = Array.from(view.container.querySelectorAll('svg'))
    const ids = icons.map(icon => Array.from(icon.querySelectorAll('linearGradient'), gradient => gradient.id))
    expect(new Set(ids.flat()).size).toBe(4)
    icons.forEach((icon, index) => {
      const fills = Array.from(icon.querySelectorAll('rect'), rect => rect.getAttribute('fill'))
      expect(fills.slice(0, 2)).toEqual(ids[index]?.map(id => `url(#${id})`))
    })
  })

  it('比例轮廓按宽高比绘制，自动选项使用虚线方形', () => {
    const view = render(<AspectRatioGlyph ratio="16:9" className="ratio-glyph" />)
    const glyph = view.container.querySelector('svg.ratio-glyph') as SVGElement
    const rect = glyph.querySelector('rect') as SVGRectElement
    expect(Number(rect.getAttribute('width'))).toBeGreaterThan(Number(rect.getAttribute('height')))
    expect(rect.getAttribute('stroke-dasharray')).toBeNull()
    const automatic = render(<AspectRatioGlyph ratio="1:1" auto />)
    expect(automatic.container.querySelector('rect')?.getAttribute('stroke-dasharray')).toBe('2 2')
  })
})
