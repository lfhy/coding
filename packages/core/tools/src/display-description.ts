/** 校验和剥离工具展示参数，业务工具只接收其余原参数。 */
import { HarnessError } from 'coding-llm'
import { TOOL_SUMMARY_KEY, toolDisplayDescription } from './display-description-value.ts'

export { TOOL_SUMMARY_KEY, TOOL_SUMMARY_SCHEMA, supportsToolSummary, toolDisplayDescription } from './display-description-value.ts'

/** 非法展示元数据不会进入工具策略或工具主体。 */
export class ToolSummaryError extends HarnessError {
  constructor() {
    super('summary must be a non-empty string of at most 160 characters', 'INVALID_ARGS')
    this.name = 'ToolSummaryError'
  }
}

/**
 * 从模型参数中分离展示字段；非对象参数保留给原工具的验证器。
 * @param args - 已解析的调用参数。
 * @returns 业务参数，未提供展示字段时保持原引用。
 */
export function toolBusinessArgs(args: unknown, hasSummary = true): unknown {
  if (!hasSummary || typeof args !== 'object' || args === null || Array.isArray(args) || !Object.hasOwn(args, TOOL_SUMMARY_KEY)) return args
  const record = args as Record<string, unknown>
  if (toolDisplayDescription(record) === undefined) {
    throw new ToolSummaryError()
  }
  const business = Object.create(null) as Record<string, unknown>
  for (const [key, value] of Object.entries(record)) {
    if (key !== TOOL_SUMMARY_KEY) business[key] = value
  }
  return business
}
