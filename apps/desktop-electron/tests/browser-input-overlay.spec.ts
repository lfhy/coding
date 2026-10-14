import { beforeEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import type { BrowserWindow } from 'electron'
import { createBrowserInputOverlay } from '../src/browser-input-overlay.ts'

const native = vi.hoisted(() => ({ html: '' }))
vi.mock('electron', () => ({
  WebContentsView: class {
    setBackgroundColor() {}
    webContents = {
      setWindowOpenHandler() {}, session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {} },
      on() {}, loadURL: async (url: string) => { native.html = decodeURIComponent(url.split(',').slice(1).join(',')) },
    }
  },
}))

function fixture(reduce = false, initialPosition?: { x: number; y: number }) {
  createBrowserInputOverlay({} as BrowserWindow, () => {}, initialPosition)
  const dom = new JSDOM(native.html, { runScripts: 'outside-only' })
  const callbacks: FrameRequestCallback[] = []
  Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: reduce }) })
  dom.window.requestAnimationFrame = (callback) => { callbacks.push(callback); return callbacks.length }
  dom.window.eval(dom.window.document.querySelector('script')!.textContent)
  const controller = dom.window as unknown as { moveCursor(x: number, y: number, action?: string): Promise<void> }
  const move = (x: number, y: number, action?: string) => controller.moveCursor(x, y, action)
  return { dom, move, frame: async (time: number) => {
    const pending = callbacks.splice(0)
    pending.forEach((callback) => { callback(time) })
    await Promise.resolve()
    await Promise.resolve()
  } }
}

beforeEach(() => { native.html = '' })

describe('原生覆盖层的逐帧鼠标轨迹', () => {
  it('等待真实中间帧、连续曲线轨迹及淡出结束，才完成移动', async () => {
    const { dom, move, frame } = fixture()
    let completed = false
    const pending = move(100, 100).then(() => { completed = true })
    await frame(0)
    const cursor = dom.window.document.querySelector<HTMLElement>('#cursor')!
    const trail = dom.window.document.querySelector<SVGElement>('#trail')!
    await frame(150)
    expect(completed).toBe(false)
    expect(cursor.style.transform).not.toBe('translate(100px,100px)')
    expect(trail.querySelector('path')!.getAttribute('d')).toContain('L')
    const middle = cursor.style.transform
    await frame(300)
    expect(cursor.style.transform).not.toBe(middle)
    expect(cursor.style.transform).toBe('translate(100px,100px)')
    await frame(316)
    await frame(366)
    expect(Number(trail.style.opacity)).toBeLessThan(1)
    expect(completed).toBe(false)
    await frame(432)
    await pending
    expect(trail.style.opacity).toBe('0')
    expect(trail.querySelector('path')!.getAttribute('d')).toBe('')
    dom.window.close()
  })

  it('减少动态效果时直接定位，无轨迹但保留静态点击反馈', async () => {
    const { dom, move } = fixture(true)
    await move(120, 80)
    expect(dom.window.document.querySelector<HTMLElement>('#cursor')!.style.transform).toBe('translate(120px,80px)')
    expect(dom.window.document.querySelector('#trail path')!.getAttribute('d')).toBe('')
    await move(120, 80, 'click')
    expect(dom.window.document.querySelector<HTMLElement>('#cursor')!.dataset.action).toBe('click')
    expect(native.html).toContain('animation:none; opacity:.65')
    dom.window.close()
  })

  it('新覆盖层从传入的上次位置开始，不在首次移动前闪现到中心', async () => {
    const { dom, move, frame } = fixture(false, { x: 40, y: 50 })
    const pending = move(120, 80)
    const cursor = dom.window.document.querySelector<HTMLElement>('#cursor')!
    // 显示与就位在首个渲染帧之前同步完成，用户不会先看到视口中心的指针。
    expect(cursor.style.display).toBe('block')
    expect(cursor.style.transform).toBe('translate(40px,50px)')
    expect(cursor.style.transform).not.toBe('translate(400px,300px)')
    await frame(0)
    expect(cursor.style.transform).toBe('translate(40px,50px)')
    await frame(150)
    await frame(300)
    await frame(316)
    await frame(366)
    await frame(432)
    await pending
    dom.window.close()
  })

  it('没有渲染帧的隐藏窗口也有定时降级，不永久等待动画', async () => {
    const { dom, move } = fixture()
    await move(60, 40)
    expect(dom.window.document.querySelector<HTMLElement>('#cursor')!.style.transform).toBe('translate(60px,40px)')
    dom.window.close()
  })
})
