/**
 * 为本次自定义渠道草稿生成可派生 POSIX 凭据名的唯一内部路由 ID。
 * @param taken - 已声明、存活及持久化的全部路由 ID。
 * @returns 以小写字母开头、包含完整 UUID 且未占用的路由 ID。
 */
export function generateChannelId(taken: readonly string[]): string {
  const occupied = new Set(taken)
  let route: string
  do {
    route = `channel-${crypto.randomUUID()}`
  } while (occupied.has(route))
  return route
}
