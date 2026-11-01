/** 会话到 ego-lite 任务空间的唯一映射；不接受模型传来的空间名或数字 ID。 */
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { SessionId } from 'coding-session/types'

const ID_PATTERN = /^[a-zA-Z0-9._~-]{1,128}$/u

/** 校验跨 HTTP／工具边界的会话与页面标识。 */
export function validId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value)
}

/**
 * 使用完整 sessionId 的哈希而不是上游的前八字符，避免同前缀会话共用页面。
 * @param sessionId - 已在 sessions 服务中确认存在的会话。
 * @returns 仅属于该会话的稳定空间名。
 */
export function spaceNameForSession(sessionId: SessionId): string {
  return `coding-ego-${createHash('sha256').update(sessionId).digest('hex')}`
}

/** 上游运行时在不同平台写入 task-spaces.json 的位置。 */
export function egoStateDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (env.EGO_LINUX_STATE_DIR) return env.EGO_LINUX_STATE_DIR
  const home = homedir()
  return process.platform === 'win32'
    ? join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'ego-lite-linux')
    : join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'ego-lite-linux')
}

/** 从上游 readTaskSpaceGroups() 的只读元数据结构导出任务空间关系，不调用修复或状态突变。 */
export async function readTaskSpaceGroups(): Promise<readonly { name: string; targetIds: readonly string[] }[]> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(egoStateDirectory(), 'task-spaces.json'), 'utf8'))
    if (!raw || typeof raw !== 'object' || !('spaces' in raw) || !Array.isArray(raw.spaces)) return []
    return raw.spaces.flatMap((entry: unknown) => {
      if (!entry || typeof entry !== 'object' || !('name' in entry) || typeof entry.name !== 'string'
        || !('targetIds' in entry) || !Array.isArray(entry.targetIds)) return []
      return [{ name: entry.name, targetIds: entry.targetIds.filter(validId) }]
    })
  } catch {
    return []
  }
}

/** 同名空间可以重复出现时只信任唯一的登记，避免误认被篡改的归属。 */
export async function targetIdsForSession(sessionId: SessionId): Promise<ReadonlySet<string>> {
  const matched = (await readTaskSpaceGroups()).filter(group => group.name === spaceNameForSession(sessionId))
  return matched.length === 1 ? new Set(matched[0]?.targetIds) : new Set()
}
