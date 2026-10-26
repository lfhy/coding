// @vitest-environment jsdom
/** 主题外观页面：卡片墙、筛选、搜索与高级外观控件都走注入的写操作。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { createSnapshotStore, type SessionListState, type WorkspaceListState } from 'coding-client-runtime/client'
import { bindSnapshotSelector } from 'coding-client-test-runtime'
import { ThemeGallery } from '../src/client/ThemeGallery.tsx'
import type { ThemeGalleryComponentProps, ThemeGalleryInjected } from '../src/client/ThemeGallery.tsx'
import { createThemeGalleryStore, type ThemeGallerySnapshot } from '../src/client/gallery-store.ts'
import { DEFAULT_GLASS, DEFAULT_WALLPAPER } from '../src/theme-settings.ts'

afterEach(cleanup)

const COPY: Record<string, string> = {
  'page.title': '主题外观',
  'page.intro': '挑一套配色。',
  'page.themes': '配色',
  'page.advanced': '高级外观',
  'filter.all': '全部',
  'filter.favorites': '收藏',
  'filter.imported': '导入',
  'search.label': '搜索主题',
  'search.placeholder': '搜索主题名称',
  'search.empty': '没有匹配的主题',
  'list.hint': '共 {count} 套配色',
  'scheme.light': '浅色',
  'scheme.dark': '深色',
  'scheme.auto': '跟随明暗',
  'card.current': '使用中',
  'action.favorite': '收藏',
  'action.unfavorite': '取消收藏',
  'action.random': '随机换一个',
  'action.reset': '还原默认',
  'wallpaper.title': '壁纸',
  'wallpaper.intro': '默认使用主题自带的弥散光。',
  'wallpaper.mode.theme': '跟随主题',
  'wallpaper.mode.off': '关闭',
  'wallpaper.mode.gradient': '渐变',
  'wallpaper.mode.image': '图片',
  'wallpaper.gradient': '渐变样式',
  'wallpaper.opacity': '可见度',
  'wallpaper.blur': '模糊',
  'wallpaper.fit': '填充方式',
  'wallpaper.fit.cover': '裁剪填满',
  'wallpaper.fit.contain': '完整显示',
  'wallpaper.fit.tile': '平铺',
  'wallpaper.url': '图片链接',
  'wallpaper.urlPlaceholder': '粘贴图片地址',
  'wallpaper.upload': '选择本地图片',
  'wallpaper.tooLarge': '太大',
  'wallpaper.unreadable': '读不出',
  'accent.title': '强调色',
  'accent.intro': '覆盖品牌色。',
  'accent.follow': '跟随主题',
  'accent.custom': '自定义颜色',
  'glass.title': '玻璃与不透明度',
  'glass.material': '材质',
  'glass.material.standard': '标准',
  'glass.material.frosted': '磨砂',
  'glass.panelOpacity': '面板不透明度',
  'glass.hint': '降低不透明度。',
  'pack.title': '主题包',
  'pack.intro': '导出或导入。',
  'pack.export': '导出当前主题',
  'pack.import': '导入主题包',
  'pack.share': '复制分享链接',
  'pack.remove': '移除',
  'pack.empty': '还没有导入过主题包。',
  'pack.imported': '已导入',
  'toast.imported': '已导入「{name}」',
  'toast.removed': '已移除「{name}」',
  'toast.exported': '已导出「{name}」',
  'toast.shared': '已复制',
  'toast.shareFailed': '没有地址',
  'toast.importFailed': '无法导入：{reason}',
}

function emptySessions() {
  const store = createSnapshotStore<SessionListState>(
    { ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined })
  return bindSnapshotSelector(store)
}

function emptyWorkspaces() {
  const store = createSnapshotStore<WorkspaceListState>({
    items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
    baselinesReady: true, recentWorkspaceId: undefined,
  })
  return bindSnapshotSelector(store)
}

const t = (key: string, params?: Record<string, unknown>): string => {
  const template = COPY[key] ?? key
  if (params === undefined) return template
  return Object.entries(params).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    template,
  )
}

/** 组装页面；注入面全部用 spy，断言点击到底走了哪条写操作。 */
function mount(patch: Partial<ThemeGallerySnapshot> = {}) {
  const store = createThemeGalleryStore().create()
  act(() => {
    store.actions.sync({
      preference: 'system',
      activeId: 'light',
      scheme: 'light',
      accent: '',
      wallpaper: DEFAULT_WALLPAPER,
      glass: DEFAULT_GLASS,
      favorites: [],
      packs: [],
      ...patch,
    }, 0)
  })
  const injected: ThemeGalleryInjected = {
    selectTheme: vi.fn(),
    toggleFavorite: vi.fn(),
    selectRandomTheme: vi.fn(),
    resetAppearance: vi.fn(),
    setAccent: vi.fn(),
    setWallpaper: vi.fn(),
    setGlass: vi.fn(),
    importPackText: vi.fn(() => ({ ok: true, name: 'Paper' })),
    exportCurrentPack: vi.fn(() => ({ text: '{}', filename: 'a.json', name: '演示' })),
    shareCurrentPack: vi.fn(() => 'http://localhost/#theme-pack=x'),
    removePack: vi.fn(),
  }
  const props: ThemeGalleryComponentProps = {
    close: () => {},
    useSessions: emptySessions(),
    useWorkspaces: emptyWorkspaces(),
    useStore: bindSnapshotSelector(store),
    actions: store.actions,
    t,
    ...injected,
  }
  render(<ThemeGallery {...props} />)
  return { store, injected }
}

describe('ThemeGallery', () => {
  it('renders the title, the built-in choices, and the ported palettes', () => {
    mount()
    expect(screen.getByText('主题外观')).toBeDefined()
    // 内置三项 + 47 套移植配色。
    expect(screen.getByText('共 50 套配色')).toBeDefined()
    expect(screen.getByText('沉静蓝')).toBeDefined()
    expect(screen.getByText('德古拉')).toBeDefined()
    expect(screen.getByText('轴伊 · 花语')).toBeDefined()
  })

  it('switches theme when a card is clicked', () => {
    const { injected } = mount()
    fireEvent.click(screen.getByRole('button', { name: /沉静蓝/ }))
    expect(injected.selectTheme).toHaveBeenCalledWith('dream-abyss')
  })

  it('marks the active card and favorites through the store', () => {
    const { injected } = mount({ preference: 'oc-dracula', favorites: ['dream-abyss'] })
    const grid = screen.getByRole('group', { name: /共 \d+ 套配色/ })
    const active = within(grid).getByRole('button', { name: /德古拉/ })
    expect(active.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getAllByText('使用中').length).toBe(1)
    // 卡片墙里的收藏开关与筛选条上的「收藏」是两件事，按区域取。
    fireEvent.click(within(grid).getAllByRole('button', { name: '取消收藏' })[0]!)
    expect(injected.toggleFavorite).toHaveBeenCalledWith('dream-abyss')
  })

  it('filters by favorites and by search text', () => {
    mount({ favorites: ['dream-ivory'] })
    const filters = screen.getByRole('group', { name: '配色' })
    fireEvent.click(within(filters).getByRole('button', { name: '收藏' }))
    expect(screen.getByText('共 1 套配色')).toBeDefined()
    expect(screen.getByText('iOS 扁平')).toBeDefined()

    fireEvent.click(within(filters).getByRole('button', { name: '全部' }))
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '德古拉' } })
    expect(screen.getByText('共 1 套配色')).toBeDefined()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '不存在的主题' } })
    expect(screen.getByText('没有匹配的主题')).toBeDefined()
  })

  it('routes random and reset to the injected actions', () => {
    const { injected } = mount()
    fireEvent.click(screen.getByRole('button', { name: '随机换一个' }))
    fireEvent.click(screen.getByRole('button', { name: '还原默认' }))
    expect(injected.selectRandomTheme).toHaveBeenCalled()
    expect(injected.resetAppearance).toHaveBeenCalled()
  })

  it('drives the wallpaper controls', () => {
    const { injected } = mount()
    const wallpaper = screen.getByText('壁纸').closest('section')!
    fireEvent.click(within(wallpaper).getByRole('button', { name: '渐变' }))
    expect(injected.setWallpaper).toHaveBeenCalledWith({ mode: 'gradient' })
    fireEvent.click(within(wallpaper).getByRole('button', { name: '图片' }))
    expect(injected.setWallpaper).toHaveBeenCalledWith({ mode: 'image' })
    fireEvent.change(within(wallpaper).getByLabelText('可见度'), { target: { value: '0.25' } })
    expect(injected.setWallpaper).toHaveBeenCalledWith({ opacity: 0.25 })
    fireEvent.change(within(wallpaper).getByLabelText('模糊'), { target: { value: '12' } })
    expect(injected.setWallpaper).toHaveBeenCalledWith({ blur: 12 })
  })

  it('shows the image fields only for the image source', () => {
    mount({ wallpaper: { ...DEFAULT_WALLPAPER, mode: 'image', url: 'https://example.com/a.png' } })
    expect(screen.getByLabelText('图片链接')).toBeDefined()
    expect(screen.getByRole('button', { name: '平铺' })).toBeDefined()
  })

  it('drives the accent, material, and pack controls', () => {
    const { injected } = mount()
    const accent = screen.getByText('强调色').closest('section')!
    fireEvent.click(within(accent).getByRole('button', { name: '跟随主题' }))
    expect(injected.setAccent).toHaveBeenCalledWith('')
    fireEvent.click(screen.getByRole('button', { name: '磨砂' }))
    expect(injected.setGlass).toHaveBeenCalledWith({ material: 'frosted' })
    fireEvent.click(screen.getByRole('button', { name: '导出当前主题' }))
    expect(injected.exportCurrentPack).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '导入主题包' }))
    expect(injected.importPackText).not.toHaveBeenCalled()
  })

  it('lists imported packs and removes them', () => {
    const { injected } = mount({
      packs: [{ id: 'imported-paper', name: '宣纸', englishName: 'Paper', scheme: 'light', tokens: { '--dsw-alias-bg-base': '#fdfaf4' } }],
    })
    // 导入的主题包同时出现在卡片墙和主题包列表里。
    expect(screen.getAllByText('宣纸').length).toBe(2)
    fireEvent.click(screen.getByRole('button', { name: '移除' }))
    expect(injected.removePack).toHaveBeenCalledWith('imported-paper')
  })
})
