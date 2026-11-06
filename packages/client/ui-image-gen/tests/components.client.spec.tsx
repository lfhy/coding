// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from 'coding-client-test-runtime'
import { CanvasPanel, type CanvasPanelProps } from '../src/client/CanvasPanel.tsx'
import { EntryButton } from '../src/client/EntryButton.tsx'
import { GalleryView, type GalleryViewProps } from '../src/client/GalleryView.tsx'
import { createGalleryUiStore } from '../src/client/gallery-ui-store.ts'
import { SettingsSection, type SettingsSectionProps } from '../src/client/SettingsSection.tsx'
import { SidebarEntry } from '../src/client/SidebarEntry.tsx'
import { zh } from '../src/client/locales.ts'

const t = (key: keyof typeof zh) => zh[key]
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function choose(label: string, option: string | RegExp): void {
  fireEvent.click(screen.getByRole('button', { name: label }))
  fireEvent.click(screen.getByRole('menuitem', { name: option }))
}

describe('图像交互组件', () => {
  it('设置开关随完整配置启用，空引用时不出现密钥输入', () => {
    const save = vi.fn(async () => ({ ok: true, keySaved: false }))
    const value = { enabled: false, endpoint: 'http://localhost:8080', model: 'paint', apiKeyRef: '' }
    render(<SettingsSection {...({ t, save, useImageSettings: (pick: (view: unknown) => unknown) => pick({
      section: { status: 'ready', writable: true, value },
      credential: { status: 'ready', ref: '', configured: true, writable: false }, saving: false, failed: false,
    }) } as unknown as SettingsSectionProps)} />)
    fireEvent.click(screen.getByLabelText('启用图像生成'))
    fireEvent.click(screen.getByText('保存设置'))
    expect(save).toHaveBeenCalledWith({ enabled: true }, '')
    expect(screen.queryByLabelText('API 密钥')).toBeNull()
    expect(screen.queryByLabelText('密钥名称')).toBeNull()
    expect(screen.getByText('本地服务无需密钥。')).toBeTruthy()
    expect(screen.getByText('OpenAI 兼容')).toBeTruthy()
  })

  it('密钥与非机密字段共享一次提交；本机无鉴权显式保存为空引用', () => {
    const save = vi.fn(async (_changes: unknown, key: string) => ({ ok: true, keySaved: !!key }))
    const value = { enabled: false, endpoint: 'http://localhost:8080/v1', model: 'paint', apiKeyRef: 'CUSTOM_IMAGE_KEY' }
    render(<SettingsSection {...({ t, save, useImageSettings: (pick: (view: unknown) => unknown) => pick({
      section: { status: 'ready', writable: true, value },
      credential: { status: 'ready', ref: 'CUSTOM_IMAGE_KEY', configured: true, writable: true },
      saving: false, failed: false,
    }) } as unknown as SettingsSectionProps)} />)
    const input = screen.getByLabelText('API 密钥') as HTMLInputElement
    expect(input.type).toBe('password')
    expect(input.value).toBe('')
    expect(screen.getByText('密钥已配置')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: '保存设置' })).toHaveLength(1)
    expect(screen.getByRole('button', { name: '保存设置' }).hasAttribute('disabled')).toBe(true)
    fireEvent.change(input, { target: { value: 'new-private-key' } })
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    expect(save).toHaveBeenCalledWith({}, 'new-private-key')
    fireEvent.click(screen.getByLabelText('本地服务无需 API 密钥'))
    expect(screen.queryByLabelText('API 密钥')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    expect(save).toHaveBeenCalledWith({ enabled: false, apiKeyRef: '' }, '')
    fireEvent.click(screen.getByLabelText('本地服务无需 API 密钥'))
    expect(screen.getByLabelText('API 密钥')).toHaveProperty('value', '')
    expect(screen.getByRole('button', { name: '保存设置' }).hasAttribute('disabled')).toBe(false)
  })

  it('可填地址、模型与密钥后一次启用；失败时保留全部草稿', async () => {
    const save = vi.fn(async () => ({ ok: false, keySaved: false }))
    render(<SettingsSection {...({ t, save, useImageSettings: (pick: (view: unknown) => unknown) => pick({
      section: { status: 'ready', writable: true,
        value: { enabled: false, endpoint: '', model: '', apiKeyRef: 'IMAGE_GEN_API_KEY' } },
      credential: { status: 'ready', ref: 'IMAGE_GEN_API_KEY', configured: false, writable: true },
      saving: false, failed: false,
    }) } as unknown as SettingsSectionProps)} />)
    fireEvent.change(screen.getByLabelText('服务地址'), { target: { value: 'http://haichat.eos.3000y.store/v1' } })
    fireEvent.change(screen.getByLabelText('绘图模型'), { target: { value: 'paint' } })
    fireEvent.change(screen.getByLabelText('API 密钥'), { target: { value: 'private-key' } })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByLabelText('启用图像生成').hasAttribute('disabled')).toBe(false)
    fireEvent.click(screen.getByLabelText('启用图像生成'))
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    expect(save).toHaveBeenCalledWith({ endpoint: 'http://haichat.eos.3000y.store/v1', model: 'paint', enabled: true }, 'private-key')
    await waitFor(() => { expect(screen.getByLabelText('API 密钥')).toHaveProperty('value', 'private-key') })
    expect(screen.getByLabelText('服务地址')).toHaveProperty('value', 'http://haichat.eos.3000y.store/v1')
    expect(screen.getByLabelText('启用图像生成')).toHaveProperty('checked', true)
  })

  it('密钥写入已确认但启用失败时清空密码，保留配置草稿供重试', async () => {
    const save = vi.fn(async () => ({ ok: false, keySaved: true }))
    render(<SettingsSection {...({ t, save, useImageSettings: (pick: (view: unknown) => unknown) => pick({
      section: { status: 'ready', writable: true,
        value: { enabled: false, endpoint: '', model: 'paint', apiKeyRef: 'IMAGE_GEN_API_KEY' } },
      credential: { status: 'ready', ref: 'IMAGE_GEN_API_KEY', configured: false, writable: true },
      saving: false, failed: false,
    }) } as unknown as SettingsSectionProps)} />)
    fireEvent.change(screen.getByLabelText('服务地址'), { target: { value: 'https://images.example/v1' } })
    fireEvent.change(screen.getByLabelText('API 密钥'), { target: { value: 'accepted-secret' } })
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    await waitFor(() => { expect(screen.getByLabelText('API 密钥')).toHaveProperty('value', '') })
    expect(screen.getByLabelText('服务地址')).toHaveProperty('value', 'https://images.example/v1')
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    expect(save).toHaveBeenLastCalledWith({ enabled: false, endpoint: 'https://images.example/v1' }, '')
  })

  it('远端不能新选无鉴权，环境凭据不可写且密码框不泄露密钥', () => {
    render(<SettingsSection {...({ t, save: vi.fn(async () => true),
      useImageSettings: (pick: (view: unknown) => unknown) => pick({
        section: { status: 'ready', writable: true,
          value: { enabled: false, endpoint: 'https://images.example/v1', model: 'paint', apiKeyRef: 'ENV_IMAGE_KEY' } },
        credential: { status: 'ready', ref: 'ENV_IMAGE_KEY', configured: true, writable: false },
        saving: false, failed: false,
      }),
    } as unknown as SettingsSectionProps)} />)
    expect(screen.getByLabelText('本地服务无需 API 密钥').hasAttribute('disabled')).toBe(true)
    expect(screen.getByLabelText('API 密钥').hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(/环境变量或只读配置/u)).toBeTruthy()
    expect(screen.getByRole('button', { name: '保存设置' }).hasAttribute('disabled')).toBe(true)
  })

  it('设置分区只读时，即便凭据本身可写也不能修改密钥', () => {
    render(<SettingsSection {...({ t, save: vi.fn(async () => true),
      useImageSettings: (pick: (view: unknown) => unknown) => pick({
        section: { status: 'ready', writable: false,
          value: { enabled: false, endpoint: 'https://images.example/v1', model: 'paint', apiKeyRef: 'CUSTOM_KEY' } },
        credential: { status: 'ready', ref: 'CUSTOM_KEY', configured: true, writable: true },
        saving: false, failed: false,
      }),
    } as unknown as SettingsSectionProps)} />)
    expect(screen.getByLabelText('API 密钥').hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: '保存设置' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('当前设置不可更改。')).toBeTruthy()
  })

  it('缺少模型时开关禁用，但仍可先保存地址与模型草稿', () => {
    const save = vi.fn(async () => ({ ok: true, keySaved: false }))
    render(<SettingsSection {...({ t, save, useImageSettings: (pick: (view: unknown) => unknown) => pick({
      section: { status: 'ready', writable: true, value: { enabled: false, endpoint: '', model: '', apiKeyRef: '' } },
      credential: { status: 'ready', ref: '', configured: true, writable: false }, saving: false, failed: false,
    }) } as unknown as SettingsSectionProps)} />)
    const inactiveHint = screen.getByText('请填写服务地址、模型，并按需配置密钥后启用。')
    expect(inactiveHint.compareDocumentPosition(screen.getByText('服务地址')) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy()
    expect(screen.queryByText('保存后只显示是否已配置，不会显示密钥内容。')).toBeNull()
    expect(screen.getByLabelText('启用图像生成').hasAttribute('disabled')).toBe(true)
    fireEvent.change(screen.getByLabelText('服务地址'), { target: { value: 'http://localhost:8080' } })
    fireEvent.change(screen.getByLabelText('绘图模型'), { target: { value: 'paint' } })
    fireEvent.click(screen.getByText('保存设置'))
    expect(save).toHaveBeenCalledWith({ enabled: false, endpoint: 'http://localhost:8080', model: 'paint' }, '')
  })

  it('服务地址只在点击保存时校验，输入过程中不显示错误', () => {
    const save = vi.fn(async () => ({ ok: true, keySaved: false }))
    render(<SettingsSection {...({ t, save, useImageSettings: (pick: (view: unknown) => unknown) => pick({
      section: { status: 'ready', writable: true,
        value: { enabled: false, endpoint: '', model: 'paint', apiKeyRef: 'IMAGE_GEN_API_KEY' } },
      credential: { status: 'ready', ref: 'IMAGE_GEN_API_KEY', configured: true, writable: true },
      saving: false, failed: false,
    }) } as unknown as SettingsSectionProps)} />)
    const input = screen.getByLabelText('服务地址')
    fireEvent.change(input, { target: { value: 'https://' } })
    expect(screen.queryByText(/有效的 HTTP\(S\)/u)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    expect(screen.getByText(/有效的 HTTP\(S\)/u)).toBeTruthy()
    expect(save).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: 'https://images.example/v1' } })
    expect(screen.queryByText(/有效的 HTTP\(S\)/u)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    expect(save).toHaveBeenCalledWith({ enabled: false, endpoint: 'https://images.example/v1' }, '')
  })

  it('比例、尺寸与参考图上限不再出现在设置页', () => {
    render(<SettingsSection {...({ t, save: vi.fn(async () => ({ ok: true, keySaved: false })),
      useImageSettings: (pick: (view: unknown) => unknown) => pick({
        section: { status: 'ready', writable: true,
          value: { enabled: false, endpoint: 'http://localhost:8080/v1', model: 'paint', apiKeyRef: '', sizes: {}, maxEditReferences: 1 } },
        credential: { status: 'ready', ref: '', configured: true, writable: false }, saving: false, failed: false,
      }) } as unknown as SettingsSectionProps)} />)
    expect(screen.queryByText('比例与分辨率设置')).toBeNull()
    expect(screen.queryByLabelText('尺寸映射（JSON）')).toBeNull()
    expect(screen.queryByLabelText('单次图生图参考图上限')).toBeNull()
  })

  it('主内容画廊有三个子页，工作台可编辑并送入生成流程', () => {
    const item = { id: 'one', prompt: '晨光', attachmentId: 'att', createdAt: 1, model: 'paint', mediaType: 'image/png', width: 256, height: 256 }
    const generate = vi.fn(async () => true)
    const place = vi.fn(async () => true)
    const show = vi.fn()
    const view = { phase: 'ready', state: { enabled: true, available: true, model: 'paint' }, items: [item],
      generating: false, uploading: false, lastResultId: null, failed: false }
    const ui = createGalleryUiStore().create()
    const { unmount } = render(<GalleryView {...({ t, sessionId: 'test', closePage: vi.fn(),
      useGallery: (pick: (state: unknown) => unknown) => pick(view), useStore: bindSnapshotSelector(ui), actions: ui.actions,
      useImageCanvas: (pick: (state: unknown) => unknown) => pick({ phase: 'loading', nodes: [], selectedId: null, saving: false, issue: null }),
      canvas: { show: vi.fn(), refresh: vi.fn(), add: vi.fn(), select: vi.fn(), move: vi.fn(), remove: vi.fn(),
        clear: vi.fn(), url: vi.fn(() => '/image') },
      show, refresh: vi.fn(), generate, place, url: (id: string) => `/api/image-gen/image?sessionId=test&id=${id}`,
    } as unknown as GalleryViewProps)} />)
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['工作台', '灵感', '图库'])
    expect(screen.queryByRole('heading', { name: '画廊' })).toBeNull()
    expect(screen.getByRole('tab', { name: '工作台' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.queryByRole('button', { name: '会话画布' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'AI 画布' })).toBeNull()
    expect(screen.queryByText('比例与分辨率设置')).toBeNull()
    expect(screen.queryByLabelText('尺寸映射（JSON）')).toBeNull()
    expect(screen.getByRole('button', { name: '文生图' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByText(/API 已配置/u)).toBeNull()
    expect(screen.getByRole('button', { name: '比例' }).textContent).toContain('Auto · 自动')
    expect(screen.getByRole('button', { name: '生成质量' }).textContent).toBe('渠道默认')
    expect(screen.queryByText('渠道默认（不发送）')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '图生图' }))
    expect(screen.getByRole('button', { name: '开始生成' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '文生图' }))
    fireEvent.click(screen.getByRole('tab', { name: '图库' }))
    fireEvent.click(screen.getByRole('button', { name: '加入画布' }))
    expect(place).toHaveBeenCalledWith('one')
    fireEvent.click(screen.getByRole('button', { name: '基于此图创作' }))
    expect(screen.getByRole('tab', { name: '工作台' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('button', { name: '返回对话' })).toBeTruthy()
    const prompt = screen.getByLabelText('画面描述')
    expect(prompt).toHaveProperty('value', '晨光')
    fireEvent.submit(screen.getByLabelText('画面描述').closest('form')!)
    expect(generate).toHaveBeenCalledWith('晨光', 'one', {})
    unmount()
    expect(show).toHaveBeenLastCalledWith(false)
  })

  it('图生图把本机参考图先导入会话，再用其图库 ID 发编辑请求', async () => {
    const ui = createGalleryUiStore().create()
    const image = { id: 'imported', prompt: '', attachmentId: 'asset', createdAt: 1,
      model: 'import', mediaType: 'image/png', width: 1, height: 1 }
    const upload = vi.fn(async () => image)
    const generate = vi.fn(async () => true)
    render(<GalleryView {...({ t, sessionId: 'test', closePage: vi.fn(),
      useGallery: (pick: (state: unknown) => unknown) => pick({ phase: 'ready',
        state: { enabled: true, available: true, model: 'paint' }, items: [], generating: false,
        uploading: false, lastResultId: null, failed: false }),
      useStore: bindSnapshotSelector(ui), actions: ui.actions,
      useImageCanvas: (pick: (state: unknown) => unknown) => pick({ phase: 'loading', nodes: [], selectedId: null, saving: false, issue: null }),
      canvas: { show: vi.fn(), refresh: vi.fn(), add: vi.fn(), select: vi.fn(), move: vi.fn(), remove: vi.fn(),
        clear: vi.fn(), url: vi.fn(() => '/image') },
      show: vi.fn(), refresh: vi.fn(), generate, importReference: upload, place: vi.fn(),
      url: (id: string) => `/api/image-gen/image?sessionId=test&id=${id}`,
    } as unknown as GalleryViewProps)} />)
    fireEvent.click(screen.getByRole('button', { name: '图生图' }))
    const file = new File([Uint8Array.of(137, 80, 78, 71)], 'reference.png', { type: 'image/png' })
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    fireEvent.change(input, { target: { files: [file] } })
    await waitFor(() => { expect(upload).toHaveBeenCalledWith(file) })
    await waitFor(() => { expect(screen.getByRole('button', { name: '移除参考图' })).toBeTruthy() })
    fireEvent.change(screen.getByLabelText('画面描述'), { target: { value: '换成蓝色背景' } })
    fireEvent.click(screen.getByRole('button', { name: '开始生成' }))
    expect(generate).toHaveBeenCalledWith('换成蓝色背景', 'imported', {})
  })

  it('按比例、分辨率和生成质量提交上游参数，并呈现原版结果操作区', () => {
    const item = { id: 'one', prompt: '晨光', attachmentId: 'att', createdAt: 1,
      model: 'paint', mediaType: 'image/png', width: 1024, height: 1024 }
    const generate = vi.fn(async () => true)
    const ui = createGalleryUiStore().create()
    render(<GalleryView {...({ t, sessionId: 'test', closePage: vi.fn(),
      useGallery: (pick: (state: unknown) => unknown) => pick({ phase: 'ready',
        state: { enabled: true, available: true, model: 'paint', sizes: {
          '1:1': { '1K': '1024x1024' }, '16:9': { '1K': '1536x864', '2K': '2048x1152' },
        } }, items: [item], generating: false, uploading: false, lastResultId: 'one', failed: false }),
      useStore: bindSnapshotSelector(ui), actions: ui.actions,
      useImageCanvas: (pick: (state: unknown) => unknown) => pick({ phase: 'loading', nodes: [], selectedId: null, saving: false, issue: null }),
      canvas: { show: vi.fn(), refresh: vi.fn(), add: vi.fn(), select: vi.fn(), move: vi.fn(), remove: vi.fn(),
        clear: vi.fn(), url: vi.fn(() => '/image') },
      show: vi.fn(), refresh: vi.fn(), generate, importReference: vi.fn(), place: vi.fn(),
      url: (id: string) => `/api/image-gen/image?sessionId=test&id=${id}`,
    } as unknown as GalleryViewProps)} />)
    expect(screen.getByText('本次结果')).toBeTruthy()
    expect(screen.getByRole('button', { name: '继续编辑（垫图）' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '再次生成' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '复制图片' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '下载图片' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '继续编辑（垫图）' }))
    expect(screen.getByRole('button', { name: '图生图' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: '再次生成' }))
    expect(screen.getByRole('button', { name: '文生图' }).getAttribute('aria-pressed')).toBe('true')
    choose('比例', /16:9/u)
    choose('生成质量', '高')
    fireEvent.submit(screen.getByLabelText('画面描述').closest('form')!)
    expect(generate).toHaveBeenCalledWith('晨光', undefined, { size: '1536x864', quality: 'high' })
  })

  it('图库收藏、筛选与本机隐藏不改写会话目录', () => {
    const items = [
      { id: 'one', prompt: '晨光', attachmentId: 'att-1', createdAt: 2, model: 'paint', mediaType: 'image/png', width: 512, height: 512 },
      { id: 'two', prompt: '暮色', attachmentId: 'att-2', createdAt: 1, model: 'paint', mediaType: 'image/png', width: 640, height: 320 },
    ]
    const ui = createGalleryUiStore().create()
    const view = { phase: 'ready', state: { enabled: true, available: true, model: 'paint' }, items,
      generating: false, uploading: false, lastResultId: null, failed: false }
    render(<GalleryView {...({ t, sessionId: 'test', closePage: vi.fn(),
      useGallery: (pick: (state: unknown) => unknown) => pick(view), useStore: bindSnapshotSelector(ui), actions: ui.actions,
      useImageCanvas: (pick: (state: unknown) => unknown) => pick({ phase: 'loading', nodes: [], selectedId: null, saving: false, issue: null }),
      canvas: { show: vi.fn(), refresh: vi.fn(), add: vi.fn(), select: vi.fn(), move: vi.fn(), remove: vi.fn(),
        clear: vi.fn(), url: vi.fn(() => '/image') },
      show: vi.fn(), refresh: vi.fn(), generate: vi.fn(async () => true), place: vi.fn(async () => true),
      url: (id: string) => `/api/image-gen/image?sessionId=test&id=${id}`,
    } as unknown as GalleryViewProps)} />)
    fireEvent.click(screen.getByRole('tab', { name: '图库' }))
    fireEvent.click(screen.getAllByRole('button', { name: '加入收藏' })[0]!)
    fireEvent.click(screen.getByRole('button', { name: '收藏' }))
    expect(screen.getByText('共 1 张生成图片')).toBeTruthy()
    expect(screen.getAllByRole('tab')).toHaveLength(3)
    fireEvent.click(screen.getByRole('button', { name: '收藏' }))
    fireEvent.change(screen.getByPlaceholderText('搜索 Prompt、模型…'), { target: { value: '暮色' } })
    expect(screen.getByText('共 1 张生成图片')).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText('搜索 Prompt、模型…'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '批量管理' }))
    fireEvent.click(screen.getByRole('button', { name: '选择图片：晨光' }))
    fireEvent.click(screen.getByRole('button', { name: '从本机图库隐藏' }))
    expect(screen.getByRole('dialog', { name: '从本机图库隐藏' }).textContent).toContain('不会删除会话记录')
    fireEvent.click(screen.getByRole('button', { name: '确认' }))
    expect(screen.getByText('共 1 张生成图片')).toBeTruthy()
    expect(view.items).toHaveLength(2)
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
    const unconfigured = { t, wide: true, openGallery, useImageEntrySettings: (pick: (state: unknown) => unknown) => pick({
      section: { status: 'ready', value: { enabled: true, endpoint: 'https://images.example', model: 'paint', apiKeyRef: 'KEY' } },
      credential: { status: 'ready', configured: false, writable: true, ref: 'KEY' },
    }), useGalleryPage: (pick: (state: unknown) => unknown) => pick(null) }
    const { rerender } = render(<SidebarEntry {...(unconfigured as unknown as React.ComponentProps<typeof SidebarEntry>)} />)
    expect(screen.queryByRole('button')).toBeNull()
    rerender(<SidebarEntry {...({ ...unconfigured, useImageEntrySettings: (pick: (state: unknown) => unknown) => pick({
      section: { status: 'ready', value: { enabled: true, endpoint: 'https://images.example', model: 'paint', apiKeyRef: 'KEY' } },
      credential: { status: 'ready', configured: true, writable: true, ref: 'KEY' },
    }) } as unknown as React.ComponentProps<typeof SidebarEntry>)} />)
    fireEvent.click(screen.getByRole('button', { name: '画图' }))
    expect(openGallery).toHaveBeenCalledTimes(1)
  })

  it('会话页头入口只在画图会话显示，侧边栏入口跟随配置出现', () => {
    const openGallery = vi.fn(async () => {})
    const configured = { status: 'ready', value: { enabled: true, endpoint: 'https://images.example', model: 'paint', apiKeyRef: 'KEY' } }
    const credential = { status: 'ready', configured: true, writable: true, ref: 'KEY' }
    const entry = (preset: string) => ({
      t, openGallery,
      useSessions: (pick: (state: unknown) => unknown) => pick({
        current: 'session', byId: { session: { agentPreset: preset } },
      }),
      useImageEntrySettings: (pick: (state: unknown) => unknown) => pick({ section: configured, credential }),
    })
    const { unmount } = render(<EntryButton {...(entry('image') as unknown as React.ComponentProps<typeof EntryButton>)} />)
    expect(screen.getByRole('button', { name: '画图' })).toBeTruthy()
    unmount()
    render(<EntryButton {...(entry('standard') as unknown as React.ComponentProps<typeof EntryButton>)} />)
    expect(screen.queryByRole('button')).toBeNull()
    cleanup()
    const sidebarProps = { t, wide: true, openGallery,
      useImageEntrySettings: (pick: (state: unknown) => unknown) => pick({ section: configured, credential }),
      useGalleryPage: (pick: (state: unknown) => unknown) => pick(null),
    } as unknown as React.ComponentProps<typeof SidebarEntry>
    const sidebar = render(<SidebarEntry {...sidebarProps} />)
    expect(screen.getByRole('button', { name: '画图' }).textContent).toBe('画图')
    sidebar.rerender(<SidebarEntry {...{ ...sidebarProps, wide: false }} />)
    expect(screen.getByRole('button', { name: '画图' }).textContent).toBe('')
  })
})
