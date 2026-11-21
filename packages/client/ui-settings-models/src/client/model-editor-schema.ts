/** 从设置 schema 推导模型编辑器需要的字段形态，避免按提供方名称维护分支。 */

/** 模型 schema 的最小结构；只读取设置服务公开的 schema 关系。 */
export interface ModelSchemaNode {
  type?: string
  value?: unknown
  inner?: ModelSchemaNode
  list?: readonly ModelSchemaNode[]
  dict?: Readonly<Record<string, ModelSchemaNode>>
  sKey?: ModelSchemaNode
  meta?: { default?: unknown }
}

/** 模型行能力字段在设置中的存储形态。 */
export type ReasoningShape = 'array' | 'map' | 'none'

/** 模型编辑器只依赖这些由 schema 描述的字段能力。 */
export interface ModelEditorSchema {
  /** 输入模态字段；缺席表示该适配器不声明视觉能力。 */
  modalityKey?: 'inputModalities' | 'input'
  /** 推理档位的存储形态。 */
  reasoningShape: ReasoningShape
  /** schema 中声明的可选推理档位。 */
  reasoningLevels: readonly string[]
}

/** 递归收集 union/const 中的字符串值，保持 schema 声明顺序。 */
function stringValues(node: ModelSchemaNode | undefined): string[] {
  if (node === undefined) return []
  if (node.type === 'const') return typeof node.value === 'string' ? [node.value] : []
  return node.type === 'union' ? [...new Set(node.list?.flatMap(stringValues) ?? [])] : []
}

/** 从推理字段 schema 读取形态与档位。 */
function reasoningOf(node: ModelSchemaNode | undefined): Pick<ModelEditorSchema, 'reasoningShape' | 'reasoningLevels'> {
  if (node?.type !== 'union') return { reasoningShape: 'none', reasoningLevels: [] }
  const array = node.list?.find(item => item.type === 'array')
  if (array !== undefined) {
    return { reasoningShape: 'array', reasoningLevels: stringValues(array.inner) }
  }
  const map = node.list?.find(item => item.type === 'dict')
  if (map !== undefined) {
    return { reasoningShape: 'map', reasoningLevels: stringValues(map.sKey) }
  }
  return { reasoningShape: 'none', reasoningLevels: [] }
}

/**
 * 从一个模型行 schema 推导编辑器字段，不读取 settings namespace 或路由 ID。
 * @param node - `models` 数组元素或 `modelOverrides` 值的 schema 节点。
 * @returns 模型编辑器所需的字段描述。
 */
export function describeModelSchema(node: ModelSchemaNode | undefined): ModelEditorSchema {
  const fields = node?.type === 'object' ? node.dict : undefined
  const reasoning = reasoningOf(fields?.['reasoningEfforts'])
  return {
    ...fields?.['inputModalities'] !== undefined ? { modalityKey: 'inputModalities' as const }
      : fields?.['input'] !== undefined ? { modalityKey: 'input' as const } : {},
    reasoningShape: reasoning.reasoningShape,
    reasoningLevels: reasoning.reasoningLevels,
  }
}
