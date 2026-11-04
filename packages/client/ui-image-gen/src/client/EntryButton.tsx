/** 欢迎页和会话页头各占一个槽位，入口仅接收同会话可用性及导航回调。 */
import { useEffect, useState } from 'react'
import { Icon, Tooltip, Toast } from 'coding-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from 'coding-client-ui-slots'
import type { SnapshotStore } from 'coding-client-runtime/client'
import type { ImageKey } from './locales.ts'
import { NS } from './locales.ts'
import type { ImageSettingsView } from './settings.ts'
import { readState } from './wire.ts'
import css from './EntryButton.module.css'

/** 图像入口由 Host 可用性与 settings 快照共同控制。 */
export interface EntryFace {
  hooks: { imageEntrySettings: SnapshotStore<ImageSettingsView> }
  openGallery: () => Promise<void>
}

type EntryProps = (PropsRuntime<'conversation.hero.actions'> | PropsRuntime<'conversation.session.header.utilities'>)
  & PropsLocale<typeof NS> & InjectFace<EntryFace>

/**
 * 图像入口仅在 Host 报告 available 时启动新创作；不可用时仍提供设置引导文案。
 * @param props - 当前会话订阅与导航回调。
 * @returns 语义图标按钮。
 */
export function EntryButton({ useSessions, useImageEntrySettings, openGallery, t }: EntryProps) {
  const { section, credential } = useImageEntrySettings(s => s)
  const current = useSessions(s => s.current)
  const imageSession = useSessions(s => s.current !== undefined && s.byId[s.current]?.agentPreset === 'image')
  const [available, setAvailable] = useState(false)
  const [pending, setPending] = useState(false)
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null)
  useEffect(() => {
    if (current === undefined) {
      setAvailable(section.status === 'ready' && section.value?.enabled === true
        && !!section.value.endpoint && !!section.value.model && credential.status === 'ready'
        && credential.configured && credential.ref === section.value.apiKeyRef)
      return
    }
    const abort = new AbortController()
    void readState(current, abort.signal).then((value) => { if (!abort.signal.aborted) setAvailable(value.available) })
      .catch(() => { if (!abort.signal.aborted) setAvailable(false) })
    return () => { abort.abort() }
  }, [current, section.status, section.value?.enabled, section.value?.endpoint, section.value?.model,
    section.value?.apiKeyRef, credential.status, credential.configured, credential.ref])
  const configured = section.status === 'ready' && section.value?.enabled && section.value.endpoint && section.value.model
    && credential.status === 'ready' && credential.configured && credential.ref === section.value.apiKeyRef
  const enabled = imageSession || configured && available
  const label: ImageKey = imageSession && !available ? 'gallery' : enabled ? 'draw' : 'noService'
  const showToast = (text: string) => { setToast(previous => ({ id: (previous?.id ?? 0) + 1, text })) }
  return <>
    <Tooltip label={t(label)} delayMs={500}>
      <button type="button" className={css.button} title={t(label)} aria-label={t(label)}
        disabled={!enabled || pending} onClick={() => {
          setPending(true)
          void (async () => {
            if (!imageSession && current !== undefined && !(await readState(current)).available) {
              throw new Error('image unavailable')
            }
            await openGallery()
          })().catch(() => { showToast(t('openFailed')) }).finally(() => { setPending(false) })
        }}><Icon name="model-vision" size={18} /></button>
    </Tooltip>
    {toast !== null && <Toast key={toast.id} text={toast.text} onDone={() => { setToast(null) }} />}
  </>
}
