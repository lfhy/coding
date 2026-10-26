/**
 * 高级外观面板：壁纸、强调色、玻璃与主题包。
 *
 * 纯展示组件：数据从属性进来，写操作通过回调交回插件体。所有颜色都来自
 * 主题目录或用户选择，因此色块用行内样式渲染；控件本身只用设计令牌。
 */
import { useId, useRef, useState } from 'react'
import clsx from 'clsx'
import { Button, Toast, writeClipboard } from 'coding-client-ui-primitives'
import type { TranslateNS } from 'coding-client-ui-slots'
import type {
  GlassSettings, ImportedThemePack, WallpaperFit, WallpaperMode, WallpaperSettings,
} from '../theme-settings.ts'
import { MAX_WALLPAPER_DATA_URL } from '../theme-settings.ts'
import { ACCENT_SWATCHES, WALLPAPER_GRADIENTS, readWallpaperImage } from './wallpaper.ts'
import css from './AppearanceAdvanced.module.css'

/** 一次提示的文案与序号（序号用于同一文案重复出现时重新播放动画）。 */
interface Notice {
  /** 递增序号。 */
  seq: number
  /** 已本地化的文案。 */
  text: string
}

/** 父级注入的写操作。 */
export interface AppearanceAdvancedInjected {
  /** 设置强调色；空串表示跟随主题。 */
  setAccent: (color: string) => void
  /** 改写壁纸设置。 */
  setWallpaper: (patch: Partial<WallpaperSettings>) => void
  /** 改写玻璃设置。 */
  setGlass: (patch: Partial<GlassSettings>) => void
  /** 导入一段主题包 JSON。 */
  importPackText: (text: string) => { ok: boolean; reason?: string; name?: string }
  /** 导出当前主题为主题包。 */
  exportCurrentPack: () => { text: string; filename: string; name: string } | undefined
  /** 生成当前主题的分享链接。 */
  shareCurrentPack: () => string | undefined
  /** 移除导入的主题包。 */
  removePack: (id: string) => void
}

/** 完整属性：本地化座位 + 当前数据 + 写操作。 */
export interface AppearanceAdvancedProps extends AppearanceAdvancedInjected {
  /** 本命名空间的翻译函数。 */
  t: TranslateNS<'settings.theme'>
  /** 当前强调色。 */
  accent: string
  /** 当前壁纸设置。 */
  wallpaper: WallpaperSettings
  /** 当前玻璃设置。 */
  glass: GlassSettings
  /** 已导入的主题包。 */
  packs: readonly ImportedThemePack[]
}

/** 壁纸来源按钮的顺序与文案键。 */
const MODES: ReadonlyArray<{ id: WallpaperMode; key: 'wallpaper.mode.theme' | 'wallpaper.mode.off' | 'wallpaper.mode.gradient' | 'wallpaper.mode.image' }> = [
  { id: 'theme', key: 'wallpaper.mode.theme' },
  { id: 'off', key: 'wallpaper.mode.off' },
  { id: 'gradient', key: 'wallpaper.mode.gradient' },
  { id: 'image', key: 'wallpaper.mode.image' },
]

/** 图片填充方式的顺序与文案键。 */
const FITS: ReadonlyArray<{ id: WallpaperFit; key: 'wallpaper.fit.cover' | 'wallpaper.fit.contain' | 'wallpaper.fit.tile' }> = [
  { id: 'cover', key: 'wallpaper.fit.cover' },
  { id: 'contain', key: 'wallpaper.fit.contain' },
  { id: 'tile', key: 'wallpaper.fit.tile' },
]

/**
 * 渲染高级外观面板。
 * @param props - 本地化座位、当前设置与写操作。
 * @returns 面板元素树。
 */
export function AppearanceAdvanced(props: AppearanceAdvancedProps) {
  const { t, accent, wallpaper, glass, packs } = props
  const [notice, setNotice] = useState<Notice | null>(null)
  const noticeSeq = useRef(0)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const imageRef = useRef<HTMLInputElement | null>(null)
  const ids = { url: useId(), blur: useId(), opacity: useId(), panel: useId() }

  const show = (text: string): void => {
    noticeSeq.current += 1
    setNotice({ seq: noticeSeq.current, text })
  }

  const importFile = async (file: File): Promise<void> => {
    const text = await file.text()
    const result = props.importPackText(text)
    if (!result.ok) {
      show(t('toast.importFailed', { reason: result.reason ?? '' }))
      return
    }
    show(t('toast.imported', { name: result.name ?? file.name }))
  }

  const pickImage = async (file: File): Promise<void> => {
    const result = await readWallpaperImage(file, MAX_WALLPAPER_DATA_URL)
    if (!result.ok) {
      show(t(result.reason === 'too-large' ? 'wallpaper.tooLarge' : 'wallpaper.unreadable'))
      return
    }
    props.setWallpaper({ mode: 'image', url: result.dataUrl })
  }

  const exportCurrent = (): void => {
    const pack = props.exportCurrentPack()
    if (pack === undefined) return
    const blob = new Blob([pack.text], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = pack.filename
    anchor.click()
    URL.revokeObjectURL(url)
    show(t('toast.exported', { name: pack.name }))
  }

  const share = async (): Promise<void> => {
    const link = props.shareCurrentPack()
    if (link === undefined) {
      show(t('toast.shareFailed'))
      return
    }
    const copied = await writeClipboard(link)
    show(t(copied ? 'toast.shared' : 'toast.shareFailed'))
  }

  return (
    <div className={css.panel}>
      <section className={css.block} aria-labelledby={`${ids.url}-wallpaper`}>
        <h3 className={css.heading} id={`${ids.url}-wallpaper`}>{t('wallpaper.title')}</h3>
        <p className={css.hint}>{t('wallpaper.intro')}</p>
        <div className={css.segments} role="group" aria-label={t('wallpaper.title')}>
          {MODES.map(mode => (
            <button
              key={mode.id}
              type="button"
              className={clsx(css.segment, wallpaper.mode === mode.id && css.segmentOn)}
              aria-pressed={wallpaper.mode === mode.id}
              onClick={() => { props.setWallpaper({ mode: mode.id }) }}
            >
              {t(mode.key)}
            </button>
          ))}
        </div>

        {wallpaper.mode === 'gradient' && (
          <div className={css.swatches} role="group" aria-label={t('wallpaper.gradient')}>
            {WALLPAPER_GRADIENTS.map(gradient => (
              <button
                key={gradient.id}
                type="button"
                className={clsx(css.gradientSwatch, wallpaper.gradient === gradient.id && css.swatchOn)}
                style={{ background: gradient.background }}
                aria-pressed={wallpaper.gradient === gradient.id}
                aria-label={gradient.name}
                title={gradient.name}
                onClick={() => { props.setWallpaper({ gradient: gradient.id }) }}
              />
            ))}
          </div>
        )}

        {wallpaper.mode === 'image' && (
          <div className={css.imageRow}>
            <label className={css.field} htmlFor={ids.url}>
              <span className={css.fieldLabel}>{t('wallpaper.url')}</span>
              <input
                id={ids.url}
                className={css.input}
                type="url"
                value={wallpaper.url.startsWith('data:') ? '' : wallpaper.url}
                placeholder={t('wallpaper.urlPlaceholder')}
                onChange={(event) => { props.setWallpaper({ url: event.target.value.trim() }) }}
              />
            </label>
            <Button
              variant="ghost"
              onClick={() => { imageRef.current?.click() }}
            >
              {t('wallpaper.upload')}
            </Button>
            <input
              ref={imageRef}
              className={css.hiddenInput}
              type="file"
              accept="image/*"
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file !== undefined) void pickImage(file)
              }}
            />
            <div className={css.segments} role="group" aria-label={t('wallpaper.fit')}>
              {FITS.map(fit => (
                <button
                  key={fit.id}
                  type="button"
                  className={clsx(css.segment, wallpaper.fit === fit.id && css.segmentOn)}
                  aria-pressed={wallpaper.fit === fit.id}
                  onClick={() => { props.setWallpaper({ fit: fit.id }) }}
                >
                  {t(fit.key)}
                </button>
              ))}
            </div>
          </div>
        )}

        {wallpaper.mode !== 'off' && (
          <div className={css.sliders}>
            <div className={css.slider}>
              <label className={css.fieldLabel} htmlFor={ids.opacity}>{t('wallpaper.opacity')}</label>
              <input
                id={ids.opacity}
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={wallpaper.opacity}
                onChange={(event) => { props.setWallpaper({ opacity: Number(event.target.value) }) }}
              />
              <span className={css.sliderValue}>{Math.round(wallpaper.opacity * 100)}%</span>
            </div>
            <div className={css.slider}>
              <label className={css.fieldLabel} htmlFor={ids.blur}>{t('wallpaper.blur')}</label>
              <input
                id={ids.blur}
                type="range"
                min={0}
                max={40}
                step={1}
                value={wallpaper.blur}
                onChange={(event) => { props.setWallpaper({ blur: Number(event.target.value) }) }}
              />
              <span className={css.sliderValue}>{wallpaper.blur}px</span>
            </div>
          </div>
        )}
      </section>

      <section className={css.block}>
        <h3 className={css.heading}>{t('accent.title')}</h3>
        <p className={css.hint}>{t('accent.intro')}</p>
        <div className={css.accentRow}>
          <button
            type="button"
            className={clsx(css.segment, accent === '' && css.segmentOn)}
            aria-pressed={accent === ''}
            onClick={() => { props.setAccent('') }}
          >
            {t('accent.follow')}
          </button>
          {ACCENT_SWATCHES.map(swatch => (
            <button
              key={swatch.color}
              type="button"
              className={clsx(css.colorSwatch, accent.toLowerCase() === swatch.color.toLowerCase() && css.swatchOn)}
              style={{ background: swatch.color }}
              aria-pressed={accent.toLowerCase() === swatch.color.toLowerCase()}
              aria-label={swatch.name}
              title={swatch.name}
              onClick={() => { props.setAccent(swatch.color) }}
            />
          ))}
          <label className={css.customColor}>
            <span className={css.fieldLabel}>{t('accent.custom')}</span>
            <input
              type="color"
              aria-label={t('accent.custom')}
              value={accent === '' ? '#5a6cff' : accent}
              onChange={(event) => { props.setAccent(event.target.value) }}
            />
          </label>
        </div>
      </section>

      <section className={css.block}>
        <h3 className={css.heading}>{t('glass.title')}</h3>
        <div className={css.segments} role="group" aria-label={t('glass.material')}>
          <button
            type="button"
            className={clsx(css.segment, glass.material === 'standard' && css.segmentOn)}
            aria-pressed={glass.material === 'standard'}
            onClick={() => { props.setGlass({ material: 'standard' }) }}
          >
            {t('glass.material.standard')}
          </button>
          <button
            type="button"
            className={clsx(css.segment, glass.material === 'frosted' && css.segmentOn)}
            aria-pressed={glass.material === 'frosted'}
            onClick={() => { props.setGlass({ material: 'frosted' }) }}
          >
            {t('glass.material.frosted')}
          </button>
        </div>
        <div className={css.slider}>
          <label className={css.fieldLabel} htmlFor={ids.panel}>{t('glass.panelOpacity')}</label>
          <input
            id={ids.panel}
            type="range"
            min={0.4}
            max={1}
            step={0.02}
            value={glass.panelOpacity}
            onChange={(event) => { props.setGlass({ panelOpacity: Number(event.target.value) }) }}
          />
          <span className={css.sliderValue}>{Math.round(glass.panelOpacity * 100)}%</span>
        </div>
        <p className={css.hint}>{t('glass.hint')}</p>
      </section>

      <section className={css.block}>
        <h3 className={css.heading}>{t('pack.title')}</h3>
        <p className={css.hint}>{t('pack.intro')}</p>
        <div className={css.actions}>
          <Button variant="outline" onClick={exportCurrent}>{t('pack.export')}</Button>
          <Button variant="outline" onClick={() => { fileRef.current?.click() }}>{t('pack.import')}</Button>
          <Button variant="ghost" onClick={() => { void share() }}>{t('pack.share')}</Button>
          <input
            ref={fileRef}
            className={css.hiddenInput}
            type="file"
            accept="application/json,.json"
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file !== undefined) void importFile(file)
            }}
          />
        </div>
        {packs.length === 0
          ? <p className={css.hint}>{t('pack.empty')}</p>
          : (
            <ul className={css.packList}>
              {packs.map(pack => (
                <li key={pack.id} className={css.packRow}>
                  <span className={css.packName}>{pack.name}</span>
                  <button
                    type="button"
                    className={css.link}
                    onClick={() => {
                      props.removePack(pack.id)
                      show(t('toast.removed', { name: pack.name }))
                    }}
                  >
                    {t('pack.remove')}
                  </button>
                </li>
              ))}
            </ul>
          )}
      </section>

      {notice !== null && (
        <Toast key={notice.seq} text={notice.text} onDone={() => { setNotice(null) }} />
      )}
    </div>
  )
}
