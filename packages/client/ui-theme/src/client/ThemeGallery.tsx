/**
 * 主题外观页面：设置里的「主题外观」分区。
 *
 * 上半部分是配色墙：内置三项外观 + 三个上游移植来的主题目录 + 导入的主题包，
 * 点一张卡片即切换；下半部分是高级外观（壁纸、强调色、玻璃、主题包），数据
 * 与写操作都由插件体注入。筛选与搜索是页面自己的浏览状态，不入 store。
 */
import { useMemo, useState } from 'react'
import clsx from 'clsx'
import type {
  InjectFace, PropsLocale, PropsRuntime, PropsStore,
} from 'coding-client-ui-slots'
import type { ImportedThemePack } from '../theme-settings.ts'
import type { ThemePresetData } from '../themes/types.ts'
import {
  BASE_THEME_CHOICES, THEME_PRESETS, THEME_SOURCES, themeGroupOf,
  type ThemeGroupId, type ThemePreset, type ThemeSourceId,
} from '../themes/catalog.ts'
import { readableOn } from '../themes/color.ts'
import type { createThemeGalleryStore } from './gallery-store.ts'
import type { AppearanceAdvancedInjected } from './AppearanceAdvanced.tsx'
import { AppearanceAdvanced } from './AppearanceAdvanced.tsx'
import { ThemeCard } from './ThemeCard.tsx'
import css from './ThemeGallery.module.css'

/** 页面注入的写操作。 */
export interface ThemeGalleryInjected extends AppearanceAdvancedInjected {
  /** 切换到指定主题（内置偏好或预设 id）。 */
  selectTheme: (id: string) => void
  /** 收藏/取消收藏。 */
  toggleFavorite: (id: string) => void
  /** 随机换一个不同的主题。 */
  selectRandomTheme: () => void
  /** 还原默认外观。 */
  resetAppearance: () => void
}

/** 完整组件属性：运行期座位 + store + 本地化座位 + 注入面。 */
export type ThemeGalleryComponentProps =
  PropsRuntime<'settings.section'>
  & PropsStore<ReturnType<typeof createThemeGalleryStore>>
  & PropsLocale<'settings.theme'>
  & InjectFace<ThemeGalleryInjected>

/** 来源筛选：`all` 与 `favorites` 之外按来源 id 过滤。 */
type Filter = 'all' | 'favorites' | ThemeSourceId

/**
 * 一张主题卡片的展示数据。
 */
interface GalleryEntry {
  id: string
  name: string
  englishName: string
  scheme: 'light' | 'dark' | 'auto'
  preview: { background: string; text: string; accent: string }
  source: ThemeSourceId
  group: ThemeGroupId
  imported: boolean
}

/** 内置三项外观转成卡片数据（它们不是注册主题，预览色取自设计基线）。 */
function baseEntries(): GalleryEntry[] {
  return BASE_THEME_CHOICES.map(choice => ({
    id: choice.id,
    name: choice.name,
    englishName: choice.englishName,
    scheme: choice.scheme,
    preview: choice.preview,
    source: 'builtin' as const,
    group: 'neutral' as ThemeGroupId,
    imported: false,
  }))
}

/** 目录条目转成卡片数据。 */
function presetEntry(preset: ThemePreset): GalleryEntry {
  return {
    id: preset.id,
    name: preset.name,
    englishName: preset.englishName,
    scheme: preset.scheme,
    preview: preset.preview,
    source: preset.source,
    group: themeGroupOf(preset),
    imported: preset.source === 'imported',
  }
}

/** 导入的主题包转成卡片数据；预览色从令牌里取。 */
function packEntry(pack: ImportedThemePack): GalleryEntry {
  const data: ThemePresetData = {
    id: pack.id,
    name: pack.name,
    englishName: pack.englishName,
    scheme: pack.scheme,
    ...(pack.tokens === undefined ? {} : { tokens: pack.tokens }),
    ...(pack.palettes === undefined ? {} : { palettes: pack.palettes }),
  }
  const tokens = data.scheme === 'auto' ? data.palettes?.dark ?? data.palettes?.light : data.tokens
  const background = tokens?.['--dsw-alias-bg-base'] ?? '#1b1d21'
  const accent = pack.accent !== undefined && pack.accent !== '' ? pack.accent : tokens?.['--dsw-alias-brand-primary'] ?? '#5a6cff'
  return {
    id: pack.id,
    name: pack.name,
    englishName: pack.englishName,
    scheme: pack.scheme,
    preview: { background, text: tokens?.['--dsw-alias-label-primary'] ?? readableOn(background), accent },
    source: 'imported',
    group: 'neutral',
    imported: true,
  }
}

/**
 * 渲染主题外观页面。
 * @param props - 本地化座位、页面状态与写操作。
 * @returns 页面元素树。
 */
export function ThemeGallery({ t, useStore, ...actions }: ThemeGalleryComponentProps) {
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const preference = useStore(s => s.preference)
  const favorites = useStore(s => s.favorites)
  const packs = useStore(s => s.packs)
  const accent = useStore(s => s.accent)
  const wallpaper = useStore(s => s.wallpaper)
  const glass = useStore(s => s.glass)

  const entries = useMemo(() => {
    const all: GalleryEntry[] = [
      ...baseEntries(),
      ...THEME_PRESETS.map(presetEntry),
      ...packs.map(packEntry),
    ]
    const needle = query.trim().toLowerCase()
    return all.filter((entry) => {
      if (filter === 'favorites') {
        if (!favorites.includes(entry.id)) return false
      } else if (filter !== 'all' && entry.source !== filter) {
        return false
      }
      if (needle === '') return true
      return entry.name.toLowerCase().includes(needle) || entry.englishName.toLowerCase().includes(needle)
    })
  }, [filter, query, favorites, packs])

  const filters: ReadonlyArray<{ id: Filter; label: string }> = [
    { id: 'all', label: t('filter.all') },
    { id: 'favorites', label: t('filter.favorites') },
    ...THEME_SOURCES.filter(source => source.id !== 'builtin' && source.id !== 'imported')
      .map(source => ({ id: source.id as Filter, label: source.name })),
    { id: 'builtin', label: THEME_SOURCES[0]?.name ?? '内置配色' },
    { id: 'imported', label: t('filter.imported') },
  ]

  return (
    <div className={css.page}>
      <header className={css.header}>
        <h2 className={css.title}>{t('page.title')}</h2>
        <p className={css.intro}>{t('page.intro')}</p>
      </header>

      <div className={css.toolbar}>
        <div className={css.filters} role="group" aria-label={t('page.themes')}>
          {filters.map(entry => (
            <button
              key={entry.id}
              type="button"
              className={clsx(css.filter, filter === entry.id && css.filterOn)}
              aria-pressed={filter === entry.id}
              onClick={() => { setFilter(entry.id) }}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <label className={css.search}>
          <span className={css.searchLabel}>{t('search.label')}</span>
          <input
            className={css.searchInput}
            type="search"
            value={query}
            placeholder={t('search.placeholder')}
            onChange={(event) => { setQuery(event.target.value) }}
          />
        </label>
      </div>

      <p className={css.count}>{t('list.hint', { count: entries.length })}</p>

      {entries.length === 0
        ? <p className={css.empty}>{t('search.empty')}</p>
        : (
          <div className={css.grid} role="group" aria-label={t('list.hint', { count: entries.length })}>
            {entries.map(entry => (
              <ThemeCard
                key={entry.id}
                id={entry.id}
                name={entry.name}
                scheme={entry.scheme}
                preview={entry.preview}
                selected={preference === entry.id}
                favorite={favorites.includes(entry.id)}
                imported={entry.imported}
                labels={{
                  current: t('card.current'),
                  favorite: t('action.favorite'),
                  unfavorite: t('action.unfavorite'),
                  scheme: t(entry.scheme === 'light' ? 'scheme.light' : entry.scheme === 'dark' ? 'scheme.dark' : 'scheme.auto'),
                  imported: t('pack.imported'),
                }}
                onSelect={actions.selectTheme}
                onToggleFavorite={actions.toggleFavorite}
              />
            ))}
          </div>
        )}

      <div className={css.footerActions}>
        <button type="button" className={css.action} onClick={actions.selectRandomTheme}>
          {t('action.random')}
        </button>
        <button type="button" className={css.action} onClick={actions.resetAppearance}>
          {t('action.reset')}
        </button>
      </div>

      <h3 className={css.sectionTitle}>{t('page.advanced')}</h3>
      <AppearanceAdvanced
        t={t}
        accent={accent}
        wallpaper={wallpaper}
        glass={glass}
        packs={packs}
        setAccent={actions.setAccent}
        setWallpaper={actions.setWallpaper}
        setGlass={actions.setGlass}
        importPackText={actions.importPackText}
        exportCurrentPack={actions.exportCurrentPack}
        shareCurrentPack={actions.shareCurrentPack}
        removePack={actions.removePack}
      />
    </div>
  )
}
