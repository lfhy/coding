import type { TargetSessions } from './capture-cdp.ts'

/** 面板要求的目标视口：CSS 宽高与设备像素比共同决定采集画面的清晰度。 */
export interface PanelViewport {
  width: number
  height: number
  /** 面板所在显示器的设备像素比；HiDPI 按 2 采集，画面才不会被放大后发虚。 */
  pixelRatio: number
}

/** 设备像素比按浮点比较，避免 1.5、1.25 这类比例的抖动反复重建视口。 */
function samePixelRatio(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.01
}

/** 在页面所在的持久采集会话上设置面板视口；关闭页面后的失败由调用方处理。 */
export async function matchPanelViewport(
  sessions: Pick<TargetSessions, 'call'>,
  targetId: string,
  desired: PanelViewport,
  measure: () => Promise<PanelViewport | null>,
): Promise<PanelViewport | null> {
  const current = await measure()
  if (current !== null && current.width === desired.width && current.height === desired.height
    && samePixelRatio(current.pixelRatio, desired.pixelRatio)) return current
  await sessions.call(targetId, 'Emulation.setDeviceMetricsOverride', {
    width: desired.width, height: desired.height, deviceScaleFactor: desired.pixelRatio, mobile: false,
  })
  const actual = await measure()
  return actual !== null && actual.width === desired.width && actual.height === desired.height ? actual : null
}
