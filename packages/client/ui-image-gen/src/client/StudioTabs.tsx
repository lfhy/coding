/** 画图页左侧栏顶部的三子页切换：工作台／灵感／图库。展开态是图标加文字的按钮行，收起态退化为图标轨按钮，与侧栏其余几何一致。 */
import { Icon, IconEditOutline16, IconSparkle16 } from 'coding-client-ui-primitives'
import type { ImageKey } from './locales.ts'
import css from './StudioTabs.module.css'

/** 主内容画廊的三个子页。 */
export type GalleryTab = 'studio' | 'inspiration' | 'gallery'

/** 切换行固定的图标与主题色；顺序即按钮顺序，与文件管理的分类行同一套语义色。 */
const TABS: readonly { id: GalleryTab; label: ImageKey; tone: 'amber' | 'green' | 'blue' | 'violet'; icon: 'edit' | 'sparkle' | 'model-vision' }[] = [
  { id: 'studio', label: 'studioTab', tone: 'amber', icon: 'edit' },
  { id: 'inspiration', label: 'inspirationTab', tone: 'violet', icon: 'sparkle' },
  { id: 'gallery', label: 'galleryTab', tone: 'blue', icon: 'model-vision' },
]

export interface StudioTabsProps {
  tab: GalleryTab
  onTab: (tab: GalleryTab) => void
  collapsed: boolean
  /** 与画廊视图同一 locale；切换行只用到四个固定键。 */
  t: (key: ImageKey) => string
  /** 首个按钮元素登记到页面级焦点锚点，页面打开时聚焦它。 */
  registerFirstTab: (element: HTMLButtonElement | null) => void
}

function tabIcon(kind: 'edit' | 'sparkle' | 'model-vision', size: number): React.JSX.Element {
  if (kind === 'edit') return <IconEditOutline16 size={size} />
  if (kind === 'sparkle') return <IconSparkle16 size={size} />
  return <Icon name="model-vision" size={size} />
}

/** @param props - 当前子页、切换动作、折叠状态、locale 与焦点登记。 @returns 展开行或收起轨。 */
export function StudioTabs({ tab, onTab, collapsed, t, registerFirstTab }: StudioTabsProps) {
  return (
    <nav className={collapsed ? css.rail : css.tabs} role="tablist" aria-label={t('gallerySections')}>
      {TABS.map((entry, index) => collapsed
        ? <button key={entry.id} type="button" role="tab" aria-selected={tab === entry.id}
          className={css.railButton} aria-label={t(entry.label)} title={t(entry.label)}
          data-tone={entry.tone} onClick={() => { onTab(entry.id) }}>
          {tabIcon(entry.icon, 18)}
        </button>
        : <button key={entry.id} type="button" role="tab" aria-selected={tab === entry.id}
          ref={index === 0 ? registerFirstTab : undefined}
          className={tab === entry.id ? css.activeTab : css.tab} data-tone={entry.tone}
          onClick={() => { onTab(entry.id) }}>
          {tabIcon(entry.icon, 16)}<span>{t(entry.label)}</span>
        </button>)}
    </nav>
  )
}
