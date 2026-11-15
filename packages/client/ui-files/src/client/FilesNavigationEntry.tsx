import { useState } from 'react'
import { IconFolderOpenOutline16, Tooltip, Toast } from 'coding-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from 'coding-client-ui-slots'
import type { ObservableSnapshot } from 'coding-client-runtime/client'
import type { PageRoute } from 'coding-client-ui-layout/client'
import { NS, type FilesLocaleKey } from './locales.ts'
import css from './FilesNavigationEntry.module.css'

export interface FilesNavigationEntryFace {
  hooks: { filesPage: ObservableSnapshot<PageRoute | null> }
  openFiles: () => Promise<void>
}

type FilesNavigationEntryProps = PropsRuntime<'shell.navigation.entry'> & PropsLocale<typeof NS>
  & InjectFace<FilesNavigationEntryFace>

export function FilesNavigationEntry({ useFilesPage, openFiles, t }: FilesNavigationEntryProps) {
  const active = useFilesPage(page => page?.kind === 'managed-files')
  const [pending, setPending] = useState(false)
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null)
  const label: FilesLocaleKey = 'nav'
  return <>
    <Tooltip label={t(label)} delayMs={500}>
      <button type="button" className={css.entry} title={t(label)} aria-label={t(label)}
        aria-current={active ? 'page' : undefined} disabled={pending} onClick={() => {
          setPending(true)
          void openFiles().catch(() => {
            setToast(previous => ({ id: (previous?.id ?? 0) + 1, text: t('error') }))
          }).finally(() => { setPending(false) })
        }}>
        <IconFolderOpenOutline16 size={18} />
      </button>
    </Tooltip>
    {toast !== null && <Toast key={toast.id} text={toast.text} onDone={() => { setToast(null) }} />}
  </>
}
