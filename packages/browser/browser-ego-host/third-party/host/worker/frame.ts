import type { TargetSessions } from './capture-cdp.ts'

/** Capture a bounded JPEG with current CSS viewport dimensions for host-side input coordinates. */
export async function captureFrame(sessions: Pick<TargetSessions, 'call'>, targetId: string): Promise<{
  targetId: string; data: string; vw: number; vh: number; ts: number
}> {
  const result = await sessions.call(targetId, 'Runtime.evaluate', {
    expression: '({ x: window.scrollX, y: window.scrollY, width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio })',
    returnByValue: true,
  }) as { result?: { value?: { x?: number; y?: number; width?: number; height?: number; dpr?: number } } }
  const viewport = result.result?.value
  const vw = viewport?.width
  const vh = viewport?.height
  if (!Number.isSafeInteger(vw) || !Number.isSafeInteger(vh)
    || (vw as number) < 1 || (vw as number) > 8192 || (vh as number) < 1 || (vh as number) > 8192) {
    throw new Error('viewport unavailable')
  }
  const dpr = Number.isFinite(viewport?.dpr) && (viewport?.dpr as number) > 0 ? viewport!.dpr as number : 1
  const x = viewport?.x ?? 0, y = viewport?.y ?? 0
  if (![x, y].every(Number.isFinite) || x < 0 || y < 0) throw new Error('viewport unavailable')
  const image = await sessions.call(targetId, 'Page.captureScreenshot', {
    format: 'jpeg', quality: 55, captureBeyondViewport: false,
    clip: { x, y, width: vw, height: vh, scale: 1 / dpr },
  }) as { data?: string }
  if (typeof image.data !== 'string' || !/^([A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(image.data)
    || image.data.length === 0 || image.data.length > 2_800_000) throw new Error('frame unavailable')
  return { targetId, data: image.data, vw: vw as number, vh: vh as number, ts: Date.now() }
}
