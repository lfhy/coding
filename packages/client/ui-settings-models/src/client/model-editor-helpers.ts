/** 模型目录编辑器共用的草稿、容量格式化与提交前校验。 */

import type { ModelEditorSchema, ReasoningShape } from './model-editor-schema.ts'

/** 保留目录行未展示字段的开放模型草稿。 */
export type ModelDraft = Record<string, unknown>

/** 模型目录校验需要的 schema 描述；未声明时只校验通用字段。 */
export interface ModelValidationOptions {
  reasoning?: ReasoningShape
  reasoningLevels?: readonly string[]
}

/** 一条模型目录校验失败的位置与界面文案键。 */
export interface ModelValidationFailure {
  /** 零基模型位置。 */
  index: number
  /** 模型设置区拥有的错误文案键。 */
  key: 'modelIdRequired' | 'modelIdDuplicate' | 'modelNameInvalid' | 'modelContextInvalid'
  | 'modelMaxTokensInvalid'
  | 'modelReasoningInvalid'
}

/** 容量字段允许的十进制 K/M 后缀。 */
const CAPACITY_PATTERN = /^(\d+(?:\.\d+)?)([km])?$/i

/** 容量后缀的十进制倍数；设置页面按模型服务常用写法解释 K/M。 */
const CAPACITY_SCALE = { k: 1_000, m: 1_000_000 } as const

/**
 * 将用户输入的容量文本转换为存储用 token 数。
 * @param text - 容量输入文本。
 * @returns 空文本对应 `undefined`，无法解析的文本对应 `NaN`。
 */
export function parseCapacity(text: string): number | undefined {
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined
  const match = CAPACITY_PATTERN.exec(trimmed)
  if (match === null) return Number.NaN
  const suffix = match[2]?.toLowerCase()
  const scale = suffix === 'k' || suffix === 'm' ? CAPACITY_SCALE[suffix] : 1
  const scaled = Number(match[1]) * scale
  // 例如 2.3M 的二进制浮点结果可能略高于整数，保留用户的整数意图。
  const rounded = Math.round(scaled)
  return Math.abs(scaled - rounded) < 1e-6 ? rounded : scaled
}

/**
 * 将存储的容量转换为可再次解析的最短文本。
 * @param value - 存储的 token 数。
 * @returns 容量输入框显示文本。
 */
export function formatCapacity(value: number): string {
  if (!Number.isInteger(value) || value <= 0) return String(value)
  if (value % CAPACITY_SCALE.m === 0) return `${String(value / CAPACITY_SCALE.m)}M`
  if (value % CAPACITY_SCALE.k === 0) return `${String(value / CAPACITY_SCALE.k)}K`
  return String(value)
}

/** 将 schema 已验证的目录值转换成开放记录，保留未展示字段。 */
export function modelDrafts(value: unknown): ModelDraft[] {
  if (!Array.isArray(value)) return []
  return value.map(entry =>
    typeof entry === 'object' && entry !== null && !Array.isArray(entry)
      ? entry as ModelDraft
      : {})
}

/**
 * 校验模型目录的通用字段及 schema 描述的推理字段形态。
 * @param value - 用户拥有的 `models` 值；未设置时跳过目录校验。
 * @param options - 由设置 schema 提供的模型字段描述。
 * @returns 首个失败行，或目录可写入时的 `undefined`。
 */
export function validateModels(
  value: unknown,
  options: ModelValidationOptions = {},
): ModelValidationFailure | undefined {
  if (value === undefined) return undefined
  const models = modelDrafts(value)
  const seen = new Set<string>()
  for (const [index, model] of models.entries()) {
    const id = model['id']
    const trimmed = typeof id === 'string' ? id.trim() : undefined
    if (trimmed === undefined || trimmed.length === 0) return { index, key: 'modelIdRequired' }
    if (seen.has(trimmed)) return { index, key: 'modelIdDuplicate' }
    seen.add(trimmed)

    const name = model['name']
    if (name !== undefined && (typeof name !== 'string' || name.length === 0)) {
      return { index, key: 'modelNameInvalid' }
    }
    const contextWindow = model['contextWindow']
    if (contextWindow !== undefined
      && (typeof contextWindow !== 'number' || !Number.isInteger(contextWindow) || contextWindow <= 0)) {
      return { index, key: 'modelContextInvalid' }
    }
    const maxTokens = model['maxTokens']
    if (maxTokens !== undefined
      && (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens) || maxTokens <= 0)) {
      return { index, key: 'modelMaxTokensInvalid' }
    }

    const reasoning = model['reasoningEfforts']
    if (options.reasoning === 'array' && reasoning !== undefined
      && (!Array.isArray(reasoning) || reasoning.length === 0
        || reasoning.some((level: unknown) => typeof level !== 'string'
          || (options.reasoningLevels !== undefined && !options.reasoningLevels.includes(level)))
        || new Set(reasoning).size !== reasoning.length)) {
      return { index, key: 'modelReasoningInvalid' }
    }
    if (options.reasoning === 'map' && reasoning !== undefined && reasoning !== false
      && (reasoning === null || typeof reasoning !== 'object' || Array.isArray(reasoning))) {
      return { index, key: 'modelReasoningInvalid' }
    }
  }
  return undefined
}

/** 模型字段未声明或为空时，不保留会挡住继承的值。 */
export function withModelFields(model: ModelDraft, fields: ModelDraft): ModelDraft {
  const next = { ...model }
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === '') Reflect.deleteProperty(next, key)
    else next[key] = value
  }
  return next
}

/** 读取模型草稿中的文本；空串用于未填写的受控输入。 */
export function modelText(model: ModelDraft, key: string): string {
  const value = model[key]
  return typeof value === 'string' ? value : ''
}

/** 按 schema 提供默认推理档位，不凭渠道名称猜测能力字段。 */
export function defaultReasoning(schema: ModelEditorSchema, disabled: boolean): unknown {
  const levels = ['off', 'low', 'high', 'max'].filter(level => schema.reasoningLevels.includes(level))
  if (schema.reasoningShape === 'array') return disabled ? ['off'] : levels
  if (schema.reasoningShape === 'map') {
    return disabled ? false : Object.fromEntries(levels.map(level => [level, level === 'off' ? null : level]))
  }
  return undefined
}
