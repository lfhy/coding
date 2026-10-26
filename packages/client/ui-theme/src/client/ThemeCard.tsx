/**
 * 主题卡片：一块配色预览 + 名称 + 明暗归属，外加收藏开关。
 *
 * 卡片本身是一个按钮（点击即切换主题），收藏是卡片下方的独立按钮——两个
 * 交互不能互相嵌套，否则键盘与读屏都分不清点中的是哪个。
 */
import clsx from 'clsx'
import css from './ThemeCard.module.css'

/** 主题卡片展示所需的数据与回调。 */
export interface ThemeCardProps {
  /** 主题 id。 */
  id: string
  /** 显示名。 */
  name: string
  /** 明暗归属。 */
  scheme: 'light' | 'dark' | 'auto'
  /** 预览色：底色可以是渐变，因此按 CSS `background` 值渲染。 */
  preview: { background: string; text: string; accent: string }
  /** 是否为当前主题。 */
  selected: boolean
  /** 是否已收藏。 */
  favorite: boolean
  /** 是否来自导入的主题包。 */
  imported: boolean
  /** 已本地化的文案。 */
  labels: {
    current: string
    favorite: string
    unfavorite: string
    scheme: string
    imported: string
  }
  /** 选中该主题。 */
  onSelect: (id: string) => void
  /** 切换收藏状态。 */
  onToggleFavorite: (id: string) => void
}

/**
 * 渲染一张主题卡片。
 * @param props - 预览数据、选中/收藏状态与回调。
 * @returns 卡片元素树。
 */
export function ThemeCard({
  id, name, preview, selected, favorite, imported, labels, onSelect, onToggleFavorite,
}: ThemeCardProps) {
  return (
    <div className={clsx(css.item, selected && css.selected)}>
      <button
        type="button"
        className={css.card}
        aria-pressed={selected}
        onClick={() => { onSelect(id) }}
      >
        <span
          className={css.swatch}
          style={{ background: preview.background }}
          aria-hidden
        >
          <span className={css.accent} style={{ background: preview.accent }} />
          <span className={css.line} style={{ background: preview.text }} />
        </span>
        <span className={css.meta}>
          <span className={css.name} title={name}>{name}</span>
          <span className={css.tags}>
            <span className={css.tag}>{labels.scheme}</span>
            {imported && <span className={css.tag}>{labels.imported}</span>}
            {selected && <span className={css.current}>{labels.current}</span>}
          </span>
        </span>
      </button>
      <button
        type="button"
        className={clsx(css.favorite, favorite && css.favoriteOn)}
        aria-pressed={favorite}
        onClick={() => { onToggleFavorite(id) }}
      >
        {favorite ? labels.unfavorite : labels.favorite}
      </button>
    </div>
  )
}
