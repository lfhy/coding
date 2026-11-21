/** 渠道编辑器持有的用户层草稿与设置路径操作。 */

import type { SettingsNamespaceView, SettingsPathOpView } from 'coding-api-remotes/client'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import { deriveKeyRef } from './store.ts'

/** 将用户层的渠道记录复制为编辑草稿；缺省为空。 */
export function draftAt(
  schema: SettingsSchemaOperations,
  namespace: SettingsNamespaceView,
  path: readonly string[],
): Record<string, unknown> {
  const subtree = schema.getPath(namespace.user, path)
  if (typeof subtree !== 'object' || subtree === null || Array.isArray(subtree)) return {}
  return structuredClone(subtree) as Record<string, unknown>
}

/**
 * 只提交编辑器能观察到的路径变化，不用脱敏字段重建分节。
 * @param base - 渠道在用户分节内的路径。
 * @param before - 打开或最后一次成功提交时的用户层记录。
 * @param after - 当前用户层草稿。
 * @returns 拟提交的路径操作。
 */
export function pathOps(
  base: readonly string[],
  before: unknown,
  after: Record<string, unknown>,
): SettingsPathOpView[] {
  const previous = typeof before === 'object' && before !== null && !Array.isArray(before)
    ? before as Record<string, unknown>
    : {}
  const ops: SettingsPathOpView[] = []
  for (const [key, value] of Object.entries(after)) {
    if (JSON.stringify(previous[key]) === JSON.stringify(value)) continue
    ops.push({ op: 'set', path: [...base, key], value })
  }
  for (const key of Object.keys(previous)) {
    if (!(key in after)) ops.push({ op: 'unset', path: [...base, key] })
  }
  return ops
}

/** 查询渠道使用的凭据引用；不读取明文。 */
export function refFor(
  schema: SettingsSchemaOperations,
  namespace: SettingsNamespaceView,
  path: readonly string[],
  provider: string,
): string {
  const profile = schema.getPath(namespace.value, path)
  const named = typeof profile === 'object' && profile !== null
    ? (profile as { apiKeyEnv?: unknown }).apiKeyEnv
    : undefined
  return typeof named === 'string' && named.length > 0 ? named : deriveKeyRef(provider)
}
