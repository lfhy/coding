// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CanvasPanel, type CanvasPanelProps } from '../src/client/CanvasPanel.tsx'
import { EntryButton } from '../src/client/EntryButton.tsx'
import { GalleryView, type GalleryViewProps } from '../src/client/GalleryView.tsx'
import { SettingsSection, type SettingsSectionProps } from '../src/client/SettingsSection.tsx'
import { SidebarEntry } from '../src/client/SidebarEntry.tsx'
import { zh } from '../src/client/locales.ts'

const t = (key: keyof typeof zh) => zh[key]
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('图像交互组件', () => {
  it('设置开关随完整配置启用，空引用时不出现密钥输入', () => {
    const save = vi.fn(async () => true)
    const value = { enabled: false, endpoint: 'http://localhost:8080', model: 'paint', apiKeyRef: '' }
    render(<SettingsSection {...({ t, save, saveKey: vi.fn(), useImageSettings: (pick: (view: unknown) => unknown) => pick({
      section: { status: 'ready', writable: true, value },
      credential: { status: 'ready', ref: '', configured: true, writable: false }, saving: false, failed: false,
      keySaving: false, keyFailed: false,
    }) } as unknown as SettingsSectionProps)} />)
    fireEvent.click(screen.getByLabelText('启用图像生成'))
    fireEvent.click(screen.getByText('保存设置'))
    expect(save).toHaveBeenCalledWith({ enabled: true })
    expect(screen.queryByLabelText('服务密钥')).toBeNull()
    expect(screen.getByText('本地服务无需密钥。')).toBeTruthy()
  })

  it('缺少模型时开关禁用，但仍可先保存地址与模型草稿', () => {
    const save = vi.fn(async () => true)
    render(<SettingsSection {...({ t, save, saveKey: vi.fn(), useImageSettings: (pick: (view: unknown) => unknown) => pick({
      section: { status: 'ready', writable: true, value: { enabled: false, endpoint: '', model: '', apiKeyRef: '' } },
      credential: { status: 'ready', ref: '', configured: true, writable: false }, saving: false, failed: false,
      keySaving: false, keyFailed: false,
    }) } as unknown as SettingsSectionProps)} />)
    expect(screen.getByLabelText('启用图像生成').hasAttribute('disabled')).toBe(true)
    fireEvent.change(screen.getByLabelText('服务地址'), { target: { value: 'http://localhost:8080' } })
    fireEvent.change(screen.getByLabelText('绘图模型'), { target: { value: 'paint' } })
    fireEvent.click(screen.getByText('保存设置'))
    expect(save).toHaveBeenCalledWith({ endpoint: 'http://localhost:8080', model: 'paint' })
  })

  it('画廊保留空态与对话引导，支持单图编辑和送入画布', () => {
    const item = { id: 'one', prompt: '晨光', attachmentId: 'att', createdAt: 1, model: 'paint', mediaType: 'image/png', width: 256, height: 256 }
    const generate = vi.fn(async () => true)
    const place = vi.fn(async () => true)
    const openCanvas = vi.fn(() => true)
    const show = vi.fn()
    const view = { phase: 'ready', state: { enabled: true, available: true, model: 'paint' }, items: [item], generating: false, failed: false }
    const { unmount } = render(<GalleryView {...({ t, shown: true, useGallery: (pick: (state: unknown) => unknown) => pick(view),
      show, refresh: vi.fn(), openCanvas, generate, place, url: (id: string) => `/api/image-gen/image?sessionId=test&id=${id}`,
    } as unknown as GalleryViewProps)} />)
    expect(screen.getByText(/在对话中描述画面/u)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '打开 AI 画布' }))
    expect(openCanvas).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByText('加入画布'))
    expect(place).toHaveBeenCalledWith('one')
    fireEvent.click(screen.getByText('基于此图创作'))
    const prompt = screen.getByLabelText('画面描述')
    expect(prompt).toHaveProperty('value', '晨光')
    fireEvent.submit(screen.getByLabelText('画面描述').closest('form')!)
    expect(generate).toHaveBeenCalledWith('晨光', 'one')
    unmount()
    expect(show).toHaveBeenLastCalledWith(false)
  })

  it('单击橡皮生成一个可保存节点，选择图片可移除', () => {
    const add = vi.fn(async () => true)
    const remove = vi.fn(async () => true)
    const nodes = [{ id: 'image', type: 'image', imageId: 'one', x: 0, y: 0, width: 256, height: 256 }]
    const show = vi.fn()
    const getContext = vi.fn(() => ({ clearRect: vi.fn(), save: vi.fn(), restore: vi.fn(),
      beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), fill: vi.fn(), arc: vi.fn(), drawImage: vi.fn() }))
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(getContext as never)
    Object.defineProperty(HTMLCanvasElement.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() })
    const { container, unmount } = render(<CanvasPanel {...({ t, shown: true, show, refresh: vi.fn(), add,
      select: vi.fn(), move: vi.fn(), remove, clear: vi.fn(), url: vi.fn(() => '/image'),
      useImageCanvas: (pick: (state: unknown) => unknown) => pick({ phase: 'ready', nodes, selectedId: 'image', saving: false, issue: null }),
    } as unknown as CanvasPanelProps)} />)
    fireEvent.click(screen.getByText('移除选中内容'))
    expect(remove).toHaveBeenCalled()
    fireEvent.click(screen.getByText('橡皮'))
    const canvas = container.querySelector('canvas')!
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 960, height: 640 } as DOMRect)
    fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 10, clientY: 20 })
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 10, clientY: 20 })
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ type: 'stroke', erase: true, width: 24 }))
    unmount()
    expect(show).toHaveBeenLastCalledWith(false)
  })

  it('未配置画图服务时不渲染入口，配置就绪后点击打开画廊', () => {
    const openGallery = vi.fn(async () => {})
    const useSessions = (pick: (state: unknown) => unknown) => pick({ current: undefined })
    const unconfigured = { t, useSessions, seat: 'welcome', openGallery, useImageEntrySettings: (pick: (state: unknown) => unknown) => pick({
      section: { status: 'ready', value: { enabled: true, endpoint: 'https://images.example', model: 'paint', apiKeyRef: 'KEY' } },
      credential: { status: 'ready', configured: false, writable: true, ref: 'KEY' },
    }) }
    const { rerender } = render(<EntryButton {...(unconfigured as unknown as React.ComponentProps<typeof EntryButton>)} />)
    expect(screen.queryByRole('button')).toBeNull()
    rerender(<EntryButton {...({ ...unconfigured, useImageEntrySettings: (pick: (state: unknown) => unknown) => pick({
      section: { status: 'ready', value: { enabled: true, endpoint: 'https://images.example', model: 'paint', apiKeyRef: 'KEY' } },
      credential: { status: 'ready', configured: true, writable: true, ref: 'KEY' },
    }) } as unknown as React.ComponentProps<typeof EntryButton>)} />)
    fireEvent.click(screen.getByRole('button', { name: '画图' }))
    expect(openGallery).toHaveBeenCalledTimes(1)
  })

  it('会话页头入口只在画图会话显示，侧边栏入口跟随配置出现', () => {
    const openGallery = vi.fn(async () => {})
    const configured = { status: 'ready', value: { enabled: true, endpoint: 'https://images.example', model: 'paint', apiKeyRef: 'KEY' } }
    const credential = { status: 'ready', configured: true, writable: true, ref: 'KEY' }
    const entry = (seat: 'welcome' | 'session', preset: string) => ({
      t, seat, openGallery,
      useSessions: (pick: (state: unknown) => unknown) => pick({
        current: 'session', byId: { session: { agentPreset: preset } },
      }),
      useImageEntrySettings: (pick: (state: unknown) => unknown) => pick({ section: configured, credential }),
    })
    const { unmount } = render(<EntryButton {...(entry('session', 'image') as unknown as React.ComponentProps<typeof EntryButton>)} />)
    expect(screen.getByRole('button', { name: '画图' })).toBeTruthy()
    unmount()
    render(<EntryButton {...(entry('session', 'standard') as unknown as React.ComponentProps<typeof EntryButton>)} />)
    expect(screen.queryByRole('button')).toBeNull()
    cleanup()
    render(<SidebarEntry {...({ t, wide: true, openGallery,
      useImageEntrySettings: (pick: (state: unknown) => unknown) => pick({ section: configured, credential }),
    } as unknown as React.ComponentProps<typeof SidebarEntry>)} />)
    expect(screen.getByRole('button', { name: '画图' })).toBeTruthy()
  })
})
