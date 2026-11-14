/** 无运行时服务依赖的工具调用说明读取契约，供 Host 与浏览器共同重放。 */

/** 支持自定义操作说明的模型工具共用的可选字段。 */
export const TOOL_SUMMARY_KEY = 'summary'

const DESCRIPTION_TOOLS = new Set([
  'bash', 'exec_command', 'pwsh', 'run_code', 'spawn_agent', 'spawn_teammate', 'subagent', 'subagent_fork',
])

const STATIC_SUMMARY_TOOLS = new Set([
  'structured_output', 'wait_agent', 'list_agents', 'list_subagent_models', 'ask_user_question', 'report',
  'memory_list', 'memory_read', 'memory_delete', 'memory_save', 'memory_update',
  'read', 'write', 'edit', 'read_image', 'grep', 'glob', 'web_search', 'web_fetch',
  'apply_patch', 'str_replace_editor', 'write_stdin', 'send_message', 'followup_task',
  'interrupt_agent', 'job_list', 'job_output', 'job_kill', 'update_plan', 'todo_write', 'set_status',
  'skill', 'skill_read', 'context_compact', 'render_ui', 'image_gen', 'edit_image',
  'validate_gen_ui', 'create_goal', 'get_goal', 'update_goal',
  'browser_close', 'browser_screenshot', 'browser_snapshot', 'browser_auth_flush', 'browser_doctor', 'browser_status',
  'computer_list_apps', 'computer_confirm', 'cordis_inspect_list', 'cordis_define',
  'terminal_list', 'canvas_state', 'ppt_templates', 'schedule_list',
  'team_task_create', 'workflow',
])

/**
 * 判断工具是否需要额外的单次动作说明，静态动作及业务摘要保持原契约。
 * @param name 模型可调用的工具名。
 * @returns 允许注入展示摘要时为 true。
 */
export function supportsToolSummary(name: string): boolean {
  return !name.startsWith('mcp__') && !DESCRIPTION_TOOLS.has(name) && !STATIC_SUMMARY_TOOLS.has(name)
}

/** 已有面向用户的逐次说明字段时直接复用，不让多余的 `summary` 抢占它。 */
function existingToolDescription(args: unknown, name: string): string | undefined {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined
  const record = args as Record<string, unknown>
  const meta = record.meta
  const description = name === 'workflow'
    ? typeof meta === 'object' && meta !== null && !Array.isArray(meta)
      ? (meta as Record<string, unknown>).description : undefined
    : name === 'cordis_define' ? record.purpose
      : name === 'team_task_create' ? record.subject
        : name === 'computer_confirm' ? record.reason
          : DESCRIPTION_TOOLS.has(name) ? record.description : undefined
  return typeof description === 'string' && description.trim() !== '' ? description.trim() : undefined
}

/** 模型可见的字段说明；调用者不要把它当作授权依据。 */
export const TOOL_SUMMARY_SCHEMA = {
  type: 'string',
  description: 'Optional short, user-friendly summary of what this call is doing now. Omit when the action is self-explanatory. Do not include secrets, raw JSON, or internal identifiers.',
} as const

/**
 * 从持久调用参数读取简短说明；无效值由调用侧决定如何降级。
 * @param args - 模型调用的原始已解析参数。
 * @param toolName - 工具名；业务载荷使用 `summary` 的工具不把它解释为操作说明。
 * @returns 可展示的说明，或 undefined。
 */
export function toolDisplayDescription(args: unknown, toolName?: string): string | undefined {
  if (toolName !== undefined) {
    if (toolName === 'structured_output' || toolName.startsWith('mcp__')
      || ['wait_agent', 'list_agents', 'list_subagent_models', 'memory_list', 'ask_user_question'].includes(toolName)) return undefined
    const existing = existingToolDescription(args, toolName)
    if (existing !== undefined) return existing
    if (!supportsToolSummary(toolName)) {
      if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined
      const legacy = (args as Record<string, unknown>).display_description
      return typeof legacy === 'string' && legacy.trim() !== '' && legacy.length <= 160 ? legacy.trim() : undefined
    }
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined
  const value = (args as Record<string, unknown>)[
    Object.hasOwn(args, TOOL_SUMMARY_KEY) ? TOOL_SUMMARY_KEY : 'display_description'
  ]
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 160) return undefined
  return value.trim()
}
