/** 文件树顶部的打开编辑器列表；与项目目录共用同一个 SidebarRoot 列。 */
import { Icon } from 'coding-client-ui-primitives'
import type { PropsLocale } from 'coding-client-ui-slots'
import { NS } from './locales.ts'
import css from './IdeFileTree.module.css'

/** 打开编辑器行；同一文件在多个分组出现时只显示一次。 */
export interface IdeOpenEditorRow {
  path: string
  name: string
  paneId: string
  active: boolean
  dirty: boolean
  preview: boolean
}

interface IdeOpenEditorsProps {
  items: readonly IdeOpenEditorRow[]
  collapsed: boolean
  onActivate: (paneId: string, path: string) => void
  onPin: (paneId: string, path: string) => void
  t: PropsLocale<typeof NS>['t']
}

/** 打开编辑器分区有独立滚动上限，文件树仍占侧栏剩余高度。 */
export function IdeOpenEditors({ items, collapsed, onActivate, onPin, t }: IdeOpenEditorsProps) {
  if (collapsed) return null
  return <section className={css.openEditors} aria-label={t('openEditors')}>
    <div className={css.sectionHeading}>{t('openEditors')}</div>
    <div className={css.openEditorList} role="list">
      {items.length === 0 ? <p className={css.openEditorEmpty}>{t('noOpenEditors')}</p> : items.map(item => (
        <div key={item.path} role="listitem">
          <button type="button" className={css.openEditorRow} title={item.name}
            aria-current={item.active ? 'true' : undefined} data-preview={item.preview ? '' : undefined}
            onClick={() => { onActivate(item.paneId, item.path) }}
            onDoubleClick={() => { if (item.preview) onPin(item.paneId, item.path) }}>
            <Icon name="file" size={14} />
            <span className={css.openEditorLabel}>{item.name}</span>
            {item.dirty && <span className={css.openEditorDirty} aria-label={t('unsaved')} />}
          </button>
        </div>
      ))}
    </div>
  </section>
}
