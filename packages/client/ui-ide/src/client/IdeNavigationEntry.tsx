import { useState } from 'react'
import { IconCodeOutline16, Toast, Tooltip } from 'coding-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from 'coding-client-ui-slots'
import type { ObservableSnapshot } from 'coding-client-runtime/client'
import type { PageRoute } from 'coding-client-ui-layout/client'
import { NS, type IdeLocaleKey } from './locales.ts'
import css from './IdeNavigationEntry.module.css'

export interface IdeNavigationEntryFace {
  hooks: { idePage: ObservableSnapshot<PageRoute | null> }
  openIde: () => Promise<void>
}

type IdeNavigationEntryProps = PropsRuntime<'shell.navigation.entry'> & PropsLocale<typeof NS>
  & InjectFace<IdeNavigationEntryFace>

/** 外层导航中的代码工作区入口；重复点击同一会话时返回原界面。 */
export function IdeNavigationEntry({ useIdePage, openIde, t }: IdeNavigationEntryProps) {
  const active = useIdePage(page => page?.kind === 'ide')
  const [pending, setPending] = useState(false)
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null)
  const label: IdeLocaleKey = 'nav'
  return <>
    <Tooltip label={t(label)} delayMs={500}>
      <button type="button" className={css.entry} title={t(label)} aria-label={t(label)}
        aria-current={active ? 'page' : undefined} disabled={pending} onClick={() => {
          setPending(true)
          void openIde().catch(() => {
            setToast(previous => ({ id: (previous?.id ?? 0) + 1, text: t('entryError') }))
          }).finally(() => { setPending(false) })
        }}>
        <IconCodeOutline16 size={18} />
      </button>
    </Tooltip>
    {toast !== null && <Toast key={toast.id} text={toast.text} onDone={() => { setToast(null) }} />}
  </>
}
