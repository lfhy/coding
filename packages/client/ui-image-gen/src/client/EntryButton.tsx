/** 欢迎页与会话页头的画图入口：欢迎页在服务就绪时出现，会话页头只在画图会话出现。 */
import { useState } from 'react'
import { Icon, Tooltip, Toast } from 'coding-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from 'coding-client-ui-slots'
import type { SnapshotStore } from 'coding-client-runtime/client'
import { NS, type ImageKey } from './locales.ts'
import { imageServiceReady, type ImageSettingsView } from './settings.ts'
import css from './EntryButton.module.css'

/** 入口所在座位决定可见范围，动作统一交给画廊面板。 */
export interface EntryFace {
  hooks: { imageEntrySettings: SnapshotStore<ImageSettingsView> }
  /** welcome 座位跟随欢迎页；session 座位只服务画图会话页头。 */
  seat: 'welcome' | 'session'
  openGallery: () => Promise<void>
}

type EntryProps = (PropsRuntime<'conversation.hero.actions'> | PropsRuntime<'conversation.session.header.utilities'>)
  & PropsLocale<typeof NS> & InjectFace<EntryFace>

/**
 * 画图入口在服务未配置或当前不是画图会话时不渲染，点击后打开当前会话的画廊面板。
 * @param props - 入口座位、设置快照与面板导航回调。
 * @returns 语义图标按钮，失败时给出短暂提示。
 */
export function EntryButton({ useSessions, useImageEntrySettings, seat, openGallery, t }: EntryProps) {
  const settings = useImageEntrySettings(s => s)
  const imageSession = useSessions(s => s.current !== undefined && s.byId[s.current]?.agentPreset === 'image')
  const [pending, setPending] = useState(false)
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null)
  const label: ImageKey = 'draw'
  if (!imageServiceReady(settings) || seat === 'session' && !imageSession) return null
  return <>
    <Tooltip label={t(label)} delayMs={500}>
      <button type="button" className={css.button} title={t(label)} aria-label={t(label)}
        disabled={pending} onClick={() => {
          setPending(true)
          void openGallery()
            .catch(() => { setToast(previous => ({ id: (previous?.id ?? 0) + 1, text: t('openFailed') })) })
            .finally(() => { setPending(false) })
        }}><Icon name="model-vision" size={18} /></button>
    </Tooltip>
    {toast !== null && <Toast key={toast.id} text={toast.text} onDone={() => { setToast(null) }} />}
  </>
}
