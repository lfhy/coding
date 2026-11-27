/** IDE 左侧懒加载文件树；只消费 store 中的目录快照与用户动作。 */
import { useMemo } from 'react'
import { Button, SidebarRoot, type SidebarRootItem } from 'coding-client-ui-primitives'
import type { PropsLocale } from 'coding-client-ui-slots'
import type { IdeDirectoryState } from './ide-store.ts'
import { IdeOpenEditors, type IdeOpenEditorRow } from './IdeOpenEditors.tsx'
import { NS } from './locales.ts'
import css from './IdeFileTree.module.css'

interface IdeFileTreeProps {
  title: string
  collapsed: boolean
  width: number
  directories: Readonly<Record<string, IdeDirectoryState>>
  expanded: readonly string[]
  activePath: string | null
  openEditors: readonly IdeOpenEditorRow[]
  onToggle: (path: string) => void
  onOpen: (path: string, name: string, segments: readonly string[]) => void
  onActivateEditor: (paneId: string, path: string) => void
  onPinEditor: (paneId: string, path: string) => void
  onRetry: () => void
  t: PropsLocale<typeof NS>['t']
}

/** 把已加载目录拍平成 SidebarRoot 支持的树行。 */
function treeItems(
  directories: Readonly<Record<string, IdeDirectoryState>>,
  expanded: readonly string[],
  activePath: string | null,
  onToggle: (path: string) => void,
  onOpen: (path: string, name: string, segments: readonly string[]) => void,
): SidebarRootItem[] {
  const rows: SidebarRootItem[] = []
  const visit = (parent: string, depth: number): void => {
    const directory = directories[parent]
    if (directory === undefined) return
    const entries = [...directory.entries].sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    for (const entry of entries) {
      if (entry.type === 'other') continue
      const path = parent === '' ? entry.name : `${parent}/${entry.name}`
      if (entry.type === 'directory') {
        const open = expanded.includes(path)
        rows.push({
          id: path, label: entry.name, icon: 'files', folder: true, open, depth,
          onSelect: () => { onToggle(path) },
        })
        if (open) visit(path, depth + 1)
      } else {
        rows.push({
          id: path, label: entry.name, icon: 'file', depth, active: path === activePath,
          onSelect: () => { onOpen(path, entry.name, entry.segments) },
        })
      }
    }
  }
  visit('', 0)
  return rows
}

/** 文件树列；展开状态与已加载层级由页面 store 保存。 */
export function IdeFileTree({
  title, collapsed, width, directories, expanded, activePath, openEditors,
  onToggle, onOpen, onActivateEditor, onPinEditor, onRetry, t,
}: IdeFileTreeProps) {
  const items = useMemo(
    () => treeItems(directories, expanded, activePath, onToggle, onOpen),
    [directories, expanded, activePath, onToggle, onOpen],
  )
  const root = directories['']
  const failed = root?.status === 'error'
  return <SidebarRoot label={t('files')} title={title} collapsed={collapsed} width={width}
    header={<IdeOpenEditors items={openEditors} collapsed={collapsed}
      onActivate={onActivateEditor} onPin={onPinEditor} t={t} />}
    items={items}
    empty={root?.status === 'loading' ? t('loading') : t('treeEmpty')}
    toolbar={failed ? <div className={css.treeError} role="alert">
      <span>{t('treeError')}</span>
      <Button size="sm" variant="outline" onClick={onRetry}>{t('retry')}</Button>
    </div> : root?.truncated === true ? <p className={css.treeNote} role="status">{t('treeTruncated')}</p> : undefined} />
}
