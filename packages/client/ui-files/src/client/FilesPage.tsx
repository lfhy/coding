import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { ImageLightbox, SidebarRoot, type SidebarRootItem } from 'coding-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from 'coding-client-ui-slots'
import { FilesSection } from './FilesSection.tsx'
import { NS } from './locales.ts'
import { categoryOf, managedFilePreviewUrl, type ManagedFileCategory, type ManagedFileKind, type ManagedFileRecord, type ManagedFilesPage } from './wire.ts'
import css from './FilesPage.module.css'

export type FilesPageProps = PropsRuntime<'shell.page'> & PropsLocale<typeof NS>
  & InjectFace<{
    list: (offset: number, limit: number, signal: AbortSignal,
      options?: { kind?: ManagedFileKind; category?: ManagedFileCategory }) => Promise<ManagedFilesPage>
  }>

/** 无工作区文件页；页头固定，列表由内容区自行滚动。 */
export function FilesPage({ closePage, list, t, sidebarCollapsed, sidebarWidth }: FilesPageProps) {
  const titleId = useId()
  const titleRef = useRef<HTMLHeadingElement | null>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const [kind, setKind] = useState<ManagedFileKind | undefined>(undefined)
  const [category, setCategory] = useState<ManagedFileCategory | undefined>(undefined)
  const [preview, setPreview] = useState<ManagedFileRecord | null>(null)
  const listForPage = useCallback((offset: number, limit: number, signal: AbortSignal,
    options?: { kind?: ManagedFileKind; category?: ManagedFileCategory }) =>
    list(offset, limit, signal, options), [list])
  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    titleRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (document.querySelector('[role="dialog"][aria-modal="true"], [role="menu"], [role="listbox"]')) return
      closePage()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      previousFocus.current?.focus()
    }
  }, [closePage])
  const categories: readonly { value: ManagedFileCategory | undefined; label: string; icon: SidebarRootItem['icon']; iconTone: NonNullable<SidebarRootItem['iconTone']> }[] = [
    { value: undefined, label: t('all'), icon: 'files', iconTone: 'amber' },
    { value: 'image', label: t('image'), icon: 'model-vision', iconTone: 'green' },
    { value: 'presentation', label: t('presentation'), icon: 'file-slides', iconTone: 'violet' },
    { value: 'document', label: t('document'), icon: 'file', iconTone: 'blue' },
    { value: 'other', label: t('other'), icon: 'file-other', iconTone: 'amber' },
  ]
  const selectedLabel = categories.find(entry => entry.value === category)?.label ?? t('all')
  return (
    <main className={css.page} aria-labelledby={titleId}
      style={{ '--page-sidebar-width': `${sidebarWidth}px` } as CSSProperties}>
      <SidebarRoot label={t('space')} title={t('space')} collapsed={sidebarCollapsed} width={sidebarWidth}
        items={categories.map(entry => ({
          id: entry.label,
          label: entry.label,
          icon: entry.icon,
          iconTone: entry.iconTone,
          active: category === entry.value,
          onSelect: () => { setCategory(entry.value); setKind(undefined) },
        }))} />
      <section className={css.content} aria-label={selectedLabel}>
        <header className={css.header}>
          <div className={css.heading}>
            <h1 ref={titleRef} id={titleId} className={css.title} tabIndex={-1}>{selectedLabel}</h1>
          </div>
        </header>
        <div className={css.body}>
          <FilesSection key={`${category ?? 'all'}:${kind ?? 'all'}`} t={t}
            {...kind === undefined ? {} : { kind }} {...category === undefined ? {} : { category }}
            onFileOpen={(file) => { if (categoryOf(file) === 'image') setPreview(file) }}
            list={listForPage} hideHeading />
        </div>
      </section>
      {preview !== null && <ImageLightbox src={managedFilePreviewUrl(preview.id)} alt={preview.name}
        labels={{ dialog: t('previewDialog'), close: t('close') }} onClose={() => { setPreview(null) }} />}
    </main>
  )
}
