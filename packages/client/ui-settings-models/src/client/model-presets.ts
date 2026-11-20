import type { IApiClient, SettingsNamespaceView, SettingsPathOpView } from 'coding-api-remotes/client'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import { messageOf } from './store.ts'

/** 模型 ID 编辑期间，按行索引保留持久身份与最后一个合法 ID。 */
export interface ModelIdentity {
  original: string
  invalid: boolean
  lastValid: string
}

/** 删除冲突行后，重新识别无需再次键入就恢复合法的模型 ID。
 * @param identities - 删除前按行索引保存的身份。
 * @param rows - 删除前的模型草稿。
 * @param removedIndex - 被删除行的索引。
 * @returns 移位后的身份及可迁移模式映射的恢复行。
 */
export function identitiesAfterRemoval(
  identities: ReadonlyMap<number, ModelIdentity>,
  rows: readonly Record<string, unknown>[],
  removedIndex: number,
): { shifted: Map<number, ModelIdentity>; recovered: { identity: ModelIdentity; id: string }[] } {
  const surviving = rows.filter((_row, at) => at !== removedIndex)
  const shifted = new Map<number, ModelIdentity>()
  const recovered: { identity: ModelIdentity; id: string }[] = []
  for (const [at, identity] of identities) {
    if (at === removedIndex) continue
    const index = at > removedIndex ? at - 1 : at
    const id = surviving[index]?.['id']
    if (identity.invalid && typeof id === 'string' && id.length > 0
      && surviving.filter(row => row['id'] === id).length === 1) {
      recovered.push({ identity, id })
      if (id !== identity.original) shifted.set(index, { ...identity, invalid: false, lastValid: id })
    } else {
      shifted.set(index, identity)
    }
  }
  return { shifted, recovered }
}

/** 模型路径按数组传递，渠道和模型 ID 中的点号不能拆作层级。
 * @param namespace - 模式设置分节。
 * @param schema - 设置镜像的路径读取器。
 * @param provider - 完整渠道 ID。
 * @param model - 完整模型 ID。
 * @returns 已保存的模式 ID；未设置时返回 undefined。
 */
export function modelPresetOf(
  namespace: SettingsNamespaceView | undefined,
  schema: SettingsSchemaOperations,
  provider: string,
  model: string,
): string | undefined {
  if (namespace === undefined) return undefined
  const defaults = schema.getPath(namespace.value, ['modelDefaults'])
  if (typeof defaults !== 'object' || defaults === null || !Object.hasOwn(defaults, provider)) return undefined
  const choices = (defaults as Record<string, unknown>)[provider]
  if (typeof choices !== 'object' || choices === null || !Object.hasOwn(choices, model)) return undefined
  const value = (choices as Record<string, unknown>)[model]
  return typeof value === 'string' ? value : undefined
}

/** 改名后的模式跟随同一行；原 ID 的已存覆盖在提交时一并清除。
 * @param changes - 当前待写入模式。
 * @param namespace - 模式设置分节。
 * @param schema - 设置路径读取器。
 * @param provider - 渠道 ID。
 * @param original - 行开始编辑时的模型 ID。
 * @param prior - 改名前最后一个有效 ID；重复或空 ID 不成为模式映射的身份。
 * @param nextId - 改名后的 ID。
 * @param duplicate - 新 ID 与另一行冲突；无效草稿暂不转移映射。
 * @returns 下一份待写入模式；不会覆盖目标 ID 已存的模式。
 */
export function renameModelPreset(
  changes: ReadonlyMap<string, string | undefined>,
  namespace: SettingsNamespaceView | undefined,
  schema: SettingsSchemaOperations,
  provider: string,
  original: string,
  prior: string,
  nextId: string,
  duplicate: boolean,
): ReadonlyMap<string, string | undefined> {
  if (prior === nextId || duplicate || nextId.length === 0 || original.length === 0) return changes
  const saved = modelPresetOf(namespace, schema, provider, original)
  const selected = changes.has(prior) ? changes.get(prior)
    : changes.has(original) ? changes.get(original) : saved
  const next = new Map(changes)
  if (prior !== original) next.delete(prior)
  if (original === nextId) {
    if (selected === saved) next.delete(original)
    else next.set(original, selected)
    return next
  }
  if (saved === undefined) next.delete(original)
  else next.set(original, undefined)
  const targetSaved = modelPresetOf(namespace, schema, provider, nextId)
  if (targetSaved === undefined && selected !== undefined) next.set(nextId, selected)
  return next
}

/** 删除模型时丢弃其草稿选择，并清除原模型 ID 的已存模式。
 * @param changes - 当前待写入模式。
 * @param namespace - 模式设置分节。
 * @param schema - 设置路径读取器。
 * @param provider - 渠道 ID。
 * @param original - 行开始编辑时的模型 ID。
 * @param current - 删除前草稿显示的模型 ID。
 * @returns 下一份待写入模式。
 */
export function removeModelPreset(
  changes: ReadonlyMap<string, string | undefined>,
  namespace: SettingsNamespaceView | undefined,
  schema: SettingsSchemaOperations,
  provider: string,
  original: string,
  current: string,
): ReadonlyMap<string, string | undefined> {
  const next = new Map(changes)
  if (current !== original) next.delete(current)
  if (modelPresetOf(namespace, schema, provider, original) === undefined) next.delete(original)
  else next.set(original, undefined)
  return next
}

/** 每条模型模式变更只触及自己的映射；失败时保留草稿供重试。
 * @param api - 设置写入接口。
 * @param namespace - 当前模式设置分节及其 revision。
 * @param changes - 本次改动的模型与模式；undefined 清除模型覆盖。
 * @param provider - 完整渠道 ID。
 * @param accept - 成功时折入共享设置镜像。
 * @param conflictMessage - revision 冲突时展示的本地化诊断。
 * @returns 写入失败的诊断或成功后的分节应答。
 */
export async function saveModelPresetChanges(
  api: Pick<IApiClient, 'settings'>,
  namespace: SettingsNamespaceView | undefined,
  changes: ReadonlyMap<string, string | undefined>,
  provider: string,
  accept?: (view: SettingsNamespaceView) => void,
  conflictMessage?: string,
): Promise<{ failure?: string; view?: SettingsNamespaceView }> {
  if (changes.size === 0) return {}
  if (namespace === undefined) return { failure: '模式设置不可用，无法保存模型默认模式。' }
  const ops: SettingsPathOpView[] = [...changes].map(([model, preset]) => preset === undefined
    ? { op: 'unset', path: ['modelDefaults', provider, model] }
    : { op: 'set', path: ['modelDefaults', provider, model], value: preset })
  try {
    const response = await api.settings.mutate({ ns: namespace.ns, expectedRevision: namespace.revision, ops })
    if (!response.result.ok) return { failure: response.result.error.code === 'settings-conflict'
      ? conflictMessage ?? response.result.error.message : response.result.error.message }
    accept?.(response.result.value)
    return { view: response.result.value }
  } catch (error) {
    return { failure: messageOf(error) }
  }
}
