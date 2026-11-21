import type { ReactNode, Ref } from 'react'
import type { PropsLocale } from 'coding-client-ui-slots'
import { Button, Icon, IconCheckOutline14, IconDownloadOutline16, IconSparkle16, Menu } from 'coding-client-ui-primitives'
import type { MenuEntry } from 'coding-client-ui-primitives'
import type { NotesLocaleKey, NS } from './locales.ts'
import { NotesEditor } from './NotesEditor.tsx'
import { NotesWelcome } from './NotesWelcome.tsx'
import css from './NotesPage.module.css'

interface NotesDocumentProps {
  title: string
  titleId: string
  titleRef: Ref<HTMLHeadingElement>
  panelId: string
  tabId: string | undefined
  content: string | undefined
  /** 幻灯片标签的内容由已声明的子 slot 提供。 */
  pptContent?: ReactNode
  saveLabel: NotesLocaleKey | undefined
  treeState: 'loading' | 'ready' | 'failed'
  exporting: boolean
  exportMenuOpen: boolean
  exportEntries: readonly MenuEntry[]
  assistantOpen: boolean
  assistantPanelId: string
  onToggleAssistant: () => void
  onToggleExport: () => void
  onCloseExport: () => void
  onExport: (id: string) => void
  onReload: (trigger: HTMLButtonElement) => void
  onRetry: () => void
  onChange: (content: string) => void
  onBlur: () => void
  t: PropsLocale<typeof NS>['t']
}

/**
 * 活动标签的内容容器：头部操作和正文共享边界，正文实现可按文档类型替换。
 * @param props - 当前文档内容、保存状态和页面持有的动作；无内容时显示欢迎或加载状态。
 * @returns 与活动标签关联的单个内容面板。
 */
export function NotesDocument({ title, titleId, titleRef, panelId, tabId, content, pptContent, saveLabel, treeState,
  exporting, exportMenuOpen, exportEntries, assistantOpen, assistantPanelId,
  onToggleAssistant, onToggleExport, onCloseExport, onExport, onReload, onRetry, onChange, onBlur, t }: NotesDocumentProps) {
  return <section id={panelId} className={css.documentBody} role={tabId === undefined ? undefined : 'tabpanel'}
    aria-labelledby={tabId}>
    <header className={css.documentHeader}>
      <div className={css.heading}>
        <span className={css.documentIcon} aria-hidden="true"><Icon name={pptContent === undefined ? 'notes' : 'file-slides'} size={18} /></span>
        <h1 ref={titleRef} id={titleId} className={css.title} title={title} tabIndex={-1}>{title}</h1>
        {saveLabel !== undefined && <span className={css.saveState} data-state={saveLabel} role="status">
          {saveLabel === 'saved' && <IconCheckOutline14 />}{t(saveLabel)}
        </span>}
      </div>
      <div className={css.documentActions}>
        {pptContent === undefined && <Menu open={exportMenuOpen}
          anchor={<Button size="sm" className={css.exportButton} icon={<IconDownloadOutline16 />}
            aria-label={t('export')} title={t('export')} aria-haspopup="menu"
            disabled={content === undefined || exporting} onClick={onToggleExport} />}
          items={exportEntries} onSelect={onExport} onClose={onCloseExport} side="bottom" portal />}
        <Button size="sm" className={css.assistant} icon={<IconSparkle16 />}
          aria-label={t('assistant')} title={t('assistant')} aria-expanded={assistantOpen}
          aria-controls={assistantPanelId} onClick={onToggleAssistant}>
          <span className={css.assistantLabel}>{t('assistant')}</span>
        </Button>
      </div>
    </header>
    {(saveLabel === 'conflict' || saveLabel === 'saveError') && <div className={css.recovery}>
      <p>{t('draftKept')}</p>
      {saveLabel === 'conflict'
        ? <Button size="sm" variant="outline" aria-haspopup="dialog"
          onClick={(event) => { onReload(event.currentTarget) }}>{t('reload')}</Button>
        : <Button size="sm" variant="outline" onClick={onRetry}>{t('retry')}</Button>}
    </div>}
    {pptContent !== undefined ? <div className={css.pptContent}>{pptContent}</div> : content !== undefined
      ? <NotesEditor content={content} onChange={onChange} onBlur={onBlur} t={t} />
      : treeState === 'ready' ? <NotesWelcome t={t} />
        : <div className={css.documentStatus} role="status">{t(treeState === 'loading' ? 'loading' : 'treeError')}</div>}
  </section>
}
