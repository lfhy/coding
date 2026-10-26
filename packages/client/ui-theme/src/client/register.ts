/**
 * 主题特征自己的设置界面：General 分区的外观行 + 独立的「主题外观」分区页面。
 *
 * 两个入口都注册在主题插件自己的 fiber 上：该特征拥有自己的设置界面，别的
 * 分区不因为多了一个外观设置而改动。
 */
import type { ClientContext } from 'coding-client-runtime/client'
import type { BoundActions } from 'coding-client-ui-slots'
import {
  THEME_PRESETS, type ThemePreset,
} from '../themes/catalog.ts'
import type { ThemeDefinition, ThemeRuntime, ThemeSnapshot } from './theme-runtime.ts'
import type { AppearanceRuntime, AppearanceSnapshot } from './appearance-runtime.ts'
import type { AppearanceRowInjected } from './AppearanceRow.tsx'
import type { ThemeGalleryInjected } from './ThemeGallery.tsx'
import { AppearanceRow } from './AppearanceRow.tsx'
import { ThemeGallery } from './ThemeGallery.tsx'
import { createAppearanceRowStore } from './settings-store.ts'
import { createThemeGalleryStore } from './gallery-store.ts'
import { themePackShareUrl } from './theme-pack.ts'

/** 本特征设置界面的文案命名空间。 */
export const SETTINGS_NS = 'settings.theme'

/** 目录条目转成运行时主题定义。 */
export function definitionOfPreset(preset: ThemePreset): ThemeDefinition {
  if (preset.scheme === 'auto') {
    return {
      id: preset.id,
      colorScheme: 'auto',
      tokens: {},
      palettes: { light: preset.palettes.light ?? {}, dark: preset.palettes.dark ?? {} },
    }
  }
  return {
    id: preset.id,
    colorScheme: preset.scheme,
    tokens: (preset.scheme === 'light' ? preset.palettes.light : preset.palettes.dark) ?? {},
  }
}

/**
 * 把内置目录注册进主题运行时，并随插件 fiber 撤销。
 * @param ctx - 客户端插件上下文。
 * @param theme - 主题运行时。
 */
export function registerThemeCatalog(ctx: ClientContext, theme: ThemeRuntime): void {
  for (const preset of THEME_PRESETS) {
    ctx.effect(() => theme.register(definitionOfPreset(preset)), `ui-theme: preset ${preset.id}`)
  }
}

/**
 * 注册 General 分区的外观行。
 * @param ctx - 客户端插件上下文。
 * @param theme - 主题运行时。
 */
export function registerAppearanceRow(ctx: ClientContext, theme: ThemeRuntime): void {
  const store = createAppearanceRowStore()
  let bound: BoundActions<typeof store> | undefined
  const sync = (snapshot: ThemeSnapshot): void => {
    bound?.sync(snapshot.preference, snapshot.active.colorScheme, snapshot.revision)
  }
  ctx.on('theme/change', sync)
  const injected = (actions: BoundActions<typeof store>): AppearanceRowInjected => {
    bound = actions
    // 从 getter 重新同步，注册到首帧之间的事件不会丢（store 的序号守卫会丢掉重复项）。
    sync(theme.getTheme())
    return { setTheme: (id) => { theme.setTheme(id) } }
  }
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'appearance',
    order: 10,
    store,
    locale: SETTINGS_NS,
    inject: injected,
  }, AppearanceRow))
}

/**
 * 注册「主题外观」设置分区。
 * @param ctx - 客户端插件上下文。
 * @param theme - 主题运行时。
 * @param appearance - 外观层（强调色、壁纸、玻璃、主题包）。
 */
export function registerThemeGallery(
  ctx: ClientContext,
  theme: ThemeRuntime,
  appearance: AppearanceRuntime,
): void {
  const t = ctx.locale.bind(SETTINGS_NS)
  const store = createThemeGalleryStore()
  let bound: BoundActions<typeof store> | undefined
  let sequence = 0
  // 两个运行时各自递增 revision，这里统一换成本地单调序号：只有真正变化才发布。
  let signature = ''
  const sync = (): void => {
    if (bound === undefined) return
    const themeSnapshot = theme.getTheme()
    const appearanceSnapshot = appearance.getSnapshot()
    const next = {
      preference: themeSnapshot.preference,
      activeId: themeSnapshot.active.id,
      scheme: themeSnapshot.active.colorScheme,
      accent: appearanceSnapshot.accent,
      wallpaper: appearanceSnapshot.wallpaper,
      glass: appearanceSnapshot.glass,
      favorites: appearanceSnapshot.favorites,
      packs: appearanceSnapshot.packs,
    }
    const encoded = JSON.stringify({
      ...next,
      packs: next.packs.map(pack => ({ id: pack.id, name: pack.name })),
    })
    if (encoded === signature) return
    signature = encoded
    sequence += 1
    bound.sync(next, sequence)
  }
  ctx.on('theme/change', sync)
  ctx.on('theme/appearance-change', sync)

  const injected = (actions: BoundActions<typeof store>): ThemeGalleryInjected => {
    bound = actions
    sync()
    const currentPack = (): { text: string; filename: string; name: string } | undefined => {
      const id = theme.getTheme().preference
      const text = appearance.exportPack(id)
      if (text === undefined) return undefined
      // 文件名与提示名都用主题包里记录的名字：导入的主题包也能导出成自己的名字。
      const name = (JSON.parse(text) as { name?: string }).name ?? t('page.title')
      return { text, filename: `${name}.theme.json`, name }
    }
    return {
      selectTheme: (id) => { theme.setTheme(id) },
      toggleFavorite: (id) => { appearance.toggleFavorite(id) },
      selectRandomTheme: () => {
        const candidates = THEME_PRESETS.filter(preset => preset.id !== theme.getTheme().preference)
        const picked = candidates[Math.floor(Math.random() * candidates.length)]
        if (picked !== undefined) theme.setTheme(picked.id)
      },
      resetAppearance: () => { appearance.reset() },
      setAccent: (color) => { appearance.setAccent(color) },
      setWallpaper: (patch) => { appearance.setWallpaper(patch) },
      setGlass: (patch) => { appearance.setGlass(patch) },
      importPackText: (text) => {
        const result = appearance.importPack(text)
        if (!result.ok) return { ok: false, reason: result.reason ?? '' }
        const pack = appearance.getSnapshot().packs.find(candidate => candidate.id === result.id)
        return { ok: true, name: pack?.name ?? result.id ?? '' }
      },
      exportCurrentPack: currentPack,
      shareCurrentPack: () => {
        const text = appearance.exportPack(theme.getTheme().preference)
        if (text === undefined) return undefined
        const pack = JSON.parse(text) as Parameters<typeof themePackShareUrl>[0]
        return themePackShareUrl(pack) || undefined
      },
      removePack: (id) => { appearance.removePack(id) },
    }
  }

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'appearance',
    order: 11,
    label: () => t('page.title'),
    locale: SETTINGS_NS,
    store,
    inject: injected,
  }, ThemeGallery))
}

export type { AppearanceSnapshot }
