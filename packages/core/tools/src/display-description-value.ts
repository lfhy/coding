/** 无运行时服务依赖的工具调用说明读取契约，供 Host 与浏览器共同重放。 */

/** 所有模型工具共用的可选说明字段。 */
export const DISPLAY_DESCRIPTION_KEY = 'display_description'

/** 模型可见的字段说明；调用者不要把它当作授权依据。 */
export const DISPLAY_DESCRIPTION_SCHEMA = {
  type: 'string',
  description: 'Optional short, user-friendly description of what this call is doing now. Do not include secrets, raw JSON, or internal identifiers.',
} as const

/**
 * 从持久调用参数读取简短说明；无效值由调用侧决定如何降级。
 * @param args - 模型调用的原始已解析参数。
 * @returns 可展示的说明，或 undefined。
 */
export function toolDisplayDescription(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null || Array.isArray(args) || !Object.hasOwn(args, DISPLAY_DESCRIPTION_KEY)) return undefined
  const value = (args as Record<string, unknown>)[DISPLAY_DESCRIPTION_KEY]
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 160) return undefined
  return value.trim()
}
