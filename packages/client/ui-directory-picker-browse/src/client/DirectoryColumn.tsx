/**
 * 单栏渲染：目录行（可挑选、可推进）与文件行（只读展示，永不参与挑选）。
 * 每行右侧在鼠标悬停或键盘聚焦（`:focus-within`）时露出重命名与删除两个图标
 * 按钮；两个按钮始终在 Tab 序列里，显隐只由不透明度决定，因此键盘不需要先
 * 「悬停」就能到达它们。纯展示组件：数据与回调全部来自 props。
 */
import clsx from 'clsx'
import type { Translate } from 'coding-client-locale/client'
import type { DirectoryEntry } from 'coding-client-runtime/client'
import {
  Icon, IconChevronRightOutline14, IconEditOutline16, IconFolderClose16, IconFolderOpen16, IconTrashOutline16,
} from 'coding-client-ui-primitives'
import css from './DirectoryBrowser.module.css'

/**
 * 一栏实际渲染的行。选中项豁免一切过滤：它锚定双栏视图（面包屑与子栏都指向
 * 它），因此点开极简模式后的隐藏过滤、或前缀不匹配，都不得让它凭空消失。
 * 前缀只在真能显示出匹配行时收窄该栏——没人匹配的尾段是在拼名字，不是在要求
 * 空栏，于是整栏照旧显示，隐藏行也回到开关的管辖内。
 * @param rows - 该栏的行（目录或文件）。
 * @param selectedPath - 选中行路径（文件栏传 null）。
 * @param showHidden - 「显示隐藏文件」开关。
 * @param filterPrefix - 路径草稿末段，或 null。
 * @returns 需要渲染的行，保持原有顺序。
 */
export function visibleRows(
  rows: readonly DirectoryEntry[],
  selectedPath: string | null,
  showHidden: boolean,
  filterPrefix: string | null,
): readonly DirectoryEntry[] {
  const needle = filterPrefix === null ? '' : filterPrefix.toLowerCase()
  // 点开头的前缀显式指名隐藏项，因此匹配的隐藏行即使开关关着也露面。
  const displayable = (entry: DirectoryEntry): boolean => showHidden || !entry.hidden || needle.startsWith('.')
  const matches = (entry: DirectoryEntry): boolean => displayable(entry) && entry.name.toLowerCase().startsWith(needle)
  const narrowing = needle !== '' && rows.some(matches)
  return rows.filter((entry) => {
    if (entry.path === selectedPath) return true
    if (narrowing) return matches(entry)
    return showHidden || !entry.hidden
  })
}

/** 行右侧的两个管理动作：重命名与删除。 */
function RowActions({ entry, disabled, onRename, onDelete, t }: {
  entry: DirectoryEntry
  disabled: boolean
  onRename: (entry: DirectoryEntry) => void
  onDelete: (entry: DirectoryEntry) => void
  t: Translate
}) {
  return (
    <span className={css.rowActions}>
      <button
        type="button"
        className={css.rowAction}
        aria-label={t('browser.renameEntry', { name: entry.name })}
        title={t('browser.rename')}
        disabled={disabled}
        onClick={() => { onRename(entry) }}
      >
        <IconEditOutline16 size={14} />
      </button>
      <button
        type="button"
        className={clsx(css.rowAction, css.rowActionDanger)}
        aria-label={t('browser.deleteEntry', { name: entry.name })}
        title={t('browser.delete')}
        disabled={disabled}
        onClick={() => { onDelete(entry) }}
      >
        <IconTrashOutline16 size={14} />
      </button>
    </span>
  )
}

/** Miller 视图的一栏（一栏或两栏时各渲染一个）。 */
export interface LevelColumnProps {
  /** 该栏的子目录行。 */
  entries: readonly DirectoryEntry[]
  /** 该栏的直接子文件行，只读展示。 */
  files: readonly DirectoryEntry[]
  /** 选中行路径（右栏与文件行不参与选中）。 */
  selectedPath: string | null
  /** 有会话在跑（列举、打开、拟态框打开中）：整栏控件禁用。 */
  busy: boolean
  /** 目录行被点击：选中并预览子项，或把右栏推进一层。 */
  onPick: (entry: DirectoryEntry) => void
  /** 行内「重命名」被点击。 */
  onRename: (entry: DirectoryEntry) => void
  /** 行内「删除」被点击。 */
  onDelete: (entry: DirectoryEntry) => void
  /** 「显示隐藏文件」开关。 */
  showHidden: boolean
  /** 该栏的路径草稿前缀过滤，或 null。 */
  filterPrefix: string | null
  /** 正在编辑路径：行不得抢焦点。 */
  pathEditing: boolean
  /** 本地化文案。 */
  t: Translate
}

/** 渲染一栏目录与文件行。 */
export function LevelColumn({
  entries, files, selectedPath, busy, onPick, onRename, onDelete, showHidden, filterPrefix, pathEditing, t,
}: LevelColumnProps) {
  const visibleEntries = visibleRows(entries, selectedPath, showHidden, filterPrefix)
  const visibleFiles = visibleRows(files, null, showHidden, filterPrefix)
  return (
    <div className={css.column} role="list">
      {visibleEntries.map((entry) => {
        const selected = entry.path === selectedPath
        return (
          // 外层承载列表语义；行本身保留原生 button 角色，辅助技术照旧拿到可操作控件。
          <span key={entry.path} role="listitem" className={css.rowSeat}>
            <button
              type="button"
              aria-current={selected || undefined}
              className={clsx(css.row, selected && css.rowSelected)}
              disabled={busy}
              // 路径编辑器打开时不抢焦点：mousedown 抢焦点会让编辑器失焦，
              // 在部分引擎里还会吞掉这一下点击。非编辑时保持原生行为。
              onMouseDown={pathEditing ? (event) => { event.preventDefault() } : undefined}
              // 编辑期的焦点停放统一放到提交之后（DirectoryBrowser 的 refocus
              // 副作用）：右栏的点击会替换这一栏，这里先 focus 反而落到 body。
              onClick={() => { onPick(entry) }}
            >
              {selected
                ? <IconFolderOpen16 size={16} className={css.rowIconSelected} />
                : <IconFolderClose16 size={16} className={css.rowIcon} />}
              <span className={css.rowName}>{entry.name}</span>
              <IconChevronRightOutline14 size={12} className={css.rowChevron} />
            </button>
            <RowActions entry={entry} disabled={busy} onRename={onRename} onDelete={onDelete} t={t} />
          </span>
        )
      })}
      {visibleFiles.map(entry => (
        // 文件行是只读的：没有挑选语义，点击不改变视图，也不参与「打开」。
        <span key={entry.path} role="listitem" className={css.rowSeat}>
          <span className={clsx(css.row, css.rowFile)}>
            <Icon name="file" size={16} className={css.rowIcon} />
            <span className={css.rowName}>{entry.name}</span>
          </span>
          <RowActions entry={entry} disabled={busy} onRename={onRename} onDelete={onDelete} t={t} />
        </span>
      ))}
    </div>
  )
}
