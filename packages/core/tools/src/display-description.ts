/** 剥离工具展示参数，业务工具只接收其余原参数。 */
import { TOOL_SUMMARY_KEY } from './display-description-value.ts'

export { TOOL_SUMMARY_KEY, TOOL_SUMMARY_SCHEMA, supportsToolSummary, toolDisplayDescription } from './display-description-value.ts'

/**
 * 从模型参数中分离展示字段；非对象参数保留给原工具的验证器。
 *
 * `summary` 只是展示元数据：空白、超长或非字符串一律按“没有说明”处理，
 * 直接从业务参数里剥掉，绝不因为展示字段让调用失败。
 * @param args - 已解析的调用参数。
 * @returns 业务参数，未提供展示字段时保持原引用。
 */
export function toolBusinessArgs(args: unknown, hasSummary = true): unknown {
  if (!hasSummary || typeof args !== 'object' || args === null || Array.isArray(args) || !Object.hasOwn(args, TOOL_SUMMARY_KEY)) return args
  const record = args as Record<string, unknown>
  const business = Object.create(null) as Record<string, unknown>
  for (const [key, value] of Object.entries(record)) {
    if (key !== TOOL_SUMMARY_KEY) business[key] = value
  }
  return business
}
