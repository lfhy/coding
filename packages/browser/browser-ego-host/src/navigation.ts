/** Host 与 ego-cast worker 共用的人工导航输入校验；任何网页地址都不能绕过 Host 会话检查。 */
import { validId } from './session-space.ts'

/** 已有页面导航必须指定 targetId；仅空白会话允许 navigate 不指定目标。 */
export interface NavigationCommand {
  targetId?: string
  action: 'navigate' | 'reload' | 'back' | 'forward'
  url?: string
}

/**
 * 接受无凭据绝对 HTTP(S) 或严格本地 file:/// 地址，不解析 DNS 或读取文件。
 * @param raw - 人工输入的原始地址。
 * @returns 可直接交给 CDP 的地址；不合法时返回 null。
 */
export function navigationUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096 || /[\s\\]/u.test(raw)) return null
  let url: URL
  try { url = new URL(raw) } catch { return null }
  if (url.protocol === 'file:') {
    return /^file:\/\/\/(?!\/)/iu.test(raw) && url.hostname === '' && !/%(?:2f|5c|00)/iu.test(raw) ? raw : null
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
  const authority = raw.match(/^https?:\/\/([^/?#\\\s]+)(?:[/?#]|$)/iu)?.[1]
  return authority && !authority.includes('@') ? raw : null
}

/**
 * 拒绝多余字段；Host 可额外要求 sessionId，但只转发封闭导航字段给 worker。
 * @param value - HTTP JSON 载荷。
 * @param withSession - Host 路由为 true，worker 本地端点为 false。
 * @returns 已清洗的命令；非法字段或地址返回 null。
 */
export function parseNavigation(value: unknown, withSession = false): NavigationCommand | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const body = value as Record<string, unknown>
  if (withSession && !validId(body.sessionId)) return null
  if (!['navigate', 'reload', 'back', 'forward'].includes(body.action as string)) return null
  const action = body.action as NavigationCommand['action']
  if (Object.hasOwn(body, 'targetId') && !validId(body.targetId)) return null
  if (!Object.hasOwn(body, 'targetId') && (action !== 'navigate' || !withSession)) return null
  const allowed = action === 'navigate'
    ? ['targetId', 'action', 'url'] : ['targetId', 'action']
  if (withSession) allowed.push('sessionId')
  if (Object.keys(body).some(key => !allowed.includes(key))) return null
  if (action === 'navigate') {
    const url = navigationUrl(body.url)
    return url === null ? null : { ...(body.targetId === undefined ? {} : { targetId: body.targetId as string }), action, url }
  }
  if (Object.hasOwn(body, 'url')) return null
  return { targetId: body.targetId as string, action }
}
