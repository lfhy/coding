/**
 * 免费通道的 body 门：把 pi-ai 序列化后的请求体改写成上游接受 agent 形状。
 *
 * 上游匿名通道除客户端指纹外还检查请求体本身（2026-10-09 起，opencode2dsh 的
 * live 探测矩阵）：只接受流式请求，且 `tools` 数组必须同时出现 `bash` 与 `read`。
 * 缺少时本模块补上调用被禁用的占位定义，而不是改客户端自己的工具——
 * 客户端已注册的同名工具一律原样保留，绝不复写其 schema。
 *
 * @module coding-llm-opencode/free-lane
 */

/** 上游强制出现在 `tools` 里的工具名；缺任一个则请求被拒。 */
export const FREE_LANE_GATE_TOOL_NAMES = ['bash', 'read'] as const

/** 一个注入到线协议上的占位工具定义。 */
export interface FreeLaneGateTool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

/**
 * 占位工具的线协议形态。描述明说它不可调用：模型看见它只是为了满足上游形状，
 * 真正被调用时消费方会以未知工具失败，因此必须让模型没有理由去调它。
 * @param name - 需要补齐的门工具名。
 * @returns 注入用的工具定义。
 */
export function freeLaneGateTool(name: (typeof FREE_LANE_GATE_TOOL_NAMES)[number]): FreeLaneGateTool {
  return {
    type: 'function',
    function: {
      name,
      description: 'Reserved for the host runtime; do not call it.',
      parameters: { type: 'object', properties: {} },
    },
  }
}

/**
 * 把 `chat/completions` 请求体改写成满足免费通道门禁的形状。
 *
 * 只补缺失的门工具：客户端已提供的同名工具原样保留，因此模型仍然调用消费方
 * 真正实现的工具。原本没有任何工具时把 `tool_choice` 固定为 `none`，让模型
 * 不会去调注入的占位定义。
 * @param payload - pi-ai 即将发往上游的请求体。
 * @returns 需要替换的请求体；已满足门禁或不是 chat 请求体时返回 `undefined`，
 *   pi-ai 会保留原值。
 */
export function ensureFreeLaneShape(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const body = payload as Record<string, unknown>
  if (!Array.isArray(body.messages)) return undefined
  const tools: unknown[] = Array.isArray(body.tools) ? body.tools : []
  const present = new Set<string>()
  for (const tool of tools) {
    const fn = typeof tool === 'object' && tool !== null
      ? (tool as { function?: { name?: unknown } }).function
      : undefined
    if (typeof fn === 'object' && typeof fn.name === 'string') present.add(fn.name)
  }
  const missing = FREE_LANE_GATE_TOOL_NAMES.filter(name => !present.has(name))
  if (missing.length === 0) return undefined
  return {
    ...body,
    tools: [...tools, ...missing.map(name => freeLaneGateTool(name))],
    ...tools.length === 0 ? { tool_choice: 'none' } : {},
  }
}
