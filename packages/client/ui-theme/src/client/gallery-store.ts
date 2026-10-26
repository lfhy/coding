/**
 * 主题外观页面的 slot store：主题运行时与外观层两个快照的合成镜像。
 *
 * 只有插件体的同步函数写它；组件经 `props.useStore` 读。两份快照的 revision
 * 不能直接比较（各自独立递增），因此由同步方给一个本地的单调序号。
 */
import { defineStore, type EngineStoreHandle } from 'coding-client-runtime/client'
import type { GlassSettings, ImportedThemePack, WallpaperSettings } from '../theme-settings.ts'
import { DEFAULT_GLASS, DEFAULT_WALLPAPER } from '../theme-settings.ts'

/** 页面需要的全部状态。 */
export interface ThemeGalleryState {
  /** 持久化的主题选择。 */
  preference: string
  /** 当前生效的主题 id（选择尚未注册时回落到基础配色）。 */
  activeId: string
  /** 解析后的明暗。 */
  scheme: 'light' | 'dark'
  /** 强调色；空串表示跟随主题。 */
  accent: string
  /** 壁纸设置。 */
  wallpaper: WallpaperSettings
  /** 玻璃设置。 */
  glass: GlassSettings
  /** 收藏的主题 id。 */
  favorites: readonly string[]
  /** 导入的主题包。 */
  packs: readonly ImportedThemePack[]
  /** 合成变化序号（-1 表示还没同步过）。 */
  revision: number
}

/** 不含序号的页面状态。 */
export type ThemeGallerySnapshot = Omit<ThemeGalleryState, 'revision'>

/** 对外声明的写入口，保证工厂返回类型稳定。 */
type ThemeGalleryActions = {
  sync: (draft: ThemeGalleryState, next: ThemeGallerySnapshot, revision: number) => void
}

/**
 * 声明页面状态与写入面。
 * @returns 页面 store 句柄。
 */
export function createThemeGalleryStore(): EngineStoreHandle<ThemeGalleryState, ThemeGalleryActions> {
  return defineStore({
    init: (): ThemeGalleryState => ({
      preference: 'system',
      activeId: 'light',
      scheme: 'light',
      accent: '',
      wallpaper: DEFAULT_WALLPAPER,
      glass: DEFAULT_GLASS,
      favorites: [],
      packs: [],
      revision: -1,
    }),
    actions: {
      sync: (draft, next, revision) => {
        if (revision <= draft.revision) return
        draft.preference = next.preference
        draft.activeId = next.activeId
        draft.scheme = next.scheme
        draft.accent = next.accent
        draft.wallpaper = next.wallpaper
        draft.glass = next.glass
        draft.favorites = next.favorites
        draft.packs = next.packs
        draft.revision = revision
      },
    },
  })
}
