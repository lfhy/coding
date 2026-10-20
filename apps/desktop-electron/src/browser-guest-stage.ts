/** 后台 guest 的私有原生承载；保留非零布局，不把页面暴露到 Host 的视图层。 */
import { BaseWindow, type WebContentsView } from 'electron'

/**
 * 按需创建永不显示的承载窗口；尺寸覆盖现有 guest 视口限制，不改变页面自身视口。
 * @returns 挂载、撤下与销毁操作；调用方先关闭所有 guest，再销毁承载窗口。
 */
export function createBackgroundStage() {
  let window: BaseWindow | undefined
  return {
    attach(view: WebContentsView, viewport: { width: number; height: number }): void {
      // 完全移出父窗口会使 Chromium 原生视图裁剪为空，导致零视口和 surface 截图挂起。
      window ??= (() => {
        const stage = new BaseWindow({ show: false, focusable: false, skipTaskbar: true,
          width: 1920, height: 1400, useContentSize: true, frame: false })
        stage.setIgnoreMouseEvents(true)
        return stage
      })()
      view.setBounds({ x: 0, y: 0, width: viewport.width, height: viewport.height })
      if (!window.contentView.children.includes(view)) window.contentView.addChildView(view)
      view.webContents.setBackgroundThrottling(false)
    },
    detach(view: WebContentsView): void {
      if (window?.contentView.children.includes(view)) window.contentView.removeChildView(view)
    },
    dispose(): void {
      if (window && !window.isDestroyed()) window.destroy()
      window = undefined
    },
  }
}
