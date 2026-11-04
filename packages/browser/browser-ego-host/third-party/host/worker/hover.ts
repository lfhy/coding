/** 将页面悬停后的真实鼠标状态投影给会话画面，不读取 DOM 内容或执行页面脚本输入。 */
import type { TargetSessions } from './capture-cdp.ts'

/** 浏览器指针仅允许标准形态，避免网页 CSS 注入本地资源或自定义游标。 */
const CURSORS = new Set(['default', 'pointer', 'text', 'wait', 'progress', 'help', 'move', 'grab', 'grabbing',
  'not-allowed', 'crosshair', 'cell', 'vertical-text', 'zoom-in', 'zoom-out', 'ew-resize', 'ns-resize'])

/**
 * 页面侧真实指针移动的最小间隔（毫秒）。
 *
 * `Input.dispatchMouseEvent` 要等渲染器确认输入，实测单条约 16ms，而面板画面只有约
 * 1fps；按事件率逐条投递只会拖慢光标反馈。悬停提示与游标另外用一次 `Runtime.evaluate`
 * 直接读页面，不依赖这条命令返回。
 */
const MOVE_INTERVAL_MS = 80

/** 每个目标只保留最新坐标；同一目标同时只有一个 Input 命令在途。 */
const pendingMoves = new Map<string, { x: number; y: number }>()
const draining = new Set<string>()
const lastMoveAt = new Map<string, number>()
const flushTimers = new Map<string, ReturnType<typeof setTimeout>>()

type SessionCalls = Pick<TargetSessions, 'call'>

/**
 * 把排队的最新坐标投递成一条真实鼠标移动，受最小间隔限制。
 * @param sessions - 只对 Host 已核验的目标调用的 CDP 会话。
 * @param targetId - 会话目录中的目标。
 */
function flushMove(sessions: SessionCalls, targetId: string): void {
  const next = pendingMoves.get(targetId)
  if (next === undefined || draining.has(targetId)) return
  const wait = (lastMoveAt.get(targetId) ?? 0) + MOVE_INTERVAL_MS - Date.now()
  if (wait > 0) {
    if (flushTimers.has(targetId)) return
    const timer = setTimeout(() => { flushTimers.delete(targetId); flushMove(sessions, targetId) }, wait)
    // 尾部移动单独定时补发：面板关闭后不应阻止进程退出。
    timer.unref?.()
    flushTimers.set(targetId, timer)
    return
  }
  pendingMoves.delete(targetId)
  draining.add(targetId)
  lastMoveAt.set(targetId, Date.now())
  void Promise.resolve(sessions.call(targetId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: next.x, y: next.y, buttons: 0 }))
    .catch(() => { /* 目标可能已关闭；下一次移动重新投递。 */ })
    .finally(() => {
      draining.delete(targetId)
      flushMove(sessions, targetId)
    })
}

/**
 * 先向当前页面投递真实鼠标移动（合并、不等待），再读取指针与悬停提示。
 *
 * 读取只依赖坐标与元素本身，页面尚未处理完移动也能给出稳定结果；跨源子帧无法读取时保留普通指针。
 * @param sessions - 只对 Host 已核验的目标调用的 CDP 会话。
 * @param targetId - 会话目录中的目标。
 * @param x - CSS 视口水平坐标。
 * @param y - CSS 视口垂直坐标。
 * @returns 页面当前的标准光标与公开链接／标题，缺失时不向面板暴露任意网页数据。
 */
export async function hoverAt(sessions: SessionCalls, targetId: string, x: number, y: number): Promise<{
  cursor: string; title: string | null; href: string | null
}> {
  pendingMoves.set(targetId, { x, y })
  flushMove(sessions, targetId)
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

/** 目标关闭后丢弃排队坐标与定时器，避免向已消失的页面继续投递输入。 */
export function forgetHoverTarget(targetId: string): void {
  pendingMoves.delete(targetId)
  lastMoveAt.delete(targetId)
  const timer = flushTimers.get(targetId)
  if (timer !== undefined) clearTimeout(timer)
  flushTimers.delete(targetId)
}
