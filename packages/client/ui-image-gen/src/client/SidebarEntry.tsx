/** 侧边栏左上角的画图入口：只在图像服务已配置并启用时出现在新对话行。 */
import { useState } from 'react'
import { Icon, Tooltip, Toast } from 'coding-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from 'coding-client-ui-slots'
import type { SnapshotStore } from 'coding-client-runtime/client'
import { NS, type ImageKey } from './locales.ts'
import { imageServiceReady, type ImageSettingsView } from './settings.ts'
import css from './SidebarEntry.module.css'

/** 侧边栏入口需要的设置快照与面板导航。 */
export interface SidebarEntryFace {
  hooks: { imageEntrySettings: SnapshotStore<ImageSettingsView> }
  openGallery: () => Promise<void>
}

type SidebarEntryProps = PropsRuntime<'sidebar.brand.action'> & PropsLocale<typeof NS>
  & InjectFace<SidebarEntryFace>

/**
 * 未配置画图服务时完全不渲染，配置后进入或新建画图会话并打开画廊面板。
 * 展开侧栏显示图标加文案，收起 rail 保持 36×36 纯图标控件。
 * @param props - 栏宽状态、设置快照与导航回调。
 * @returns 新对话行内的画图入口。
 */
export function SidebarEntry({ wide, useImageEntrySettings, openGallery, t }: SidebarEntryProps) {
  const settings = useImageEntrySettings(s => s)
  const [pending, setPending] = useState(false)
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null)
  const label: ImageKey = 'draw'
  if (!imageServiceReady(settings)) return null
  return <>
    <Tooltip label={t(label)} delayMs={500} disabled={wide}>
      <button type="button" className={wide ? css.wide : css.rail} title={t(label)} aria-label={t(label)}
        disabled={pending} onClick={() => {
          setPending(true)
          void openGallery()
            .catch(() => { setToast(previous => ({ id: (previous?.id ?? 0) + 1, text: t('openFailed') })) })
            .finally(() => { setPending(false) })
        }}>
        <Icon name="model-vision" size={wide ? 16 : 18} />
        {wide && <span className={css.label}>{t(label)}</span>}
      </button>
    </Tooltip>
    {toast !== null && <Toast key={toast.id} text={toast.text} onDone={() => { setToast(null) }} />}
  </>
}
