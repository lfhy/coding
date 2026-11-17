import { useState } from 'react'
import { Tooltip, Toast } from 'coding-client-ui-primitives'
import { Icon } from 'coding-client-ui-icons'
import type { InjectFace, PropsLocale, PropsRuntime } from 'coding-client-ui-slots'
import type { ObservableSnapshot } from 'coding-client-runtime/client'
import type { PageRoute } from 'coding-client-ui-layout/client'
import { NS, type NotesLocaleKey } from './locales.ts'
import css from './NavigationEntry.module.css'

export interface NotesNavigationEntryFace {
  hooks: { notesPage: ObservableSnapshot<PageRoute | null> }
  openNotes: () => Promise<void>
}

type NotesNavigationEntryProps = PropsRuntime<'shell.navigation.entry'> & PropsLocale<typeof NS>
  & InjectFace<NotesNavigationEntryFace>

export function NotesNavigationEntry({ useNotesPage, openNotes, t }: NotesNavigationEntryProps) {
  const active = useNotesPage(page => page?.kind === 'notes')
  const [pending, setPending] = useState(false)
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null)
  const label: NotesLocaleKey = 'nav'
  return <>
    <Tooltip label={t(label)} delayMs={500}>
      <button type="button" className={css.entry} title={t(label)} aria-label={t(label)}
        aria-current={active ? 'page' : undefined} disabled={pending} onClick={() => {
          setPending(true)
          void openNotes().catch(() => {
            setToast(previous => ({ id: (previous?.id ?? 0) + 1, text: t('treeError') }))
          }).finally(() => { setPending(false) })
        }}>
        <Icon name="notes" size={18} />
      </button>
    </Tooltip>
    {toast !== null && <Toast key={toast.id} text={toast.text} onDone={() => { setToast(null) }} />}
  </>
}
