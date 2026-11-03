import type { TargetSessions } from './capture-cdp.ts'

/** 在页面所在的持久采集会话上设置面板视口；关闭页面后的失败由调用方处理。 */
export async function matchPanelViewport(
  sessions: Pick<TargetSessions, 'call'>,
  targetId: string,
  desired: { width: number; height: number },
  measure: () => Promise<{ width: number; height: number } | null>,
): Promise<{ width: number; height: number } | null> {
  const current = await measure()
  if (current?.width === desired.width && current.height === desired.height) return current
  await sessions.call(targetId, 'Emulation.setDeviceMetricsOverride', {
    width: desired.width, height: desired.height, deviceScaleFactor: 1, mobile: false,
  })
  const actual = await measure()
  return actual?.width === desired.width && actual.height === desired.height ? actual : null
}
