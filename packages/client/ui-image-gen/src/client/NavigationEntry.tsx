/** 外侧窄导航栏的画图入口：只在图像服务已配置并启用时出现。 */
import { useState } from 'react'
import { Icon, Tooltip, Toast } from 'coding-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from 'coding-client-ui-slots'
import type { SnapshotStore } from 'coding-client-runtime/client'
import type { ObservableSnapshot } from 'coding-client-runtime/client'
import type { PageRoute } from 'coding-client-ui-layout/client'
import { NS, type ImageKey } from './locales.ts'
import { imageServiceReady, type ImageSettingsView } from './settings.ts'
import css from './NavigationEntry.module.css'

/** 外侧导航入口需要的设置快照与面板导航。 */
export interface NavigationEntryFace {
  hooks: { imageEntrySettings: SnapshotStore<ImageSettingsView>; galleryPage: ObservableSnapshot<PageRoute | null> }
  openGallery: () => Promise<void>
}

type NavigationEntryProps = PropsRuntime<'shell.navigation.entry'> & PropsLocale<typeof NS>
  & InjectFace<NavigationEntryFace>

/**
 * 未配置画图服务时完全不渲染；配置后进入或新建画图会话并打开画廊面板。
 * 外层窄导航没有文案位置，只渲染 36×36 图标盒、可访问名称与悬停提示，
 * 画廊打开期间以 `aria-current="page"` 与主页图标同样高亮。
 * @param props - 设置快照、页面投影与导航回调。
 * @returns 独立的图标入口；服务不可用时不占导航空间。
 */
export function NavigationEntry({ useImageEntrySettings, useGalleryPage, openGallery, t }: NavigationEntryProps) {
  const settings = useImageEntrySettings(s => s)
  const active = useGalleryPage(page => page?.kind === 'image-gallery')
  const [pending, setPending] = useState(false)
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null)
  const label: ImageKey = 'draw'
  if (!imageServiceReady(settings)) return null
  return <>
    <Tooltip label={t(label)} delayMs={500}>
      <button type="button" className={css.entry} title={t(label)} aria-label={t(label)}
        aria-current={active ? 'page' : undefined} disabled={pending} onClick={() => {
          setPending(true)
          void openGallery()
            .catch(() => { setToast(previous => ({ id: (previous?.id ?? 0) + 1, text: t('openFailed') })) })
            .finally(() => { setPending(false) })
        }}>
        <Icon name="model-vision" size={18} />
      </button>
    </Tooltip>
    {toast !== null && <Toast key={toast.id} text={toast.text} onDone={() => { setToast(null) }} />}
  </>
}
