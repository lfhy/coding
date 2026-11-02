/** 将页面悬停后的真实鼠标状态投影给会话画面，不读取 DOM 内容或执行页面脚本输入。 */
import type { TargetSessions } from './capture-cdp.ts'

/** 浏览器指针仅允许标准形态，避免网页 CSS 注入本地资源或自定义游标。 */
const CURSORS = new Set(['default', 'pointer', 'text', 'wait', 'progress', 'help', 'move', 'grab', 'grabbing',
  'not-allowed', 'crosshair', 'cell', 'vertical-text', 'zoom-in', 'zoom-out', 'ew-resize', 'ns-resize'])

/**
 * 先向当前页面投递真实鼠标移动，再读取指针与悬停提示；跨源子帧无法读取时保留普通指针。
 * @param sessions - 只对 Host 已核验的目标调用的 CDP 会话。
 * @param targetId - 会话目录中的目标。
 * @param x - CSS 视口水平坐标。
 * @param y - CSS 视口垂直坐标。
 * @returns 页面当前的标准光标与公开链接／标题，缺失时不向面板暴露任意网页数据。
 */
export async function hoverAt(sessions: Pick<TargetSessions, 'call'>, targetId: string, x: number, y: number): Promise<{
  cursor: string; title: string | null; href: string | null
}> {
  await sessions.call(targetId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 })
  const expression = `(() => {
    const el = document.elementFromPoint(${x}, ${y});
    const link = el?.closest('a[href]');
    const style = el ? getComputedStyle(el) : null;
    return { cursor: style?.cursor === 'auto' && el ?
      (el.closest('a[href], button, [role="button"]') ? 'pointer' : el.closest('input, textarea, [contenteditable="true"]') ? 'text' : 'default')
      : style?.cursor ?? 'default', title: el?.closest('[title]')?.getAttribute('title') ?? null,
      href: link?.href ?? null };
  })()`
  const result = await sessions.call(targetId, 'Runtime.evaluate', { expression, returnByValue: true }) as {
    result?: { value?: { cursor?: unknown; title?: unknown; href?: unknown } }
  }
  const value = result.result?.value
  const cursor = typeof value?.cursor === 'string' && CURSORS.has(value.cursor) ? value.cursor : 'default'
  const title = typeof value?.title === 'string' && value.title.length <= 256 ? value.title : null
  let href: string | null = null
  if (typeof value?.href === 'string' && value.href.length <= 2048) {
    try {
      const parsed = new URL(value.href)
      if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && !parsed.username && !parsed.password) {
        href = parsed.href
      }
    } catch { /* 页面给出的无效地址不进入悬停提示。 */ }
  }
  return { cursor, title, href }
}
